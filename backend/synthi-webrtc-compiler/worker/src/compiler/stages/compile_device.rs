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
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
#[cfg(feature = "gpu-hmr")]
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
#[cfg(all(feature = "gpu-hmr", target_os = "linux"))]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;
#[cfg(feature = "gpu-hmr")]
use std::sync::{OnceLock, Weak};
#[cfg(feature = "gpu-hmr")]
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
#[cfg(feature = "gpu-hmr")]
use tokio::time::{timeout, Duration};

/// Standard filenames for the AI-synthesised device source files.
pub const DEVICE_CU_FILENAME: &str = "device.cu";
pub const DEVICE_HIP_FILENAME: &str = "device.hip";
#[cfg(feature = "gpu-hmr")]
const DEFAULT_DEVICE_FULL_COMPILE_TIMEOUT_SECS: u64 = 180;
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
const DEVICE_COMPILER_CACHE_POLICY: &str =
    "empty_parent_environment_external_cache_state_unobserved";
const DEVICE_COMPILER_CACHE_EVIDENCE_SCOPE: &str =
    "no_declared_cache_controls_not_cache_miss_attestation";
const DEVICE_COMPILER_ENVIRONMENT_SCOPE: &str =
    "empty_parent_environment_with_explicit_content_bound_control_contract";
const DEVICE_COMPILER_IDENTITY_SCOPE: &str =
    "held_compiler_driver_entry_file_bytes_bound_to_linux_parent_procfd_execution_child_toolchain_not_attested";
const DEVICE_COMPILER_IDENTITY_METHOD: &str =
    "held_compiler_driver_entry_file_sha256+version_output";
const DEVICE_COMPILER_EXECUTION_TRANSPORT: &str =
    "linux_parent_procfd_held_compiler_driver_entry_file";
const DEVICE_COMPILE_COMMAND_HASH_SCOPE: &str =
    "explicit_preprocess_and_compile_program_args_cwd_environment_overrides_piped_input_hashes_and_stdout_artifact_transport";
const DEVICE_COMPILER_INPUT_MODE: &str = "compiler_preprocessed_translation_unit_piped_stdin";
const DEVICE_COMPILER_OUTPUT_TRANSPORT: &str =
    "compiler_stdout_parent_materialized_held_reservation";
const DEVICE_COMPILER_SOURCE_EVIDENCE_SCOPE: &str =
    "generated_device_stage_transform_chain_preprocessor_input_and_preprocessed_translation_unit_bound_to_compiler_input_not_original_request_provenance";
const DEVICE_COMPILER_DEPENDENCY_METHOD: &str = "compiler_preprocessed_translation_unit_sha256";

#[cfg(feature = "gpu-hmr")]
type DeviceSourceLockMap = HashMap<String, Weak<tokio::sync::Mutex<()>>>;

#[cfg(feature = "gpu-hmr")]
static DEVICE_SOURCE_COMPILE_LOCKS: OnceLock<tokio::sync::Mutex<DeviceSourceLockMap>> =
    OnceLock::new();

#[cfg(feature = "gpu-hmr")]
async fn acquire_device_source_compile_lock(
    source_path: &Path,
) -> tokio::sync::OwnedMutexGuard<()> {
    let key = normalize_path_key(source_path);
    let lock = {
        let locks =
            DEVICE_SOURCE_COMPILE_LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
        let mut locks = locks.lock().await;
        locks.retain(|_, existing| existing.strong_count() > 0);
        match locks.get(&key).and_then(Weak::upgrade) {
            Some(existing) => existing,
            None => {
                let created = Arc::new(tokio::sync::Mutex::new(()));
                locks.insert(key, Arc::downgrade(&created));
                created
            }
        }
    };
    lock.lock_owned().await
}

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
    /// Structured compile provenance for GPU HMR proof artifacts.
    pub proof_metadata: DeviceCompileProofMetadata,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCompileProofMetadata {
    pub compiler_executable: Option<String>,
    pub compiler_identity: Option<String>,
    pub compiler_resolved_path: Option<String>,
    pub compiler_executable_hash: Option<String>,
    pub compiler_identity_method: Option<String>,
    pub compiler_driver_entry_file_attested: bool,
    pub compiler_process_image_attested: bool,
    pub compiler_execution_transport: String,
    pub device_compiler: Option<String>,
    pub gpu_vendor: Option<String>,
    pub gpu_arch: Vec<String>,
    pub target_triple: Option<String>,
    pub sdk_version: Option<String>,
    pub source_filename: Option<String>,
    pub effective_device_flags: Vec<String>,
    pub compile_command_hash: Option<String>,
    pub dependency_hash: Option<String>,
    pub dependency_method: Option<String>,
    pub artifact_cache_key: Option<String>,
    pub cache_hit: bool,
    pub artifact_cache_bypassed: bool,
    pub compiler_process_executed: bool,
    pub preprocessor_process_executed: bool,
    pub preprocessor_identity_verified_after_execution: bool,
    pub preprocessor_command_hash: Option<String>,
    pub preprocessor_elapsed_ms: Option<u64>,
    pub compiler_output_freshly_created: bool,
    pub compiler_path_identity_verified_after_execution: bool,
    pub compiler_cache_policy: String,
    pub compiler_cache_controls: BTreeMap<String, String>,
    pub compiler_cache_evidence_scope: String,
    pub compiler_environment_scope: String,
    pub compiler_identity_scope: String,
    pub compile_command_hash_scope: String,
    pub compiler_input_mode: String,
    pub compiler_output_transport: String,
    pub compiler_source_evidence_scope: String,
    pub request_source_sha256: Option<String>,
    pub request_source_bytes: Option<usize>,
    pub transformed_source_sha256: Option<String>,
    pub transformed_source_bytes: Option<usize>,
    pub preprocessor_input_sha256: Option<String>,
    pub preprocessor_input_bytes: Option<usize>,
    pub source_transforms: Vec<DeviceSourceTransformEvidence>,
    pub compiled_source_sha256: Option<String>,
    pub compiled_source_bytes: Option<usize>,
    pub source_bytes_verified_after_execution: bool,
    #[serde(skip)]
    pub request_source_snapshot: Option<Arc<[u8]>>,
    #[serde(skip)]
    pub compiler_input_snapshot: Option<Arc<[u8]>>,
    #[cfg(feature = "gpu-hmr")]
    #[serde(skip)]
    pub(crate) compiler_execution_snapshot: Option<Arc<DeviceCompilerExecutableSnapshot>>,
    pub artifact_sha256: Option<String>,
    pub artifact_bytes: Option<usize>,
    #[serde(skip)]
    pub artifact_snapshot: Option<Arc<[u8]>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSourceTransformEvidence {
    pub transform: String,
    pub attempt: usize,
    pub input_sha256: String,
    pub input_bytes: usize,
    pub output_sha256: String,
    pub output_bytes: usize,
}

pub fn enforce_requested_cold_device_compile(
    required: bool,
    outcome: Option<&DeviceCompileOutcome>,
) -> Result<()> {
    if !required {
        return Ok(());
    }

    let Some(outcome) = outcome else {
        anyhow::bail!("cold device compile required but no device compiler outcome was produced");
    };
    let metadata = &outcome.proof_metadata;
    let mut gaps = Vec::new();
    if !metadata.artifact_cache_bypassed {
        gaps.push("synthi_artifact_cache_not_bypassed");
    }
    if metadata.artifact_cache_key.is_some() || metadata.cache_hit {
        gaps.push("synthi_artifact_cache_reuse_observed");
    }
    if !metadata.compiler_process_executed {
        gaps.push("compiler_process_not_executed");
    }
    if !metadata.preprocessor_process_executed {
        gaps.push("compiler_preprocessor_not_executed");
    }
    if !metadata.preprocessor_identity_verified_after_execution {
        gaps.push("compiler_preprocessor_identity_not_verified");
    }
    if !metadata
        .preprocessor_command_hash
        .as_deref()
        .is_some_and(canonical_sha256_value)
    {
        gaps.push("compiler_preprocessor_command_hash_missing");
    }
    if metadata.preprocessor_elapsed_ms.is_none() {
        gaps.push("compiler_preprocessor_timing_missing");
    }
    if !metadata.compiler_output_freshly_created {
        gaps.push("fresh_compiler_output_missing");
    }
    if !metadata.compiler_path_identity_verified_after_execution {
        gaps.push("compiler_path_identity_not_verified_after_execution");
    }
    if metadata.compiler_cache_policy != DEVICE_COMPILER_CACHE_POLICY {
        gaps.push("compiler_cache_policy_mismatch");
    }
    if metadata.compiler_cache_evidence_scope != DEVICE_COMPILER_CACHE_EVIDENCE_SCOPE {
        gaps.push("compiler_cache_evidence_scope_mismatch");
    }
    if metadata.compiler_environment_scope != DEVICE_COMPILER_ENVIRONMENT_SCOPE {
        gaps.push("compiler_environment_scope_mismatch");
    }
    if metadata.compiler_identity_scope != DEVICE_COMPILER_IDENTITY_SCOPE {
        gaps.push("compiler_identity_scope_mismatch");
    }
    if metadata.compile_command_hash_scope != DEVICE_COMPILE_COMMAND_HASH_SCOPE {
        gaps.push("compile_command_hash_scope_mismatch");
    }
    if !metadata
        .compile_command_hash
        .as_deref()
        .is_some_and(canonical_sha256_value)
    {
        gaps.push("compile_command_hash_missing");
    }
    if metadata.compiler_input_mode != DEVICE_COMPILER_INPUT_MODE {
        gaps.push("compiler_input_mode_mismatch");
    }
    if metadata.compiler_output_transport != DEVICE_COMPILER_OUTPUT_TRANSPORT {
        gaps.push("compiler_output_transport_mismatch");
    }
    if metadata.compiler_source_evidence_scope != DEVICE_COMPILER_SOURCE_EVIDENCE_SCOPE {
        gaps.push("compiler_source_evidence_scope_mismatch");
    }
    if !metadata.compiler_cache_controls.is_empty() {
        gaps.push("compiler_cache_controls_mismatch");
    }
    if metadata.compiler_identity_method.as_deref() != Some(DEVICE_COMPILER_IDENTITY_METHOD) {
        gaps.push("compiler_identity_method_mismatch");
    }
    if !metadata.compiler_driver_entry_file_attested {
        gaps.push("compiler_driver_entry_file_not_attested");
    }
    if metadata.compiler_process_image_attested {
        gaps.push("compiler_process_tree_attestation_overclaimed");
    }
    if metadata.compiler_execution_transport != DEVICE_COMPILER_EXECUTION_TRANSPORT {
        gaps.push("compiler_execution_transport_mismatch");
    }
    if !metadata
        .compiler_resolved_path
        .as_deref()
        .is_some_and(|path| {
            Path::new(path).is_absolute() && !path.chars().any(|ch| matches!(ch, '\r' | '\n'))
        })
    {
        gaps.push("compiler_invocation_path_missing");
    }
    for (name, value) in [
        ("compiler_identity", metadata.compiler_identity.as_deref()),
        (
            "compiler_executable_hash",
            metadata.compiler_executable_hash.as_deref(),
        ),
    ] {
        let digest = value
            .and_then(|value| value.strip_prefix("sha256:").or(Some(value)))
            .unwrap_or_default();
        if digest.len() != 64 || !digest.chars().all(|ch| ch.is_ascii_hexdigit()) {
            gaps.push(name);
        }
    }
    let transformed_source_hash =
        format!("sha256:{}", hex_sha256(outcome.compiled_source.as_bytes()));
    if metadata.transformed_source_sha256.as_deref() != Some(transformed_source_hash.as_str())
        || metadata.transformed_source_bytes != Some(outcome.compiled_source.len())
    {
        gaps.push("transformed_source_binding_mismatch");
    }
    match metadata.request_source_snapshot.as_deref() {
        Some(bytes) if !bytes.is_empty() => {
            let request_source_hash = format!("sha256:{}", hex_sha256(bytes));
            if metadata.request_source_sha256.as_deref() != Some(request_source_hash.as_str())
                || metadata.request_source_bytes != Some(bytes.len())
            {
                gaps.push("request_source_binding_mismatch");
            }
            let mut previous_hash = request_source_hash;
            let mut previous_bytes = bytes.len();
            for transform in &metadata.source_transforms {
                if transform.transform.trim().is_empty()
                    || transform.input_sha256 != previous_hash
                    || transform.input_bytes != previous_bytes
                    || !canonical_sha256_value(&transform.output_sha256)
                {
                    gaps.push("source_transform_chain_mismatch");
                    break;
                }
                previous_hash = transform.output_sha256.clone();
                previous_bytes = transform.output_bytes;
            }
            if previous_hash != transformed_source_hash
                || previous_bytes != outcome.compiled_source.len()
            {
                gaps.push("source_transform_final_binding_mismatch");
            }
        }
        _ => gaps.push("request_source_snapshot_missing"),
    }
    let preprocessor_input = cold_device_compiler_input(
        metadata.source_filename.as_deref().unwrap_or_default(),
        &outcome.compiled_source,
    )?;
    let preprocessor_input_hash = format!("sha256:{}", hex_sha256(&preprocessor_input));
    if metadata.preprocessor_input_sha256.as_deref() != Some(preprocessor_input_hash.as_str())
        || metadata.preprocessor_input_bytes != Some(preprocessor_input.len())
    {
        gaps.push("preprocessor_input_binding_mismatch");
    }
    match metadata.compiler_input_snapshot.as_deref() {
        Some(bytes) if !bytes.is_empty() => {
            let input_hash = format!("sha256:{}", hex_sha256(bytes));
            if metadata.compiled_source_sha256.as_deref() != Some(input_hash.as_str())
                || metadata.compiled_source_bytes != Some(bytes.len())
                || metadata.dependency_hash.as_deref() != Some(input_hash.as_str())
                || metadata.dependency_method.as_deref() != Some(DEVICE_COMPILER_DEPENDENCY_METHOD)
                || !metadata.source_bytes_verified_after_execution
            {
                gaps.push("compiler_input_binding_mismatch");
            }
        }
        _ => gaps.push("compiler_input_snapshot_missing"),
    }
    match metadata.artifact_snapshot.as_deref() {
        Some(bytes) if !bytes.is_empty() => {
            let artifact_hash = format!("{:x}", Sha256::digest(bytes));
            if metadata.artifact_sha256.as_deref()
                != Some(format!("sha256:{artifact_hash}").as_str())
                || metadata.artifact_bytes != Some(bytes.len())
            {
                gaps.push("artifact_snapshot_binding_mismatch");
            }
            match (
                std::fs::symlink_metadata(&outcome.artifact_path),
                std::fs::read(&outcome.artifact_path),
            ) {
                (Ok(path_metadata), Ok(path_bytes))
                    if path_metadata.file_type().is_file()
                        && !path_metadata.file_type().is_symlink()
                        && path_bytes.as_slice() == bytes => {}
                _ => gaps.push("artifact_path_snapshot_mismatch"),
            }
        }
        _ => gaps.push("fresh_artifact_snapshot_missing"),
    }

    if gaps.is_empty() {
        Ok(())
    } else {
        anyhow::bail!("cold device compile proof incomplete: {}", gaps.join(","))
    }
}

fn cold_device_compiler_input(source_filename: &str, source: &str) -> Result<Vec<u8>> {
    let normalized = source_filename.replace('\\', "/");
    if normalized.trim().is_empty()
        || normalized
            .chars()
            .any(|ch| matches!(ch, '\r' | '\n' | '\0'))
    {
        anyhow::bail!("cold device compiler source filename is invalid");
    }
    let escaped = normalized.replace('\\', "\\\\").replace('"', "\\\"");
    let mut input = format!("#line 1 \"{escaped}\"\n").into_bytes();
    input.extend_from_slice(source.as_bytes());
    Ok(input)
}

fn device_source_transform_evidence(
    transform: &str,
    attempt: usize,
    input: &[u8],
    output: &[u8],
) -> DeviceSourceTransformEvidence {
    DeviceSourceTransformEvidence {
        transform: transform.to_string(),
        attempt,
        input_sha256: format!("sha256:{}", hex_sha256(input)),
        input_bytes: input.len(),
        output_sha256: format!("sha256:{}", hex_sha256(output)),
        output_bytes: output.len(),
    }
}

fn canonical_sha256_value(value: &str) -> bool {
    let digest = value.strip_prefix("sha256:").unwrap_or(value);
    digest.len() == 64
        && digest
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
}

/// Phase-0 entry point. Returns `Ok(None)` when:
///
///   - the `gpu-hmr` feature is disabled at build time, or
///   - `device_source` is empty, or
///   - no explicit generated device source filename is supplied, or
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
    compile_device_phase0_with_cache_policy(
        workspace_dir,
        output_dir,
        timestamp,
        device_source,
        source_filename_override,
        manifest,
        false,
    )
    .await
}

/// Compile a device source with an explicit Synthi-cache policy. When
/// `bypass_artifact_cache` is true, the request cannot be satisfied from
/// Synthi's device artifact cache and the compiler receives an empty parent
/// environment. External compiler cache state remains explicitly unobserved.
pub async fn compile_device_phase0_with_cache_policy(
    workspace_dir: &std::path::Path,
    output_dir: &std::path::Path,
    timestamp: i64,
    device_source: &str,
    source_filename_override: Option<&str>,
    manifest: &CompileManifest,
    bypass_artifact_cache: bool,
) -> Result<Option<DeviceCompileOutcome>> {
    if device_source.trim().is_empty() {
        eprintln!("[compile-device] skipping — empty device source");
        return Ok(None);
    }
    let Some(gpu) = manifest.gpu.as_ref() else {
        eprintln!("[compile-device] manifest has no gpu block — falling through");
        return Ok(None);
    };
    if source_filename_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        eprintln!(
            "[compile-device] skipping - explicit generated device source filename is required"
        );
        return Ok(None);
    }

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
            bypass_artifact_cache,
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
    bypass_artifact_cache: bool,
) -> Result<Option<DeviceCompileOutcome>> {
    if bypass_artifact_cache && !cfg!(target_os = "linux") {
        anyhow::bail!(
            "content-bound device compiler entry-file execution currently requires a Linux worker; host Windows/WSL orchestration must run the compiler inside the Linux worker"
        );
    }
    // Pick filename + executable from the manifest. `select_compiler`
    // owns the dispatch; we resolve to the canonical name here so the
    // log lines name the actual binary the worker spawned.
    let compiler_exe = manifest.select_compiler(crate::hmr::compile_manifest::ModuleKind::Device);
    let artifact_ext = match gpu.vendor {
        DeviceVendor::Cuda => "cubin",
        DeviceVendor::Rocm => "hsaco",
    };
    let Some(source_filename) = source_filename_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        eprintln!(
            "[compile-device] skipping - explicit generated device source filename is required"
        );
        return Ok(None);
    };

    let source_path = workspace_dir.join(source_filename);
    if let Some(parent) = source_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .context("creating device source parent dir")?;
    }
    tokio::fs::create_dir_all(output_dir)
        .await
        .context("creating device output dir")?;
    let _source_compile_guard = acquire_device_source_compile_lock(&source_path).await;

    let heal_allowed =
        !bypass_artifact_cache && manifest_declares_device_role(manifest, source_filename);
    let max_heal_attempts = if heal_allowed { 2 } else { 0 };
    if !heal_allowed {
        eprintln!(
            "[compile-device] AI heal disabled - source is not a manifest-declared device role: {}",
            source_filename
        );
    }

    let requested_source_snapshot = Arc::<[u8]>::from(device_source.as_bytes());
    let mut source_transforms = Vec::new();
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
                    source_transforms.push(device_source_transform_evidence(
                        "prune_redundant_generated_device_includes",
                        attempt,
                        current_source.as_bytes(),
                        sanitized.as_bytes(),
                    ));
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
                    source_transforms.push(device_source_transform_evidence(
                        "remove_source_owned_device_forward_declarations",
                        attempt,
                        current_source.as_bytes(),
                        sanitized.as_bytes(),
                    ));
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

        let cache_key = if bypass_artifact_cache {
            None
        } else {
            device_artifact_cache_key(
                workspace_dir,
                compiler_exe,
                gpu,
                source_filename,
                &current_source,
            )
            .await?
        };
        let mut proof_metadata = device_compile_proof_metadata(
            workspace_dir,
            compiler_exe,
            gpu,
            source_filename,
            requested_source_snapshot.clone(),
            &current_source,
            source_transforms.clone(),
            cache_key.as_ref(),
            false,
            bypass_artifact_cache,
            false,
        )
        .await?;
        let artifact_reservation =
            reserve_device_artifact_path(output_dir, timestamp, artifact_ext).await?;
        let artifact_path = artifact_reservation.path.clone();
        if let Some(cache_key) = cache_key.as_ref() {
            if restore_cached_device_artifact(workspace_dir, &cache_key.cache_key, &artifact_path)
                .await?
            {
                let mut proof_metadata = proof_metadata.clone();
                bind_device_artifact_snapshot(&mut proof_metadata, &artifact_path).await?;
                let artifact_exported_symbols =
                    inspect_device_artifact_exported_symbols(gpu.vendor, &artifact_path).await;
                proof_metadata.cache_hit = true;
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
                    proof_metadata,
                }));
            }
        }

        let compiler_invocation_exe = if bypass_artifact_cache {
            proof_metadata
                .compiler_execution_snapshot
                .as_ref()
                .map(|snapshot| snapshot.execution_path.clone())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "cold device compiler process image cannot be bound to an open executable"
                    )
                })?
        } else {
            compiler_exe.to_string()
        };
        let piped_compiler_input = if bypass_artifact_cache {
            let request_source = cold_device_compiler_input(source_filename, &current_source)?;
            let preprocessed = run_cold_device_preprocessor(
                &compiler_invocation_exe,
                workspace_dir,
                gpu,
                source_filename,
                &request_source,
                proof_metadata
                    .compiler_execution_snapshot
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("cold device compiler snapshot missing"))?,
                &format!("sha256:{}", hex_sha256(current_source.as_bytes())),
                current_source.len(),
            )
            .await?;
            let preprocessed_hash = format!("sha256:{}", hex_sha256(preprocessed.bytes.as_ref()));
            let normalized_command = normalized_device_compile_command_tokens(
                workspace_dir,
                &compiler_invocation_exe,
                gpu,
                source_filename,
                true,
                Some(&preprocessed_hash),
            );
            proof_metadata.preprocessor_process_executed = true;
            proof_metadata.preprocessor_identity_verified_after_execution = true;
            proof_metadata.preprocessor_command_hash = Some(preprocessed.command_hash);
            proof_metadata.preprocessor_elapsed_ms = Some(preprocessed.elapsed_ms);
            proof_metadata.compile_command_hash =
                Some(hash_string_sequence("compile_command", &normalized_command));
            proof_metadata.dependency_hash = Some(preprocessed_hash.clone());
            proof_metadata.dependency_method = Some(DEVICE_COMPILER_DEPENDENCY_METHOD.to_string());
            proof_metadata.compiled_source_sha256 = Some(preprocessed_hash);
            proof_metadata.compiled_source_bytes = Some(preprocessed.bytes.len());
            proof_metadata.compiler_input_snapshot = Some(preprocessed.bytes.clone());
            Some(preprocessed.bytes)
        } else {
            None
        };
        let compile = run_device_compile_once(
            &compiler_invocation_exe,
            workspace_dir,
            gpu,
            source_filename,
            &artifact_reservation,
            bypass_artifact_cache,
            bypass_artifact_cache
                .then_some(proof_metadata.compiler_execution_snapshot.as_deref())
                .flatten(),
            proof_metadata
                .compiled_source_sha256
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("device compiler source hash missing"))?,
            proof_metadata
                .compiled_source_bytes
                .ok_or_else(|| anyhow::anyhow!("device compiler source byte length missing"))?,
            piped_compiler_input.as_deref(),
            &format!("sha256:{}", hex_sha256(current_source.as_bytes())),
            current_source.len(),
        )
        .await?;

        if compile.status.success() {
            if bypass_artifact_cache {
                let artifact_bytes =
                    read_device_artifact_reservation(&artifact_reservation).await?;
                if !has_elf_magic_bytes(&artifact_bytes) {
                    anyhow::bail!(
                        "cold device compiler stdout did not contain an ELF device code object"
                    );
                }
            }
            if gpu.vendor == DeviceVendor::Rocm {
                if bypass_artifact_cache
                    && has_clang_offload_bundle_header_bytes(
                        &read_device_artifact_reservation(&artifact_reservation).await?,
                    )
                {
                    anyhow::bail!(
                        "cold device compile produced a bundled ROCm artifact; strict proof requires direct compiler output without an unattested post-compiler transformer"
                    );
                }
                if !bypass_artifact_cache {
                    normalize_rocm_artifact_if_bundled(&artifact_path).await?;
                }
            }
            finalize_device_compile_proof_metadata(
                &mut proof_metadata,
                &compile,
                bypass_artifact_cache,
            )
            .await?;
            if bypass_artifact_cache {
                bind_device_artifact_reservation_snapshot(
                    &mut proof_metadata,
                    &artifact_reservation,
                )
                .await?;
            } else {
                bind_device_artifact_snapshot(&mut proof_metadata, &artifact_path).await?;
            }

            eprintln!(
                "[compile-device] {} ok  artifact={}  compiler_ms={} diagnostics_kernels={}",
                compiler_exe,
                artifact_path.display(),
                compile.elapsed_ms,
                compile.diagnostics.register_pressure.len()
            );
            let artifact_exported_symbols = if bypass_artifact_cache {
                Vec::new()
            } else {
                inspect_device_artifact_exported_symbols(gpu.vendor, &artifact_path).await
            };
            verify_device_artifact_snapshot(&proof_metadata, &artifact_path).await?;

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
                proof_metadata,
            }));
        }

        eprintln!(
            "[compile-device] {} FAILED status={} compiler_ms={}\n{}",
            compiler_exe, compile.status, compile.elapsed_ms, compile.stderr
        );
        if let Err(error) = tokio::fs::remove_file(&artifact_path).await {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[compile-device] failed artifact cleanup skipped path={} error={error}",
                    artifact_path.display()
                );
            }
        }

        if attempt >= max_heal_attempts {
            anyhow::bail!(
                "device compile failed (exit {}): {}",
                compile.status,
                compile.stderr.trim()
            );
        }

        let (shared_for_heal, heal_arch_md) =
            read_device_heal_context(workspace_dir, manifest, source_filename).await;
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
        source_transforms.push(device_source_transform_evidence(
            "ai_heal_after_compiler_failure",
            attempt,
            current_source.as_bytes(),
            fixed.as_bytes(),
        ));
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
fn positive_timeout_secs(value: Option<String>) -> Option<u64> {
    value
        .and_then(|raw| raw.parse::<u64>().ok())
        .filter(|secs| *secs > 0)
}

#[cfg(feature = "gpu-hmr")]
fn device_compile_timeout_secs_for(
    global_override: Option<u64>,
    full_override: Option<u64>,
) -> u64 {
    if let Some(secs) = global_override {
        return secs;
    }
    full_override.unwrap_or(DEFAULT_DEVICE_FULL_COMPILE_TIMEOUT_SECS)
}

#[cfg(feature = "gpu-hmr")]
fn device_compile_timeout_secs() -> u64 {
    device_compile_timeout_secs_for(
        positive_timeout_secs(std::env::var("SYNTHI_GPU_HMR_DEVICE_COMPILE_TIMEOUT_SECS").ok()),
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
#[derive(Debug, Clone)]
struct DeviceArtifactCacheKey {
    cache_key: String,
    dependency_hash: String,
    dependency_method: String,
    compile_command_hash: String,
    compiler_identity: DeviceCompilerIdentityEvidence,
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

    let normalized_command = normalized_device_compile_command_tokens(
        workspace_dir,
        compiler_exe,
        gpu,
        source_filename,
        false,
        None,
    );
    let compile_command_hash = hash_string_sequence("compile_command", &normalized_command);

    let Some(dependency_digest) = device_dependency_cache_hash(
        workspace_dir,
        compiler_exe,
        gpu,
        source_filename,
        source,
        false,
    )
    .await?
    else {
        return Ok(None);
    };

    let mut hasher = Sha256::new();
    cache_update_str(
        &mut hasher,
        "cache_key_schema",
        DEVICE_ARTIFACT_CACHE_KEY_SCHEMA,
    );
    cache_update_str(&mut hasher, "artifact_schema", DEVICE_ARTIFACT_CACHE_SCHEMA);
    cache_update_str(&mut hasher, "artifact_kind", "device_sidecar");
    cache_update_str(&mut hasher, "compiler_exe", compiler_exe);
    let Some(compiler_identity) =
        device_compiler_identity_evidence(workspace_dir, compiler_exe).await?
    else {
        return Ok(None);
    };
    cache_update_str(
        &mut hasher,
        "compiler_identity",
        &compiler_identity.identity_hash,
    );
    cache_update_str(
        &mut hasher,
        "sdk_version",
        &gpu_sdk_version_fingerprint(gpu),
    );
    cache_update_str(&mut hasher, "vendor", gpu.vendor.as_str());
    cache_update_str(
        &mut hasher,
        "device_compiler",
        gpu.device_compiler.executable(),
    );
    for arch in &gpu.arch {
        cache_update_str(&mut hasher, "arch", arch);
    }
    cache_update_str(
        &mut hasher,
        "target_triple",
        &target_triple_fingerprint(gpu),
    );
    for (name, value) in device_compiler_env_fingerprint() {
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
        compiler_identity,
    }))
}

#[cfg(feature = "gpu-hmr")]
async fn device_compile_proof_metadata(
    workspace_dir: &Path,
    compiler_exe: &str,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
    requested_source_snapshot: Arc<[u8]>,
    source: &str,
    source_transforms: Vec<DeviceSourceTransformEvidence>,
    cache_key: Option<&DeviceArtifactCacheKey>,
    cache_hit: bool,
    artifact_cache_bypassed: bool,
    compiler_process_executed: bool,
) -> Result<DeviceCompileProofMetadata> {
    let compiler_identity = match cache_key {
        Some(cache_key) => Some(cache_key.compiler_identity.clone()),
        None => device_compiler_identity_evidence(workspace_dir, compiler_exe).await?,
    };
    if artifact_cache_bypassed && compiler_identity.is_none() {
        anyhow::bail!(
            "cold device compile requires a resolved, byte-hashed compiler executable: {compiler_exe}"
        );
    }
    let compiler_invocation_exe = if artifact_cache_bypassed {
        compiler_identity
            .as_ref()
            .map(|identity| identity.resolved_path.as_str())
            .ok_or_else(|| anyhow::anyhow!("cold device compiler invocation path missing"))?
    } else {
        compiler_exe
    };
    let preprocessor_input = if artifact_cache_bypassed {
        cold_device_compiler_input(source_filename, source)?
    } else {
        source.as_bytes().to_vec()
    };
    let request_source_sha256 =
        format!("sha256:{}", hex_sha256(requested_source_snapshot.as_ref()));
    let transformed_source_sha256 = format!("sha256:{}", hex_sha256(source.as_bytes()));
    let preprocessor_input_sha256 = format!("sha256:{}", hex_sha256(&preprocessor_input));
    let normalized_command = normalized_device_compile_command_tokens(
        workspace_dir,
        compiler_invocation_exe,
        gpu,
        source_filename,
        artifact_cache_bypassed,
        artifact_cache_bypassed.then_some(preprocessor_input_sha256.as_str()),
    );
    let dependency_digest = if artifact_cache_bypassed {
        None
    } else {
        match cache_key {
            Some(cache_key) => Some(DeviceDependencyDigest {
                hash: cache_key.dependency_hash.clone(),
                method: cache_key.dependency_method.clone(),
            }),
            None => {
                device_dependency_cache_hash(
                    workspace_dir,
                    compiler_invocation_exe,
                    gpu,
                    source_filename,
                    source,
                    artifact_cache_bypassed,
                )
                .await?
            }
        }
    };
    let compiler_cache_controls = if artifact_cache_bypassed {
        device_compiler_cache_controls()
    } else {
        BTreeMap::new()
    };
    let compiler_execution_snapshot = artifact_cache_bypassed
        .then(|| {
            compiler_identity
                .as_ref()
                .and_then(|identity| identity.execution_snapshot.clone())
        })
        .flatten();
    let compiler_execution_available = compiler_execution_snapshot.is_some();

    Ok(DeviceCompileProofMetadata {
        compiler_executable: Some(compiler_exe.to_string()),
        compiler_identity: compiler_identity
            .as_ref()
            .map(|identity| identity.identity_hash.clone()),
        compiler_resolved_path: compiler_identity
            .as_ref()
            .map(|identity| identity.resolved_path.clone()),
        compiler_executable_hash: compiler_identity
            .as_ref()
            .map(|identity| identity.executable_hash.clone()),
        compiler_identity_method: compiler_identity
            .as_ref()
            .map(|identity| identity.identity_method.clone()),
        compiler_driver_entry_file_attested: false,
        compiler_process_image_attested: false,
        compiler_execution_transport: if compiler_execution_available {
            DEVICE_COMPILER_EXECUTION_TRANSPORT.to_string()
        } else if artifact_cache_bypassed {
            "unavailable".to_string()
        } else {
            "not_requested".to_string()
        },
        device_compiler: Some(gpu.device_compiler.executable().to_string()),
        gpu_vendor: Some(gpu.vendor.as_str().to_string()),
        gpu_arch: gpu.arch.clone(),
        target_triple: Some(target_triple_fingerprint(gpu)),
        sdk_version: Some(gpu_sdk_version_fingerprint(gpu)),
        source_filename: Some(source_filename.replace('\\', "/")),
        effective_device_flags: gpu.device_flags.clone(),
        compile_command_hash: if artifact_cache_bypassed {
            None
        } else {
            Some(
                cache_key
                    .map(|cache_key| cache_key.compile_command_hash.clone())
                    .unwrap_or_else(|| {
                        hash_string_sequence("compile_command", &normalized_command)
                    }),
            )
        },
        dependency_hash: dependency_digest.as_ref().map(|digest| digest.hash.clone()),
        dependency_method: dependency_digest
            .as_ref()
            .map(|digest| digest.method.clone()),
        artifact_cache_key: cache_key.map(|cache_key| cache_key.cache_key.clone()),
        cache_hit,
        artifact_cache_bypassed,
        compiler_process_executed,
        preprocessor_process_executed: false,
        preprocessor_identity_verified_after_execution: false,
        preprocessor_command_hash: None,
        preprocessor_elapsed_ms: None,
        compiler_output_freshly_created: false,
        compiler_path_identity_verified_after_execution: false,
        compiler_cache_policy: if artifact_cache_bypassed {
            DEVICE_COMPILER_CACHE_POLICY.to_string()
        } else {
            "not_requested".to_string()
        },
        compiler_cache_controls,
        compiler_cache_evidence_scope: if artifact_cache_bypassed {
            DEVICE_COMPILER_CACHE_EVIDENCE_SCOPE.to_string()
        } else {
            "not_requested".to_string()
        },
        compiler_environment_scope: DEVICE_COMPILER_ENVIRONMENT_SCOPE.to_string(),
        compiler_identity_scope: if compiler_execution_available {
            DEVICE_COMPILER_IDENTITY_SCOPE.to_string()
        } else if artifact_cache_bypassed {
            "unavailable".to_string()
        } else {
            "compiler_identity_for_cache_key_only".to_string()
        },
        compile_command_hash_scope: DEVICE_COMPILE_COMMAND_HASH_SCOPE.to_string(),
        compiler_input_mode: if artifact_cache_bypassed {
            DEVICE_COMPILER_INPUT_MODE.to_string()
        } else {
            "workspace_path".to_string()
        },
        compiler_output_transport: if artifact_cache_bypassed {
            DEVICE_COMPILER_OUTPUT_TRANSPORT.to_string()
        } else {
            "compiler_path_output".to_string()
        },
        compiler_source_evidence_scope: if artifact_cache_bypassed {
            DEVICE_COMPILER_SOURCE_EVIDENCE_SCOPE.to_string()
        } else {
            "workspace_path_before_after".to_string()
        },
        request_source_sha256: artifact_cache_bypassed.then_some(request_source_sha256),
        request_source_bytes: artifact_cache_bypassed.then_some(requested_source_snapshot.len()),
        transformed_source_sha256: artifact_cache_bypassed.then_some(transformed_source_sha256),
        transformed_source_bytes: artifact_cache_bypassed.then_some(source.len()),
        preprocessor_input_sha256: artifact_cache_bypassed.then_some(preprocessor_input_sha256),
        preprocessor_input_bytes: artifact_cache_bypassed.then_some(preprocessor_input.len()),
        source_transforms,
        compiled_source_sha256: (!artifact_cache_bypassed)
            .then(|| format!("sha256:{}", hex_sha256(&preprocessor_input))),
        compiled_source_bytes: (!artifact_cache_bypassed).then_some(preprocessor_input.len()),
        source_bytes_verified_after_execution: false,
        request_source_snapshot: artifact_cache_bypassed.then_some(requested_source_snapshot),
        compiler_input_snapshot: None,
        compiler_execution_snapshot,
        artifact_sha256: None,
        artifact_bytes: None,
        artifact_snapshot: None,
    })
}

#[cfg(feature = "gpu-hmr")]
fn device_compiler_cache_controls() -> BTreeMap<String, String> {
    BTreeMap::new()
}

#[cfg(feature = "gpu-hmr")]
fn device_compiler_command(
    compiler_exe: &str,
    isolate_parent_environment: bool,
) -> tokio::process::Command {
    device_compiler_command_for_platform(
        compiler_exe,
        isolate_parent_environment,
        cfg!(target_os = "windows"),
    )
}

#[cfg(feature = "gpu-hmr")]
fn device_compiler_command_for_platform(
    compiler_exe: &str,
    isolate_parent_environment: bool,
    windows_wsl: bool,
) -> tokio::process::Command {
    let mut cmd = if windows_wsl {
        let mut cmd = tokio::process::Command::new("wsl");
        if isolate_parent_environment {
            cmd.arg("env").arg("-i");
        }
        cmd.arg(compiler_exe);
        cmd
    } else {
        tokio::process::Command::new(compiler_exe)
    };
    if isolate_parent_environment {
        cmd.env_clear();
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd
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
    isolate_parent_environment: bool,
    piped_input_sha256: Option<&str>,
) -> Vec<String> {
    let mut cmd = device_compiler_command(compiler_exe, isolate_parent_environment);
    if isolate_parent_environment {
        populate_device_command_with_piped_source(&mut cmd, gpu, source_filename, Path::new("-"));
    } else {
        let artifact_placeholder = PathBuf::from("__synthi_device_artifact__");
        populate_device_command(&mut cmd, gpu, source_filename, &artifact_placeholder);
    }
    normalized_device_process_command_tokens(
        workspace_dir,
        source_filename,
        &cmd,
        isolate_parent_environment,
        piped_input_sha256,
    )
}

#[cfg(feature = "gpu-hmr")]
fn normalized_device_process_command_tokens(
    workspace_dir: &Path,
    source_filename: &str,
    cmd: &tokio::process::Command,
    isolate_parent_environment: bool,
    piped_input_sha256: Option<&str>,
) -> Vec<String> {
    let program = cmd.as_std().get_program().to_string_lossy().into_owned();
    let mut tokens = vec![
        format!("cwd={}", normalize_path_key(workspace_dir)),
        format!(
            "parent-environment={}",
            if isolate_parent_environment {
                "empty"
            } else {
                "inherited"
            }
        ),
    ];
    let mut environment = cmd
        .as_std()
        .get_envs()
        .map(|(name, value)| {
            let name = name.to_string_lossy();
            match value {
                Some(value) => format!("env:{name}={}", value.to_string_lossy()),
                None => format!("env-unset:{name}"),
            }
        })
        .collect::<Vec<_>>();
    environment.sort();
    tokens.extend(environment);
    tokens.extend(normalize_compile_command_tokens(
        workspace_dir,
        &program,
        source_filename,
        cmd.as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned()),
    ));
    if let Some(input_hash) = piped_input_sha256 {
        tokens.push(format!("stdin-content={input_hash}"));
    }
    tokens
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
    (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/')
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
        "-I" | "-isystem"
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
    for prefix in ["--include-directory=", "--system-include=", "--sysroot="] {
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
fn device_compiler_env_fingerprint() -> Vec<(String, String)> {
    let mut out = std::env::vars_os()
        .map(|(name, value)| {
            (
                os_string_content_hash(name.as_os_str()),
                os_string_content_hash(value.as_os_str()),
            )
        })
        .collect::<Vec<_>>();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[cfg(feature = "gpu-hmr")]
fn os_string_content_hash(value: &std::ffi::OsStr) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        format!("sha256:{}", hex_sha256(value.as_bytes()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let bytes = value
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        format!("sha256:{}", hex_sha256(&bytes))
    }
    #[cfg(not(any(unix, windows)))]
    {
        format!("sha256:{}", hex_sha256(value.to_string_lossy().as_bytes()))
    }
}

#[cfg(feature = "gpu-hmr")]
fn gpu_sdk_version_fingerprint(gpu: &crate::hmr::compile_manifest::GpuBuildBlock) -> String {
    match gpu.vendor {
        DeviceVendor::Rocm => {
            match std::env::var("ROCM_PATH").or_else(|_| std::env::var("ROCM_HOME")) {
                Ok(root) => {
                    let version_file = PathBuf::from(root).join(".info/version");
                    std::fs::read_to_string(&version_file)
                        .map(|raw| format!("rocm:{}", raw.trim()))
                        .unwrap_or_else(|_| "rocm:unavailable".to_string())
                }
                Err(_) => "rocm:unavailable:sdk_root_unproven".to_string(),
            }
        }
        DeviceVendor::Cuda => {
            match std::env::var("CUDA_HOME").or_else(|_| std::env::var("CUDA_PATH")) {
                Ok(root) => {
                    let version_file = PathBuf::from(root).join("version.txt");
                    std::fs::read_to_string(&version_file)
                        .map(|raw| format!("cuda:{}", raw.trim()))
                        .unwrap_or_else(|_| "cuda:unavailable".to_string())
                }
                Err(_) => "cuda:unavailable:sdk_root_unproven".to_string(),
            }
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
    isolate_parent_environment: bool,
) -> Result<Option<DeviceDependencyDigest>> {
    if let Some(depfile_hash) = compiler_depfile_dependency_cache_hash(
        workspace_dir,
        compiler_exe,
        gpu,
        source_filename,
        isolate_parent_environment,
    )
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
    isolate_parent_environment: bool,
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

    let mut cmd = device_compiler_command(compiler_exe, isolate_parent_environment);
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

    let out = match timeout(
        Duration::from_secs(DEVICE_DEPFILE_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    {
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
            "-I" | "-isystem"
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
#[derive(Debug, Clone)]
struct DeviceCompilerIdentityEvidence {
    identity_hash: String,
    resolved_path: String,
    executable_hash: String,
    identity_method: String,
    execution_snapshot: Option<Arc<DeviceCompilerExecutableSnapshot>>,
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug)]
pub(crate) struct DeviceCompilerExecutableSnapshot {
    handle: tokio::fs::File,
    execution_path: String,
    executable_hash: String,
    executable_bytes: usize,
}

#[cfg(feature = "gpu-hmr")]
fn device_compiler_path_resolution_command(
    workspace_dir: &Path,
    compiler_exe: &str,
) -> tokio::process::Command {
    let mut resolve_cmd = crate::infra::utils::system_command("sh");
    resolve_cmd
        .current_dir(workspace_dir)
        .arg("-lc")
        .arg("resolved=$(command -v -- \"$1\") || exit 1; case \"$resolved\" in /*) printf '%s\\n' \"$resolved\" ;; *) exit 2 ;; esac")
        .arg("synthi-device-compiler-resolve")
        .arg(compiler_exe)
        .kill_on_drop(true);
    resolve_cmd
}

#[cfg(feature = "gpu-hmr")]
fn device_compiler_version_command(
    workspace_dir: &Path,
    execution_path: &str,
) -> tokio::process::Command {
    let mut cmd = device_compiler_command(execution_path, true);
    cmd.current_dir(workspace_dir)
        .arg("--version")
        .kill_on_drop(true);
    cmd
}

#[cfg(feature = "gpu-hmr")]
async fn device_compiler_identity_evidence(
    workspace_dir: &Path,
    compiler_exe: &str,
) -> Result<Option<DeviceCompilerIdentityEvidence>> {
    let mut resolve_cmd = device_compiler_path_resolution_command(workspace_dir, compiler_exe);
    let resolved_out = match timeout(Duration::from_secs(5), resolve_cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => out,
        Ok(Ok(out)) => {
            eprintln!(
                "[compile-device] compiler path resolution failed status={} stderr={}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
            return Ok(None);
        }
        Ok(Err(error)) => {
            eprintln!("[compile-device] compiler path resolution failed: {error}");
            return Ok(None);
        }
        Err(_) => {
            eprintln!("[compile-device] compiler path resolution timed out");
            return Ok(None);
        }
    };
    let resolved_path = String::from_utf8_lossy(&resolved_out.stdout)
        .trim()
        .to_string();
    if !Path::new(&resolved_path).is_absolute()
        || resolved_path.chars().any(|ch| matches!(ch, '\r' | '\n'))
    {
        eprintln!(
            "[compile-device] compiler path resolution returned an invalid path: {:?}",
            resolved_path
        );
        return Ok(None);
    }

    #[cfg(target_os = "linux")]
    let execution_snapshot = {
        let handle = tokio::fs::File::open(&resolved_path)
            .await
            .with_context(|| format!("opening resolved device compiler {resolved_path}"))?;
        let metadata = handle
            .metadata()
            .await
            .with_context(|| format!("inspecting resolved device compiler {resolved_path}"))?;
        if !metadata.is_file() {
            eprintln!("[compile-device] resolved compiler is not a regular file: {resolved_path}");
            return Ok(None);
        }
        let mut reader = handle
            .try_clone()
            .await
            .context("cloning held device compiler executable")?;
        reader
            .seek(std::io::SeekFrom::Start(0))
            .await
            .context("seeking held device compiler executable")?;
        let mut bytes = Vec::new();
        reader
            .read_to_end(&mut bytes)
            .await
            .context("reading held device compiler executable")?;
        if bytes.is_empty() {
            eprintln!("[compile-device] resolved compiler executable is empty: {resolved_path}");
            return Ok(None);
        }
        if !bytes.starts_with(b"\x7fELF") {
            eprintln!(
                "[compile-device] exact compiler entry-file binding requires a native ELF executable: {resolved_path}"
            );
            return Ok(None);
        }
        let executable_hash = format!("sha256:{}", hex_sha256(&bytes));
        let execution_path = format!("/proc/{}/fd/{}", std::process::id(), handle.as_raw_fd());
        Arc::new(DeviceCompilerExecutableSnapshot {
            handle,
            execution_path,
            executable_hash,
            executable_bytes: bytes.len(),
        })
    };
    #[cfg(target_os = "linux")]
    let execution_path = execution_snapshot.execution_path.clone();
    #[cfg(target_os = "linux")]
    let executable_hash = execution_snapshot.executable_hash.clone();

    #[cfg(not(target_os = "linux"))]
    let execution_path = resolved_path.clone();
    #[cfg(not(target_os = "linux"))]
    let executable_hash = {
        let bytes = read_stable_regular_file(
            Path::new(&resolved_path),
            "resolved device compiler executable",
        )
        .await?;
        format!("sha256:{}", hex_sha256(&bytes))
    };

    // The Linux path names the already-open executable description, so the
    // version probe and later compile cannot be redirected by replacing the
    // workspace or PATH entry after measurement.
    let mut cmd = device_compiler_version_command(workspace_dir, &execution_path);
    let out = match timeout(Duration::from_secs(5), cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            eprintln!("[compile-device] compiler identity probe failed: {e}");
            return Ok(None);
        }
        Err(_) => {
            eprintln!("[compile-device] compiler identity probe timed out");
            return Ok(None);
        }
    };
    if !out.status.success() {
        eprintln!(
            "[compile-device] compiler identity probe returned {}",
            out.status
        );
        return Ok(None);
    }

    let mut hasher = Sha256::new();
    cache_update_str(&mut hasher, "invocation_path", &resolved_path);
    cache_update_str(&mut hasher, "executable_hash", &executable_hash);
    cache_update_bytes(&mut hasher, "stdout", &out.stdout);
    cache_update_bytes(&mut hasher, "stderr", &out.stderr);
    cache_update_str(&mut hasher, "status", &out.status.to_string());
    Ok(Some(DeviceCompilerIdentityEvidence {
        identity_hash: cache_hex(hasher),
        resolved_path,
        executable_hash,
        identity_method: if cfg!(target_os = "linux") {
            DEVICE_COMPILER_IDENTITY_METHOD.to_string()
        } else {
            "path_resolved_invocation_sha256+version_output".to_string()
        },
        #[cfg(target_os = "linux")]
        execution_snapshot: Some(execution_snapshot),
        #[cfg(not(target_os = "linux"))]
        execution_snapshot: None,
    }))
}

#[cfg(feature = "gpu-hmr")]
async fn verify_device_compiler_execution_snapshot(
    snapshot: &DeviceCompilerExecutableSnapshot,
) -> Result<()> {
    let mut reader = snapshot
        .handle
        .try_clone()
        .await
        .context("cloning held device compiler executable for verification")?;
    reader
        .seek(std::io::SeekFrom::Start(0))
        .await
        .context("seeking held device compiler executable for verification")?;
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .await
        .context("reading held device compiler executable for verification")?;
    if bytes.len() != snapshot.executable_bytes
        || format!("sha256:{}", hex_sha256(&bytes)) != snapshot.executable_hash
    {
        anyhow::bail!("held device compiler executable bytes changed during cold compilation");
    }
    Ok(())
}

#[cfg(feature = "gpu-hmr")]
async fn finalize_device_compile_proof_metadata(
    metadata: &mut DeviceCompileProofMetadata,
    compile: &DeviceCompileAttempt,
    cold_compile: bool,
) -> Result<()> {
    if !compile.artifact_freshly_created {
        anyhow::bail!("device compiler did not create a fresh nonempty artifact");
    }
    metadata.compiler_process_executed = true;
    metadata.compiler_output_freshly_created = true;
    metadata.source_bytes_verified_after_execution = compile.source_bytes_verified_after_execution;

    if !cold_compile {
        return Ok(());
    }

    let snapshot = metadata
        .compiler_execution_snapshot
        .clone()
        .ok_or_else(|| anyhow::anyhow!("cold device compiler execution snapshot missing"))?;
    verify_device_compiler_execution_snapshot(&snapshot).await?;
    if metadata.compiler_executable_hash.as_deref() != Some(snapshot.executable_hash.as_str()) {
        anyhow::bail!("cold device compiler executable hash does not match held driver entry file");
    }
    metadata.compiler_path_identity_verified_after_execution = true;
    metadata.compiler_driver_entry_file_attested = true;
    metadata.compiler_process_image_attested = false;
    metadata.compiler_execution_transport = DEVICE_COMPILER_EXECUTION_TRANSPORT.to_string();
    metadata.compiler_identity_method = Some(DEVICE_COMPILER_IDENTITY_METHOD.to_string());
    Ok(())
}

#[cfg(feature = "gpu-hmr")]
async fn bind_device_artifact_snapshot(
    metadata: &mut DeviceCompileProofMetadata,
    artifact_path: &Path,
) -> Result<()> {
    let bytes = read_stable_regular_file(artifact_path, "device compiler artifact").await?;
    if bytes.is_empty() {
        anyhow::bail!(
            "device compiler artifact snapshot is empty: {}",
            artifact_path.display()
        );
    }
    metadata.artifact_sha256 = Some(format!("sha256:{}", hex_sha256(&bytes)));
    metadata.artifact_bytes = Some(bytes.len());
    metadata.artifact_snapshot = Some(Arc::<[u8]>::from(bytes));
    Ok(())
}

#[cfg(feature = "gpu-hmr")]
async fn bind_device_artifact_reservation_snapshot(
    metadata: &mut DeviceCompileProofMetadata,
    reservation: &DeviceArtifactReservation,
) -> Result<()> {
    let handle_bytes = read_device_artifact_reservation(reservation).await?;
    let path_bytes =
        read_stable_regular_file(&reservation.path, "device compiler artifact").await?;
    if handle_bytes.is_empty() || handle_bytes != path_bytes {
        anyhow::bail!(
            "device compiler artifact path does not match the held output reservation: {}",
            reservation.path.display()
        );
    }
    metadata.artifact_sha256 = Some(format!("sha256:{}", hex_sha256(&handle_bytes)));
    metadata.artifact_bytes = Some(handle_bytes.len());
    metadata.artifact_snapshot = Some(Arc::<[u8]>::from(handle_bytes));
    Ok(())
}

#[cfg(feature = "gpu-hmr")]
async fn verify_device_artifact_snapshot(
    metadata: &DeviceCompileProofMetadata,
    artifact_path: &Path,
) -> Result<()> {
    let expected_hash = metadata
        .artifact_sha256
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("device artifact snapshot hash missing"))?;
    let expected_bytes = metadata
        .artifact_bytes
        .ok_or_else(|| anyhow::anyhow!("device artifact snapshot byte length missing"))?;
    let observed = read_stable_regular_file(artifact_path, "device compiler artifact").await?;
    if observed.len() != expected_bytes
        || format!("sha256:{}", hex_sha256(&observed)) != expected_hash
    {
        anyhow::bail!(
            "device artifact path changed after its immutable snapshot was captured: {}",
            artifact_path.display()
        );
    }
    Ok(())
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
    cache_update_str(
        &mut hasher,
        "dependency_schema",
        DEVICE_ARTIFACT_CACHE_KEY_SCHEMA,
    );
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
                cache_update_str(
                    &mut hasher,
                    "dependency_content_hash",
                    &hex_sha256(&content),
                );
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

fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug)]
struct DeviceCompileAttempt {
    status: std::process::ExitStatus,
    diagnostics: GpuToolchainDiagnostics,
    stderr: String,
    elapsed_ms: u64,
    artifact_freshly_created: bool,
    source_bytes_verified_after_execution: bool,
}

#[cfg(feature = "gpu-hmr")]
struct DevicePreprocessAttempt {
    bytes: Arc<[u8]>,
    command_hash: String,
    elapsed_ms: u64,
}

#[cfg(feature = "gpu-hmr")]
fn same_file_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> bool {
    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(target_family = "unix"))]
    {
        left.len() == right.len()
            && left.modified().ok() == right.modified().ok()
            && left.created().ok() == right.created().ok()
    }
}

#[cfg(feature = "gpu-hmr")]
async fn read_stable_regular_file(path: &Path, label: &str) -> Result<Vec<u8>> {
    let path_before = tokio::fs::symlink_metadata(path)
        .await
        .with_context(|| format!("inspecting {label} path {}", path.display()))?;
    if !path_before.file_type().is_file() || path_before.file_type().is_symlink() {
        anyhow::bail!(
            "{label} path is not a regular non-symlink file: {}",
            path.display()
        );
    }

    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("opening {label} {}", path.display()))?;
    let handle_before = file
        .metadata()
        .await
        .with_context(|| format!("inspecting open {label} handle {}", path.display()))?;
    if !same_file_identity(&path_before, &handle_before) {
        anyhow::bail!(
            "{label} path changed while it was opened: {}",
            path.display()
        );
    }

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .await
        .with_context(|| format!("reading {label} {}", path.display()))?;
    let handle_after = file
        .metadata()
        .await
        .with_context(|| format!("rechecking open {label} handle {}", path.display()))?;
    let path_after = tokio::fs::symlink_metadata(path)
        .await
        .with_context(|| format!("rechecking {label} path {}", path.display()))?;
    if !path_after.file_type().is_file()
        || path_after.file_type().is_symlink()
        || !same_file_identity(&handle_before, &handle_after)
        || !same_file_identity(&handle_after, &path_after)
        || handle_after.len() != bytes.len() as u64
    {
        anyhow::bail!(
            "{label} changed while bytes were captured: {}",
            path.display()
        );
    }
    Ok(bytes)
}

#[cfg(feature = "gpu-hmr")]
async fn verify_compiler_source_bytes(
    workspace_dir: &Path,
    source_filename: &str,
    expected_sha256: &str,
    expected_bytes: usize,
) -> Result<()> {
    let source_path = workspace_dir.join(source_filename);
    let bytes = read_stable_regular_file(&source_path, "device compiler source").await?;
    let observed_sha256 = format!("sha256:{}", hex_sha256(&bytes));
    if bytes.len() != expected_bytes || observed_sha256 != expected_sha256 {
        anyhow::bail!(
            "device compiler source bytes do not match the request-bound source: {}",
            source_path.display()
        );
    }
    Ok(())
}

#[cfg(feature = "gpu-hmr")]
struct DeviceArtifactReservation {
    path: PathBuf,
    handle: tokio::fs::File,
}

#[cfg(feature = "gpu-hmr")]
async fn read_device_artifact_reservation(
    reservation: &DeviceArtifactReservation,
) -> Result<Vec<u8>> {
    let mut handle = reservation
        .handle
        .try_clone()
        .await
        .context("cloning open device artifact reservation")?;
    handle
        .seek(std::io::SeekFrom::Start(0))
        .await
        .context("seeking open device artifact reservation")?;
    let mut bytes = Vec::new();
    handle
        .read_to_end(&mut bytes)
        .await
        .context("reading open device artifact reservation")?;
    Ok(bytes)
}

#[cfg(feature = "gpu-hmr")]
async fn materialize_device_artifact_reservation(
    reservation: &DeviceArtifactReservation,
    compiler_stdout: &[u8],
) -> Result<()> {
    if compiler_stdout.is_empty() {
        anyhow::bail!("successful cold device compiler produced no artifact bytes on stdout");
    }
    if compiler_stdout.len() as u64 > DEVICE_CACHE_MAX_INCLUDED_BYTES {
        anyhow::bail!(
            "cold device compiler artifact exceeds {} bytes",
            DEVICE_CACHE_MAX_INCLUDED_BYTES
        );
    }
    let mut handle = reservation
        .handle
        .try_clone()
        .await
        .context("cloning held device artifact reservation for materialization")?;
    handle
        .seek(std::io::SeekFrom::Start(0))
        .await
        .context("seeking held device artifact reservation for materialization")?;
    handle
        .set_len(0)
        .await
        .context("truncating held device artifact reservation for materialization")?;
    handle
        .write_all(compiler_stdout)
        .await
        .context("writing compiler stdout to held device artifact reservation")?;
    handle
        .flush()
        .await
        .context("flushing held device artifact reservation")?;
    Ok(())
}

#[cfg(feature = "gpu-hmr")]
async fn reserve_device_artifact_path(
    output_dir: &Path,
    timestamp: i64,
    artifact_ext: &str,
) -> Result<DeviceArtifactReservation> {
    for _ in 0..8 {
        let nonce = uuid::Uuid::new_v4().simple();
        let path = output_dir.join(format!("device_{timestamp}_{nonce}.{artifact_ext}"));
        match tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(handle) => return Ok(DeviceArtifactReservation { path, handle }),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("reserving device artifact {}", path.display()));
            }
        }
    }
    anyhow::bail!("unable to reserve a unique device artifact path after 8 attempts")
}

#[cfg(feature = "gpu-hmr")]
async fn run_cold_device_preprocessor(
    compiler_exe: &str,
    workspace_dir: &Path,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
    request_source: &[u8],
    compiler_snapshot: &DeviceCompilerExecutableSnapshot,
    workspace_source_sha256: &str,
    workspace_source_bytes: usize,
) -> Result<DevicePreprocessAttempt> {
    verify_compiler_source_bytes(
        workspace_dir,
        source_filename,
        workspace_source_sha256,
        workspace_source_bytes,
    )
    .await?;
    verify_device_compiler_execution_snapshot(compiler_snapshot).await?;
    if compiler_exe != compiler_snapshot.execution_path {
        anyhow::bail!("cold device preprocessor did not use the held compiler executable");
    }

    let mut cmd = device_compiler_command(compiler_exe, true);
    populate_device_preprocess_command(&mut cmd, gpu, source_filename);
    cmd.current_dir(workspace_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let request_hash = format!("sha256:{}", hex_sha256(request_source));
    let command_tokens = normalized_device_process_command_tokens(
        workspace_dir,
        source_filename,
        &cmd,
        true,
        Some(&request_hash),
    );
    let command_hash = hash_string_sequence("preprocess_command", &command_tokens);
    let timeout_secs = device_compile_timeout_secs();
    let started = std::time::Instant::now();
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawning cold device preprocessor {compiler_exe}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("cold device preprocessor stdin pipe is unavailable"))?;
    let request_source = request_source.to_vec();
    let writer = tokio::spawn(async move {
        stdin.write_all(&request_source).await?;
        stdin.shutdown().await
    });
    let output = match timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(error.into()),
        Err(_) => {
            writer.abort();
            anyhow::bail!("Device preprocessing timed out after {timeout_secs}s")
        }
    };
    writer
        .await
        .context("joining cold device preprocessor stdin writer")?
        .context("writing request-bound cold device preprocessor stdin")?;
    if !output.status.success() {
        anyhow::bail!(
            "cold device preprocessing failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if output.stdout.is_empty() {
        anyhow::bail!("cold device preprocessing produced an empty translation unit");
    }
    if output.stdout.len() as u64 > DEVICE_CACHE_MAX_INCLUDED_BYTES {
        anyhow::bail!(
            "cold device preprocessed translation unit exceeds {} bytes",
            DEVICE_CACHE_MAX_INCLUDED_BYTES
        );
    }
    verify_compiler_source_bytes(
        workspace_dir,
        source_filename,
        workspace_source_sha256,
        workspace_source_bytes,
    )
    .await?;
    verify_device_compiler_execution_snapshot(compiler_snapshot).await?;

    Ok(DevicePreprocessAttempt {
        bytes: Arc::<[u8]>::from(output.stdout),
        command_hash,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(feature = "gpu-hmr")]
async fn run_device_compile_once(
    compiler_exe: &str,
    workspace_dir: &std::path::Path,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
    artifact_reservation: &DeviceArtifactReservation,
    isolate_parent_environment: bool,
    compiler_snapshot: Option<&DeviceCompilerExecutableSnapshot>,
    expected_source_sha256: &str,
    expected_source_bytes: usize,
    piped_compiler_input: Option<&[u8]>,
    workspace_source_sha256: &str,
    workspace_source_bytes: usize,
) -> Result<DeviceCompileAttempt> {
    let artifact_path = artifact_reservation.path.as_path();
    verify_compiler_source_bytes(
        workspace_dir,
        source_filename,
        workspace_source_sha256,
        workspace_source_bytes,
    )
    .await?;
    if let Some(input) = piped_compiler_input {
        if input.len() != expected_source_bytes
            || format!("sha256:{}", hex_sha256(input)) != expected_source_sha256
        {
            anyhow::bail!("cold device compiler piped input does not match proof metadata");
        }
    }
    if let Some(snapshot) = compiler_snapshot {
        verify_device_compiler_execution_snapshot(snapshot).await?;
        if compiler_exe != snapshot.execution_path {
            anyhow::bail!("cold device compile did not use the held compiler executable");
        }
    }
    let reserved_path = tokio::fs::symlink_metadata(artifact_path)
        .await
        .with_context(|| {
            format!(
                "inspecting reserved device artifact {}",
                artifact_path.display()
            )
        })?;
    let reserved_path_bytes =
        read_stable_regular_file(artifact_path, "reserved device compiler artifact").await?;
    let reserved_handle_bytes = read_device_artifact_reservation(artifact_reservation).await?;
    if !reserved_path.file_type().is_file()
        || reserved_path.file_type().is_symlink()
        || !reserved_path_bytes.is_empty()
        || !reserved_handle_bytes.is_empty()
        || reserved_path_bytes != reserved_handle_bytes
    {
        anyhow::bail!(
            "device compile output reservation is missing, replaced, or nonempty: {}",
            artifact_path.display()
        );
    }

    let mut cmd = device_compiler_command(compiler_exe, isolate_parent_environment);
    if piped_compiler_input.is_some() {
        populate_device_command_with_piped_source(&mut cmd, gpu, source_filename, Path::new("-"));
        cmd.stdin(std::process::Stdio::piped());
    } else {
        populate_device_command(&mut cmd, gpu, source_filename, artifact_path);
    }
    cmd.current_dir(workspace_dir);
    cmd.kill_on_drop(true);
    let timeout_secs = device_compile_timeout_secs();

    eprintln!(
        "[compile-device] {} -> {}  timeout_secs={} args={:?}",
        compiler_exe,
        artifact_path.display(),
        timeout_secs,
        cmd.as_std().get_args()
    );

    let started = std::time::Instant::now();
    let mut child = cmd
        .spawn()
        .with_context(|| format!("spawning {compiler_exe}"))?;
    let mut input_writer = if let Some(input) = piped_compiler_input {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("cold device compiler stdin pipe is unavailable"))?;
        let input = input.to_vec();
        Some(tokio::spawn(async move {
            stdin.write_all(&input).await?;
            stdin.shutdown().await
        }))
    } else {
        None
    };
    let out = match timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => {
            if let Some(writer) = input_writer.take() {
                writer.abort();
            }
            anyhow::bail!("Device compile timed out after {timeout_secs}s")
        }
    };
    if let Some(writer) = input_writer {
        writer
            .await
            .context("joining cold device compiler stdin writer")?
            .context("writing request-bound cold device compiler stdin")?;
    }

    if out.status.success() && piped_compiler_input.is_some() {
        materialize_device_artifact_reservation(artifact_reservation, &out.stdout).await?;
    }

    let stderr_str = String::from_utf8_lossy(&out.stderr).to_string();
    let elapsed_ms = started.elapsed().as_millis() as u64;
    verify_compiler_source_bytes(
        workspace_dir,
        source_filename,
        workspace_source_sha256,
        workspace_source_bytes,
    )
    .await?;
    if let Some(snapshot) = compiler_snapshot {
        verify_device_compiler_execution_snapshot(snapshot).await?;
    }
    let diagnostics = match gpu.vendor {
        DeviceVendor::Cuda => parse_ptxas(&stderr_str),
        DeviceVendor::Rocm => GpuToolchainDiagnostics::default(),
    };

    let artifact_freshly_created = if out.status.success() {
        let path_metadata = tokio::fs::symlink_metadata(artifact_path)
            .await
            .with_context(|| {
                format!(
                    "successful device compiler did not create artifact {}",
                    artifact_path.display()
                )
            })?;
        let path_bytes =
            read_stable_regular_file(artifact_path, "successful device compiler artifact").await?;
        let handle_bytes = read_device_artifact_reservation(artifact_reservation).await?;
        if !path_metadata.file_type().is_file()
            || path_metadata.file_type().is_symlink()
            || path_bytes.is_empty()
            || handle_bytes != path_bytes
        {
            anyhow::bail!(
                "successful device compiler did not populate the held artifact reservation bytes: {}",
                artifact_path.display()
            );
        }
        true
    } else {
        false
    };

    Ok(DeviceCompileAttempt {
        status: out.status,
        diagnostics,
        stderr: stderr_str,
        elapsed_ms,
        artifact_freshly_created,
        source_bytes_verified_after_execution: true,
    })
}

#[cfg(feature = "gpu-hmr")]
fn normalized_manifest_role_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim()
        .trim_start_matches("./")
        .to_string()
}

#[cfg(feature = "gpu-hmr")]
fn manifest_declares_device_role(manifest: &CompileManifest, source_filename: &str) -> bool {
    let source_filename = normalized_manifest_role_path(source_filename);
    manifest
        .module_files
        .device
        .as_deref()
        .is_some_and(|path| normalized_manifest_role_path(path) == source_filename)
        || manifest.gpu.as_ref().is_some_and(|gpu| {
            gpu.device_roles
                .iter()
                .any(|role| normalized_manifest_role_path(&role.path) == source_filename)
        })
}

#[cfg(feature = "gpu-hmr")]
fn manifest_device_architecture(
    manifest: &CompileManifest,
    source_filename: &str,
) -> Option<String> {
    let source_filename = normalized_manifest_role_path(source_filename);
    let gpu = manifest.gpu.as_ref()?;
    let role_arch = gpu
        .device_roles
        .iter()
        .find(|role| normalized_manifest_role_path(&role.path) == source_filename)
        .map(|role| role.arch.as_slice())
        .filter(|arch| !arch.is_empty());
    let architecture = role_arch.unwrap_or(gpu.arch.as_slice());
    (!architecture.is_empty()).then(|| architecture.join(","))
}

#[cfg(feature = "gpu-hmr")]
async fn read_device_heal_context(
    workspace_dir: &std::path::Path,
    manifest: &CompileManifest,
    source_filename: &str,
) -> (String, Option<String>) {
    let mut shared_content = String::new();
    if let Some(shared_role) = manifest.module_files.shared.as_deref() {
        let candidate = workspace_dir.join(shared_role);
        if let (Ok(canonical_workspace), Ok(canonical_candidate)) = (
            tokio::fs::canonicalize(workspace_dir).await,
            tokio::fs::canonicalize(&candidate).await,
        ) {
            if canonical_candidate.starts_with(canonical_workspace) {
                if let Ok(content) = tokio::fs::read_to_string(canonical_candidate).await {
                    if !content.trim().is_empty() {
                        shared_content = content;
                    }
                }
            }
        }
    }

    let architecture = manifest_device_architecture(manifest, source_filename);

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
        if let Ok(root) = std::env::var("ROCM_PATH").or_else(|_| std::env::var("ROCM_HOME")) {
            candidates.push(
                PathBuf::from(root)
                    .join("llvm/bin/llvm-readobj")
                    .to_string_lossy()
                    .to_string(),
            );
        }
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
    let mut is_undefined = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed == "Symbol {" {
            in_symbol = true;
            name = None;
            is_global = false;
            is_function = false;
            is_undefined = false;
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
        } else if let Some(rest) = trimmed.strip_prefix("Section:") {
            is_undefined = rest.contains("Undefined");
        } else if trimmed == "}" {
            if is_global && is_function && !is_undefined {
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
    let mut file = tokio::fs::File::open(path)
        .await
        .with_context(|| format!("opening device artifact {}", path.display()))?;
    let mut buf = [0u8; 24];
    let n = file
        .read(&mut buf)
        .await
        .with_context(|| format!("reading device artifact {}", path.display()))?;
    Ok(has_clang_offload_bundle_header_bytes(&buf[..n]))
}

#[cfg(feature = "gpu-hmr")]
fn has_clang_offload_bundle_header_bytes(bytes: &[u8]) -> bool {
    const HEADER: &[u8] = b"__CLANG_OFFLOAD_BUNDLE__";
    bytes.len() >= HEADER.len() && &bytes[..HEADER.len()] == HEADER
}

#[cfg(feature = "gpu-hmr")]
fn has_elf_magic_bytes(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x7fELF")
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

#[cfg(feature = "gpu-hmr")]
fn populate_device_preprocess_command(
    cmd: &mut tokio::process::Command,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_filename: &str,
) {
    cmd.arg("-E");
    match gpu.device_compiler {
        DeviceCompiler::Nvcc => {
            for arch in &gpu.arch {
                cmd.arg(format!("-arch={arch}"));
            }
            cmd.arg("-x").arg("cu");
        }
        DeviceCompiler::ClangCuda => {
            for arch in &gpu.arch {
                cmd.arg(format!("--cuda-gpu-arch={arch}"));
            }
            cmd.arg("-x").arg("cuda");
        }
        DeviceCompiler::Hipcc => {
            for arch in &gpu.arch {
                cmd.arg(format!("--offload-arch={arch}"));
            }
            cmd.arg("-x").arg("hip");
        }
    }
    if let Some(parent) = Path::new(source_filename)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        cmd.arg("-I").arg(parent);
    }
    append_device_preprocessor_flags(cmd, &gpu.device_flags);
    cmd.arg("-");
}

#[cfg(feature = "gpu-hmr")]
fn append_device_preprocessor_flags(cmd: &mut tokio::process::Command, device_flags: &[String]) {
    let mut index = 0;
    while index < device_flags.len() {
        let flag = &device_flags[index];
        if matches!(flag.as_str(), "-o" | "--output-file" | "-x") {
            index = index.saturating_add(2);
            continue;
        }
        if matches!(
            flag.as_str(),
            "-E" | "-c"
                | "--compile"
                | "--cubin"
                | "--genco"
                | "--offload-device-only"
                | "--no-gpu-bundle-output"
                | "-S"
                | "--ptx"
        ) || flag.starts_with("-o=")
            || flag.starts_with("--output-file=")
            || (flag.starts_with("-x") && flag.len() > 2)
        {
            index += 1;
            continue;
        }
        cmd.arg(flag);
        index += 1;
    }
}

#[cfg(feature = "gpu-hmr")]
fn cold_preprocessor_only_flag_takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "-I" | "-isystem"
            | "-iquote"
            | "-idirafter"
            | "-include"
            | "--include"
            | "--include-directory"
            | "--system-include"
            | "--pre-include"
            | "-imacros"
            | "-D"
            | "-U"
            | "-x"
    )
}

#[cfg(feature = "gpu-hmr")]
fn append_device_codegen_flags(
    cmd: &mut tokio::process::Command,
    device_flags: &[String],
    preprocessed_source: bool,
) {
    if !preprocessed_source {
        cmd.args(device_flags);
        return;
    }

    let mut index = 0;
    while index < device_flags.len() {
        let flag = &device_flags[index];
        if cold_preprocessor_only_flag_takes_value(flag) {
            index = index.saturating_add(2);
            continue;
        }
        if flag.starts_with("-I")
            || flag.starts_with("-isystem")
            || flag.starts_with("-iquote")
            || flag.starts_with("-idirafter")
            || flag.starts_with("-include")
            || flag.starts_with("--include=")
            || flag.starts_with("--include-directory=")
            || flag.starts_with("--system-include=")
            || flag.starts_with("--pre-include=")
            || flag.starts_with("-imacros")
            || flag.starts_with("-D")
            || flag.starts_with("-U")
            || flag.starts_with("-x")
        {
            index += 1;
            continue;
        }
        cmd.arg(flag);
        index += 1;
    }
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
    populate_device_command_inner(cmd, gpu, source_filename, artifact_path, None, false);
}

#[cfg(feature = "gpu-hmr")]
fn populate_device_command_with_piped_source(
    cmd: &mut tokio::process::Command,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    _source_filename: &str,
    artifact_path: &std::path::Path,
) {
    populate_device_command_inner(cmd, gpu, "-", artifact_path, None, true);
}

#[cfg(feature = "gpu-hmr")]
fn populate_device_command_inner(
    cmd: &mut tokio::process::Command,
    gpu: &crate::hmr::compile_manifest::GpuBuildBlock,
    source_argument: &str,
    artifact_path: &std::path::Path,
    piped_source_parent: Option<&Path>,
    preprocessed_source: bool,
) {
    match gpu.device_compiler {
        DeviceCompiler::Nvcc => {
            cmd.arg("--cubin");
            for arch in &gpu.arch {
                cmd.arg(format!("-arch={arch}"));
            }
            if let Some(parent) = piped_source_parent {
                cmd.arg("-x").arg("cu");
                cmd.arg("-I").arg(parent);
            } else if source_argument == "-" {
                cmd.arg("-x").arg("cu");
            }
            // -lineinfo, --use_fast_math, -O3 etc. flow through verbatim;
            // the GPU error triage path (§11.2) parses ptxas-info so the
            // user's `--ptxas-options=-v` is honoured as-is.
            append_device_codegen_flags(cmd, &gpu.device_flags, preprocessed_source);
            cmd.arg("--ptxas-options=-v");
            cmd.arg("-o").arg(artifact_path);
            cmd.arg(source_argument);
        }
        DeviceCompiler::ClangCuda => {
            // clang's CUDA front-end driven by `--cuda-gpu-arch`.
            cmd.arg("--cuda-device-only");
            for arch in &gpu.arch {
                cmd.arg(format!("--cuda-gpu-arch={arch}"));
            }
            if source_argument == "-" {
                cmd.arg("-x").arg(if preprocessed_source {
                    "cuda-cpp-output"
                } else {
                    "cuda"
                });
                if let Some(parent) = piped_source_parent {
                    cmd.arg("-I").arg(parent);
                }
            }
            append_device_codegen_flags(cmd, &gpu.device_flags, preprocessed_source);
            cmd.arg("-o").arg(artifact_path);
            cmd.arg(source_argument);
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
            if source_argument == "-" {
                cmd.arg("-x").arg(if preprocessed_source {
                    "hip-cpp-output"
                } else {
                    "hip"
                });
                if let Some(parent) = piped_source_parent {
                    cmd.arg("-I").arg(parent);
                }
            }
            append_device_codegen_flags(cmd, &gpu.device_flags, preprocessed_source);
            cmd.arg("-o").arg(artifact_path);
            cmd.arg(source_argument);
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
            generated_split_granularity: None,
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
            generated_split_granularity: None,
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
    fn device_compile_timeout_is_identity_independent() {
        assert_eq!(
            device_compile_timeout_secs_for(None, None),
            DEFAULT_DEVICE_FULL_COMPILE_TIMEOUT_SECS
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn device_compile_timeout_honors_scoped_overrides() {
        assert_eq!(device_compile_timeout_secs_for(None, Some(240)), 240);
        assert_eq!(device_compile_timeout_secs_for(Some(30), Some(240)), 30);
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
    fn cold_command_hash_binds_opaque_flags_without_identity_policy() {
        let workspace = PathBuf::from("/workspace/project");
        let mut first = rocm_block();
        first.device_flags = vec!["--arbitrary-backend-option=value-a".to_string()];
        let mut second = first.clone();
        second.device_flags = vec!["--arbitrary-backend-option=value-b".to_string()];

        let first_tokens = normalized_device_compile_command_tokens(
            &workspace,
            "/opt/toolchain/compiler",
            &first,
            "src/device.hip",
            true,
            Some("sha256:input"),
        );
        let second_tokens = normalized_device_compile_command_tokens(
            &workspace,
            "/opt/toolchain/compiler",
            &second,
            "src/device.hip",
            true,
            Some("sha256:input"),
        );

        assert_ne!(
            hash_string_sequence("compile_command", &first_tokens),
            hash_string_sequence("compile_command", &second_tokens)
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn cold_codegen_command_drops_preprocessor_only_inputs() {
        let mut block = rocm_block();
        block.device_flags = vec![
            "-O2".to_string(),
            "-I".to_string(),
            "include".to_string(),
            "--pre-include".to_string(),
            "generated_config.h".to_string(),
            "-DSCALE=2".to_string(),
        ];
        let mut cmd = tokio::process::Command::new("hipcc");
        populate_device_command_with_piped_source(&mut cmd, &block, "device.hip", Path::new("-"));
        let args = args_of(&cmd);

        assert!(args.iter().any(|arg| arg == "-O2"));
        for omitted in [
            "-I",
            "include",
            "--pre-include",
            "generated_config.h",
            "-DSCALE=2",
        ] {
            assert!(!args.iter().any(|arg| arg == omitted), "{omitted:?}");
        }
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
    fn device_heal_requires_an_explicit_manifest_role() {
        let mut manifest = CompileManifest::generic_fallback();
        manifest.module_files.device = Some("units/accelerator-A.payload".to_string());
        let mut gpu = rocm_block();
        gpu.arch = vec!["arch-default".to_string()];
        gpu.device_roles
            .push(crate::hmr::compile_manifest::GpuDeviceRole {
                id: "role-B".to_string(),
                path: "modules/device-B.src".to_string(),
                arch: vec!["arch-role".to_string()],
                ..Default::default()
            });
        manifest.gpu = Some(gpu);

        assert!(manifest_declares_device_role(
            &manifest,
            "./units/accelerator-A.payload"
        ));
        assert!(manifest_declares_device_role(
            &manifest,
            "modules\\device-B.src"
        ));
        assert!(!manifest_declares_device_role(
            &manifest,
            "undeclared/location/device.src"
        ));
        assert_eq!(
            manifest_device_architecture(&manifest, "modules/device-B.src").as_deref(),
            Some("arch-role")
        );
        assert_eq!(
            manifest_device_architecture(&manifest, "units/accelerator-A.payload").as_deref(),
            Some("arch-default")
        );
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
            false,
            None,
        );

        assert!(tokens.iter().any(|token| token == "-I"));
        assert!(tokens
            .iter()
            .any(|token| token == "/workspace/project/include"));
        assert!(tokens
            .iter()
            .any(|token| token == "/workspace/project/third_party/sdk"));
        assert!(tokens
            .iter()
            .any(|token| { token == "--include-directory=/workspace/project/generated/headers" }));
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
    Section: .text (0x2)
  }
  Symbol {
    Name: shade.private_seg_size (12)
    Binding: Local (0x0)
    Type: None (0x0)
    Section: .data (0x3)
  }
  Symbol {
    Name: shade (32)
    Binding: Global (0x1)
    Type: Function (0x2)
    Section: .text (0x2)
  }
  Symbol {
    Name: helper_external (39)
    Binding: Global (0x1)
    Type: Function (0x2)
    Section: Undefined (0x0)
  }
  Symbol {
    Name: shade.kd (45)
    Binding: Global (0x1)
    Type: Object (0x1)
    Section: .data (0x3)
  }
  Symbol {
    Name: __hip_cuid_deadbeef (52)
    Binding: Global (0x1)
    Type: Object (0x1)
    Section: .data (0x3)
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
            compiler_identity: DeviceCompilerIdentityEvidence {
                identity_hash: "identity".to_string(),
                resolved_path: "/usr/bin/compiler".to_string(),
                executable_hash: format!("sha256:{}", "a".repeat(64)),
                identity_method: "test".to_string(),
                execution_snapshot: None,
            },
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

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn cold_device_compile_uses_an_identity_independent_empty_environment() {
        let native = device_compiler_command_for_platform("hipcc", true, false);
        let native_env = native
            .as_std()
            .get_envs()
            .map(|(name, value)| {
                (
                    name.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<BTreeMap<_, _>>();
        assert_eq!(native.as_std().get_program(), "hipcc");
        assert!(native_env.is_empty());
        assert!(device_compiler_cache_controls().is_empty());

        let wsl = device_compiler_command_for_platform("hipcc", true, true);
        let wsl_args = wsl
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(wsl.as_std().get_program(), "wsl");
        assert_eq!(wsl_args, vec!["env", "-i", "hipcc"]);

        let hot = device_compiler_command_for_platform("hipcc", false, false);
        assert_eq!(hot.as_std().get_program(), "hipcc");
        assert_eq!(hot.as_std().get_envs().count(), 0);
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn device_compiler_identity_probes_use_the_workspace_directory() {
        let workspace = tempfile::tempdir().unwrap();
        let resolution = device_compiler_path_resolution_command(workspace.path(), "hipcc");
        assert_eq!(
            resolution.as_std().get_current_dir(),
            Some(workspace.path())
        );

        let version = device_compiler_version_command(workspace.path(), "/opt/rocm/bin/hipcc");
        assert_eq!(version.as_std().get_current_dir(), Some(workspace.path()));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn requested_cold_device_compile_requires_complete_outcome() {
        let tmp = tempfile::tempdir().unwrap();
        let artifact_path = tmp.path().join("device.hsaco");
        let artifact_bytes = b"fresh-device-bytes";
        let compiled_source = "device-source";
        let compiler_input = cold_device_compiler_input("device.hip", compiled_source).unwrap();
        std::fs::write(&artifact_path, artifact_bytes).unwrap();
        let metadata = DeviceCompileProofMetadata {
            compiler_executable: Some("hipcc".to_string()),
            compiler_identity: Some("a".repeat(64)),
            compiler_resolved_path: Some("/opt/rocm/bin/hipcc".to_string()),
            compiler_executable_hash: Some(format!("sha256:{}", "b".repeat(64))),
            compiler_identity_method: Some(DEVICE_COMPILER_IDENTITY_METHOD.to_string()),
            compiler_driver_entry_file_attested: true,
            compiler_process_image_attested: false,
            compiler_execution_transport: DEVICE_COMPILER_EXECUTION_TRANSPORT.to_string(),
            artifact_cache_bypassed: true,
            compiler_process_executed: true,
            preprocessor_process_executed: true,
            preprocessor_identity_verified_after_execution: true,
            preprocessor_command_hash: Some("c".repeat(64)),
            preprocessor_elapsed_ms: Some(1),
            compiler_output_freshly_created: true,
            compiler_path_identity_verified_after_execution: true,
            compiler_cache_policy: DEVICE_COMPILER_CACHE_POLICY.to_string(),
            compiler_cache_controls: device_compiler_cache_controls(),
            compiler_cache_evidence_scope: DEVICE_COMPILER_CACHE_EVIDENCE_SCOPE.to_string(),
            compiler_environment_scope: DEVICE_COMPILER_ENVIRONMENT_SCOPE.to_string(),
            compiler_identity_scope: DEVICE_COMPILER_IDENTITY_SCOPE.to_string(),
            compile_command_hash_scope: DEVICE_COMPILE_COMMAND_HASH_SCOPE.to_string(),
            compiler_input_mode: DEVICE_COMPILER_INPUT_MODE.to_string(),
            compiler_output_transport: DEVICE_COMPILER_OUTPUT_TRANSPORT.to_string(),
            compiler_source_evidence_scope: DEVICE_COMPILER_SOURCE_EVIDENCE_SCOPE.to_string(),
            compile_command_hash: Some("d".repeat(64)),
            dependency_hash: Some(format!("sha256:{}", hex_sha256(&compiler_input))),
            dependency_method: Some(DEVICE_COMPILER_DEPENDENCY_METHOD.to_string()),
            request_source_sha256: Some(format!(
                "sha256:{}",
                hex_sha256(compiled_source.as_bytes())
            )),
            request_source_bytes: Some(compiled_source.len()),
            transformed_source_sha256: Some(format!(
                "sha256:{}",
                hex_sha256(compiled_source.as_bytes())
            )),
            transformed_source_bytes: Some(compiled_source.len()),
            preprocessor_input_sha256: Some(format!("sha256:{}", hex_sha256(&compiler_input))),
            preprocessor_input_bytes: Some(compiler_input.len()),
            source_transforms: Vec::new(),
            compiled_source_sha256: Some(format!("sha256:{}", hex_sha256(&compiler_input))),
            compiled_source_bytes: Some(compiler_input.len()),
            source_filename: Some("device.hip".to_string()),
            source_bytes_verified_after_execution: true,
            request_source_snapshot: Some(Arc::<[u8]>::from(compiled_source.as_bytes())),
            compiler_input_snapshot: Some(Arc::<[u8]>::from(compiler_input.as_slice())),
            artifact_sha256: Some(format!("sha256:{}", hex_sha256(artifact_bytes))),
            artifact_bytes: Some(artifact_bytes.len()),
            artifact_snapshot: Some(Arc::<[u8]>::from(artifact_bytes.as_slice())),
            ..Default::default()
        };
        let mut outcome = DeviceCompileOutcome {
            artifact_path,
            compiled_source: compiled_source.to_string(),
            compiler_elapsed_ms: 1,
            partial_module: false,
            target_symbols: Vec::new(),
            fallback_used: false,
            fallback_reason: None,
            requested_artifact_kind: None,
            selected_artifact_kind: None,
            selected_artifact_bytes: None,
            full_device_bytes: None,
            artifact_exported_symbols: Vec::new(),
            diagnostics: GpuToolchainDiagnostics::default(),
            stderr: String::new(),
            proof_metadata: metadata,
        };

        enforce_requested_cold_device_compile(true, Some(&outcome)).unwrap();
        enforce_requested_cold_device_compile(false, None).unwrap();
        assert!(enforce_requested_cold_device_compile(true, None).is_err());

        outcome.proof_metadata.cache_hit = true;
        let error = enforce_requested_cold_device_compile(true, Some(&outcome)).unwrap_err();
        assert!(error
            .to_string()
            .contains("synthi_artifact_cache_reuse_observed"));
    }

    #[cfg(all(feature = "gpu-hmr", target_os = "linux"))]
    #[tokio::test]
    async fn exact_compiler_entry_binding_rejects_interpreter_scripts() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let compiler = tmp.path().join("compiler-entry");
        tokio::fs::write(&compiler, "#!/bin/sh\nexit 0\n")
            .await
            .unwrap();
        let mut permissions = tokio::fs::metadata(&compiler).await.unwrap().permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&compiler, permissions)
            .await
            .unwrap();

        let evidence = device_compiler_identity_evidence(tmp.path(), &compiler.to_string_lossy())
            .await
            .unwrap();
        assert!(evidence.is_none());
    }

    #[cfg(all(feature = "gpu-hmr", target_os = "linux"))]
    #[tokio::test]
    async fn cold_device_compile_requires_reserved_output_and_binds_driver_identity() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let tmp = tempfile::tempdir().unwrap();
        let compiler_target = tmp.path().join("compiler-driver");
        let compiler_replacement = tmp.path().join("compiler-driver-replacement");
        let compiler_link = tmp.path().join("hipcc");
        let source_path = tmp.path().join("device.hip");
        let dependency_path = tmp.path().join("dependency.h");
        let stale_artifact_path = tmp.path().join("device-stale.hsaco");
        let source = "#include \"dependency.h\"\nextern \"C\" __global__ void apply(float* out) { *out = DEPENDENCY_VALUE; }";
        let dependency_before = "#define DEPENDENCY_VALUE 2.0f\n";
        let dependency_after = "#define DEPENDENCY_VALUE 9.0f\n";
        let helper_source_path = tmp.path().join("compiler-driver.c");
        let helper_source = r##"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

static int copy_stream(FILE *input, FILE *output) {
    unsigned char buffer[4096];
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), input)) > 0) {
        if (fwrite(buffer, 1, count, output) != count) return 1;
    }
    return ferror(input) ? 1 : 0;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
        if (environ && environ[0]) return 89;
        if (access("dependency.h", R_OK) != 0) return 90;
        puts("synthi-test-compiler 1.0");
        return 0;
    }

    const char *depfile = NULL;
    const char *output_path = NULL;
    int preprocess = 0;
    int replace_output = 0;
    for (int index = 1; index < argc; ++index) {
        if (strcmp(argv[index], "-E") == 0) preprocess = 1;
        else if (strcmp(argv[index], "-MF") == 0 && index + 1 < argc) depfile = argv[++index];
        else if (strcmp(argv[index], "-o") == 0 && index + 1 < argc) output_path = argv[++index];
        else if (strcmp(argv[index], "--synthi-test-replace-output") == 0) replace_output = 1;
    }

    if (environ && environ[0]) return 91;
    if (depfile) {
        FILE *file = fopen(depfile, "wb");
        if (!file) return 94;
        fputs("synthi_device_artifact: device.hip\n", file);
        return fclose(file) == 0 ? 0 : 95;
    }

    char first_line[256];
    if (!fgets(first_line, sizeof(first_line), stdin)) return 96;
    if (strcmp(first_line, "#line 1 \"device.hip\"\n") != 0) return 97;
    if (preprocess) {
        fputs(first_line, stdout);
        if (copy_stream(stdin, stdout) != 0) return 98;
        FILE *dependency = fopen("dependency.h", "rb");
        if (!dependency) return 99;
        int copied = copy_stream(dependency, stdout);
        fclose(dependency);
        return copied == 0 ? 0 : 100;
    }
    if (!output_path) return 101;
    if (replace_output) sleep(1);

    FILE *output = strcmp(output_path, "-") == 0 ? stdout : fopen(output_path, "wb");
    if (!output) return 102;
    fputc(0x7f, output);
    fputs("ELFfresh:native:1:1:1", output);
    fputs(first_line, output);
    int copied = copy_stream(stdin, output);
    if (output != stdout) fclose(output);
    return copied == 0 ? 0 : 103;
}
"##;
        tokio::fs::write(&helper_source_path, helper_source)
            .await
            .unwrap();
        let helper_compile = std::process::Command::new("cc")
            .arg("-O2")
            .arg(&helper_source_path)
            .arg("-o")
            .arg(&compiler_target)
            .output()
            .unwrap();
        assert!(
            helper_compile.status.success(),
            "native compiler fixture failed: {}",
            String::from_utf8_lossy(&helper_compile.stderr)
        );
        tokio::fs::write(
            &compiler_replacement,
            "#!/bin/sh\nprintf '%s' 'replacement-compiler-used' >&2\nexit 88\n",
        )
        .await
        .unwrap();
        let mut replacement_permissions = tokio::fs::metadata(&compiler_replacement)
            .await
            .unwrap()
            .permissions();
        replacement_permissions.set_mode(0o755);
        tokio::fs::set_permissions(&compiler_replacement, replacement_permissions)
            .await
            .unwrap();
        symlink(&compiler_target, &compiler_link).unwrap();
        tokio::fs::write(&source_path, source).await.unwrap();
        tokio::fs::write(&dependency_path, dependency_before)
            .await
            .unwrap();
        tokio::fs::write(&stale_artifact_path, b"stale-artifact")
            .await
            .unwrap();

        let block = rocm_block();
        let compiler = compiler_link.to_string_lossy().into_owned();
        let mut metadata = device_compile_proof_metadata(
            tmp.path(),
            &compiler,
            &block,
            "device.hip",
            Arc::<[u8]>::from(source.as_bytes()),
            source,
            Vec::new(),
            None,
            false,
            true,
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            metadata.compiler_resolved_path.as_deref(),
            Some(compiler.as_str())
        );
        assert!(metadata.dependency_method.is_none());
        let compiler_snapshot = metadata
            .compiler_execution_snapshot
            .clone()
            .expect("held compiler executable snapshot");
        let compiler_invocation = compiler_snapshot.execution_path.clone();
        let request_source = cold_device_compiler_input("device.hip", source).unwrap();
        let preprocessed = run_cold_device_preprocessor(
            &compiler_invocation,
            tmp.path(),
            &block,
            "device.hip",
            &request_source,
            &compiler_snapshot,
            &format!("sha256:{}", hex_sha256(source.as_bytes())),
            source.len(),
        )
        .await
        .unwrap();
        let preprocessed_hash = format!("sha256:{}", hex_sha256(preprocessed.bytes.as_ref()));
        metadata.preprocessor_process_executed = true;
        metadata.preprocessor_identity_verified_after_execution = true;
        metadata.preprocessor_command_hash = Some(preprocessed.command_hash);
        metadata.preprocessor_elapsed_ms = Some(preprocessed.elapsed_ms);
        metadata.dependency_hash = Some(preprocessed_hash.clone());
        metadata.dependency_method = Some(DEVICE_COMPILER_DEPENDENCY_METHOD.to_string());
        metadata.compiled_source_sha256 = Some(preprocessed_hash.clone());
        metadata.compiled_source_bytes = Some(preprocessed.bytes.len());
        metadata.compiler_input_snapshot = Some(preprocessed.bytes.clone());
        assert!(String::from_utf8_lossy(preprocessed.bytes.as_ref()).contains(dependency_before));
        let cold_command_tokens = normalized_device_compile_command_tokens(
            tmp.path(),
            &compiler_invocation,
            &block,
            "device.hip",
            true,
            Some(&preprocessed_hash),
        );
        assert!(cold_command_tokens
            .iter()
            .any(|token| token == "parent-environment=empty"));
        assert!(!cold_command_tokens
            .iter()
            .any(|token| token.starts_with("env:")));
        metadata.compile_command_hash = Some(hash_string_sequence(
            "compile_command",
            &cold_command_tokens,
        ));
        tokio::fs::remove_file(&compiler_link).await.unwrap();
        symlink(&compiler_replacement, &compiler_link).unwrap();
        tokio::fs::write(&source_path, "tampered-device-source")
            .await
            .unwrap();
        let piped_input = preprocessed.bytes;
        let stale_handle = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&stale_artifact_path)
            .await
            .unwrap();
        let stale_reservation = DeviceArtifactReservation {
            path: stale_artifact_path.clone(),
            handle: stale_handle,
        };
        let source_error = run_device_compile_once(
            &compiler_invocation,
            tmp.path(),
            &block,
            "device.hip",
            &stale_reservation,
            true,
            Some(&compiler_snapshot),
            metadata.compiled_source_sha256.as_deref().unwrap(),
            metadata.compiled_source_bytes.unwrap(),
            Some(&piped_input),
            &format!("sha256:{}", hex_sha256(source.as_bytes())),
            source.len(),
        )
        .await
        .unwrap_err();
        assert!(source_error
            .to_string()
            .contains("source bytes do not match the request-bound source"));
        tokio::fs::write(&source_path, source).await.unwrap();
        tokio::fs::write(&dependency_path, dependency_after)
            .await
            .unwrap();

        let stale_error = run_device_compile_once(
            &compiler_invocation,
            tmp.path(),
            &block,
            "device.hip",
            &stale_reservation,
            true,
            Some(&compiler_snapshot),
            metadata.compiled_source_sha256.as_deref().unwrap(),
            metadata.compiled_source_bytes.unwrap(),
            Some(&piped_input),
            &format!("sha256:{}", hex_sha256(source.as_bytes())),
            source.len(),
        )
        .await
        .unwrap_err();
        assert!(stale_error
            .to_string()
            .contains("output reservation is missing, replaced, or nonempty"));

        let replaced_artifact = reserve_device_artifact_path(tmp.path(), 42, "hsaco")
            .await
            .unwrap();
        tokio::fs::remove_file(&replaced_artifact.path)
            .await
            .unwrap();
        symlink(&stale_artifact_path, &replaced_artifact.path).unwrap();
        let replaced_error = run_device_compile_once(
            &compiler_invocation,
            tmp.path(),
            &block,
            "device.hip",
            &replaced_artifact,
            true,
            Some(&compiler_snapshot),
            metadata.compiled_source_sha256.as_deref().unwrap(),
            metadata.compiled_source_bytes.unwrap(),
            Some(&piped_input),
            &format!("sha256:{}", hex_sha256(source.as_bytes())),
            source.len(),
        )
        .await
        .unwrap_err();
        assert!(replaced_error
            .to_string()
            .contains("not a regular non-symlink file"));

        let replaced_during_compile = reserve_device_artifact_path(tmp.path(), 42, "hsaco")
            .await
            .unwrap();
        let mut replacing_block = block.clone();
        replacing_block
            .device_flags
            .push("--synthi-test-replace-output".to_string());
        let replacement_path = replaced_during_compile.path.clone();
        let replacement = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            tokio::fs::remove_file(&replacement_path).await.unwrap();
            tokio::fs::write(&replacement_path, b"path-replaced-during-compile")
                .await
                .unwrap();
        });
        let replaced_during_error = run_device_compile_once(
            &compiler_invocation,
            tmp.path(),
            &replacing_block,
            "device.hip",
            &replaced_during_compile,
            true,
            Some(&compiler_snapshot),
            metadata.compiled_source_sha256.as_deref().unwrap(),
            metadata.compiled_source_bytes.unwrap(),
            Some(&piped_input),
            &format!("sha256:{}", hex_sha256(source.as_bytes())),
            source.len(),
        )
        .await
        .unwrap_err();
        replacement.await.unwrap();
        assert!(
            replaced_during_error
                .to_string()
                .contains("did not populate the held artifact reservation bytes"),
            "unexpected replacement-during-compile refusal: {replaced_during_error:#}"
        );

        let (first_reservation, second_reservation) = tokio::join!(
            reserve_device_artifact_path(tmp.path(), 42, "hsaco"),
            reserve_device_artifact_path(tmp.path(), 42, "hsaco"),
        );
        let artifact_reservation = first_reservation.unwrap();
        let concurrent_artifact_reservation = second_reservation.unwrap();
        assert_ne!(
            artifact_reservation.path,
            concurrent_artifact_reservation.path
        );

        let compile = run_device_compile_once(
            &compiler_invocation,
            tmp.path(),
            &block,
            "device.hip",
            &artifact_reservation,
            true,
            Some(&compiler_snapshot),
            metadata.compiled_source_sha256.as_deref().unwrap(),
            metadata.compiled_source_bytes.unwrap(),
            Some(&piped_input),
            &format!("sha256:{}", hex_sha256(source.as_bytes())),
            source.len(),
        )
        .await
        .unwrap();
        assert!(compile.status.success());
        finalize_device_compile_proof_metadata(&mut metadata, &compile, true)
            .await
            .unwrap();
        bind_device_artifact_reservation_snapshot(&mut metadata, &artifact_reservation)
            .await
            .unwrap();
        verify_device_artifact_snapshot(&metadata, &artifact_reservation.path)
            .await
            .unwrap();

        let artifact_bytes = tokio::fs::read(&artifact_reservation.path).await.unwrap();
        let artifact_text = String::from_utf8_lossy(&artifact_bytes);
        assert!(artifact_text.starts_with("\u{7f}ELFfresh:"));
        assert!(artifact_text.contains(":1:1:1"));
        assert!(!artifact_text.contains("replacement-compiler-used"));
        assert!(artifact_text.contains(dependency_before));
        assert!(!artifact_text.contains(dependency_after));
        assert!(metadata.artifact_cache_bypassed);
        assert!(metadata.compiler_process_executed);
        assert!(metadata.compiler_output_freshly_created);
        assert!(metadata.compiler_path_identity_verified_after_execution);
        assert!(metadata.source_bytes_verified_after_execution);
        assert_eq!(metadata.compiled_source_bytes, Some(piped_input.len()));
        assert_eq!(metadata.artifact_bytes, Some(artifact_bytes.len()));
        assert_eq!(
            metadata.compiler_identity_method.as_deref(),
            Some(DEVICE_COMPILER_IDENTITY_METHOD)
        );
        assert!(metadata.compiler_driver_entry_file_attested);
        assert!(!metadata.compiler_process_image_attested);
        assert_eq!(
            metadata.compiler_execution_transport,
            DEVICE_COMPILER_EXECUTION_TRANSPORT
        );
        assert_eq!(metadata.compiler_cache_policy, DEVICE_COMPILER_CACHE_POLICY);
        assert_eq!(
            metadata.compiler_output_transport,
            DEVICE_COMPILER_OUTPUT_TRANSPORT
        );
        assert_eq!(
            metadata.compiler_cache_controls,
            device_compiler_cache_controls()
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn cold_device_compile_real_rocm_toolchain_when_requested() {
        if std::env::var("SYNTHI_TEST_REAL_ROCM_COLD_COMPILE").as_deref() != Ok("1") {
            return;
        }
        let arch = std::env::var("SYNTHI_TEST_GPU_ARCH")
            .expect("SYNTHI_TEST_GPU_ARCH must identify the live ROCm device architecture");
        assert!(!arch.trim().is_empty());

        let tmp = tempfile::tempdir().unwrap();
        let source_filename = ".synthi/generated/gpu/device.hip";
        let source_parent = tmp.path().join(".synthi/generated/gpu");
        tokio::fs::create_dir_all(&source_parent).await.unwrap();
        tokio::fs::write(
            source_parent.join("compile_config.h"),
            b"#define SYNTHI_TEST_SCALE 3.0f\n",
        )
        .await
        .unwrap();
        let source = r#"#include "compile_config.h"
extern "C" __global__ void synthi_test_apply(float* out) {
    if (threadIdx.x == 0) out[0] = SYNTHI_TEST_SCALE;
}
"#;
        let mut block = rocm_block();
        block.arch = vec![arch];
        block.device_flags = vec!["-O2".to_string()];
        let mut manifest = CompileManifest::generic_fallback();
        manifest.gpu = Some(block);

        let outcome = compile_device_phase0_with_cache_policy(
            tmp.path(),
            tmp.path(),
            chrono::Utc::now().timestamp_millis(),
            source,
            Some(source_filename),
            &manifest,
            true,
        )
        .await
        .expect("real cold ROCm compile")
        .expect("real cold ROCm compiler outcome");

        enforce_requested_cold_device_compile(true, Some(&outcome))
            .expect("complete real cold ROCm compiler receipt");
        let artifact = outcome
            .proof_metadata
            .artifact_snapshot
            .as_deref()
            .expect("bound real compiler artifact snapshot");
        assert!(artifact.starts_with(b"\x7fELF"));
        assert_eq!(
            tokio::fs::read(&outcome.artifact_path).await.unwrap(),
            artifact
        );
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

    #[cfg(feature = "gpu-hmr")]
    #[tokio::test]
    async fn explicit_source_filename_is_required_for_device_compile() {
        let mut manifest = CompileManifest::generic_fallback();
        manifest.gpu = Some(rocm_block());
        let tmp = tempfile::tempdir().unwrap();

        let out = compile_device_phase0(
            tmp.path(),
            tmp.path(),
            1,
            "extern \"C\" __global__ void k(float* x) { x[0] = 1.0f; }",
            None,
            &manifest,
        )
        .await
        .unwrap();

        assert!(
            out.is_none(),
            "device compile must require an explicit manifest/generated source filename"
        );
        assert!(
            !tmp.path().join(DEVICE_HIP_FILENAME).exists(),
            "vendor default device.hip must not be materialized"
        );
        assert!(
            !tmp.path().join(DEVICE_CU_FILENAME).exists(),
            "vendor default device.cu must not be materialized"
        );
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
