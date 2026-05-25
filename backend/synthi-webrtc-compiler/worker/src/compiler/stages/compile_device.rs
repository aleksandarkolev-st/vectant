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
// intermediate, cubin is the load-time artifact. For ROCm single-arch
// HMR we ask hipcc for raw device-only output; multi-arch builds still use
// bundled output and extract the active AMDGPU code object for HIP's module
// loader.
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
use crate::hmr::compile_manifest::CompileManifest;
#[cfg(feature = "gpu-hmr")]
use crate::hmr::compile_manifest::{DeviceCompiler, DeviceVendor};
#[cfg(feature = "gpu-hmr")]
use anyhow::Context;
use anyhow::Result;
#[cfg(feature = "gpu-hmr")]
use regex::Regex;
#[cfg(feature = "gpu-hmr")]
use sha2::{Digest, Sha256};
#[cfg(feature = "gpu-hmr")]
use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};
use std::path::{Path, PathBuf};
#[cfg(feature = "gpu-hmr")]
use tokio::io::AsyncReadExt;
#[cfg(feature = "gpu-hmr")]
use tokio::time::{timeout, Duration};

/// Standard filenames for the AI-synthesised device source files.
pub const DEVICE_CU_FILENAME: &str = "device.cu";
pub const DEVICE_HIP_FILENAME: &str = "device.hip";
#[cfg(feature = "gpu-hmr")]
const DEFAULT_DEVICE_FULL_COMPILE_TIMEOUT_SECS: u64 = 180;
#[cfg(feature = "gpu-hmr")]
const DEFAULT_DEVICE_PARTIAL_COMPILE_TIMEOUT_SECS: u64 = 60;
#[cfg(feature = "gpu-hmr")]
const DEVICE_ARTIFACT_CACHE_SCHEMA: &str = "synthi.gpu.device_artifact_cache.v1";
#[cfg(feature = "gpu-hmr")]
const DEVICE_ARTIFACT_CACHE_KEY_SCHEMA: &str = "synthi.gpu.device_artifact_cache_key.v2";
#[cfg(feature = "gpu-hmr")]
const DEVICE_ARTIFACT_CACHE_DIR_ENV: &str = "SYNTHI_GPU_HMR_DEVICE_ARTIFACT_CACHE_DIR";
#[cfg(feature = "gpu-hmr")]
const DEVICE_ARTIFACT_CACHE_SCOPE_ENV: &str = "SYNTHI_GPU_HMR_DEVICE_ARTIFACT_CACHE_SCOPE";
#[cfg(feature = "gpu-hmr")]
const DEVICE_ARTIFACT_CACHE_GLOBAL_DIR: &str = "synthi-gpu-device-artifacts";
#[cfg(feature = "gpu-hmr")]
const DEVICE_CACHE_MAX_INCLUDED_FILES: usize = 8192;
#[cfg(feature = "gpu-hmr")]
const DEVICE_CACHE_MAX_INCLUDED_BYTES: u64 = 256 * 1024 * 1024;
#[cfg(feature = "gpu-hmr")]
const DEVICE_CACHE_MAX_SINGLE_INCLUDE_BYTES: u64 = 64 * 1024 * 1024;
#[cfg(feature = "gpu-hmr")]
const DEVICE_DEPFILE_TIMEOUT_SECS: u64 = 15;

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
    /// Wall-clock time spent inside the device compiler process for the
    /// successful attempt. This excludes source generation, host rebuild,
    /// runner reload, and artifact unbundling.
    pub compiler_elapsed_ms: u64,
    pub partial_module: bool,
    pub target_symbols: Vec<String>,
    pub fallback_used: bool,
    pub fallback_reason: Option<String>,
    pub requested_artifact_kind: Option<String>,
    pub selected_artifact_kind: Option<String>,
    pub selected_artifact_bytes: Option<usize>,
    pub full_device_bytes: Option<usize>,
    pub artifact_exported_symbols: Vec<String>,
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
    let compiler_exe = manifest.select_compiler(crate::hmr::compile_manifest::ModuleKind::Device);
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
            match prune_redundant_generated_device_includes(
                workspace_dir,
                source_filename,
                &current_source,
                &gpu.device_flags,
            )
            .await
            {
                Ok(sanitized) if sanitized != current_source => {
                    eprintln!(
                        "[compile-device] pruned redundant generated device include bridge entries before compile"
                    );
                    current_source = sanitized;
                }
                Ok(_) => {}
                Err(e) => {
                    eprintln!("[compile-device] generated include pruning skipped: {e}");
                }
            }
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
                    eprintln!("[compile-device] source-owned declaration cleanup skipped: {e}");
                }
            }
        }

        tokio::fs::write(&source_path, &current_source)
            .await
            .context("writing device source")?;

        let cache_key = device_artifact_cache_key(
            workspace_dir,
            compiler_exe,
            gpu,
            source_filename,
            &current_source,
        )
        .await?;
        if let Some(cache_key) = cache_key.as_ref() {
            if restore_cached_device_artifact(workspace_dir, &cache_key.cache_key, &artifact_path)
                .await?
            {
                let artifact_exported_symbols =
                    inspect_device_artifact_exported_symbols(gpu.vendor, &artifact_path).await;
                eprintln!(
                    "[compile-device] artifact cache hit key={} dependency_hash={} dependency_method={} compile_command_hash={} artifact={}",
                    cache_key.cache_key,
                    cache_key.dependency_hash,
                    cache_key.dependency_method,
                    cache_key.compile_command_hash,
                    artifact_path.display()
                );
                return Ok(Some(DeviceCompileOutcome {
                    artifact_path,
                    compiled_source: current_source,
                    compiler_elapsed_ms: 0,
                    partial_module: false,
                    target_symbols: Vec::new(),
                    fallback_used: false,
                    fallback_reason: None,
                    requested_artifact_kind: None,
                    selected_artifact_kind: None,
                    selected_artifact_bytes: None,
                    full_device_bytes: None,
                    artifact_exported_symbols,
                    diagnostics: GpuToolchainDiagnostics::default(),
                    stderr: String::new(),
                }));
            }
        }

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
                "[compile-device] {} ok  artifact={}  compiler_ms={} diagnostics_kernels={}",
                compiler_exe,
                artifact_path.display(),
                compile.elapsed_ms,
                compile.diagnostics.register_pressure.len()
            );
            let artifact_exported_symbols =
                inspect_device_artifact_exported_symbols(gpu.vendor, &artifact_path).await;

            if let Some(cache_key) = cache_key.as_ref() {
                if let Err(e) =
                    store_cached_device_artifact(workspace_dir, cache_key, &artifact_path).await
                {
                    eprintln!("[compile-device] artifact cache store skipped: {e}");
                }
            }

            return Ok(Some(DeviceCompileOutcome {
                artifact_path,
                compiled_source: current_source,
                compiler_elapsed_ms: compile.elapsed_ms,
                partial_module: false,
                target_symbols: Vec::new(),
                fallback_used: false,
                fallback_reason: None,
                requested_artifact_kind: None,
                selected_artifact_kind: None,
                selected_artifact_bytes: None,
                full_device_bytes: None,
                artifact_exported_symbols,
                diagnostics: compile.diagnostics,
                stderr: compile.stderr,
            }));
        }

        eprintln!(
            "[compile-device] {} FAILED status={} compiler_ms={}\n{}",
            compiler_exe, compile.status, compile.elapsed_ms, compile.stderr
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
async fn prune_redundant_generated_device_includes(
    workspace_dir: &Path,
    source_filename: &str,
    source: &str,
    device_flags: &[String],
) -> Result<String> {
    let includes =
        resolve_top_level_device_includes(workspace_dir, source_filename, source, device_flags);
    if includes.len() <= 1 {
        return Ok(source.to_string());
    }

    let mut remove_indices = HashSet::new();
    let mut seen_paths = HashSet::new();
    for (index, include) in includes.iter().enumerate() {
        if !seen_paths.insert(include.normalized.clone())
            && generated_device_include_can_be_pruned(workspace_dir, include).await
        {
            remove_indices.insert(index);
        }
    }

    for (index, include) in includes.iter().enumerate() {
        if remove_indices.contains(&index)
            || !generated_device_include_can_be_pruned(workspace_dir, include).await
        {
            continue;
        }
        for (other_index, other) in includes.iter().enumerate() {
            if index == other_index || include.normalized == other.normalized {
                continue;
            }
            if include_file_reaches_target(
                workspace_dir,
                &other.resolved,
                &include.normalized,
                device_flags,
            )
            .await?
            {
                remove_indices.insert(index);
                break;
            }
        }
    }

    if remove_indices.is_empty() {
        return Ok(source.to_string());
    }

    let mut remove_spans = includes
        .iter()
        .enumerate()
        .filter_map(|(index, include)| {
            if remove_indices.contains(&index) {
                Some((include.start, include.end, include.path.as_str()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    remove_spans.sort_by_key(|(start, _, _)| *start);

    let mut output = String::with_capacity(source.len());
    let mut cursor = 0usize;
    for (start, end, include_path) in remove_spans {
        if start < cursor || end > source.len() {
            continue;
        }
        output.push_str(&source[cursor..start]);
        output.push_str("// synthi-gpu-hmr: pruned redundant generated device include");
        if source[start..end].ends_with('\n') {
            output.push('\n');
        }
        cursor = end;
        eprintln!("[compile-device] pruned redundant generated device include path={include_path}");
    }
    output.push_str(&source[cursor..]);
    Ok(output)
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug, Clone)]
struct TopLevelDeviceInclude {
    path: String,
    start: usize,
    end: usize,
    resolved: PathBuf,
    normalized: String,
}

#[cfg(feature = "gpu-hmr")]
fn resolve_top_level_device_includes(
    workspace_dir: &Path,
    source_filename: &str,
    source: &str,
    device_flags: &[String],
) -> Vec<TopLevelDeviceInclude> {
    let mut include_dirs = device_include_dirs(workspace_dir, device_flags);
    include_dirs.push(workspace_dir.to_path_buf());
    let source_path = workspace_dir.join(source_filename);
    let root_dir = source_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| workspace_dir.to_path_buf());
    include_dirs.push(root_dir.clone());

    parse_top_level_device_includes(source)
        .into_iter()
        .filter_map(|include| {
            let resolved = resolve_device_include(
                workspace_dir,
                &root_dir,
                &include.path,
                include.quoted,
                &include_dirs,
            )?;
            let normalized = normalize_path_key(&resolved);
            Some(TopLevelDeviceInclude {
                path: include.path,
                start: include.start,
                end: include.end,
                resolved,
                normalized,
            })
        })
        .collect()
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug, Clone)]
struct RawTopLevelDeviceInclude {
    path: String,
    quoted: bool,
    start: usize,
    end: usize,
}

#[cfg(feature = "gpu-hmr")]
fn parse_top_level_device_includes(source: &str) -> Vec<RawTopLevelDeviceInclude> {
    let include_re = Regex::new(r#"^\s*#\s*include\s*(?P<delim>[<"])(?P<path>[^>"]+)[>"]"#)
        .expect("valid include regex");
    let mut includes = Vec::new();
    let mut offset = 0usize;
    for line in source.split_inclusive('\n') {
        let line_body = line.trim_end_matches(['\r', '\n']);
        if let Some(caps) = include_re.captures(line_body) {
            if let Some(path) = caps.name("path").map(|m| m.as_str().trim()) {
                if !path.is_empty() {
                    includes.push(RawTopLevelDeviceInclude {
                        path: path.replace('\\', "/"),
                        quoted: caps.name("delim").map(|m| m.as_str()) == Some("\""),
                        start: offset,
                        end: offset + line.len(),
                    });
                }
            }
        }
        offset += line.len();
    }
    includes
}

#[cfg(feature = "gpu-hmr")]
async fn generated_device_include_can_be_pruned(
    workspace_dir: &Path,
    include: &TopLevelDeviceInclude,
) -> bool {
    if !path_is_within_workspace(workspace_dir, &include.resolved) {
        return false;
    }
    let Ok(metadata) = tokio::fs::metadata(&include.resolved).await else {
        return false;
    };
    if !metadata.is_file() || metadata.len() > DEVICE_CACHE_MAX_SINGLE_INCLUDE_BYTES {
        return false;
    }
    let Ok(content) = tokio::fs::read_to_string(&include.resolved).await else {
        return false;
    };
    !device_source_declares_kernel_entry(&content)
}

#[cfg(feature = "gpu-hmr")]
fn device_source_declares_kernel_entry(source: &str) -> bool {
    let kernel_re = Regex::new(
        r#"(?x)
        \b
        (
            __global__
            | GLOBAL_KERNEL_SIGNATURE
            | KERNEL_SIGNATURE
            | CUDA_KERNEL_SIGNATURE
            | HIP_KERNEL_SIGNATURE
        )
        \b
        "#,
    )
    .expect("valid kernel entry regex");
    kernel_re.is_match(&strip_cpp_comments_for_device_compile(source))
}

#[cfg(feature = "gpu-hmr")]
async fn include_file_reaches_target(
    workspace_dir: &Path,
    start_path: &Path,
    target_normalized: &str,
    device_flags: &[String],
) -> Result<bool> {
    let mut include_dirs = device_include_dirs(workspace_dir, device_flags);
    include_dirs.push(workspace_dir.to_path_buf());

    let mut queue = VecDeque::from([start_path.to_path_buf()]);
    let mut visited = HashSet::new();
    let mut total_bytes = 0u64;
    while let Some(path) = queue.pop_front() {
        let normalized = normalize_path_key(&path);
        if !visited.insert(normalized) {
            continue;
        }
        if visited.len() > DEVICE_CACHE_MAX_INCLUDED_FILES {
            return Ok(false);
        }

        let Ok(metadata) = tokio::fs::metadata(&path).await else {
            continue;
        };
        if !metadata.is_file() || metadata.len() > DEVICE_CACHE_MAX_SINGLE_INCLUDE_BYTES {
            continue;
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > DEVICE_CACHE_MAX_INCLUDED_BYTES {
            return Ok(false);
        }

        let Ok(content) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let including_dir = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| workspace_dir.to_path_buf());
        for include in parse_includes(&content) {
            let Some(next) = resolve_device_include(
                workspace_dir,
                &including_dir,
                &include.path,
                include.quoted,
                &include_dirs,
            ) else {
                continue;
            };
            let next_normalized = normalize_path_key(&next);
            if next_normalized == target_normalized {
                return Ok(true);
            }
            if path_is_within_workspace(workspace_dir, &next) {
                queue.push_back(next);
            }
        }
    }
    Ok(false)
}

#[cfg(feature = "gpu-hmr")]
fn path_is_within_workspace(workspace_dir: &Path, path: &Path) -> bool {
    path.starts_with(workspace_dir)
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
    let include_re = Regex::new(r#"(?m)^\s*#\s*include\s*(?P<delim>[<"])(?P<path>[^>"]+)[>"]"#)
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
            iter.next()
                .map(|next| vec![next.clone()])
                .unwrap_or_default()
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
    let device_fn_re = Regex::new(&format!(
        r#"(?xs)
        \b(?:{}|__device__|__host__\s+__device__|__device__\s+__host__)\b
        (?P<signature>[^;{{}}]*?)
        \b(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*
        \(
            [^;{{}}()]*
            (?:\([^;{{}}()]*\)[^;{{}}()]*)*
        \)
        \s*(?:;|\{{)
        "#,
        device_annotation_macro_pattern()
    ))
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

    let masked_source = strip_cpp_comments_for_device_compile(source);
    let forward_decl_re = Regex::new(&format!(
        r#"(?ms)^[ \t]*(?:extern\s+(?:"C"\s+)?\s*)?(?:__device__|{}|__host__\s+__device__|__device__\s+__host__)\b[^;{{}}]*?\b(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*\([^;{{}}()]*(?:\([^;{{}}()]*\)[^;{{}}()]*)*\)\s*;\s*(?:\r?\n)?"#,
        device_annotation_macro_pattern()
    ))
    .expect("valid forward declaration regex");
    let out = forward_decl_re
        .replace_all(source, |caps: &regex::Captures| {
            let name = caps.name("name").map(|m| m.as_str()).unwrap_or("");
            let declaration_end = caps.get(0).map(|m| m.end()).unwrap_or(0);
            if source_owned_names.contains(name)
                && !forward_decl_is_required_before_later_include(
                    &masked_source,
                    declaration_end,
                    name,
                )
            {
                String::new()
            } else {
                caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string()
            }
        })
        .into_owned();

    let empty_extern_c_re = Regex::new(r#"(?ms)^[ \t]*extern\s+"C"\s*\{\s*\}\s*(?:\r?\n)?"#)
        .expect("valid empty extern C regex");
    empty_extern_c_re.replace_all(&out, "").into_owned()
}

#[cfg(feature = "gpu-hmr")]
fn forward_decl_is_required_before_later_include(
    masked_source: &str,
    declaration_end: usize,
    name: &str,
) -> bool {
    if name.trim().is_empty() || declaration_end >= masked_source.len() {
        return false;
    }

    let tail = &masked_source[declaration_end..];
    let include_re =
        Regex::new(r#"(?m)^\s*#\s*include\s*[<"][^>"]+[>"]"#).expect("valid include regex");
    let before_next_include = include_re
        .find(tail)
        .map(|m| &tail[..m.start()])
        .unwrap_or(tail);
    if before_next_include.trim().is_empty() {
        return false;
    }

    let escaped = regex::escape(name);
    let use_re = Regex::new(&format!(r#"\b{}\s*\("#, escaped)).expect("valid identifier regex");
    use_re.is_match(before_next_include)
}

#[cfg(feature = "gpu-hmr")]
fn device_annotation_macro_pattern() -> &'static str {
    r#"[A-Z][A-Z0-9_]*(?:DEVICE|GPU|CUDA|HIP)[A-Z0-9_]*"#
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
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(feature = "gpu-hmr")]
fn is_partial_device_source_filename(source_filename: &str) -> bool {
    source_filename
        .replace('\\', "/")
        .rsplit('/')
        .next()
        .is_some_and(|name| name.contains(".partial."))
}

#[cfg(feature = "gpu-hmr")]
fn positive_timeout_secs(value: Option<String>) -> Option<u64> {
    value
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
}

#[cfg(feature = "gpu-hmr")]
fn device_compile_timeout_secs_for(
    source_filename: &str,
    global_override: Option<u64>,
    partial_override: Option<u64>,
    full_override: Option<u64>,
) -> u64 {
    if let Some(secs) = global_override {
        return secs;
    }
    if is_partial_device_source_filename(source_filename) {
        partial_override.unwrap_or(DEFAULT_DEVICE_PARTIAL_COMPILE_TIMEOUT_SECS)
    } else {
        full_override.unwrap_or(DEFAULT_DEVICE_FULL_COMPILE_TIMEOUT_SECS)
    }
}

#[cfg(feature = "gpu-hmr")]
fn device_compile_timeout_secs(source_filename: &str) -> u64 {
    device_compile_timeout_secs_for(
        source_filename,
        positive_timeout_secs(std::env::var("SYNTHI_GPU_HMR_DEVICE_COMPILE_TIMEOUT_SECS").ok()),
        positive_timeout_secs(
            std::env::var("SYNTHI_GPU_HMR_DEVICE_PARTIAL_COMPILE_TIMEOUT_SECS").ok(),
        ),
        positive_timeout_secs(
            std::env::var("SYNTHI_GPU_HMR_DEVICE_FULL_COMPILE_TIMEOUT_SECS").ok(),
        ),
    )
}

#[cfg(feature = "gpu-hmr")]
fn device_artifact_cache_disabled() -> bool {
    std::env::var("SYNTHI_GPU_HMR_DEVICE_ARTIFACT_CACHE")
        .ok()
        .is_some_and(|value| matches!(value.trim(), "0" | "false" | "False" | "FALSE"))
}

#[cfg(feature = "gpu-hmr")]
fn cache_update_str(hasher: &mut Sha256, label: &str, value: &str) {
    hasher.update(label.as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    hasher.update([0xff]);
}

#[cfg(feature = "gpu-hmr")]
fn cache_update_bytes(hasher: &mut Sha256, label: &str, value: &[u8]) {
    hasher.update(label.as_bytes());
    hasher.update([0]);
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
    hasher.update([0xff]);
}

#[cfg(feature = "gpu-hmr")]
fn cache_hex(hasher: Sha256) -> String {
    format!("{:x}", hasher.finalize())
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct DeviceArtifactCacheKey {
    cache_key: String,
    dependency_hash: String,
    dependency_method: String,
    compile_command_hash: String,
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct DeviceDependencyDigest {
    hash: String,
    method: String,
}

#[cfg(feature = "gpu-hmr")]
async fn device_artifact_cache_key(
    workspace_dir: &Path,
    compiler_exe: &str,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
    source: &str,
) -> Result<Option<DeviceArtifactCacheKey>> {
    if device_artifact_cache_disabled() {
        return Ok(None);
    }

    let normalized_command =
        normalized_device_compile_command_tokens(workspace_dir, compiler_exe, gpu, source_filename);
    let compile_command_hash = hash_string_sequence("compile_command", &normalized_command);

    let Some(dependency_digest) =
        device_dependency_cache_hash(workspace_dir, compiler_exe, gpu, source_filename, source)
            .await?
    else {
        return Ok(None);
    };

    let mut hasher = Sha256::new();
    cache_update_str(&mut hasher, "cache_key_schema", DEVICE_ARTIFACT_CACHE_KEY_SCHEMA);
    cache_update_str(&mut hasher, "artifact_schema", DEVICE_ARTIFACT_CACHE_SCHEMA);
    cache_update_str(
        &mut hasher,
        "artifact_kind",
        if is_partial_device_source_filename(source_filename) {
            "partial"
        } else {
            "full"
        },
    );
    cache_update_str(&mut hasher, "compiler_exe", compiler_exe);
    let Some(compiler_identity) = device_compiler_identity(compiler_exe).await? else {
        return Ok(None);
    };
    cache_update_str(&mut hasher, "compiler_identity", &compiler_identity);
    cache_update_str(&mut hasher, "sdk_version", &gpu_sdk_version_fingerprint(gpu));
    cache_update_str(&mut hasher, "vendor", gpu.vendor.as_str());
    cache_update_str(
        &mut hasher,
        "device_compiler",
        gpu.device_compiler.executable(),
    );
    for arch in &gpu.arch {
        cache_update_str(&mut hasher, "arch", arch);
    }
    cache_update_str(&mut hasher, "target_triple", &target_triple_fingerprint(gpu));
    for (name, value) in device_compiler_env_fingerprint(gpu) {
        cache_update_str(&mut hasher, "env_name", &name);
        cache_update_str(&mut hasher, "env_value", &value);
    }
    for flag in &gpu.device_flags {
        cache_update_str(&mut hasher, "flag", flag);
    }
    for token in &normalized_command {
        cache_update_str(&mut hasher, "compile_token", token);
    }
    for classified in classified_device_flags(workspace_dir, &gpu.device_flags) {
        cache_update_str(&mut hasher, "classified_flag", &classified);
    }
    cache_update_str(&mut hasher, "compile_command_hash", &compile_command_hash);
    cache_update_str(
        &mut hasher,
        "source_filename",
        &source_filename.replace('\\', "/"),
    );
    cache_update_bytes(&mut hasher, "source", source.as_bytes());
    cache_update_str(&mut hasher, "dependency_method", &dependency_digest.method);
    cache_update_str(&mut hasher, "dependency_hash", &dependency_digest.hash);

    Ok(Some(DeviceArtifactCacheKey {
        cache_key: cache_hex(hasher),
        dependency_hash: dependency_digest.hash,
        dependency_method: dependency_digest.method,
        compile_command_hash,
    }))
}

#[cfg(feature = "gpu-hmr")]
fn hash_string_sequence(label: &str, values: &[String]) -> String {
    let mut hasher = Sha256::new();
    cache_update_str(&mut hasher, "sequence", label);
    for value in values {
        cache_update_str(&mut hasher, "value", value);
    }
    cache_hex(hasher)
}

#[cfg(feature = "gpu-hmr")]
fn normalized_device_compile_command_tokens(
    workspace_dir: &Path,
    compiler_exe: &str,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
) -> Vec<String> {
    let mut cmd = tokio::process::Command::new(compiler_exe);
    let artifact_placeholder = PathBuf::from("__synthi_device_artifact__");
    populate_device_command(&mut cmd, gpu, source_filename, &artifact_placeholder);
    normalize_compile_command_tokens(
        workspace_dir,
        compiler_exe,
        source_filename,
        cmd.as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned()),
    )
}

#[cfg(feature = "gpu-hmr")]
fn normalize_compile_command_tokens<I>(
    workspace_dir: &Path,
    compiler_exe: &str,
    source_filename: &str,
    args: I,
) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let normalized_source = source_filename.replace('\\', "/");
    let mut out = vec![compiler_exe.to_string()];
    let mut previous_path_flag = false;
    for token in args {
        if previous_path_flag {
            out.push(normalize_path_flag_value(workspace_dir, &token));
            previous_path_flag = false;
            continue;
        }
        if is_separate_path_value_flag(&token) {
            previous_path_flag = true;
            out.push(token);
            continue;
        }
        if token.replace('\\', "/") == normalized_source {
            out.push(normalize_path_flag_value(workspace_dir, &token));
            continue;
        }
        out.push(normalize_compile_command_token(workspace_dir, &token));
    }
    out
}

#[cfg(feature = "gpu-hmr")]
fn normalize_path_flag_value(workspace_dir: &Path, value: &str) -> String {
    let value = value.replace('\\', "/");
    if is_windows_absolute_path_value(&value) {
        return normalize_windows_absolute_path_value(&value);
    }
    let path = PathBuf::from(&value);
    if path.is_absolute() {
        normalize_path_key(&path)
    } else {
        normalize_path_key(&workspace_dir.join(path))
    }
}

#[cfg(feature = "gpu-hmr")]
fn is_windows_absolute_path_value(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && bytes[2] == b'/')
        || value.starts_with("//")
}

#[cfg(feature = "gpu-hmr")]
fn normalize_windows_absolute_path_value(value: &str) -> String {
    let mut normalized = value.replace('\\', "/");
    if normalized.as_bytes().get(1) == Some(&b':') {
        let drive = normalized[0..1].to_ascii_lowercase();
        normalized.replace_range(0..1, &drive);
    }
    normalized
}

#[cfg(feature = "gpu-hmr")]
fn is_separate_path_value_flag(flag: &str) -> bool {
    matches!(
        flag,
        "-I"
            | "-isystem"
            | "-iquote"
            | "-idirafter"
            | "-include"
            | "--include"
            | "--include-directory"
            | "--system-include"
            | "--sysroot"
            | "-isysroot"
    )
}

#[cfg(feature = "gpu-hmr")]
fn normalize_compile_command_token(workspace_dir: &Path, token: &str) -> String {
    let token = token.replace('\\', "/");
    if token == "__synthi_device_artifact__" {
        return token;
    }
    for prefix in [
        "--include-directory=",
        "--system-include=",
        "--sysroot=",
    ] {
        if let Some(rest) = token.strip_prefix(prefix).filter(|rest| !rest.is_empty()) {
            return format!("{prefix}{}", normalize_path_flag_value(workspace_dir, rest));
        }
    }
    for prefix in [
        "-I",
        "-isystem",
        "-iquote",
        "-idirafter",
        "-include",
        "-isysroot",
    ] {
        if token != prefix {
            if let Some(rest) = token.strip_prefix(prefix).filter(|rest| !rest.is_empty()) {
                return format!("{prefix}{}", normalize_path_flag_value(workspace_dir, rest));
            }
        }
    }
    token
}

#[cfg(feature = "gpu-hmr")]
fn classified_device_flags(workspace_dir: &Path, device_flags: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut iter = device_flags.iter().peekable();
    while let Some(flag) = iter.next() {
        let class = if matches!(flag.as_str(), "-I" | "-isystem" | "-iquote" | "-idirafter") {
            iter.peek().map(|next| {
                format!(
                    "include_path:{flag}:{}",
                    normalize_path_flag_value(workspace_dir, next)
                )
            })
        } else if matches!(flag.as_str(), "-D" | "-U") {
            iter.peek().map(|next| format!("define:{flag}:{next}"))
        } else if matches!(flag.as_str(), "-std" | "--std") {
            iter.peek().map(|next| format!("std:{flag}:{next}"))
        } else if flag.starts_with("-I")
            || flag.starts_with("-isystem")
            || flag.starts_with("-iquote")
            || flag.starts_with("-idirafter")
            || flag.starts_with("--include-directory=")
            || flag.starts_with("--system-include=")
        {
            Some(format!(
                "include_path:{}",
                normalize_compile_command_token(workspace_dir, flag)
            ))
        } else if flag.starts_with("-D") || flag.starts_with("-U") {
            Some(format!("define:{flag}"))
        } else if flag.starts_with("-std=") || flag.starts_with("--std=") {
            Some(format!("std:{flag}"))
        } else {
            None
        };
        if let Some(class) = class {
            out.push(class);
        }
    }
    out
}

#[cfg(feature = "gpu-hmr")]
fn target_triple_fingerprint(gpu: &crate::hmr::compile_manifest::GpuBuildBlock) -> String {
    let mut parts = Vec::new();
    let mut iter = gpu.device_flags.iter().peekable();
    while let Some(flag) = iter.next() {
        if flag == "--target" || flag == "-target" {
            if let Some(next) = iter.next() {
                parts.push(format!("{flag}={next}"));
            }
        } else if flag.starts_with("--target=") || flag.starts_with("-target=") {
            parts.push(flag.clone());
        }
    }
    if parts.is_empty() {
        format!("{}:{}", gpu.vendor.as_str(), gpu.arch.join(","))
    } else {
        parts.join("|")
    }
}

#[cfg(feature = "gpu-hmr")]
fn device_compiler_env_fingerprint(
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
) -> Vec<(String, String)> {
    let mut names = vec![
        "CPATH",
        "CPLUS_INCLUDE_PATH",
        "HIP_PATH",
        "HIP_PLATFORM",
        "HIPCC_VERBOSE",
        "HSA_OVERRIDE_GFX_VERSION",
        "ROCM_HOME",
        "ROCM_PATH",
    ];
    if gpu.vendor == DeviceVendor::Cuda {
        names.extend(["CUDA_HOME", "CUDA_PATH"]);
    }
    let mut out = names
        .into_iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (name.to_string(), value)))
        .collect::<Vec<_>>();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(feature = "gpu-hmr")]
fn gpu_sdk_version_fingerprint(gpu: &crate::hmr::compile_manifest::GpuBuildBlock) -> String {
    match gpu.vendor {
        DeviceVendor::Rocm => {
            let root = std::env::var("ROCM_PATH")
                .or_else(|_| std::env::var("ROCM_HOME"))
                .unwrap_or_else(|_| "/opt/rocm".to_string());
            let version_file = PathBuf::from(root).join(".info/version");
            std::fs::read_to_string(&version_file)
                .map(|raw| format!("rocm:{}", raw.trim()))
                .unwrap_or_else(|_| "rocm:unavailable".to_string())
        }
        DeviceVendor::Cuda => {
            let root = std::env::var("CUDA_HOME")
                .or_else(|_| std::env::var("CUDA_PATH"))
                .unwrap_or_else(|_| "/usr/local/cuda".to_string());
            let version_file = PathBuf::from(root).join("version.txt");
            std::fs::read_to_string(&version_file)
                .map(|raw| format!("cuda:{}", raw.trim()))
                .unwrap_or_else(|_| "cuda:unavailable".to_string())
        }
    }
}

#[cfg(feature = "gpu-hmr")]
async fn device_dependency_cache_hash(
    workspace_dir: &Path,
    compiler_exe: &str,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
    source: &str,
) -> Result<Option<DeviceDependencyDigest>> {
    if let Some(depfile_hash) =
        compiler_depfile_dependency_cache_hash(workspace_dir, compiler_exe, gpu, source_filename)
            .await?
    {
        return Ok(Some(depfile_hash));
    }

    reachable_device_include_cache_hash(workspace_dir, source_filename, source, &gpu.device_flags)
        .await
}

#[cfg(feature = "gpu-hmr")]
async fn compiler_depfile_dependency_cache_hash(
    workspace_dir: &Path,
    compiler_exe: &str,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
) -> Result<Option<DeviceDependencyDigest>> {
    if std::env::var("SYNTHI_GPU_HMR_DEVICE_DEPFILE_CACHE")
        .ok()
        .is_some_and(|value| matches!(value.trim(), "0" | "false" | "False" | "FALSE"))
    {
        return Ok(None);
    }

    let dep_dir = device_artifact_cache_dir(workspace_dir).join("depfiles");
    tokio::fs::create_dir_all(&dep_dir)
        .await
        .with_context(|| format!("creating device depfile cache {}", dep_dir.display()))?;
    let dep_stem = hex_sha256(
        format!(
            "{}|{}|{}|{}",
            compiler_exe,
            source_filename,
            gpu.vendor.as_str(),
            gpu.arch.join(",")
        )
        .as_bytes(),
    );
    let depfile = dep_dir.join(format!("{dep_stem}.d"));

    let mut cmd = crate::infra::utils::system_command(compiler_exe);
    cmd.current_dir(workspace_dir)
        .arg("-M")
        .arg("-MT")
        .arg("synthi_device_artifact")
        .arg("-MF")
        .arg(&depfile);
    for flag in dependency_probe_flags(gpu) {
        cmd.arg(flag);
    }
    cmd.arg(source_filename).kill_on_drop(true);

    let out = match timeout(Duration::from_secs(DEVICE_DEPFILE_TIMEOUT_SECS), cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            eprintln!("[compile-device] dependency depfile probe unavailable: {e}");
            return Ok(None);
        }
        Err(_) => {
            eprintln!(
                "[compile-device] dependency depfile probe timed out after {}s",
                DEVICE_DEPFILE_TIMEOUT_SECS
            );
            return Ok(None);
        }
    };
    if !out.status.success() {
        eprintln!(
            "[compile-device] dependency depfile probe failed status={} stderr={}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return Ok(None);
    }

    let raw = match tokio::fs::read_to_string(&depfile).await {
        Ok(raw) => raw,
        Err(e) => {
            eprintln!("[compile-device] dependency depfile missing: {e}");
            return Ok(None);
        }
    };
    let paths = parse_make_depfile_paths(&raw);
    if paths.is_empty() {
        return Ok(None);
    }
    hash_dependency_paths(workspace_dir, paths, Vec::new(), "depfile").await
}

#[cfg(feature = "gpu-hmr")]
fn dependency_probe_flags(gpu: &crate::hmr::compile_manifest::GpuBuildBlock) -> Vec<String> {
    let mut out = Vec::new();
    let mut iter = gpu.device_flags.iter().peekable();
    while let Some(flag) = iter.next() {
        if matches!(
            flag.as_str(),
            "-I"
                | "-isystem"
                | "-iquote"
                | "-idirafter"
                | "-D"
                | "-U"
                | "-include"
                | "--include"
                | "-std"
                | "--std"
                | "-x"
                | "--sysroot"
                | "-isysroot"
        ) {
            out.push(flag.clone());
            if let Some(next) = iter.next() {
                out.push(next.clone());
            }
            continue;
        }
        if flag.starts_with("-I")
            || flag.starts_with("-isystem")
            || flag.starts_with("-iquote")
            || flag.starts_with("-idirafter")
            || flag.starts_with("-D")
            || flag.starts_with("-U")
            || flag.starts_with("-std=")
            || flag.starts_with("--std=")
            || flag.starts_with("-x")
            || flag.starts_with("--include=")
            || flag.starts_with("--include-directory=")
            || flag.starts_with("--system-include=")
            || flag.starts_with("--sysroot=")
            || flag.starts_with("-isysroot")
        {
            out.push(flag.clone());
        }
    }
    match gpu.device_compiler {
        DeviceCompiler::Hipcc => {
            for arch in &gpu.arch {
                out.push(format!("--offload-arch={arch}"));
            }
        }
        DeviceCompiler::Nvcc => {
            for arch in &gpu.arch {
                out.push(format!("-arch={arch}"));
            }
        }
        DeviceCompiler::ClangCuda => {
            for arch in &gpu.arch {
                out.push(format!("--cuda-gpu-arch={arch}"));
            }
        }
    }
    out
}

#[cfg(feature = "gpu-hmr")]
fn parse_make_depfile_paths(raw: &str) -> Vec<String> {
    let Some((_, deps)) = raw.split_once(':') else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    let mut current = String::new();
    let mut escaped = false;
    for ch in deps.chars() {
        if escaped {
            if ch != '\n' && ch != '\r' {
                current.push(ch);
            }
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                paths.push(current.clone());
                current.clear();
            }
        } else {
            current.push(ch);
        }
    }
    if !current.is_empty() {
        paths.push(current);
    }
    paths
}

#[cfg(feature = "gpu-hmr")]
async fn device_compiler_identity(compiler_exe: &str) -> Result<Option<String>> {
    let mut cmd = crate::infra::utils::system_command(compiler_exe);
    cmd.arg("--version").kill_on_drop(true);
    let out = match timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            eprintln!(
                "[compile-device] artifact cache disabled - compiler identity probe failed: {e}"
            );
            return Ok(None);
        }
        Err(_) => {
            eprintln!(
                "[compile-device] artifact cache disabled - compiler identity probe timed out"
            );
            return Ok(None);
        }
    };
    let mut hasher = Sha256::new();
    cache_update_str(&mut hasher, "compiler", compiler_exe);
    cache_update_bytes(&mut hasher, "stdout", &out.stdout);
    cache_update_bytes(&mut hasher, "stderr", &out.stderr);
    cache_update_str(&mut hasher, "status", &out.status.to_string());
    Ok(Some(cache_hex(hasher)))
}

#[cfg(feature = "gpu-hmr")]
async fn reachable_device_include_cache_hash(
    workspace_dir: &Path,
    source_filename: &str,
    source: &str,
    device_flags: &[String],
) -> Result<Option<DeviceDependencyDigest>> {
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
        queue.push_back((root_dir.clone(), include));
    }

    let mut visited = HashSet::new();
    let mut dependency_paths = vec![source_filename.replace('\\', "/")];
    let mut unresolved_includes = Vec::new();

    while let Some((including_dir, include)) = queue.pop_front() {
        let Some(path) = resolve_device_include(
            workspace_dir,
            &including_dir,
            &include.path,
            include.quoted,
            &include_dirs,
        ) else {
            unresolved_includes.push(include.path);
            continue;
        };

        let normalized = normalize_path_key(&path);
        if !visited.insert(normalized.clone()) {
            continue;
        }
        if visited.len() > DEVICE_CACHE_MAX_INCLUDED_FILES {
            eprintln!(
                "[compile-device] artifact cache disabled reason=cache.disabled.dependency_scan_unbounded files>{}",
                DEVICE_CACHE_MAX_INCLUDED_FILES
            );
            return Ok(None);
        }

        let metadata = tokio::fs::metadata(&path)
            .await
            .with_context(|| format!("stat device include {}", path.display()))?;
        if !metadata.is_file() {
            unresolved_includes.push(normalized);
            continue;
        }
        if metadata.len() > DEVICE_CACHE_MAX_SINGLE_INCLUDE_BYTES {
            eprintln!(
                "[compile-device] artifact cache disabled reason=cache.disabled.dependency_scan_unbounded include_too_large={} bytes={} limit={}",
                path.display(),
                metadata.len(),
                DEVICE_CACHE_MAX_SINGLE_INCLUDE_BYTES
            );
            return Ok(None);
        }
        dependency_paths.push(normalized);
        let content = tokio::fs::read(&path)
            .await
            .with_context(|| format!("read device include {}", path.display()))?;

        let including_dir = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| workspace_dir.to_path_buf());
        let text = String::from_utf8_lossy(&content);
        for nested in parse_includes(&text) {
            queue.push_back((including_dir.clone(), nested));
        }
    }

    hash_dependency_paths(
        workspace_dir,
        dependency_paths,
        unresolved_includes,
        "bounded_include_scanner",
    )
    .await
}

#[cfg(feature = "gpu-hmr")]
async fn hash_dependency_paths(
    workspace_dir: &Path,
    raw_paths: Vec<String>,
    unresolved_entries: Vec<String>,
    method: &str,
) -> Result<Option<DeviceDependencyDigest>> {
    let mut paths = BTreeMap::<String, PathBuf>::new();
    for raw in raw_paths {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let path = PathBuf::from(raw);
        let path = if path.is_absolute() {
            path
        } else {
            workspace_dir.join(path)
        };
        paths.insert(normalize_path_key(&path), path);
    }

    if paths.len() > DEVICE_CACHE_MAX_INCLUDED_FILES {
        eprintln!(
            "[compile-device] artifact cache disabled reason=cache.disabled.dependency_scan_unbounded files>{}",
            DEVICE_CACHE_MAX_INCLUDED_FILES
        );
        return Ok(None);
    }

    let mut total_bytes = 0u64;
    let mut hasher = Sha256::new();
    cache_update_str(&mut hasher, "dependency_schema", DEVICE_ARTIFACT_CACHE_KEY_SCHEMA);
    cache_update_str(&mut hasher, "dependency_method", method);
    for unresolved in unresolved_entries {
        cache_update_str(&mut hasher, "unresolved_dependency", &unresolved);
    }
    for (normalized, path) in paths {
        let metadata = match tokio::fs::metadata(&path).await {
            Ok(metadata) => metadata,
            Err(_) => {
                cache_update_str(&mut hasher, "missing_dependency", &normalized);
                continue;
            }
        };
        if !metadata.is_file() {
            cache_update_str(&mut hasher, "non_file_dependency", &normalized);
            continue;
        }
        if metadata.len() > DEVICE_CACHE_MAX_SINGLE_INCLUDE_BYTES {
            eprintln!(
                "[compile-device] artifact cache disabled reason=cache.disabled.dependency_scan_unbounded dependency_too_large={} bytes={} limit={}",
                path.display(),
                metadata.len(),
                DEVICE_CACHE_MAX_SINGLE_INCLUDE_BYTES
            );
            return Ok(None);
        }
        total_bytes = total_bytes.saturating_add(metadata.len());
        if total_bytes > DEVICE_CACHE_MAX_INCLUDED_BYTES {
            eprintln!(
                "[compile-device] artifact cache disabled reason=cache.disabled.dependency_scan_unbounded bytes>{}",
                DEVICE_CACHE_MAX_INCLUDED_BYTES
            );
            return Ok(None);
        }
        cache_update_str(&mut hasher, "dependency_path", &normalized);
        cache_update_str(&mut hasher, "dependency_size", &metadata.len().to_string());
        match tokio::fs::read(&path).await {
            Ok(content) => {
                cache_update_str(&mut hasher, "dependency_content_hash", &hex_sha256(&content));
            }
            Err(_) => {
                let modified = metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_nanos().to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                cache_update_str(&mut hasher, "dependency_mtime", &modified);
            }
        }
    }

    Ok(Some(DeviceDependencyDigest {
        hash: cache_hex(hasher),
        method: method.to_string(),
    }))
}

#[cfg(feature = "gpu-hmr")]
fn device_artifact_cache_dir(workspace_dir: &Path) -> PathBuf {
    let configured_dir = std::env::var(DEVICE_ARTIFACT_CACHE_DIR_ENV).ok();
    let configured_scope = std::env::var(DEVICE_ARTIFACT_CACHE_SCOPE_ENV).ok();
    device_artifact_cache_dir_from_config(
        workspace_dir,
        configured_dir.as_deref(),
        configured_scope.as_deref(),
    )
}

#[cfg(feature = "gpu-hmr")]
fn device_artifact_cache_dir_from_config(
    workspace_dir: &Path,
    configured_dir: Option<&str>,
    configured_scope: Option<&str>,
) -> PathBuf {
    if let Some(raw) = configured_dir.map(str::trim).filter(|raw| !raw.is_empty()) {
        return PathBuf::from(raw);
    }
    if matches!(
        configured_scope.map(str::trim),
        Some(scope) if scope.eq_ignore_ascii_case("workspace")
    ) {
        return workspace_dir.join(".synthi/cache/gpu-device-artifacts");
    }
    std::env::temp_dir().join(DEVICE_ARTIFACT_CACHE_GLOBAL_DIR)
}

#[cfg(feature = "gpu-hmr")]
async fn restore_cached_device_artifact(
    workspace_dir: &Path,
    cache_key: &str,
    artifact_path: &Path,
) -> Result<bool> {
    let ext = artifact_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("bin");
    let cache_dir = device_artifact_cache_dir(workspace_dir);
    let metadata_path = cache_dir.join(format!("{cache_key}.json"));
    let cached_path = cache_dir.join(format!("{cache_key}.{ext}"));
    let Ok(metadata_raw) = tokio::fs::read(&metadata_path).await else {
        eprintln!("[compile-device] artifact cache miss key={cache_key}");
        return Ok(false);
    };
    let metadata_json: serde_json::Value = match serde_json::from_slice(&metadata_raw) {
        Ok(value) => value,
        Err(e) => {
            eprintln!("[compile-device] artifact cache miss key={cache_key} reason=bad_metadata error={e}");
            return Ok(false);
        }
    };
    if metadata_json
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        != Some(DEVICE_ARTIFACT_CACHE_SCHEMA)
        || metadata_json
            .get("cacheKey")
            .and_then(serde_json::Value::as_str)
            != Some(cache_key)
    {
        eprintln!("[compile-device] artifact cache miss key={cache_key} reason=metadata_mismatch");
        return Ok(false);
    }
    let Ok(metadata) = tokio::fs::metadata(&cached_path).await else {
        eprintln!("[compile-device] artifact cache miss key={cache_key}");
        return Ok(false);
    };
    if !metadata.is_file() || metadata.len() == 0 {
        eprintln!("[compile-device] artifact cache miss key={cache_key} reason=invalid_entry");
        return Ok(false);
    }
    let Some(expected_bytes) = metadata_json
        .get("artifactBytes")
        .and_then(serde_json::Value::as_u64)
    else {
        eprintln!(
            "[compile-device] artifact cache miss key={cache_key} reason=metadata_missing_bytes"
        );
        return Ok(false);
    };
    if expected_bytes != metadata.len() {
        eprintln!(
            "[compile-device] artifact cache miss key={cache_key} reason=byte_count_mismatch"
        );
        return Ok(false);
    }
    let cached_content = tokio::fs::read(&cached_path)
        .await
        .with_context(|| format!("reading cached device artifact {}", cached_path.display()))?;
    let cached_hash = hex_sha256(&cached_content);
    let Some(expected_hash) = metadata_json
        .get("artifactSha256")
        .and_then(serde_json::Value::as_str)
    else {
        eprintln!(
            "[compile-device] artifact cache miss key={cache_key} reason=metadata_missing_hash"
        );
        return Ok(false);
    };
    if expected_hash != cached_hash {
        eprintln!(
            "[compile-device] artifact cache miss key={cache_key} reason=artifact_hash_mismatch"
        );
        return Ok(false);
    }
    if let Some(parent) = artifact_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating artifact output dir {}", parent.display()))?;
    }
    tokio::fs::write(artifact_path, cached_content)
        .await
        .with_context(|| {
            format!(
                "restoring cached device artifact {} -> {}",
                cached_path.display(),
                artifact_path.display()
            )
        })?;
    Ok(true)
}

#[cfg(feature = "gpu-hmr")]
async fn store_cached_device_artifact(
    workspace_dir: &Path,
    cache_key: &DeviceArtifactCacheKey,
    artifact_path: &Path,
) -> Result<()> {
    let metadata = tokio::fs::metadata(artifact_path)
        .await
        .with_context(|| format!("stat device artifact {}", artifact_path.display()))?;
    if !metadata.is_file() || metadata.len() == 0 {
        anyhow::bail!("compiled device artifact is missing or empty");
    }
    let ext = artifact_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("bin");
    let cache_dir = device_artifact_cache_dir(workspace_dir);
    tokio::fs::create_dir_all(&cache_dir)
        .await
        .with_context(|| format!("creating device artifact cache {}", cache_dir.display()))?;
    let cached_path = cache_dir.join(format!("{}.{ext}", cache_key.cache_key));
    let cached_tmp = cache_dir.join(format!("{}.{ext}.tmp", cache_key.cache_key));
    let artifact_content = tokio::fs::read(artifact_path)
        .await
        .with_context(|| format!("reading device artifact {}", artifact_path.display()))?;
    let artifact_hash = hex_sha256(&artifact_content);
    tokio::fs::write(&cached_tmp, artifact_content)
        .await
        .with_context(|| {
            format!(
                "storing cached device artifact {} -> {}",
                artifact_path.display(),
                cached_tmp.display()
            )
        })?;
    tokio::fs::rename(&cached_tmp, &cached_path)
        .await
        .with_context(|| {
            format!(
                "publishing cached device artifact {} -> {}",
                cached_tmp.display(),
                cached_path.display()
            )
        })?;
    let metadata_path = cache_dir.join(format!("{}.json", cache_key.cache_key));
    let metadata_tmp = cache_dir.join(format!("{}.json.tmp", cache_key.cache_key));
    let metadata = serde_json::json!({
        "schemaVersion": DEVICE_ARTIFACT_CACHE_SCHEMA,
        "keySchemaVersion": DEVICE_ARTIFACT_CACHE_KEY_SCHEMA,
        "cacheKey": cache_key.cache_key,
        "dependencyHash": cache_key.dependency_hash,
        "dependencyMethod": cache_key.dependency_method,
        "compileCommandHash": cache_key.compile_command_hash,
        "artifact": cached_path.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
        "artifactBytes": metadata.len(),
        "artifactSha256": artifact_hash,
    });
    tokio::fs::write(&metadata_tmp, serde_json::to_vec_pretty(&metadata)?)
        .await
        .with_context(|| {
            format!(
                "writing device artifact cache metadata {}",
                metadata_tmp.display()
            )
        })?;
    tokio::fs::rename(&metadata_tmp, &metadata_path)
        .await
        .with_context(|| {
            format!(
                "publishing device artifact cache metadata {} -> {}",
                metadata_tmp.display(),
                metadata_path.display()
            )
        })?;
    eprintln!(
        "[compile-device] artifact cache stored key={} dependency_hash={} dependency_method={} compile_command_hash={} artifact={}",
        cache_key.cache_key,
        cache_key.dependency_hash,
        cache_key.dependency_method,
        cache_key.compile_command_hash,
        cached_path.display()
    );
    Ok(())
}

#[cfg(feature = "gpu-hmr")]
fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    cache_hex(hasher)
}

#[cfg(feature = "gpu-hmr")]
struct DeviceCompileAttempt {
    status: std::process::ExitStatus,
    diagnostics: GpuToolchainDiagnostics,
    stderr: String,
    elapsed_ms: u64,
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
    let timeout_secs = device_compile_timeout_secs(source_filename);

    eprintln!(
        "[compile-device] {} -> {}  timeout_secs={} args={:?}",
        compiler_exe,
        artifact_path.display(),
        timeout_secs,
        cmd.as_std().get_args()
    );

    let started = std::time::Instant::now();
    let child = cmd
        .spawn()
        .with_context(|| format!("spawning {compiler_exe}"))?;
    let out = match timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => anyhow::bail!("Device compile timed out after {timeout_secs}s"),
    };

    let stderr_str = String::from_utf8_lossy(&out.stderr).to_string();
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let diagnostics = match gpu.vendor {
        DeviceVendor::Cuda => parse_ptxas(&stderr_str),
        DeviceVendor::Rocm => GpuToolchainDiagnostics::default(),
    };

    Ok(DeviceCompileAttempt {
        status: out.status,
        diagnostics,
        stderr: stderr_str,
        elapsed_ms,
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
async fn inspect_device_artifact_exported_symbols(
    vendor: DeviceVendor,
    artifact_path: &Path,
) -> Vec<String> {
    let mut candidates = Vec::new();
    if vendor == DeviceVendor::Rocm {
        candidates.push("/opt/rocm/llvm/bin/llvm-readobj".to_string());
    }
    candidates.push("llvm-readobj".to_string());

    for tool in candidates {
        let mut cmd = crate::infra::utils::system_command(&tool);
        cmd.arg("--symbols").arg(artifact_path).kill_on_drop(true);
        let output = match timeout(Duration::from_secs(10), cmd.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(_)) => continue,
            Err(_) => {
                eprintln!(
                    "[compile-device] artifact symbol inspection timed out tool={} artifact={}",
                    tool,
                    artifact_path.display()
                );
                continue;
            }
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut symbols = parse_llvm_readobj_exported_function_symbols(&stdout);
        if symbols.is_empty() {
            symbols = parse_llvm_readobj_exported_function_symbols(&stderr);
        }
        eprintln!(
            "[compile-device] artifact symbol inspection producer={} exported_symbols={} artifact={}",
            tool,
            if symbols.is_empty() {
                "-".to_string()
            } else {
                symbols.join(",")
            },
            artifact_path.display()
        );
        if !symbols.is_empty() {
            return symbols;
        }
    }

    eprintln!(
        "[compile-device] artifact symbol inspection unavailable vendor={} artifact={}",
        vendor.as_str(),
        artifact_path.display()
    );
    Vec::new()
}

#[cfg(feature = "gpu-hmr")]
fn parse_llvm_readobj_exported_function_symbols(raw: &str) -> Vec<String> {
    let mut symbols = BTreeSet::new();
    let mut in_symbol = false;
    let mut name: Option<String> = None;
    let mut is_global = false;
    let mut is_function = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed == "Symbol {" {
            in_symbol = true;
            name = None;
            is_global = false;
            is_function = false;
            continue;
        }
        if !in_symbol {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("Name:") {
            name = readobj_symbol_name(rest);
        } else if let Some(rest) = trimmed.strip_prefix("Binding:") {
            is_global = rest.contains("Global") || rest.contains("Weak");
        } else if let Some(rest) = trimmed.strip_prefix("Type:") {
            is_function = rest.contains("Function");
        } else if trimmed == "}" {
            if is_global && is_function {
                if let Some(symbol) = name.take().filter(|symbol| is_device_export_symbol(symbol)) {
                    symbols.insert(symbol);
                }
            }
            in_symbol = false;
        }
    }

    symbols.into_iter().collect()
}

#[cfg(feature = "gpu-hmr")]
fn readobj_symbol_name(rest: &str) -> Option<String> {
    let trimmed = rest.trim();
    if trimmed.is_empty() || trimmed.starts_with('(') {
        return None;
    }
    let name = trimmed
        .split_once(" (")
        .map(|(name, _)| name)
        .unwrap_or(trimmed)
        .trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

#[cfg(feature = "gpu-hmr")]
fn is_device_export_symbol(symbol: &str) -> bool {
    !symbol.is_empty()
        && symbol != "_DYNAMIC"
        && !symbol.starts_with("__hip_cuid_")
        && !symbol.ends_with(".kd")
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
/// For hipcc single-arch HMR we ask clang's HIP driver for device-only output
/// and disable bundling so the artifact is already a raw code object suitable
/// for `hipModuleLoad`. Multi-arch HIP output still uses the legacy bundled
/// path, then the compile stage extracts the active code object.
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
            if gpu.arch.len() == 1 {
                cmd.arg("--offload-device-only");
                cmd.arg("--no-gpu-bundle-output");
            } else {
                cmd.arg("--genco");
            }
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
    fn device_compile_timeout_keeps_partial_compiles_tight() {
        assert_eq!(
            device_compile_timeout_secs_for(
                ".synthi/generated/gpu/device.partial.abc.hip",
                None,
                None,
                None
            ),
            DEFAULT_DEVICE_PARTIAL_COMPILE_TIMEOUT_SECS
        );
        assert_eq!(
            device_compile_timeout_secs_for(".synthi/generated/gpu/device.hip", None, None, None),
            DEFAULT_DEVICE_FULL_COMPILE_TIMEOUT_SECS
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn device_compile_timeout_honors_scoped_overrides() {
        assert_eq!(
            device_compile_timeout_secs_for("device.partial.abc.hip", None, Some(12), Some(240)),
            12
        );
        assert_eq!(
            device_compile_timeout_secs_for("device.hip", None, Some(12), Some(240)),
            240
        );
        assert_eq!(
            device_compile_timeout_secs_for("device.hip", Some(30), Some(12), Some(240)),
            30
        );
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
        assert!(args.iter().any(|a| a == "--offload-device-only"));
        assert!(args.iter().any(|a| a == "--no-gpu-bundle-output"));
        assert!(args.iter().any(|a| a == "--offload-arch=gfx90a"));
        assert!(args.iter().any(|a| a.ends_with("device_42.hsaco")));
        assert!(args.iter().any(|a| a == "device.hip"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn hipcc_multi_arch_uses_bundled_output() {
        let mut block = rocm_block();
        block.arch.push("gfx1100".to_string());
        let mut cmd = tokio::process::Command::new("hipcc");
        let out = PathBuf::from("/tmp/device_42.hsaco");
        populate_device_command(&mut cmd, &block, "device.hip", &out);
        let args = args_of(&cmd);
        assert!(args.iter().any(|a| a == "--genco"));
        assert!(!args.iter().any(|a| a == "--offload-device-only"));
        assert!(!args.iter().any(|a| a == "--no-gpu-bundle-output"));
        assert!(args.iter().any(|a| a == "--offload-arch=gfx90a"));
        assert!(args.iter().any(|a| a == "--offload-arch=gfx1100"));
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
    #[test]
    fn device_artifact_cache_dir_defaults_to_worker_global_cache() {
        let workspace = PathBuf::from("/workspace/project");
        let cache_dir = device_artifact_cache_dir_from_config(&workspace, None, None);

        assert_eq!(
            cache_dir,
            std::env::temp_dir().join(DEVICE_ARTIFACT_CACHE_GLOBAL_DIR)
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn device_artifact_cache_dir_can_be_overridden() {
        let workspace = PathBuf::from("/workspace/project");
        let cache_dir = device_artifact_cache_dir_from_config(
            &workspace,
            Some("/cache/gpu"),
            Some("workspace"),
        );

        assert_eq!(cache_dir, PathBuf::from("/cache/gpu"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn device_artifact_cache_dir_can_use_workspace_scope() {
        let workspace = PathBuf::from("/workspace/project");
        let cache_dir = device_artifact_cache_dir_from_config(&workspace, None, Some("workspace"));

        assert_eq!(
            cache_dir,
            workspace.join(".synthi/cache/gpu-device-artifacts")
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn depfile_parser_handles_continuations_and_escaped_spaces() {
        let paths = parse_make_depfile_paths(
            "synthi_device_artifact: .synthi/generated/gpu/device.partial.hip \\\nsrc/kernel\\ body.h /opt/rocm/include/hip/hip_runtime.h\n",
        );

        assert_eq!(
            paths,
            vec![
                ".synthi/generated/gpu/device.partial.hip",
                "src/kernel body.h",
                "/opt/rocm/include/hip/hip_runtime.h",
            ]
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn compile_command_tokens_normalize_split_path_flags() {
        let workspace = PathBuf::from("/workspace/project");
        let mut block = rocm_block();
        block.device_flags = vec![
            "-I".to_string(),
            "include".to_string(),
            "-isystem".to_string(),
            "third_party\\sdk".to_string(),
            "--include-directory=generated\\headers".to_string(),
            "-O3".to_string(),
        ];

        let tokens = normalized_device_compile_command_tokens(
            &workspace,
            "hipcc",
            &block,
            ".synthi\\generated\\gpu\\device.partial.test.hip",
        );

        assert!(tokens.iter().any(|token| token == "-I"));
        assert!(tokens
            .iter()
            .any(|token| token == "/workspace/project/include"));
        assert!(tokens
            .iter()
            .any(|token| token == "/workspace/project/third_party/sdk"));
        assert!(tokens.iter().any(|token| {
            token == "--include-directory=/workspace/project/generated/headers"
        }));
        assert!(tokens.iter().any(|token| {
            token == "/workspace/project/.synthi/generated/gpu/device.partial.test.hip"
        }));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn classified_device_flags_normalize_include_paths() {
        let workspace = PathBuf::from("/workspace/project");
        let flags = vec![
            "-I".to_string(),
            "include".to_string(),
            "-DVALUE=1".to_string(),
            "--include-directory=generated\\headers".to_string(),
        ];

        let classified = classified_device_flags(&workspace, &flags);

        assert!(classified
            .iter()
            .any(|item| item == "include_path:-I:/workspace/project/include"));
        assert!(classified.iter().any(|item| {
            item == "include_path:--include-directory=/workspace/project/generated/headers"
        }));
        assert!(classified.iter().any(|item| item == "define:-DVALUE=1"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn path_flag_normalization_preserves_windows_absolute_paths() {
        let workspace = PathBuf::from("/workspace/project");

        assert_eq!(
            normalize_path_flag_value(&workspace, "C:\\GPU SDK\\include"),
            "c:/GPU SDK/include"
        );
        assert_eq!(
            normalize_path_flag_value(&workspace, "\\\\buildshare\\sdk\\include"),
            "//buildshare/sdk/include"
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn readobj_symbol_parser_keeps_only_exported_functions() {
        let raw = r#"
Symbols [
  Symbol {
    Name: helper (1)
    Binding: Local (0x0)
    Type: Function (0x2)
  }
  Symbol {
    Name: shade.private_seg_size (12)
    Binding: Local (0x0)
    Type: None (0x0)
  }
  Symbol {
    Name: shade (32)
    Binding: Global (0x1)
    Type: Function (0x2)
  }
  Symbol {
    Name: shade.kd (45)
    Binding: Global (0x1)
    Type: Object (0x1)
  }
  Symbol {
    Name: __hip_cuid_deadbeef (52)
    Binding: Global (0x1)
    Type: Object (0x1)
  }
]
"#;

        assert_eq!(
            parse_llvm_readobj_exported_function_symbols(raw),
            vec!["shade".to_string()]
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn device_artifact_cache_key_tracks_reachable_include_content() {
        let tmp = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(tmp.path().join("src"))
            .await
            .unwrap();
        tokio::fs::write(tmp.path().join("src/constants.h"), "#define LIMIT 2\n")
            .await
            .unwrap();
        let source = r#"
#include "src/constants.h"
extern "C" __global__ void shade(int* out) { *out = LIMIT; }
"#;
        let first = device_artifact_cache_key(
            tmp.path(),
            "rustc",
            &rocm_block(),
            ".synthi/generated/gpu/device.partial.test.hip",
            source,
        )
        .await
        .unwrap()
        .unwrap();

        tokio::fs::write(tmp.path().join("src/constants.h"), "#define LIMIT 4\n")
            .await
            .unwrap();
        let second = device_artifact_cache_key(
            tmp.path(),
            "rustc",
            &rocm_block(),
            ".synthi/generated/gpu/device.partial.test.hip",
            source,
        )
        .await
        .unwrap()
        .unwrap();

        assert_ne!(first.cache_key, second.cache_key);
        assert_ne!(first.dependency_hash, second.dependency_hash);
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn unchanged_include_wrapper_changed_source_emits_new_cache_entry() {
        let tmp = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(tmp.path().join("src"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(tmp.path().join(".synthi/generated/gpu"))
            .await
            .unwrap();
        let wrapper_path = tmp
            .path()
            .join(".synthi/generated/gpu/device.partial.test.hip");
        let wrapper_source = "#include \"src/kernel_body.h\"\n";
        tokio::fs::write(&wrapper_path, wrapper_source)
            .await
            .unwrap();
        tokio::fs::write(
            tmp.path().join("src/kernel_body.h"),
            "extern \"C\" __global__ void shade(int* out) { *out = 1; }\n",
        )
        .await
        .unwrap();

        let first = device_artifact_cache_key(
            tmp.path(),
            "rustc",
            &rocm_block(),
            ".synthi/generated/gpu/device.partial.test.hip",
            wrapper_source,
        )
        .await
        .unwrap()
        .unwrap();
        let artifact = tmp.path().join("build/device_1.hsaco");
        tokio::fs::create_dir_all(artifact.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&artifact, b"old-hsaco").await.unwrap();
        store_cached_device_artifact(tmp.path(), &first, &artifact)
            .await
            .unwrap();

        tokio::fs::write(
            tmp.path().join("src/kernel_body.h"),
            "extern \"C\" __global__ void shade(int* out) { *out = 2; }\n",
        )
        .await
        .unwrap();
        let second = device_artifact_cache_key(
            tmp.path(),
            "rustc",
            &rocm_block(),
            ".synthi/generated/gpu/device.partial.test.hip",
            wrapper_source,
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(&wrapper_path).await.unwrap(),
            wrapper_source
        );
        assert_ne!(first.dependency_hash, second.dependency_hash);
        assert_ne!(first.cache_key, second.cache_key);
        tokio::fs::remove_file(&artifact).await.unwrap();
        assert!(
            !restore_cached_device_artifact(tmp.path(), &second.cache_key, &artifact)
                .await
                .unwrap()
        );
        assert!(!artifact.exists());

        tokio::fs::write(&artifact, b"new-hsaco").await.unwrap();
        store_cached_device_artifact(tmp.path(), &second, &artifact)
            .await
            .unwrap();
        tokio::fs::remove_file(&artifact).await.unwrap();
        assert!(
            restore_cached_device_artifact(tmp.path(), &second.cache_key, &artifact)
                .await
                .unwrap()
        );
        let restored = tokio::fs::read(&artifact).await.unwrap();
        assert_eq!(restored, b"new-hsaco");
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn device_artifact_cache_key_tracks_compile_flags() {
        let tmp = tempfile::tempdir().unwrap();
        let source = r#"extern "C" __global__ void shade(int* out) { *out = 1; }"#;
        let mut first_block = rocm_block();
        first_block.device_flags = vec!["-O2".to_string()];
        let mut second_block = rocm_block();
        second_block.device_flags = vec!["-O3".to_string()];

        let first = device_artifact_cache_key(
            tmp.path(),
            "rustc",
            &first_block,
            ".synthi/generated/gpu/device.partial.test.hip",
            source,
        )
        .await
        .unwrap()
        .unwrap();
        let second = device_artifact_cache_key(
            tmp.path(),
            "rustc",
            &second_block,
            ".synthi/generated/gpu/device.partial.test.hip",
            source,
        )
        .await
        .unwrap()
        .unwrap();

        assert_ne!(first.cache_key, second.cache_key);
        assert_ne!(first.compile_command_hash, second.compile_command_hash);
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn device_artifact_cache_key_disables_when_compiler_identity_is_unavailable() {
        let tmp = tempfile::tempdir().unwrap();
        let source = r#"extern "C" __global__ void shade(int* out) { *out = 1; }"#;

        let key = device_artifact_cache_key(
            tmp.path(),
            "definitely-not-a-real-device-compiler",
            &rocm_block(),
            ".synthi/generated/gpu/device.partial.test.hip",
            source,
        )
        .await
        .unwrap();

        assert!(key.is_none());
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn device_artifact_cache_round_trips_artifact() {
        let tmp = tempfile::tempdir().unwrap();
        let artifact = tmp.path().join("build/device_1.hsaco");
        tokio::fs::create_dir_all(artifact.parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(&artifact, b"compiled-device")
            .await
            .unwrap();

        let cache_key = DeviceArtifactCacheKey {
            cache_key: "abc123".to_string(),
            dependency_hash: "dep".to_string(),
            dependency_method: "test".to_string(),
            compile_command_hash: "cmd".to_string(),
        };
        store_cached_device_artifact(tmp.path(), &cache_key, &artifact)
            .await
            .unwrap();
        tokio::fs::remove_file(&artifact).await.unwrap();

        assert!(
            restore_cached_device_artifact(tmp.path(), "abc123", &artifact)
                .await
                .unwrap()
        );
        let restored = tokio::fs::read(&artifact).await.unwrap();
        assert_eq!(restored, b"compiled-device");
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn source_owned_cleanup_removes_macro_annotated_device_forward_decl_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let header = tmp
            .path()
            .join("thirdparties/device-lib/include/devlib/device_impl.h");
        tokio::fs::create_dir_all(header.parent().unwrap())
            .await
            .unwrap();
        let header_source =
            "PROJECT_DEVICE bool filterFunc(unsigned int, unsigned int, const ProjectRay&);\n";
        tokio::fs::write(&header, header_source).await.unwrap();
        assert!(source_owned_device_function_names(header_source).contains("filterFunc"));

        let mut block = rocm_block();
        block.device_flags = vec!["-Ithirdparties/device-lib/include".to_string()];
        let source = r#"
#include <devlib/device_impl.h>
extern "C" {
    __device__ bool filterFunc(unsigned int, unsigned int, const ProjectRay&);
}
__device__ int generated_helper();
extern "C" __global__ void SourceBackedKernel(int* out) { *out = 1; }
"#;

        let reachable = reachable_source_owned_device_functions(
            tmp.path(),
            ".synthi/generated/gpu/device.hip",
            source,
            &block.device_flags,
        )
        .await
        .unwrap();
        assert!(reachable.contains("filterFunc"));

        let cleaned = remove_source_owned_device_forward_decls(
            tmp.path(),
            ".synthi/generated/gpu/device.hip",
            source,
            &block,
        )
        .await
        .unwrap();

        assert!(cleaned.contains("#include <devlib/device_impl.h>"));
        assert!(!cleaned.contains("__device__ bool filterFunc"));
        assert!(!cleaned.contains("extern \"C\" {\n}"));
        assert!(cleaned.contains("__device__ int generated_helper();"));
        assert!(cleaned.contains("extern \"C\" __global__ void SourceBackedKernel"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn generated_include_pruning_removes_transitively_reachable_helper_include() {
        let tmp = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(tmp.path().join("src"))
            .await
            .unwrap();
        tokio::fs::write(tmp.path().join("src/common.h"), "#define SCALE 2\n")
            .await
            .unwrap();
        tokio::fs::write(
            tmp.path().join("src/kernel.h"),
            "#include \"common.h\"\nGLOBAL_KERNEL_SIGNATURE(void) Shade(int* out) { *out = SCALE; }\n",
        )
        .await
        .unwrap();

        let source = "#include \"src/common.h\"\n#include \"src/kernel.h\"\n";
        let cleaned = prune_redundant_generated_device_includes(
            tmp.path(),
            ".synthi/generated/gpu/device.hip",
            source,
            &[],
        )
        .await
        .unwrap();

        assert!(!cleaned.contains("#include \"src/common.h\""));
        assert!(cleaned.contains("#include \"src/kernel.h\""));
        assert!(cleaned.contains("pruned redundant generated device include"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn generated_include_pruning_preserves_kernel_entry_includes() {
        let tmp = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(tmp.path().join("src"))
            .await
            .unwrap();
        tokio::fs::write(
            tmp.path().join("src/kernel.h"),
            "GLOBAL_KERNEL_SIGNATURE(void) Shade(int* out) { *out = 1; }\n",
        )
        .await
        .unwrap();
        tokio::fs::write(
            tmp.path().join("src/all_kernels.h"),
            "#include \"kernel.h\"\n",
        )
        .await
        .unwrap();

        let source = "#include \"src/kernel.h\"\n#include \"src/all_kernels.h\"\n";
        let cleaned = prune_redundant_generated_device_includes(
            tmp.path(),
            ".synthi/generated/gpu/device.hip",
            source,
            &[],
        )
        .await
        .unwrap();

        assert!(cleaned.contains("#include \"src/kernel.h\""));
        assert!(cleaned.contains("#include \"src/all_kernels.h\""));
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn generated_include_pruning_removes_duplicate_non_kernel_include() {
        let tmp = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(tmp.path().join("src"))
            .await
            .unwrap();
        tokio::fs::write(tmp.path().join("src/common.h"), "#define SCALE 2\n")
            .await
            .unwrap();

        let source = "#include \"src/common.h\"\n#include \"src/common.h\"\n";
        let cleaned = prune_redundant_generated_device_includes(
            tmp.path(),
            ".synthi/generated/gpu/device.hip",
            source,
            &[],
        )
        .await
        .unwrap();

        assert_eq!(cleaned.matches("#include \"src/common.h\"").count(), 1);
        assert!(cleaned.contains("pruned redundant generated device include"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn generated_include_pruning_canonicalizes_equivalent_include_paths() {
        let tmp = tempfile::tempdir().unwrap();
        tokio::fs::create_dir_all(tmp.path().join("thirdparty/pkg"))
            .await
            .unwrap();
        tokio::fs::write(
            tmp.path().join("thirdparty/pkg/impl.h"),
            "struct Helper {};\n",
        )
        .await
        .unwrap();
        tokio::fs::write(tmp.path().join("bridge.h"), "#include <pkg/impl.h>\n")
            .await
            .unwrap();

        let source = "#include \"bridge.h\"\n#include \"thirdparty/pkg/impl.h\"\n";
        let cleaned = prune_redundant_generated_device_includes(
            tmp.path(),
            ".synthi/generated/gpu/device.hip",
            source,
            &["-Ithirdparty/pkg/..".to_string()],
        )
        .await
        .unwrap();

        assert!(cleaned.contains("#include \"bridge.h\""));
        assert!(!cleaned.contains("#include \"thirdparty/pkg/impl.h\""));
        assert!(cleaned.contains("pruned redundant generated device include"));
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
    fn source_owned_cleanup_preserves_forward_decl_used_before_later_include() {
        let mut owned = HashSet::new();
        owned.insert("source_owned_helper".to_string());
        let source = r#"
__device__ bool source_owned_helper(const Ray&, const void*, void*, const Hit&);
__device__ bool generated_filter(const Ray& ray, const void* data, void* payload, const Hit& hit) {
    return source_owned_helper(ray, data, payload, hit);
}
#include "src/device/source_owned_helper.h"
extern "C" __global__ void apply(float* out) { *out = 1.0f; }
"#;

        let cleaned = remove_forward_decls_for_names(source, &owned);

        assert!(cleaned.contains("__device__ bool source_owned_helper"));
        assert!(cleaned.contains("return source_owned_helper"));
        assert!(cleaned.contains("#include \"src/device/source_owned_helper.h\""));
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
        assert_eq!(target.as_deref(), Some("hipv4-amdgcn-amd-amdhsa--gfx1201"));
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
        assert!(
            out.is_none(),
            "device compile must be a no-op without gpu-hmr feature"
        );
    }
}
