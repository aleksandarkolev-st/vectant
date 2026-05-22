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
// intermediate, cubin is the load-time artifact. For ROCm we run
// `hipcc --genco` and normalize clang's offload bundle output into the
// raw AMDGPU code object expected by HIP's module loader.
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

#[cfg(feature = "gpu-hmr")]
use crate::compiler::stages::ptxas_info_parser::parse as parse_ptxas;
use crate::compiler::stages::ptxas_info_parser::GpuToolchainDiagnostics;
#[cfg(feature = "gpu-hmr")]
use crate::hmr::compile_manifest::{DeviceCompiler, DeviceVendor};
use crate::hmr::compile_manifest::CompileManifest;
#[cfg(feature = "gpu-hmr")]
use anyhow::Context;
use anyhow::Result;
#[cfg(feature = "gpu-hmr")]
use regex::Regex;
#[cfg(feature = "gpu-hmr")]
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
#[cfg(feature = "gpu-hmr")]
use tokio::io::AsyncReadExt;
#[cfg(feature = "gpu-hmr")]
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
    /// Device source that was actually compiled after any internal generated
    /// role heal attempts.
    pub compiled_source: String,
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
    source_filename_override: Option<&str>,
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
        let _ = (
            workspace_dir,
            output_dir,
            timestamp,
            device_source,
            source_filename_override,
            manifest,
            gpu,
        );
        return Ok(None);
    }

    #[cfg(feature = "gpu-hmr")]
    {
        compile_device_inner(
            workspace_dir,
            output_dir,
            timestamp,
            device_source,
            source_filename_override,
            manifest,
            gpu,
        )
        .await
    }
}

#[cfg(feature = "gpu-hmr")]
async fn compile_device_inner(
    workspace_dir: &std::path::Path,
    output_dir: &std::path::Path,
    timestamp: i64,
    device_source: &str,
    source_filename_override: Option<&str>,
    manifest: &CompileManifest,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
) -> Result<Option<DeviceCompileOutcome>> {
    // Pick filename + executable from the manifest. `select_compiler`
    // owns the dispatch; we resolve to the canonical name here so the
    // log lines name the actual binary the worker spawned.
    let compiler_exe = manifest
        .select_compiler(crate::hmr::compile_manifest::ModuleKind::Device);
    let (default_source_filename, artifact_ext) = match gpu.vendor {
        DeviceVendor::Cuda => (DEVICE_CU_FILENAME, "cubin"),
        DeviceVendor::Rocm => (DEVICE_HIP_FILENAME, "hsaco"),
    };
    let source_filename = source_filename_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default_source_filename);

    let source_path = workspace_dir.join(source_filename);
    if let Some(parent) = source_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("creating device source parent dir")?;
    }
    tokio::fs::create_dir_all(output_dir)
        .await
        .context("creating device output dir")?;

    let artifact_path = output_dir.join(format!("device_{}.{}", timestamp, artifact_ext));
    let heal_allowed = is_internal_generated_device_source(source_filename);
    let max_heal_attempts = if heal_allowed { 2 } else { 0 };
    if !heal_allowed {
        eprintln!(
            "[compile-device] AI heal disabled - source is not an internal generated role: {}",
            source_filename
        );
    }

    let mut current_source = device_source.to_string();
    for attempt in 0..=max_heal_attempts {
        if heal_allowed {
            match remove_source_owned_device_forward_decls(
                workspace_dir,
                source_filename,
                &current_source,
                gpu,
            )
            .await
            {
                Ok(sanitized) if sanitized != current_source => {
                    eprintln!(
                        "[compile-device] removed source-owned generated device forward declarations before compile"
                    );
                    current_source = sanitized;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!(
                        "[compile-device] source-owned declaration cleanup skipped: {e}"
                    );
                }
            }
        }

        tokio::fs::write(&source_path, &current_source)
            .await
            .context("writing device source")?;

        let compile = run_device_compile_once(
            compiler_exe,
            workspace_dir,
            gpu,
            source_filename,
            &artifact_path,
        )
        .await?;

        if compile.status.success() {
            if gpu.vendor == DeviceVendor::Rocm {
                normalize_rocm_artifact_if_bundled(&artifact_path).await?;
            }

            eprintln!(
                "[compile-device] {} ok  artifact={}  diagnostics_kernels={}",
                compiler_exe,
                artifact_path.display(),
                compile.diagnostics.register_pressure.len()
            );

            return Ok(Some(DeviceCompileOutcome {
                artifact_path,
                compiled_source: current_source,
                diagnostics: compile.diagnostics,
                stderr: compile.stderr,
            }));
        }

        eprintln!(
            "[compile-device] {} FAILED status={}\n{}",
            compiler_exe, compile.status, compile.stderr
        );

        if attempt >= max_heal_attempts {
            anyhow::bail!(
                "device compile failed (exit {}): {}",
                compile.status,
                compile.stderr.trim()
            );
        }

        let (shared_for_heal, heal_arch_md) =
            read_device_heal_context(workspace_dir, &source_path).await;
        let heal_arch_hint = heal_arch_md.as_deref().filter(|s| !s.trim().is_empty());

        eprintln!(
            "[compile-device] AI heal attempt {} for device",
            attempt + 1
        );
        let fixed = match crate::compiler::stages::ai_utils::perform_ai_heal(
            "device",
            &current_source,
            &compile.stderr,
            &shared_for_heal,
            heal_arch_hint,
        )
        .await
        {
            Ok(fixed) if !fixed.trim().is_empty() => fixed,
            Ok(_) => {
                anyhow::bail!(
                    "device compile AI heal returned empty source after compiler error (exit {}): {}",
                    compile.status,
                    compile.stderr.trim()
                );
            }
            Err(e) => {
                anyhow::bail!(
                    "device compile AI heal failed after compiler error (exit {}): {}; original compiler stderr: {}",
                    compile.status,
                    e,
                    compile.stderr.trim()
                );
            }
        };

        tokio::fs::write(&source_path, &fixed)
            .await
            .context("writing healed device source")?;
        current_source = fixed;
    }

    unreachable!("device compile loop always returns or bails")
}

#[cfg(feature = "gpu-hmr")]
async fn remove_source_owned_device_forward_decls(
    workspace_dir: &Path,
    source_filename: &str,
    source: &str,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
) -> Result<String> {
    let owned_names = reachable_source_owned_device_functions(
        workspace_dir,
        source_filename,
        source,
        &gpu.device_flags,
    )
    .await?;
    if owned_names.is_empty() {
        return Ok(source.to_string());
    }
    Ok(remove_forward_decls_for_names(source, &owned_names))
}

#[cfg(feature = "gpu-hmr")]
async fn reachable_source_owned_device_functions(
    workspace_dir: &Path,
    source_filename: &str,
    source: &str,
    device_flags: &[String],
) -> Result<HashSet<String>> {
    const MAX_INCLUDED_FILES: usize = 160;
    const MAX_INCLUDED_BYTES: u64 = 2 * 1024 * 1024;

    let mut include_dirs = device_include_dirs(workspace_dir, device_flags);
    include_dirs.push(workspace_dir.to_path_buf());
    if let Some(parent) = workspace_dir.join(source_filename).parent() {
        include_dirs.push(parent.to_path_buf());
    }

    let mut queue = VecDeque::new();
    let root_dir = workspace_dir
        .join(source_filename)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| workspace_dir.to_path_buf());
    for include in parse_includes(source) {
        if let Some(path) = resolve_device_include(
            workspace_dir,
            &root_dir,
            &include.path,
            include.quoted,
            &include_dirs,
        ) {
            queue.push_back(path);
        }
    }

    let mut visited = HashSet::new();
    let mut names = HashSet::new();
    while let Some(path) = queue.pop_front() {
        if visited.len() >= MAX_INCLUDED_FILES {
            break;
        }
        let normalized = normalize_path_key(&path);
        if !visited.insert(normalized) {
            continue;
        }
        let Ok(metadata) = tokio::fs::metadata(&path).await else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > MAX_INCLUDED_BYTES {
            continue;
        }
        let Ok(content) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        names.extend(source_owned_device_function_names(&content));
        let including_dir = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| workspace_dir.to_path_buf());
        for include in parse_includes(&content) {
            if let Some(next) = resolve_device_include(
                workspace_dir,
                &including_dir,
                &include.path,
                include.quoted,
                &include_dirs,
            ) {
                queue.push_back(next);
            }
        }
    }

    Ok(names)
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug)]
struct DeviceInclude {
    path: String,
    quoted: bool,
}

#[cfg(feature = "gpu-hmr")]
fn parse_includes(source: &str) -> Vec<DeviceInclude> {
    let include_re =
        Regex::new(r#"(?m)^\s*#\s*include\s*(?P<delim>[<"])(?P<path>[^>"]+)[>"]"#)
            .expect("valid include regex");
    include_re
        .captures_iter(&strip_cpp_comments_for_device_compile(source))
        .filter_map(|caps| {
            let path = caps.name("path")?.as_str().trim();
            if path.is_empty() {
                return None;
            }
            Some(DeviceInclude {
                path: path.replace('\\', "/"),
                quoted: caps.name("delim").map(|m| m.as_str()) == Some("\""),
            })
        })
        .collect()
}

#[cfg(feature = "gpu-hmr")]
fn device_include_dirs(workspace_dir: &Path, device_flags: &[String]) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut iter = device_flags.iter().peekable();
    while let Some(flag) = iter.next() {
        let candidates: Vec<String> = if flag == "-I" || flag == "-isystem" {
            iter.next().map(|next| vec![next.clone()]).unwrap_or_default()
        } else if let Some(rest) = flag.strip_prefix("-I") {
            vec![rest.to_string()]
        } else if let Some(rest) = flag.strip_prefix("-isystem") {
            vec![rest.to_string()]
        } else if let Some(rest) = flag.strip_prefix("--include-directory=") {
            vec![rest.to_string()]
        } else if let Some(rest) = flag.strip_prefix("--system-include=") {
            vec![rest.to_string()]
        } else {
            Vec::new()
        };

        for candidate in candidates {
            let trimmed = candidate.trim();
            if trimmed.is_empty() {
                continue;
            }
            let path = PathBuf::from(trimmed);
            dirs.push(if path.is_absolute() {
                path
            } else {
                workspace_dir.join(path)
            });
        }
    }
    dirs
}

#[cfg(feature = "gpu-hmr")]
fn resolve_device_include(
    workspace_dir: &Path,
    including_dir: &Path,
    include_path: &str,
    quoted: bool,
    include_dirs: &[PathBuf],
) -> Option<PathBuf> {
    let include_path = include_path.trim();
    if include_path.is_empty() || include_path.contains('\0') {
        return None;
    }
    let include = PathBuf::from(include_path);
    if include.is_absolute() && include.is_file() {
        return Some(include);
    }

    let mut candidates = Vec::new();
    if quoted {
        candidates.push(including_dir.join(&include));
    }
    candidates.push(workspace_dir.join(&include));
    for dir in include_dirs {
        candidates.push(dir.join(&include));
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(feature = "gpu-hmr")]
fn source_owned_device_function_names(source: &str) -> HashSet<String> {
    let device_fn_re = Regex::new(
        r#"(?xs)
        \b(?:HIPRT_DEVICE|HIPRT_HOST_DEVICE|__device__|__host__\s+__device__|__device__\s+__host__)\b
        (?P<signature>[^;{}]*?)
        \b(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*
        \(
            [^;{}()]*
            (?:\([^;{}()]*\)[^;{}()]*)*
        \)
        \s*(?:;|\{)
        "#,
    )
    .expect("valid device function regex");
    device_fn_re
        .captures_iter(&strip_cpp_comments_for_device_compile(source))
        .filter_map(|caps| {
            let name = caps.name("name")?.as_str();
            if matches!(
                name,
                "if" | "for" | "while" | "switch" | "return" | "__global__"
            ) {
                return None;
            }
            Some(name.to_string())
        })
        .collect()
}

#[cfg(feature = "gpu-hmr")]
fn remove_forward_decls_for_names(source: &str, source_owned_names: &HashSet<String>) -> String {
    if source_owned_names.is_empty() {
        return source.to_string();
    }

    let forward_decl_re = Regex::new(
        r#"(?ms)
        ^[ \t]*
        (?:
            extern\s+(?:"C"\s+)?
        )?
        (?:
            __device__|HIPRT_DEVICE|HIPRT_HOST_DEVICE|__host__\s+__device__|__device__\s+__host__
        )\b
        [^;{}]*?
        \b(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*
        \(
            [^;{}()]*
            (?:\([^;{}()]*\)[^;{}()]*)*
        \)
        \s*;\s*
        (?:\r?\n)?
        "#,
    )
    .expect("valid forward declaration regex");
    let out = forward_decl_re
        .replace_all(source, |caps: &regex::Captures| {
            let name = caps.name("name").map(|m| m.as_str()).unwrap_or("");
            if source_owned_names.contains(name) {
                String::new()
            } else {
                caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string()
            }
        })
        .into_owned();

    let empty_extern_c_re =
        Regex::new(r#"(?ms)^[ \t]*extern\s+"C"\s*\{\s*\}\s*(?:\r?\n)?"#)
            .expect("valid empty extern C regex");
    empty_extern_c_re.replace_all(&out, "").into_owned()
}

#[cfg(feature = "gpu-hmr")]
fn strip_cpp_comments_for_device_compile(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                out.push(' ');
                i += 1;
            }
        } else if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            out.push(' ');
            out.push(' ');
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                out.push(if bytes[i] == b'\n' { '\n' } else { ' ' });
                i += 1;
            }
            if i + 1 < bytes.len() {
                out.push(' ');
                out.push(' ');
                i += 2;
            }
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

#[cfg(feature = "gpu-hmr")]
fn normalize_path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(feature = "gpu-hmr")]
struct DeviceCompileAttempt {
    status: std::process::ExitStatus,
    diagnostics: GpuToolchainDiagnostics,
    stderr: String,
}

#[cfg(feature = "gpu-hmr")]
async fn run_device_compile_once(
    compiler_exe: &str,
    workspace_dir: &std::path::Path,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
    artifact_path: &Path,
) -> Result<DeviceCompileAttempt> {
    let mut cmd = crate::infra::utils::system_command(compiler_exe);
    populate_device_command(&mut cmd, gpu, source_filename, artifact_path);
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

    Ok(DeviceCompileAttempt {
        status: out.status,
        diagnostics,
        stderr: stderr_str,
    })
}

#[cfg(feature = "gpu-hmr")]
fn is_internal_generated_device_source(source_filename: &str) -> bool {
    let normalized = source_filename
        .replace('\\', "/")
        .trim()
        .trim_start_matches("./")
        .to_string();
    normalized.starts_with(".synthi/generated/") || normalized.contains("/.synthi/generated/")
}

#[cfg(feature = "gpu-hmr")]
async fn read_device_heal_context(
    workspace_dir: &std::path::Path,
    source_path: &std::path::Path,
) -> (String, Option<String>) {
    let mut shared_candidates: Vec<PathBuf> = Vec::new();
    if let Some(parent) = source_path.parent() {
        shared_candidates.push(parent.join("shared.h"));
    }
    shared_candidates.push(workspace_dir.join(".synthi/generated/gpu/shared.h"));
    shared_candidates.push(workspace_dir.join("shared.h"));

    let mut shared_content = String::new();
    for candidate in shared_candidates {
        match tokio::fs::read_to_string(&candidate).await {
            Ok(content) if !content.trim().is_empty() => {
                shared_content = content;
                break;
            }
            _ => {}
        }
    }

    let architecture = tokio::fs::read_to_string(workspace_dir.join(".synthi_split_meta.json"))
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("architecture")
                .and_then(|architecture| architecture.as_str())
                .map(|architecture| architecture.to_string())
        });

    (shared_content, architecture)
}

#[cfg(feature = "gpu-hmr")]
async fn normalize_rocm_artifact_if_bundled(artifact_path: &Path) -> Result<()> {
    if !has_clang_offload_bundle_header(artifact_path).await? {
        return Ok(());
    }

    let bundler = std::env::var("SYNTHI_CLANG_OFFLOAD_BUNDLER")
        .unwrap_or_else(|_| "clang-offload-bundler".to_string());

    let mut list_cmd = crate::infra::utils::system_command(&bundler);
    list_cmd
        .arg("--list")
        .arg("--type=o")
        .arg(format!("--input={}", artifact_path.display()))
        .kill_on_drop(true);
    let list_out = match timeout(Duration::from_secs(15), list_cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(e).context("listing ROCm offload bundle targets"),
        Err(_) => anyhow::bail!("listing ROCm offload bundle targets timed out after 15s"),
    };
    if !list_out.status.success() {
        anyhow::bail!(
            "clang-offload-bundler --list failed ({}): {}",
            list_out.status,
            String::from_utf8_lossy(&list_out.stderr).trim()
        );
    }

    let target_list = String::from_utf8_lossy(&list_out.stdout);
    let target = parse_hip_offload_target(&target_list)
        .ok_or_else(|| anyhow::anyhow!("no HIP target found in offload bundle: {target_list}"))?;

    let stem = artifact_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("device");
    let raw_path = artifact_path.with_file_name(format!("{stem}.raw.hsaco"));

    let mut unbundle_cmd = crate::infra::utils::system_command(&bundler);
    unbundle_cmd
        .arg("--unbundle")
        .arg("--type=o")
        .arg(format!("--input={}", artifact_path.display()))
        .arg(format!("--targets={target}"))
        .arg(format!("--output={}", raw_path.display()))
        .kill_on_drop(true);
    let unbundle_out = match timeout(Duration::from_secs(15), unbundle_cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(e).context("extracting ROCm code object from offload bundle"),
        Err(_) => anyhow::bail!("extracting ROCm code object timed out after 15s"),
    };
    if !unbundle_out.status.success() {
        anyhow::bail!(
            "clang-offload-bundler --unbundle failed ({}): {}",
            unbundle_out.status,
            String::from_utf8_lossy(&unbundle_out.stderr).trim()
        );
    }

    let raw_len = tokio::fs::metadata(&raw_path)
        .await
        .with_context(|| format!("stat extracted ROCm code object {}", raw_path.display()))?
        .len();
    if raw_len == 0 {
        anyhow::bail!(
            "extracted ROCm code object is empty: {}",
            raw_path.display()
        );
    }
    if has_clang_offload_bundle_header(&raw_path).await? {
        anyhow::bail!(
            "extracted ROCm code object is still a clang offload bundle: {}",
            raw_path.display()
        );
    }

    tokio::fs::remove_file(artifact_path)
        .await
        .with_context(|| format!("replacing ROCm offload bundle {}", artifact_path.display()))?;
    tokio::fs::rename(&raw_path, artifact_path)
        .await
        .with_context(|| {
            format!(
                "installing extracted ROCm code object {} -> {}",
                raw_path.display(),
                artifact_path.display()
            )
        })?;

    eprintln!(
        "[compile-device] normalized ROCm offload bundle target={} artifact={} bytes={}",
        target,
        artifact_path.display(),
        raw_len
    );
    Ok(())
}

#[cfg(feature = "gpu-hmr")]
async fn has_clang_offload_bundle_header(path: &Path) -> Result<bool> {
    const HEADER: &[u8] = b"__CLANG_OFFLOAD_BUNDLE__";
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("opening device artifact {}", path.display()))?;
    let mut buf = [0u8; 24];
    let n = file
        .read(&mut buf)
        .await
        .with_context(|| format!("reading device artifact {}", path.display()))?;
    Ok(n >= HEADER.len() && &buf[..HEADER.len()] == HEADER)
}

#[cfg(feature = "gpu-hmr")]
fn parse_hip_offload_target(target_list: &str) -> Option<String> {
    target_list
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with("hip"))
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
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
/// For hipcc we pass `--genco`, then the compile stage extracts the
/// device bundle into a raw code object suitable for `hipModuleLoad`.
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
            device_roles: Vec::new(),
            device_link: Default::default(),
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
            device_roles: Vec::new(),
            device_link: Default::default(),
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
    fn device_heal_only_targets_internal_generated_roles() {
        assert!(is_internal_generated_device_source(
            ".synthi/generated/gpu/device.hip"
        ));
        assert!(is_internal_generated_device_source(
            "/workspace/app/.synthi/generated/gpu/device.cu"
        ));
        assert!(!is_internal_generated_device_source("device.hip"));
        assert!(!is_internal_generated_device_source("src/gpu/raster.hip"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn source_owned_cleanup_removes_generated_device_forward_decl_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let header = tmp
            .path()
            .join("thirdparties/HIPRT-Fork/hiprt/impl/hiprt_device_impl.h");
        tokio::fs::create_dir_all(header.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(
            &header,
            "HIPRT_DEVICE bool filterFunc(unsigned int, unsigned int, const hiprtRay&);\n",
        )
        .await
        .unwrap();

        let mut block = rocm_block();
        block.device_flags = vec!["-Ithirdparties/HIPRT-Fork".to_string()];
        let source = r#"
#include <hiprt/impl/hiprt_device_impl.h>
extern "C" {
    __device__ bool filterFunc(unsigned int, unsigned int, const hiprtRay&);
}
__device__ int generated_helper();
extern "C" __global__ void CameraRays(int* out) { *out = 1; }
"#;

        let cleaned = remove_source_owned_device_forward_decls(
            tmp.path(),
            ".synthi/generated/gpu/device.hip",
            source,
            &block,
        )
        .await
        .unwrap();

        assert!(cleaned.contains("#include <hiprt/impl/hiprt_device_impl.h>"));
        assert!(!cleaned.contains("__device__ bool filterFunc"));
        assert!(!cleaned.contains("extern \"C\" {\n}"));
        assert!(cleaned.contains("__device__ int generated_helper();"));
        assert!(cleaned.contains("extern \"C\" __global__ void CameraRays"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn source_owned_cleanup_keeps_unknown_generated_forward_decls() {
        let mut owned = HashSet::new();
        owned.insert("source_declared".to_string());
        let source = r#"
__device__ int source_declared(float*);
__device__ int generated_helper();
extern "C" __global__ void apply(float* out) { *out = 1.0f; }
"#;

        let cleaned = remove_forward_decls_for_names(source, &owned);

        assert!(!cleaned.contains("source_declared(float*)"));
        assert!(cleaned.contains("__device__ int generated_helper();"));
        assert!(cleaned.contains("extern \"C\" __global__ void apply"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn source_owned_cleanup_removes_extern_device_forward_decl_conflict() {
        let mut owned = HashSet::new();
        owned.insert("filterFunc".to_string());
        let source = r#"
extern __device__ hiprtHit filterFunc(unsigned int, unsigned int, const hiprtRay&);
extern __device__ int generated_helper();
extern "C" __global__ void apply(float* out) { *out = 1.0f; }
"#;

        let cleaned = remove_forward_decls_for_names(source, &owned);

        assert!(!cleaned.contains("hiprtHit filterFunc"));
        assert!(cleaned.contains("extern __device__ int generated_helper();"));
        assert!(cleaned.contains("extern \"C\" __global__ void apply"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn parse_hip_offload_target_prefers_device_bundle() {
        let target = parse_hip_offload_target(
            "host-x86_64-unknown-linux-gnu-\nhipv4-amdgcn-amd-amdhsa--gfx1201\n",
        );
        assert_eq!(
            target.as_deref(),
            Some("hipv4-amdgcn-amd-amdhsa--gfx1201")
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn parse_hip_offload_target_returns_none_without_device_bundle() {
        assert!(parse_hip_offload_target("host-x86_64-unknown-linux-gnu-\n").is_none());
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
        let mut manifest = CompileManifest::generic_fallback();
        manifest.gpu = Some(cuda_block());
        let tmp = tempfile::tempdir().unwrap();
        let out = compile_device_phase0(tmp.path(), tmp.path(), 1, "", None, &manifest)
            .await
            .unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn missing_gpu_block_returns_none() {
        let manifest = CompileManifest::generic_fallback();
        let tmp = tempfile::tempdir().unwrap();
        let out = compile_device_phase0(
            tmp.path(),
            tmp.path(),
            1,
            "__global__ void k() {}",
            None,
            &manifest,
        )
        .await
        .unwrap();
        assert!(out.is_none());
    }

    #[cfg(not(feature = "gpu-hmr"))]
    #[tokio::test]
    async fn returns_none_when_feature_disabled() {
        // With gpu-hmr off the entry point declines regardless of input.
        let mut manifest = CompileManifest::generic_fallback();
        manifest.gpu = Some(cuda_block());
        let tmp = tempfile::tempdir().unwrap();
        let out = compile_device_phase0(
            tmp.path(),
            tmp.path(),
            1,
            "__global__ void k() {}",
            None,
            &manifest,
        )
        .await
        .unwrap();
        assert!(out.is_none(), "device compile must be a no-op without gpu-hmr feature");
    }
}
