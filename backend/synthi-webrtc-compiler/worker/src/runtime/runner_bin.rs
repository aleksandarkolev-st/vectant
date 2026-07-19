use libloading::{Library, Symbol};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::ffi::{c_void, CString};
use std::io::{self, Write};
use std::ptr;
use std::sync::mpsc;
#[cfg(feature = "gpu-hmr")]
use std::sync::Arc;
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
#[cfg(feature = "gpu-hmr")]
use worker::hmr::gpu_module_adapter::host_output_oracle_receipt::{
    consume_host_verified_compute_receipt, HostVerifiedComputeReadbackReceipt,
    HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY, HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
};
use worker::hmr::orchestrator as hmr_orchestrator;
use worker::infra::crash_recovery;
use worker::infra::host_kv;
use worker::runtime::capability;
#[cfg(feature = "gpu-hmr")]
use worker::runtime::gpu_runtime_boundary::runtime_session_id;
#[cfg(feature = "gpu-hmr")]
use worker::runtime::gpu_runtime_proof::{
    verify_strict_gpu_runtime_proof, StrictGpuRuntimeProofExpectation,
};
use worker::runtime::loader;
use worker::runtime::native_runner_codec::{RunnerStdoutMode, RUNNER_STDOUT_MODE_ENV};
use worker::runtime::runner_command_admission::{
    read_bounded_runner_command_line, RunnerCommandAdmission, RunnerCommandAdmissionClass,
    RunnerCommandAdmissionLease, RunnerCommandWorkBudget,
};
use worker::runtime::runner_protocol::{
    canonical_runner_runtime_control_session_id, RunnerRuntimeControlAck,
    RunnerRuntimeControlStatus, RUNNER_RUNTIME_CONTROL_SESSION_ENV,
};
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

use worker::safety::hardened_ipc::{
    decode_msgpack_limited, read_frame_validated, write_frame_with_checksum, IpcConfig,
};

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

const RUNNER_COMMAND_INGRESS_FAILURE_EXIT_CODE: i32 = 74;

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
        "synthi_pause_runtime_v2" | "synthi_resume_runtime_v2"
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

#[cfg(feature = "gpu-hmr")]
fn gpu_reload_operation_matches_epoch(cold_load: bool, active_epoch_exists: bool) -> bool {
    cold_load != active_epoch_exists
}

#[cfg(not(feature = "gpu-hmr"))]
fn should_process_runner_command(_command: &str, _gpu_reload_inflight_count: usize) -> bool {
    true
}

fn configured_runner_runtime_control_session_id(value: Option<String>) -> Result<String, String> {
    let value = value.ok_or_else(|| "runner runtime-control session is missing".to_string())?;
    if !canonical_runner_runtime_control_session_id(&value) {
        return Err("runner runtime-control session is invalid".to_string());
    }
    Ok(value)
}

fn runtime_control_status_line(
    status: RunnerRuntimeControlStatus,
    token: &str,
    runtime_paused: bool,
    gpu_reload_inflight_count: usize,
    runner_control_session_id: &str,
) -> Result<String, String> {
    RunnerRuntimeControlAck::current(
        status,
        token,
        runtime_paused,
        gpu_reload_inflight_count,
        runner_control_session_id,
    )?
    .line()
}

fn runtime_control_command_ack_line(
    parts: &[&str],
    status: RunnerRuntimeControlStatus,
    runtime_paused: bool,
    gpu_reload_inflight_count: usize,
    runner_control_session_id: &str,
) -> Result<String, String> {
    if parts.len() != 2 {
        return Err("runner runtime-control command arity is invalid".to_string());
    }
    let expected_command = match status {
        RunnerRuntimeControlStatus::Paused => "synthi_pause_runtime_v2",
        RunnerRuntimeControlStatus::Resumed => "synthi_resume_runtime_v2",
    };
    if parts[0] != expected_command {
        return Err("runner runtime-control command/status binding is invalid".to_string());
    }
    runtime_control_status_line(
        status,
        parts[1],
        runtime_paused,
        gpu_reload_inflight_count,
        runner_control_session_id,
    )
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
    decode_reload_capsule_metadata_token, normalized_reload_source_edit_id,
    reload_compute_expected_output_semantics_binding_valid,
    reload_output_oracle_proof_context_valid_for_reload, Adapter, AdapterReloadRequest,
    AdapterReloadResult, ReloadArtifactBlob, ReloadCapsuleMetadata,
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
    canonical_sha256_content_hash, GpuArtifactLoadV1Result, GpuReloadV2Result, GpuReloadV4Payload,
    GpuRuntimeProofMaterialV1, RunnerProtocolAck, GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY,
    GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY, GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY,
    GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY,
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

fn runner_command_log_summary(command: &str) -> String {
    format!(
        "bytes={} sha256=sha256:{:x}",
        command.len(),
        Sha256::digest(command.as_bytes())
    )
}

#[cfg(feature = "gpu-hmr")]
struct GpuReloadCompletion {
    language: String,
    artifact_content_hash: String,
    kernel_count: usize,
    cold_load: bool,
    request_id: Option<String>,
    source_edit_id: Option<String>,
    command_envelope_sha256: Option<String>,
    runner_challenge: Option<String>,
    adapter: GpuModuleAdapter,
    result: AdapterReloadResult,
}

#[cfg(feature = "gpu-hmr")]
fn catch_gpu_reload_worker_result(
    reload: impl FnOnce() -> AdapterReloadResult,
) -> AdapterReloadResult {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(reload)).unwrap_or_else(|_| {
        AdapterReloadResult::Failed {
            error: "GPU reload worker panicked before producing a terminal result".to_string(),
            recoverable: false,
        }
    })
}

#[cfg(feature = "gpu-hmr")]
fn gpu_reload_result_allows_adapter_restore(result: &AdapterReloadResult) -> bool {
    !matches!(
        result,
        AdapterReloadResult::Failed {
            recoverable: false,
            ..
        }
    )
}

#[cfg(all(feature = "gpu-hmr", test))]
const RUNNER_GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof_ledger.v1";
#[cfg(all(feature = "gpu-hmr", test))]
const RUNNER_GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE: &str =
    "synthi.gpu_hmr.proof_ledger.portable.v2";
#[cfg(all(feature = "gpu-hmr", test))]
const RUNNER_GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
#[cfg(all(feature = "gpu-hmr", test))]
const RUNNER_GPU_HMR_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof.v1";
#[cfg(all(feature = "gpu-hmr", test))]
const RUNNER_GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.validation-proof.v1";
#[cfg(all(feature = "gpu-hmr", test))]
const RUNNER_GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION: &str = "synthi.gpu_hmr.contract.v1";
#[cfg(all(feature = "gpu-hmr", test))]
const RUNNER_GPU_HMR_FULL_RUNTIME_RESULT_STATE: &str = "gpu-hmr-full-runtime-proven";

#[cfg(all(feature = "gpu-hmr", test))]
fn stable_runtime_proof_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null
        | serde_json::Value::Bool(_)
        | serde_json::Value::Number(_)
        | serde_json::Value::String(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
        serde_json::Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_runtime_proof_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    let encoded_key =
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    let encoded_value =
                        stable_runtime_proof_json(map.get(key).unwrap_or(&serde_json::Value::Null));
                    format!("{encoded_key}:{encoded_value}")
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
    }
}

#[cfg(all(feature = "gpu-hmr", test))]
fn runtime_proof_json_sha256(value: &serde_json::Value) -> String {
    sha256_hex_bytes(stable_runtime_proof_json(value).as_bytes())
}

#[cfg(all(feature = "gpu-hmr", test))]
fn runtime_proof_json_field(value: &serde_json::Value, key: &str) -> serde_json::Value {
    value.get(key).cloned().unwrap_or(serde_json::Value::Null)
}

#[cfg(all(feature = "gpu-hmr", test))]
fn runtime_proof_json_object_or_empty(value: &serde_json::Value, key: &str) -> serde_json::Value {
    match value.get(key) {
        Some(serde_json::Value::Object(_)) => value
            .get(key)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
        _ => serde_json::json!({}),
    }
}

#[cfg(all(feature = "gpu-hmr", test))]
fn canonical_runner_runtime_ledger_proof_id(record: &serde_json::Value) -> String {
    let firewall = runtime_proof_json_object_or_empty(record, "firewall_evidence");
    let mut material = serde_json::json!({
        "schemaVersion": RUNNER_GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        "projectId": runtime_proof_json_field(record, "project_id"),
        "editId": runtime_proof_json_field(record, "edit_id"),
        "backend": runtime_proof_json_field(record, "backend"),
        "classification": runtime_proof_json_object_or_empty(record, "classification"),
        "contractHash": runtime_proof_json_field(record, "contract_hash"),
        "artifactBeforeHash": runtime_proof_json_field(record, "artifact_before_hash"),
        "artifactAfterHash": runtime_proof_json_field(record, "artifact_after_hash"),
        "loaderEvent": runtime_proof_json_object_or_empty(record, "loader_event"),
        "epochPublishEvent": runtime_proof_json_object_or_empty(record, "epoch_publish_event"),
        "dispatchEvent": runtime_proof_json_object_or_empty(record, "dispatch_event"),
        "outputEvent": runtime_proof_json_object_or_empty(record, "output_event"),
        "retirementEvent": runtime_proof_json_object_or_empty(record, "retirement_event"),
        "processIdentity": runtime_proof_json_object_or_empty(record, "process_identity"),
        "deviceIdentity": runtime_proof_json_object_or_empty(record, "device_identity"),
        "oracleArtifacts": runtime_proof_json_object_or_empty(record, "oracle_artifacts"),
        "deterministicVisualMode": runtime_proof_json_object_or_empty(record, "deterministic_visual_mode"),
        "outputOracleTarget": runtime_proof_json_object_or_empty(record, "output_oracle_target"),
        "metricClock": runtime_proof_json_field(record, "metric_clock"),
        "metricScope": runtime_proof_json_field(record, "metric_scope"),
        "cacheState": runtime_proof_json_field(record, "cache_state"),
        "timings": runtime_proof_json_object_or_empty(record, "timings"),
        "timingMetrics": runtime_proof_json_object_or_empty(record, "timing_metrics"),
        "modelProvenance": runtime_proof_json_object_or_empty(record, "model_provenance"),
        "evidenceRefs": runtime_proof_json_field(record, "evidence_refs"),
        "cpuHmrUsed": record.get("cpu_hmr_used").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "fullRebuildUsed": record.get("full_rebuild_used").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "processRestarted": record.get("process_restarted").and_then(serde_json::Value::as_bool).unwrap_or(false),
        "firewallEvidence": {
            "cpuHmrUsedEvidencePresent": firewall.get("cpu_hmr_used").is_some() || firewall.get("cpuHmrUsed").is_some(),
            "fullRebuildUsedEvidencePresent": firewall.get("full_rebuild_used").is_some() || firewall.get("fullRebuildUsed").is_some(),
            "processRestartedEvidencePresent": firewall.get("process_restarted").is_some() || firewall.get("processRestarted").is_some(),
            "processIdBefore": firewall.get("process_id_before")
                .or_else(|| firewall.get("processIdBefore"))
                .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_u64().map(|pid| pid.to_string()))),
            "processIdAfter": firewall.get("process_id_after")
                .or_else(|| firewall.get("processIdAfter"))
                .and_then(|value| value.as_str().map(str::to_string).or_else(|| value.as_u64().map(|pid| pid.to_string()))),
        },
    });
    if record
        .get("proof_canonical_profile")
        .and_then(serde_json::Value::as_str)
        == Some(RUNNER_GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE)
    {
        let object = material
            .as_object_mut()
            .expect("canonical runner ledger proof material is an object");
        object.insert(
            "proofCanonicalProfile".to_string(),
            serde_json::json!(RUNNER_GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE),
        );
        if record.get("epoch_commit_event").is_some() {
            object.insert(
                "epochCommitEvent".to_string(),
                runtime_proof_json_object_or_empty(record, "epoch_commit_event"),
            );
        }
    }
    format!(
        "gpu-ledger-proof:sha256:{}",
        runtime_proof_json_sha256(&material)
    )
}

#[cfg(all(feature = "gpu-hmr", test))]
fn portable_runner_json_numbers_supported(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Number(number) => number
            .as_i64()
            .map(|value| value.unsigned_abs() <= RUNNER_GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER)
            .or_else(|| {
                number
                    .as_u64()
                    .map(|value| value <= RUNNER_GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER)
            })
            .unwrap_or(false),
        serde_json::Value::Array(values) => {
            values.iter().all(portable_runner_json_numbers_supported)
        }
        serde_json::Value::Object(fields) => {
            fields.values().all(portable_runner_json_numbers_supported)
        }
        _ => true,
    }
}

#[cfg(all(feature = "gpu-hmr", test))]
fn portable_runner_json_aliases_consistent(value: &serde_json::Value) -> bool {
    fn alias_group_consistent(
        fields: &serde_json::Map<String, serde_json::Value>,
        names: &[&str],
    ) -> bool {
        let mut values = names.iter().filter_map(|name| fields.get(*name));
        let Some(first) = values.next() else {
            return true;
        };
        values.all(|value| value == first)
    }

    match value {
        serde_json::Value::Array(values) => {
            values.iter().all(portable_runner_json_aliases_consistent)
        }
        serde_json::Value::Object(fields) => {
            let semantic_aliases_match = [
                &["backend", "gpu_backend", "gpuBackend"][..],
                &[
                    "artifact_after_hash",
                    "changed_gpu_artifact_hash",
                    "changedGpuArtifactHash",
                ][..],
                &[
                    "artifact_hash",
                    "artifact_id",
                    "artifactHash",
                    "artifactId",
                    "loaded_artifact_id",
                    "loadedArtifactId",
                    "published_artifact_id",
                    "publishedArtifactId",
                ][..],
            ]
            .iter()
            .all(|names| alias_group_consistent(fields, names));
            semantic_aliases_match
                && fields.iter().all(|(key, field_value)| {
                    let mut camel_key = String::with_capacity(key.len());
                    let mut uppercase_next = false;
                    let mut had_separator = false;
                    for character in key.chars() {
                        if character == '_' {
                            uppercase_next = true;
                            had_separator = true;
                        } else if uppercase_next {
                            camel_key.push(character.to_ascii_uppercase());
                            uppercase_next = false;
                        } else {
                            camel_key.push(character);
                        }
                    }
                    let alias_matches = !had_separator
                        || fields
                            .get(&camel_key)
                            .is_none_or(|alias_value| alias_value == field_value);
                    alias_matches && portable_runner_json_aliases_consistent(field_value)
                })
        }
        _ => true,
    }
}

#[cfg(all(feature = "gpu-hmr", test))]
#[derive(Clone, Copy)]
enum PortableRunnerEventAliasMode {
    Standard,
    Dispatch,
    Output,
    Retirement,
}

#[cfg(all(feature = "gpu-hmr", test))]
fn portable_runner_event_aliases_consistent(
    event: &serde_json::Value,
    mode: PortableRunnerEventAliasMode,
) -> bool {
    let Some(fields) = event.as_object() else {
        return false;
    };
    let alias_group_consistent = |names: &[&str]| {
        let mut values = names.iter().filter_map(|name| fields.get(*name));
        let Some(first) = values.next() else {
            return true;
        };
        values.all(|value| value == first)
    };

    let standard_event_ids = ["id", "event_id", "eventId", "proof_id", "proofId"];
    let dispatch_event_ids = [
        "id",
        "event_id",
        "eventId",
        "proof_id",
        "proofId",
        "dispatch_id",
        "dispatchId",
    ];
    let event_ids = if matches!(mode, PortableRunnerEventAliasMode::Dispatch) {
        dispatch_event_ids.as_slice()
    } else {
        standard_event_ids.as_slice()
    };
    let artifact_ids = [
        "artifact_hash",
        "artifactHash",
        "artifact_id",
        "artifactId",
        "loaded_artifact_hash",
        "loadedArtifactHash",
        "loaded_artifact_id",
        "loadedArtifactId",
        "published_artifact_hash",
        "publishedArtifactHash",
        "published_artifact_id",
        "publishedArtifactId",
        "runtime_artifact_id",
        "runtimeArtifactId",
        "selected_artifact_id",
        "selectedArtifactId",
        "new_artifact_hash",
        "newArtifactHash",
        "hash",
    ];
    let standard_groups = [
        event_ids,
        &["event", "event_kind", "eventKind", "kind"],
        &["epoch", "epoch_id", "epochId", "generation"],
        artifact_ids.as_slice(),
        &["process_id", "processId", "pid"],
        &["publication_id", "publicationId"],
        &["candidate_registration_id", "candidateRegistrationId"],
        &["dispatcher_registration_id", "dispatcherRegistrationId"],
        &["previous_epoch", "previousEpoch"],
        &["device_uuid", "deviceUuid", "device_id", "deviceId"],
        &[
            "timestamp_monotonic_ns",
            "timestampMonotonicNs",
            "timestamp_ms",
            "timestampMs",
            "ts",
        ],
        &[
            "passed",
            "success",
            "succeeded",
            "accepted",
            "gpu_hmr_success",
            "gpuHmrSuccess",
        ],
    ];
    standard_groups
        .iter()
        .all(|group| alias_group_consistent(group))
        && (!matches!(mode, PortableRunnerEventAliasMode::Output)
            || alias_group_consistent(&[
                "after_dispatch_id",
                "afterDispatchId",
                "dispatch_id",
                "dispatchId",
            ]))
        && (!matches!(mode, PortableRunnerEventAliasMode::Retirement)
            || (alias_group_consistent(&[
                "status",
                "result",
                "retirement_result",
                "retirementResult",
            ]) && alias_group_consistent(&["proof", "retirement_proof", "retirementProof"])))
}

#[cfg(all(feature = "gpu-hmr", test))]
fn canonical_runner_epoch(value: Option<&str>) -> Option<u64> {
    let value = value?;
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse::<u64>().ok()
}

#[cfg(all(feature = "gpu-hmr", test))]
fn expected_runtime_artifact_id(artifact_content_hash: &str) -> Option<String> {
    canonical_sha256_content_hash(artifact_content_hash).then(|| {
        format!(
            "artifact:sha256:{}",
            artifact_content_hash.trim_start_matches("sha256:")
        )
    })
}

#[cfg(all(feature = "gpu-hmr", test))]
fn canonical_runtime_artifact_id(value: &str) -> bool {
    value
        .strip_prefix("artifact:")
        .is_some_and(canonical_sha256_content_hash)
}

#[cfg(all(feature = "gpu-hmr", test))]
fn strict_runtime_record_chain_matches(
    record: &serde_json::Value,
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
    expected_process_id: &str,
    expected_runtime_session_id: &str,
) -> bool {
    let Some(expected_artifact_id) = expected_runtime_artifact_id(artifact_content_hash) else {
        return false;
    };
    let field_str = |pointer: &str| record.pointer(pointer).and_then(serde_json::Value::as_str);
    let field_u64 = |pointer: &str| record.pointer(pointer).and_then(serde_json::Value::as_u64);
    let event_artifact_matches = |event: &str| {
        field_str(&format!("/{event}/artifact_hash")) == Some(expected_artifact_id.as_str())
            && field_str(&format!("/{event}/artifact_id")) == Some(expected_artifact_id.as_str())
    };
    let event_process = |event: &str| field_str(&format!("/{event}/process_id"));
    let process_id = event_process("loader_event");
    let commit_event_id = field_str("/epoch_commit_event/id");
    let previous_epoch = field_str("/epoch_publish_event/previous_epoch");
    let candidate_epoch = field_str("/epoch_publish_event/epoch");
    let publication_id = field_str("/epoch_commit_event/publication_id");
    let candidate_registration_id = field_str("/epoch_commit_event/candidate_registration_id");
    let previous_artifact_id = field_str("/artifact_before_hash");
    let canonical_record_proof_id = canonical_runner_runtime_ledger_proof_id(record);
    let record_proof_id_matches = ["proof_id", "proofId"]
        .iter()
        .filter_map(|name| record.get(*name))
        .all(|value| value.as_str() == Some(canonical_record_proof_id.as_str()));
    let generation_transition_matches = canonical_runner_epoch(previous_epoch)
        .zip(canonical_runner_epoch(candidate_epoch))
        .is_some_and(|(previous, candidate)| candidate > previous);
    let retirement_proof_accepted = matches!(
        field_str("/retirement_event/retirement_proof"),
        Some(
            "stream_event_proven"
                | "queue_idle_proven"
                | "frame_boundary_proven"
                | "no_retirement_required"
        )
    );
    let firewall = record.get("firewall_evidence");
    let evidence_refs = record
        .get("evidence_refs")
        .and_then(serde_json::Value::as_array);
    let has_ref = |expected: &str| {
        evidence_refs.is_some_and(|refs| refs.iter().any(|value| value.as_str() == Some(expected)))
    };

    record
        .get("schemaVersion")
        .and_then(serde_json::Value::as_str)
        == Some(RUNNER_GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION)
        && field_str("/proof_canonical_profile")
            == Some(RUNNER_GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE)
        && portable_runner_json_numbers_supported(record)
        && portable_runner_json_aliases_consistent(record)
        && record_proof_id_matches
        && record.get("edit_id").and_then(serde_json::Value::as_str) == Some(source_edit_id)
        && record
            .get("artifact_after_hash")
            .and_then(serde_json::Value::as_str)
            == Some(expected_artifact_id.as_str())
        && record
            .get("artifact_before_hash")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|before| {
                canonical_runtime_artifact_id(before) && before != expected_artifact_id
            })
        && portable_runner_event_aliases_consistent(
            &record["loader_event"],
            PortableRunnerEventAliasMode::Standard,
        )
        && portable_runner_event_aliases_consistent(
            &record["epoch_publish_event"],
            PortableRunnerEventAliasMode::Standard,
        )
        && portable_runner_event_aliases_consistent(
            &record["epoch_commit_event"],
            PortableRunnerEventAliasMode::Standard,
        )
        && portable_runner_event_aliases_consistent(
            &record["dispatch_event"],
            PortableRunnerEventAliasMode::Dispatch,
        )
        && portable_runner_event_aliases_consistent(
            &record["output_event"],
            PortableRunnerEventAliasMode::Output,
        )
        && portable_runner_event_aliases_consistent(
            &record["retirement_event"],
            PortableRunnerEventAliasMode::Retirement,
        )
        && event_artifact_matches("loader_event")
        && event_artifact_matches("epoch_publish_event")
        && event_artifact_matches("epoch_commit_event")
        && event_artifact_matches("dispatch_event")
        && event_artifact_matches("output_event")
        && field_str("/epoch_publish_event/event") == Some("provisional_install")
        && field_str("/epoch_publish_event/kind")
            .is_none_or(|kind| Some(kind) == field_str("/epoch_publish_event/event"))
        && field_str("/epoch_commit_event/event") == Some("unrestricted_visibility_commit")
        && field_str("/epoch_commit_event/kind")
            .is_none_or(|kind| Some(kind) == field_str("/epoch_commit_event/event"))
        && commit_event_id.is_some_and(|value| !value.is_empty())
        && generation_transition_matches
        && publication_id.is_some_and(|value| !value.is_empty())
        && candidate_registration_id.is_some_and(|value| !value.is_empty())
        && field_str("/epoch_publish_event/publication_id") == publication_id
        && field_str("/dispatch_event/publication_id") == publication_id
        && field_str("/epoch_publish_event/candidate_registration_id") == candidate_registration_id
        && field_str("/dispatch_event/dispatcher_registration_id") == candidate_registration_id
        && field_str("/epoch_commit_event/epoch") == field_str("/epoch_publish_event/epoch")
        && field_str("/epoch_commit_event/previous_epoch") == previous_epoch
        && field_str("/retirement_event/epoch") == previous_epoch
        && field_str("/retirement_event/artifact_hash") == previous_artifact_id
        && field_str("/retirement_event/artifact_id") == previous_artifact_id
        && field_str("/retirement_event/status") == Some("retired_after_quiescent")
        && retirement_proof_accepted
        && field_str("/dispatch_event/epoch") == field_str("/epoch_publish_event/epoch")
        && field_str("/output_event/epoch") == field_str("/dispatch_event/epoch")
        && field_str("/output_event/after_dispatch_id") == field_str("/dispatch_event/id")
        && record
            .pointer("/output_event/passed")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        && process_id == Some(expected_process_id)
        && event_process("epoch_publish_event") == process_id
        && event_process("epoch_commit_event") == process_id
        && event_process("dispatch_event") == process_id
        && event_process("output_event") == process_id
        && event_process("retirement_event") == process_id
        && field_str("/process_identity/process_id") == Some(expected_process_id)
        && field_str("/process_identity/runtime_session_id") == Some(expected_runtime_session_id)
        && record
            .get("cpu_hmr_used")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && record
            .get("full_rebuild_used")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && record
            .get("process_restarted")
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && firewall
            .and_then(|value| value.get("cpu_hmr_used"))
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && firewall
            .and_then(|value| value.get("full_rebuild_used"))
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && firewall
            .and_then(|value| value.get("process_restarted"))
            .and_then(serde_json::Value::as_bool)
            == Some(false)
        && firewall
            .and_then(|value| value.get("process_id_before"))
            .and_then(serde_json::Value::as_str)
            == process_id
        && firewall
            .and_then(|value| value.get("process_id_after"))
            .and_then(serde_json::Value::as_str)
            == process_id
        && field_u64("/loader_event/timestamp_monotonic_ns")
            .zip(field_u64("/epoch_publish_event/timestamp_monotonic_ns"))
            .is_some_and(|(loader, publish)| loader <= publish)
        && field_u64("/epoch_publish_event/timestamp_monotonic_ns")
            .zip(field_u64("/dispatch_event/timestamp_monotonic_ns"))
            .is_some_and(|(publish, dispatch)| publish <= dispatch)
        && field_u64("/dispatch_event/timestamp_monotonic_ns")
            .zip(field_u64("/output_event/timestamp_monotonic_ns"))
            .is_some_and(|(dispatch, output)| dispatch <= output)
        && field_u64("/output_event/timestamp_monotonic_ns")
            .zip(field_u64("/epoch_commit_event/timestamp_monotonic_ns"))
            .is_some_and(|(output, commit)| output <= commit)
        && field_u64("/epoch_commit_event/timestamp_monotonic_ns")
            .zip(field_u64("/retirement_event/timestamp_monotonic_ns"))
            .is_some_and(|(commit, retirement)| commit <= retirement)
        && has_ref(&format!("reload:{request_id}"))
        && has_ref(&format!("source-edit-id:{source_edit_id}"))
        && has_ref(publication_id.unwrap_or_default())
        && has_ref(candidate_registration_id.unwrap_or_default())
}

#[cfg(feature = "gpu-hmr")]
#[derive(Clone)]
struct StrictRuntimeOracleReceipt {
    receipt_id: String,
    request_id: String,
    source_edit_id: String,
    runtime_session_id: String,
    process_id: u32,
    artifact_content_hash: String,
    artifact_id: String,
    generation: u64,
    dispatcher_registration_id: String,
    dispatch_table_hash: String,
    dispatch_table_entry_id: String,
    publication_id: String,
    previous_generation: u64,
    publication_timestamp_monotonic_ns: u128,
    publication_committed_timestamp_monotonic_ns: u128,
    dispatch_id: String,
    dispatch_timestamp_monotonic_ns: u128,
    readback_timestamp_monotonic_ns: u128,
    stream_token: usize,
    profile_schema_version: String,
    profile_id: String,
    profile_bytes_sha256: String,
    contract_sha256: String,
    proof_context_binding_sha256: Option<String>,
    proof_context_proof_id: Option<String>,
    oracle_id: String,
    producer: String,
    output_target_id: String,
    output_buffer_name: String,
    baseline_sha256: String,
    expected_sha256: String,
    observed_sha256: String,
    probe_mode: String,
    probe_config_hash: String,
    probe_evidence_ref: String,
    readback_schema: serde_json::Value,
    readback_schema_sha256: String,
    recomputed_readback_schema_sha256: String,
    deterministic_slice_offset: usize,
    deterministic_slice_length: usize,
    deterministic_slice_stride: usize,
    deterministic_slice_sha256: String,
    readback_bytes: Arc<[u8]>,
}

#[cfg(feature = "gpu-hmr")]
fn canonical_typed_sha256(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

#[cfg(feature = "gpu-hmr")]
impl TryFrom<&HostVerifiedComputeReadbackReceipt> for StrictRuntimeOracleReceipt {
    type Error = &'static str;

    fn try_from(receipt: &HostVerifiedComputeReadbackReceipt) -> Result<Self, Self::Error> {
        Ok(Self {
            receipt_id: receipt.receipt_id().to_string(),
            request_id: receipt.request_id().to_string(),
            source_edit_id: receipt.source_edit_id().to_string(),
            runtime_session_id: receipt.runtime_session_id().to_string(),
            process_id: receipt.process_id(),
            artifact_content_hash: receipt.artifact_content_hash().to_string(),
            artifact_id: receipt.artifact_id().to_string(),
            generation: receipt.generation(),
            dispatcher_registration_id: receipt.dispatcher_registration_id().to_string(),
            dispatch_table_hash: receipt.dispatch_table_hash().to_string(),
            dispatch_table_entry_id: receipt.dispatch_table_entry_id().to_string(),
            publication_id: receipt
                .publication_id()
                .ok_or("host output receipt publication id is missing")?
                .to_string(),
            previous_generation: receipt
                .previous_generation()
                .ok_or("host output receipt previous generation is missing")?,
            publication_timestamp_monotonic_ns: receipt
                .publication_timestamp_monotonic_ns()
                .ok_or("host output receipt publication timestamp is missing")?,
            publication_committed_timestamp_monotonic_ns: receipt
                .publication_committed_timestamp_monotonic_ns()
                .ok_or("host output receipt commit timestamp is missing")?,
            dispatch_id: receipt.dispatch_id().to_string(),
            dispatch_timestamp_monotonic_ns: receipt.dispatch_timestamp_monotonic_ns(),
            readback_timestamp_monotonic_ns: receipt.readback_timestamp_monotonic_ns(),
            stream_token: receipt.stream_token(),
            profile_schema_version: receipt.profile_schema_version().to_string(),
            profile_id: receipt.profile_id().to_string(),
            profile_bytes_sha256: receipt.profile_bytes_sha256().to_string(),
            contract_sha256: receipt.contract_sha256().to_string(),
            proof_context_binding_sha256: receipt
                .proof_context_binding_sha256()
                .map(str::to_string),
            proof_context_proof_id: receipt.proof_context_proof_id().map(str::to_string),
            oracle_id: receipt.oracle_id().to_string(),
            producer: receipt.producer().to_string(),
            output_target_id: receipt.output_target_id().to_string(),
            output_buffer_name: receipt.output_buffer_name().to_string(),
            baseline_sha256: receipt.baseline_sha256().to_string(),
            expected_sha256: receipt.expected_sha256().to_string(),
            observed_sha256: receipt.observed_sha256().to_string(),
            probe_mode: receipt.probe_mode().to_string(),
            probe_config_hash: receipt.probe_config_hash().to_string(),
            probe_evidence_ref: receipt.probe_evidence_ref().to_string(),
            readback_schema: receipt.readback_schema_json(),
            readback_schema_sha256: receipt.readback_schema_sha256().to_string(),
            recomputed_readback_schema_sha256: receipt.recompute_readback_schema_sha256(),
            deterministic_slice_offset: receipt.deterministic_slice_offset(),
            deterministic_slice_length: receipt.deterministic_slice_length(),
            deterministic_slice_stride: receipt.deterministic_slice_stride(),
            deterministic_slice_sha256: receipt.deterministic_slice_sha256().to_string(),
            readback_bytes: receipt.readback_bytes_arc(),
        })
    }
}

#[cfg(feature = "gpu-hmr")]
fn strict_runtime_oracle_receipt_matches(
    record: &serde_json::Value,
    expected_runtime_session_id: &str,
    expected_request_id: &str,
    expected_source_edit_id: &str,
    expected_artifact_content_hash: &str,
    receipt: &StrictRuntimeOracleReceipt,
) -> bool {
    let Some(output_event) = record
        .get("output_event")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    let Some(epoch_publish_event) = record
        .get("epoch_publish_event")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    let Some(epoch_commit_event) = record
        .get("epoch_commit_event")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    let Some(dispatch_event) = record
        .get("dispatch_event")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    let Some(retirement_event) = record
        .get("retirement_event")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    let Some(oracle_artifacts) = record
        .get("oracle_artifacts")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    let Some(output_oracle) = output_event
        .get("output_oracle")
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    if output_event.get("oracle_artifacts") != record.get("oracle_artifacts")
        || output_oracle.get("oracle_artifacts") != record.get("oracle_artifacts")
    {
        return false;
    }

    let Some(oracle_id) = output_event.get("id").and_then(serde_json::Value::as_str) else {
        return false;
    };
    let Some(dispatch_id) = output_event
        .get("after_dispatch_id")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    let Some(artifact_id) = output_event
        .get("artifact_id")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    let Some(generation) = output_event
        .get("epoch")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return false;
    };
    let Some(output_timestamp) = output_event
        .get("timestamp_monotonic_ns")
        .and_then(serde_json::Value::as_u64)
        .map(u128::from)
    else {
        return false;
    };

    if receipt.request_id != expected_request_id
        || receipt.source_edit_id != expected_source_edit_id
        || receipt.runtime_session_id != expected_runtime_session_id
        || receipt.process_id != std::process::id()
        || receipt.artifact_content_hash != expected_artifact_content_hash
        || receipt.oracle_id != oracle_id
        || receipt.generation != generation
        || receipt.artifact_id != artifact_id
        || receipt.dispatch_id != dispatch_id
        || receipt.readback_timestamp_monotonic_ns != output_timestamp
        || receipt.dispatch_timestamp_monotonic_ns
            != record
                .pointer("/dispatch_event/timestamp_monotonic_ns")
                .and_then(serde_json::Value::as_u64)
                .map(u128::from)
                .unwrap_or_default()
        || receipt.readback_timestamp_monotonic_ns < receipt.dispatch_timestamp_monotonic_ns
        || receipt.previous_generation >= receipt.generation
        || !canonical_typed_sha256(&receipt.publication_id, "dispatcher-publication:sha256:")
        || !canonical_typed_sha256(&receipt.dispatcher_registration_id, "dispatcher:sha256:")
        || !canonical_sha256_content_hash(&receipt.dispatch_table_hash)
        || receipt.dispatch_table_entry_id.is_empty()
        || receipt
            .dispatch_table_entry_id
            .chars()
            .any(char::is_whitespace)
        || receipt.publication_timestamp_monotonic_ns > receipt.dispatch_timestamp_monotonic_ns
        || receipt.publication_committed_timestamp_monotonic_ns
            < receipt.readback_timestamp_monotonic_ns
        || retirement_event
            .get("timestamp_monotonic_ns")
            .and_then(serde_json::Value::as_u64)
            .map(u128::from)
            .is_none_or(|timestamp| {
                timestamp < receipt.publication_committed_timestamp_monotonic_ns
            })
        || epoch_publish_event
            .get("publication_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.publication_id.as_str())
        || epoch_publish_event
            .get("candidate_registration_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatcher_registration_id.as_str())
        || epoch_publish_event
            .get("dispatcher_registration_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatcher_registration_id.as_str())
        || epoch_publish_event
            .get("previous_epoch")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.parse::<u64>().ok())
            != Some(receipt.previous_generation)
        || epoch_publish_event
            .get("timestamp_monotonic_ns")
            .and_then(serde_json::Value::as_u64)
            .map(u128::from)
            != Some(receipt.publication_timestamp_monotonic_ns)
        || epoch_publish_event
            .get("committed_timestamp_monotonic_ns")
            .and_then(serde_json::Value::as_u64)
            .map(u128::from)
            != Some(receipt.publication_committed_timestamp_monotonic_ns)
        || epoch_commit_event
            .get("publication_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.publication_id.as_str())
        || epoch_commit_event
            .get("candidate_registration_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatcher_registration_id.as_str())
        || epoch_commit_event
            .get("timestamp_monotonic_ns")
            .and_then(serde_json::Value::as_u64)
            .map(u128::from)
            != Some(receipt.publication_committed_timestamp_monotonic_ns)
        || dispatch_event
            .get("publication_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.publication_id.as_str())
        || dispatch_event
            .get("dispatcher_registration_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatcher_registration_id.as_str())
        || dispatch_event
            .get("dispatch_table_hash")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatch_table_hash.as_str())
        || dispatch_event
            .get("dispatch_table_entry_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatch_table_entry_id.as_str())
        || record
            .pointer("/device_identity/dispatch_stream_token")
            .and_then(serde_json::Value::as_u64)
            != u64::try_from(receipt.stream_token).ok()
        || !canonical_sha256_content_hash(&receipt.expected_sha256)
        || !canonical_sha256_content_hash(&receipt.baseline_sha256)
        || !canonical_sha256_content_hash(&receipt.observed_sha256)
        || receipt.expected_sha256 != receipt.observed_sha256
        || receipt.baseline_sha256 == receipt.observed_sha256
        || receipt.readback_schema_sha256 != receipt.recomputed_readback_schema_sha256
        || format!("sha256:{}", sha256_hex_bytes(&receipt.readback_bytes))
            != receipt.observed_sha256
        || output_oracle
            .get("oracle_id")
            .and_then(serde_json::Value::as_str)
            != Some(oracle_id)
        || output_oracle
            .get("kind")
            .and_then(serde_json::Value::as_str)
            != Some("buffer_checksum")
        || output_oracle
            .get("expected")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.expected_sha256.as_str())
        || output_oracle
            .get("actual")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.observed_sha256.as_str())
        || output_oracle
            .get("passed")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
    {
        return false;
    }

    if receipt.readback_bytes.is_empty()
        || receipt.deterministic_slice_stride != 1
        || receipt.deterministic_slice_offset > receipt.readback_bytes.len()
    {
        return false;
    }
    let slice_end = receipt
        .deterministic_slice_offset
        .saturating_add(receipt.deterministic_slice_length);
    if slice_end > receipt.readback_bytes.len() {
        return false;
    }
    let recomputed_slice_hash = format!(
        "sha256:{}",
        sha256_hex_bytes(&receipt.readback_bytes[receipt.deterministic_slice_offset..slice_end])
    );
    if recomputed_slice_hash != receipt.deterministic_slice_sha256
        || oracle_artifacts
            .get("host_receipt_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.receipt_id.as_str())
        || oracle_artifacts
            .get("host_receipt_schema")
            .and_then(serde_json::Value::as_str)
            != Some(HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA)
        || oracle_artifacts
            .get("host_receipt_authority")
            .and_then(serde_json::Value::as_str)
            != Some(HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY)
        || oracle_artifacts
            .get("dispatcher_publication_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.publication_id.as_str())
        || oracle_artifacts
            .get("dispatcher_previous_generation")
            .and_then(serde_json::Value::as_u64)
            != Some(receipt.previous_generation)
        || oracle_artifacts
            .get("dispatcher_publication_timestamp_monotonic_ns")
            .and_then(serde_json::Value::as_u64)
            .map(u128::from)
            != Some(receipt.publication_timestamp_monotonic_ns)
        || oracle_artifacts
            .get("dispatcher_publication_committed_timestamp_monotonic_ns")
            .and_then(serde_json::Value::as_u64)
            .map(u128::from)
            != Some(receipt.publication_committed_timestamp_monotonic_ns)
        || oracle_artifacts
            .get("dispatcher_registration_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatcher_registration_id.as_str())
        || oracle_artifacts
            .get("dispatch_table_hash")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatch_table_hash.as_str())
        || oracle_artifacts
            .get("dispatch_table_entry_id")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.dispatch_table_entry_id.as_str())
        || oracle_artifacts.get("readback_schema") != Some(&receipt.readback_schema)
        || oracle_artifacts
            .get("readback_schema_hash")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.readback_schema_sha256.as_str())
        || oracle_artifacts
            .get("checksum_before")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.baseline_sha256.as_str())
        || oracle_artifacts
            .get("checksum_after")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.observed_sha256.as_str())
        || oracle_artifacts
            .get("raw_readback_hash")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.observed_sha256.as_str())
        || oracle_artifacts
            .get("raw_readback_byte_length")
            .and_then(serde_json::Value::as_u64)
            != u64::try_from(receipt.readback_bytes.len()).ok()
        || oracle_artifacts
            .get("raw_readback_source")
            .and_then(serde_json::Value::as_str)
            != Some("host_verified_full_dtoh_receipt")
        || record
            .pointer("/oracle_artifacts/raw_readback_verification/hash_verified")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || record
            .pointer("/oracle_artifacts/raw_readback_verification/authority")
            .and_then(serde_json::Value::as_str)
            != Some(HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY)
        || record
            .pointer("/oracle_artifacts/deterministic_slice/offset")
            .and_then(serde_json::Value::as_u64)
            != u64::try_from(receipt.deterministic_slice_offset).ok()
        || record
            .pointer("/oracle_artifacts/deterministic_slice/length")
            .and_then(serde_json::Value::as_u64)
            != u64::try_from(receipt.deterministic_slice_length).ok()
        || record
            .pointer("/oracle_artifacts/deterministic_slice/stride")
            .and_then(serde_json::Value::as_u64)
            != u64::try_from(receipt.deterministic_slice_stride).ok()
        || record
            .pointer("/oracle_artifacts/deterministic_slice/source")
            .and_then(serde_json::Value::as_str)
            != Some("host_verified_full_dtoh_receipt")
        || oracle_artifacts
            .get("deterministic_slice_hash")
            .and_then(serde_json::Value::as_str)
            != Some(receipt.deterministic_slice_sha256.as_str())
    {
        return false;
    }
    oracle_artifacts
        .get("producer")
        .and_then(serde_json::Value::as_str)
        == Some(receipt.producer.as_str())
        && oracle_artifacts
            .get("profile_id")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.profile_id.as_str())
        && oracle_artifacts
            .get("profile_schema_version")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.profile_schema_version.as_str())
        && oracle_artifacts
            .get("profile_bytes_sha256")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.profile_bytes_sha256.as_str())
        && oracle_artifacts
            .get("fission_output_oracle_contract_sha256")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.contract_sha256.as_str())
        && oracle_artifacts
            .get("proof_context_binding_sha256")
            .and_then(serde_json::Value::as_str)
            == receipt.proof_context_binding_sha256.as_deref()
        && oracle_artifacts
            .get("proof_context_proof_id")
            .and_then(serde_json::Value::as_str)
            == receipt.proof_context_proof_id.as_deref()
        && oracle_artifacts
            .get("probe_mode")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.probe_mode.as_str())
        && oracle_artifacts
            .get("oracle_code_hash")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.probe_config_hash.as_str())
        && oracle_artifacts
            .get("probe_evidence_ref")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.probe_evidence_ref.as_str())
        && oracle_artifacts
            .get("output_buffer_name")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.output_buffer_name.as_str())
        && record
            .pointer("/output_oracle_target/target_id")
            .and_then(serde_json::Value::as_str)
            == Some(receipt.output_target_id.as_str())
}

#[cfg(all(feature = "gpu-hmr", test))]
fn recomputed_runtime_proof_id(
    runtime_artifact: &serde_json::Value,
    record: &serde_json::Value,
) -> Option<String> {
    let material = serde_json::json!({
        "resultState": runtime_artifact.get("resultState")?,
        "proofLedger": runtime_artifact.get("proofLedger")?,
        "acceptanceContract": runtime_artifact.get("acceptanceContract")?,
        "stageResults": runtime_artifact.get("stageResults")?,
        "runtimeTrace": runtime_artifact.get("runtimeTrace")?,
        "runtimeSessionId": runtime_artifact.pointer("/runtimeTrace/runtimeSessionId")?,
        "artifactBefore": record.get("artifact_before_hash")?,
        "artifactAfter": record.get("artifact_after_hash")?,
        "dispatchId": record.pointer("/dispatch_event/id")?,
    });
    Some(format!(
        "gpu-runtime-proof:sha256:{}",
        runtime_proof_json_sha256(&material)
    ))
}

#[cfg(feature = "gpu-hmr")]
fn matching_strict_gpu_runtime_proof_id(
    proof: &serde_json::Value,
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
    receipt: &StrictRuntimeOracleReceipt,
) -> Option<String> {
    let expected_process_id = std::process::id().to_string();
    let expected_runtime_session_id = runtime_session_id();
    let shared_verification = verify_strict_gpu_runtime_proof(
        proof,
        &StrictGpuRuntimeProofExpectation {
            request_id,
            source_edit_id,
            artifact_content_hash,
            process_id: &expected_process_id,
            runtime_session_id: expected_runtime_session_id,
            compute_expected_output_contract_hash: None,
            enforce_compute_expected_output_contract_hash: false,
        },
    )?;
    let record = proof.pointer("/proofLedger/records/0")?;
    strict_runtime_oracle_receipt_matches(
        record,
        expected_runtime_session_id,
        request_id,
        source_edit_id,
        artifact_content_hash,
        receipt,
    )
    .then(|| shared_verification.proof_id)
}

#[cfg(feature = "gpu-hmr")]
fn strict_gpu_reload_terminal_result(
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
    result: &AdapterReloadResult,
    runtime_proof: Option<&serde_json::Value>,
    command_envelope_sha256: Option<&str>,
    runner_challenge: Option<&str>,
) -> Result<GpuReloadV2Result, String> {
    match result {
        AdapterReloadResult::Success { .. } => {
            let receipt = match consume_host_verified_compute_receipt(
                request_id,
                source_edit_id,
                artifact_content_hash,
            ) {
                Ok(receipt) => receipt,
                Err(error) => {
                    return GpuReloadV2Result::rejected(
                        request_id,
                        source_edit_id,
                        artifact_content_hash,
                        format!(
                            "strict GPU reload completed without one host-verified full-readback receipt: {error}"
                        ),
                    );
                }
            };
            let receipt = match StrictRuntimeOracleReceipt::try_from(&receipt) {
                Ok(receipt) => receipt,
                Err(error) => {
                    return GpuReloadV2Result::rejected(
                        request_id,
                        source_edit_id,
                        artifact_content_hash,
                        format!(
                            "strict GPU reload completed with an unfinalized host receipt: {error}"
                        ),
                    );
                }
            };
            strict_gpu_reload_terminal_result_with_receipt(
                request_id,
                source_edit_id,
                artifact_content_hash,
                result,
                runtime_proof,
                Some(&receipt),
                command_envelope_sha256,
                runner_challenge,
            )
        }
        AdapterReloadResult::Failed { .. } | AdapterReloadResult::Unsupported { .. } => {
            strict_gpu_reload_terminal_result_with_receipt(
                request_id,
                source_edit_id,
                artifact_content_hash,
                result,
                runtime_proof,
                None,
                command_envelope_sha256,
                runner_challenge,
            )
        }
    }
}

#[cfg(feature = "gpu-hmr")]
fn strict_gpu_reload_terminal_result_with_receipt(
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
    result: &AdapterReloadResult,
    runtime_proof: Option<&serde_json::Value>,
    receipt: Option<&StrictRuntimeOracleReceipt>,
    command_envelope_sha256: Option<&str>,
    runner_challenge: Option<&str>,
) -> Result<GpuReloadV2Result, String> {
    match result {
        AdapterReloadResult::Success { .. } => {
            let proof_match = receipt
                .zip(runtime_proof)
                .zip(command_envelope_sha256)
                .zip(runner_challenge)
                .and_then(
                    |(((receipt, proof), command_envelope_sha256), runner_challenge)| {
                        matching_strict_gpu_runtime_proof_id(
                            proof,
                            request_id,
                            source_edit_id,
                            artifact_content_hash,
                            receipt,
                        )
                        .map(|proof_id| {
                            (proof_id, proof, command_envelope_sha256, runner_challenge)
                        })
                    },
                );
            if let Some((proof_id, proof, command_envelope_sha256, runner_challenge)) = proof_match
            {
                match GpuRuntimeProofMaterialV1::new(
                    proof,
                    request_id,
                    source_edit_id,
                    artifact_content_hash,
                    &proof_id,
                    command_envelope_sha256,
                    std::process::id(),
                    runtime_session_id(),
                    runner_challenge,
                ) {
                    Ok(material) => GpuReloadV2Result::applied(
                        request_id,
                        source_edit_id,
                        artifact_content_hash,
                        proof_id,
                        material,
                    ),
                    Err(error) => GpuReloadV2Result::rejected(
                        request_id,
                        source_edit_id,
                        artifact_content_hash,
                        format!("strict GPU runtime proof transport failed: {error}"),
                    ),
                }
            } else {
                GpuReloadV2Result::rejected(
                    request_id,
                    source_edit_id,
                    artifact_content_hash,
                    "strict GPU reload completed without a matching accepted full runtime proof",
                )
            }
        }
        AdapterReloadResult::Failed { error, .. } => {
            GpuReloadV2Result::rejected(request_id, source_edit_id, artifact_content_hash, error)
        }
        AdapterReloadResult::Unsupported { reason } => {
            GpuReloadV2Result::rejected(request_id, source_edit_id, artifact_content_hash, reason)
        }
    }
}

#[cfg(feature = "gpu-hmr")]
fn cold_gpu_artifact_load_terminal_result(
    request_id: &str,
    source_edit_id: &str,
    artifact_content_hash: &str,
    result: &AdapterReloadResult,
) -> Result<GpuArtifactLoadV1Result, String> {
    match result {
        AdapterReloadResult::Success { .. } => {
            GpuArtifactLoadV1Result::loaded(request_id, source_edit_id, artifact_content_hash)
        }
        AdapterReloadResult::Failed { error, .. } => GpuArtifactLoadV1Result::rejected(
            request_id,
            source_edit_id,
            artifact_content_hash,
            error,
        ),
        AdapterReloadResult::Unsupported { reason } => GpuArtifactLoadV1Result::rejected(
            request_id,
            source_edit_id,
            artifact_content_hash,
            reason,
        ),
    }
}

#[cfg(feature = "gpu-hmr")]
fn emit_correlated_gpu_command_rejection(
    cold_load: bool,
    request_id: Option<&str>,
    source_edit_id: Option<&str>,
    artifact_content_hash: Option<&str>,
    reason: &str,
) {
    let status = match (request_id, source_edit_id) {
        (Some(request_id), Some(source_edit_id)) if cold_load => artifact_content_hash
            .ok_or_else(|| "cold GPU artifact load hash is missing".to_string())
            .and_then(|artifact_hash| {
                GpuArtifactLoadV1Result::rejected(request_id, source_edit_id, artifact_hash, reason)
                    .and_then(|result| result.to_json())
            }),
        (Some(request_id), Some(source_edit_id)) => artifact_content_hash
            .ok_or_else(|| "hot GPU reload hash is missing".to_string())
            .and_then(|artifact_hash| {
                GpuReloadV2Result::rejected(request_id, source_edit_id, artifact_hash, reason)
            })
            .and_then(|result| result.to_json()),
        _ => Err("correlated GPU command terminal identity is incomplete".to_string()),
    };
    match status {
        Ok(status) => eprintln!("[Runner] [HMR-STATUS] {status}"),
        Err(error) => {
            let fallback = HmrStatus::rejected_with_fallback(
                "device",
                &format!("GPU command terminal result invalid: {error}"),
                "Keep previous GPU sidecar loaded",
            );
            eprintln!("[Runner] [HMR-STATUS] {}", fallback.to_json());
        }
    }
}

#[cfg(feature = "gpu-hmr")]
fn legacy_cold_gpu_artifact_status(
    artifact_content_hash: &str,
    result: &AdapterReloadResult,
) -> String {
    match result {
        AdapterReloadResult::Success { .. } => serde_json::json!({
            "status": "gpu-artifact-loaded",
            "module": "device",
            "loadKind": "cold_legacy_compatibility",
            "artifactContentHash": artifact_content_hash,
            "proofAuthority": "legacy_cold_artifact_load_only_not_gpu_hmr_success",
            "acceptedForGpuHmr": false,
            "gpuHmrSuccess": false,
        })
        .to_string(),
        AdapterReloadResult::Failed { error, .. } => HmrStatus::rejected_with_fallback(
            "device",
            error,
            "Keep the previous device state or use a correlated V4 cold load",
        )
        .to_json(),
        AdapterReloadResult::Unsupported { reason } => {
            HmrStatus::rejected_with_fallback("device", reason, "Use a correlated V4 cold load")
                .to_json()
        }
    }
}

#[cfg(feature = "gpu-hmr")]
fn emit_gpu_reload_completion(completion: &GpuReloadCompletion) {
    let result_status = match &completion.result {
        AdapterReloadResult::Success { .. } => "success",
        AdapterReloadResult::Failed { .. } => "failed",
        AdapterReloadResult::Unsupported { .. } => "unsupported",
    };
    eprintln!(
        "[Runner] [GPU HMR] Device sidecar reload vendor={} artifact_hash={} kernel_count={} result={}",
        completion.language,
        completion.artifact_content_hash,
        completion.kernel_count,
        result_status,
    );
    match (
        completion.request_id.as_deref(),
        completion.source_edit_id.as_deref(),
    ) {
        (Some(request_id), Some(source_edit_id)) => {
            let terminal = if completion.cold_load {
                cold_gpu_artifact_load_terminal_result(
                    request_id,
                    source_edit_id,
                    &completion.artifact_content_hash,
                    &completion.result,
                )
                .and_then(|result| result.to_json())
            } else {
                strict_gpu_reload_terminal_result(
                    request_id,
                    source_edit_id,
                    &completion.artifact_content_hash,
                    &completion.result,
                    completion.adapter.last_runtime_proof(),
                    completion.command_envelope_sha256.as_deref(),
                    completion.runner_challenge.as_deref(),
                )
                .and_then(|result| result.to_json())
            };
            match terminal {
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
        (None, None) => {
            eprintln!(
                "[Runner] [HMR-STATUS] {}",
                legacy_cold_gpu_artifact_status(
                    &completion.artifact_content_hash,
                    &completion.result,
                )
            );
            return;
        }
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
                "[Runner] [GPU HMR] RAM artifact capsule unavailable path_bytes={} path_sha256=sha256:{:x} error_kind={:?}",
                artifact_path.len(),
                Sha256::digest(artifact_path.as_bytes()),
                error.kind()
            );
            None
        }
    }
}

#[cfg(feature = "gpu-hmr")]
fn validate_gpu_reload_artifact_content_hash(
    expected_hash: Option<&str>,
    artifact_blob: Option<&ReloadArtifactBlob>,
) -> Result<(), String> {
    let Some(expected_hash) = expected_hash else {
        return Ok(());
    };
    if artifact_blob
        .map(|blob| blob.content_hash.as_str())
        .is_some_and(|observed_hash| observed_hash == expected_hash)
    {
        Ok(())
    } else {
        Err(format!(
            "GPU reload artifact bytes do not match request-bound content hash {expected_hash}"
        ))
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
fn gpu_reload_source_paths(capsule_metadata: Option<&ReloadCapsuleMetadata>) -> Vec<String> {
    capsule_metadata
        .and_then(|metadata| metadata.fission_source_paths.clone())
        .unwrap_or_default()
}

#[cfg(feature = "gpu-hmr")]
#[derive(Debug)]
struct ParsedGpuReloadCommand {
    request_id: Option<String>,
    cold_load: bool,
    partial: bool,
    vendor: String,
    artifact_path: String,
    expected_artifact_content_hash: Option<String>,
    kernels: Vec<String>,
    abi_version: String,
    capsule_metadata: Option<ReloadCapsuleMetadata>,
    source_edit_id: Option<String>,
    command_envelope_sha256: Option<String>,
    runner_challenge: Option<String>,
}

#[cfg(feature = "gpu-hmr")]
fn parse_gpu_reload_command(
    parts: &[&str],
    expected_runner_challenge: Option<&str>,
) -> Result<ParsedGpuReloadCommand, String> {
    if matches!(
        parts.first().copied(),
        Some("gpu_reload_v4" | "gpu_load_v4")
    ) {
        if parts.len() != 3 {
            return Err("GPU reload V4 command must contain request ID and payload".to_string());
        }
        let payload = GpuReloadV4Payload::decode(parts[2])?;
        if parts[1] != payload.request_id {
            return Err("GPU reload V4 command request ID mismatch".to_string());
        }
        let expected_operation = if parts[0] == "gpu_load_v4" {
            "cold_load"
        } else {
            "hot_reload"
        };
        if payload.operation != expected_operation {
            return Err("GPU reload V4 command operation mismatch".to_string());
        }
        if expected_runner_challenge != Some(payload.runner_challenge.as_str()) {
            return Err(
                "GPU reload V4 runner challenge is missing, stale, or mismatched".to_string(),
            );
        }
        if payload.runner_runtime_session_id != runtime_session_id() {
            return Err("GPU reload V4 target runtime session mismatch".to_string());
        }
        let source_edit_id = normalized_reload_source_edit_id(Some(&payload.source_edit_id))
            .ok_or_else(|| "GPU reload V2 source edit identity is invalid".to_string())?;
        let abi_version =
            device_load_abi_version(&payload.kernels, payload.abi_fingerprint.as_deref());
        let capsule_metadata = match payload.capsule_token.as_deref() {
            Some(token) => Some(
                gpu_reload_capsule_metadata_from_token(Some(token))
                    .ok_or_else(|| "GPU reload V4 proof capsule is invalid".to_string())?,
            ),
            None => None,
        };
        if capsule_metadata.as_ref().is_some_and(|metadata| {
            !reload_output_oracle_proof_context_valid_for_reload(
                metadata,
                payload
                    .proof_runtime_session_id
                    .as_deref()
                    .unwrap_or_default(),
                &payload.artifact_content_hash,
                &payload.source_edit_id,
            )
        }) {
            return Err("GPU reload V4 proof capsule/envelope binding mismatch".to_string());
        }
        if capsule_metadata.as_ref().is_some_and(|metadata| {
            !reload_compute_expected_output_semantics_binding_valid(
                metadata,
                payload.compute_expected_output_semantics_hash.as_deref(),
            )
        }) {
            return Err(
                "GPU reload V4 expected-output semantics capsule/envelope binding mismatch"
                    .to_string(),
            );
        }
        return Ok(ParsedGpuReloadCommand {
            request_id: Some(payload.request_id),
            cold_load: payload.operation == "cold_load",
            partial: payload.mode == "partial",
            vendor: payload.vendor,
            artifact_path: payload.artifact_path,
            expected_artifact_content_hash: Some(payload.artifact_content_hash),
            kernels: payload.kernels,
            abi_version,
            capsule_metadata,
            source_edit_id: Some(source_edit_id),
            command_envelope_sha256: Some(payload.envelope_sha256),
            runner_challenge: Some(payload.runner_challenge),
        });
    }

    let command = parts.first().copied().unwrap_or_default();
    if !matches!(command, "load_device" | "load_device_partial") || parts.len() < 3 {
        return Err("legacy GPU reload command format is invalid".to_string());
    }
    if command == "load_device_partial" {
        return Err(
            "legacy partial GPU commands are unsupported; use a challenge-bound V4 hot reload"
                .to_string(),
        );
    }
    if parts.len() > 5 {
        return Err(
            "legacy GPU cold load commands cannot carry proof capsules, edit identities, or content hashes; use the GPU reload V4 envelope"
                .to_string(),
        );
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
    Ok(ParsedGpuReloadCommand {
        request_id: None,
        cold_load: true,
        partial: false,
        vendor: parts[1].to_string(),
        artifact_path: parts[2].to_string(),
        expected_artifact_content_hash: None,
        kernels,
        abi_version,
        capsule_metadata: None,
        source_edit_id: None,
        command_envelope_sha256: None,
        runner_challenge: None,
    })
}

#[cfg(feature = "gpu-hmr")]
fn consume_gpu_protocol_challenge(
    active_challenge: &mut Option<String>,
    command_name: &str,
) -> Option<String> {
    matches!(command_name, "gpu_reload_v4" | "gpu_load_v4")
        .then(|| active_challenge.take())
        .flatten()
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

impl RunnerCommand {
    fn command_name(&self) -> Option<&str> {
        match self {
            Self::Legacy(command) => runner_command_name(command),
            Self::Ipc(message) => match message {
                process_isolation::IpcMessage::LoadModule { .. } => Some("load"),
                process_isolation::IpcMessage::ReloadModule { .. } => Some("reload"),
                process_isolation::IpcMessage::InputEvent { .. }
                | process_isolation::IpcMessage::SendEvent { .. } => Some("input"),
                process_isolation::IpcMessage::Shutdown { .. } => Some("quit"),
                _ => None,
            },
        }
    }

    fn admission_class(&self) -> RunnerCommandAdmissionClass {
        match self {
            Self::Legacy(command)
                if reserved_legacy_runner_command(runner_command_name(command)) =>
            {
                RunnerCommandAdmissionClass::Reserved
            }
            Self::Ipc(
                process_isolation::IpcMessage::LoadModule { .. }
                | process_isolation::IpcMessage::ReloadModule { .. }
                | process_isolation::IpcMessage::RequestSnapshot { .. }
                | process_isolation::IpcMessage::Shutdown { .. }
                | process_isolation::IpcMessage::Ping { .. },
            ) => RunnerCommandAdmissionClass::Reserved,
            _ => RunnerCommandAdmissionClass::General,
        }
    }
}

fn reserved_legacy_runner_command(command_name: Option<&str>) -> bool {
    matches!(
        command_name,
        Some(
            "handshake"
                | "handshake_v5"
                | "set_session"
                | "load"
                | "reload"
                | "unload"
                | "load_device"
                | "load_device_partial"
                | "gpu_load_v4"
                | "gpu_reload_v4"
                | "synthi_pause_runtime_v2"
                | "synthi_resume_runtime_v2"
                | "quit"
        )
    )
}

#[derive(Debug)]
struct AdmittedRunnerCommand {
    command: RunnerCommand,
    _admission_lease: RunnerCommandAdmissionLease,
}

impl AdmittedRunnerCommand {
    fn command_name(&self) -> Option<&str> {
        self.command.command_name()
    }
}

fn admit_runner_command(
    admission: &RunnerCommandAdmission,
    command: RunnerCommand,
    retained_bytes: usize,
) -> Result<
    AdmittedRunnerCommand,
    worker::runtime::runner_command_admission::RunnerCommandAdmissionError,
> {
    let admission_class = command.admission_class();
    let admission_lease = admission.try_admit(retained_bytes, admission_class)?;
    Ok(AdmittedRunnerCommand {
        command,
        _admission_lease: admission_lease,
    })
}

fn send_admitted_runner_command(
    sender: &mpsc::SyncSender<AdmittedRunnerCommand>,
    admission: &RunnerCommandAdmission,
    command: RunnerCommand,
    retained_bytes: usize,
) -> bool {
    let admission_class = command.admission_class();
    let admitted = match admit_runner_command(admission, command, retained_bytes) {
        Ok(admitted) => admitted,
        Err(error)
            if admission_class == RunnerCommandAdmissionClass::General
                && error.is_capacity_exhausted() =>
        {
            eprintln!(
                "[Runner] Dropping general input command after bounded admission refusal: {}",
                error
            );
            return true;
        }
        Err(error) => {
            eprintln!(
                "[Runner] Closing command ingress after fail-closed admission refusal: {}",
                error
            );
            return false;
        }
    };
    if let Err(error) = sender.send(admitted) {
        eprintln!("[Runner] Failed to send admitted command: {}", error);
        return false;
    }
    true
}

fn admitted_runner_command_to_text(command: AdmittedRunnerCommand) -> String {
    runner_command_to_text(command.command)
}

fn take_next_admitted_runner_command(
    receiver: &mpsc::Receiver<AdmittedRunnerCommand>,
    deferred_commands: &mut VecDeque<AdmittedRunnerCommand>,
    gpu_reload_inflight_count: usize,
    work_budget: &mut RunnerCommandWorkBudget,
) -> Option<AdmittedRunnerCommand> {
    if work_budget.exhausted() {
        return None;
    }

    if gpu_reload_inflight_count == 0 {
        if let Some(command) = deferred_commands.pop_front() {
            assert!(work_budget.consume_one());
            return Some(command);
        }
        let command = receiver.try_recv().ok()?;
        assert!(work_budget.consume_one());
        return Some(command);
    }

    // Split each tick's finite inspection budget between newly received and
    // already deferred commands. Rotating blocked commands through the deque
    // prevents either source from starving runtime-control traffic.
    let receiver_scan_limit = work_budget.remaining().saturating_add(1) / 2;
    for _ in 0..receiver_scan_limit {
        let Ok(command) = receiver.try_recv() else {
            break;
        };
        assert!(work_budget.consume_one());
        match command.command_name() {
            Some(name) if should_process_runner_command(name, gpu_reload_inflight_count) => {
                return Some(command);
            }
            Some(_) => deferred_commands.push_back(command),
            None => {}
        }
    }

    let deferred_scan_limit = deferred_commands.len().min(work_budget.remaining());
    for _ in 0..deferred_scan_limit {
        let command = deferred_commands
            .pop_front()
            .expect("deferred scan limit must not exceed queue length");
        assert!(work_budget.consume_one());
        match command.command_name() {
            Some(name) if should_process_runner_command(name, gpu_reload_inflight_count) => {
                return Some(command);
            }
            Some(_) => deferred_commands.push_back(command),
            None => {}
        }
    }

    None
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

fn raw_frame_transport_contract_available(
    target_supports_raw_frames: bool,
    unsafe_in_process: bool,
    worker_managed_display: bool,
    x11_connection_ready: bool,
    shm_capture_ready: bool,
) -> bool {
    target_supports_raw_frames
        && unsafe_in_process
        && !worker_managed_display
        && x11_connection_ready
        && shm_capture_ready
}

fn main() {
    let configured_stdout_mode = std::env::var(RUNNER_STDOUT_MODE_ENV).ok();
    let stdout_mode = match RunnerStdoutMode::parse(configured_stdout_mode.as_deref()) {
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("[Runner] FATAL: invalid stdout mode contract: {error}");
            std::process::exit(1);
        }
    };

    let runner_runtime_control_session_id = match configured_runner_runtime_control_session_id(
        std::env::var(RUNNER_RUNTIME_CONTROL_SESSION_ENV).ok(),
    ) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[Runner] FATAL: {error}");
            std::process::exit(1);
        }
    };

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
    let unsafe_in_process = !execution_mode.is_safe();

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

    #[cfg(target_os = "linux")]
    let raw_frame_transport_available = raw_frame_transport_contract_available(
        true,
        unsafe_in_process,
        worker_managed_display,
        x11_conn.is_some(),
        shm_seg != 0 && !shm_ptr.is_null(),
    );
    #[cfg(not(target_os = "linux"))]
    let raw_frame_transport_available = raw_frame_transport_contract_available(
        false,
        unsafe_in_process,
        worker_managed_display,
        false,
        false,
    );
    let stdout_mode = match stdout_mode.validate_transport_available(raw_frame_transport_available)
    {
        Ok(mode) => mode,
        Err(error) => {
            eprintln!("[Runner] FATAL: invalid stdout mode contract: {error}");
            std::process::exit(1);
        }
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

    let command_admission = RunnerCommandAdmission::at_consumer_maxima();
    let (tx, rx) =
        mpsc::sync_channel::<AdmittedRunnerCommand>(command_admission.channel_capacity());

    // Frame pipe to stdout (non-blocking for the main loop)
    // We keep the channel tiny and drop frames when the pipe is backed up so on_update keeps running.
    #[cfg(target_os = "linux")]
    let (frame_tx, frame_rx) = mpsc::sync_channel::<Vec<u8>>(2);

    // Dedicated writer so rendering never blocks on stdout backpressure
    #[cfg(target_os = "linux")]
    {
        if stdout_mode.writes_raw_frame_bytes() {
            // Only spawn video writer if NOT in ProcessIsolated mode to prevent IPC corruption.
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
                drop(frame_rx);
                debug_log!(
                    "[Runner] Raw video output DISABLED in ProcessIsolated mode (IPC active)"
                );
            }
        } else {
            drop(frame_rx);
            debug_log!("[Runner] Raw video output DISABLED by stdout transport contract");
        }
    }

    // Spawn input reader thread based on execution mode
    let tx_clone = tx.clone();
    let mode_for_thread = execution_mode;
    let command_admission_for_thread = command_admission.clone();

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
                            let retained_bytes = payload.len();
                            // Deserialize MsgPack
                            match decode_msgpack_limited::<process_isolation::IpcMessage>(
                                &payload,
                                &config.decode_limits,
                            ) {
                                Ok(msg) => {
                                    if !send_admitted_runner_command(
                                        &tx_clone,
                                        &command_admission_for_thread,
                                        RunnerCommand::Ipc(msg),
                                        retained_bytes,
                                    ) {
                                        std::process::exit(
                                            RUNNER_COMMAND_INGRESS_FAILURE_EXIT_CODE,
                                        );
                                    }
                                }
                                Err(e) => {
                                    eprintln!("IPC Deserialization error: {:?}", e);
                                    std::process::exit(RUNNER_COMMAND_INGRESS_FAILURE_EXIT_CODE);
                                }
                            }
                        }
                        Err(e) => {
                            // Check if it's EOF
                            if matches!(e, worker::safety::hardened_ipc::IpcError::ConnectionClosed)
                            {
                                debug_log!("IPC connection closed (EOF)");
                            } else {
                                eprintln!("IPC Read error: {:?}", e);
                                std::process::exit(RUNNER_COMMAND_INGRESS_FAILURE_EXIT_CODE);
                            }
                            break;
                        }
                    }
                }
            }
            #[allow(deprecated)]
            process_isolation::ExecutionMode::UnsafeInProcess => {
                // Legacy text reader
                loop {
                    match read_bounded_runner_command_line(
                        &mut handle,
                        command_admission_for_thread.max_command_bytes(),
                    ) {
                        Ok(None) => {
                            debug_log!("Stdin closed (EOF)");
                            break;
                        }
                        Ok(Some(line)) => {
                            let command = match std::str::from_utf8(&line) {
                                Ok(command) => command,
                                Err(error) => {
                                    eprintln!(
                                        "[Runner] Closing command ingress after invalid UTF-8: {}",
                                        error
                                    );
                                    std::process::exit(RUNNER_COMMAND_INGRESS_FAILURE_EXIT_CODE);
                                }
                            };
                            let trimmed = command.trim();
                            if !trimmed.is_empty() {
                                debug_log!(
                                    "Stdin received command {}",
                                    runner_command_log_summary(trimmed)
                                );
                                if !send_admitted_runner_command(
                                    &tx_clone,
                                    &command_admission_for_thread,
                                    RunnerCommand::Legacy(trimmed.to_string()),
                                    trimmed.len(),
                                ) {
                                    std::process::exit(RUNNER_COMMAND_INGRESS_FAILURE_EXIT_CODE);
                                }
                            }
                        }
                        Err(e) => {
                            eprintln!(
                                "[Runner] Closing command ingress after bounded read failure: {}",
                                e
                            );
                            std::process::exit(RUNNER_COMMAND_INGRESS_FAILURE_EXIT_CODE);
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
    let mut deferred_commands: VecDeque<AdmittedRunnerCommand> = VecDeque::new();
    #[cfg(feature = "gpu-hmr")]
    let mut active_gpu_protocol_challenge: Option<String> = None;

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
            if gpu_reload_result_allows_adapter_restore(&completion.result) {
                gpu_adapters.insert(completion.language, completion.adapter);
            } else {
                runtime_paused = true;
                eprintln!(
                    "[Runner] [GPU HMR] Non-recoverable device reload failure; runtime remains paused and adapter was discarded"
                );
            }
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

        // Process a bounded amount of command work before returning to runtime
        // update/render. The budget counts inspected and discarded commands,
        // not only commands that reach a handler.
        let mut command_work_budget = RunnerCommandWorkBudget::at_consumer_maximum();
        while !command_work_budget.exhausted() {
            #[cfg(feature = "gpu-hmr")]
            let gpu_reload_inflight_count = gpu_reload_inflight.len();
            #[cfg(not(feature = "gpu-hmr"))]
            let gpu_reload_inflight_count = 0usize;

            let Some(cmd_wrapper) = take_next_admitted_runner_command(
                &rx,
                &mut deferred_commands,
                gpu_reload_inflight_count,
                &mut command_work_budget,
            ) else {
                break;
            };

            if let Some(command_name) = cmd_wrapper.command_name() {
                if !should_process_runner_command(command_name, gpu_reload_inflight_count) {
                    deferred_commands.push_back(cmd_wrapper);
                    break;
                }
            }
            let cmd = admitted_runner_command_to_text(cmd_wrapper);

            if cmd.is_empty() {
                continue;
            }

            // Route command logs to stderr so stdout stays dedicated to the video stream.
            debug_log!(
                "[Runner] Processing command {}",
                runner_command_log_summary(&cmd)
            );
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }

            match parts[0] {
                "handshake_v5" => {
                    #[cfg(feature = "gpu-hmr")]
                    {
                        let valid = parts.len() == 9
                            && !parts[1].is_empty()
                            && parts[1].len() <= 128
                            && parts[1]
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                            && parts[2].parse::<u32>().ok()
                                == Some(RUNNER_PROTOCOL_CURRENT_VERSION)
                            && parts[3].parse::<u32>().ok()
                                == Some(RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION)
                            && parts[4] == GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY
                            && parts[5] == GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY
                            && parts[6] == GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY
                            && parts[7] == GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY
                            && parts[8] == GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY;
                        if !valid {
                            eprintln!(
                                "[Runner] [GPU HMR] Refusing malformed strict GPU protocol handshake"
                            );
                            continue;
                        }
                        let runner_challenge = uuid::Uuid::new_v4().simple().to_string();
                        active_gpu_protocol_challenge = Some(runner_challenge.clone());
                        match RunnerProtocolAck::current(
                            parts[1],
                            runtime_session_id(),
                            runner_challenge,
                        )
                        .line()
                        {
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
                "synthi_pause_runtime_v2" => {
                    #[cfg(feature = "gpu-hmr")]
                    let gpu_reload_inflight_count = gpu_reload_inflight.len();
                    #[cfg(not(feature = "gpu-hmr"))]
                    let gpu_reload_inflight_count = 0;
                    let ack_line = match runtime_control_command_ack_line(
                        &parts,
                        RunnerRuntimeControlStatus::Paused,
                        true,
                        gpu_reload_inflight_count,
                        &runner_runtime_control_session_id,
                    ) {
                        Ok(line) => line,
                        Err(_) => {
                            eprintln!("[Runner] Runtime-control pause command rejected");
                            continue;
                        }
                    };
                    if !runtime_paused {
                        runtime_paused = true;
                        eprintln!("[Runner] Runtime update/render paused for external HMR work");
                    }
                    eprintln!("{ack_line}");
                }
                "synthi_resume_runtime_v2" => {
                    #[cfg(feature = "gpu-hmr")]
                    let gpu_reload_inflight_count = gpu_reload_inflight.len();
                    #[cfg(not(feature = "gpu-hmr"))]
                    let gpu_reload_inflight_count = 0;
                    let ack_line = match runtime_control_command_ack_line(
                        &parts,
                        RunnerRuntimeControlStatus::Resumed,
                        false,
                        gpu_reload_inflight_count,
                        &runner_runtime_control_session_id,
                    ) {
                        Ok(line) => line,
                        Err(_) => {
                            eprintln!("[Runner] Runtime-control resume command rejected");
                            continue;
                        }
                    };
                    if runtime_paused {
                        runtime_paused = false;
                        eprintln!("[Runner] Runtime update/render resumed");
                    }
                    eprintln!("{ack_line}");
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
                "load_device" | "load_device_partial" | "gpu_reload_v4" | "gpu_load_v4" => {
                    #[cfg(feature = "gpu-hmr")]
                    {
                        let runner_challenge = consume_gpu_protocol_challenge(
                            &mut active_gpu_protocol_challenge,
                            parts.first().copied().unwrap_or_default(),
                        );
                        let parsed = match parse_gpu_reload_command(
                            &parts,
                            runner_challenge.as_deref(),
                        ) {
                            Ok(parsed) => parsed,
                            Err(error) => {
                                eprintln!(
                                    "[Runner] [GPU HMR] Refusing invalid GPU reload command: {error}"
                                );
                                continue;
                            }
                        };
                        let cold_load = parsed.cold_load;
                        let partial_device_load = parsed.partial;
                        let vendor_raw = parsed.vendor.as_str();
                        let artifact_path = parsed.artifact_path.as_str();
                        let expected_artifact_content_hash =
                            parsed.expected_artifact_content_hash.as_deref();
                        let kernels = parsed.kernels;
                        let abi_version = parsed.abi_version;
                        let capsule_metadata = parsed.capsule_metadata;
                        let source_paths = gpu_reload_source_paths(capsule_metadata.as_ref());
                        let terminal_request_id = parsed.request_id.clone();
                        let terminal_source_edit_id = parsed.source_edit_id.clone();
                        let terminal_command_envelope_sha256 =
                            parsed.command_envelope_sha256.clone();
                        let terminal_runner_challenge = parsed.runner_challenge.clone();
                        let source_edit_id = parsed.source_edit_id;
                        let reload_id = parsed.request_id.unwrap_or_else(|| {
                            format!("runner-device-{}-{}", vendor_raw, frame_count)
                        });

                        let (language, vendor) = match vendor_raw {
                            "cuda" => ("cuda", GpuVendor::Cuda),
                            "rocm" | "hip" => ("rocm", GpuVendor::Rocm),
                            other => {
                                let error = format!("Unknown device vendor '{other}'");
                                eprintln!("[Runner] [GPU HMR] {error}");
                                emit_correlated_gpu_command_rejection(
                                    cold_load,
                                    terminal_request_id.as_deref(),
                                    terminal_source_edit_id.as_deref(),
                                    expected_artifact_content_hash,
                                    &error,
                                );
                                continue;
                            }
                        };

                        let active_epoch_exists = gpu_adapters.contains_key(language);
                        if !gpu_reload_operation_matches_epoch(cold_load, active_epoch_exists) {
                            let error = if cold_load {
                                "cold GPU load cannot replace an active device epoch"
                            } else {
                                "hot GPU reload requires an active device epoch"
                            };
                            eprintln!("[Runner] [GPU HMR] {error}");
                            emit_correlated_gpu_command_rejection(
                                cold_load,
                                terminal_request_id.as_deref(),
                                terminal_source_edit_id.as_deref(),
                                expected_artifact_content_hash,
                                error,
                            );
                            continue;
                        }

                        let artifact_blob = gpu_reload_artifact_blob_from_path(artifact_path);
                        if let Err(error) = validate_gpu_reload_artifact_content_hash(
                            expected_artifact_content_hash,
                            artifact_blob.as_ref(),
                        ) {
                            eprintln!("[Runner] [GPU HMR] {error}");
                            emit_correlated_gpu_command_rejection(
                                cold_load,
                                terminal_request_id.as_deref(),
                                terminal_source_edit_id.as_deref(),
                                expected_artifact_content_hash,
                                &error,
                            );
                            continue;
                        }
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

                        let mut req = AdapterReloadRequest::new(
                            reload_id,
                            "device",
                            source_paths,
                            manifest,
                            true,
                            5000,
                        );
                        req.source_edit_id = source_edit_id;
                        req.artifact_blob = artifact_blob;
                        req.capsule_metadata = capsule_metadata;
                        let req = req.into_gpu_device_sidecar_route();
                        let artifact_loader_transport =
                            match gpu_artifact_loader_transport_from_env_for_reload(
                                req.artifact_blob.as_ref(),
                            ) {
                                Ok(transport) => transport,
                                Err(error) => {
                                    eprintln!(
                                        "[Runner] [GPU HMR] Device sidecar reload refused before adapter creation: {error}"
                                    );
                                    if terminal_request_id.is_some()
                                        || terminal_source_edit_id.is_some()
                                    {
                                        emit_correlated_gpu_command_rejection(
                                            cold_load,
                                            terminal_request_id.as_deref(),
                                            terminal_source_edit_id.as_deref(),
                                            expected_artifact_content_hash,
                                            &error,
                                        );
                                    } else {
                                        let status = HmrStatus::rejected_with_fallback(
                                            "device",
                                            &error,
                                            "Correct the GPU artifact loader transport or use a cold reload",
                                        );
                                        eprintln!("[Runner] [HMR-STATUS] {}", status.to_json());
                                    }
                                    continue;
                                }
                            };
                        if expected_artifact_content_hash.is_some()
                            && artifact_loader_transport != ArtifactLoaderTransport::RamBytes
                        {
                            let error = "content-bound GPU command requires RAM artifact bytes after hash verification";
                            eprintln!("[Runner] [GPU HMR] {error}");
                            emit_correlated_gpu_command_rejection(
                                cold_load,
                                terminal_request_id.as_deref(),
                                terminal_source_edit_id.as_deref(),
                                expected_artifact_content_hash,
                                error,
                            );
                            continue;
                        }

                        if gpu_reload_inflight.contains_key(language) {
                            eprintln!(
                                "[Runner] [GPU HMR] Device sidecar reload skipped vendor={} artifact_hash={} kernel_count={} reason=reload-in-flight",
                                language,
                                artifact_hash,
                                kernels.len()
                            );
                            if terminal_request_id.is_some() || terminal_source_edit_id.is_some() {
                                emit_correlated_gpu_command_rejection(
                                    cold_load,
                                    terminal_request_id.as_deref(),
                                    terminal_source_edit_id.as_deref(),
                                    expected_artifact_content_hash,
                                    "GPU sidecar reload already in flight",
                                );
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
                        let kernel_count = kernels.len();
                        gpu_reload_inflight.insert(language_owned.clone(), Instant::now());
                        eprintln!(
                            "[Runner] [GPU HMR] Device sidecar reload started vendor={} artifact_hash={} kernel_count={} partial={}",
                            language_owned,
                            artifact_hash,
                            kernels.len(),
                            partial_device_load
                        );
                        if let Err(error) = adapter.capture_current_context_for_reload() {
                            eprintln!(
                                "[Runner] [GPU HMR] Device context capture failed vendor={}: {}",
                                language, error
                            );
                        }

                        if partial_device_load {
                            let result = catch_gpu_reload_worker_result(|| adapter.reload(&req));
                            let completion = GpuReloadCompletion {
                                language: language_owned,
                                artifact_content_hash: artifact_hash.clone(),
                                kernel_count,
                                cold_load,
                                request_id: terminal_request_id,
                                source_edit_id: terminal_source_edit_id,
                                command_envelope_sha256: terminal_command_envelope_sha256,
                                runner_challenge: terminal_runner_challenge,
                                adapter,
                                result,
                            };
                            emit_gpu_reload_completion(&completion);
                            let GpuReloadCompletion {
                                language,
                                adapter,
                                result,
                                ..
                            } = completion;
                            gpu_reload_inflight.remove(&language);
                            if gpu_reload_result_allows_adapter_restore(&result) {
                                gpu_adapters.insert(language, adapter);
                            } else {
                                runtime_paused = true;
                                eprintln!(
                                    "[Runner] [GPU HMR] Non-recoverable partial device reload failure; runtime remains paused and adapter was discarded"
                                );
                            }
                            continue;
                        }

                        let spawn_failure_language = language_owned.clone();
                        let spawn_failure_request_id = terminal_request_id.clone();
                        let spawn_failure_source_edit_id = terminal_source_edit_id.clone();
                        let spawn_failure_artifact_hash = artifact_hash.clone();
                        let spawn_result = thread::Builder::new()
                            .name("synthi-gpu-reload".to_string())
                            .spawn(move || {
                                let result =
                                    catch_gpu_reload_worker_result(|| adapter.reload(&req));
                                let completion = GpuReloadCompletion {
                                    language: language_owned,
                                    artifact_content_hash: artifact_hash,
                                    kernel_count,
                                    cold_load,
                                    request_id: terminal_request_id,
                                    source_edit_id: terminal_source_edit_id,
                                    command_envelope_sha256: terminal_command_envelope_sha256,
                                    runner_challenge: terminal_runner_challenge,
                                    adapter,
                                    result,
                                };
                                if let Err(error) = completion_tx.send(completion) {
                                    emit_gpu_reload_completion(&error.0);
                                }
                            });
                        if let Err(error) = spawn_result {
                            runtime_paused = true;
                            gpu_reload_inflight.remove(&spawn_failure_language);
                            let reason = format!(
                                "GPU reload worker thread could not start; runtime paused: {error}"
                            );
                            eprintln!("[Runner] [GPU HMR] {reason}");
                            emit_correlated_gpu_command_rejection(
                                cold_load,
                                spawn_failure_request_id.as_deref(),
                                spawn_failure_source_edit_id.as_deref(),
                                Some(spawn_failure_artifact_hash.as_str()),
                                &reason,
                            );
                        }
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
        if stdout_mode.writes_raw_frame_bytes() {
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
        admitted_runner_command_to_text, configured_runner_runtime_control_session_id,
        decode_gpu_kernel_command_token, device_load_abi_version, is_runtime_execution_paused,
        raw_frame_transport_contract_available, runner_command_log_summary,
        runtime_control_command_ack_line, runtime_control_status_line,
        send_admitted_runner_command, should_process_runner_command,
        take_next_admitted_runner_command, RunnerCommand, RunnerRuntimeControlStatus,
    };
    #[cfg(feature = "gpu-hmr")]
    use super::{
        canonical_runner_runtime_ledger_proof_id, catch_gpu_reload_worker_result,
        consume_gpu_protocol_challenge, gpu_artifact_loader_transport_for_reload,
        gpu_reload_artifact_blob_from_path, gpu_reload_capsule_metadata_from_token,
        gpu_reload_operation_matches_epoch, gpu_reload_result_allows_adapter_restore,
        gpu_reload_source_paths, legacy_cold_gpu_artifact_status,
        parse_gpu_artifact_loader_transport, parse_gpu_reload_command, recomputed_runtime_proof_id,
        strict_gpu_reload_terminal_result_with_receipt, validate_gpu_reload_artifact_content_hash,
        AdapterReloadResult, ArtifactLoaderTransport, ReloadArtifactBlob,
        StrictRuntimeOracleReceipt, RUNNER_GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
        RUNNER_GPU_HMR_FULL_RUNTIME_RESULT_STATE, RUNNER_GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER,
        RUNNER_GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION, RUNNER_GPU_HMR_PROOF_SCHEMA_VERSION,
        RUNNER_GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION,
    };
    use std::collections::VecDeque;
    #[cfg(feature = "gpu-hmr")]
    use std::io::Write as _;
    use std::sync::mpsc;
    #[cfg(feature = "gpu-hmr")]
    use std::sync::Arc;
    use worker::runtime::process_isolation::IpcMessage;
    use worker::runtime::runner_command_admission::{
        RunnerCommandAdmission, RunnerCommandAdmissionClass, RunnerCommandAdmissionLimits,
        RunnerCommandAdmissionUsage, RunnerCommandWorkBudget,
    };
    #[cfg(feature = "gpu-hmr")]
    use worker::runtime::runner_protocol::GpuReloadV4Payload;

    fn runtime_control_session_id() -> String {
        format!("runner-control-session:{}", "5".repeat(32))
    }

    fn test_runner_command_admission() -> RunnerCommandAdmission {
        RunnerCommandAdmission::new(RunnerCommandAdmissionLimits {
            max_command_bytes: 64,
            max_queue_items: 4,
            max_queue_retained_bytes: 128,
            reserved_queue_items: 1,
            reserved_queue_retained_bytes: 64,
        })
        .unwrap()
    }

    #[test]
    fn native_runner_reserves_admission_for_non_input_protocol_commands() {
        assert_eq!(
            RunnerCommand::Legacy("input motion 10 20".to_string()).admission_class(),
            RunnerCommandAdmissionClass::General
        );
        assert_eq!(
            RunnerCommand::Legacy("unknown_future_command payload".to_string()).admission_class(),
            RunnerCommandAdmissionClass::General
        );
        for command in [
            "handshake 1",
            "handshake_v5 nonce",
            "set_session session",
            "load core /tmp/core.so",
            "unload core",
            "load_device_partial hip /tmp/device.hsaco",
            "gpu_reload_v4 request payload",
            "synthi_pause_runtime_v2 token",
            "quit",
        ] {
            assert_eq!(
                RunnerCommand::Legacy(command.to_string()).admission_class(),
                RunnerCommandAdmissionClass::Reserved,
                "{command}"
            );
        }
        assert_eq!(
            RunnerCommand::Ipc(IpcMessage::InputEvent {
                kind: 0,
                a: 1,
                b: 2,
                c: 3,
            })
            .admission_class(),
            RunnerCommandAdmissionClass::General
        );
        assert_eq!(
            RunnerCommand::Ipc(IpcMessage::LoadModule {
                slot: "core".to_string(),
                path: "/tmp/core.so".to_string(),
                state_snapshot: None,
            })
            .admission_class(),
            RunnerCommandAdmissionClass::Reserved
        );
    }

    #[test]
    fn native_runner_command_lease_survives_channel_delivery_and_releases_on_consumption() {
        let admission = test_runner_command_admission();
        let (sender, receiver) = mpsc::sync_channel(admission.channel_capacity());
        let wire = "input motion 10 20";
        assert!(send_admitted_runner_command(
            &sender,
            &admission,
            RunnerCommand::Legacy(wire.to_string()),
            wire.len(),
        ));
        assert_eq!(
            admission.usage(),
            RunnerCommandAdmissionUsage {
                retained_items: 1,
                retained_bytes: wire.len() as u64,
                general_retained_items: 1,
                general_retained_bytes: wire.len() as u64,
                reserved_retained_items: 0,
                reserved_retained_bytes: 0,
            }
        );
        let admitted = receiver.recv().unwrap();
        assert_eq!(admission.usage().retained_items, 1);
        assert_eq!(admitted_runner_command_to_text(admitted), wire);
        assert_eq!(
            admission.usage(),
            RunnerCommandAdmissionUsage {
                retained_items: 0,
                retained_bytes: 0,
                general_retained_items: 0,
                general_retained_bytes: 0,
                reserved_retained_items: 0,
                reserved_retained_bytes: 0,
            }
        );

        drop(receiver);
        assert!(!send_admitted_runner_command(
            &sender,
            &admission,
            RunnerCommand::Legacy("quit".to_string()),
            4,
        ));
        assert_eq!(admission.usage().retained_items, 0);
        assert_eq!(admission.usage().retained_bytes, 0);
    }

    #[test]
    fn native_runner_bounds_flood_scans_and_eventually_selects_runtime_control() {
        let admission = RunnerCommandAdmission::new(RunnerCommandAdmissionLimits {
            max_command_bytes: 64,
            max_queue_items: 8,
            max_queue_retained_bytes: 256,
            reserved_queue_items: 2,
            reserved_queue_retained_bytes: 64,
        })
        .unwrap();
        let (sender, receiver) = mpsc::sync_channel(admission.channel_capacity());
        for index in 0..5 {
            let command = format!("input motion {index} {index}");
            assert!(send_admitted_runner_command(
                &sender,
                &admission,
                RunnerCommand::Legacy(command.clone()),
                command.len(),
            ));
        }
        let pause = "synthi_pause_runtime_v2 proof-token";
        assert!(send_admitted_runner_command(
            &sender,
            &admission,
            RunnerCommand::Legacy(pause.to_string()),
            pause.len(),
        ));

        let mut deferred = VecDeque::new();
        for _ in 0..2 {
            let mut budget = RunnerCommandWorkBudget::new(4).unwrap();
            assert!(
                take_next_admitted_runner_command(&receiver, &mut deferred, 1, &mut budget,)
                    .is_none()
            );
            assert!(budget.exhausted());
        }

        let mut budget = RunnerCommandWorkBudget::new(4).unwrap();
        let selected = take_next_admitted_runner_command(&receiver, &mut deferred, 1, &mut budget)
            .expect("bounded scans must eventually reach runtime control");
        assert_eq!(selected.command_name(), Some("synthi_pause_runtime_v2"));
        assert_eq!(admitted_runner_command_to_text(selected), pause);
        assert_eq!(admission.usage().reserved_retained_items, 0);
    }

    #[test]
    fn raw_frame_contract_requires_concrete_self_managed_capture_transport() {
        assert!(raw_frame_transport_contract_available(
            true, true, false, true, true
        ));

        for unavailable in [
            raw_frame_transport_contract_available(false, true, false, true, true),
            raw_frame_transport_contract_available(true, false, false, true, true),
            raw_frame_transport_contract_available(true, true, true, true, true),
            raw_frame_transport_contract_available(true, true, false, false, true),
            raw_frame_transport_contract_available(true, true, false, true, false),
        ] {
            assert!(!unavailable);
        }
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_reload_worker_panic_becomes_an_explicit_failure() {
        let result = catch_gpu_reload_worker_result(|| panic!("simulated worker panic"));
        assert!(!gpu_reload_result_allows_adapter_restore(&result));
        match result {
            AdapterReloadResult::Failed { error, recoverable } => {
                assert!(error.contains("panicked before producing a terminal result"));
                assert!(!recoverable);
            }
            other => panic!("unexpected worker result: {other:?}"),
        }
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn only_non_recoverable_gpu_reload_failures_discard_the_adapter() {
        assert!(!gpu_reload_result_allows_adapter_restore(
            &AdapterReloadResult::Failed {
                error: "runtime state may be corrupt".to_string(),
                recoverable: false,
            }
        ));
        assert!(gpu_reload_result_allows_adapter_restore(
            &AdapterReloadResult::Failed {
                error: "previous epoch restored".to_string(),
                recoverable: true,
            }
        ));
        assert!(gpu_reload_result_allows_adapter_restore(
            &AdapterReloadResult::Unsupported {
                reason: "adapter cannot load this artifact".to_string(),
            }
        ));
    }

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
        let token = format!("runner-control:{}", "3".repeat(32));
        let session_id = runtime_control_session_id();
        let line = runtime_control_status_line(
            RunnerRuntimeControlStatus::Paused,
            &token,
            true,
            2,
            &session_id,
        )
        .unwrap();
        let ack =
            worker::runtime::runner_protocol::parse_runner_runtime_control_ack(&line).unwrap();

        assert_eq!(ack.status, RunnerRuntimeControlStatus::Paused);
        assert_eq!(ack.runtime_control_token, token);
        assert!(ack.runtime_paused);
        assert_eq!(ack.gpu_reload_inflight_count, 2);
        assert_eq!(ack.runner_pid, std::process::id());
        assert_eq!(ack.runner_control_session_id, session_id);
    }

    #[test]
    fn runtime_control_status_line_rejects_untyped_or_contradictory_commands() {
        assert!(runtime_control_status_line(
            RunnerRuntimeControlStatus::Resumed,
            "runner-control-3",
            false,
            0,
            &runtime_control_session_id(),
        )
        .is_err());
        assert!(runtime_control_status_line(
            RunnerRuntimeControlStatus::Paused,
            &format!("runner-control:{}", "3".repeat(32)),
            false,
            0,
            &runtime_control_session_id(),
        )
        .is_err());
    }

    #[test]
    fn runtime_control_session_is_required_and_canonical() {
        assert_eq!(
            configured_runner_runtime_control_session_id(Some(runtime_control_session_id()))
                .unwrap(),
            runtime_control_session_id()
        );
        assert!(configured_runner_runtime_control_session_id(None).is_err());
        assert!(configured_runner_runtime_control_session_id(Some(
            "runner-control-session:short".to_string()
        ))
        .is_err());
    }

    #[test]
    fn runtime_control_command_requires_exact_versioned_shape_before_ack() {
        let token = format!("runner-control:{}", "4".repeat(32));
        let session_id = runtime_control_session_id();
        assert!(runtime_control_command_ack_line(
            &["synthi_pause_runtime_v2", &token],
            RunnerRuntimeControlStatus::Paused,
            true,
            0,
            &session_id,
        )
        .is_ok());
        assert!(runtime_control_command_ack_line(
            &["synthi_pause_runtime_v2"],
            RunnerRuntimeControlStatus::Paused,
            true,
            0,
            &session_id,
        )
        .is_err());
        assert!(runtime_control_command_ack_line(
            &["synthi_pause_runtime_v2", &token, "extra"],
            RunnerRuntimeControlStatus::Paused,
            true,
            0,
            &session_id,
        )
        .is_err());
        assert!(runtime_control_command_ack_line(
            &["synthi_pause_runtime_v2", "runner-control-4"],
            RunnerRuntimeControlStatus::Paused,
            true,
            0,
            &session_id,
        )
        .is_err());
        assert!(runtime_control_command_ack_line(
            &["synthi_pause_runtime", &token],
            RunnerRuntimeControlStatus::Paused,
            true,
            0,
            &session_id,
        )
        .is_err());
        assert!(runtime_control_command_ack_line(
            &["synthi_resume_runtime_v2", &token],
            RunnerRuntimeControlStatus::Paused,
            true,
            0,
            &session_id,
        )
        .is_err());
    }

    #[test]
    fn runner_command_log_summary_never_contains_command_material() {
        let summary = runner_command_log_summary(
            "gpu_reload_v4 sentinel-request sentinel-capsule sentinel-proof-material",
        );
        assert!(!summary.contains("sentinel"));
        assert!(summary.contains("bytes="));
        assert!(summary.contains("sha256=sha256:"));
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
        assert!(should_process_runner_command("synthi_pause_runtime_v2", 1));
        assert!(should_process_runner_command("synthi_resume_runtime_v2", 1));
        assert!(!should_process_runner_command("synthi_pause_runtime", 1));
        assert!(!should_process_runner_command("synthi_resume_runtime", 1));
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
    fn gpu_reload_operation_requires_matching_epoch_state() {
        assert!(gpu_reload_operation_matches_epoch(true, false));
        assert!(gpu_reload_operation_matches_epoch(false, true));
        assert!(!gpu_reload_operation_matches_epoch(true, true));
        assert!(!gpu_reload_operation_matches_epoch(false, false));
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
    fn strict_gpu_reload_rejects_path_bytes_that_do_not_match_request_hash() {
        let expected_bytes = b"compiler-bound-artifact";
        let replaced_bytes = b"path-replaced-artifact";
        let expected_hash = format!(
            "sha256:{}",
            worker::hmr::gpu_proof::sha256_hex_bytes(expected_bytes)
        );
        let replaced_hash = worker::hmr::gpu_proof::sha256_hex_bytes(replaced_bytes);
        let replaced_blob = ReloadArtifactBlob {
            blob_id: format!("artifact:sha256:{replaced_hash}"),
            content_hash: format!("sha256:{replaced_hash}"),
            bytes: replaced_bytes.to_vec(),
        };

        let error =
            validate_gpu_reload_artifact_content_hash(Some(&expected_hash), Some(&replaced_blob))
                .unwrap_err();

        assert!(error.contains("do not match request-bound content hash"));
        assert!(validate_gpu_reload_artifact_content_hash(None, Some(&replaced_blob)).is_ok());
    }

    #[cfg(feature = "gpu-hmr")]
    fn bound_gpu_reload_capsule_token(
        runtime_session_id: &str,
        artifact_content_hash: &str,
        source_edit_id: &str,
    ) -> String {
        bound_gpu_reload_capsule_token_with_contract(
            runtime_session_id,
            artifact_content_hash,
            source_edit_id,
            None,
        )
    }

    #[cfg(feature = "gpu-hmr")]
    fn bound_gpu_reload_capsule_token_with_contract(
        runtime_session_id: &str,
        artifact_content_hash: &str,
        source_edit_id: &str,
        compute_expected_output_contract_v2: Option<
            worker::infra::compute_expected_output_semantics::ComputeExpectedOutputContractV2,
        >,
    ) -> String {
        use worker::hmr::adapter_trait::{
            bind_reload_output_oracle_proof_context, encode_reload_capsule_metadata_token,
            reload_output_oracle_contract_content_hash, ReloadCapsuleMetadata,
            ReloadOutputOracleProfileCommitment,
            RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION,
        };

        let proof_digest = "d".repeat(64);
        let contract = serde_json::json!({
            "kind": "compute_readback",
            "outputTargetId": "output:tensor:0",
            "causalOutputChangeRequired": true,
        });
        let mut metadata =
            ReloadCapsuleMetadata {
                fission_island_id: Some(format!("fission-island:sha256:{}", "1".repeat(64))),
                fission_output_oracle_contract: Some(contract.clone()),
                output_oracle_profile_commitment: Some(ReloadOutputOracleProfileCommitment {
                    schema_version: RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION.into(),
                    candidate_artifact_sha256: artifact_content_hash.to_string(),
                    fission_output_oracle_contract_sha256:
                        reload_output_oracle_contract_content_hash(&contract).unwrap(),
                    profile_bytes_sha256: format!("sha256:{}", "c".repeat(64)),
                    edit_id: source_edit_id.to_string(),
                }),
                compute_expected_output_contract_v2,
                abi_membrane_hash: Some(format!("sha256:{}", "4".repeat(64))),
                dependency_closure_hash: Some(format!("sha256:{}", "5".repeat(64))),
                proof_hash: Some(format!("sha256:{proof_digest}")),
                ..Default::default()
            };
        assert!(bind_reload_output_oracle_proof_context(
            &mut metadata,
            &format!("gpu-proof:{proof_digest}"),
            "2026-07-16T12:00:00.000Z",
            runtime_session_id,
        ));
        encode_reload_capsule_metadata_token(&metadata).expect("bound capsule token")
    }

    #[cfg(feature = "gpu-hmr")]
    fn expected_output_contract_for_reload(
        artifact_content_hash: &str,
        source_edit_id: &str,
        runtime_session_id: &str,
    ) -> worker::infra::compute_expected_output_semantics::ComputeExpectedOutputContractV2 {
        use worker::infra::compute_expected_output_semantics::{
            ComputeExpectedOutputContractBindingV2, ComputeExpectedOutputSemantics,
            COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
        };

        let semantics: ComputeExpectedOutputSemantics =
            serde_json::from_value(serde_json::json!({
                "schemaVersion": COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
                "comparisonMode": "exact_bytes",
                "outputTargetId": "output:tensor:0",
                "byteOffset": 64,
                "byteLength": 16,
                "dtype": "u32",
                "shape": [2, 2],
                "elementCount": 4,
                "byteOrder": "little_endian",
                "toleranceDecimal": "0",
                "expectedValuesDecimal": null,
                "expectedValuesHash": null,
                "expectedRawHash": format!("sha256:{}", "a".repeat(64)),
                "semanticsHash": "sha256:cd7074de01fc4bc0fb0eab922f457e4499c886128cadff30232b7e5f6df3bdde",
            }))
            .expect("canonical expected-output semantics");
        semantics
            .derive_contract_v2(ComputeExpectedOutputContractBindingV2 {
                project_id: "project:protocol-fixture".to_string(),
                edit_id: source_edit_id.to_string(),
                artifact_after_hash: artifact_content_hash.to_string(),
                output_target_id: "output:tensor:0".to_string(),
                oracle_code_hash: format!("sha256:{}", "f".repeat(64)),
                compile_transport_nonce:
                    "gpu-proof-transport-request:0123456789abcdef0123456789abcdef".to_string(),
                runtime_session_id: runtime_session_id.to_string(),
            })
            .expect("derived expected-output contract")
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_reload_capsule_metadata_decodes_runner_protocol_token() {
        let artifact_hash = format!("sha256:{}", "a".repeat(64));
        let source_edit_id = format!("source-edit:sha256:{}", "e".repeat(64));
        let token =
            bound_gpu_reload_capsule_token("runtime-session:test", &artifact_hash, &source_edit_id);

        let metadata =
            gpu_reload_capsule_metadata_from_token(Some(&token)).expect("runner capsule metadata");

        assert_eq!(
            metadata.fission_island_id.as_deref(),
            Some(format!("fission-island:sha256:{}", "1".repeat(64)).as_str())
        );
        assert_eq!(
            metadata.abi_membrane_hash.as_deref(),
            Some(format!("sha256:{}", "4".repeat(64)).as_str())
        );
        assert_eq!(
            metadata.dependency_closure_hash.as_deref(),
            Some(format!("sha256:{}", "5".repeat(64)).as_str())
        );
        assert_eq!(
            metadata.proof_hash.as_deref(),
            Some(format!("sha256:{}", "d".repeat(64)).as_str())
        );
        assert!(gpu_reload_capsule_metadata_from_token(Some("-")).is_none());
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_reload_v4_parser_rejects_replayed_capsule_or_envelope_identity() {
        let artifact_hash = format!("sha256:{}", "a".repeat(64));
        let source_edit_id = format!("source-edit:sha256:{}", "e".repeat(64));
        let runner_challenge = "6".repeat(32);
        let runner_session = super::runtime_session_id().to_string();
        let capsule =
            bound_gpu_reload_capsule_token("runtime-session:a", &artifact_hash, &source_edit_id);
        let make_payload = |session: &str, artifact_hash: String, source_edit_id: String| {
            GpuReloadV4Payload::new(
                format!("gpu-reload:request:{}", "6".repeat(32)),
                "hot_reload",
                "partial",
                "rocm",
                "/tmp/device.hsaco",
                artifact_hash,
                vec!["gpu::shade".to_string()],
                Some("sha256:abi".to_string()),
                Some(capsule.clone()),
                source_edit_id,
                Some(session.to_string()),
                None,
                runner_session.clone(),
                runner_challenge.clone(),
            )
            .unwrap()
        };
        let parse = |payload: &GpuReloadV4Payload| {
            let encoded = payload.encode().unwrap();
            parse_gpu_reload_command(
                &[
                    "gpu_reload_v4",
                    payload.request_id.as_str(),
                    encoded.as_str(),
                ],
                Some(&runner_challenge),
            )
        };

        let accepted = make_payload(
            "runtime-session:a",
            artifact_hash.clone(),
            source_edit_id.clone(),
        );
        assert!(parse(&accepted).is_ok());

        let wrong_session = make_payload(
            "runtime-session:b",
            artifact_hash.clone(),
            source_edit_id.clone(),
        );
        assert!(parse(&wrong_session)
            .unwrap_err()
            .contains("capsule/envelope binding mismatch"));

        let wrong_artifact = make_payload(
            "runtime-session:a",
            format!("sha256:{}", "b".repeat(64)),
            source_edit_id.clone(),
        );
        assert!(parse(&wrong_artifact)
            .unwrap_err()
            .contains("capsule/envelope binding mismatch"));

        let wrong_edit = make_payload(
            "runtime-session:a",
            artifact_hash,
            format!("source-edit:sha256:{}", "f".repeat(64)),
        );
        assert!(parse(&wrong_edit)
            .unwrap_err()
            .contains("capsule/envelope binding mismatch"));

        let encoded = accepted.encode().unwrap();
        assert!(parse_gpu_reload_command(
            &[
                "gpu_load_v4",
                accepted.request_id.as_str(),
                encoded.as_str(),
            ],
            Some(&runner_challenge),
        )
        .unwrap_err()
        .contains("operation mismatch"));
        assert!(parse_gpu_reload_command(
            &[
                "gpu_reload_v4",
                accepted.request_id.as_str(),
                encoded.as_str(),
            ],
            Some("77777777777777777777777777777777"),
        )
        .unwrap_err()
        .contains("challenge"));

        let wrong_target_session = GpuReloadV4Payload::new(
            accepted.request_id.clone(),
            "hot_reload",
            "partial",
            "rocm",
            "/tmp/device.hsaco",
            accepted.artifact_content_hash.clone(),
            vec!["gpu::shade".to_string()],
            Some("sha256:abi".to_string()),
            accepted.capsule_token.clone(),
            accepted.source_edit_id.clone(),
            accepted.proof_runtime_session_id.clone(),
            accepted.compute_expected_output_semantics_hash.clone(),
            "pid:999999:boot:11111111111111111111111111111111".to_string(),
            runner_challenge.clone(),
        )
        .unwrap();
        assert!(parse(&wrong_target_session)
            .unwrap_err()
            .contains("target runtime session mismatch"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_reload_v4_parser_requires_exact_expected_output_semantics_binding() {
        let artifact_hash = format!("sha256:{}", "a".repeat(64));
        let source_edit_id = format!("source-edit:sha256:{}", "e".repeat(64));
        let proof_session = "runtime-session:semantics";
        let runner_challenge = "7".repeat(32);
        let expected_contract =
            expected_output_contract_for_reload(&artifact_hash, &source_edit_id, proof_session);
        let expected_semantics_hash = expected_contract.semantics().semantics_hash().to_string();
        let contract_capsule = bound_gpu_reload_capsule_token_with_contract(
            proof_session,
            &artifact_hash,
            &source_edit_id,
            Some(expected_contract),
        );
        let legacy_capsule =
            bound_gpu_reload_capsule_token(proof_session, &artifact_hash, &source_edit_id);
        let make_payload = |capsule: String, semantics_hash: Option<String>| {
            GpuReloadV4Payload::new(
                format!("gpu-reload:request:{}", "7".repeat(32)),
                "hot_reload",
                "partial",
                "rocm",
                "/tmp/device.hsaco",
                artifact_hash.clone(),
                vec!["gpu::shade".to_string()],
                Some("sha256:abi".to_string()),
                Some(capsule),
                source_edit_id.clone(),
                Some(proof_session.to_string()),
                semantics_hash,
                super::runtime_session_id().to_string(),
                runner_challenge.clone(),
            )
            .unwrap()
        };
        let parse = |payload: &GpuReloadV4Payload| {
            let encoded = payload.encode().unwrap();
            parse_gpu_reload_command(
                &[
                    "gpu_reload_v4",
                    payload.request_id.as_str(),
                    encoded.as_str(),
                ],
                Some(&runner_challenge),
            )
        };

        let accepted = make_payload(
            contract_capsule.clone(),
            Some(expected_semantics_hash.clone()),
        );
        assert!(parse(&accepted).is_ok());

        for rejected in [
            make_payload(contract_capsule.clone(), None),
            make_payload(contract_capsule, Some(format!("sha256:{}", "b".repeat(64)))),
            make_payload(legacy_capsule, Some(expected_semantics_hash)),
        ] {
            assert!(parse(&rejected)
                .unwrap_err()
                .contains("expected-output semantics capsule/envelope binding mismatch"));
        }
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn gpu_protocol_challenge_is_consumed_exactly_once() {
        let challenge = "8".repeat(32);
        let mut active = Some(challenge.clone());

        assert!(consume_gpu_protocol_challenge(&mut active, "load_device").is_none());
        assert_eq!(active.as_deref(), Some(challenge.as_str()));
        assert_eq!(
            consume_gpu_protocol_challenge(&mut active, "gpu_reload_v4").as_deref(),
            Some(challenge.as_str())
        );
        assert!(active.is_none());
        assert!(consume_gpu_protocol_challenge(&mut active, "gpu_reload_v4").is_none());
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
    fn gpu_reload_v4_parser_preserves_independent_identity_and_typed_fields() {
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let artifact_hash = format!("sha256:{}", "b".repeat(64));
        let proof_session = "runtime-session:test";
        let runner_challenge = "1".repeat(32);
        let capsule =
            bound_gpu_reload_capsule_token(proof_session, &artifact_hash, &source_edit_id);
        let payload = GpuReloadV4Payload::new(
            format!("gpu-reload:request:{}", "1".repeat(32)),
            "hot_reload",
            "partial",
            "rocm",
            "/tmp/path with space/device.hsaco",
            artifact_hash,
            vec!["gpu::shade".to_string()],
            Some("sha256:abi".to_string()),
            Some(capsule),
            source_edit_id.clone(),
            Some(proof_session.to_string()),
            None,
            super::runtime_session_id().to_string(),
            runner_challenge.clone(),
        )
        .unwrap();
        let encoded = payload.encode().unwrap();
        let parts = [
            "gpu_reload_v4",
            payload.request_id.as_str(),
            encoded.as_str(),
        ];
        let parsed = parse_gpu_reload_command(&parts, Some(&runner_challenge)).unwrap();
        assert!(!parsed.cold_load);
        assert_eq!(
            parsed.request_id.as_deref(),
            Some(payload.request_id.as_str())
        );
        assert!(parsed.partial);
        assert_eq!(parsed.vendor, "rocm");
        assert_eq!(parsed.artifact_path, "/tmp/path with space/device.hsaco");
        assert_eq!(
            parsed.expected_artifact_content_hash.as_deref(),
            Some(format!("sha256:{}", "b".repeat(64)).as_str())
        );
        assert_eq!(parsed.kernels, vec!["gpu::shade"]);
        assert_eq!(parsed.abi_version, "sha256:abi");
        assert_eq!(
            parsed.source_edit_id.as_deref(),
            Some(source_edit_id.as_str())
        );
        assert_eq!(
            parsed.command_envelope_sha256.as_deref(),
            Some(payload.envelope_sha256.as_str())
        );
        assert_eq!(
            parsed.runner_challenge.as_deref(),
            Some(runner_challenge.as_str())
        );
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn legacy_gpu_reload_rejects_hash_bearing_commands_without_strict_identity() {
        let artifact_hash = format!("sha256:{}", "a".repeat(64));
        let parts = [
            "load_device",
            "rocm",
            "/tmp/device.hsaco",
            "shade",
            "sha256:abi",
            "-",
            artifact_hash.as_str(),
        ];
        let error = parse_gpu_reload_command(&parts, None).unwrap_err();
        assert!(error.contains("cannot carry proof capsules"));
        assert!(error.contains("V4"));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn legacy_gpu_commands_are_cold_only_and_never_claim_hmr_success() {
        let parsed = parse_gpu_reload_command(
            &[
                "load_device",
                "rocm",
                "/tmp/device.hsaco",
                "shade",
                "sha256:abi",
            ],
            None,
        )
        .unwrap();
        assert!(parsed.cold_load);
        assert!(!parsed.partial);
        assert!(parsed.request_id.is_none());
        assert!(parsed.source_edit_id.is_none());
        assert!(parsed.expected_artifact_content_hash.is_none());
        assert!(gpu_reload_operation_matches_epoch(parsed.cold_load, false));
        assert!(!gpu_reload_operation_matches_epoch(parsed.cold_load, true));

        let partial_error = parse_gpu_reload_command(
            &[
                "load_device_partial",
                "rocm",
                "/tmp/device.hsaco",
                "shade",
                "sha256:abi",
            ],
            None,
        )
        .unwrap_err();
        assert!(partial_error.contains("legacy partial GPU commands are unsupported"));
        assert!(partial_error.contains("V4"));

        let status = legacy_cold_gpu_artifact_status(
            &format!("sha256:{}", "a".repeat(64)),
            &AdapterReloadResult::Success {
                reload_ms: 1,
                state_preserved: false,
            },
        );
        let status: serde_json::Value = serde_json::from_str(&status).unwrap();
        assert_eq!(status["status"], "gpu-artifact-loaded");
        assert_eq!(status["loadKind"], "cold_legacy_compatibility");
        assert_eq!(status["acceptedForGpuHmr"], false);
        assert_eq!(status["gpuHmrSuccess"], false);
        assert_ne!(status["status"], "applied");
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn cold_gpu_load_v4_preserves_correlation_without_claiming_hot_reload() {
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let runner_challenge = "4".repeat(32);
        let payload = GpuReloadV4Payload::new(
            format!("gpu-reload:request:{}", "4".repeat(32)),
            "cold_load",
            "full",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            vec!["shade".to_string()],
            Some("sha256:abi".to_string()),
            None,
            source_edit_id,
            None,
            None,
            super::runtime_session_id().to_string(),
            runner_challenge.clone(),
        )
        .unwrap();
        let encoded = payload.encode().unwrap();
        let parts = ["gpu_load_v4", payload.request_id.as_str(), encoded.as_str()];
        let parsed = parse_gpu_reload_command(&parts, Some(&runner_challenge)).unwrap();
        assert!(parsed.cold_load);
        assert_eq!(
            parsed.request_id.as_deref(),
            Some(payload.request_id.as_str())
        );
        assert_eq!(
            parsed.expected_artifact_content_hash.as_deref(),
            Some(payload.artifact_content_hash.as_str())
        );
    }

    #[cfg(feature = "gpu-hmr")]
    fn strict_runtime_proof_fixture(
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        process_id: &str,
        runtime_session_id: &str,
    ) -> (serde_json::Value, String, StrictRuntimeOracleReceipt) {
        let artifact_id = format!(
            "artifact:sha256:{}",
            artifact_content_hash.trim_start_matches("sha256:")
        );
        let previous_artifact_id = format!("artifact:sha256:{}", "0".repeat(64));
        let dispatch_id = format!("dispatch:sha256:{}", "6".repeat(64));
        let publication_id = format!("dispatcher-publication:sha256:{}", "8".repeat(64));
        let dispatcher_registration_id = format!("dispatcher:sha256:{}", "9".repeat(64));
        let dispatch_table_hash = format!("sha256:{}", "a".repeat(64));
        let dispatch_table_entry_id = "generic_kernel:0x1000";
        let oracle_id = "output:2";
        let output_target_id = "buffer:output";
        let output_buffer_name = "output";
        let readback_bytes = (0..1_250)
            .flat_map(|index| ((index as f32 * 0.25) + 1.0).to_le_bytes())
            .collect::<Vec<_>>();
        let observed_sha256 = format!(
            "sha256:{}",
            worker::hmr::gpu_proof::sha256_hex_bytes(&readback_bytes)
        );
        let baseline_sha256 = format!(
            "sha256:{}",
            worker::hmr::gpu_proof::sha256_hex_bytes(&vec![0u8; readback_bytes.len()])
        );
        let deterministic_slice_offset = 0usize;
        let deterministic_slice_length = 4_096usize;
        let deterministic_slice_stride = 1usize;
        let deterministic_slice_sha256 = format!(
            "sha256:{}",
            worker::hmr::gpu_proof::sha256_hex_bytes(&readback_bytes[..deterministic_slice_length])
        );
        let readback_schema = serde_json::json!({
            "schemaVersion": super::HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
            "elementType": "f32",
            "elementCount": 1_250,
            "elementByteWidth": 4,
            "endianness": "little",
            "byteLength": readback_bytes.len(),
        });
        let readback_schema_material = format!(
            "{{\"schemaVersion\":\"{}\",\"elementType\":\"f32\",\"elementCount\":1250,\"elementByteWidth\":4,\"endianness\":\"little\",\"byteLength\":{}}}",
            super::HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
            readback_bytes.len()
        );
        let readback_schema_sha256 = format!(
            "sha256:{}",
            worker::hmr::gpu_proof::sha256_hex_bytes(readback_schema_material.as_bytes())
        );
        let profile_schema_version = "synthi.gpu_hmr.runtime_output_oracle_profile.v1";
        let profile_id = "runtime-output-oracle:generic-compute";
        let profile_bytes_sha256 = format!("sha256:{}", "c".repeat(64));
        let contract_sha256 = format!("sha256:{}", "d".repeat(64));
        let proof_context_binding_sha256 = Some(format!("sha256:{}", "e".repeat(64)));
        let proof_context_proof_id = Some(format!("gpu-proof:{}", "f".repeat(64)));
        let probe_mode = "runtime_profile_dispatch";
        let probe_config_hash = format!("sha256:{}", "7".repeat(64));
        let probe_evidence_ref = "host-receipt://generic-compute/readback";
        let receipt_id = format!(
            "host-output-oracle-receipt:sha256:{}",
            worker::hmr::gpu_proof::sha256_hex_bytes(
                format!("{request_id}:{source_edit_id}:{artifact_content_hash}:{dispatch_id}")
                    .as_bytes()
            )
        );
        let oracle_artifacts = serde_json::json!({
            "raw_readback_bin": format!("host-receipt://{receipt_id}/raw"),
            "readback_schema_json": format!("host-receipt://{receipt_id}/schema"),
            "readback_schema": readback_schema,
            "readback_schema_hash": readback_schema_sha256,
            "checksum_before": baseline_sha256,
            "checksum_after": observed_sha256,
            "raw_readback_hash": observed_sha256,
            "raw_readback_hash_verified": true,
            "raw_readback_source": "host_verified_full_dtoh_receipt",
            "raw_readback_byte_length": readback_bytes.len(),
            "raw_readback_verification": {
                "hash_verified": true,
                "raw_readback_hash_verified": true,
                "raw_readback_byte_length": readback_bytes.len(),
                "deterministic_slice_hash_verified": true,
                "authority": super::HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY,
            },
            "deterministic_slice": {
                "offset": deterministic_slice_offset,
                "length": deterministic_slice_length,
                "stride": deterministic_slice_stride,
                "source": "host_verified_full_dtoh_receipt",
            },
            "deterministic_slice_hash": deterministic_slice_sha256,
            "deterministic_slice_hash_verified": true,
            "oracle_code_hash": probe_config_hash,
            "rendered_card_png": serde_json::Value::Null,
            "rendered_card_required_for_machine_acceptance": false,
            "producer": "worker.gpu_module_adapter",
            "timestamp_after_dispatch": 40,
            "epoch": "2",
            "output_after_dispatch_id": dispatch_id,
            "host_receipt_id": receipt_id,
            "host_receipt_schema": super::HOST_OUTPUT_ORACLE_RECEIPT_SCHEMA,
            "host_receipt_authority": super::HOST_OUTPUT_ORACLE_RECEIPT_AUTHORITY,
            "dispatcher_publication_id": publication_id,
            "dispatcher_previous_generation": 1,
            "dispatcher_publication_timestamp_monotonic_ns": 20,
            "dispatcher_publication_committed_timestamp_monotonic_ns": 45,
            "dispatcher_registration_id": dispatcher_registration_id,
            "dispatch_table_hash": dispatch_table_hash,
            "dispatch_table_entry_id": dispatch_table_entry_id,
            "profile_id": profile_id,
            "profile_schema_version": profile_schema_version,
            "profile_bytes_sha256": profile_bytes_sha256,
            "fission_output_oracle_contract_sha256": contract_sha256,
            "proof_context_binding_sha256": proof_context_binding_sha256,
            "proof_context_proof_id": proof_context_proof_id,
            "probe_mode": probe_mode,
            "probe_evidence_ref": probe_evidence_ref,
            "output_buffer_name": output_buffer_name,
        });
        let output_oracle_target = serde_json::json!({
            "kind": "compute",
            "target_id": output_target_id,
            "compute_only_target_verified": true,
        });
        let oracle_receipt = StrictRuntimeOracleReceipt {
            receipt_id: receipt_id.clone(),
            request_id: request_id.to_string(),
            source_edit_id: source_edit_id.to_string(),
            runtime_session_id: runtime_session_id.to_string(),
            process_id: process_id.parse().unwrap_or_default(),
            artifact_content_hash: artifact_content_hash.to_string(),
            artifact_id: artifact_id.clone(),
            generation: 2,
            dispatcher_registration_id: dispatcher_registration_id.clone(),
            dispatch_table_hash: dispatch_table_hash.clone(),
            dispatch_table_entry_id: dispatch_table_entry_id.to_string(),
            publication_id: publication_id.clone(),
            previous_generation: 1,
            publication_timestamp_monotonic_ns: 20,
            publication_committed_timestamp_monotonic_ns: 45,
            dispatch_id: dispatch_id.to_string(),
            dispatch_timestamp_monotonic_ns: 30,
            readback_timestamp_monotonic_ns: 40,
            stream_token: 17,
            profile_schema_version: profile_schema_version.to_string(),
            profile_id: profile_id.to_string(),
            profile_bytes_sha256: profile_bytes_sha256.clone(),
            contract_sha256: contract_sha256.clone(),
            proof_context_binding_sha256: proof_context_binding_sha256.clone(),
            proof_context_proof_id: proof_context_proof_id.clone(),
            oracle_id: oracle_id.to_string(),
            producer: "worker.gpu_module_adapter".to_string(),
            output_target_id: output_target_id.to_string(),
            output_buffer_name: output_buffer_name.to_string(),
            baseline_sha256: baseline_sha256.clone(),
            expected_sha256: observed_sha256.clone(),
            observed_sha256: observed_sha256.clone(),
            probe_mode: probe_mode.to_string(),
            probe_config_hash: probe_config_hash.clone(),
            probe_evidence_ref: probe_evidence_ref.to_string(),
            readback_schema: readback_schema.clone(),
            readback_schema_sha256: readback_schema_sha256.clone(),
            recomputed_readback_schema_sha256: readback_schema_sha256.clone(),
            deterministic_slice_offset,
            deterministic_slice_length,
            deterministic_slice_stride,
            deterministic_slice_sha256: deterministic_slice_sha256.clone(),
            readback_bytes: Arc::from(readback_bytes.into_boxed_slice()),
        };
        let evidence_refs = vec![
            format!("reload:{request_id}"),
            format!("source-edit-id:{source_edit_id}"),
            publication_id.clone(),
            dispatcher_registration_id.clone(),
        ];
        let record = serde_json::json!({
            "schemaVersion": RUNNER_GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
            "proof_canonical_profile": super::RUNNER_GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE,
            "project_id": "content-bound-fixture",
            "edit_id": source_edit_id,
            "backend": "rocm",
            "classification": {
                "project_kind": "gpu_project",
                "edit_kind": "gpu_artifact_edit",
                "route": "gpu_hmr",
            },
            "contract_hash": format!("sha256:{}", "1".repeat(64)),
            "artifact_before_hash": previous_artifact_id,
            "artifact_after_hash": artifact_id,
            "loader_event": {
                "id": "loader:2",
                "artifact_id": artifact_id,
                "artifact_hash": artifact_id,
                "timestamp_monotonic_ns": 10,
                "process_id": process_id,
            },
            "epoch_publish_event": {
                "id": "epoch:2",
                "event": "provisional_install",
                "publication_id": publication_id,
                "candidate_registration_id": dispatcher_registration_id,
                "dispatcher_registration_id": dispatcher_registration_id,
                "epoch": "2",
                "previous_epoch": "1",
                "artifact_id": artifact_id,
                "artifact_hash": artifact_id,
                "timestamp_monotonic_ns": 20,
                "committed_timestamp_monotonic_ns": 45,
                "process_id": process_id,
            },
            "epoch_commit_event": {
                "id": "epoch-commit:2",
                "event": "unrestricted_visibility_commit",
                "publication_id": publication_id,
                "candidate_registration_id": dispatcher_registration_id,
                "epoch": "2",
                "previous_epoch": "1",
                "artifact_id": artifact_id,
                "artifact_hash": artifact_id,
                "timestamp_monotonic_ns": 45,
                "process_id": process_id,
            },
            "dispatch_event": {
                "id": dispatch_id,
                "publication_id": publication_id,
                "dispatcher_registration_id": dispatcher_registration_id,
                "epoch": "2",
                "artifact_id": artifact_id,
                "artifact_hash": artifact_id,
                "dispatch_table_hash": dispatch_table_hash,
                "dispatch_table_entry_id": dispatch_table_entry_id,
                "timestamp_monotonic_ns": 30,
                "process_id": process_id,
            },
            "output_event": {
                "id": oracle_id,
                "passed": true,
                "after_dispatch_id": dispatch_id,
                "epoch": "2",
                "artifact_id": artifact_id,
                "artifact_hash": artifact_id,
                "timestamp_monotonic_ns": 40,
                "process_id": process_id,
                "output_oracle": {
                    "oracle_id": oracle_id,
                    "kind": "buffer_checksum",
                    "expected": observed_sha256,
                    "actual": observed_sha256,
                    "passed": true,
                    "output_oracle_target": output_oracle_target,
                    "oracle_artifacts": oracle_artifacts,
                },
                "oracle_artifacts": oracle_artifacts,
            },
            "retirement_event": {
                "id": "retirement:1",
                "epoch": "1",
                "artifact_id": previous_artifact_id,
                "artifact_hash": previous_artifact_id,
                "status": "retired_after_quiescent",
                "retirement_proof": "stream_event_proven",
                "retirement_strategy": "epoch_fence",
                "timestamp_monotonic_ns": 50,
                "process_id": process_id,
            },
            "process_identity": {
                "process_id": process_id,
                "runtime_session_id": runtime_session_id,
            },
            "device_identity": {
                "dispatch_stream_token": 17,
            },
            "oracle_artifacts": oracle_artifacts,
            "output_oracle_target": output_oracle_target,
            "cpu_hmr_used": false,
            "full_rebuild_used": false,
            "process_restarted": false,
            "firewall_evidence": {
                "cpu_hmr_used": false,
                "full_rebuild_used": false,
                "process_restarted": false,
                "process_id_before": process_id,
                "process_id_after": process_id,
            },
            "evidence_refs": evidence_refs,
        });
        let ledger_proof_id = canonical_runner_runtime_ledger_proof_id(&record);
        let proof_ledger = serde_json::json!({
            "schemaVersion": RUNNER_GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
            "proofId": ledger_proof_id,
            "gpuHmrSuccess": true,
            "records": [record],
        });
        let acceptance_contract = serde_json::json!({
            "contract_version": RUNNER_GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
            "edit_id": source_edit_id,
            "artifact_hash_before": previous_artifact_id,
            "artifact_hash_after": artifact_id,
        });
        let runtime_trace = serde_json::json!({
            "runtimeSessionId": runtime_session_id,
            "processId": process_id,
        });
        let mut runtime_artifact = serde_json::json!({
            "schemaVersion": RUNNER_GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION,
            "proofId": "pending",
            "resultState": RUNNER_GPU_HMR_FULL_RUNTIME_RESULT_STATE,
            "fullRuntimeProven": true,
            "gpuHmrSuccess": true,
            "stageResults": [],
            "limitations": [],
            "proofLedger": proof_ledger,
            "proofLedgerQuery": {
                "schemaVersion": RUNNER_GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
                "proofId": ledger_proof_id,
                "gpuHmrSuccess": true,
                "failedInvariants": [],
            },
            "runtimeTrace": runtime_trace,
            "acceptanceContract": acceptance_contract,
            "derivedAcceptanceContract": acceptance_contract,
            "acceptanceContractEvaluation": { "accepted": true, "failedGates": [] },
            "acceptanceContractConsistency": { "accepted": true, "failedGates": [] },
            "derivedAcceptanceContractEvaluation": { "accepted": true, "failedGates": [] },
            "explicitProofLedgerRecord": record,
            "derivedProofLedgerRecord": record,
            "proofLedgerSourceConsistency": { "accepted": true, "failures": [] },
        });
        let proof_id = recomputed_runtime_proof_id(&runtime_artifact, &record).unwrap();
        runtime_artifact["proofId"] = serde_json::Value::String(proof_id.clone());
        let proof = serde_json::json!({
            "type": "gpu_hmr_proof",
            "schemaVersion": RUNNER_GPU_HMR_PROOF_SCHEMA_VERSION,
            "module": "device",
            "resultState": RUNNER_GPU_HMR_FULL_RUNTIME_RESULT_STATE,
            "proofId": proof_id,
            "proofLedger": proof_ledger,
            "runtimeProofArtifact": runtime_artifact,
        });
        (proof, proof_id, oracle_receipt)
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn strict_gpu_reload_terminal_recomputes_artifact_bound_full_runtime_proof() {
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let request_id = format!("gpu-reload:request:{}", "2".repeat(32));
        let artifact_content_hash = format!("sha256:{}", "b".repeat(64));
        let live_process_id = std::process::id().to_string();
        let live_runtime_session_id = super::runtime_session_id().to_string();
        let command_envelope_sha256 = format!("sha256:{}", "6".repeat(64));
        let runner_challenge = "7".repeat(32);
        let (proof, proof_id, oracle_receipt) = strict_runtime_proof_fixture(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &live_process_id,
            &live_runtime_session_id,
        );
        let success = AdapterReloadResult::Success {
            reload_ms: 1,
            state_preserved: true,
        };

        let terminal = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&oracle_receipt),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(terminal.status, "applied");
        assert_eq!(
            terminal.full_runtime_proof_id.as_deref(),
            Some(proof_id.as_str())
        );
        assert!(terminal.gpu_hmr_success);

        assert_eq!(terminal.artifact_content_hash, artifact_content_hash);
        let material = terminal
            .runtime_proof_material
            .as_ref()
            .expect("applied terminal must carry protected proof material");
        assert!(material.matches_runner_context(
            std::process::id(),
            &live_runtime_session_id,
            &runner_challenge,
        ));
        assert_eq!(
            material
                .decode_for(
                    &request_id,
                    &source_edit_id,
                    &artifact_content_hash,
                    &proof_id,
                    &command_envelope_sha256,
                )
                .unwrap(),
            proof
        );

        let parsed_proof = proof.clone();
        let mut conflicting_outer_id = parsed_proof.clone();
        conflicting_outer_id["proof_id"] = serde_json::json!("gpu-runtime-proof:stale");
        let mut conflicting_artifact_id = parsed_proof.clone();
        conflicting_artifact_id["runtimeProofArtifact"]["proof_id"] =
            serde_json::json!("gpu-runtime-proof:stale");
        let mut conflicting_query_id = parsed_proof.clone();
        conflicting_query_id["runtimeProofArtifact"]["proofLedgerQuery"]["proof_id"] =
            serde_json::json!("gpu-ledger-proof:stale");
        for replay in [
            conflicting_outer_id,
            conflicting_artifact_id,
            conflicting_query_id,
        ] {
            let rejected = strict_gpu_reload_terminal_result_with_receipt(
                &request_id,
                &source_edit_id,
                &artifact_content_hash,
                &success,
                Some(&replay),
                Some(&oracle_receipt),
                Some(&command_envelope_sha256),
                Some(&runner_challenge),
            )
            .unwrap();
            assert_eq!(rejected.status, "rejected");
            assert!(!rejected.gpu_hmr_success);
        }

        for (evaluation, failure_field) in [
            ("acceptanceContractEvaluation", "failedGates"),
            ("acceptanceContractConsistency", "failedGates"),
            ("derivedAcceptanceContractEvaluation", "failedGates"),
            ("proofLedgerSourceConsistency", "failures"),
        ] {
            let mut contradictory = proof.clone();
            contradictory["runtimeProofArtifact"][evaluation][failure_field] =
                serde_json::json!(["generic_strict_gate_failed"]);
            let rejected = strict_gpu_reload_terminal_result_with_receipt(
                &request_id,
                &source_edit_id,
                &artifact_content_hash,
                &success,
                Some(&contradictory),
                Some(&oracle_receipt),
                Some(&command_envelope_sha256),
                Some(&runner_challenge),
            )
            .unwrap();
            assert_eq!(rejected.status, "rejected");
            assert!(!rejected.gpu_hmr_success);
        }

        let mut missing_query_schema = parsed_proof;
        missing_query_schema["runtimeProofArtifact"]["proofLedgerQuery"]
            .as_object_mut()
            .unwrap()
            .remove("schemaVersion");
        let rejected = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&missing_query_schema),
            Some(&oracle_receipt),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert!(!rejected.gpu_hmr_success);

        let success_shaped_log_line = proof.to_string();
        assert!(success_shaped_log_line.contains("\"type\":\"gpu_hmr_proof\""));
        let log_only = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            None,
            Some(&oracle_receipt),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(log_only.status, "rejected");
        assert!(!log_only.gpu_hmr_success);

        let missing_command_envelope = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&oracle_receipt),
            None,
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(missing_command_envelope.status, "rejected");
        assert!(!missing_command_envelope.gpu_hmr_success);

        let missing_runner_challenge = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&oracle_receipt),
            Some(&command_envelope_sha256),
            None,
        )
        .unwrap();
        assert_eq!(missing_runner_challenge.status, "rejected");
        assert!(!missing_runner_challenge.gpu_hmr_success);

        let other_artifact_hash = format!("sha256:{}", "c".repeat(64));
        let artifact_mismatch = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &other_artifact_hash,
            &success,
            Some(&proof),
            Some(&oracle_receipt),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(artifact_mismatch.status, "rejected");
        assert!(!artifact_mismatch.gpu_hmr_success);

        let (wrong_process_proof, _, wrong_process_receipt) = strict_runtime_proof_fixture(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            "0",
            &live_runtime_session_id,
        );
        let wrong_process = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&wrong_process_proof),
            Some(&wrong_process_receipt),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(wrong_process.status, "rejected");
        assert!(!wrong_process.gpu_hmr_success);

        let (wrong_session_proof, _, wrong_session_receipt) = strict_runtime_proof_fixture(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &live_process_id,
            "runtime-session:unrelated",
        );
        let wrong_session = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&wrong_session_proof),
            Some(&wrong_session_receipt),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(wrong_session.status, "rejected");
        assert!(!wrong_session.gpu_hmr_success);

        let other_source_edit_id = format!("source-edit:sha256:{}", "c".repeat(64));
        let other_request_id = format!("gpu-reload:request:{}", "3".repeat(32));
        let stale = strict_gpu_reload_terminal_result_with_receipt(
            &other_request_id,
            &other_source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&oracle_receipt),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(stale.status, "rejected");
        assert!(!stale.full_runtime_proof_accepted);

        let (proof, _, oracle_receipt) = strict_runtime_proof_fixture(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &live_process_id,
            &live_runtime_session_id,
        );
        let missing_live_receipt = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            None,
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(missing_live_receipt.status, "rejected");
        assert!(!missing_live_receipt.gpu_hmr_success);

        let mut forged_receipt = oracle_receipt.clone();
        Arc::make_mut(&mut forged_receipt.readback_bytes)[0] ^= 0xff;
        let forged_live_bytes = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&forged_receipt),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(forged_live_bytes.status, "rejected");
        assert!(!forged_live_bytes.gpu_hmr_success);

        let mut forged_schema = oracle_receipt.clone();
        forged_schema.recomputed_readback_schema_sha256 = format!("sha256:{}", "9".repeat(64));
        let forged_schema = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&forged_schema),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(forged_schema.status, "rejected");
        assert!(!forged_schema.gpu_hmr_success);

        let mut forged_slice = oracle_receipt.clone();
        forged_slice.deterministic_slice_sha256 = format!("sha256:{}", "8".repeat(64));
        let forged_slice = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&forged_slice),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(forged_slice.status, "rejected");
        assert!(!forged_slice.gpu_hmr_success);

        let mut forged_publication = oracle_receipt.clone();
        forged_publication.publication_id =
            format!("dispatcher-publication:sha256:{}", "0".repeat(64));
        let forged_publication = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&forged_publication),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(forged_publication.status, "rejected");
        assert!(!forged_publication.gpu_hmr_success);

        let mut forged_dispatch_slot = oracle_receipt.clone();
        forged_dispatch_slot.dispatch_table_entry_id = "other_kernel:0x2000".to_string();
        let forged_dispatch_slot = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&forged_dispatch_slot),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(forged_dispatch_slot.status, "rejected");
        assert!(!forged_dispatch_slot.gpu_hmr_success);

        let mut wrong_stream = oracle_receipt;
        wrong_stream.stream_token += 1;
        let wrong_stream = strict_gpu_reload_terminal_result_with_receipt(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &success,
            Some(&proof),
            Some(&wrong_stream),
            Some(&command_envelope_sha256),
            Some(&runner_challenge),
        )
        .unwrap();
        assert_eq!(wrong_stream.status, "rejected");
        assert!(!wrong_stream.gpu_hmr_success);
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn strict_runtime_record_chain_binds_publication_dispatch_commit_and_retirement() {
        let source_edit_id = format!("source-edit:sha256:{}", "a".repeat(64));
        let request_id = format!("gpu-reload:request:{}", "2".repeat(32));
        let artifact_content_hash = format!("sha256:{}", "b".repeat(64));
        let process_id = std::process::id().to_string();
        let runtime_session_id = super::runtime_session_id().to_string();
        let (proof, _, _) = strict_runtime_proof_fixture(
            &request_id,
            &source_edit_id,
            &artifact_content_hash,
            &process_id,
            &runtime_session_id,
        );
        let record = proof.pointer("/proofLedger/records/0").unwrap();
        let matches = |candidate: &serde_json::Value| {
            super::strict_runtime_record_chain_matches(
                candidate,
                &request_id,
                &source_edit_id,
                &artifact_content_hash,
                &process_id,
                &runtime_session_id,
            )
        };
        assert!(matches(record));

        let mut missing_commit = record.clone();
        missing_commit
            .as_object_mut()
            .unwrap()
            .remove("epoch_commit_event");
        assert!(!matches(&missing_commit));

        let mut stale_registration = record.clone();
        stale_registration["dispatch_event"]["dispatcher_registration_id"] =
            serde_json::json!("registration:stale");
        assert!(!matches(&stale_registration));

        let mut commit_before_output = record.clone();
        commit_before_output["epoch_commit_event"]["timestamp_monotonic_ns"] =
            serde_json::json!(39);
        assert!(!matches(&commit_before_output));

        let mut retirement_before_commit = record.clone();
        retirement_before_commit["retirement_event"]["timestamp_monotonic_ns"] =
            serde_json::json!(44);
        assert!(!matches(&retirement_before_commit));

        let mut stale_retirement_epoch = record.clone();
        stale_retirement_epoch["retirement_event"]["epoch"] = serde_json::json!("0");
        assert!(!matches(&stale_retirement_epoch));

        let mut missing_epoch_transition = record.clone();
        missing_epoch_transition["epoch_publish_event"]["previous_epoch"] = serde_json::json!("2");
        missing_epoch_transition["epoch_commit_event"]["previous_epoch"] = serde_json::json!("2");
        missing_epoch_transition["retirement_event"]["epoch"] = serde_json::json!("2");
        assert!(!matches(&missing_epoch_transition));

        let mut numerically_equal_epoch = record.clone();
        for event in [
            "epoch_publish_event",
            "epoch_commit_event",
            "dispatch_event",
            "output_event",
        ] {
            numerically_equal_epoch[event]["epoch"] = serde_json::json!("01");
        }
        assert!(!matches(&numerically_equal_epoch));

        let mut skipped_epoch = record.clone();
        for event in [
            "epoch_publish_event",
            "epoch_commit_event",
            "dispatch_event",
            "output_event",
        ] {
            skipped_epoch[event]["epoch"] = serde_json::json!("3");
        }
        assert!(matches(&skipped_epoch));

        let mut failed_retirement = record.clone();
        failed_retirement["retirement_event"]["status"] = serde_json::json!("retirement_failed");
        failed_retirement["retirement_event"]["retirement_proof"] = serde_json::json!("unproven");
        assert!(!matches(&failed_retirement));

        let mut conflicting_retirement_result = record.clone();
        conflicting_retirement_result["retirement_event"]["result"] =
            serde_json::json!("retirement_failed");
        assert!(!matches(&conflicting_retirement_result));

        let mut conflicting_retirement_proof = record.clone();
        conflicting_retirement_proof["retirement_event"]["proof"] = serde_json::json!("unproven");
        assert!(!matches(&conflicting_retirement_proof));

        let mut candidate_retirement = record.clone();
        let candidate_artifact = candidate_retirement["artifact_after_hash"].clone();
        candidate_retirement["retirement_event"]["artifact_id"] = candidate_artifact.clone();
        candidate_retirement["retirement_event"]["artifact_hash"] = candidate_artifact;
        assert!(!matches(&candidate_retirement));

        let mut conflicting_backend_alias = record.clone();
        conflicting_backend_alias["gpu_backend"] = serde_json::json!("cuda");
        assert!(!matches(&conflicting_backend_alias));

        let mut conflicting_changed_artifact_alias = record.clone();
        conflicting_changed_artifact_alias["changed_gpu_artifact_hash"] =
            conflicting_changed_artifact_alias["artifact_before_hash"].clone();
        assert!(!matches(&conflicting_changed_artifact_alias));

        let mut conflicting_event_kind = record.clone();
        conflicting_event_kind["epoch_publish_event"]["kind"] =
            serde_json::json!("unrestricted_visibility_commit");
        assert!(!matches(&conflicting_event_kind));

        for event in [
            "loader_event",
            "dispatch_event",
            "output_event",
            "retirement_event",
        ] {
            let mut conflicting_event_alias = record.clone();
            conflicting_event_alias[event]["event"] = serde_json::json!("observed");
            conflicting_event_alias[event]["event_kind"] = serde_json::json!("forged");
            assert!(!matches(&conflicting_event_alias), "{event}");
        }

        let mut conflicting_dispatch_id = record.clone();
        conflicting_dispatch_id["dispatch_event"]["dispatch_id"] =
            serde_json::json!("dispatch:stale");
        assert!(!matches(&conflicting_dispatch_id));

        let mut stale_event_proof_id = record.clone();
        stale_event_proof_id["loader_event"]["proof_id"] = serde_json::json!("loader:stale");
        assert!(!matches(&stale_event_proof_id));

        let mut unsafe_number = record.clone();
        unsafe_number["epoch_commit_event"]["unsafe_integer"] =
            serde_json::json!(RUNNER_GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER + 1);
        assert!(!matches(&unsafe_number));

        let mut conflicting_alias = record.clone();
        conflicting_alias["output_event"]["afterDispatchId"] = serde_json::json!("dispatch:stale");
        assert!(!matches(&conflicting_alias));

        let mut conflicting_proof_id_alias = record.clone();
        conflicting_proof_id_alias["proof_id"] = serde_json::json!("proof:one");
        conflicting_proof_id_alias["proofId"] = serde_json::json!("proof:two");
        assert!(!matches(&conflicting_proof_id_alias));

        let mut stale_record_proof_id = record.clone();
        stale_record_proof_id["proof_id"] = serde_json::json!("gpu-ledger-proof:stale");
        assert!(!matches(&stale_record_proof_id));

        let mut matching_record_proof_id = record.clone();
        matching_record_proof_id["proof_id"] =
            serde_json::json!(canonical_runner_runtime_ledger_proof_id(record));
        assert!(matches(&matching_record_proof_id));

        for malformed_previous_artifact in [
            "build/old.hsaco",
            " artifact:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "artifact:sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        ] {
            let mut malformed_previous = record.clone();
            malformed_previous["artifact_before_hash"] =
                serde_json::json!(malformed_previous_artifact);
            malformed_previous["retirement_event"]["artifact_id"] =
                serde_json::json!(malformed_previous_artifact);
            malformed_previous["retirement_event"]["artifact_hash"] =
                serde_json::json!(malformed_previous_artifact);
            assert!(
                !matches(&malformed_previous),
                "{malformed_previous_artifact}"
            );
        }

        let mut string_timestamp = record.clone();
        string_timestamp["epoch_commit_event"]["timestamp_monotonic_ns"] =
            serde_json::json!("9007199254740992");
        assert!(!matches(&string_timestamp));
    }

    #[cfg(feature = "gpu-hmr")]
    #[test]
    fn portable_ledger_canonical_profile_matches_cross_language_golden_id() {
        let record = serde_json::json!({
            "proof_canonical_profile": super::RUNNER_GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE,
            "project_id": "project",
            "edit_id": "edit",
            "backend": "hip",
            "classification": {},
            "contract_hash": "contract",
            "artifact_before_hash": "before",
            "artifact_after_hash": "after",
            "loader_event": {},
            "epoch_publish_event": {},
            "epoch_commit_event": {
                "id": "commit",
                "safe_integer": super::RUNNER_GPU_HMR_PORTABLE_JSON_MAX_SAFE_INTEGER,
                "decimal_fraction": "1.25",
            },
            "dispatch_event": {},
            "output_event": {},
            "retirement_event": {},
            "process_identity": {},
            "device_identity": {},
            "oracle_artifacts": {},
            "deterministic_visual_mode": {},
            "output_oracle_target": {},
            "metric_clock": null,
            "metric_scope": null,
            "cache_state": null,
            "timings": {},
            "timing_metrics": {},
            "model_provenance": {},
            "evidence_refs": [],
            "cpu_hmr_used": false,
            "full_rebuild_used": false,
            "process_restarted": false,
            "firewall_evidence": {
                "cpu_hmr_used": false,
                "full_rebuild_used": false,
                "process_restarted": false,
            },
        });
        assert_eq!(
            super::canonical_runner_runtime_ledger_proof_id(&record),
            "gpu-ledger-proof:sha256:6b7c1a2fe57042594e099b136b20ddb54fc529b9e55638bde4d089fc689f4f4e"
        );
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

        for configured in ["filesystem", "filesystem_path", "path", "module_load_path"] {
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
