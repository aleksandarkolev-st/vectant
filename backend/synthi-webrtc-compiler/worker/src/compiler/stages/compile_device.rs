// ============================================================
// COMPILE DEVICE (GPU_HMR_ULTRAPLAN §5.3, Phase 0)
// ============================================================
//
// Compiles the AI-emitted `device.cu` (CUDA) or `device.hip` (HIP) into
// a sidecar `cubin`/`hsaco` that the GPU module adapter loads via
// `cuModuleLoadData` / `hipModuleLoad`. Sibling of `compile_runner.rs`
// — same caching pattern (`IncrementalCache::cache_key` over device
// source + flags + arch list), same workspace conventions, same
// 30-second compile timeout shape.
//
// Two-step nvcc invocation:
//
//   step 1:  nvcc <arch> <device_flags> -ptx -o device_<ts>.ptx <src>
//   step 2:  nvcc --cubin -arch=<arch>  -o device_<ts>.cubin     device_<ts>.ptx
//
// The two-step is symmetric with the host two-step: PTX is the cacheable
// intermediate, cubin is the load-time artifact. For ROCm we run a single
// `hipcc --genco` invocation because HIP-side intermediates aren't
// stabilised across driver versions.
//
// Phase 0 scope: produce the artifact, run the stderr through
// `ptxas_info_parser`, attach `GpuToolchainDiagnostics` to the result.
// No reload orchestration, no caching coordination with the host slot
// pool — those land in Phases 1-3.
//
// Feature gate: the entire module is compiled behind `feature = "gpu-hmr"`.
// Without the feature, `compile_device_phase0` returns `Ok(None)`
// regardless of input so the orchestrator falls through to the legacy
// host-only path. This keeps the build green on machines that don't
// have CUDA/HIP installed during the rollout.

use crate::compiler::stages::ptxas_info_parser::{parse as parse_ptxas, GpuToolchainDiagnostics};
use crate::hmr::compile_manifest::{CompileManifest, DeviceCompiler, DeviceVendor};
use anyhow::{Context, Result};
use std::path::PathBuf;
use tokio::time::{timeout, Duration};

/// Standard filenames for the AI-synthesised device source files.
pub const DEVICE_CU_FILENAME: &str = "device.cu";
pub const DEVICE_HIP_FILENAME: &str = "device.hip";

/// Compile result attached alongside the cubin/hsaco path. The
/// diagnostics surface to the IDE (badges) and feed the Tier-2 healer
/// threshold checks.
#[derive(Debug, Clone)]
pub struct DeviceCompileOutcome {
    /// Absolute path to the produced cubin (CUDA) or hsaco (ROCm).
    pub artifact_path: PathBuf,
    /// Parsed ptxas/nvlink diagnostics — empty for ROCm (Phase 0).
    pub diagnostics: GpuToolchainDiagnostics,
    /// Raw stderr from the device compiler — preserved verbatim for the
    /// healer (Tier-1) when the compile fails.
    pub stderr: String,
}

/// Phase-0 entry point. Returns `Ok(None)` when:
///
///   - the `gpu-hmr` feature is disabled at build time, or
///   - `device_source` is empty, or
///   - the manifest has no `gpu` block (the orchestrator shouldn't call
///     us in that case, but we guard rather than panic).
///
/// Returns `Ok(Some(outcome))` on a successful compile, and `Err(_)`
/// when the device compiler fails. Heal-loop integration is a Phase 3
/// concern (see GPU_HMR_ULTRAPLAN §11.1 Tier 1) — Phase 0 just
/// surfaces the raw error.
pub async fn compile_device_phase0(
    workspace_dir: &std::path::Path,
    output_dir: &std::path::Path,
    timestamp: i64,
    device_source: &str,
    manifest: &CompileManifest,
) -> Result<Option<DeviceCompileOutcome>> {
    if device_source.trim().is_empty() {
        eprintln!("[compile-device] skipping — empty device source");
        return Ok(None);
    }
    let Some(gpu) = manifest.gpu.as_ref() else {
        eprintln!("[compile-device] manifest has no gpu block — falling through");
        return Ok(None);
    };

    #[cfg(not(feature = "gpu-hmr"))]
    {
        eprintln!(
            "[compile-device] gpu-hmr feature OFF — declining to compile (vendor={})",
            gpu.vendor.as_str()
        );
        let _ = (workspace_dir, output_dir, timestamp, device_source, manifest, gpu);
        return Ok(None);
    }

    #[cfg(feature = "gpu-hmr")]
    {
        compile_device_inner(workspace_dir, output_dir, timestamp, device_source, manifest, gpu)
            .await
    }
}

#[cfg(feature = "gpu-hmr")]
async fn compile_device_inner(
    workspace_dir: &std::path::Path,
    output_dir: &std::path::Path,
    timestamp: i64,
    device_source: &str,
    manifest: &CompileManifest,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
) -> Result<Option<DeviceCompileOutcome>> {
    // Pick filename + executable from the manifest. `select_compiler`
    // owns the dispatch; we resolve to the canonical name here so the
    // log lines name the actual binary the worker spawned.
    let compiler_exe = manifest
        .select_compiler(crate::hmr::compile_manifest::ModuleKind::Device);
    let (source_filename, artifact_ext) = match gpu.vendor {
        DeviceVendor::Cuda => (DEVICE_CU_FILENAME, "cubin"),
        DeviceVendor::Rocm => (DEVICE_HIP_FILENAME, "hsaco"),
    };

    tokio::fs::write(workspace_dir.join(source_filename), device_source)
        .await
        .context("writing device source")?;
    tokio::fs::create_dir_all(output_dir)
        .await
        .context("creating device output dir")?;

    let artifact_path = output_dir.join(format!("device_{}.{}", timestamp, artifact_ext));

    let mut cmd = crate::infra::utils::system_command(compiler_exe);
    populate_device_command(&mut cmd, gpu, source_filename, &artifact_path);
    cmd.current_dir(workspace_dir);
    cmd.kill_on_drop(true);

    eprintln!(
        "[compile-device] {} -> {}  args={:?}",
        compiler_exe,
        artifact_path.display(),
        cmd.as_std().get_args()
    );

    let child = cmd
        .spawn()
        .with_context(|| format!("spawning {compiler_exe}"))?;
    let out = match timeout(Duration::from_secs(60), child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => anyhow::bail!("Device compile timed out after 60s"),
    };

    let stderr_str = String::from_utf8_lossy(&out.stderr).to_string();
    let diagnostics = match gpu.vendor {
        DeviceVendor::Cuda => parse_ptxas(&stderr_str),
        DeviceVendor::Rocm => GpuToolchainDiagnostics::default(),
    };

    if !out.status.success() {
        eprintln!(
            "[compile-device] {} FAILED status={}\n{}",
            compiler_exe, out.status, stderr_str
        );
        anyhow::bail!(
            "device compile failed (exit {}): {}",
            out.status,
            stderr_str.trim()
        );
    }

    eprintln!(
        "[compile-device] {} ok  artifact={}  diagnostics_kernels={}",
        compiler_exe,
        artifact_path.display(),
        diagnostics.register_pressure.len()
    );

    Ok(Some(DeviceCompileOutcome {
        artifact_path,
        diagnostics,
        stderr: stderr_str,
    }))
}

/// Pure helper that builds the device-compiler command line from a
/// GPU build block. Split out so unit tests can assert the flag shape
/// without needing nvcc/hipcc on PATH.
///
/// For nvcc we use a single-shot `--cubin` invocation: nvcc handles
/// PTX → cubin internally and the resulting cubin matches what
/// `cuModuleLoadData` expects. The plan's two-step (ptx → cubin) is an
/// optimisation for Phase 5 cross-TU device linking; Phase 0's
/// monolithic device.cu doesn't need it.
///
/// For hipcc we pass `--genco` to produce a code object suitable for
/// `hipModuleLoad`.
#[cfg(feature = "gpu-hmr")]
pub fn populate_device_command(
    cmd: &mut tokio::process::Command,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
    artifact_path: &std::path::Path,
) {
    match gpu.device_compiler {
        DeviceCompiler::Nvcc => {
            cmd.arg("--cubin");
            for arch in &gpu.arch {
                cmd.arg(format!("-arch={arch}"));
            }
            // -lineinfo, --use_fast_math, -O3 etc. flow through verbatim;
            // the GPU error triage path (§11.2) parses ptxas-info so the
            // user's `--ptxas-options=-v` is honoured as-is.
            for flag in &gpu.device_flags {
                cmd.arg(flag);
            }
            cmd.arg("--ptxas-options=-v");
            cmd.arg("-o").arg(artifact_path);
            cmd.arg(source_filename);
        }
        DeviceCompiler::ClangCuda => {
            // clang's CUDA front-end driven by `--cuda-gpu-arch`.
            cmd.arg("--cuda-device-only");
            for arch in &gpu.arch {
                cmd.arg(format!("--cuda-gpu-arch={arch}"));
            }
            for flag in &gpu.device_flags {
                cmd.arg(flag);
            }
            cmd.arg("-o").arg(artifact_path);
            cmd.arg(source_filename);
        }
        DeviceCompiler::Hipcc => {
            cmd.arg("--genco");
            for arch in &gpu.arch {
                cmd.arg(format!("--offload-arch={arch}"));
            }
            for flag in &gpu.device_flags {
                cmd.arg(flag);
            }
            cmd.arg("-o").arg(artifact_path);
            cmd.arg(source_filename);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hmr::compile_manifest::{
        DeviceCompiler, DeviceVendor, FatbinStrategy, GpuBuildBlock, SnapshotMode,
    };
    use std::path::PathBuf;

    fn cuda_block() -> GpuBuildBlock {
        GpuBuildBlock {
            vendor: DeviceVendor::Cuda,
            device_compiler: DeviceCompiler::Nvcc,
            arch: vec!["sm_80".to_string()],
            device_flags: vec!["-O3".to_string(), "-lineinfo".to_string()],
            runtime_libs: vec!["cudart".to_string()],
            snapshot_mode: SnapshotMode::Auto,
            fatbin_strategy: FatbinStrategy::SidecarModule,
        }
    }

    fn rocm_block() -> GpuBuildBlock {
        GpuBuildBlock {
            vendor: DeviceVendor::Rocm,
            device_compiler: DeviceCompiler::Hipcc,
            arch: vec!["gfx90a".to_string()],
            device_flags: vec!["-O3".to_string()],
            runtime_libs: vec!["amdhip64".to_string()],
            snapshot_mode: SnapshotMode::Userspace,
            fatbin_strategy: FatbinStrategy::SidecarModule,
        }
    }

    fn args_of(cmd: &tokio::process::Command) -> Vec<String> {
        cmd.as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn nvcc_command_carries_arch_and_output() {
        let mut cmd = tokio::process::Command::new("nvcc");
        let out = PathBuf::from("/tmp/device_42.cubin");
        populate_device_command(&mut cmd, &cuda_block(), "device.cu", &out);
        let args = args_of(&cmd);
        assert!(args.iter().any(|a| a == "--cubin"));
        assert!(args.iter().any(|a| a == "-arch=sm_80"));
        assert!(args.iter().any(|a| a == "-O3"));
        assert!(args.iter().any(|a| a == "-lineinfo"));
        assert!(args.iter().any(|a| a == "--ptxas-options=-v"));
        assert!(args.iter().any(|a| a == "-o"));
        assert!(args.iter().any(|a| a.ends_with("device_42.cubin")));
        assert!(args.iter().any(|a| a == "device.cu"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn hipcc_command_carries_offload_arch() {
        let mut cmd = tokio::process::Command::new("hipcc");
        let out = PathBuf::from("/tmp/device_42.hsaco");
        populate_device_command(&mut cmd, &rocm_block(), "device.hip", &out);
        let args = args_of(&cmd);
        assert!(args.iter().any(|a| a == "--genco"));
        assert!(args.iter().any(|a| a == "--offload-arch=gfx90a"));
        assert!(args.iter().any(|a| a.ends_with("device_42.hsaco")));
        assert!(args.iter().any(|a| a == "device.hip"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn clang_cuda_command_uses_cuda_gpu_arch() {
        let mut block = cuda_block();
        block.device_compiler = DeviceCompiler::ClangCuda;
        let mut cmd = tokio::process::Command::new("clang++");
        let out = PathBuf::from("/tmp/device_42.cubin");
        populate_device_command(&mut cmd, &block, "device.cu", &out);
        let args = args_of(&cmd);
        assert!(args.iter().any(|a| a == "--cuda-device-only"));
        assert!(args.iter().any(|a| a == "--cuda-gpu-arch=sm_80"));
    }

    #[tokio::test]
    async fn empty_source_returns_none() {
        let mut manifest = CompileManifest::sdl2_default();
        manifest.gpu = Some(cuda_block());
        let tmp = tempfile::tempdir().unwrap();
        let out =
            compile_device_phase0(tmp.path(), tmp.path(), 1, "", &manifest).await.unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn missing_gpu_block_returns_none() {
        let manifest = CompileManifest::sdl2_default();
        let tmp = tempfile::tempdir().unwrap();
        let out =
            compile_device_phase0(tmp.path(), tmp.path(), 1, "__global__ void k() {}", &manifest)
                .await
                .unwrap();
        assert!(out.is_none());
    }

    #[cfg(not(feature = "gpu-hmr"))]
    #[tokio::test]
    async fn returns_none_when_feature_disabled() {
        // With gpu-hmr off the entry point declines regardless of input.
        let mut manifest = CompileManifest::sdl2_default();
        manifest.gpu = Some(cuda_block());
        let tmp = tempfile::tempdir().unwrap();
        let out = compile_device_phase0(
            tmp.path(),
            tmp.path(),
            1,
            "__global__ void k() {}",
            &manifest,
        )
        .await
        .unwrap();
        assert!(out.is_none(), "device compile must be a no-op without gpu-hmr feature");
    }
}
