use libloading::{Library, Symbol};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_void, CString};
use std::io::{self, BufRead, Write};
use std::ptr;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
struct SendVoidPtr(pub usize);
unsafe impl Send for SendVoidPtr {}
unsafe impl Sync for SendVoidPtr {}

#[cfg(target_os = "linux")]
use std::process::Command;
#[cfg(target_os = "linux")]
use worker::runtime::platform::sdl_defs::*;
#[cfg(target_os = "linux")]
use x11rb::connection::Connection;
#[cfg(target_os = "linux")]
use x11rb::protocol::shm::ConnectionExt as ShmConnectionExt;
#[cfg(target_os = "linux")]
use x11rb::protocol::xtest::ConnectionExt as XTestConnectionExt;
// xproto::ConnectionExt provides `get_keyboard_mapping`, used to build
// the keysym → keycode reverse table for XTest keyboard injection.
#[cfg(target_os = "linux")]
use x11rb::protocol::xproto::ConnectionExt as XprotoConnectionExt;

use worker::runtime::runner_logic;
// use worker::compiler::abi_version;
// use worker::hmr::binary_state;
// use worker::hmr::fast_refresh;
use worker::hmr::orchestrator as hmr_orchestrator;
use worker::infra::crash_recovery;
use worker::infra::host_kv;
use worker::runtime::capability;
use worker::runtime::loader;
// use worker::safety::boundary;
// use worker::compiler::source_map;
// use worker::hmr::reload_manager;
// use worker::hmr::state_diff;
use worker::hmr::state_manager;
use worker::runtime::supervisor;

// safety / hardening
use worker::runtime::process_isolation;
// use worker::safety::strict_contract;

// public protocol + infra
// use worker::hmr::reload_protocol;
// use worker::hmr::state_type_id;
// use worker::infra::observability;
// use worker::safety::hardened_ipc;
// use worker::safety::quiescence;
// use worker::safety::restart_control;
// use worker::safety::security;
// use worker::safety::slot_isolation;

use worker::safety::hardened_ipc::{read_frame_validated, write_frame_with_checksum, IpcConfig};

use capability::HmrStatus;
use worker::runtime::plugin_contract::{
    ModuleSlot,
    // HotApi, HotGetApiFn, RunnerApi, CORE_STATE_MAGIC, GUI_STATE_MAGIC, LOG_ERROR,
    // LOG_INFO, LOG_WARN, MAX_STATE_ALIGNMENT, RUNNER_API_VERSION, SYNTHI_CORE_ABI_VERSION,
    // SYNTHI_GUI_ABI_VERSION,
}; // Removed detect_capabilities

use crash_recovery::{
    execute_with_protection, generate_crash_report, install_crash_handlers, set_current_lib_path,
    set_protection_mode, HmrCrashStatus, ProtectionMode,
};

use hmr_orchestrator::HmrOrchestrator; // Removed SavedState

use host_kv::{
    create_kv_api, // Removed module_slot_to_u32, read_schema_table, KV_STORE, HostKvSchemaEvent, SynthiHostContextV1
};

fn device_load_abi_version(kernels: &[String], abi_arg: Option<&str>) -> String {
    abi_arg
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "-")
        .map(str::to_string)
        .unwrap_or_else(|| kernels.join("|"))
}

#[cfg(feature = "gpu-hmr")]
fn is_runtime_execution_paused(runtime_paused: bool, gpu_reload_inflight_count: usize) -> bool {
    runtime_paused || gpu_reload_inflight_count > 0
}

#[cfg(not(feature = "gpu-hmr"))]
fn is_runtime_execution_paused(runtime_paused: bool, _gpu_reload_inflight_count: usize) -> bool {
    runtime_paused
}

#[cfg(feature = "gpu-hmr")]
fn is_runtime_control_command(command: &str) -> bool {
    matches!(
        command,
        "synthi_pause_runtime" | "pause_runtime" | "synthi_resume_runtime" | "resume_runtime"
    )
}

#[cfg(not(feature = "gpu-hmr"))]
fn is_runtime_control_command(_command: &str) -> bool {
    false
}

fn runner_command_name(command: &str) -> Option<&str> {
    command.split_whitespace().next()
}

#[cfg(feature = "gpu-hmr")]
fn should_process_runner_command(command: &str, gpu_reload_inflight_count: usize) -> bool {
    gpu_reload_inflight_count == 0 || is_runtime_control_command(command)
}

#[cfg(not(feature = "gpu-hmr"))]
fn should_process_runner_command(_command: &str, _gpu_reload_inflight_count: usize) -> bool {
    true
}

fn runtime_control_status_payload(
    status: &str,
    token: Option<&str>,
    runtime_paused: bool,
    gpu_reload_inflight_count: usize,
) -> String {
    let mut payload = serde_json::json!({
        "status": status,
        "module": "runner",
        "runtimePaused": runtime_paused,
        "gpuReloadInflightCount": gpu_reload_inflight_count,
    });
    if let Some(token) = token.filter(|value| !value.trim().is_empty()) {
        payload["runtimeControlToken"] = serde_json::Value::String(token.to_string());
    }
    payload.to_string()
}

fn emit_runtime_control_status(
    status: &str,
    token: Option<&str>,
    runtime_paused: bool,
    gpu_reload_inflight_count: usize,
) {
    eprintln!(
        "[Runner] [HMR-STATUS] {}",
        runtime_control_status_payload(status, token, runtime_paused, gpu_reload_inflight_count)
    );
}

#[cfg(feature = "gpu-hmr")]
fn decode_gpu_kernel_command_token(value: &str) -> Option<String> {
    worker::runtime::runner_protocol::decode_runner_command_token(value)
}

use loader::ModuleLoader; // Removed LoadResult

use state_manager::StateManager;
use supervisor::{CrashSupervisor, RecoveryAction, SupervisorConfig};

#[cfg(feature = "gpu-hmr")]
use worker::hmr::adapter_trait::{
    decode_reload_capsule_metadata_token, normalized_reload_source_edit_id, Adapter,
    AdapterReloadRequest, AdapterReloadResult, ReloadArtifactBlob, ReloadCapsuleMetadata,
    ReloadFirewallEvidence,
};
#[cfg(feature = "gpu-hmr")]
use worker::hmr::build_manifest::{
    BuildManifest, BuildSlot, SnapshotMode, GPU_SIDECAR_MODULE_CAPABILITY,
    GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY,
};
#[cfg(feature = "gpu-hmr")]
use worker::hmr::gpu_module_adapter::{
    ArtifactLoaderTransport, GpuModuleAdapter, GpuModuleAdapterConfig, GpuVendor,
};
#[cfg(feature = "gpu-hmr")]
use worker::hmr::gpu_proof::sha256_hex_bytes;
#[cfg(feature = "gpu-hmr")]
use worker::runtime::runner_protocol::{
    GpuReloadV2Payload, GpuReloadV2Result, RunnerProtocolAck,
    GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY, RUNNER_PROTOCOL_CURRENT_VERSION,
    RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION,
};

// use enhanced_fingerprint::{extract_fingerprint_from_module}; // Removed AbiFingerprint

// use crate::runtime::hot_reload::v2::{
//     get_module_abi_version, hot_reload_v2, save_state_msgpack_v2, validate_state_magic,
//     HotModuleState, HotReloadResult, RUNNER_API,
// };
use worker::debug_log;
use worker::runtime::legacy_module_state::{AppState, ModuleState};

#[cfg(feature = "gpu-hmr")]
struct GpuReloadCompletion {
    language: String,
    artifact_path: String,
    kernels: String,
    request_id: Option<String>,
    source_edit_id: Option<String>,
    adapter: GpuModuleAdapter,
    result: AdapterReloadResult,
}

#[cfg(feature = "gpu-hmr")]
fn matching_strict_gpu_runtime_proof_id(
    log_lines: &[String],
    request_id: &str,
    source_edit_id: &str,
) -> Option<String> {
    let reload_ref = format!("reload:{request_id}");
    let source_edit_ref = format!("source-edit-id:{source_edit_id}");
    log_lines.iter().rev().find_map(|line| {
        let proof = serde_json::from_str::<serde_json::Value>(line).ok()?;
        if proof.get("type").and_then(serde_json::Value::as_str) != Some("gpu_hmr_proof")
            || proof.get("resultState").and_then(serde_json::Value::as_str)
                != Some("gpu-hmr-full-runtime-proven")
        {
            return None;
        }
        let proof_id = proof.get("proofId").and_then(serde_json::Value::as_str)?;
        let runtime_artifact = proof.get("runtimeProofArtifact")?;
        if runtime_artifact
            .get("proofId")
            .and_then(serde_json::Value::as_str)
            != Some(proof_id)
            || runtime_artifact
                .get("resultState")
                .and_then(serde_json::Value::as_str)
                != Some("gpu-hmr-full-runtime-proven")
            || runtime_artifact
                .get("fullRuntimeProven")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || runtime_artifact
                .get("gpuHmrSuccess")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || runtime_artifact
                .pointer("/acceptanceContractEvaluation/accepted")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || runtime_artifact
                .pointer("/acceptanceContractConsistency/accepted")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || runtime_artifact
                .pointer("/derivedAcceptanceContractEvaluation/accepted")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || runtime_artifact
                .pointer("/proofLedgerSourceConsistency/accepted")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || runtime_artifact
                .get("limitations")
                .and_then(serde_json::Value::as_array)
                .is_none_or(|limitations| !limitations.is_empty())
        {
            return None;
        }

        let proof_ledger = proof.get("proofLedger")?;
        if proof_ledger
            .get("gpuHmrSuccess")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
            || runtime_artifact.get("proofLedger") != Some(proof_ledger)
        {
            return None;
        }
        let record = proof_ledger.pointer("/records/0")?;
        if record.get("edit_id").and_then(serde_json::Value::as_str) != Some(source_edit_id)
            || runtime_artifact
                .pointer("/explicitProofLedgerRecord/edit_id")
                .and_then(serde_json::Value::as_str)
                != Some(source_edit_id)
            || runtime_artifact
                .pointer("/acceptanceContract/edit_id")
                .and_then(serde_json::Value::as_str)
                != Some(source_edit_id)
            || runtime_artifact
                .pointer("/derivedAcceptanceContract/edit_id")
                .and_then(serde_json::Value::as_str)
                != Some(source_edit_id)
            || runtime_artifact.get("explicitProofLedgerRecord") != Some(record)
            || runtime_artifact.get("derivedProofLedgerRecord") != Some(record)
            || runtime_artifact
                .pointer("/proofLedgerQuery/gpuHmrSuccess")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
            || runtime_artifact
                .pointer("/proofLedgerQuery/failedInvariants")
                .and_then(serde_json::Value::as_array)
                .is_none_or(|failures| !failures.is_empty())
        {
            return None;
        }
        let evidence_refs = record
            .get("evidence_refs")
            .and_then(serde_json::Value::as_array)?;
        let has_ref = |expected: &str| {
            evidence_refs
                .iter()
                .any(|value| value.as_str() == Some(expected))
        };
        (has_ref(&reload_ref) && has_ref(&source_edit_ref)).then(|| proof_id.to_string())
    })
}

#[cfg(feature = "gpu-hmr")]
fn strict_gpu_reload_terminal_result(
    request_id: &str,
    source_edit_id: &str,
    result: &AdapterReloadResult,
    log_lines: &[String],
) -> Result<GpuReloadV2Result, String> {
    match result {
        AdapterReloadResult::Success { .. } => {
            if let Some(proof_id) =
                matching_strict_gpu_runtime_proof_id(log_lines, request_id, source_edit_id)
            {
                GpuReloadV2Result::applied(request_id, source_edit_id, proof_id)
            } else {
                GpuReloadV2Result::rejected(
                    request_id,
                    source_edit_id,
                    "strict GPU reload completed without a matching accepted full runtime proof",
                )
            }
        }
        AdapterReloadResult::Failed { error, .. } => {
            GpuReloadV2Result::rejected(request_id, source_edit_id, error)
        }
        AdapterReloadResult::Unsupported { reason } => {
            GpuReloadV2Result::rejected(request_id, source_edit_id, reason)
        }
    }
}

#[cfg(feature = "gpu-hmr")]
fn emit_gpu_reload_completion(completion: &GpuReloadCompletion) {
    eprintln!(
        "[Runner] [GPU HMR] Device sidecar reload vendor={} artifact={} kernels={} result={:?}",
        completion.language, completion.artifact_path, completion.kernels, completion.result
    );
    match (
        completion.request_id.as_deref(),
        completion.source_edit_id.as_deref(),
    ) {
        (Some(request_id), Some(source_edit_id)) => {
            match strict_gpu_reload_terminal_result(
                request_id,
                source_edit_id,
                &completion.result,
                completion.adapter.last_reload_log(),
            )
            .and_then(|result| result.to_json())
            {
                Ok(status) => eprintln!("[Runner] [HMR-STATUS] {status}"),
                Err(error) => {
                    let status = HmrStatus::rejected_with_fallback(
                        "device",
                        &format!("strict GPU reload terminal result invalid: {error}"),
                        "Keep previous GPU sidecar loaded",
                    );
                    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                }
            }
            return;
        }
        (None, None) => {}
        _ => {
            let status = HmrStatus::rejected_with_fallback(
                "device",
                "strict GPU reload terminal identity is incomplete",
                "Keep previous GPU sidecar loaded",
            );
            eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
            return;
        }
    }

    let status = match &completion.result {
        AdapterReloadResult::Success {
            state_preserved, ..
        } => HmrStatus::Applied {
            module: "device".into(),
            capability: "GPU sidecar HMR".into(),
            state_preserved: *state_preserved,
        },
        AdapterReloadResult::Failed { error, .. } => {
            HmrStatus::rejected_with_fallback("device", error, "Keep previous GPU sidecar loaded")
        }
        AdapterReloadResult::Unsupported { reason } => {
            HmrStatus::rejected_with_fallback("device", reason, "Full GPU sidecar reload required")
        }
    };
    eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
}

#[cfg(feature = "gpu-hmr")]
fn gpu_reload_artifact_blob_from_path(artifact_path: &str) -> Option<ReloadArtifactBlob> {
    match std::fs::read(artifact_path) {
        Ok(bytes) => {
            let artifact_hash = sha256_hex_bytes(&bytes);
            Some(ReloadArtifactBlob {
                blob_id: format!("artifact:sha256:{artifact_hash}"),
                content_hash: format!("sha256:{artifact_hash}"),
                bytes,
            })
        }
        Err(error) => {
            eprintln!(
                "[Runner] [GPU HMR] RAM artifact capsule unavailable artifact={} error={}",
                artifact_path, error
            );
            None
        }
    }
}

#[cfg(feature = "gpu-hmr")]
fn parse_gpu_artifact_loader_transport(
    value: Option<&str>,
) -> Result<ArtifactLoaderTransport, String> {
    match value
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "auto" | "capability" | "capability_auto" | "ram" | "ram_blob" | "ram_bytes"
        | "module_load_data" => Ok(ArtifactLoaderTransport::RamBytes),
        "filesystem" | "filesystem_path" | "path" | "module_load_path" => {
            Ok(ArtifactLoaderTransport::FilesystemPath)
        }
        other => Err(format!(
            "invalid SYNTHI_GPU_HMR_ARTIFACT_LOADER_TRANSPORT={other:?}; expected auto, ram_bytes, or an explicit filesystem_path compatibility mode"
        )),
    }
}

#[cfg(feature = "gpu-hmr")]
fn gpu_artifact_loader_transport_for_reload(
    configured_transport: Option<&str>,
    _artifact_blob: Option<&ReloadArtifactBlob>,
) -> Result<ArtifactLoaderTransport, String> {
    let normalized_transport = configured_transport
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);

    match normalized_transport.as_deref() {
        None | Some("auto") | Some("capability") | Some("capability_auto") => {
            Ok(ArtifactLoaderTransport::RamBytes)
        }
        Some(transport) => parse_gpu_artifact_loader_transport(Some(transport)),
    }
}

#[cfg(feature = "gpu-hmr")]
fn gpu_artifact_loader_transport_from_env_for_reload(
    artifact_blob: Option<&ReloadArtifactBlob>,
) -> Result<ArtifactLoaderTransport, String> {
    let configured_transport = std::env::var("SYNTHI_GPU_HMR_ARTIFACT_LOADER_TRANSPORT").ok();
    gpu_artifact_loader_transport_for_reload(configured_transport.as_deref(), artifact_blob)
}

#[cfg(feature = "gpu-hmr")]
fn gpu_reload_capsule_metadata_from_token(token: Option<&str>) -> Option<ReloadCapsuleMetadata> {
    let token = token
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "-")?;
    let metadata = decode_reload_capsule_metadata_token(token);
    if metadata.is_none() {
        eprintln!("[Runner] [GPU HMR] Ignoring invalid reload capsule metadata token");
    }
    metadata
}

#[cfg(feature = "gpu-hmr")]
fn gpu_reload_source_paths(
    capsule_metadata: Option<&ReloadCapsuleMetadata>,
) -> Vec<String> {
    capsule_metadata
        .and_then(|metadata| metadata.fission_source_paths.clone())
        .unwrap_or_default()
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug)]
struct ParsedGpuReloadCommand {
    request_id: Option<String>,
    partial: bool,
    vendor: String,
    artifact_path: String,
    kernels: Vec<String>,
    abi_version: String,
    capsule_metadata: Option<ReloadCapsuleMetadata>,
    source_edit_id: Option<String>,
}

#[cfg(feature = "gpu-hmr")]
fn parse_gpu_reload_command(parts: &[&str]) -> Result<ParsedGpuReloadCommand, String> {
    if parts.first().copied() == Some("gpu_reload_v2") {
        if parts.len() != 3 {
            return Err("GPU reload V2 command must contain request ID and payload".to_string());
        }
        let payload = GpuReloadV2Payload::decode(parts[2])?;
        if parts[1] != payload.request_id {
            return Err("GPU reload V2 command request ID mismatch".to_string());
        }
        let source_edit_id = normalized_reload_source_edit_id(Some(&payload.source_edit_id))
            .ok_or_else(|| "GPU reload V2 source edit identity is invalid".to_string())?;
        let abi_version =
            device_load_abi_version(&payload.kernels, payload.abi_fingerprint.as_deref());
        let capsule_metadata =
            gpu_reload_capsule_metadata_from_token(payload.capsule_token.as_deref());
        return Ok(ParsedGpuReloadCommand {
            request_id: Some(payload.request_id),
            partial: payload.mode == "partial",
            vendor: payload.vendor,
            artifact_path: payload.artifact_path,
            kernels: payload.kernels,
            abi_version,
            capsule_metadata,
            source_edit_id: Some(source_edit_id),
        });
    }

    let command = parts.first().copied().unwrap_or_default();
    if !matches!(command, "load_device" | "load_device_partial") || parts.len() < 3 {
        return Err("legacy GPU reload command format is invalid".to_string());
    }
    let kernels_arg = parts.get(3).copied().unwrap_or("-");
    let kernels = kernels_arg
        .split(',')
        .filter(|value| !value.trim().is_empty() && *value != "-")
        .map(|value| {
            let raw = value.trim();
            decode_gpu_kernel_command_token(raw)
                .ok_or_else(|| format!("invalid encoded legacy GPU kernel token {raw:?}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let abi_version = device_load_abi_version(&kernels, parts.get(4).copied());
    let capsule_metadata = gpu_reload_capsule_metadata_from_token(parts.get(5).copied());
    if parts.get(6).is_some() {
        eprintln!(
            "[Runner] [GPU HMR] Ignoring independent edit identity on legacy GPU reload verb"
        );
    }
    Ok(ParsedGpuReloadCommand {
        request_id: None,
        partial: command == "load_device_partial",
        vendor: parts[1].to_string(),
        artifact_path: parts[2].to_string(),
        kernels,
        abi_version,
        capsule_metadata,
        source_edit_id: None,
    })
}

// ============================================================
// INDEPENDENT SWAP DOMAINS: Separate state for each module
// ============================================================
// Each module (core, gui) has its own state pointer.
// This allows:
// 1. GUI reload without touching core state
// 2. Core reload triggers GUI reload (ABI change)
// 3. State migration runs only for the affected module
// ============================================================

// Import new HotApi types for v2 ABI
// use capability::{validate_hot_api, HotApiInfo};

// ModuleState moved to legacy_module_state.rs

// HotModuleState moved to hot_reload/v2.rs

// HotReloadResult moved to hot_reload/v2.rs

// RUNNER_API moved to hot_reload/v2.rs

// hot_reload_v2 moved to hot_reload/v2.rs

// Helper functions moved to hot_reload/v2.rs

// Command enum to handle both legacy text commands and binary IPC messages
#[derive(Debug)]
enum RunnerCommand {
    Legacy(String),
    Ipc(process_isolation::IpcMessage),
}

fn runner_command_to_text(cmd_wrapper: RunnerCommand) -> String {
    match cmd_wrapper {
        RunnerCommand::Legacy(c) => c,
        RunnerCommand::Ipc(msg) => match msg {
            process_isolation::IpcMessage::LoadModule { slot, path, .. } => {
                format!("load {} {}", slot, path)
            }
            process_isolation::IpcMessage::ReloadModule { slot, path, .. } => {
                format!("reload {} {}", slot, path)
            }
            process_isolation::IpcMessage::InputEvent { kind, a, b, c } => {
                // Map numeric events back to legacy string commands
                match kind {
                    0 => format!("input motion {} {}", a, b), // x, y
                    1 => format!(
                        "input button {} {} {} {}",
                        if b == 1 { "down" } else { "up" }, // state
                        a,                                  // button
                        (c >> 16) as i16,
                        (c & 0xFFFF) as i16
                    ), // x, y packed
                    2 => format!("input key {} {}", if a == 1 { "down" } else { "up" }, b), // state, keycode
                    _ => String::new(),
                }
            }
            process_isolation::IpcMessage::Ping { seq } => {
                debug_log!("[Runner] Ping received (seq={})", seq);
                String::new()
            }
            _ => {
                debug_log!("[Runner] Unhandled IPC message: {:?}", msg);
                String::new()
            }
        },
    }
}

/// ULTRAPLAN Lightning Phase 10g.2 — backend selection for runtime.
///
/// Runs the WindowBackend selector against the real workspace
/// sidecar + manifest AND returns the chosen backend so main() can
/// actually use it for window creation. Supersedes the
/// observability-only Phase 10g.1 helper (`log_phase10g_backend_selection`).
///
/// Reads the sidecar at `./.synthi_split_meta.json` (relative to
/// the runner's cwd, inherited from the worker's workspace_path).
/// Extracts `architecture` + `compile_manifest.runner_link_flags`
/// and feeds them to `select_backend`.
///
/// Returns:
///   - `Some(SelectedBackend)` when the sidecar parsed cleanly
///     and the selector produced a decision. The caller inspects
///     `.backend.name()` to decide which init path to take.
///   - `None` when the sidecar is missing, unparseable, or
///     otherwise unusable. The caller falls back to the legacy
///     `init_sdl()` path.
///
/// Side effects: logs the decision + inputs to stderr for
/// observability. Every error path also logs before returning None.
fn select_backend_for_runner() -> Option<worker::runtime::backends::selector::SelectedBackend> {
    use worker::runtime::backends::selector::{select_backend, SelectorInputs};

    let sidecar_path = std::path::PathBuf::from(".synthi_split_meta.json");
    let raw = match std::fs::read_to_string(&sidecar_path) {
        Ok(s) => s,
        Err(_) => {
            eprintln!(
                "[Phase 10g] sidecar {} not found — falling back to legacy init_sdl path",
                sidecar_path.display()
            );
            return None;
        }
    };
    let sidecar: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[Phase 10g] sidecar parse failed ({}) — falling back to legacy init_sdl path",
                e
            );
            return None;
        }
    };

    let architecture = sidecar
        .get("architecture")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let link_flags: Vec<String> = sidecar
        .get("compile_manifest")
        .and_then(|m| m.get("runner_link_flags"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let inputs = SelectorInputs {
        arch_cache: architecture,
        link_flags: &link_flags,
    };
    let selected = select_backend(inputs);

    eprintln!(
        "[Phase 10g] Backend selector: picked={} (layer={:?}, display={:?})",
        selected.backend.name(),
        selected.matched_layer,
        selected.framework_display
    );
    eprintln!(
        "[Phase 10g] Inputs: arch_cache={} chars, link_flags={:?}",
        architecture.len(),
        link_flags
    );
    Some(selected)
}

fn main() {
    // ULTRAPLAN Lightning Phase 10g.2 — run the backend selector
    // and keep the result for window creation below. `None` means
    // no sidecar was found (e.g. BYOR or pre-Phase-1 project);
    // we fall back to the legacy `init_sdl()` path in that case.
    //
    // The Box<dyn WindowBackend> is held in `selected_runtime_backend`
    // for the whole lifetime of main() — dropping it would unload
    // any dlopen'd library the backend holds (GLFW/raylib/SFML in
    // future wiring). For the SDL2 MVP this is belt-and-braces since
    // sdl_defs.rs already static-links libSDL2, but the pattern is
    // correct for the non-SDL backends we'll wire next.
    let mut selected_runtime_backend = select_backend_for_runner();

    // ============================================================
    // EXECUTION MODE CHECK - PROCESS ISOLATION IS DEFAULT
    // ============================================================
    // This runner operates in one of two modes:
    // 1. PROCESS-ISOLATED (default): Run as a supervised child process
    //    - Safe: dlclose UB is contained in disposable process
    //    - Automatic restart on crash
    //    - State preserved via IPC snapshots
    //
    // 2. UNSAFE IN-PROCESS (legacy, deprecated): Direct library loading
    //    - DANGEROUS: dlclose UB can corrupt parent process
    //    - Only enabled with SYNTHI_UNSAFE_INPROCESS=1
    //    - Exists only for debugging/profiling where isolation overhead is unacceptable
    // ============================================================
    let execution_mode = process_isolation::ExecutionMode::from_env();

    match execution_mode {
        process_isolation::ExecutionMode::ProcessIsolated => {
            // This is the SAFE path - we should be running under a supervisor.
            // If we're the top-level process, we need to spawn a supervisor.
            if std::env::var("SYNTHI_SUPERVISED").is_err() {
                // We are the top-level process - start the supervisor
                debug_log!("[Runner] Starting in PROCESS-ISOLATED mode (safe default)");
                debug_log!("[Runner] Spawning supervisor to manage worker process...");

                // Mark that we're now supervising
                std::env::set_var("SYNTHI_SUPERVISED", "1");

                let config = process_isolation::IsolationConfig::default();
                let mut supervisor = process_isolation::ProcessSupervisor::new(config);

                if let Err(e) = supervisor.start() {
                    eprintln!("[Runner] FATAL: Failed to start supervisor: {}", e);
                    std::process::exit(1);
                }

                // Run the full supervisor event loop
                debug_log!("[Runner] Supervisor started, entering event loop");
                if let Err(e) = supervisor.run_event_loop() {
                    eprintln!("[Runner] Supervisor event loop error: {}", e);
                    std::process::exit(1);
                }

                debug_log!("[Runner] Supervisor event loop completed, exiting");
                std::process::exit(0);
            } else {
                debug_log!(
                    "[Runner] Running as supervised worker process (PID: {})",
                    std::process::id()
                );
                // v2.1: Verify we are receiving the correct environment
                if let Ok(parent_pid) = std::env::var("SYNTHI_SUPERVISOR_PID") {
                    debug_log!("[Runner] Managed by supervisor PID: {}", parent_pid);
                }
            }
        }
        #[allow(deprecated)]
        process_isolation::ExecutionMode::UnsafeInProcess => {
            // UNSAFE PATH - User explicitly opted in
            debug_log!("[Runner] ============================================================");
            eprintln!("[Runner] WARNING: Running in UNSAFE IN-PROCESS mode");
            debug_log!("[Runner] This mode is DEPRECATED and may cause process corruption");
            eprintln!("[Runner] dlclose UB can corrupt memory, leak resources, crash randomly");
            debug_log!("[Runner] Use SYNTHI_UNSAFE_INPROCESS=1 only for debugging");
            debug_log!("[Runner] ============================================================");
        }
    }

    // Install crash handlers for runtime error recovery
    // IMPORTANT: Set protection mode to SignalRecovery BEFORE installing handlers.
    // The runner uses thread-based execution (execute_with_protection spawns threads),
    // NOT fork-based isolation. ForkIsolation mode would call _exit() in the signal
    // handler, killing the entire runner process instead of just the crashed thread.
    eprintln!("[Runner] Installing crash handlers...");
    set_protection_mode(ProtectionMode::SignalRecovery);
    if let Err(e) = install_crash_handlers() {
        eprintln!("[Runner] Warning: Failed to install crash handlers: {}", e);
    } else {
        eprintln!("[Runner] Crash handlers installed successfully");
    }

    // When DISPLAY is pre-set, the worker manages Xvfb, GStreamer, and video
    // streaming.  Skip creating our own Xvfb / X11 connection / SHM since the
    // worker captures frames via GStreamer ximagesrc.  BUT we still need an SDL
    // window + renderer so loaded modules can render into the worker's Xvfb.
    #[cfg(target_os = "linux")]
    let worker_managed_display = !std::env::var("DISPLAY").unwrap_or_default().is_empty();
    #[cfg(not(target_os = "linux"))]
    let worker_managed_display = false;

    #[cfg(target_os = "linux")]
    let (_xvfb_proc, x11_conn, _x11_screen_num, x11_root) = if !worker_managed_display {
        let mut cmd = Command::new("Xvfb");
        cmd.args(&[":99", "-screen", "0", "800x600x24"]);
        let c = cmd.spawn().ok();
        thread::sleep(Duration::from_millis(100));
        std::env::set_var("DISPLAY", ":99");
        let (conn, screen_num) = x11rb::connect(Some(":99")).expect("Failed to connect to X11");
        let root = conn.setup().roots[screen_num].root;
        (c, Some(conn), screen_num, root)
    } else {
        // Worker manages Xvfb — we still need an X11 connection for XTest
        // input injection (fake_input for mouse events).
        let display_str = std::env::var("DISPLAY").unwrap_or_else(|_| ":99".to_string());
        debug_log!(
            "[Runner] Worker manages display — connecting to {} for XTest input injection",
            display_str
        );
        match x11rb::connect(Some(&display_str)) {
            Ok((conn, screen_num)) => {
                let root = conn.setup().roots[screen_num].root;
                (None, Some(conn), screen_num, root)
            }
            Err(e) => {
                eprintln!(
                    "[Runner] Failed to connect to X11 display {}: {}. Mouse input disabled.",
                    display_str, e
                );
                (None, None, 0, 0u32)
            }
        }
    };

    // Initialize XTest extension for mouse input injection.
    // XTest fake_input bypasses window-manager passive grabs (with grab_control),
    // eliminating the WM interference that caused xdotool clicks to clear windows.
    // Also avoids spawning a process per event (5-10ms overhead + race conditions).
    #[cfg(target_os = "linux")]
    let xtest_ready = if let Some(ref conn) = x11_conn {
        match conn.xtest_get_version(2, 2u16) {
            Ok(cookie) => {
                match cookie.reply() {
                    Ok(ver) => {
                        debug_log!(
                            "[Runner] XTest extension v{}.{} available",
                            ver.major_version,
                            ver.minor_version
                        );
                        // Enable grab bypass: XTest events will not activate passive grabs
                        // (e.g. matchbox-WM's button grabs for click-to-focus). Without this,
                        // the WM intercepts every button event before the app sees it.
                        match conn.xtest_grab_control(true) {
                            Ok(_) => {
                                let _ = conn.flush();
                                debug_log!("[Runner] XTest grab_control(impervious=true) — WM grabs bypassed");
                                true
                            }
                            Err(e) => {
                                eprintln!("[Runner] XTest grab_control failed: {}. Falling back to xdotool.", e);
                                false
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[Runner] XTest get_version failed: {}. Mouse input may not work.",
                            e
                        );
                        false
                    }
                }
            }
            Err(e) => {
                debug_log!(
                    "[Runner] XTest extension not available: {}. Mouse input may not work.",
                    e
                );
                false
            }
        }
    } else {
        false
    };

    // Build a keysym → keycode lookup so keyboard injection via XTest works
    // for raw-Xlib user apps (those that `XSelectInput(KeyPressMask)` and
    // poll `XNextEvent` directly — e.g. the snake demo). The shipped
    // `SDL_PushEvent` path below stays in place for SDL apps; this is the
    // parallel path for the non-SDL case. Querying the X server once at
    // startup is cheaper than per-event and matches the active keyboard
    // layout. Empty on failure → key injection silently degrades.
    #[cfg(target_os = "linux")]
    let keysym_to_keycode: std::collections::HashMap<u32, u8> = if let Some(ref conn) = x11_conn {
        let setup = conn.setup();
        let min_kc = setup.min_keycode;
        let max_kc = setup.max_keycode;
        let count = max_kc - min_kc + 1;
        match conn.get_keyboard_mapping(min_kc, count) {
            Ok(cookie) => match cookie.reply() {
                Ok(mapping) => {
                    let per = mapping.keysyms_per_keycode as usize;
                    let mut map = std::collections::HashMap::with_capacity(count as usize * per);
                    for i in 0..count as usize {
                        let kc = min_kc + i as u8;
                        for j in 0..per {
                            let ks = mapping.keysyms[i * per + j];
                            if ks != 0 {
                                // First keycode wins — typical layout has
                                // lower-case at index 0, upper at index 1,
                                // so XK_a → its base keycode and XK_A → the
                                // same keycode (Shift handled by caller).
                                map.entry(ks).or_insert(kc);
                            }
                        }
                    }
                    debug_log!("[Runner] keysym→keycode map built: {} entries", map.len());
                    map
                }
                Err(e) => {
                    eprintln!("[Runner] get_keyboard_mapping reply failed: {}. Keyboard XTest injection disabled.", e);
                    std::collections::HashMap::new()
                }
            },
            Err(e) => {
                eprintln!(
                    "[Runner] get_keyboard_mapping failed: {}. Keyboard XTest injection disabled.",
                    e
                );
                std::collections::HashMap::new()
            }
        }
    } else {
        std::collections::HashMap::new()
    };

    // SHM is only needed when runner manages its own display (for frame capture).
    // When the worker manages display, GStreamer ximagesrc handles capture.
    #[cfg(target_os = "linux")]
    let (shm_seg, shm_ptr) = if !worker_managed_display {
        if let Some(ref conn) = x11_conn {
            let size = 800 * 600 * 4;
            let (id, ptr) = worker::runtime::runner::capture::create_shm_segment(size)
                .expect("Failed to create SHM");
            let seg = conn.generate_id().unwrap();
            conn.shm_attach(seg, id as u32, false).unwrap();
            (seg, ptr)
        } else {
            (0u32, ptr::null_mut())
        }
    } else {
        (0u32, ptr::null_mut())
    };

    // ULTRAPLAN Lightning Phase 10g.2-10g.4 — backend init via
    // WindowBackend trait. The selector picks a backend from the
    // sidecar; the trait's init + create_window run. For SDL2 we
    // also extract the raw_ptr/renderer_ptr into the legacy
    // `(window, renderer)` tuple so the existing SDL-specific
    // downstream code (sdl_window_id lookup, xdotool input
    // injection, etc.) keeps working. For non-SDL2 backends the
    // `window`/`renderer` tuple stays null, but `host_surface`
    // carries the backend render surface passed to generated
    // modules. GLFW/OpenGL, for example, needs the GLFWwindow*
    // there even though the SDL-specific tuple must remain null.
    //
    // When the selector returns None (no sidecar — BYOR or smoke
    // test path) we fall back to the legacy init_sdl() path with
    // a null runtime_handle. Non-SDL backends have no legacy
    // fallback (the host needs to know the library shape) so an
    // init failure just propagates and the runner exits.
    #[cfg(target_os = "linux")]
    let mut runtime_handle: Option<worker::runtime::window_backend::WindowHandle> = None;
    #[cfg(target_os = "linux")]
    let (window, renderer, host_surface) = {
        use worker::runtime::window_backend::WindowFlags;
        if let Some(selected) = selected_runtime_backend.as_mut() {
            let backend_name = selected.backend.name().to_string();
            match selected.backend.init() {
                Ok(()) => {
                    match selected.backend.create_window(
                        "Synthi Runner",
                        800,
                        600,
                        WindowFlags::default(),
                    ) {
                        Ok(handle) => {
                            let surface = if handle.renderer_ptr.is_null() {
                                handle.raw_ptr
                            } else {
                                handle.renderer_ptr
                            };
                            eprintln!(
                                "[Phase 10g.4] WindowBackend trait created {} window \
                                 (win={:p}, renderer={:p}, surface={:p}, x11_id={:?})",
                                backend_name,
                                handle.raw_ptr,
                                handle.renderer_ptr,
                                surface,
                                handle.x11_window_id,
                            );
                            // For SDL2, extract raw pointers for the
                            // legacy downstream call sites; for non-SDL
                            // backends the SDL-specific pointers stay
                            // null. `surface` is still passed to modules
                            // through AppState so they can use their own
                            // backend pointer.
                            let (win, ren) = if backend_name == "SDL2" {
                                (handle.raw_ptr as *mut SDL_Window, handle.renderer_ptr)
                            } else {
                                (ptr::null_mut(), ptr::null_mut())
                            };
                            runtime_handle = Some(handle);
                            (win, ren, surface)
                        }
                        Err(e) => {
                            eprintln!(
                                "[Phase 10g.4] WindowBackend create_window failed for {} ({}) — \
                                 falling back to legacy init_sdl (only safe for SDL2 projects)",
                                backend_name, e
                            );
                            let (win, ren) = unsafe { init_sdl() };
                            (win, ren, ren)
                        }
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[Phase 10g.4] WindowBackend init failed for {} ({}) — \
                         falling back to legacy init_sdl (only safe for SDL2 projects)",
                        backend_name, e
                    );
                    let (win, ren) = unsafe { init_sdl() };
                    (win, ren, ren)
                }
            }
        } else {
            // No sidecar. Happens on BYOR projects, smoke tests,
            // and any manual runner invocation without a workspace.
            // Default to SDL2 via the legacy init_sdl path — this
            // preserves pre-Phase-10g behavior for anything the
            // selector can't inspect.
            eprintln!(
                "[Phase 10g.4] No selector decision (no sidecar) — \
                 defaulting to legacy init_sdl path"
            );
            let (win, ren) = unsafe { init_sdl() };
            (win, ren, ren)
        }
    };

    // Cache the SDL window ID for injected events (SDL assigns IDs starting
    // from 1). Using windowID=0 in injected events causes them to target a
    // non-existent window.
    //
    // ULTRAPLAN Lightning Phase 10g.4 — this ID is ONLY meaningful when
    // the backend is SDL2. Non-SDL backends (GLFW/raylib/SFML) don't speak
    // SDL_Event and won't receive xdotool-style input forwarding through
    // this ID; they use the X11-level input injection via x11_conn + XTest
    // instead. For those backends we leave sdl_window_id=0 and the event
    // injection path skips SDL entirely.
    #[cfg(target_os = "linux")]
    let sdl_window_id: u32 = {
        let backend_is_sdl2 = selected_runtime_backend
            .as_ref()
            .map(|s| s.backend.name() == "SDL2")
            .unwrap_or(true); // legacy init_sdl fallback is SDL2 by construction
        if backend_is_sdl2 && !window.is_null() {
            unsafe { SDL_GetWindowID(window as *mut SDL_Window) }
        } else {
            0
        }
    };
    #[cfg(not(target_os = "linux"))]
    let sdl_window_id: u32 = 0;

    // Phase 10g.4 — the SDL_CreateTexture block was dead code. The
    // texture handle was bound to `_sdl_texture` and never read
    // downstream (actual frame capture uses XShmGetImage via the
    // worker-managed GStreamer pipeline). Dropped entirely. If a
    // future rev needs an in-runner SDL texture pipeline for
    // headless-runner capture mode, it should go behind the
    // WindowBackend trait so non-SDL backends have an equivalent.

    // Initialize GStreamer
    if let Err(e) = gstreamer::init() {
        eprintln!("Failed to initialize GStreamer: {}", e);
    } else {
        debug_log!("GStreamer initialized.");
    }
    let _ = io::stdout().flush();

    debug_log!("Runner started. Waiting for commands...");

    let (tx, rx) = mpsc::channel::<RunnerCommand>();

    // Frame pipe to stdout (non-blocking for the main loop)
    // We keep the channel tiny and drop frames when the pipe is backed up so on_update keeps running.
    #[cfg(target_os = "linux")]
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Vec<u8>>(2);

    // Dedicated writer so rendering never blocks on stdout backpressure
    #[cfg(target_os = "linux")]
    {
        // Only spawn video writer if NOT in ProcessIsolated mode to prevent IPC corruption
        if !matches!(
            execution_mode,
            process_isolation::ExecutionMode::ProcessIsolated
        ) {
            std::thread::spawn(move || {
                let mut stdout = io::stdout();
                while let Ok(buf) = frame_rx.recv() {
                    if let Err(e) = stdout.write_all(&buf) {
                        eprintln!("[Runner] stdout writer error: {}", e);
                        break;
                    }
                    let _ = stdout.flush();
                }
            });
        } else {
            debug_log!("[Runner] Raw video output DISABLED in ProcessIsolated mode (IPC active)");
        }
    }

    // Spawn input reader thread based on execution mode
    let tx_clone = tx.clone();
    let mode_for_thread = execution_mode;

    // Spawn stdin reader thread
    thread::spawn(move || {
        debug_log!("Input reader thread started (Mode: {:?})", mode_for_thread);
        let stdin = io::stdin();
        let mut handle = stdin.lock();

        match mode_for_thread {
            process_isolation::ExecutionMode::ProcessIsolated => {
                // Binary IPC reader (MsgPack frames)
                // Use default config for now
                let config = IpcConfig::default();

                loop {
                    match read_frame_validated(&mut handle, &config, None) {
                        Ok(payload) => {
                            // Deserialize MsgPack
                            match rmp_serde::from_slice::<process_isolation::IpcMessage>(&payload) {
                                Ok(msg) => {
                                    if let Err(e) = tx_clone.send(RunnerCommand::Ipc(msg)) {
                                        eprintln!("Failed to send IPC command: {}", e);
                                        break;
                                    }
                                }
                                Err(e) => eprintln!("IPC Deserialization error: {}", e),
                            }
                        }
                        Err(e) => {
                            // Check if it's EOF
                            if matches!(e, worker::safety::hardened_ipc::IpcError::ConnectionClosed)
                            {
                                debug_log!("IPC connection closed (EOF)");
                            } else {
                                eprintln!("IPC Read error: {:?}", e);
                            }
                            break;
                        }
                    }
                }
            }
            #[allow(deprecated)]
            process_isolation::ExecutionMode::UnsafeInProcess => {
                // Legacy text reader
                let mut line = String::new();
                loop {
                    match handle.read_line(&mut line) {
                        Ok(0) => {
                            debug_log!("Stdin closed (EOF)");
                            break;
                        }
                        Ok(_) => {
                            let trimmed = line.trim().to_string();
                            if !trimmed.is_empty() {
                                debug_log!("Stdin received: {}", trimmed);
                                if let Err(e) = tx_clone.send(RunnerCommand::Legacy(trimmed)) {
                                    eprintln!("Failed to send command to main thread: {}", e);
                                    break;
                                }
                            }
                            line.clear();
                        }
                        Err(e) => {
                            eprintln!("Error reading stdin: {}", e);
                            break;
                        }
                    }
                }
            }
        }
        debug_log!("Input reader thread exited");
    });

    let mut modules: HashMap<String, Library> = HashMap::new();
    let mut loaded_paths: HashMap<String, String> = HashMap::new();
    // Independent swap: Track state per module
    let mut module_states: HashMap<String, ModuleState> = HashMap::new();
    // Flicker prevention: skip render for one frame after a module load
    // so the new module's on_load has executed before on_render is called.
    let mut skip_render_frames: u32 = 0;
    // GPU sidecar HMR can spend seconds in the device compiler while the
    // current module keeps rendering. Let the worker quiesce user module
    // update/render during that window without stopping stdin, status
    // processing, frame presentation, or capture.
    let mut runtime_paused: bool = false;
    let mut deferred_commands: VecDeque<String> = VecDeque::new();

    // ============================================================
    // MODULE LOADER WITH ABI VALIDATION
    // ============================================================
    // ModuleLoader provides:
    // - ABI compatibility checking before load
    // - Symbol manifest validation
    // - Rollback support to previous versions
    // - Load history for debugging
    // Note: We still use the modules HashMap for actual library storage
    // because ModuleLoader integration is gradual - it validates but
    // the existing loading code handles state transfer and lifecycle.
    let mut module_loader = ModuleLoader::new();
    let loader_enabled = std::env::var("SYNTHI_LOADER_VALIDATION").is_ok();
    if loader_enabled {
        debug_log!("[Runner] ModuleLoader ABI validation ENABLED");
    }

    // ============================================================
    // CRASH SUPERVISOR
    // ============================================================
    // CrashSupervisor coordinates crash recovery with policies:
    // - First crash: attempt hot reload
    // - Second crash: rollback to previous version
    // - Third+ crash: clean restart
    // - Too many crashes: full restart required
    let mut crash_supervisor = CrashSupervisor::new(SupervisorConfig {
        max_consecutive_crashes: 3,
        crash_window: Duration::from_secs(60),
        detailed_logging: true,
        ..Default::default()
    });
    let supervisor_enabled = std::env::var("SYNTHI_CRASH_SUPERVISOR").is_ok() || true; // Enable by default
    if supervisor_enabled {
        eprintln!("[Runner] CrashSupervisor ENABLED (max_crashes=3, window=60s)");
    }

    // ============================================================
    // STATE MANAGER
    // ============================================================
    // StateManager tracks state per module for centralized lifecycle management
    let _state_manager = StateManager::new();
    debug_log!("[Runner] StateManager initialized");

    // ============================================================
    // HMR ORCHESTRATOR (Unified State/Reload Management)
    // ============================================================
    // The orchestrator consolidates:
    // - State save/load (binary-first with JSON fallback)
    // - Reload classification (Safe/Warm/Cold)
    // - Schema compatibility checking
    // - Crash recovery coordination
    // ============================================================
    let mut orchestrator = HmrOrchestrator::new();
    debug_log!("[Runner] HmrOrchestrator initialized (binary_state=ENABLED)");

    #[cfg(not(target_os = "linux"))]
    let (_window, _renderer, host_surface) = (
        ptr::null_mut::<c_void>(),
        ptr::null_mut::<c_void>(),
        ptr::null_mut::<c_void>(),
    );
    let mut app_state = AppState {
        raw: std::ptr::null_mut(),
        renderer: host_surface,
    };
    let mut last_frame = Instant::now();
    let mut last_log = Instant::now();
    let mut last_motion_time = Instant::now();
    let mut frame_count: u64 = 0;
    let mut frames_sent: u64 = 0;
    let mut last_frame_log = Instant::now();

    // ============================================================
    // HOST KV STATE
    // ============================================================
    // Session ID for Host KV scoping. Must be set via "set_session" command
    // before loading modules that use Host KV.
    // Read session from env var (set by worker when spawning us) as initial
    // fallback. The worker also sends a 'set_session' text command, but
    // having the env var ensures session is available immediately for the
    // first module loads without a race against stdin ordering.
    let mut session_id: Option<String> = std::env::var("SYNTHI_SESSION_ID").ok();
    let mut session_id_cstring: Option<CString> = session_id
        .as_ref()
        .and_then(|s| CString::new(s.clone()).ok());
    if let Some(ref sid) = session_id {
        debug_log!("[Runner] Session ID from env: {}", sid);
    }
    let kv_api = create_kv_api();
    #[cfg(feature = "gpu-hmr")]
    let mut gpu_adapters: HashMap<String, GpuModuleAdapter> = HashMap::new();
    #[cfg(feature = "gpu-hmr")]
    let (gpu_reload_tx, gpu_reload_rx) = mpsc::channel::<GpuReloadCompletion>();
    #[cfg(feature = "gpu-hmr")]
    let mut gpu_reload_inflight: HashMap<String, Instant> = HashMap::new();

    #[cfg(target_os = "linux")]
    debug_log!("[Runner] Frame capture enabled (Linux build)");
    #[cfg(not(target_os = "linux"))]
    debug_log!("[Runner] Frame capture DISABLED (non-Linux build)");

    // Notify supervisor that we are ready (if in isolated mode)
    if let process_isolation::ExecutionMode::ProcessIsolated = execution_mode {
        let mut stdout = io::stdout();
        let msg = process_isolation::IpcMessage::Ready;
        let payload = rmp_serde::to_vec(&msg).unwrap();

        if let Err(e) = write_frame_with_checksum(&mut stdout, &payload) {
            eprintln!("[Runner] Failed to send Ready message: {}", e);
        } else {
            let _ = stdout.flush();
            debug_log!("[Runner] Sent Ready message to supervisor");
        }
    }

    loop {
        #[cfg(feature = "gpu-hmr")]
        while let Ok(completion) = gpu_reload_rx.try_recv() {
            emit_gpu_reload_completion(&completion);
            gpu_reload_inflight.remove(&completion.language);
            gpu_adapters.insert(completion.language, completion.adapter);
        }

        #[cfg(feature = "gpu-hmr")]
        let runtime_execution_paused =
            is_runtime_execution_paused(runtime_paused, gpu_reload_inflight.len());
        #[cfg(not(feature = "gpu-hmr"))]
        let runtime_execution_paused = is_runtime_execution_paused(runtime_paused, 0);

        // Poll SDL2 events and pass them to loaded modules.
        //
        // ULTRAPLAN Lightning Phase 10g.3b — route through the
        // WindowBackend trait's pump_events when a runtime_handle
        // was established (selector picked SDL2). Each event's
        // Raw payload is a pointer into sdl2_backend's event_arena
        // (stable until the NEXT pump_events call), which we cast
        // back to *mut SDL_Event for dispatch to user modules.
        // Behaviorally identical to the legacy SDL_PollEvent loop
        // for SDL2, but the dispatch surface is now library-agnostic
        // — a GLFW backend would pump glfw events, a raylib backend
        // would pump raylib events, etc.
        //
        // Fallback: when no runtime_handle is held (no sidecar
        // / non-SDL2 selector / trait init failure), run the
        // legacy direct SDL_PollEvent path. Drained events go
        // into a local Vec<SDL_Event> that outlives the pointer
        // collection used for dispatch.
        #[cfg(target_os = "linux")]
        if !window.is_null() && !runtime_execution_paused {
            // Collect event pointers from whichever source. The
            // storage behind the pointers lives in either
            // sdl2_backend's event_arena (trait path) or the local
            // `legacy_drained` Vec (fallback path), both of which
            // outlive `event_ptrs`.
            let mut trait_events_buf: Vec<worker::runtime::window_backend::BackendEvent> =
                Vec::new();
            let mut legacy_drained: Vec<SDL_Event> = Vec::new();
            let used_trait = {
                if let (Some(_handle), Some(selected)) =
                    (runtime_handle.as_ref(), selected_runtime_backend.as_mut())
                {
                    selected.backend.pump_events(&mut trait_events_buf);
                    true
                } else {
                    false
                }
            };
            // ULTRAPLAN Lightning Phase 10g.5 — event_ptrs is now
            // typed as `*mut c_void` rather than `*mut SDL_Event`.
            // The pointer content is unchanged (it still points at
            // an SDL_Event for the SDL2 backend, and at GLFW /
            // raylib / SFML event data for those backends when the
            // runner is eventually paired with library-specific
            // user modules via Phase 10g.5 prompt changes). User
            // modules cast the `void*` to their library's event
            // type based on which library they were compiled
            // against — the same contract every library-agnostic
            // HMR runtime uses. SDL2 modules stay backward-compat
            // because `void core_on_event(void* state, void* evt)`
            // already takes a void*; only the Rust-side Symbol
            // type changed.
            let event_ptrs: Vec<*mut c_void> = if used_trait {
                use worker::runtime::window_backend::BackendEvent;
                trait_events_buf
                    .iter()
                    .filter_map(|ev| match ev {
                        BackendEvent::Raw { payload, .. } => Some(*payload as *mut c_void),
                        // Quit and Resized don't carry a Raw pointer;
                        // they're handled elsewhere by the runner
                        // (Quit → core state mutation via the Raw
                        // counterpart that SDL2Backend double-emits
                        // for SDL_QUIT).
                        _ => None,
                    })
                    .collect()
            } else {
                unsafe {
                    loop {
                        let mut event: SDL_Event = std::mem::zeroed();
                        if SDL_PollEvent(&mut event) == 0 {
                            break;
                        }
                        legacy_drained.push(event);
                    }
                }
                legacy_drained
                    .iter()
                    .map(|e| e as *const SDL_Event as *mut c_void)
                    .collect()
            };

            for &event_ptr in &event_ptrs {
                unsafe {
                    // SPLIT MODE: Events go to core module with core's state.
                    // Core handles button clicks, key presses, etc. that affect app state.
                    // GUI module can also receive events for hover/focus handling.
                    // Pass the opaque event pointer to every loaded module that
                    // exports on_event. The module casts to its library's
                    // event type (SDL_Event for SDL2 projects, GLFW event
                    // payload for GLFW projects, etc.) — the runner stays
                    // library-agnostic (Phase 10g.5).
                    for (name, lib) in modules.iter() {
                        let event_func: Result<
                            Symbol<unsafe extern "C" fn(*mut c_void, *mut c_void)>,
                            _,
                        > = lib.get(b"on_event");
                        if let Ok(f) = event_func {
                            // CRITICAL FIX: In split mode, both core and GUI should receive
                            // core's state for events. Core handles state changes (pause, quit),
                            // and if GUI has on_event it should also see core's state.
                            let state_ptr =
                                if modules.contains_key("core") && !app_state.raw.is_null() {
                                    // Split mode: use core's state for all event handlers
                                    app_state.raw
                                } else if name == "gui" {
                                    // GUI-only mode: use GUI's own state
                                    module_states
                                        .get(name)
                                        .map(|s| s.state_ptr)
                                        .unwrap_or(app_state.raw)
                                } else {
                                    app_state.raw
                                };

                            // BUG FIX: Wrap on_event in crash protection, same as on_update.
                            // Previously this was a bare call — if user_event() crashed
                            // (SIGSEGV, etc.), the entire runner process died without recovery,
                            // causing the GUI app to "disappear" on click.
                            #[cfg(unix)]
                            {
                                let module_name = name.clone();
                                if let Some(lib_path) = loaded_paths.get(name) {
                                    set_current_lib_path(lib_path);
                                }
                                let state_ptr_wrapper = SendVoidPtr(state_ptr as usize);
                                // Phase 10g.3b: `event` is now a `&mut SDL_Event`
                                // re-borrowed from an event pointer yielded by
                                // pump_events / legacy drain, so the cast is
                                // event_ptr (already *mut SDL_Event). We wrap
                                // the raw pointer directly, skipping the
                                // &mut → ptr re-cast the old stack-local path
                                // used to do.
                                let event_ptr_wrapper = SendVoidPtr(event_ptr as usize);
                                let func_ptr = *f;
                                let result = execute_with_protection(&module_name, move || {
                                    let sp = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                                    // Phase 10g.5 — opaque void* so the
                                    // same dispatch path works for any
                                    // backend's event payload. Module
                                    // casts based on its own #include.
                                    let ep = event_ptr_wrapper.0 as *mut std::ffi::c_void;
                                    func_ptr(sp, ep);
                                });
                                if let Err(crash_info) = result {
                                    eprintln!("{}", generate_crash_report(&crash_info));
                                    let status = HmrCrashStatus::from_crash(&crash_info, true);
                                    debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                                    eprintln!(
                                        "[Runner] on_event crash in module '{}' — continuing",
                                        name
                                    );
                                    // Don't kill the runner; skip this module's event and continue
                                }
                            }
                            #[cfg(not(unix))]
                            {
                                f(state_ptr, &mut event);
                            }
                        }
                    }
                }
            }
        }

        if last_log.elapsed() > Duration::from_secs(5) {
            // Keep stdout clean for raw frame bytes; log diagnostics to stderr instead.
            debug_log!(
                "[Runner] Heartbeat. Modules: {}, FPS: {:.2}",
                modules.len(),
                1.0 / last_frame.elapsed().as_secs_f64().max(0.001)
            );
            last_log = Instant::now();
        }

        // Process all pending commands
        loop {
            #[cfg(feature = "gpu-hmr")]
            let gpu_reload_inflight_count = gpu_reload_inflight.len();
            #[cfg(not(feature = "gpu-hmr"))]
            let gpu_reload_inflight_count = 0usize;

            let cmd = if gpu_reload_inflight_count == 0 {
                if let Some(cmd) = deferred_commands.pop_front() {
                    cmd
                } else {
                    let Ok(cmd_wrapper) = rx.try_recv() else {
                        break;
                    };
                    runner_command_to_text(cmd_wrapper)
                }
            } else if let Some(index) = deferred_commands.iter().position(|cmd| {
                runner_command_name(cmd)
                    .map(|name| should_process_runner_command(name, gpu_reload_inflight_count))
                    .unwrap_or(false)
            }) {
                deferred_commands.remove(index).unwrap_or_default()
            } else {
                let mut selected = None;
                while let Ok(cmd_wrapper) = rx.try_recv() {
                    let cmd = runner_command_to_text(cmd_wrapper);
                    let Some(name) = runner_command_name(&cmd) else {
                        continue;
                    };
                    if should_process_runner_command(name, gpu_reload_inflight_count) {
                        selected = Some(cmd);
                        break;
                    }
                    deferred_commands.push_back(cmd);
                }
                let Some(cmd) = selected else {
                    break;
                };
                cmd
            };

            if cmd.is_empty() {
                continue;
            }

            // Route command logs to stderr so stdout stays dedicated to the video stream.
            debug_log!("[Runner] Processing command: {}", cmd);
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }

            if !should_process_runner_command(parts[0], gpu_reload_inflight_count) {
                deferred_commands.push_back(cmd);
                break;
            }

            match parts[0] {
                "handshake_v2" => {
                    #[cfg(feature = "gpu-hmr")]
                    {
                        let valid = parts.len() == 5
                            && !parts[1].is_empty()
                            && parts[1].len() <= 128
                            && parts[1]
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                            && parts[2].parse::<u32>().ok()
                                == Some(RUNNER_PROTOCOL_CURRENT_VERSION)
                            && parts[3].parse::<u32>().ok()
                                == Some(RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION)
                            && parts[4] == GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY;
                        if !valid {
                            eprintln!(
                                "[Runner] [GPU HMR] Refusing malformed strict GPU protocol handshake"
                            );
                            continue;
                        }
                        match RunnerProtocolAck::current(parts[1]).line() {
                            Ok(line) => eprintln!("{line}"),
                            Err(error) => eprintln!(
                                "[Runner] [GPU HMR] Failed to serialize protocol acknowledgement: {error}"
                            ),
                        }
                    }

                    #[cfg(not(feature = "gpu-hmr"))]
                    {
                        eprintln!(
                            "[Runner] [GPU HMR] Strict GPU protocol unavailable without gpu-hmr"
                        );
                    }
                }
                // ============================================================
                // SET_SESSION COMMAND - Must be called before loading Host KV modules
                // ============================================================
                "set_session" => {
                    if parts.len() >= 2 {
                        let new_session = parts[1].to_string();

                        // Reject session change if already set (prevent silent keyspace switch)
                        if let Some(ref existing) = session_id {
                            if existing != &new_session {
                                eprintln!("[Runner] [HOST-KV] ERROR: Cannot change session_id mid-run (current: {}, requested: {})", existing, new_session);
                                continue;
                            }
                            // Same session, no-op
                            debug_log!("[Runner] [HOST-KV] Session already set: {}", new_session);
                            continue;
                        }

                        // Set the session
                        session_id = Some(new_session.clone());
                        session_id_cstring = CString::new(new_session.clone()).ok();

                        debug_log!("[Runner] [HOST-KV] Session set: {}", new_session);

                        // Emit status event
                        let status = HmrStatus::host_kv_ready(&new_session, "pending");
                        debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                    } else {
                        debug_log!(
                            "[Runner] [HOST-KV] ERROR: set_session requires session_id argument"
                        );
                    }
                }

                "input" => {
                    #[cfg(target_os = "linux")]
                    if parts.len() >= 2 {
                        // XTest fake_input for mouse; SDL_PushEvent for keyboard.
                        //
                        // XTest with grab_control(impervious=true) bypasses
                        // window-manager passive grabs entirely. This fixes the
                        // issue where matchbox-WM intercepted xdotool button
                        // events, causing the user's X11 app to redraw incorrectly
                        // (text/components disappearing on click).
                        //
                        // XTest also eliminates per-event process spawning (~5-10ms
                        // xdotool overhead) and race conditions between concurrent
                        // xdotool processes.
                        //
                        // XTest event types:
                        //   2 = KeyPress, 3 = KeyRelease
                        //   4 = ButtonPress, 5 = ButtonRelease
                        //   6 = MotionNotify
                        match parts[1] {
                            "motion" => {
                                if parts.len() >= 4 {
                                    // Rate-limit motion to ~60fps
                                    let now = Instant::now();
                                    if now.duration_since(last_motion_time).as_millis() >= 16 {
                                        last_motion_time = now;
                                        let x = parts[2].parse::<i16>().unwrap_or(0);
                                        let y = parts[3].parse::<i16>().unwrap_or(0);
                                        if xtest_ready {
                                            if let Some(ref conn) = x11_conn {
                                                // MotionNotify: detail=0, root_x/root_y = target position, deviceid=0 (server default)
                                                let _ = conn
                                                    .xtest_fake_input(6, 0, 0, x11_root, x, y, 0);
                                                let _ = conn.flush();
                                            }
                                        }
                                    }
                                }
                            }
                            "button" => {
                                if parts.len() >= 6 {
                                    let type_str = parts[2];
                                    let btn: u8 = parts[3].parse().unwrap_or(1);
                                    let x = parts[4].parse::<i16>().unwrap_or(0);
                                    let y = parts[5].parse::<i16>().unwrap_or(0);

                                    if xtest_ready {
                                        if let Some(ref conn) = x11_conn {
                                            // Warp pointer to click position first,
                                            // then send button event (which fires at
                                            // the current pointer position).
                                            let _ =
                                                conn.xtest_fake_input(6, 0, 0, x11_root, x, y, 0);
                                            let event_type: u8 =
                                                if type_str == "down" { 4 } else { 5 };
                                            let _ = conn.xtest_fake_input(
                                                event_type, btn, 0, x11_root, 0, 0, 0,
                                            );
                                            let _ = conn.flush();
                                        }
                                    }
                                }
                            }
                            "key" => {
                                if parts.len() >= 4 {
                                    let type_str = parts[2];
                                    let keycode = parts[3].parse::<i32>().unwrap_or(0);

                                    // Path 1 — SDL apps. SDL_PushEvent drops a synthetic
                                    // event into SDL's queue keyed on the SDL keycode.
                                    // SDL keycodes differ from X11 keysyms (especially for
                                    // special keys with the 0x40000000 high bit), so we
                                    // can't reuse one value for both pipelines.
                                    unsafe {
                                        let event_type = if type_str == "down" {
                                            SDL_KEYDOWN
                                        } else {
                                            SDL_KEYUP
                                        };

                                        let mut event: SDL_Event = std::mem::zeroed();
                                        let event_ptr = event.data.as_mut_ptr();
                                        *(event_ptr as *mut u32) = event_type;
                                        *(event_ptr.add(4) as *mut u32) = 0; // timestamp
                                        *(event_ptr.add(8) as *mut u32) = sdl_window_id; // windowID
                                        *(event_ptr.add(12) as *mut u8) =
                                            if type_str == "down" { 1 } else { 0 };
                                        *(event_ptr.add(13) as *mut u8) = 0; // repeat
                                        *(event_ptr.add(16) as *mut u32) = keycode as u32; // scancode
                                        *(event_ptr.add(20) as *mut i32) = keycode; // sym
                                        *(event_ptr.add(24) as *mut u16) = 0; // mod

                                        SDL_PushEvent(&mut event);
                                    }

                                    // Path 2 — raw-Xlib apps. Inject a real X11
                                    // KeyPress / KeyRelease through XTest so apps
                                    // that read via `XNextEvent` (and selected
                                    // `KeyPressMask` on their window) see it.
                                    // Optional 5th token in the stdin protocol
                                    // carries the X11 keysym from main.rs's
                                    // `js_key_to_x11_keysym`. Backward-compatible:
                                    // older callers omit the field, in which case
                                    // only SDL gets the event (today's behaviour).
                                    if parts.len() >= 5
                                        && xtest_ready
                                        && !keysym_to_keycode.is_empty()
                                    {
                                        let keysym = parts[4].parse::<u32>().unwrap_or(0);
                                        if keysym != 0 {
                                            if let Some(&xkc) = keysym_to_keycode.get(&keysym) {
                                                if let Some(ref conn) = x11_conn {
                                                    // XTest event types: 2 = KeyPress, 3 = KeyRelease.
                                                    let event_type: u8 =
                                                        if type_str == "down" { 2 } else { 3 };
                                                    let _ = conn.xtest_fake_input(
                                                        event_type, xkc, 0, x11_root, 0, 0, 0,
                                                    );
                                                    let _ = conn.flush();
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {
                                debug_log!("[Runner] Unknown input type: {}", parts[1]);
                            }
                        }
                    }
                }
                "synthi_pause_runtime" | "pause_runtime" => {
                    let control_token = parts.get(1).copied();
                    if !runtime_paused {
                        runtime_paused = true;
                        eprintln!("[Runner] Runtime update/render paused for external HMR work");
                    }
                    #[cfg(feature = "gpu-hmr")]
                    let gpu_reload_inflight_count = gpu_reload_inflight.len();
                    #[cfg(not(feature = "gpu-hmr"))]
                    let gpu_reload_inflight_count = 0;
                    emit_runtime_control_status(
                        "runtime-paused",
                        control_token,
                        runtime_paused,
                        gpu_reload_inflight_count,
                    );
                }
                "synthi_resume_runtime" | "resume_runtime" => {
                    let control_token = parts.get(1).copied();
                    if runtime_paused {
                        runtime_paused = false;
                        eprintln!("[Runner] Runtime update/render resumed");
                    }
                    #[cfg(feature = "gpu-hmr")]
                    let gpu_reload_inflight_count = gpu_reload_inflight.len();
                    #[cfg(not(feature = "gpu-hmr"))]
                    let gpu_reload_inflight_count = 0;
                    emit_runtime_control_status(
                        "runtime-resumed",
                        control_token,
                        runtime_paused,
                        gpu_reload_inflight_count,
                    );
                }
                "load" => {
                    // usage: load <name> <path>
                    // fallback: load <path> -> name="main"
                    let (name, path) = if parts.len() >= 3 {
                        (parts[1], parts[2])
                    } else if parts.len() == 2 {
                        ("main", parts[1])
                    } else {
                        eprintln!("[Runner] Invalid load command format");
                        continue;
                    };

                    debug_log!("[Runner] Loading module '{}' from {}", name, path);

                    if let Some(current_path) = loaded_paths.get(name) {
                        if current_path == path {
                            debug_log!(
                                "[Runner] Module '{}' already loaded from {}. Skipping.",
                                name,
                                path
                            );
                            continue;
                        }
                    }

                    unsafe {
                        runner_logic::process_load_command(
                            name,
                            path,
                            &mut modules,
                            &mut loaded_paths,
                            &mut module_states,
                            &mut app_state,
                            &mut module_loader,
                            &mut orchestrator,
                            &session_id,
                            &session_id_cstring,
                            &kv_api,
                            loader_enabled,
                        );
                    }
                    // Skip render for 1 frame to let on_load initialize state
                    // before on_render uses it — prevents flicker
                    skip_render_frames = 1;
                }
                "load_device" | "load_device_partial" | "gpu_reload_v2" => {
                    #[cfg(feature = "gpu-hmr")]
                    {
                        let parsed = match parse_gpu_reload_command(&parts) {
                            Ok(parsed) => parsed,
                            Err(error) => {
                                eprintln!(
                                    "[Runner] [GPU HMR] Refusing invalid GPU reload command: {error}"
                                );
                                continue;
                            }
                        };
                        let partial_device_load = parsed.partial;
                        let vendor_raw = parsed.vendor.as_str();
                        let artifact_path = parsed.artifact_path.as_str();
                        let kernels = parsed.kernels;
                        let abi_version = parsed.abi_version;
                        let capsule_metadata = parsed.capsule_metadata;
                        let source_paths = gpu_reload_source_paths(capsule_metadata.as_ref());
                        let terminal_request_id = parsed.request_id.clone();
                        let terminal_source_edit_id = parsed.source_edit_id.clone();
                        let source_edit_id = parsed.source_edit_id;
                        let reload_id = parsed.request_id.unwrap_or_else(|| {
                            format!("runner-device-{}-{}", vendor_raw, frame_count)
                        });

                        let (language, vendor) = match vendor_raw {
                            "cuda" => ("cuda", GpuVendor::Cuda),
                            "rocm" | "hip" => ("rocm", GpuVendor::Rocm),
                            other => {
                                eprintln!("[Runner] [GPU HMR] Unknown device vendor '{}'", other);
                                continue;
                            }
                        };

                        let artifact_blob = gpu_reload_artifact_blob_from_path(artifact_path);
                        let artifact_hash = artifact_blob
                            .as_ref()
                            .map(|blob| blob.content_hash.clone())
                            .or_else(|| {
                                std::fs::metadata(artifact_path)
                                    .map(|m| m.len().to_string())
                                    .ok()
                            })
                            .unwrap_or_else(|| "unknown".to_string());
                        let mut capabilities = vec![
                            GPU_SIDECAR_MODULE_CAPABILITY.to_string(),
                            "synthi_gpu_launch".to_string(),
                        ];
                        if partial_device_load {
                            capabilities.push(GPU_SIDECAR_PARTIAL_MODULE_CAPABILITY.to_string());
                        }
                        let mut manifest = BuildManifest::for_language(
                            session_id
                                .clone()
                                .unwrap_or_else(|| "runner-gpu".to_string()),
                            language,
                        )
                        .with_slot(BuildSlot::Custom("device".into()))
                        .with_artifact(artifact_path, &artifact_hash)
                        .with_abi_version(&abi_version)
                        .with_state_schema_hash(&artifact_hash)
                        .with_exported_symbols(kernels.clone())
                        .with_capabilities(capabilities)
                        .with_snapshot_modes(vec![SnapshotMode::Binary]);
                        if !source_paths.is_empty() {
                            manifest.translation_units = Some(source_paths.clone());
                            manifest.dirty_units = Some(source_paths.clone());
                        }

                        let firewall_process_id_before = std::process::id();
                        let firewall_process_id_after = std::process::id();
                        let req = AdapterReloadRequest {
                            reload_id,
                            source_edit_id,
                            module_id: "device".into(),
                            changed_files: source_paths,
                            build_manifest: manifest,
                            artifact_blob,
                            capsule_metadata,
                            firewall_evidence:
                                ReloadFirewallEvidence::from_gpu_device_sidecar_boundary(
                                    "runner_bin:device_sidecar_reload",
                                    firewall_process_id_before,
                                    firewall_process_id_after,
                                ),
                            preserve_state: true,
                            timeout_ms: 5000,
                        };
                        let artifact_loader_transport =
                            match gpu_artifact_loader_transport_from_env_for_reload(
                                req.artifact_blob.as_ref(),
                            ) {
                                Ok(transport) => transport,
                                Err(error) => {
                                    eprintln!(
                                        "[Runner] [GPU HMR] Device sidecar reload refused before adapter creation: {error}"
                                    );
                                    if let (Some(request_id), Some(source_edit_id)) = (
                                        terminal_request_id.as_deref(),
                                        terminal_source_edit_id.as_deref(),
                                    ) {
                                        if let Ok(status) = GpuReloadV2Result::rejected(
                                            request_id,
                                            source_edit_id,
                                            &error,
                                        )
                                        .and_then(|result| result.to_json())
                                        {
                                            eprintln!("[Runner] [HMR-STATUS] {status}");
                                        }
                                    } else {
                                        let status = HmrStatus::rejected_with_fallback(
                                            "device",
                                            &error,
                                            "Correct the GPU artifact loader transport or use a cold reload",
                                        );
                                        eprintln!(
                                            "[Runner] [HMR-STATUS] {}",
                                            status.to_json()
                                        );
                                    }
                                    continue;
                                }
                            };

                        if gpu_reload_inflight.contains_key(language) {
                            eprintln!(
                                "[Runner] [GPU HMR] Device sidecar reload skipped vendor={} artifact={} kernels={} reason=reload-in-flight",
                                language,
                                artifact_path,
                                kernels.join(",")
                            );
                            if let (Some(request_id), Some(source_edit_id)) = (
                                terminal_request_id.as_deref(),
                                terminal_source_edit_id.as_deref(),
                            ) {
                                if let Ok(status) = GpuReloadV2Result::rejected(
                                    request_id,
                                    source_edit_id,
                                    "GPU sidecar reload already in flight",
                                )
                                .and_then(|result| result.to_json())
                                {
                                    eprintln!("[Runner] [HMR-STATUS] {status}");
                                }
                            } else {
                                let status = HmrStatus::rejected_with_fallback(
                                    "device",
                                    "GPU sidecar reload already in flight",
                                    "Wait for active GPU sidecar reload or restart runner",
                                );
                                eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                            }
                            continue;
                        }

                        let mut adapter = gpu_adapters.remove(language).unwrap_or_else(|| {
                            let mut adapter = GpuModuleAdapter::new(GpuModuleAdapterConfig {
                                vendor,
                                artifact_loader_transport,
                                ..Default::default()
                            });
                            if let Err(e) = adapter.initialize() {
                                eprintln!(
                                    "[Runner] [GPU HMR] Device adapter init failed vendor={}: {}",
                                    language, e
                                );
                            }
                            adapter
                        });

                        let completion_tx = gpu_reload_tx.clone();
                        let language_owned = language.to_string();
                        let artifact_path_owned = artifact_path.to_string();
                        let kernels_log = kernels.join(",");
                        gpu_reload_inflight.insert(language_owned.clone(), Instant::now());
                        eprintln!(
                            "[Runner] [GPU HMR] Device sidecar reload started vendor={} artifact={} kernels={} partial={}",
                            language_owned,
                            artifact_path_owned,
                            kernels_log,
                            partial_device_load
                        );
                        if let Err(error) = adapter.capture_current_context_for_reload() {
                            eprintln!(
                                "[Runner] [GPU HMR] Device context capture failed vendor={}: {}",
                                language, error
                            );
                        }

                        if partial_device_load {
                            let result = adapter.reload(&req);
                            let completion = GpuReloadCompletion {
                                language: language_owned,
                                artifact_path: artifact_path_owned,
                                kernels: kernels_log,
                                request_id: terminal_request_id,
                                source_edit_id: terminal_source_edit_id,
                                adapter,
                                result,
                            };
                            emit_gpu_reload_completion(&completion);
                            let GpuReloadCompletion {
                                language, adapter, ..
                            } = completion;
                            gpu_reload_inflight.remove(&language);
                            gpu_adapters.insert(language, adapter);
                            continue;
                        }

                        thread::spawn(move || {
                            let result = adapter.reload(&req);
                            let _ = completion_tx.send(GpuReloadCompletion {
                                language: language_owned,
                                artifact_path: artifact_path_owned,
                                kernels: kernels_log,
                                request_id: terminal_request_id,
                                source_edit_id: terminal_source_edit_id,
                                adapter,
                                result,
                            });
                        });
                    }

                    #[cfg(not(feature = "gpu-hmr"))]
                    {
                        eprintln!(
                            "[Runner] [GPU HMR] load_device ignored; runner built without gpu-hmr"
                        );
                    }
                }
                "unload" => {
                    if parts.len() == 2 {
                        let name = parts[1];
                        debug_log!("[Runner] Unloading module '{}'", name);
                        if let Some(lib) = modules.remove(name) {
                            loaded_paths.remove(name);
                            // Get module's own state for unload
                            let module_state_ptr = module_states
                                .get(name)
                                .map(|s| s.state_ptr)
                                .unwrap_or(std::ptr::null_mut());
                            module_states.remove(name);
                            unsafe {
                                // Prefer ABI-prefixed unload symbols, fall back to legacy.
                                let func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                                    if name == "core" {
                                        lib.get(b"core_on_unload")
                                            .or_else(|_| lib.get(b"on_unload"))
                                    } else if name == "gui" {
                                        lib.get(b"gui_on_unload").or_else(|_| lib.get(b"on_unload"))
                                    } else {
                                        lib.get(b"on_unload")
                                    };
                                if let Ok(f) = func {
                                    f(module_state_ptr);
                                }
                            }
                            debug_log!("[Runner] Unloaded module {}", name);
                        }
                    }
                }
                "quit" => {
                    debug_log!("[Runner] Quitting.");
                    // ULTRAPLAN Lightning Phase 10g.3c — route
                    // shutdown through the WindowBackend trait when
                    // the trait path was taken (runtime_handle is
                    // Some). Calls destroy_window with the stored
                    // handle, then shutdown to release any dlopen'd
                    // library (critical for GLFW/raylib/SFML future
                    // wiring; a no-op for SDL2 since sdl_defs.rs
                    // static-links libSDL2).
                    //
                    // Fallback path (no runtime_handle) still calls
                    // SDL_Quit directly, preserving pre-10g.2
                    // behavior for BYOR / sidecar-less runs.
                    #[cfg(target_os = "linux")]
                    {
                        let handled_via_trait = if let (Some(handle), Some(selected)) =
                            (runtime_handle.take(), selected_runtime_backend.as_mut())
                        {
                            selected.backend.destroy_window(handle);
                            selected.backend.shutdown();
                            true
                        } else {
                            false
                        };
                        if !handled_via_trait {
                            unsafe {
                                SDL_Quit();
                            }
                        }
                    }
                    return;
                }
                _ => {}
            }
        }

        // Calculate delta time
        let now = Instant::now();
        let dt = now.duration_since(last_frame).as_secs_f64();
        last_frame = now;

        // NOTE: Do NOT clear screen here - let the user's gui_render handle it.
        // Clearing here and in gui_render can cause timing issues.

        // Run update loop for all loaded modules
        // INDEPENDENT SWAP: Each module gets called with its own state pointer.
        // - "core" and "main" use app_state.raw (backward compatible)
        // - "gui" uses its own module_states["gui"].state_ptr
        // Deterministic order: "core" first, then others sorted alphabetically
        let mut keys: Vec<String> = modules.keys().cloned().collect();
        keys.sort_by(|a, b| {
            if a == "core" {
                std::cmp::Ordering::Less
            } else if b == "core" {
                std::cmp::Ordering::Greater
            } else {
                a.cmp(b)
            }
        });

        if !runtime_execution_paused {
            for name in &keys {
                if let Some(lib) = modules.get(name) {
                    unsafe {
                        // Try new symbol names first, then legacy
                        let update_func: Option<Symbol<unsafe extern "C" fn(*mut c_void, f64)>> =
                            if name == "core" {
                                lib.get(b"core_on_update")
                                    .ok()
                                    .or_else(|| lib.get(b"on_update").ok())
                            } else if name == "gui" {
                                // GUI doesn't have on_update in new ABI (only on_render)
                                lib.get(b"gui_on_update")
                                    .ok()
                                    .or_else(|| lib.get(b"on_update").ok())
                            } else {
                                lib.get(b"on_update").ok()
                            };

                        if let Some(f) = update_func {
                            // INDEPENDENT SWAP: Use module-specific state for GUI
                            let state_ptr = if name == "gui" {
                                module_states
                                    .get(name)
                                    .map(|s| s.state_ptr)
                                    .unwrap_or(app_state.raw)
                            } else {
                                // For core/main, use shared app_state.raw
                                app_state.raw
                            };

                            // Execute with crash protection on Linux
                            #[cfg(unix)]
                            {
                                let module_name = name.clone();
                                // Set current library path for source map lookup on crash
                                if let Some(lib_path) = loaded_paths.get(name) {
                                    set_current_lib_path(lib_path);
                                }

                                // Enter crash supervisor context for this module
                                if supervisor_enabled {
                                    let slot =
                                        ModuleSlot::from_str(name).unwrap_or(ModuleSlot::Main);
                                    crash_supervisor.enter_context(slot);
                                }

                                let state_ptr_wrapper = SendVoidPtr(state_ptr as usize);
                                let func_ptr = *f;
                                let result = execute_with_protection(&module_name, move || {
                                    let state_ptr = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                                    func_ptr(state_ptr, dt);
                                });

                                // Exit crash supervisor context
                                if supervisor_enabled {
                                    crash_supervisor.exit_context();
                                }

                                if let Err(crash_info) = result {
                                    // Crash recovered! Log and continue with old module
                                    eprintln!("{}", generate_crash_report(&crash_info));

                                    // Use CrashSupervisor to determine recovery action
                                    let recovery_action = if supervisor_enabled {
                                        crash_supervisor.report_crash(&crash_info)
                                    } else {
                                        RecoveryAction::HotReload
                                    };

                                    // Check if supervisor thinks we should restart
                                    // (too many consecutive crashes without recovery).
                                    // NOTE: We intentionally do NOT treat SIGSEGV as
                                    // unconditionally fatal because our thread-based
                                    // crash protection isolates the crash to the plugin
                                    // thread.  The runner's own heap and SDL state are
                                    // safe since the faulting thread is terminated via
                                    // pthread_exit and never touches shared state again.
                                    let force_restart = recovery_action
                                        == RecoveryAction::FullRestart
                                        || recovery_action == RecoveryAction::Fatal
                                        || (supervisor_enabled
                                            && crash_supervisor.should_force_restart());

                                    let status =
                                        HmrCrashStatus::from_crash(&crash_info, !force_restart);
                                    debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                                    debug_log!("[Runner] Recovery action: {:?}", recovery_action);

                                    if force_restart {
                                        eprintln!("[Runner] Too many consecutive crashes (action={:?}). Exiting for cold restart.", recovery_action);
                                        std::process::exit(1);
                                    }

                                    // On successful hot reload, reset crash count
                                    if recovery_action == RecoveryAction::HotReload
                                        && supervisor_enabled
                                    {
                                        // Don't reset here - reset after successful reload
                                    }

                                    // Skip this module for now, continue with others
                                    continue;
                                }

                                // Successful execution - reset crash count if supervisor enabled
                                // Note: We only reset on successful frame completion, not per-module
                            }

                            #[cfg(not(unix))]
                            {
                                f(state_ptr, dt);
                            }
                        }
                    }
                }
            }
        }

        // Render pass:
        // SPLIT MODE: GUI renders core's state (app_state.raw) since core owns the
        // application data (x, y, dx, paused, etc.). GUI only handles presentation.
        // The GUI's own state (module_states["gui"]) is for GUI-specific data like
        // cached textures, hover states, etc. - but core state drives the rendering.
        //
        // For non-split mode (main): Call main's on_render/gui_render.

        // Check if GUI module has an independent on_render
        // BUG FIX: Wrap all on_render calls in crash protection. Previously
        // a click that corrupted module state would cause an unprotected
        // on_render to SIGSEGV, killing the runner process ("app disappears
        // when user clicks a button").
        //
        // Flicker prevention: after a module load, skip rendering for one
        // frame so on_load has time to initialize state.  The previous
        // frame stays visible on the X11 framebuffer (ximagesrc captures it).
        if runtime_execution_paused {
            // Keep presenting/capturing the last completed frame while
            // compile work happens outside the runner process.
        } else if skip_render_frames > 0 {
            skip_render_frames -= 1;
        } else if let Some(lib) = modules.get("gui") {
            unsafe {
                // Try new symbol first, then legacy
                let render_func: Option<Symbol<unsafe extern "C" fn(*mut c_void)>> = lib
                    .get(b"gui_on_render")
                    .ok()
                    .or_else(|| lib.get(b"on_render").ok())
                    .or_else(|| lib.get(b"gui_render").ok());

                // CRITICAL FIX: In split mode (core+gui), GUI must render core's state
                // because core owns application data (x, y, dx, paused, etc.).
                // Only fall back to GUI's own state if core is not loaded.
                let render_state = if modules.contains_key("core") && !app_state.raw.is_null() {
                    app_state.raw
                } else {
                    module_states
                        .get("gui")
                        .map(|s| s.state_ptr)
                        .unwrap_or(app_state.raw)
                };

                if let Some(f) = render_func {
                    #[cfg(unix)]
                    {
                        if let Some(lib_path) = loaded_paths.get("gui") {
                            set_current_lib_path(lib_path);
                        }
                        let func_ptr = *f;
                        // SDL and most native render backends require render calls
                        // on the thread that owns the window/renderer. The generic
                        // crash guard runs plugin code on a helper thread, which can
                        // leave split GUI modules producing black frames without a
                        // crash. Keep GUI rendering on the runner loop thread.
                        func_ptr(render_state);
                    }
                    #[cfg(not(unix))]
                    {
                        f(render_state);
                    }
                }
            }
        } else if let Some(lib) = modules.get("core") {
            unsafe {
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"on_render");
                if let Ok(f) = render_func {
                    #[cfg(unix)]
                    {
                        if let Some(lib_path) = loaded_paths.get("core") {
                            set_current_lib_path(lib_path);
                        }
                        let state_ptr_wrapper = SendVoidPtr(app_state.raw as usize);
                        let func_ptr = *f;
                        let result = execute_with_protection("core_render", move || {
                            let sp = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                            func_ptr(sp);
                        });
                        if let Err(crash_info) = result {
                            eprintln!("{}", generate_crash_report(&crash_info));
                            let status = HmrCrashStatus::from_crash(&crash_info, true);
                            debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                            eprintln!("[Runner] on_render crash in module 'core' — continuing");
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        f(app_state.raw);
                    }
                }
            }
        } else if let Some(lib) = modules.get("main") {
            unsafe {
                let render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"on_render");
                let gui_render_func: Result<Symbol<unsafe extern "C" fn(*mut c_void)>, _> =
                    lib.get(b"gui_render");

                let func_to_call: Option<Symbol<unsafe extern "C" fn(*mut c_void)>> =
                    if let Ok(f) = render_func {
                        Some(f)
                    } else if let Ok(f) = gui_render_func {
                        Some(f)
                    } else {
                        None
                    };

                if let Some(f) = func_to_call {
                    #[cfg(unix)]
                    {
                        if let Some(lib_path) = loaded_paths.get("main") {
                            set_current_lib_path(lib_path);
                        }
                        let state_ptr_wrapper = SendVoidPtr(app_state.raw as usize);
                        let func_ptr = *f;
                        let result = execute_with_protection("main_render", move || {
                            let sp = state_ptr_wrapper.0 as *mut std::ffi::c_void;
                            func_ptr(sp);
                        });
                        if let Err(crash_info) = result {
                            eprintln!("{}", generate_crash_report(&crash_info));
                            let status = HmrCrashStatus::from_crash(&crash_info, true);
                            debug_log!("[Runner] [HMR-STATUS] {}", status.to_json());
                            eprintln!("[Runner] on_render crash in module 'main' — continuing");
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        f(app_state.raw);
                    }
                }
            }
        }

        // Present the SDL renderer BEFORE capturing from Xvfb.
        // This ensures the plugin's rendering is visible in the capture.
        //
        // ULTRAPLAN Lightning Phase 10g.3a — route through the
        // WindowBackend trait when runtime_handle is Some (set by
        // 10g.2 when the selector picked SDL2). For SDL2 the trait
        // call is behaviorally identical to SDL_RenderPresent with
        // the same renderer pointer, but it exercises the trait
        // surface so future non-SDL backends can swap in without
        // touching the main loop. Falls back to direct
        // SDL_RenderPresent when no handle is held (sidecar-less
        // path or non-SDL2 selector decision).
        #[cfg(target_os = "linux")]
        {
            let mut presented_via_trait = false;
            if let (Some(handle), Some(selected)) =
                (runtime_handle.as_ref(), selected_runtime_backend.as_mut())
            {
                if let Err(e) = selected.backend.present_frame(handle) {
                    eprintln!(
                        "[Phase 10g.3a] WindowBackend present_frame failed ({}) — \
                         falling back to direct SDL_RenderPresent for this frame",
                        e
                    );
                } else {
                    presented_via_trait = true;
                }
            }
            if !presented_via_trait && !renderer.is_null() {
                unsafe {
                    SDL_RenderPresent(renderer);
                }
            }
        }

        #[cfg(target_os = "linux")]
        if let Some(ref conn) = x11_conn {
            worker::runtime::runner::capture::capture_frame(
                conn,
                x11_root,
                shm_seg,
                shm_ptr,
                &frame_tx,
                &mut frame_count,
                &mut frames_sent,
                &mut last_frame_log,
            );
        }

        // Cap at ~60 FPS
        let elapsed = now.elapsed();
        if elapsed < Duration::from_millis(16) {
            thread::sleep(Duration::from_millis(16) - elapsed);
        }
    } // end of loop
} // end of main

#[cfg(test)]
mod tests {
    use super::{
        decode_gpu_kernel_command_token, device_load_abi_version, is_runtime_execution_paused,
        runtime_control_status_payload, should_process_runner_command,
    };
    #[cfg(feature = "gpu-hmr")]
    use super::{
        gpu_artifact_loader_transport_for_reload, gpu_reload_artifact_blob_from_path,
        gpu_reload_capsule_metadata_from_token, gpu_reload_source_paths,
        parse_gpu_artifact_loader_transport,
        parse_gpu_reload_command, strict_gpu_reload_terminal_result, AdapterReloadResult,
        ArtifactLoaderTransport, ReloadArtifactBlob,
    };
    #[cfg(feature = "gpu-hmr")]
    use std::io::Write as _;
    #[cfg(feature = "gpu-hmr")]
    use worker::runtime::runner_protocol::GpuReloadV2Payload;

    #[test]
    fn device_load_abi_version_prefers_protocol_fingerprint() {
        let kernels = vec!["advance".to_string(), "init".to_string()];
        assert_eq!(
            device_load_abi_version(&kernels, Some("12345")),
            "12345".to_string()
        );
    }

    #[test]
    fn device_load_abi_version_preserves_legacy_kernel_list() {
        let kernels = vec!["advance".to_string(), "init".to_string()];
        assert_eq!(
            device_load_abi_version(&kernels, None),
            "advance|init".to_string()
        );
    }

    #[test]
    fn gpu_kernel_command_token_decodes_delimited_symbol_identity() {
        assert_eq!(
            decode_gpu_kernel_command_token("gpu%3A%3Ashade%3D_ZN3gpu5shadeEPf").as_deref(),
            Some("gpu::shade=_ZN3gpu5shadeEPf")
        );
    }

    #[test]
    fn gpu_kernel_command_token_rejects_invalid_escape() {
        assert!(decode_gpu_kernel_command_token("shade%XX").is_none());
    }

    #[test]
    fn runtime_control_status_payload_carries_token_and_pause_state() {
        let payload =
            runtime_control_status_payload("runtime-paused", Some("runner-control-3"), true, 2);
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(value["status"], "runtime-paused");
        assert_eq!(value["module"], "runner");
        assert_eq!(value["runtimeControlToken"], "runner-control-3");
        assert_eq!(value["runtimePaused"], true);
        assert_eq!(value["gpuReloadInflightCount"], 2);
    }

    #[test]
    fn runtime_control_status_payload_omits_blank_token() {
        let payload = runtime_control_status_payload("runtime-resumed", Some(""), false, 0);
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();

        assert_eq!(value["status"], "runtime-resumed");
        assert!(value.get("runtimeControlToken").is_none());
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn runtime_execution_pauses_while_gpu_reload_is_inflight() {
        assert!(is_runtime_execution_paused(false, 1));
        assert!(is_runtime_execution_paused(true, 0));
        assert!(!is_runtime_execution_paused(false, 0));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn runner_defers_module_commands_while_gpu_reload_is_inflight() {
        assert!(!should_process_runner_command("load", 1));
        assert!(!should_process_runner_command("reload", 1));
        assert!(!should_process_runner_command("load_device", 1));
        assert!(should_process_runner_command("load", 0));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn runner_allows_runtime_control_while_gpu_reload_is_inflight() {
        assert!(should_process_runner_command("synthi_pause_runtime", 1));
        assert!(should_process_runner_command("pause_runtime", 1));
        assert!(should_process_runner_command("synthi_resume_runtime", 1));
        assert!(should_process_runner_command("resume_runtime", 1));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn runner_stops_draining_commands_after_gpu_reload_starts() {
        let mut inflight_reloads = 0usize;
        let mut processed = Vec::new();

        for command in ["load_device", "load_core", "load_gui"] {
            if !should_process_runner_command(command, inflight_reloads) {
                break;
            }
            processed.push(command);
            if command == "load_device" {
                inflight_reloads += 1;
            }
        }

        assert_eq!(processed, vec!["load_device"]);
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_reload_artifact_blob_from_path_hashes_runtime_bytes() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"runtime-artifact").unwrap();
        let artifact_hash = worker::hmr::gpu_proof::sha256_hex_bytes(b"runtime-artifact");

        let blob = gpu_reload_artifact_blob_from_path(&file.path().to_string_lossy())
            .expect("runtime RAM artifact capsule");

        assert_eq!(blob.blob_id, format!("artifact:sha256:{artifact_hash}"));
        assert_eq!(blob.content_hash, format!("sha256:{artifact_hash}"));
        assert_eq!(blob.bytes, b"runtime-artifact");
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_reload_capsule_metadata_decodes_runner_protocol_token() {
        let token = worker::hmr::adapter_trait::encode_reload_capsule_metadata_token(
            &worker::hmr::adapter_trait::ReloadCapsuleMetadata {
                fission_island_id: Some("fission-island:sha256:abc".into()),
                output_oracle_profile_commitment: Some(
                    worker::hmr::adapter_trait::ReloadOutputOracleProfileCommitment {
                        schema_version: worker::hmr::adapter_trait::RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION.into(),
                        candidate_artifact_sha256: format!("sha256:{}", "a".repeat(64)),
                        fission_output_oracle_contract_sha256: format!(
                            "sha256:{}",
                            "b".repeat(64)
                        ),
                        profile_bytes_sha256: format!("sha256:{}", "c".repeat(64)),
                        edit_id: "source-edit:runner-proof".into(),
                    },
                ),
                abi_membrane_hash: Some("sha256:def".into()),
                dependency_closure_hash: Some("sha256:123".into()),
                proof_hash: Some("sha256:456".into()),
                ..Default::default()
            },
        )
        .expect("capsule token");

        let metadata =
            gpu_reload_capsule_metadata_from_token(Some(&token)).expect("runner capsule metadata");

        assert_eq!(
            metadata.fission_island_id.as_deref(),
            Some("fission-island:sha256:abc")
        );
        assert_eq!(metadata.abi_membrane_hash.as_deref(), Some("sha256:def"));
        assert_eq!(
            metadata.dependency_closure_hash.as_deref(),
            Some("sha256:123")
        );
        assert_eq!(metadata.proof_hash.as_deref(), Some("sha256:456"));
        assert!(gpu_reload_capsule_metadata_from_token(Some("-")).is_none());
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_reload_source_paths_come_only_from_verified_capsule_provenance() {
        let metadata = worker::hmr::adapter_trait::ReloadCapsuleMetadata {
            fission_source_paths: Some(vec![
                "engines/render/include/material_kernel.inc".to_string(),
                "src/scene lighting/material graph.cpp".to_string(),
            ]),
            ..Default::default()
        };

        assert_eq!(
            gpu_reload_source_paths(Some(&metadata)),
            vec![
                "engines/render/include/material_kernel.inc",
                "src/scene lighting/material graph.cpp",
            ]
        );
        assert!(gpu_reload_source_paths(None).is_empty());
        assert!(gpu_reload_source_paths(Some(&Default::default())).is_empty());
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_reload_v2_parser_preserves_independent_identity_and_typed_fields() {
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let payload = GpuReloadV2Payload::new(
            format!("gpu-reload:request:{}", "1".repeat(32)),
            "partial",
            "rocm",
            "/tmp/path with space/device.hsaco",
            vec!["gpu::shade".to_string()],
            Some("sha256:abi".to_string()),
            None,
            source_edit_id.clone(),
        )
        .unwrap();
        let encoded = payload.encode().unwrap();
        let parts = [
            "gpu_reload_v2",
            payload.request_id.as_str(),
            encoded.as_str(),
        ];
        let parsed = parse_gpu_reload_command(&parts).unwrap();
        assert_eq!(
            parsed.request_id.as_deref(),
            Some(payload.request_id.as_str())
        );
        assert!(parsed.partial);
        assert_eq!(parsed.vendor, "rocm");
        assert_eq!(parsed.artifact_path, "/tmp/path with space/device.hsaco");
        assert_eq!(parsed.kernels, vec!["gpu::shade"]);
        assert_eq!(parsed.abi_version, "sha256:abi");
        assert_eq!(
            parsed.source_edit_id.as_deref(),
            Some(source_edit_id.as_str())
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn legacy_gpu_reload_never_backfills_strict_source_identity() {
        let encoded_source = format!("source%2Dedit%3Asha256%3A{}", "a".repeat(64));
        let parts = [
            "load_device",
            "rocm",
            "/tmp/device.hsaco",
            "shade",
            "sha256:abi",
            "-",
            encoded_source.as_str(),
        ];
        let parsed = parse_gpu_reload_command(&parts).unwrap();
        assert_eq!(parsed.source_edit_id, None);
        assert_eq!(parsed.request_id, None);
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn strict_gpu_reload_terminal_requires_matching_full_runtime_proof() {
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let request_id = format!("gpu-reload:request:{}", "2".repeat(32));
        let proof_id = format!("gpu-runtime-proof:sha256:{}", "b".repeat(64));
        let evidence_refs = vec![
            format!("reload:{request_id}"),
            format!("source-edit-id:{source_edit_id}"),
        ];
        let record = serde_json::json!({
            "edit_id": source_edit_id,
            "evidence_refs": evidence_refs,
        });
        let proof_ledger = serde_json::json!({
            "gpuHmrSuccess": true,
            "records": [record],
        });
        let proof_line = serde_json::json!({
            "type": "gpu_hmr_proof",
            "resultState": "gpu-hmr-full-runtime-proven",
            "proofId": proof_id,
            "proofLedger": proof_ledger,
            "runtimeProofArtifact": {
                "proofId": proof_id,
                "resultState": "gpu-hmr-full-runtime-proven",
                "fullRuntimeProven": true,
                "gpuHmrSuccess": true,
                "limitations": [],
                "proofLedger": proof_ledger,
                "proofLedgerQuery": {
                    "gpuHmrSuccess": true,
                    "failedInvariants": [],
                },
                "explicitProofLedgerRecord": record,
                "derivedProofLedgerRecord": record,
                "acceptanceContract": { "edit_id": source_edit_id },
                "derivedAcceptanceContract": { "edit_id": source_edit_id },
                "acceptanceContractEvaluation": { "accepted": true },
                "acceptanceContractConsistency": { "accepted": true },
                "derivedAcceptanceContractEvaluation": { "accepted": true },
                "proofLedgerSourceConsistency": { "accepted": true },
            },
        })
        .to_string();
        let success = AdapterReloadResult::Success {
            reload_ms: 1,
            state_preserved: true,
        };

        let terminal = strict_gpu_reload_terminal_result(
            &request_id,
            &source_edit_id,
            &success,
            &[proof_line.clone()],
        )
        .unwrap();
        assert_eq!(terminal.status, "applied");
        assert_eq!(
            terminal.full_runtime_proof_id.as_deref(),
            Some(proof_id.as_str())
        );
        assert!(terminal.gpu_hmr_success);

        let missing =
            strict_gpu_reload_terminal_result(&request_id, &source_edit_id, &success, &[]).unwrap();
        assert_eq!(missing.status, "rejected");
        assert!(!missing.gpu_hmr_success);

        let other_source_edit_id = format!("source-edit:sha256:{}", "c".repeat(64));
        let other_request_id = format!("gpu-reload:request:{}", "3".repeat(32));
        let stale = strict_gpu_reload_terminal_result(
            &other_request_id,
            &other_source_edit_id,
            &success,
            &[proof_line],
        )
        .unwrap();
        assert_eq!(stale.status, "rejected");
        assert!(!stale.full_runtime_proof_accepted);
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_artifact_loader_transport_defaults_to_content_bound_ram() {
        for configured in [None, Some(""), Some("auto"), Some("capability_auto")] {
            assert_eq!(
                parse_gpu_artifact_loader_transport(configured),
                Ok(ArtifactLoaderTransport::RamBytes)
            );
        }
        assert_eq!(
            parse_gpu_artifact_loader_transport(Some("ram_blob")),
            Ok(ArtifactLoaderTransport::RamBytes)
        );
        let error = parse_gpu_artifact_loader_transport(Some("unknown"))
            .expect_err("unknown transport must fail closed");
        assert!(error.contains("invalid SYNTHI_GPU_HMR_ARTIFACT_LOADER_TRANSPORT"));
        assert!(error.contains("unknown"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_artifact_loader_transport_auto_prefers_runtime_ram_blob() {
        let blob = ReloadArtifactBlob {
            blob_id: "artifact:sha256:test".to_string(),
            content_hash: "sha256:test".to_string(),
            bytes: b"runtime-artifact".to_vec(),
        };

        for configured in [
            None,
            Some("auto"),
            Some("capability"),
            Some("capability_auto"),
            Some("CaPaBiLiTy_AuTo"),
        ] {
            assert_eq!(
                gpu_artifact_loader_transport_for_reload(configured, Some(&blob)),
                Ok(ArtifactLoaderTransport::RamBytes)
            );
        }
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_artifact_loader_transport_auto_never_selects_filesystem_without_blob() {
        let empty_blob = ReloadArtifactBlob {
            blob_id: "artifact:sha256:empty".to_string(),
            content_hash: "sha256:empty".to_string(),
            bytes: Vec::new(),
        };

        for configured in [
            None,
            Some(""),
            Some("   "),
            Some("auto"),
            Some("capability"),
            Some("capability_auto"),
        ] {
            assert_eq!(
                gpu_artifact_loader_transport_for_reload(configured, None),
                Ok(ArtifactLoaderTransport::RamBytes)
            );
            assert_eq!(
                gpu_artifact_loader_transport_for_reload(configured, Some(&empty_blob)),
                Ok(ArtifactLoaderTransport::RamBytes)
            );
        }
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_artifact_loader_transport_filesystem_requires_explicit_alias() {
        let blob = ReloadArtifactBlob {
            blob_id: "artifact:sha256:test".to_string(),
            content_hash: "sha256:test".to_string(),
            bytes: b"runtime-artifact".to_vec(),
        };

        for configured in [
            "filesystem",
            "filesystem_path",
            "path",
            "module_load_path",
        ] {
            assert_eq!(
                gpu_artifact_loader_transport_for_reload(Some(configured), None),
                Ok(ArtifactLoaderTransport::FilesystemPath)
            );
            assert_eq!(
                gpu_artifact_loader_transport_for_reload(Some(configured), Some(&blob)),
                Ok(ArtifactLoaderTransport::FilesystemPath)
            );
        }
        assert_eq!(
            gpu_artifact_loader_transport_for_reload(Some("module_load_data"), None),
            Ok(ArtifactLoaderTransport::RamBytes)
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_artifact_loader_transport_read_failure_stays_content_bound() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing-device-artifact");
        let missing_blob = gpu_reload_artifact_blob_from_path(&missing.to_string_lossy());
        assert!(missing_blob.is_none());
        assert_eq!(
            gpu_artifact_loader_transport_for_reload(None, missing_blob.as_ref()),
            Ok(ArtifactLoaderTransport::RamBytes)
        );

        let empty_file = tempfile::NamedTempFile::new().unwrap();
        let empty_blob = gpu_reload_artifact_blob_from_path(&empty_file.path().to_string_lossy())
            .expect("empty artifact still has a content address");
        assert!(empty_blob.bytes.is_empty());
        assert_eq!(
            gpu_artifact_loader_transport_for_reload(Some("auto"), Some(&empty_blob)),
            Ok(ArtifactLoaderTransport::RamBytes)
        );
    }
}
