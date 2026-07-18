use crate::debug_log;
use anyhow::{Context, Result};
use base64::{engine::general_purpose, Engine as _};
use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app as gst_app;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use webrtc::data_channel::RTCDataChannel;
use webrtc::rtp::packet::Packet;
use webrtc_util::Unmarshal;

use crate::compiler::builder::ModuleHashes;
use crate::compiler::context::CompileContext;
use crate::infra::constants::GUI_TOOLS;
use crate::infra::messages::CompileRequest;
use crate::runtime::gpu_runtime_proof::{
    verify_strict_gpu_runtime_proof, StrictGpuRuntimeProofExpectation, VerifiedGpuRuntimeProof,
};
use crate::runtime::runner_protocol::{
    decode_runner_command_token, parse_runner_protocol_ack, GpuArtifactLoadV1Result,
    GpuReloadV2Expectation, GpuReloadV2Result, GpuReloadV4Payload, RunnerProtocolAck,
    GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY, GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION,
    GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY, GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY,
    GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY,
    GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY, GPU_RELOAD_V4_RESULT_SCHEMA_VERSION,
    RUNNER_PROTOCOL_ACK_PREFIX, RUNNER_PROTOCOL_CURRENT_VERSION,
    RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION,
};
use crate::runtime::runner_state::RunnerState; // Aliasing if needed, or check definition
use crate::webrtc::PER_DC_SEND_TIMEOUT;

const STRUCTURED_LOG_CHUNK_BYTES: usize = 4096;
const STRUCTURED_LOG_CHUNK_SCHEMA_VERSION: &str = "synthi.build_log.structured_json_chunk.v1";

fn extract_structured_runner_message(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.starts_with('{') && trimmed.ends_with('}') {
        return Some(trimmed);
    }

    const PREFIX: &str = "[Runner] [HMR-STATUS] ";
    line.find(PREFIX).map(|idx| &line[idx + PREFIX.len()..])
}

fn should_forward_runner_stderr_line_to_log_dc(line: &str) -> bool {
    !runner_line_contains_protected_gpu_evidence(line)
}

fn normalized_evidence_token(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn json_contains_protected_gpu_evidence(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(values) => values.iter().any(json_contains_protected_gpu_evidence),
        serde_json::Value::Object(fields) => {
            let module_is_device =
                fields.get("module").and_then(serde_json::Value::as_str) == Some("device");
            if module_is_device && fields.contains_key("status") {
                return true;
            }

            fields.iter().any(|(key, field_value)| {
                let key = normalized_evidence_token(key);
                let authority_key = matches!(
                    key.as_str(),
                    "acceptedforgpuhmr"
                        | "gpuhmrsuccess"
                        | "fullruntimeproofaccepted"
                        | "fullruntimeproven"
                        | "runtimeproofartifact"
                        | "runtimeproofmaterial"
                        | "proofledger"
                        | "acceptancecontract"
                ) || key.starts_with("cansatisfy")
                    || key.ends_with("authority");
                authority_key || json_contains_protected_gpu_evidence(field_value)
            })
        }
        serde_json::Value::String(value) => {
            let value = normalized_evidence_token(value);
            (value.contains("gpu") && value.contains("hmr") && value.contains("proof"))
                || value.contains("gpuhmrfullruntimeproven")
                || value.starts_with("synthigpuhmr")
                || value == "synthirunnergpureloadresultv3"
                || value == "synthirunnergpureloadresultv4"
                || value == "synthirunnergpuartifactloadresultv1"
        }
        _ => false,
    }
}

fn runner_line_contains_protected_gpu_evidence(line: &str) -> bool {
    let trimmed = line.trim_start();
    if trimmed.starts_with(RUNNER_PROTOCOL_ACK_PREFIX)
        || trimmed.starts_with("Stdin received:")
        || trimmed.starts_with("[Runner] Processing command:")
    {
        return true;
    }

    let normalized_line = normalized_evidence_token(line);
    if normalized_line.contains("gpuruntimeboundary")
        || [
            "acceptedforgpuhmr",
            "gpuhmrsuccess",
            "fullruntimeproofaccepted",
            "fullruntimeproven",
            "gpuhmrfullruntimeproven",
            "synthirunnergpureloadresultv3",
            "synthirunnergpureloadresultv4",
            "runtimeproofmaterial",
            "synthirunnergpuartifactloadresultv1",
        ]
        .iter()
        .any(|marker| normalized_line.contains(marker))
    {
        return true;
    }

    let hmr_status_line = line.contains("[Runner] [HMR-STATUS] ");
    let Some(payload) = extract_structured_runner_message(line) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
        return hmr_status_line;
    };
    if json_contains_protected_gpu_evidence(&value) {
        return true;
    }
    hmr_status_line
        && !matches!(
            value.get("module").and_then(serde_json::Value::as_str),
            Some("core" | "gui" | "host")
        )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunnerOutputRoute {
    General,
    ProtectedProtocol,
    ProtectedEvidence,
}

fn is_legacy_gpu_terminal_candidate(value: &serde_json::Value) -> bool {
    value.get("module").and_then(serde_json::Value::as_str) == Some("device")
        && matches!(
            value.get("status").and_then(serde_json::Value::as_str),
            Some("applied" | "rejected" | "compile_error" | "compile-error" | "crash-fatal")
        )
}

fn is_runtime_control_ack(value: &serde_json::Value) -> bool {
    matches!(
        value.get("status").and_then(serde_json::Value::as_str),
        Some("runtime-paused" | "runtime-resumed")
    ) && value
        .get("runtimeControlToken")
        .and_then(serde_json::Value::as_str)
        .is_some()
}

fn runner_line_is_private_protocol(line: &str) -> bool {
    if line.starts_with(RUNNER_PROTOCOL_ACK_PREFIX) {
        return true;
    }
    let Some(payload) = extract_structured_runner_message(line) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(payload).is_ok_and(|value| {
        matches!(
            value
                .get("schemaVersion")
                .and_then(serde_json::Value::as_str),
            Some(GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION | GPU_RELOAD_V4_RESULT_SCHEMA_VERSION)
        ) || is_runtime_control_ack(&value)
            || is_legacy_gpu_terminal_candidate(&value)
    })
}

fn route_runner_output_line(
    line: &str,
    general_tx: &tokio::sync::broadcast::Sender<String>,
    protocol_tx: &tokio::sync::broadcast::Sender<String>,
) -> RunnerOutputRoute {
    if runner_line_is_private_protocol(line) {
        let _ = protocol_tx.send(line.to_string());
        RunnerOutputRoute::ProtectedProtocol
    } else if runner_line_contains_protected_gpu_evidence(line) {
        RunnerOutputRoute::ProtectedEvidence
    } else {
        let _ = general_tx.send(line.to_string());
        RunnerOutputRoute::General
    }
}

fn runner_command_log_summary(command: &str) -> String {
    format!(
        "bytes={} sha256=sha256:{}",
        command.len(),
        sha256_hex_local(command.as_bytes())
    )
}

fn protected_runner_line_log_summary(line: &str) -> String {
    let trimmed = line.trim_start();
    let kind = if trimmed.starts_with(RUNNER_PROTOCOL_ACK_PREFIX) {
        "protocol_ack"
    } else if trimmed.starts_with("Stdin received:")
        || trimmed.starts_with("[Runner] Processing command:")
    {
        "command_echo"
    } else if normalized_evidence_token(line).contains("gpuruntimeboundary") {
        "runtime_evidence"
    } else if extract_structured_runner_message(line).is_some() {
        "structured_terminal"
    } else {
        "protected_evidence"
    };
    format!(
        "kind={kind} bytes={} sha256=sha256:{}",
        line.len(),
        sha256_hex_local(line.as_bytes())
    )
}

fn sha256_hex_local(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn structured_log_json_chunks(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    if bytes.len() <= STRUCTURED_LOG_CHUNK_BYTES {
        return vec![text.to_string()];
    }

    let hash = sha256_hex_local(bytes);
    let total = bytes.len().div_ceil(STRUCTURED_LOG_CHUNK_BYTES);
    (0..total)
        .filter_map(|index| {
            let start = index * STRUCTURED_LOG_CHUNK_BYTES;
            let end = bytes.len().min(start + STRUCTURED_LOG_CHUNK_BYTES);
            let payload = serde_json::json!({
                "type": "structured-json-chunk",
                "schemaVersion": STRUCTURED_LOG_CHUNK_SCHEMA_VERSION,
                "chunkId": format!("structured-json:sha256:{hash}"),
                "encoding": "base64:utf8",
                "sha256": format!("sha256:{hash}"),
                "byteLength": bytes.len(),
                "index": index,
                "total": total,
                "data": general_purpose::STANDARD.encode(&bytes[start..end]),
            });
            serde_json::to_string(&payload).ok()
        })
        .collect()
}

async fn send_log_dc_text_bounded(
    dc: &Arc<RTCDataChannel>,
    text: String,
    label: &'static str,
) -> bool {
    match tokio::time::timeout(PER_DC_SEND_TIMEOUT, dc.send_text(text)).await {
        Ok(Ok(_)) => true,
        Ok(Err(err)) => {
            debug_log!("[build-log-dc] dropped {label}: {err}");
            false
        }
        Err(_) => {
            debug_log!(
                "[build-log-dc] dropped {label}: send exceeded {}ms",
                PER_DC_SEND_TIMEOUT.as_millis()
            );
            false
        }
    }
}

async fn send_structured_log_dc_text_bounded(
    dc: &Arc<RTCDataChannel>,
    text: String,
    label: &'static str,
) -> bool {
    let chunks = structured_log_json_chunks(&text);
    if chunks.len() == 1 {
        return send_log_dc_text_bounded(dc, text, label).await;
    }

    let mut all_sent = true;
    for chunk in chunks {
        all_sent &= send_log_dc_text_bounded(dc, chunk, label).await;
    }
    all_sent
}

/// Emit a lifecycle-progress message on the build-log DC so the MCP +
/// frontend can surface per-stage warming progress. Ultraplan
/// §Response envelope "Warming progress" — MCP's session envelope
/// carries `warming_progress: {stage, stage_progress_pct,
/// estimated_ready_at}`.
///
/// Fire-and-forget; drop errors so a flaky DC doesn't stall the warm
/// path.
async fn emit_lifecycle_progress(
    ctx: &CompileContext,
    session_id: Option<&str>,
    state: &str,
    stage: &str,
    progress_pct: u8,
    estimated_ready_ms: Option<u64>,
) {
    let mut payload = serde_json::json!({
        "sessionId": session_id,
        "type": "lifecycle",
        "state": state,
        "warming_progress": {
            "stage": stage,
            "stage_progress_pct": progress_pct.min(100),
        },
    });
    if let Some(ms) = estimated_ready_ms {
        payload["warming_progress"]["estimated_ready_at"] = serde_json::Value::from(now_ms() + ms);
    }
    let _ = send_log_dc_text_bounded(
        &ctx.log_dc,
        serde_json::to_string(&payload).unwrap_or_default(),
        "lifecycle-progress",
    )
    .await;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn x11_display_num() -> u32 {
    const DEFAULT_DISPLAY_NUM: u32 = 99;
    const MAX_DISPLAY_NUM: u32 = 65_535;

    std::env::var("SYNTHI_XVFB_DISPLAY")
        .ok()
        .and_then(|raw| raw.parse::<u32>().ok())
        .filter(|num| *num <= MAX_DISPLAY_NUM)
        .unwrap_or(DEFAULT_DISPLAY_NUM)
}

async fn clear_stale_x11_processes(display_num: u32) {
    let display = format!(":{}", display_num);
    let xvfb_pattern = format!("Xvfb {}", display);
    if let Ok(status) = Command::new("pkill")
        .arg("-f")
        .arg(&xvfb_pattern)
        .status()
        .await
    {
        if status.success() {
            debug_log!("Killed stale Xvfb process for display {}", display);
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    let display_env = format!("DISPLAY={}", display);
    if let Ok(output) = Command::new("pgrep")
        .arg("matchbox-window-manager")
        .output()
        .await
    {
        for pid in String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
        {
            let environ = std::fs::read(format!("/proc/{}/environ", pid)).unwrap_or_default();
            let owns_display = environ
                .split(|byte| *byte == 0)
                .any(|item| item == display_env.as_bytes());
            if owns_display {
                if let Ok(status) = Command::new("kill").arg(pid.to_string()).status().await {
                    if status.success() {
                        debug_log!(
                            "Killed stale matchbox-window-manager process {} for display {}",
                            pid,
                            display
                        );
                    }
                }
            }
        }
        if !output.stdout.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RunnerLoadCommand {
    wire: String,
    gpu_terminal: Option<RunnerGpuTerminalExpectation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GpuArtifactLoadExpectation {
    request_id: String,
    source_edit_id: String,
    artifact_content_hash: String,
    runner_pid: u32,
    runner_runtime_session_id: String,
    command_envelope_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RunnerGpuTerminalExpectation {
    ColdLoad(GpuArtifactLoadExpectation),
    HotReload(StrictGpuTerminalExpectation),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StrictGpuTerminalExpectation {
    identity: GpuReloadV2Expectation,
    runner_pid: u32,
    runner_runtime_session_id: String,
    runner_challenge: String,
    command_envelope_sha256: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CorrelatedColdGpuLoadReceipt {
    request_id: String,
    source_edit_id: String,
    artifact_content_hash: String,
    runner_pid: u32,
    runner_runtime_session_id: String,
    command_envelope_sha256: String,
}

impl CorrelatedColdGpuLoadReceipt {
    pub(crate) fn runner_pid(&self) -> u32 {
        self.runner_pid
    }

    pub(crate) fn runner_runtime_session_id(&self) -> &str {
        &self.runner_runtime_session_id
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct VerifiedHotGpuReloadReceipt {
    request_id: String,
    source_edit_id: String,
    artifact_content_hash: String,
    full_runtime_proof_id: String,
    proof_ledger_id: String,
    proof_json_sha256: String,
    runner_pid: u32,
    runner_runtime_session_id: String,
    command_envelope_sha256: String,
}

impl VerifiedHotGpuReloadReceipt {
    pub(crate) fn runner_pid(&self) -> u32 {
        self.runner_pid
    }

    pub(crate) fn runner_runtime_session_id(&self) -> &str {
        &self.runner_runtime_session_id
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CorrelatedGpuTerminalReceipt {
    ColdLoad(CorrelatedColdGpuLoadReceipt),
    VerifiedHotReload(VerifiedHotGpuReloadReceipt),
}

impl CorrelatedGpuTerminalReceipt {
    fn runner_identity(&self) -> (u32, &str) {
        match self {
            Self::ColdLoad(receipt) => (receipt.runner_pid, &receipt.runner_runtime_session_id),
            Self::VerifiedHotReload(receipt) => {
                (receipt.runner_pid, &receipt.runner_runtime_session_id)
            }
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RunnerExecutionOutcome {
    gpu_terminal_receipts: Vec<CorrelatedGpuTerminalReceipt>,
}

impl RunnerExecutionOutcome {
    pub fn into_single_gpu_terminal(mut self) -> Result<Option<CorrelatedGpuTerminalReceipt>> {
        match self.gpu_terminal_receipts.len() {
            0 => Ok(None),
            1 => Ok(self.gpu_terminal_receipts.pop()),
            count => anyhow::bail!(
                "runner returned {count} GPU terminal receipts for a single continuation"
            ),
        }
    }

    #[cfg(test)]
    fn gpu_terminal_receipts(&self) -> &[CorrelatedGpuTerminalReceipt] {
        &self.gpu_terminal_receipts
    }
}

#[derive(Debug, Clone, Copy)]
struct RunnerCommandProofContext<'a> {
    runner_pid: u32,
    runner_runtime_session_id: &'a str,
    runner_challenge: &'a str,
}

fn runner_load_command(
    name: &str,
    path: &str,
    strict_hot_reload: bool,
    proof_context: Option<RunnerCommandProofContext<'_>>,
) -> Result<RunnerLoadCommand> {
    let gpu_marker = name
        .strip_prefix("__gpu_device_partial:")
        .map(|rest| ("load_device_partial", rest))
        .or_else(|| {
            name.strip_prefix("__gpu_device:")
                .map(|rest| ("load_device", rest))
        });
    if let Some((command, rest)) = gpu_marker {
        let mut fields = rest.splitn(7, ':');
        let vendor = fields
            .next()
            .filter(|s| matches!(*s, "cuda" | "rocm"))
            .with_context(|| {
                format!(
                    "GPU device module marker must include an explicit supported vendor: {}",
                    name
                )
            })?;
        let kernels = fields.next().filter(|s| !s.is_empty()).unwrap_or("-");
        let abi = fields.next().filter(|s| !s.is_empty());
        let capsule = fields.next().filter(|s| !s.is_empty());
        let source_edit_id = fields.next().filter(|s| !s.is_empty());
        let artifact_content_hash = fields.next().filter(|s| !s.is_empty());
        let proof_runtime_session_id = fields
            .next()
            .filter(|value| !value.is_empty() && *value != "-");
        if strict_hot_reload && source_edit_id.is_none() {
            anyhow::bail!("hot GPU reload requires an independent canonical source edit identity");
        }
        if strict_hot_reload && artifact_content_hash.is_none() {
            anyhow::bail!("hot GPU reload requires an expected artifact content hash");
        }
        let artifact_content_hash = artifact_content_hash
            .map(|encoded| {
                decode_runner_command_token(encoded)
                    .context("decoding expected GPU artifact content hash")
            })
            .transpose()?;
        if artifact_content_hash.is_some() && source_edit_id.is_none() {
            anyhow::bail!(
                "content-bound GPU artifact load requires an independent canonical source edit identity"
            );
        }
        if strict_hot_reload || artifact_content_hash.is_some() {
            let proof_context = proof_context.context(
                "content-bound GPU artifact load requires a runner-issued protocol challenge",
            )?;
            let source_edit_id = source_edit_id
                .map(|encoded| {
                    decode_runner_command_token(encoded)
                        .context("decoding independent GPU source edit identity")
                })
                .transpose()?
                .context("content-bound GPU artifact load source edit identity missing")?;
            let artifact_content_hash = artifact_content_hash
                .clone()
                .context("content-bound GPU artifact load hash missing")?;
            let request_id = format!("gpu-reload:request:{}", uuid::Uuid::new_v4().simple());
            let validated_identity = GpuReloadV2Expectation::new(
                request_id.clone(),
                source_edit_id.clone(),
                artifact_content_hash.clone(),
            )
            .map_err(anyhow::Error::msg)?;
            if strict_hot_reload && capsule.is_none_or(|value| value == "-") {
                anyhow::bail!(
                    "hot GPU reload requires a typed proof capsule before runner mutation"
                );
            }
            let proof_runtime_session_id = proof_runtime_session_id
                .map(|encoded| {
                    decode_runner_command_token(encoded)
                        .context("decoding independent GPU proof runtime session identity")
                })
                .transpose()?;
            if capsule.is_some_and(|value| value != "-") && proof_runtime_session_id.is_none() {
                anyhow::bail!(
                    "GPU proof capsule requires an independently transported runtime session identity"
                );
            }
            let decoded_kernels = if kernels == "-" {
                Vec::new()
            } else {
                kernels
                    .split(',')
                    .map(|kernel| {
                        decode_runner_command_token(kernel)
                            .with_context(|| format!("decoding GPU kernel token {kernel:?}"))
                    })
                    .collect::<Result<Vec<_>>>()?
            };
            let payload = GpuReloadV4Payload::new(
                request_id.clone(),
                if strict_hot_reload {
                    "hot_reload"
                } else {
                    "cold_load"
                },
                if command == "load_device_partial" {
                    "partial"
                } else {
                    "full"
                },
                vendor,
                path,
                artifact_content_hash,
                decoded_kernels,
                abi.filter(|value| *value != "-").map(str::to_string),
                capsule.filter(|value| *value != "-").map(str::to_string),
                source_edit_id.clone(),
                proof_runtime_session_id,
                proof_context.runner_runtime_session_id.to_string(),
                proof_context.runner_challenge.to_string(),
            )
            .map_err(anyhow::Error::msg)?;
            let encoded = payload.encode().map_err(anyhow::Error::msg)?;
            let gpu_terminal = if strict_hot_reload {
                RunnerGpuTerminalExpectation::HotReload(StrictGpuTerminalExpectation {
                    identity: validated_identity,
                    runner_pid: proof_context.runner_pid,
                    runner_runtime_session_id: payload.runner_runtime_session_id.clone(),
                    runner_challenge: payload.runner_challenge.clone(),
                    command_envelope_sha256: payload.envelope_sha256.clone(),
                })
            } else {
                RunnerGpuTerminalExpectation::ColdLoad(GpuArtifactLoadExpectation {
                    request_id: request_id.clone(),
                    source_edit_id,
                    artifact_content_hash: payload.artifact_content_hash.clone(),
                    runner_pid: proof_context.runner_pid,
                    runner_runtime_session_id: payload.runner_runtime_session_id.clone(),
                    command_envelope_sha256: payload.envelope_sha256.clone(),
                })
            };
            Ok(RunnerLoadCommand {
                wire: format!(
                    "{} {} {}\n",
                    if strict_hot_reload {
                        "gpu_reload_v4"
                    } else {
                        "gpu_load_v4"
                    },
                    request_id,
                    encoded
                ),
                gpu_terminal: Some(gpu_terminal),
            })
        } else if let Some(capsule) = capsule {
            Ok(RunnerLoadCommand {
                wire: format!(
                    "{} {} {} {} {} {}\n",
                    command,
                    vendor,
                    path,
                    kernels,
                    abi.unwrap_or("-"),
                    capsule
                ),
                gpu_terminal: None,
            })
        } else if let Some(abi) = abi {
            Ok(RunnerLoadCommand {
                wire: format!("{} {} {} {} {}\n", command, vendor, path, kernels, abi),
                gpu_terminal: None,
            })
        } else {
            Ok(RunnerLoadCommand {
                wire: format!("{} {} {} {}\n", command, vendor, path, kernels),
                gpu_terminal: None,
            })
        }
    } else {
        Ok(RunnerLoadCommand {
            wire: format!("load {} {}\n", name, path),
            gpu_terminal: None,
        })
    }
}

#[cfg(test)]
fn runner_command_requires_strict_gpu_protocol(command: &RunnerLoadCommand) -> bool {
    command.gpu_terminal.is_some()
}

fn module_requires_strict_gpu_protocol(name: &str, strict_hot_reload: bool) -> bool {
    let marker = name
        .strip_prefix("__gpu_device_partial:")
        .or_else(|| name.strip_prefix("__gpu_device:"));
    let Some(marker) = marker else {
        return false;
    };
    if strict_hot_reload {
        return true;
    }
    marker
        .splitn(7, ':')
        .nth(5)
        .is_some_and(|value| !value.is_empty() && value != "-")
}

fn strict_gpu_protocol_required_for_batch(
    modules_to_load: &[(String, String)],
    strict_hot_reload: bool,
) -> Result<bool> {
    let strict_command_count = modules_to_load
        .iter()
        .filter(|(name, _)| module_requires_strict_gpu_protocol(name, strict_hot_reload))
        .count();
    if strict_command_count > 1 {
        anyhow::bail!(
            "runner protocol v5 permits one challenge-bound GPU command per batch; received {strict_command_count}"
        );
    }
    Ok(strict_command_count == 1)
}

fn runner_has_hot_device_epoch(
    existing_runner_can_hmr: bool,
    loaded_device_abi: Option<&str>,
) -> bool {
    existing_runner_can_hmr && loaded_device_abi.is_some_and(|abi| !abi.is_empty())
}

fn runner_protocol_handshake_timeout() -> Duration {
    const DEFAULT_TIMEOUT_MS: u64 = 2_000;
    const MAX_TIMEOUT_MS: u64 = 30_000;
    let timeout_ms = std::env::var("SYNTHI_RUNNER_PROTOCOL_HANDSHAKE_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS);
    Duration::from_millis(timeout_ms)
}

async fn wait_for_strict_gpu_protocol_ack(
    receiver: &mut tokio::sync::broadcast::Receiver<String>,
    nonce: &str,
    expected_pid: u32,
) -> Result<RunnerProtocolAck> {
    let deadline = tokio::time::Instant::now() + runner_protocol_handshake_timeout();
    loop {
        let line = tokio::time::timeout_at(deadline, receiver.recv())
            .await
            .context("strict GPU runner protocol acknowledgement timed out")?
            .context("strict GPU runner protocol output channel closed")?;
        let Some(ack) = parse_runner_protocol_ack(&line) else {
            continue;
        };
        if ack.nonce != nonce {
            continue;
        }
        if !ack.supports_strict_gpu_reload(nonce, expected_pid) {
            anyhow::bail!(
                "strict GPU runner protocol acknowledgement failed version, PID, or capability validation"
            );
        }
        return Ok(ack);
    }
}

fn strict_gpu_reload_terminal_timeout() -> Duration {
    const DEFAULT_TIMEOUT_MS: u64 = 30_000;
    const MAX_TIMEOUT_MS: u64 = 300_000;
    let timeout_ms = std::env::var("SYNTHI_RUNNER_GPU_RELOAD_TERMINAL_TIMEOUT_MS")
        .ok()
        .or_else(|| std::env::var("SYNTHI_GPU_HMR_DEVICE_RELOAD_ACK_TIMEOUT_MS").ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .min(MAX_TIMEOUT_MS);
    Duration::from_millis(timeout_ms)
}

async fn wait_for_gpu_command_terminals(
    receiver: &mut tokio::sync::broadcast::Receiver<String>,
    expectations: &[RunnerGpuTerminalExpectation],
) -> Result<Vec<CorrelatedGpuTerminalReceipt>> {
    if expectations.is_empty() {
        return Ok(Vec::new());
    }
    let mut pending_cold = HashMap::new();
    let mut pending_hot = HashMap::new();
    let mut receipts = Vec::with_capacity(expectations.len());
    for expectation in expectations {
        let duplicate = match expectation {
            RunnerGpuTerminalExpectation::ColdLoad(expectation) => pending_cold
                .insert(expectation.request_id.clone(), expectation.clone())
                .is_some(),
            RunnerGpuTerminalExpectation::HotReload(expectation) => pending_hot
                .insert(expectation.identity.request_id.clone(), expectation.clone())
                .is_some(),
        };
        if duplicate {
            anyhow::bail!("GPU runner command request IDs are not unique");
        }
    }
    if pending_cold
        .keys()
        .any(|request_id| pending_hot.contains_key(request_id))
    {
        anyhow::bail!("cold-load and hot-reload request IDs overlap");
    }

    let deadline = tokio::time::Instant::now() + strict_gpu_reload_terminal_timeout();
    while !pending_cold.is_empty() || !pending_hot.is_empty() {
        let line = tokio::time::timeout_at(deadline, receiver.recv())
            .await
            .with_context(|| {
                let mut pending = pending_cold.keys().cloned().collect::<Vec<_>>();
                pending.extend(pending_hot.keys().cloned());
                format!(
                    "GPU runner terminal result timed out with pending requests: {}",
                    pending.join(",")
                )
            })?
            .context("GPU runner terminal output channel closed")?;
        let Some(payload) = extract_structured_runner_message(&line) else {
            continue;
        };
        if let Ok(result) = GpuArtifactLoadV1Result::from_json(payload) {
            let Some(expectation) = pending_cold.get(&result.request_id) else {
                continue;
            };
            if !result.matches(
                &result.request_id,
                &expectation.source_edit_id,
                &expectation.artifact_content_hash,
            ) {
                anyhow::bail!(
                    "cold GPU artifact load terminal identity or hash mismatch for request {}",
                    result.request_id
                );
            }
            if result.status == "rejected" {
                anyhow::bail!(
                    "cold GPU artifact load rejected request {}: {}",
                    result.request_id,
                    result.reason.as_deref().unwrap_or("reason missing")
                );
            }
            receipts.push(CorrelatedGpuTerminalReceipt::ColdLoad(
                CorrelatedColdGpuLoadReceipt {
                    request_id: result.request_id.clone(),
                    source_edit_id: result.source_edit_id.clone(),
                    artifact_content_hash: result.artifact_content_hash.clone(),
                    runner_pid: expectation.runner_pid,
                    runner_runtime_session_id: expectation.runner_runtime_session_id.clone(),
                    command_envelope_sha256: expectation.command_envelope_sha256.clone(),
                },
            ));
            pending_cold.remove(&result.request_id);
            continue;
        }
        if let Ok(result) = GpuReloadV2Result::from_json(payload) {
            let Some(expectation) = pending_hot.get(&result.request_id) else {
                continue;
            };
            if !result.matches_expectation(&expectation.identity) {
                anyhow::bail!(
                    "strict GPU runner terminal identity or artifact hash mismatch for request {}",
                    result.request_id
                );
            }
            if result.status == "rejected" {
                anyhow::bail!(
                    "strict GPU runner reload rejected request {}: {}",
                    result.request_id,
                    result.reason.as_deref().unwrap_or("reason missing")
                );
            }
            let (verified_proof, proof_json_sha256) =
                verify_applied_gpu_terminal_proof(&result, expectation)?;
            receipts.push(CorrelatedGpuTerminalReceipt::VerifiedHotReload(
                VerifiedHotGpuReloadReceipt {
                    request_id: result.request_id.clone(),
                    source_edit_id: result.source_edit_id.clone(),
                    artifact_content_hash: result.artifact_content_hash.clone(),
                    full_runtime_proof_id: verified_proof.proof_id,
                    proof_ledger_id: verified_proof.ledger_proof_id,
                    proof_json_sha256,
                    runner_pid: expectation.runner_pid,
                    runner_runtime_session_id: expectation.runner_runtime_session_id.clone(),
                    command_envelope_sha256: expectation.command_envelope_sha256.clone(),
                },
            ));
            pending_hot.remove(&result.request_id);
            continue;
        }

        let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else {
            continue;
        };
        if is_legacy_gpu_terminal_candidate(&value) {
            anyhow::bail!(
                "GPU runner emitted an unbound legacy terminal result instead of a correlated envelope"
            );
        }
    }
    Ok(receipts)
}

fn verify_applied_gpu_terminal_proof(
    result: &GpuReloadV2Result,
    expectation: &StrictGpuTerminalExpectation,
) -> Result<(VerifiedGpuRuntimeProof, String)> {
    let full_runtime_proof_id = result
        .full_runtime_proof_id
        .as_deref()
        .context("applied strict GPU terminal omitted its runtime proof identity")?;
    let material = result
        .runtime_proof_material
        .as_ref()
        .context("applied strict GPU terminal omitted its runtime proof material")?;
    if !material.matches_runner_context(
        expectation.runner_pid,
        &expectation.runner_runtime_session_id,
        &expectation.runner_challenge,
    ) {
        anyhow::bail!("strict GPU terminal proof material runner context mismatch");
    }
    let proof = material
        .decode_for(
            &expectation.identity.request_id,
            &expectation.identity.source_edit_id,
            &expectation.identity.artifact_content_hash,
            full_runtime_proof_id,
            &expectation.command_envelope_sha256,
        )
        .map_err(anyhow::Error::msg)
        .context("validating strict GPU terminal proof material")?;
    let expected_process_id = expectation.runner_pid.to_string();
    let verified = verify_strict_gpu_runtime_proof(
        &proof,
        &StrictGpuRuntimeProofExpectation {
            request_id: &expectation.identity.request_id,
            source_edit_id: &expectation.identity.source_edit_id,
            artifact_content_hash: &expectation.identity.artifact_content_hash,
            process_id: &expected_process_id,
            runtime_session_id: &expectation.runner_runtime_session_id,
        },
    )
    .context("parent rejected strict GPU runtime proof semantics")?;
    if verified.proof_id != full_runtime_proof_id {
        anyhow::bail!("strict GPU terminal proof identity disagrees with parent recomputation");
    }
    Ok((verified, material.proof_json_sha256.clone()))
}

fn full_device_abi_from_marker(name: &str) -> Option<&str> {
    let rest = name.strip_prefix("__gpu_device:")?;
    let mut fields = rest.splitn(4, ':');
    fields.next()?;
    fields.next()?;
    fields.next().filter(|abi| !abi.is_empty())
}

fn next_full_device_abi(modules_to_load: &[(String, String)]) -> Option<String> {
    modules_to_load
        .iter()
        .filter_map(|(name, _)| full_device_abi_from_marker(name).map(str::to_string))
        .last()
}

#[derive(Debug, Clone, Default)]
struct LoadedRunnerModuleState {
    module_hashes: ModuleHashes,
    loaded_core_path: Option<String>,
    loaded_gui_path: Option<String>,
    loaded_device_abi: Option<String>,
}

fn uncommitted_runner_module_state() -> LoadedRunnerModuleState {
    LoadedRunnerModuleState::default()
}

fn loaded_runner_module_state(
    new_hashes: &ModuleHashes,
    core_lib_path: &str,
    gui_lib_path: &str,
    next_device_abi: Option<&str>,
) -> LoadedRunnerModuleState {
    LoadedRunnerModuleState {
        module_hashes: new_hashes.clone(),
        loaded_core_path: (!core_lib_path.is_empty()).then(|| core_lib_path.to_string()),
        loaded_gui_path: (!gui_lib_path.is_empty()).then(|| gui_lib_path.to_string()),
        loaded_device_abi: next_device_abi
            .filter(|abi| !abi.is_empty())
            .map(str::to_string),
    }
}

async fn invalidate_runner_after_command_failure(state: &mut RunnerState) {
    if let Some(mut child) = state.process.take() {
        let _ = child.kill().await;
    }
    state.stdin = None;
    state.module_hashes = ModuleHashes::default();
    state.loaded_core_path = None;
    state.loaded_gui_path = None;
    state.loaded_device_abi = None;
    state.gpu_runtime_protocol_process_id = None;
    state.gpu_runtime_protocol_session_id = None;
    state.loaded_widget_paths.clear();
    state.widget_hashes.clear();
}

fn same_session_full_device_abi_changed(
    current_session: Option<&str>,
    requested_session: Option<&str>,
    previous_abi: Option<&str>,
    next_abi: Option<&str>,
) -> bool {
    runner_session_matches(current_session, requested_session)
        && matches!(
            (previous_abi, next_abi),
            (Some(previous), Some(next)) if !previous.is_empty() && !next.is_empty() && previous != next
        )
}

fn full_device_abi_restart_marker(
    current_session: Option<&str>,
    requested_session: Option<&str>,
    previous_abi: Option<&str>,
    next_abi: Option<&str>,
) -> Option<(String, String)> {
    if same_session_full_device_abi_changed(
        current_session,
        requested_session,
        previous_abi,
        next_abi,
    ) {
        return Some((
            previous_abi?.trim().to_string(),
            next_abi?.trim().to_string(),
        ));
    }
    if !runner_session_matches(current_session, requested_session) {
        return None;
    }
    let next = next_abi.map(str::trim).filter(|abi| !abi.is_empty())?;
    match previous_abi.map(str::trim).filter(|abi| !abi.is_empty()) {
        Some(previous) if previous != next => Some((previous.to_string(), next.to_string())),
        None => Some(("untracked".to_string(), next.to_string())),
        _ => None,
    }
}

fn emit_abi_breaking_restart_marker(
    previous_abi: &str,
    next_abi: &str,
    policy: &RunnerReloadPolicy,
) {
    let reason = if previous_abi == "untracked" {
        "device_abi_untracked"
    } else {
        "device_abi_changed"
    };
    eprintln!(
        "[gpu-reload] plan=abi_breaking reason={} previous_abi={} next_abi={} reload_policy_reasons={}",
        reason,
        previous_abi,
        next_abi,
        policy.reason_summary()
    );
    eprintln!("[gpu-reload] cold_reload reason=abi_breaking");
}

fn runner_session_matches(current: Option<&str>, requested: Option<&str>) -> bool {
    match (current, requested) {
        (Some(current), Some(requested)) => current == requested,
        (None, None) => true,
        _ => false,
    }
}

#[derive(Debug, Clone)]
pub struct RunnerReloadPolicy {
    pub allow_existing_runner_reload: bool,
    pub reason_codes: Vec<String>,
}

impl Default for RunnerReloadPolicy {
    fn default() -> Self {
        Self {
            allow_existing_runner_reload: true,
            reason_codes: Vec::new(),
        }
    }
}

impl RunnerReloadPolicy {
    pub fn require_runner_restart(reason_codes: Vec<String>) -> Self {
        Self {
            allow_existing_runner_reload: false,
            reason_codes,
        }
    }

    fn reason_summary(&self) -> String {
        if self.reason_codes.is_empty() {
            "reload_policy".to_string()
        } else {
            self.reason_codes.join(",")
        }
    }
}

fn runner_reuse_allowed(
    policy: &RunnerReloadPolicy,
    runner_alive: bool,
    gui_mode_same: bool,
    resolution_same: bool,
    session_same: bool,
) -> bool {
    policy.allow_existing_runner_reload
        && runner_alive
        && gui_mode_same
        && resolution_same
        && session_same
}

fn post_reload_crash_probe_duration() -> Duration {
    const DEFAULT_MS: u64 = 1_000;
    const MAX_MS: u64 = 10_000;
    std::env::var("SYNTHI_RUNNER_POST_RELOAD_CRASH_PROBE_MS")
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(|ms| ms.min(MAX_MS))
        .filter(|ms| *ms > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_MS))
}

fn exit_status_repr(status: std::process::ExitStatus) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        match (status.code(), status.signal()) {
            (Some(code), _) => format!("code={}", code),
            (None, Some(sig)) => format!("signal={}", sig),
            _ => format!("{}", status),
        }
    }
    #[cfg(not(unix))]
    {
        format!("{}", status)
    }
}

async fn probe_runner_exit_after_reload(
    child: &mut tokio::process::Child,
    timeout: Duration,
) -> Option<String> {
    let started = tokio::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(exit_status_repr(status)),
            Ok(None) => {}
            Err(e) => return Some(format!("status_probe_failed={}", e)),
        }
        if started.elapsed() >= timeout {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn handle_runner_execution(
    ctx: &CompileContext,
    req: &CompileRequest,
    modules_to_load: Vec<(String, String)>,
    has_on_update: bool,
    use_ai_split: bool,
    new_hashes: ModuleHashes,
    core_lib_path: String,
    gui_lib_path: String,
    session_id: Option<String>,
    // ULTRAPLAN Lightning Phase 12 — when Some, spawn the AI-generated
    // per-project host_runner_<ts> binary instead of the shipped
    // target/debug/runner. The per-project binary owns window/renderer
    // lifecycle, dlopens libcore.so/libgui.so itself, and runs its own
    // main loop. Worker still manages Xvfb + GStreamer + WebRTC around
    // it (frame capture via ximagesrc on DISPLAY=:99 is unchanged).
    host_runner_bin_path: Option<String>,
    reload_policy: RunnerReloadPolicy,
) -> Result<RunnerExecutionOutcome> {
    // Unified Runner Logic
    if modules_to_load.is_empty() {
        // Nothing to load — still resolve the frontend's compile() promise.
        let done_payload = serde_json::json!({
            "sessionId": session_id,
            "status": "done",
            "success": true,
            "stage": "runner",
        });
        let _ = send_log_dc_text_bounded(
            &ctx.log_dc,
            serde_json::to_string(&done_payload).unwrap_or_default(),
            "runner-done",
        )
        .await;
        return Ok(RunnerExecutionOutcome::default());
    }

    let mut gpu_terminal_receipts = Vec::new();

    let mut guard = ctx.runner_store.lock().await;

    // ULTRAPLAN Lightning Phase 12 — hoisted so both the spawn block
    // and the later logging can reference it without re-resolving
    // `host_runner_bin_path`. The spawn block uses it to pick the
    // binary + cwd. Stdin HMR commands (set_session / load) are
    // sent uniformly to both runner types (Phase 12.5).
    let use_per_project_runner = host_runner_bin_path.is_some();

    let req_width = req.width.unwrap_or(800);
    let req_height = req.height.unwrap_or(600);
    // Xvfb/GStreamer emits physical Xvfb pixels, and input events target
    // that same pixel space.
    let producer_dpr = 1.0_f64;
    let next_device_abi = next_full_device_abi(&modules_to_load);
    let mut pending_abi_breaking_restart_marker: Option<(String, String)> = None;

    debug_log!(
        "[Main] Restart check: is_gui={}, has_on_update={}, use_ai_split={}",
        req.is_gui,
        has_on_update,
        use_ai_split
    );

    // Reuse Xvfb/GStreamer if possible. Under `TrackFanout` there's no
    // per-run track to carry across restarts — fanout subscribers are
    // per-peer and persistent for the peer's lifetime.
    let mut reused_xvfb: Option<tokio::process::Child> = None;
    let mut reused_pipeline: Option<gst::Pipeline> = None;
    let mut reused_wsl_display = String::new();
    let mut reused_gst_display = String::new();
    let mut reused_sdl_tx: Option<mpsc::UnboundedSender<String>> = None;

    // Determine if we have an existing runner that can handle HMR.
    // The runner process supports hot-loading modules via stdin `load`
    // commands regardless of whether the user's code exports on_update.
    // The on_update callback is optional — it just lets user code react
    // to the swap (e.g. migrate state).  Without it, the new module is
    // loaded and the next render frame picks up the new symbols.
    //
    // CRITICAL: also verify the child process is still alive. Otherwise we
    // happily fall into the "HMR MODE: Reusing existing runner" path and
    // immediately bail with "Runner process exited before module loading
    // could begin" — which is exactly what happens when the user's main()
    // returned cleanly after a previous run (e.g. clicked Restart, or the
    // game-loop hit Escape). Treating an exited runner as "no runner" lets
    // the spawn-fresh branch below take over.
    let existing_runner_can_hmr = if let Some(state) = guard.as_mut() {
        let runner_alive = match state.process.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        let gui_mode_same = state.is_gui == req.is_gui;
        let resolution_same = state.width == req_width && state.height == req_height;
        let session_same =
            runner_session_matches(state.session_id.as_deref(), session_id.as_deref());
        if !reload_policy.allow_existing_runner_reload {
            pending_abi_breaking_restart_marker = full_device_abi_restart_marker(
                state.session_id.as_deref(),
                session_id.as_deref(),
                state.loaded_device_abi.as_deref(),
                next_device_abi.as_deref(),
            );
        }
        debug_log!("[Main] Existing runner: alive={}, is_gui={}, gui_mode_same={}, resolution_same={}, session_same={}, current_session={:?}, requested_session={:?}, has_on_update={}, reload_policy_allow_existing={}, reload_policy_reasons={}",
            runner_alive, state.is_gui, gui_mode_same, resolution_same, session_same, state.session_id.as_deref(), session_id.as_deref(), has_on_update, reload_policy.allow_existing_runner_reload, reload_policy.reason_summary());

        // HMR enabled: reuse running process when alive AND GUI mode and
        // resolution/session identity match. Reusing a runner across
        // sessions can send HMR commands into the previous workspace.
        runner_reuse_allowed(
            &reload_policy,
            runner_alive,
            gui_mode_same,
            resolution_same,
            session_same,
        )
    } else {
        false
    };

    // If we can do HMR, skip all the restart/initialization logic and just send load commands
    if existing_runner_can_hmr {
        debug_log!("[Main] ╔═══════════════════════════════════════════════════════════╗");
        debug_log!("[Main] ║  HMR MODE: Reusing existing runner - NO RESTART          ║");
        debug_log!("[Main] ╚═══════════════════════════════════════════════════════════╝");
        debug_log!(
            "[Main] HMR mode: Skipping track attachment and output subscription (already set up)"
        );
    } else if let Some(state) = guard.as_mut() {
        // We have an existing runner but can't do HMR - need to restart
        let gui_mode_changed = state.is_gui != req.is_gui;
        if let Some((previous, next)) = pending_abi_breaking_restart_marker.take() {
            emit_abi_breaking_restart_marker(&previous, &next, &reload_policy);
        }
        debug_log!(
            "[Main] Restarting runner: gui_mode_changed={}, use_ai_split={}, reload_policy_reasons={}",
            gui_mode_changed,
            use_ai_split,
            reload_policy.reason_summary()
        );

        // If resolution matches and is_gui matches, we can reuse Xvfb/GStreamer
        let can_reuse =
            state.is_gui == req.is_gui && state.width == req_width && state.height == req_height;

        let state = guard.take().unwrap();
        if let Some(mut child) = state.process {
            debug_log!("Killing old runner process...");
            let _ = child.kill().await;
        }

        if can_reuse {
            debug_log!("Reusing Xvfb and GStreamer pipeline...");
            reused_xvfb = state.xvfb_process;
            reused_pipeline = state.gst_pipeline;
            reused_wsl_display = state.wsl_display_str;
            reused_gst_display = state.gst_display_str;
            reused_sdl_tx = None; // Do not reuse sdl_tx so we recreate the input task for the new runner's stdin
        } else {
            debug_log!("Full restart (resolution/GUI mode changed)...");
            // Stop GStreamer BEFORE killing Xvfb to avoid capture-from-dead-display crashes
            if let Some(pipeline) = state.gst_pipeline {
                let _ = pipeline.set_state(gst::State::Null);
            }
            if let Some(mut child) = state.xvfb_process {
                let _ = child.kill().await;
            }
        }
    }

    // Only start a new runner if we don't have one (either first run, or after restart)
    if !existing_runner_can_hmr && guard.is_none() {
        // Start runner
        debug_log!("Starting persistent runner...");

        let mut wsl_display_str = reused_wsl_display;
        let mut gst_display_str = reused_gst_display;
        let mut xvfb_process: Option<tokio::process::Child> = reused_xvfb;
        let mut gst_pipeline: Option<gst::Pipeline> = reused_pipeline;
        let sdl_tx_opt: Option<mpsc::UnboundedSender<String>> = reused_sdl_tx;

        // Phase 12.6: if a supervisor session exists with a per-session
        // Xvfb display, override gst_display_str so ximagesrc captures
        // from the supervisor's display instead of the shared :99.
        {
            let sup_guard = ctx.supervisor_store.lock().await;
            if let Some(ref session) = *sup_guard {
                eprintln!(
                    "[Runner] Phase 12.6: using supervisor display {} (not :99)",
                    session.display_str
                );
                wsl_display_str = session.display_str.clone();
                gst_display_str = session.display_str.clone();
            }
        }

        if req.is_gui {
            let width = req_width;
            let height = req_height;

            if xvfb_process.is_none() {
                for tool in GUI_TOOLS {
                    if Command::new(tool).arg("--version").output().await.is_err() {
                        let msg = format!("GUI tool '{}' is missing. GUI apps require Linux/WSL with xdotool, Xvfb, and matchbox-window-manager installed.", tool);
                        debug_log!("[Runner] {}", msg);
                        anyhow::bail!(msg);
                    }
                }

                // Start Xvfb (Virtual Framebuffer)
                // The default remains the historical single-worker display,
                // but deployments can override it per worker.
                let display_num = x11_display_num();

                clear_stale_x11_processes(display_num).await;

                // [Fix] Clean up stale lock files from previous runs
                let lock_file = format!("/tmp/.X11-unix/X{}", display_num);
                if std::path::Path::new(&lock_file).exists() {
                    debug_log!("Removing stale Xvfb lock file: {}", lock_file);
                    let _ = std::fs::remove_file(&lock_file);
                }
                let lock_file_tmp = format!("/tmp/.X{}-lock", display_num);
                if std::path::Path::new(&lock_file_tmp).exists() {
                    debug_log!("Removing stale Xvfb lock file: {}", lock_file_tmp);
                    let _ = std::fs::remove_file(&lock_file_tmp);
                }

                wsl_display_str = format!(":{}", display_num);
                gst_display_str = wsl_display_str.clone();

                debug_log!("Starting Xvfb on display {}", wsl_display_str);
                emit_lifecycle_progress(
                    ctx,
                    session_id.as_deref(),
                    "warming",
                    "xvfb_start",
                    15,
                    Some(5_000),
                )
                .await;

                let mut xvfb_cmd = Command::new("Xvfb");
                xvfb_cmd
                    .arg(&wsl_display_str)
                    .arg("-screen")
                    .arg("0")
                    .arg(format!("{}x{}x24", width, height))
                    .arg("-ac"); // Disable access control

                xvfb_cmd.kill_on_drop(true);
                let child = xvfb_cmd.spawn().context("Failed to spawn Xvfb")?;
                xvfb_process = Some(child);

                // Give Xvfb a moment to start
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

                // Start Matchbox Window Manager (to handle window sizing/borders)
                let mut wm_cmd = Command::new("matchbox-window-manager");
                wm_cmd
                    .arg("-use_titlebar")
                    .arg("no")
                    .arg("-use_cursor")
                    .arg("no");
                wm_cmd.env("DISPLAY", &wsl_display_str);
                // NOTE: kill_on_drop is NOT set here. The WM needs to live as long
                // as Xvfb — it will be killed when Xvfb is killed. Setting
                // kill_on_drop(true) + `let _ = spawn()` would immediately drop the
                // Child handle, killing the WM within milliseconds of starting.
                wm_cmd
                    .spawn()
                    .context("Failed to spawn matchbox-window-manager")?;

                debug_log!("Xvfb and Window Manager started.");
            }

            // Wait for Xvfb and window manager to be fully ready before
            // starting GStreamer capture (ximagesrc needs a live X display).
            tokio::time::sleep(tokio::time::Duration::from_millis(700)).await;

            // Kick off the focus probe for this display. One probe per
            // DISPLAY; idempotent. The probe's cache feeds the
            // window-tree focus lock + WM_CLASS spoof check in the
            // gui-event handler (main.rs). Advisory-only in phase 1.
            crate::safety::focus_probe::ensure_probe(&wsl_display_str).await;
            if let Some(sid) = session_id.as_deref() {
                crate::safety::focus_probe::bind_session_display(sid, &wsl_display_str);
            }

            emit_lifecycle_progress(
                ctx,
                session_id.as_deref(),
                "warming",
                "gstreamer_start",
                40,
                Some(3_000),
            )
            .await;

            if gst_pipeline.is_none() {
                // VP8 only: the per-peer WebRTC track declares video/VP8 so
                // the pipeline MUST emit VP8 RTP. H264 is excluded because
                // @roamhq/wrtc (used by the MCP agent) ships without H264,
                // and mixing codecs between pipeline and track silently
                // breaks negotiation.
                //
                // `keyframe-max-dist=30` forces a keyframe every second at
                // 30 fps. Without it, vp8enc's default of 128 frames (~4 s)
                // means a late-joining observer peer can wait multiple
                // seconds before FrameSink sees a decodable keyframe — and
                // some combinations of `deadline=1 cpu-used=4` end up
                // emitting keyframes only on scene-change, which the
                // MCP observer flow treats as "no_frame_yet" forever.
                // The encoder is given `name=video_enc` so `create_peer`
                // can dispatch `force-key-unit` events on subscribe.
                let encoders = [
                    ("vp8enc name=video_enc deadline=1 cpu-used=4 end-usage=cbr target-bitrate=2000000 keyframe-max-dist=30", "rtpvp8pay", "video/VP8"),
                ];

                let mut selected_mime_type = "video/VP8".to_owned();
                let mut encoder_idx = 0;
                let mut pipeline = None;

                while encoder_idx < encoders.len() {
                    let (encoder, payloader, mime_type) = encoders[encoder_idx];
                    debug_log!("Trying encoder: {}", encoder);

                    // ximagesrc -> videoscale -> videoconvert -> encoder -> payloader -> appsink
                    // audiotestsrc (silence) -> opusenc -> rtpopuspay -> appsink
                    // We use audiotestsrc instead of pulsesrc to be robust in headless environments

                    let pipeline_str = format!(
                        "ximagesrc display-name=\"{}\" use-damage=0 ! video/x-raw,framerate=30/1 ! videoscale ! videoconvert ! {} ! {} name=video_pay ! appsink name=video_sink sync=false \
                         audiotestsrc is-live=true wave=silence ! opusenc ! rtpopuspay name=audio_pay ! appsink name=audio_sink sync=false",
                         gst_display_str, encoder, payloader
                    );

                    match gst::parse_launch(&pipeline_str) {
                        Ok(p) => {
                            if let Ok(pipe) = p.dynamic_cast::<gst::Pipeline>() {
                                match pipe.set_state(gst::State::Playing) {
                                    Ok(_) => {
                                        // Check if it actually runs for a bit?
                                        // ideally we wait for state change success
                                        let bus = pipe.bus().unwrap();
                                        // wait up to 0.5s for error
                                        if let Some(msg) =
                                            bus.timed_pop(gst::ClockTime::from_mseconds(500))
                                        {
                                            if let gst::MessageView::Error(err) = msg.view() {
                                                println!(
                                                    "Encoder {} failed: {}",
                                                    encoder,
                                                    err.error()
                                                );
                                                let _ = pipe.set_state(gst::State::Null);
                                            } else {
                                                debug_log!(
                                                    "Encoder {} started successfully.",
                                                    encoder
                                                );
                                                pipeline = Some(pipe);
                                                selected_mime_type = mime_type.to_string();
                                                break;
                                            }
                                        } else {
                                            debug_log!(
                                                "Encoder {} started successfully (no immediate error).",
                                                encoder
                                            );
                                            pipeline = Some(pipe);
                                            selected_mime_type = mime_type.to_string();
                                            break;
                                        }
                                    }
                                    Err(err) => {
                                        debug_log!(
                                            "Failed to set state for encoder {}: {}",
                                            encoder,
                                            err
                                        );
                                    }
                                }
                            }
                        }
                        Err(err) => {
                            println!("Failed to parse pipeline with {}: {}", encoder, err);
                        }
                    }
                    encoder_idx += 1;
                }

                if pipeline.is_none() {
                    let msg = "Failed to initialize vp8enc. Check GStreamer installation (gstreamer1.0-plugins-good).";
                    debug_log!("[Runner] {}", msg);
                    anyhow::bail!(msg);
                }

                let (v_tx, mut v_rx) = mpsc::unbounded_channel::<Vec<u8>>();
                let (a_tx, mut a_rx) = mpsc::unbounded_channel::<Vec<u8>>();

                gst_pipeline = pipeline;
                let pipeline_ref = gst_pipeline.as_ref().unwrap();

                // Get AppSinks
                let video_sink = pipeline_ref
                    .by_name("video_sink")
                    .unwrap()
                    .dynamic_cast::<gst_app::AppSink>()
                    .unwrap();
                let audio_sink = pipeline_ref
                    .by_name("audio_sink")
                    .unwrap()
                    .dynamic_cast::<gst_app::AppSink>()
                    .unwrap();

                // Video: appsink pushes RTP bytes into a channel; we
                // unmarshal to `Packet` and `dispatch` into the session
                // `video_fanout`. Each peer's subscribed
                // `TrackLocalStaticRTP` task (set up in `create_peer`)
                // writes into its own transceiver. Under HMR, the next
                // runner run produces fresh packets that flow through
                // the same fanout — no `replace_track` dance needed.
                let _ = &selected_mime_type; // kept for pipeline_string use

                let v_tx_clone = v_tx.clone();
                video_sink.set_callbacks(
                    gst_app::AppSinkCallbacks::builder()
                        .new_sample(move |sink| match sink.pull_sample() {
                            Ok(sample) => {
                                if let Some(buffer) = sample.buffer() {
                                    if let Ok(map) = buffer.map_readable() {
                                        let data = map.as_slice().to_vec();
                                        let _ = v_tx_clone.send(data);
                                    }
                                }
                                Ok(gst::FlowSuccess::Ok)
                            }
                            Err(_) => Err(gst::FlowError::Eos),
                        })
                        .build(),
                );

                // Dispatch video packets to the session fanout + tap the
                // RTP marker bit to emit sparse `{type:"frame-advance"}`
                // for the post-HMR paint gate (ultraplan §4.4). The
                // frame-advance ack goes on the build-log DC of the
                // peer that triggered this compile; observers see it
                // via broadcast_build_log_text.
                let video_fanout = ctx.video_fanout.clone();
                let log_dc_for_frame_advance = ctx.log_dc.clone();
                let session_id_for_frame_timing = session_id.clone();
                let producer_viewport_width = req_width;
                let producer_viewport_height = req_height;
                let producer_viewport_dpr = producer_dpr;
                tokio::spawn(async move {
                    let mut frame_seq: u64 = 0;
                    let mut dispatched: u64 = 0;
                    let mut unmarshal_fail: u64 = 0;
                    let mut last_log = std::time::Instant::now();
                    const EMIT_EVERY_N_FRAMES: u64 = 3;
                    while let Some(data) = v_rx.recv().await {
                        let is_end_of_frame = data.len() >= 2 && (data[1] & 0x80) != 0;
                        if let Ok(packet) = Packet::unmarshal(&mut &data[..]) {
                            video_fanout.dispatch(packet);
                            dispatched += 1;
                        } else {
                            unmarshal_fail += 1;
                            eprintln!(
                                "[Runner] Failed to unmarshal RTP packet ({} bytes)",
                                data.len()
                            );
                        }
                        if dispatched <= 3
                            || last_log.elapsed() >= std::time::Duration::from_secs(2)
                        {
                            last_log = std::time::Instant::now();
                            eprintln!(
                                "[video-rtp] dispatched={} unmarshal_fail={} subscribers={} fanout_dispatched={} fanout_dropped_lag={} fanout_dropped_error={}",
                                dispatched,
                                unmarshal_fail,
                                video_fanout.subscriber_count(),
                                video_fanout.stats().packets_dispatched,
                                video_fanout.stats().packets_dropped_lag,
                                video_fanout.stats().packets_dropped_error,
                            );
                        }
                        if is_end_of_frame {
                            frame_seq += 1;
                            // F4 measurement: feed every end-of-frame
                            // into the per-session interval tracker.
                            // Cheap (one mutex + push to a bounded
                            // VecDeque); marker-rate caps at the
                            // encoder's frame rate (≤60 Hz).
                            if let Some(ref sid) = session_id_for_frame_timing {
                                crate::infra::frame_timing::record_end_of_frame(sid);
                            }
                            if frame_seq == 1 || frame_seq % EMIT_EVERY_N_FRAMES == 0 {
                                let ts_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);
                                let msg = serde_json::json!({
                                    "type": "frame-advance",
                                    "frame_seq": frame_seq,
                                    "ts_ms": ts_ms,
                                    "viewport": {
                                        "w": producer_viewport_width,
                                        "h": producer_viewport_height,
                                        "dpr": producer_viewport_dpr,
                                    },
                                })
                                .to_string();
                                let dc = log_dc_for_frame_advance.clone();
                                tokio::spawn(async move {
                                    let _ =
                                        send_log_dc_text_bounded(&dc, msg, "frame-advance").await;
                                });
                            }
                        }
                    }
                });

                // Audio: identical dispatch pattern via `audio_fanout`.
                let a_tx_clone = a_tx.clone();
                audio_sink.set_callbacks(
                    gst_app::AppSinkCallbacks::builder()
                        .new_sample(move |sink| match sink.pull_sample() {
                            Ok(sample) => {
                                if let Some(buffer) = sample.buffer() {
                                    if let Ok(map) = buffer.map_readable() {
                                        let data = map.as_slice().to_vec();
                                        let _ = a_tx_clone.send(data);
                                    }
                                }
                                Ok(gst::FlowSuccess::Ok)
                            }
                            Err(_) => Err(gst::FlowError::Eos),
                        })
                        .build(),
                );

                let audio_fanout = ctx.audio_fanout.clone();
                tokio::spawn(async move {
                    while let Some(data) = a_rx.recv().await {
                        if let Ok(packet) = Packet::unmarshal(&mut &data[..]) {
                            audio_fanout.dispatch(packet);
                        }
                    }
                });
            }
        }

        // Frame-timing publisher (F2 + F4): every 5s, publish the
        // rolling p50/p95/p99 of inter-frame intervals + a pipeline-
        // budget proxy on the build-log DC. The MCP routes this into
        // its event log so PHASE_0_5_FINDINGS.md can be filled in
        // with real numbers without a separate scrape endpoint.
        if let Some(sid_for_publish) = session_id.clone() {
            let log_dc_for_timing = ctx.log_dc.clone();
            tokio::spawn(async move {
                let mut interval =
                    tokio::time::interval(crate::infra::frame_timing::PUBLISH_INTERVAL);
                interval.tick().await; // skip the immediate first tick
                loop {
                    interval.tick().await;
                    crate::infra::frame_timing::publish_snapshots();
                    let snap = match crate::infra::frame_timing::latest_published(&sid_for_publish)
                    {
                        Some(s) if s.sample_count > 0 => s,
                        _ => continue,
                    };
                    let payload = serde_json::json!({
                        "sessionId": sid_for_publish,
                        "type": "frame-timing",
                        "total_frames": snap.total_frames,
                        "sample_count": snap.sample_count,
                        "interval_ms": {
                            "mean": snap.mean_ms,
                            "min": snap.min_ms,
                            "p50": snap.p50_ms,
                            "p95": snap.p95_ms,
                            "p99": snap.p99_ms,
                            "max": snap.max_ms,
                        },
                        "pipeline_budget_estimate_ms": snap.pipeline_budget_estimate_ms,
                    });
                    let _ = send_log_dc_text_bounded(
                        &log_dc_for_timing,
                        payload.to_string(),
                        "frame-timing",
                    )
                    .await;
                }
            });
        }

        // Spawn Runner Process
        //
        // ULTRAPLAN Lightning Phase 12 — per-project runner selection.
        // When `host_runner_bin_path` is Some we spawn the AI-synthesised
        // per-project binary directly. It owns SDL/window/renderer + the
        // dlopen of libcore.so/libgui.so + its own main loop. cwd is set
        // to the binary's parent dir so the AI's `./libcore.so` dlopen
        // call resolves against the symlinks created in compile_core /
        // compile_gui.
        //
        // When `host_runner_bin_path` is None we fall back to the shipped
        // `target/debug/runner` — the legacy path that drives modules via
        // stdin `load` commands and uses the SHIPPED ABI expectations.
        // `use_per_project_runner` is hoisted at the top of this fn.
        let runner_path: std::path::PathBuf = if let Some(ref p) = host_runner_bin_path {
            std::path::PathBuf::from(p)
        } else {
            std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.join("runner")))
                .unwrap_or_else(|| std::path::PathBuf::from("runner"))
        };

        debug_log!(
            "Spawning runner ({}): {:?}",
            if use_per_project_runner {
                "per-project"
            } else {
                "shipped"
            },
            runner_path
        );
        eprintln!(
            "[Main] Spawning runner ({}): {:?}",
            if use_per_project_runner {
                "per-project"
            } else {
                "shipped"
            },
            runner_path
        );

        emit_lifecycle_progress(
            ctx,
            session_id.as_deref(),
            "warming",
            "runner_spawn",
            75,
            Some(2_000),
        )
        .await;

        let mut cmd = Command::new(&runner_path);
        cmd.env("DISPLAY", &wsl_display_str)
            .env(
                "LD_LIBRARY_PATH",
                std::env::var("LD_LIBRARY_PATH").unwrap_or_default(),
            )
            // The worker already manages Xvfb, GStreamer, and video streaming.
            // The runner only needs to load .so modules and execute them in-process.
            // ProcessIsolated mode spawns a supervisor + child that conflicts with
            // the worker's own Xvfb on :99 and uses binary IPC instead of the text
            // protocol the worker sends.
            .env("SYNTHI_UNSAFE_INPROCESS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Phase 12 — per-project runner needs cwd = build dir so its
        // `dlopen("./libcore.so")` resolves via the symlinks created
        // after link. GPU split sidecars are workspace-relative; the
        // shipped runner reads ./.synthi_split_meta.json at startup to
        // choose the backend and split-state path.
        if use_per_project_runner {
            if let Some(parent) = runner_path.parent() {
                cmd.current_dir(parent);
                eprintln!("[Main] per-project runner cwd: {}", parent.display());
            }
        } else if ctx.workspace_path.join(".synthi_split_meta.json").exists() {
            cmd.current_dir(&ctx.workspace_path);
            eprintln!(
                "[Main] shipped runner cwd: {}",
                ctx.workspace_path.display()
            );
        }

        if let Some(sid) = &session_id {
            cmd.env("SYNTHI_SESSION_ID", sid);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                // Diagnostic: the bare anyhow context strips the underlying
                // io::Error reason before it reaches the frontend, leaving us
                // unable to tell ENOENT from EACCES from ETXTBSY. Capture
                // errno + binary state into both the worker stderr and the
                // wrapped error message so the next failure is actionable.
                let kind = e.kind();
                let raw_os_error = e.raw_os_error();
                let cwd_at_spawn = std::env::current_dir().ok();
                let (exists, len, is_file) = match std::fs::metadata(&runner_path) {
                    Ok(md) => (true, md.len(), md.is_file()),
                    Err(_) => (false, 0u64, false),
                };
                eprintln!(
                    "[Main] runner spawn FAILED: binary={:?} cwd_at_spawn={:?} kind={:?} raw_os_error={:?} exists={} len={} is_file={} err={}",
                    runner_path, cwd_at_spawn, kind, raw_os_error, exists, len, is_file, e
                );
                return Err(anyhow::Error::from(e).context(format!(
                    "Failed to spawn runner process: binary={} kind={:?} raw_os_error={:?} exists={} len={} is_file={}",
                    runner_path.display(), kind, raw_os_error, exists, len, is_file
                )));
            }
        };

        // Runner is up — flip lifecycle to `ready`. First peer attach
        // moves it to `running` via peer-count tracking (signaling-side).
        emit_lifecycle_progress(
            ctx,
            session_id.as_deref(),
            "ready",
            "runner_started",
            100,
            None,
        )
        .await;

        // Guest-process registry (ultraplan §Security v4 pre-work #5-#6).
        // Record the root PID + binary fingerprint so the focus-lock +
        // WM_CLASS spoof checks have a ground truth. This is passive —
        // enforcement lands in a follow-up; the registry entry exists
        // on every spawn whether or not downstream code consumes it.
        if let Some(pid) = child.id() {
            if let Some(sid) = session_id.as_deref() {
                let argv0 = runner_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string());
                let registered =
                    crate::safety::guest_registry::GLOBAL_GUEST_REGISTRY.register(sid, pid, argv0);
                let summary = serde_json::json!({
                    "sessionId": sid,
                    "type": "guest-registered",
                    "root_pid": registered.root_pid,
                    "binary_path": registered.binary_path
                        .as_ref().map(|p| p.display().to_string()),
                    "binary_fingerprint": registered.binary_fingerprint,
                    "expected_wm_class_hint": registered.expected_wm_class_hint,
                });
                let _ = send_log_dc_text_bounded(
                    &ctx.log_dc,
                    serde_json::to_string(&summary).unwrap_or_default(),
                    "guest-registered",
                )
                .await;
                eprintln!(
                    "[GuestRegistry] session={} root_pid={} binary={:?}",
                    sid, registered.root_pid, registered.binary_path,
                );
            }
        }

        // Capture stdout/stderr
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take().unwrap()));

        let (log_tx, _) = tokio::sync::broadcast::channel::<String>(100);
        let log_tx_clone = log_tx.clone();
        let (protocol_tx, _) = tokio::sync::broadcast::channel::<String>(100);
        let protocol_tx_stdout = protocol_tx.clone();
        let protocol_tx_stderr = protocol_tx.clone();

        // Forward stdout/stderr to log_dc
        let ctx_clone = ctx.clone();
        let session_id_clone = session_id.clone();

        // Stdout Reader
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(line) = reader.next_line().await {
                match line {
                    Some(l) => {
                        let route =
                            route_runner_output_line(&l, &log_tx_clone, &protocol_tx_stdout);
                        if route != RunnerOutputRoute::General {
                            debug_log!(
                                "[Runner Protocol] {}",
                                protected_runner_line_log_summary(&l)
                            );
                            continue;
                        }
                        // Send to frontend
                        let payload = serde_json::json!({
                           "sessionId": session_id_clone,
                           "type": "stdout",
                           "line": l
                        });
                        let _ = send_log_dc_text_bounded(
                            &ctx_clone.log_dc,
                            serde_json::to_string(&payload).unwrap_or_default(),
                            "runner-stdout",
                        )
                        .await;
                    }
                    None => break,
                }
            }
        });

        let ctx_clone2 = ctx.clone();
        let session_id_clone2 = session_id.clone();
        let log_tx_clone2 = log_tx.clone();

        // Stderr Reader
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(line) = reader.next_line().await {
                match line {
                    Some(l) => {
                        let route =
                            route_runner_output_line(&l, &log_tx_clone2, &protocol_tx_stderr);
                        if route != RunnerOutputRoute::General {
                            debug_log!(
                                "[Runner Protocol] {}",
                                protected_runner_line_log_summary(&l)
                            );
                            continue;
                        }
                        debug_log!("[Runner Stderr] {}", l);

                        if let Some(structured) = extract_structured_runner_message(&l) {
                            if serde_json::from_str::<serde_json::Value>(structured).is_ok() {
                                let _ = send_structured_log_dc_text_bounded(
                                    &ctx_clone2.log_dc,
                                    structured.to_string(),
                                    "runner-structured",
                                )
                                .await;
                                continue;
                            }
                        }

                        if !should_forward_runner_stderr_line_to_log_dc(&l) {
                            continue;
                        }

                        // Send to frontend
                        let payload = serde_json::json!({
                           "sessionId": session_id_clone2,
                           "type": "stderr",
                           "line": l
                        });
                        let _ = send_log_dc_text_bounded(
                            &ctx_clone2.log_dc,
                            serde_json::to_string(&payload).unwrap_or_default(),
                            "runner-stderr",
                        )
                        .await;
                    }
                    None => break,
                }
            }
        });

        let uncommitted_module_state = uncommitted_runner_module_state();
        *guard = Some(RunnerState {
            process: Some(child),
            stdin: Some(stdin.clone()),
            output_tx: log_tx,
            protocol_tx,
            session_id: session_id.clone(),
            is_gui: req.is_gui,
            is_hmr_capable: has_on_update,
            hmr_capability: None,
            xvfb_process,
            gst_pipeline,
            sdl_tx: sdl_tx_opt.clone(),
            video_track: None,
            audio_track: None,
            width: req_width,
            height: req_height,
            wsl_display_str: wsl_display_str.clone(),
            gst_display_str,
            module_hashes: uncommitted_module_state.module_hashes,
            loaded_core_path: uncommitted_module_state.loaded_core_path,
            loaded_gui_path: uncommitted_module_state.loaded_gui_path,
            loaded_device_abi: uncommitted_module_state.loaded_device_abi,
            gpu_runtime_protocol_process_id: None,
            gpu_runtime_protocol_session_id: None,
            loaded_widget_paths: HashMap::new(),
            widget_hashes: HashMap::new(),
        });

        // Set up xdotool input channel for GUI apps (only on fresh start, not reuse)
        if req.is_gui && sdl_tx_opt.is_none() {
            if let Some(ref sid) = session_id {
                let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();

                // Store sender in RunnerState
                if let Some(state) = guard.as_mut() {
                    state.sdl_tx = Some(input_tx.clone());
                }

                // Register in sdl_input_store so terminal handler can route events
                {
                    let mut sdl_guard = ctx.sdl_input_store.lock().await;
                    sdl_guard.insert(sid.clone(), input_tx);
                }

                // Spawn stdin input writer — sends `input` commands directly
                // to the runner process's stdin (parsed as SDL_PushEvent).
                // This completely bypasses X11 and the window manager, avoiding:
                //   - matchbox-WM intercepting/consuming click events
                //   - xdotool process-per-event overhead (~5-10ms each)
                //   - coordinate mismatches between Xvfb and SDL window
                let stdin_for_input = stdin.clone();
                tokio::spawn(async move {
                    while let Some(cmd) = input_rx.recv().await {
                        let mut stdin_guard = stdin_for_input.lock().await;
                        // Commands may contain multiple lines (e.g. scroll = button down + up)
                        for line in cmd.lines() {
                            if !line.is_empty() {
                                let _ = stdin_guard
                                    .write_all(format!("{}\n", line).as_bytes())
                                    .await;
                            }
                        }
                        let _ = stdin_guard.flush().await;
                    }
                    debug_log!("[stdin-input] Input channel closed");
                });

                debug_log!("[Main] stdin input channel registered for session {}", sid);
            }
        } else if req.is_gui {
            // Reusing existing sdl_tx - re-register it in the store
            if let Some(ref sid) = session_id {
                if let Some(state) = guard.as_ref() {
                    if let Some(tx) = &state.sdl_tx {
                        let mut sdl_guard = ctx.sdl_input_store.lock().await;
                        sdl_guard.insert(sid.clone(), tx.clone());
                    }
                }
            }
        }
    }

    if let Some(state) = guard.as_mut() {
        // Under `TrackFanout`, there is no per-run track to
        // `replace_track` onto each peer's transceiver — per-peer tracks
        // are attached in `create_peer` and persist for the peer's
        // lifetime. Fresh RTP packets from the new GStreamer pipeline
        // flow through the same fanout, so every attached peer sees the
        // new frames automatically.

        // Signal the frontend to show/update the GUI widget.
        // Must be sent on both full-restart and HMR reloads so the
        // window always opens regardless of whether the runner was reused.
        if req.is_gui {
            let gui_start = serde_json::json!({
                "type": "run-gui-start",
                "sessionId": session_id,
                "width": state.width,
                "height": state.height,
                "dpr": producer_dpr,
                "viewport": {
                    "w": state.width,
                    "h": state.height,
                    "dpr": producer_dpr,
                },
            });
            let _ =
                send_log_dc_text_bounded(&ctx.log_dc, gui_start.to_string(), "run-gui-start").await;
        }

        // ============================================================
        // SEND SESSION + LOAD COMMANDS (BATCHED)
        // ============================================================
        // We send all commands back-to-back and flush once.  The runner's
        // main loop uses try_recv() to drain ALL pending commands before
        // the next render frame, so batching ensures atomic multi-module
        // swap: no intermediate frame where new core state is rendered
        // by old GUI code (which would read corrupt data).
        //
        // ULTRAPLAN Lightning Phase 12.5 — the per-project host_runner
        // now speaks the same stdin text protocol as the shipped runner
        // (set_session / load core <path> / load gui <path> / quit).
        // The AI-generated template has a reader thread that drains the
        // queue at the top of every frame and executes the 6-phase
        // dlopen/dlclose sequence with prev_state preserved across
        // reloads — see UNIVERSAL_SPLIT_PROMPT's HOST RUNNER GENERATION
        // section. So we send the same commands in both modes, no
        // branching needed.
        if let Some(stdin_arc) = &state.stdin {
            let strict_gpu_hot_reload = runner_has_hot_device_epoch(
                existing_runner_can_hmr,
                state.loaded_device_abi.as_deref(),
            );
            let requires_strict_gpu_protocol =
                strict_gpu_protocol_required_for_batch(&modules_to_load, strict_gpu_hot_reload)?;
            let mut strict_output_receiver =
                requires_strict_gpu_protocol.then(|| state.protocol_tx.subscribe());
            // Check if process is still alive before sending anything.
            // Capture the exit status (signal vs code) so that the bail
            // message below can carry it into the frontend's
            // SynthiException — the bare "Runner process exited" string
            // is useless for telling a SIGSEGV apart from a normal exit
            // apart from a SIGKILL from an OOM killer.
            let mut process_alive = true;
            let mut exit_status_text: Option<String> = None;
            if let Some(child) = state.process.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    let repr = exit_status_repr(status);
                    debug_log!("[Main] Runner process has already exited ({})", repr);
                    exit_status_text = Some(repr);
                    process_alive = false;
                }
            }

            if process_alive {
                let strict_protocol_ack = if requires_strict_gpu_protocol {
                    let handshake_result = async {
                        let expected_pid = state
                            .process
                            .as_ref()
                            .and_then(|child| child.id())
                            .context("strict GPU runner process has no PID")?;
                        let nonce = uuid::Uuid::new_v4().simple().to_string();
                        let handshake = format!(
                            "handshake_v5 {} {} {} {} {} {} {} {}\n",
                            nonce,
                            RUNNER_PROTOCOL_CURRENT_VERSION,
                            RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION,
                            GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY,
                            GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY,
                            GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY,
                            GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY,
                            GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY,
                        );
                        {
                            let mut stdin = stdin_arc.lock().await;
                            debug_log!(
                                "[Main] Sending strict GPU handshake {}",
                                runner_command_log_summary(handshake.trim_end())
                            );
                            stdin
                                .write_all(handshake.as_bytes())
                                .await
                                .context("writing strict GPU runner protocol handshake")?;
                            stdin
                                .flush()
                                .await
                                .context("flushing strict GPU runner protocol handshake")?;
                        }
                        wait_for_strict_gpu_protocol_ack(
                            strict_output_receiver
                                .as_mut()
                                .expect("strict output receiver"),
                            &nonce,
                            expected_pid,
                        )
                        .await
                    }
                    .await;
                    match handshake_result {
                        Ok(ack) => Some(ack),
                        Err(error) => {
                            invalidate_runner_after_command_failure(state).await;
                            return Err(error.context(
                                "strict GPU runner handshake failed before loaded module state publication",
                            ));
                        }
                    }
                } else {
                    None
                };
                let proof_context =
                    strict_protocol_ack
                        .as_ref()
                        .map(|ack| RunnerCommandProofContext {
                            runner_pid: ack.runner_pid,
                            runner_runtime_session_id: &ack.runner_runtime_session_id,
                            runner_challenge: &ack.runner_challenge,
                        });
                let load_commands = modules_to_load
                    .iter()
                    .map(|(name, path)| {
                        runner_load_command(name, path, strict_gpu_hot_reload, proof_context)
                    })
                    .collect::<Result<Vec<_>>>()?;
                let gpu_terminal_expectations = load_commands
                    .iter()
                    .filter_map(|command| command.gpu_terminal.clone())
                    .collect::<Vec<_>>();

                let mut stdin = stdin_arc.lock().await;
                let mut send_failed = false;

                // ULTRAPLAN Lightning Phase 12.6 — version handshake.
                // Send `handshake <version>` as the FIRST command on every
                // stdin session. The runner's command dispatcher ignores
                // unknown commands gracefully (Phase 12.5 contract), so
                // old runners that don't understand "handshake" just log
                // and continue. Future versions use the handshake for
                // capability negotiation (e.g. "supports binary state
                // transfer", "supports widget-level reload", etc.).
                //
                // Protocol version 1: set_session + load + quit. That's
                // all the runner needs to speak today.
                if !requires_strict_gpu_protocol {
                    let handshake = "handshake 1\n";
                    debug_log!(
                        "[Main] Sending runner handshake {}",
                        runner_command_log_summary(handshake.trim_end())
                    );
                    if let Err(e) = stdin.write_all(handshake.as_bytes()).await {
                        eprintln!("[Main] Failed to write handshake to runner stdin: {}", e);
                        send_failed = true;
                    }
                }

                // Send set_session (required for Host KV support).
                // The runner needs the session ID before any module load
                // so modules can read/write persistent key-value state.
                if !send_failed {
                    if let Some(ref sid) = session_id {
                        let session_cmd = format!("set_session {}\n", sid);
                        debug_log!(
                            "[Main] Sending runner session command {}",
                            runner_command_log_summary(session_cmd.trim_end())
                        );
                        if let Err(e) = stdin.write_all(session_cmd.as_bytes()).await {
                            eprintln!("[Main] Failed to write set_session to runner stdin: {}", e);
                            send_failed = true;
                        }
                    }
                }

                if !send_failed {
                    // Send all load commands back-to-back (no sleep between them)
                    for cmd in &load_commands {
                        debug_log!(
                            "[Main] Sending runner load command {}",
                            runner_command_log_summary(cmd.wire.trim_end())
                        );
                        if let Err(e) = stdin.write_all(cmd.wire.as_bytes()).await {
                            eprintln!("[Main] Failed to write to runner stdin: {}", e);
                            send_failed = true;
                            break;
                        }
                    }
                }

                if !send_failed {
                    // Single flush pushes all commands at once
                    if let Err(e) = stdin.flush().await {
                        eprintln!("[Main] Failed to flush runner stdin: {}", e);
                        send_failed = true;
                    }
                }

                if send_failed {
                    drop(stdin);
                    invalidate_runner_after_command_failure(state).await;
                    anyhow::bail!("Runner process stdin write failed (process may have crashed)");
                }

                drop(stdin);
                if let Some(receiver) = strict_output_receiver.as_mut() {
                    match wait_for_gpu_command_terminals(receiver, &gpu_terminal_expectations).await
                    {
                        Ok(receipts) => gpu_terminal_receipts.extend(receipts),
                        Err(error) => {
                            invalidate_runner_after_command_failure(state).await;
                            return Err(error.context(
                                "GPU runner command failed before loaded module state publication",
                            ));
                        }
                    }
                }
                if gpu_terminal_receipts.len() > 1 {
                    invalidate_runner_after_command_failure(state).await;
                    anyhow::bail!(
                        "runner returned multiple GPU terminal receipts before state publication"
                    );
                }

                let post_command_exit = if let Some(child) = state.process.as_mut() {
                    probe_runner_exit_after_reload(child, post_reload_crash_probe_duration()).await
                } else {
                    None
                };
                if let Some(status) = post_command_exit {
                    invalidate_runner_after_command_failure(state).await;
                    anyhow::bail!(
                        "Runner process exited while applying reload commands ({})",
                        status
                    );
                }
            } else {
                anyhow::bail!(
                    "Runner process exited before module loading could begin ({})",
                    exit_status_text.as_deref().unwrap_or("status unknown")
                );
            }
        }

        // Update RunnerState
        let loaded_module_state = loaded_runner_module_state(
            &new_hashes,
            &core_lib_path,
            &gui_lib_path,
            next_device_abi.as_deref(),
        );
        state.module_hashes = loaded_module_state.module_hashes;
        state.loaded_core_path = loaded_module_state.loaded_core_path;
        state.loaded_gui_path = loaded_module_state.loaded_gui_path;
        state.loaded_device_abi = loaded_module_state.loaded_device_abi;
        if let Some(receipt) = gpu_terminal_receipts.first() {
            let (runner_pid, runtime_session_id) = receipt.runner_identity();
            state.gpu_runtime_protocol_process_id = Some(runner_pid);
            state.gpu_runtime_protocol_session_id = Some(runtime_session_id.to_string());
        }
    }

    // Send build-status "done" so the frontend's compile() promise resolves.
    // Without this, native compile promises hang forever, breaking HMR session
    // lifecycle and the [RECOMPILING] badge.
    let done_payload = serde_json::json!({
        "sessionId": session_id,
        "status": "done",
        "success": true,
        "stage": "runner",
    });
    let _ = send_log_dc_text_bounded(
        &ctx.log_dc,
        serde_json::to_string(&done_payload).unwrap_or_default(),
        "runner-done",
    )
    .await;

    Ok(RunnerExecutionOutcome {
        gpu_terminal_receipts,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        full_device_abi_from_marker, full_device_abi_restart_marker, loaded_runner_module_state,
        next_full_device_abi, protected_runner_line_log_summary, route_runner_output_line,
        runner_command_log_summary, runner_command_requires_strict_gpu_protocol,
        runner_has_hot_device_epoch, runner_line_contains_protected_gpu_evidence,
        runner_load_command, runner_reuse_allowed, runner_session_matches,
        same_session_full_device_abi_changed, should_forward_runner_stderr_line_to_log_dc,
        strict_gpu_protocol_required_for_batch, structured_log_json_chunks,
        uncommitted_runner_module_state, verify_applied_gpu_terminal_proof,
        wait_for_gpu_command_terminals, wait_for_strict_gpu_protocol_ack,
        CorrelatedGpuTerminalReceipt, RunnerCommandProofContext, RunnerExecutionOutcome,
        RunnerGpuTerminalExpectation, RunnerOutputRoute, RunnerReloadPolicy,
        StrictGpuTerminalExpectation, STRUCTURED_LOG_CHUNK_BYTES,
    };
    use crate::compiler::builder::ModuleHashes;
    use crate::runtime::gpu_runtime_proof::{
        canonical_runtime_ledger_proof_id, recomputed_runtime_proof_id,
        GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION, GPU_HMR_FULL_RUNTIME_RESULT_STATE,
        GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE, GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
        GPU_HMR_PROOF_SCHEMA_VERSION, GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION,
    };
    use crate::runtime::runner_protocol::{
        GpuArtifactLoadV1Result, GpuReloadV2Expectation, GpuReloadV2Result, GpuReloadV4Payload,
        GpuRuntimeProofMaterialV1, RunnerProtocolAck,
        GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY,
        GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY, GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY,
        GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY,
        GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY,
    };
    use base64::{engine::general_purpose, Engine as _};

    fn canonical_source_edit_id() -> String {
        format!("source-edit:sha256:{}", "a".repeat(64))
    }

    fn encoded_source_edit_id() -> String {
        format!("source%2Dedit%3Asha256%3A{}", "a".repeat(64))
    }

    fn artifact_content_hash() -> String {
        format!("sha256:{}", "b".repeat(64))
    }

    fn encoded_artifact_content_hash() -> String {
        format!("sha256%3A{}", "b".repeat(64))
    }

    fn encoded_proof_runtime_session_id() -> &'static str {
        "runtime%2Dsession%3Atest"
    }

    fn proof_context() -> RunnerCommandProofContext<'static> {
        RunnerCommandProofContext {
            runner_pid: std::process::id(),
            runner_runtime_session_id: "pid123-456",
            runner_challenge: "11111111111111111111111111111111",
        }
    }

    #[test]
    fn strict_gpu_protocol_batch_refuses_multiple_challenge_consumers() {
        let host_module = ("core".to_string(), "/tmp/core.so".to_string());
        let first_gpu_module = (
            "__gpu_device:rocm:-:-:-:-:-:-".to_string(),
            "/tmp/device-a.hsaco".to_string(),
        );
        let second_gpu_module = (
            "__gpu_device_partial:rocm:-:-:-:-:-:-".to_string(),
            "/tmp/device-b.hsaco".to_string(),
        );

        assert!(
            !strict_gpu_protocol_required_for_batch(std::slice::from_ref(&host_module), true,)
                .unwrap()
        );
        assert!(strict_gpu_protocol_required_for_batch(
            &[host_module.clone(), first_gpu_module.clone()],
            true,
        )
        .unwrap());

        let error = strict_gpu_protocol_required_for_batch(
            &[host_module, first_gpu_module, second_gpu_module],
            true,
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("one challenge-bound GPU command per batch; received 2"));
    }

    fn strict_terminal_expectation(
        identity: GpuReloadV2Expectation,
    ) -> StrictGpuTerminalExpectation {
        let context = proof_context();
        StrictGpuTerminalExpectation {
            identity,
            runner_pid: context.runner_pid,
            runner_runtime_session_id: context.runner_runtime_session_id.to_string(),
            runner_challenge: context.runner_challenge.to_string(),
            command_envelope_sha256: format!("sha256:{}", "e".repeat(64)),
        }
    }

    fn strict_runtime_proof_fixture(
        expectation: &StrictGpuTerminalExpectation,
    ) -> (serde_json::Value, String) {
        let identity = &expectation.identity;
        let process_id = expectation.runner_pid.to_string();
        let artifact_id = format!(
            "artifact:sha256:{}",
            identity.artifact_content_hash.trim_start_matches("sha256:")
        );
        let previous_artifact_id = format!("artifact:sha256:{}", "0".repeat(64));
        let publication_id = format!("dispatcher-publication:sha256:{}", "8".repeat(64));
        let registration_id = format!("dispatcher:sha256:{}", "9".repeat(64));
        let dispatch_id = format!("dispatch:sha256:{}", "6".repeat(64));
        let record = serde_json::json!({
            "schemaVersion": GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
            "proof_canonical_profile": GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE,
            "project_id": "generic-parent-proof-verification",
            "edit_id": identity.source_edit_id,
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
                "candidate_registration_id": registration_id,
                "epoch": "2",
                "previous_epoch": "1",
                "artifact_id": artifact_id,
                "artifact_hash": artifact_id,
                "timestamp_monotonic_ns": 20,
                "process_id": process_id,
            },
            "epoch_commit_event": {
                "id": "epoch-commit:2",
                "event": "unrestricted_visibility_commit",
                "publication_id": publication_id,
                "candidate_registration_id": registration_id,
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
                "dispatcher_registration_id": registration_id,
                "epoch": "2",
                "artifact_id": artifact_id,
                "artifact_hash": artifact_id,
                "timestamp_monotonic_ns": 30,
                "process_id": process_id,
            },
            "output_event": {
                "id": "output:2",
                "passed": true,
                "after_dispatch_id": dispatch_id,
                "epoch": "2",
                "artifact_id": artifact_id,
                "artifact_hash": artifact_id,
                "timestamp_monotonic_ns": 40,
                "process_id": process_id,
            },
            "retirement_event": {
                "id": "retirement:1",
                "epoch": "1",
                "artifact_id": previous_artifact_id,
                "artifact_hash": previous_artifact_id,
                "status": "retired_after_quiescent",
                "retirement_proof": "stream_event_proven",
                "timestamp_monotonic_ns": 50,
                "process_id": process_id,
            },
            "process_identity": {
                "process_id": process_id,
                "runtime_session_id": expectation.runner_runtime_session_id,
            },
            "device_identity": {},
            "oracle_artifacts": {},
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
            "evidence_refs": [
                format!("reload:{}", identity.request_id),
                format!("source-edit-id:{}", identity.source_edit_id),
                publication_id,
                registration_id,
            ],
        });
        let ledger_proof_id = canonical_runtime_ledger_proof_id(&record);
        let proof_ledger = serde_json::json!({
            "schemaVersion": GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
            "proofId": ledger_proof_id,
            "gpuHmrSuccess": true,
            "records": [record],
        });
        let acceptance_contract = serde_json::json!({
            "contract_version": GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
            "edit_id": identity.source_edit_id,
            "artifact_hash_before": previous_artifact_id,
            "artifact_hash_after": artifact_id,
        });
        let mut runtime_artifact = serde_json::json!({
            "schemaVersion": GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION,
            "proofId": "pending",
            "resultState": GPU_HMR_FULL_RUNTIME_RESULT_STATE,
            "fullRuntimeProven": true,
            "gpuHmrSuccess": true,
            "stageResults": [],
            "limitations": [],
            "proofLedger": proof_ledger,
            "proofLedgerQuery": {
                "schemaVersion": GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
                "proofId": ledger_proof_id,
                "gpuHmrSuccess": true,
                "failedInvariants": [],
            },
            "runtimeTrace": {
                "runtimeSessionId": expectation.runner_runtime_session_id,
                "processId": process_id,
            },
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
            "schemaVersion": GPU_HMR_PROOF_SCHEMA_VERSION,
            "module": "device",
            "resultState": GPU_HMR_FULL_RUNTIME_RESULT_STATE,
            "proofId": proof_id,
            "proofLedger": proof_ledger,
            "runtimeProofArtifact": runtime_artifact,
        });
        (proof, proof_id)
    }

    fn proof_material(
        expectation: &StrictGpuTerminalExpectation,
        proof: &serde_json::Value,
        proof_id: &str,
    ) -> GpuRuntimeProofMaterialV1 {
        GpuRuntimeProofMaterialV1::new(
            proof,
            &expectation.identity.request_id,
            &expectation.identity.source_edit_id,
            &expectation.identity.artifact_content_hash,
            proof_id,
            &expectation.command_envelope_sha256,
            expectation.runner_pid,
            &expectation.runner_runtime_session_id,
            &expectation.runner_challenge,
        )
        .unwrap()
    }

    fn decode_gpu_v4_command(command: &str, expected_verb: &str) -> (String, GpuReloadV4Payload) {
        let parts = command.trim().split_whitespace().collect::<Vec<_>>();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], expected_verb);
        let payload = GpuReloadV4Payload::decode(parts[2]).unwrap();
        assert_eq!(parts[1], payload.request_id);
        (parts[1].to_string(), payload)
    }

    #[test]
    fn structured_log_json_chunks_fragment_oversized_json() {
        let text = serde_json::json!({
            "type": "gpu_hmr_proof",
            "payload": "x".repeat(STRUCTURED_LOG_CHUNK_BYTES * 2 + 17),
        })
        .to_string();
        let chunks = structured_log_json_chunks(&text);
        assert!(chunks.len() > 1);

        let mut decoded_parts = Vec::new();
        for (expected_index, chunk) in chunks.iter().enumerate() {
            let value: serde_json::Value = serde_json::from_str(chunk).unwrap();
            assert_eq!(value["type"], "structured-json-chunk");
            assert_eq!(value["encoding"], "base64:utf8");
            assert_eq!(value["index"], expected_index);
            assert_eq!(value["total"], chunks.len());
            assert_eq!(value["byteLength"], text.as_bytes().len());
            assert!(value["sha256"].as_str().unwrap().starts_with("sha256:"));
            decoded_parts.extend(
                general_purpose::STANDARD
                    .decode(value["data"].as_str().unwrap())
                    .unwrap(),
            );
        }

        assert_eq!(decoded_parts, text.as_bytes());
    }

    #[test]
    fn gpu_device_load_command_preserves_legacy_shape_without_abi() {
        assert_eq!(
            runner_load_command(
                "__gpu_device:rocm:advance,init",
                "/tmp/device.hsaco",
                false,
                None,
            )
            .unwrap()
            .wire,
            "load_device rocm /tmp/device.hsaco advance,init\n"
        );
    }

    #[test]
    fn gpu_device_load_command_includes_signature_abi_when_present() {
        assert_eq!(
            runner_load_command(
                "__gpu_device:rocm:advance,init:12345",
                "/tmp/device.hsaco",
                false,
                None,
            )
            .unwrap()
            .wire,
            "load_device rocm /tmp/device.hsaco advance,init 12345\n"
        );
    }

    #[test]
    fn gpu_device_load_command_carries_capsule_token_when_present() {
        assert_eq!(
            runner_load_command(
                "__gpu_device:rocm:advance,init:12345:capsulev1_abcd",
                "/tmp/device.hsaco",
                false,
                None,
            )
            .unwrap()
            .wire,
            "load_device rocm /tmp/device.hsaco advance,init 12345 capsulev1_abcd\n"
        );
    }

    #[test]
    fn gpu_device_load_command_carries_independent_source_edit_identity() {
        let marker = format!(
            "__gpu_device:rocm:advance,init:12345:capsulev1_abcd:{}:{}:{}",
            encoded_source_edit_id(),
            encoded_artifact_content_hash(),
            encoded_proof_runtime_session_id(),
        );
        let command =
            runner_load_command(&marker, "/tmp/device.hsaco", true, Some(proof_context())).unwrap();
        let (_, payload) = decode_gpu_v4_command(&command.wire, "gpu_reload_v4");
        assert_eq!(payload.mode, "full");
        assert_eq!(payload.vendor, "rocm");
        assert_eq!(payload.artifact_path, "/tmp/device.hsaco");
        assert_eq!(payload.kernels, vec!["advance", "init"]);
        assert_eq!(payload.abi_fingerprint.as_deref(), Some("12345"));
        assert_eq!(payload.capsule_token.as_deref(), Some("capsulev1_abcd"));
        assert_eq!(payload.source_edit_id, canonical_source_edit_id());
        assert_eq!(payload.artifact_content_hash, artifact_content_hash());
        assert!(runner_command_requires_strict_gpu_protocol(&command));
        let Some(RunnerGpuTerminalExpectation::HotReload(expectation)) =
            command.gpu_terminal.as_ref()
        else {
            panic!("expected strict GPU terminal context");
        };
        assert_eq!(expectation.runner_pid, std::process::id());
        assert_eq!(
            expectation.runner_runtime_session_id,
            payload.runner_runtime_session_id
        );
        assert_eq!(expectation.runner_challenge, payload.runner_challenge);
        assert_eq!(expectation.command_envelope_sha256, payload.envelope_sha256);

        let second =
            runner_load_command(&marker, "/tmp/device.hsaco", true, Some(proof_context())).unwrap();
        let (_, second_payload) = decode_gpu_v4_command(&second.wire, "gpu_reload_v4");
        assert_eq!(second_payload.source_edit_id, payload.source_edit_id);
        assert_ne!(second_payload.request_id, payload.request_id);
        assert_ne!(
            second.gpu_terminal.as_ref().unwrap(),
            command.gpu_terminal.as_ref().unwrap()
        );
    }

    #[test]
    fn cold_device_load_does_not_claim_strict_hot_runtime_identity() {
        let marker = format!(
            "__gpu_device:rocm:advance:12345:capsulev1_abcd:{}:{}:{}",
            encoded_source_edit_id(),
            encoded_artifact_content_hash(),
            encoded_proof_runtime_session_id(),
        );
        let command =
            runner_load_command(&marker, "/tmp/device.hsaco", false, Some(proof_context()))
                .unwrap();
        let (_, payload) = decode_gpu_v4_command(&command.wire, "gpu_load_v4");
        assert_eq!(payload.artifact_content_hash, artifact_content_hash());
        assert!(matches!(
            command.gpu_terminal,
            Some(RunnerGpuTerminalExpectation::ColdLoad(_))
        ));
    }

    #[test]
    fn hot_device_load_refuses_missing_identity() {
        let missing_identity = runner_load_command(
            "__gpu_device:rocm:advance:12345:capsulev1_abcd",
            "/tmp/device.hsaco",
            true,
            Some(proof_context()),
        )
        .unwrap_err();
        assert!(missing_identity
            .to_string()
            .contains("requires an independent canonical source edit identity"));
    }

    #[test]
    fn existing_host_process_is_not_a_hot_device_epoch() {
        assert!(!runner_has_hot_device_epoch(true, None));
        assert!(!runner_has_hot_device_epoch(true, Some("")));
        assert!(!runner_has_hot_device_epoch(false, Some("sha256:abi")));
        assert!(runner_has_hot_device_epoch(true, Some("sha256:abi")));
    }

    #[test]
    fn noncanonical_source_edit_identity_cannot_form_strict_gpu_command() {
        let marker = format!(
            "__gpu_device:rocm:advance:12345:-:source%2Dedit%3Asha256%3Ashort:{}",
            encoded_artifact_content_hash()
        );
        let error = runner_load_command(&marker, "/tmp/device.hsaco", true, Some(proof_context()))
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("source edit identity is invalid"));
    }

    #[tokio::test]
    async fn strict_gpu_protocol_ack_requires_exact_nonce_pid_and_capability() {
        let (sender, _) = tokio::sync::broadcast::channel(4);
        let mut receiver = sender.subscribe();
        sender
            .send(
                RunnerProtocolAck::current(
                    "nonce-a",
                    "pid123-456",
                    "11111111111111111111111111111111",
                )
                .line()
                .unwrap(),
            )
            .unwrap();
        wait_for_strict_gpu_protocol_ack(&mut receiver, "nonce-a", std::process::id())
            .await
            .unwrap();

        for required in [
            GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY,
            GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY,
            GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY,
            GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY,
            GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY,
        ] {
            let mut invalid = RunnerProtocolAck::current(
                "nonce-b",
                "pid123-456",
                "22222222222222222222222222222222",
            );
            invalid
                .capabilities
                .retain(|capability| capability != required);
            let mut invalid_receiver = sender.subscribe();
            sender.send(invalid.line().unwrap()).unwrap();
            assert!(wait_for_strict_gpu_protocol_ack(
                &mut invalid_receiver,
                "nonce-b",
                std::process::id()
            )
            .await
            .is_err());
        }
    }

    #[tokio::test]
    async fn strict_gpu_terminal_wait_correlates_unique_requests_and_rejects_legacy_status() {
        let first = strict_terminal_expectation(
            GpuReloadV2Expectation::new(
                format!("gpu-reload:request:{}", "1".repeat(32)),
                canonical_source_edit_id(),
                format!("sha256:{}", "a".repeat(64)),
            )
            .unwrap(),
        );
        let second = strict_terminal_expectation(
            GpuReloadV2Expectation::new(
                format!("gpu-reload:request:{}", "2".repeat(32)),
                format!("source-edit:sha256:{}", "b".repeat(64)),
                format!("sha256:{}", "b".repeat(64)),
            )
            .unwrap(),
        );
        let (first_proof, first_proof_id) = strict_runtime_proof_fixture(&first);
        let (second_proof, second_proof_id) = strict_runtime_proof_fixture(&second);
        let (sender, _) = tokio::sync::broadcast::channel(8);
        let mut receiver = sender.subscribe();
        sender
            .send(format!(
                "[Runner] [HMR-STATUS] {}",
                GpuReloadV2Result::applied(
                    &second.identity.request_id,
                    &second.identity.source_edit_id,
                    &second.identity.artifact_content_hash,
                    &second_proof_id,
                    proof_material(&second, &second_proof, &second_proof_id),
                )
                .unwrap()
                .to_json()
                .unwrap()
            ))
            .unwrap();
        sender
            .send(format!(
                "[Runner] [HMR-STATUS] {}",
                GpuReloadV2Result::applied(
                    &first.identity.request_id,
                    &first.identity.source_edit_id,
                    &first.identity.artifact_content_hash,
                    &first_proof_id,
                    proof_material(&first, &first_proof, &first_proof_id),
                )
                .unwrap()
                .to_json()
                .unwrap()
            ))
            .unwrap();
        let receipts = wait_for_gpu_command_terminals(
            &mut receiver,
            &[
                RunnerGpuTerminalExpectation::HotReload(first.clone()),
                RunnerGpuTerminalExpectation::HotReload(second.clone()),
            ],
        )
        .await
        .unwrap();
        let outcome = RunnerExecutionOutcome {
            gpu_terminal_receipts: receipts,
        };
        assert_eq!(outcome.gpu_terminal_receipts().len(), 2);
        for expected_proof_id in [&first_proof_id, &second_proof_id] {
            assert!(outcome.gpu_terminal_receipts().iter().any(|receipt| {
                matches!(
                    receipt,
                    CorrelatedGpuTerminalReceipt::VerifiedHotReload(receipt)
                        if &receipt.full_runtime_proof_id == expected_proof_id
                            && receipt.proof_ledger_id.starts_with("gpu-ledger-proof:sha256:")
                            && receipt.proof_json_sha256.starts_with("sha256:")
                            && receipt.runner_pid == std::process::id()
                            && receipt.runner_runtime_session_id
                                == proof_context().runner_runtime_session_id
                            && receipt.command_envelope_sha256
                                == first.command_envelope_sha256
                )
            }));
        }

        let mut receiver = sender.subscribe();
        sender
            .send(
                r#"[Runner] [HMR-STATUS] {"status":"applied","module":"device","capability":"GPU sidecar HMR","state_preserved":true}"#
                    .to_string(),
            )
            .unwrap();
        assert!(wait_for_gpu_command_terminals(
            &mut receiver,
            &[RunnerGpuTerminalExpectation::HotReload(first)],
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("unbound legacy terminal"));
    }

    #[tokio::test]
    async fn verified_hot_terminal_mints_single_use_resume_authorization() {
        let expectation = strict_terminal_expectation(
            GpuReloadV2Expectation::new(
                format!("gpu-reload:request:{}", "5".repeat(32)),
                canonical_source_edit_id(),
                format!("sha256:{}", "5".repeat(64)),
            )
            .unwrap(),
        );
        let (proof, proof_id) = strict_runtime_proof_fixture(&expectation);
        let (sender, _) = tokio::sync::broadcast::channel(2);
        let mut receiver = sender.subscribe();
        sender
            .send(format!(
                "[Runner] [HMR-STATUS] {}",
                GpuReloadV2Result::applied(
                    &expectation.identity.request_id,
                    &expectation.identity.source_edit_id,
                    &expectation.identity.artifact_content_hash,
                    &proof_id,
                    proof_material(&expectation, &proof, &proof_id),
                )
                .unwrap()
                .to_json()
                .unwrap()
            ))
            .unwrap();
        let receipts = wait_for_gpu_command_terminals(
            &mut receiver,
            &[RunnerGpuTerminalExpectation::HotReload(expectation)],
        )
        .await
        .unwrap();
        let terminal = RunnerExecutionOutcome {
            gpu_terminal_receipts: receipts,
        }
        .into_single_gpu_terminal()
        .unwrap()
        .unwrap();
        assert!(matches!(
            terminal,
            CorrelatedGpuTerminalReceipt::VerifiedHotReload(_)
        ));
    }

    #[tokio::test]
    async fn strict_gpu_terminal_wait_fails_on_source_mismatch_or_rejection() {
        let expectation = strict_terminal_expectation(
            GpuReloadV2Expectation::new(
                format!("gpu-reload:request:{}", "3".repeat(32)),
                canonical_source_edit_id(),
                format!("sha256:{}", "c".repeat(64)),
            )
            .unwrap(),
        );
        let source_mismatch = strict_terminal_expectation(
            GpuReloadV2Expectation::new(
                expectation.identity.request_id.clone(),
                format!("source-edit:sha256:{}", "d".repeat(64)),
                expectation.identity.artifact_content_hash.clone(),
            )
            .unwrap(),
        );
        let hash_mismatch = strict_terminal_expectation(
            GpuReloadV2Expectation::new(
                expectation.identity.request_id.clone(),
                expectation.identity.source_edit_id.clone(),
                format!("sha256:{}", "f".repeat(64)),
            )
            .unwrap(),
        );
        let (source_mismatch_proof, source_mismatch_proof_id) =
            strict_runtime_proof_fixture(&source_mismatch);
        let (hash_mismatch_proof, hash_mismatch_proof_id) =
            strict_runtime_proof_fixture(&hash_mismatch);
        let (sender, _) = tokio::sync::broadcast::channel(4);
        let mut mismatch_receiver = sender.subscribe();
        sender
            .send(format!(
                "[Runner] [HMR-STATUS] {}",
                GpuReloadV2Result::applied(
                    &source_mismatch.identity.request_id,
                    &source_mismatch.identity.source_edit_id,
                    &source_mismatch.identity.artifact_content_hash,
                    &source_mismatch_proof_id,
                    proof_material(
                        &source_mismatch,
                        &source_mismatch_proof,
                        &source_mismatch_proof_id,
                    ),
                )
                .unwrap()
                .to_json()
                .unwrap()
            ))
            .unwrap();
        assert!(wait_for_gpu_command_terminals(
            &mut mismatch_receiver,
            &[RunnerGpuTerminalExpectation::HotReload(expectation.clone())],
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("identity or artifact hash mismatch"));

        let mut hash_mismatch_receiver = sender.subscribe();
        sender
            .send(format!(
                "[Runner] [HMR-STATUS] {}",
                GpuReloadV2Result::applied(
                    &hash_mismatch.identity.request_id,
                    &hash_mismatch.identity.source_edit_id,
                    &hash_mismatch.identity.artifact_content_hash,
                    &hash_mismatch_proof_id,
                    proof_material(
                        &hash_mismatch,
                        &hash_mismatch_proof,
                        &hash_mismatch_proof_id,
                    ),
                )
                .unwrap()
                .to_json()
                .unwrap()
            ))
            .unwrap();
        assert!(wait_for_gpu_command_terminals(
            &mut hash_mismatch_receiver,
            &[RunnerGpuTerminalExpectation::HotReload(expectation.clone())],
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("identity or artifact hash mismatch"));

        let mut rejected_receiver = sender.subscribe();
        sender
            .send(format!(
                "[Runner] [HMR-STATUS] {}",
                GpuReloadV2Result::rejected(
                    &expectation.identity.request_id,
                    &expectation.identity.source_edit_id,
                    &expectation.identity.artifact_content_hash,
                    "runtime proof missing",
                )
                .unwrap()
                .to_json()
                .unwrap()
            ))
            .unwrap();
        assert!(wait_for_gpu_command_terminals(
            &mut rejected_receiver,
            &[RunnerGpuTerminalExpectation::HotReload(expectation)],
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("runtime proof missing"));
    }

    #[test]
    fn parent_recomputes_runtime_proof_and_rejects_bound_context_splices() {
        let expectation = strict_terminal_expectation(
            GpuReloadV2Expectation::new(
                format!("gpu-reload:request:{}", "4".repeat(32)),
                canonical_source_edit_id(),
                format!("sha256:{}", "d".repeat(64)),
            )
            .unwrap(),
        );
        let (proof, proof_id) = strict_runtime_proof_fixture(&expectation);
        let valid = GpuReloadV2Result::applied(
            &expectation.identity.request_id,
            &expectation.identity.source_edit_id,
            &expectation.identity.artifact_content_hash,
            &proof_id,
            proof_material(&expectation, &proof, &proof_id),
        )
        .unwrap();
        let (verified, proof_json_sha256) =
            verify_applied_gpu_terminal_proof(&valid, &expectation).unwrap();
        assert_eq!(verified.proof_id, proof_id);
        assert!(verified
            .ledger_proof_id
            .starts_with("gpu-ledger-proof:sha256:"));
        assert!(proof_json_sha256.starts_with("sha256:"));

        let mut forged_semantics = proof.clone();
        forged_semantics["resultState"] = serde_json::json!("gpu-hmr-compile-proven");
        let forged = GpuReloadV2Result::applied(
            &expectation.identity.request_id,
            &expectation.identity.source_edit_id,
            &expectation.identity.artifact_content_hash,
            &proof_id,
            proof_material(&expectation, &forged_semantics, &proof_id),
        )
        .unwrap();
        assert!(verify_applied_gpu_terminal_proof(&forged, &expectation)
            .unwrap_err()
            .to_string()
            .contains("parent rejected strict GPU runtime proof semantics"));

        let stale_proof_id = format!("gpu-runtime-proof:sha256:{}", "7".repeat(64));
        let mut forged_proof_id = proof.clone();
        forged_proof_id["proofId"] = serde_json::json!(stale_proof_id);
        forged_proof_id["runtimeProofArtifact"]["proofId"] = serde_json::json!(stale_proof_id);
        let forged = GpuReloadV2Result::applied(
            &expectation.identity.request_id,
            &expectation.identity.source_edit_id,
            &expectation.identity.artifact_content_hash,
            &stale_proof_id,
            proof_material(&expectation, &forged_proof_id, &stale_proof_id),
        )
        .unwrap();
        assert!(verify_applied_gpu_terminal_proof(&forged, &expectation)
            .unwrap_err()
            .to_string()
            .contains("parent rejected strict GPU runtime proof semantics"));

        let context_splices = [
            (
                expectation.runner_pid.saturating_add(1),
                expectation.runner_runtime_session_id.clone(),
                expectation.runner_challenge.clone(),
                expectation.command_envelope_sha256.clone(),
            ),
            (
                expectation.runner_pid,
                "pid999-999".to_string(),
                expectation.runner_challenge.clone(),
                expectation.command_envelope_sha256.clone(),
            ),
            (
                expectation.runner_pid,
                expectation.runner_runtime_session_id.clone(),
                "2".repeat(32),
                expectation.command_envelope_sha256.clone(),
            ),
            (
                expectation.runner_pid,
                expectation.runner_runtime_session_id.clone(),
                expectation.runner_challenge.clone(),
                format!("sha256:{}", "f".repeat(64)),
            ),
        ];
        for (runner_pid, runtime_session_id, challenge, command_envelope_sha256) in context_splices
        {
            let material = GpuRuntimeProofMaterialV1::new(
                &proof,
                &expectation.identity.request_id,
                &expectation.identity.source_edit_id,
                &expectation.identity.artifact_content_hash,
                &proof_id,
                command_envelope_sha256,
                runner_pid,
                runtime_session_id,
                challenge,
            )
            .unwrap();
            let terminal = GpuReloadV2Result::applied(
                &expectation.identity.request_id,
                &expectation.identity.source_edit_id,
                &expectation.identity.artifact_content_hash,
                &proof_id,
                material,
            )
            .unwrap();
            assert!(verify_applied_gpu_terminal_proof(&terminal, &expectation).is_err());
        }
    }

    #[tokio::test]
    async fn cold_gpu_load_wait_requires_correlated_hash_bound_terminal() {
        let marker = format!(
            "__gpu_device:rocm:advance:12345:capsulev1_abcd:{}:{}:{}",
            encoded_source_edit_id(),
            encoded_artifact_content_hash(),
            encoded_proof_runtime_session_id(),
        );
        let command =
            runner_load_command(&marker, "/tmp/device.hsaco", false, Some(proof_context()))
                .unwrap();
        let expectation = command.gpu_terminal.clone().unwrap();
        let RunnerGpuTerminalExpectation::ColdLoad(cold) = &expectation else {
            panic!("expected a cold artifact-load terminal");
        };
        let (sender, _) = tokio::sync::broadcast::channel(4);
        let mut receiver = sender.subscribe();
        sender
            .send(format!(
                "[Runner] [HMR-STATUS] {}",
                GpuArtifactLoadV1Result::loaded(
                    &cold.request_id,
                    &cold.source_edit_id,
                    &cold.artifact_content_hash,
                )
                .unwrap()
                .to_json()
                .unwrap()
            ))
            .unwrap();
        let receipts = wait_for_gpu_command_terminals(&mut receiver, &[expectation])
            .await
            .unwrap();
        let terminal = RunnerExecutionOutcome {
            gpu_terminal_receipts: receipts,
        }
        .into_single_gpu_terminal()
        .unwrap()
        .unwrap();
        let CorrelatedGpuTerminalReceipt::ColdLoad(receipt) = terminal else {
            panic!("cold artifact load minted hot reload authorization");
        };
        assert_eq!(receipt.runner_pid, proof_context().runner_pid);
        assert_eq!(
            receipt.runner_runtime_session_id,
            proof_context().runner_runtime_session_id
        );
        assert!(receipt.command_envelope_sha256.starts_with("sha256:"));

        let expectation = command.gpu_terminal.unwrap();
        let RunnerGpuTerminalExpectation::ColdLoad(cold) = &expectation else {
            panic!("expected a cold artifact-load terminal");
        };
        let mut mismatch_receiver = sender.subscribe();
        sender
            .send(format!(
                "[Runner] [HMR-STATUS] {}",
                GpuArtifactLoadV1Result::loaded(
                    &cold.request_id,
                    &cold.source_edit_id,
                    format!("sha256:{}", "f".repeat(64)),
                )
                .unwrap()
                .to_json()
                .unwrap()
            ))
            .unwrap();
        assert!(
            wait_for_gpu_command_terminals(&mut mismatch_receiver, &[expectation])
                .await
                .unwrap_err()
                .to_string()
                .contains("identity or hash mismatch")
        );
    }

    #[test]
    fn hot_gpu_device_load_rejects_capsule_placeholder() {
        let marker = format!(
            "__gpu_device:rocm:advance,init:12345:-:{}:{}",
            encoded_source_edit_id(),
            encoded_artifact_content_hash(),
        );
        let error = runner_load_command(&marker, "/tmp/device.hsaco", true, Some(proof_context()))
            .unwrap_err();
        assert!(error.to_string().contains("requires a typed proof capsule"));
    }

    #[test]
    fn gpu_device_partial_load_command_uses_partial_runner_verb() {
        assert_eq!(
            runner_load_command(
                "__gpu_device_partial:rocm:advance:12345",
                "/tmp/device_part.hsaco",
                false,
                None,
            )
            .unwrap()
            .wire,
            "load_device_partial rocm /tmp/device_part.hsaco advance 12345\n"
        );
    }

    #[test]
    fn gpu_device_partial_load_command_carries_independent_source_edit_identity() {
        let marker = format!(
            "__gpu_device_partial:rocm:advance:12345:capsulev1_abcd:{}:{}:{}",
            encoded_source_edit_id(),
            encoded_artifact_content_hash(),
            encoded_proof_runtime_session_id(),
        );
        let command = runner_load_command(
            &marker,
            "/tmp/device_part.hsaco",
            true,
            Some(proof_context()),
        )
        .unwrap();
        let (_, payload) = decode_gpu_v4_command(&command.wire, "gpu_reload_v4");
        assert_eq!(payload.mode, "partial");
        assert_eq!(payload.source_edit_id, canonical_source_edit_id());
    }

    #[test]
    fn full_device_abi_tracking_ignores_partial_markers() {
        assert_eq!(
            full_device_abi_from_marker("__gpu_device:rocm:advance:abi-full"),
            Some("abi-full")
        );
        assert_eq!(
            full_device_abi_from_marker("__gpu_device:rocm:advance:abi-full:capsulev1_abcd"),
            Some("abi-full")
        );
        assert_eq!(
            full_device_abi_from_marker(
                "__gpu_device:rocm:advance:abi-full:capsulev1_abcd:source%2Dedit%3Aproof"
            ),
            Some("abi-full")
        );
        assert_eq!(
            full_device_abi_from_marker("__gpu_device_partial:rocm:advance:abi-partial"),
            None
        );
    }

    #[test]
    fn next_full_device_abi_uses_latest_full_device_marker() {
        let modules = vec![
            (
                "__gpu_device:rocm:init,advance:abi-v1".to_string(),
                "/tmp/device-a.hsaco".to_string(),
            ),
            (
                "__gpu_device_partial:rocm:advance:partial-abi".to_string(),
                "/tmp/device-part.hsaco".to_string(),
            ),
            (
                "__gpu_device:rocm:init,advance:abi-v2".to_string(),
                "/tmp/device-b.hsaco".to_string(),
            ),
        ];
        assert_eq!(next_full_device_abi(&modules).as_deref(), Some("abi-v2"));
    }

    #[test]
    fn fresh_runner_state_stays_uncommitted_before_load_terminals() {
        let state = uncommitted_runner_module_state();

        assert_eq!(state.module_hashes.shared_hash, 0);
        assert_eq!(state.module_hashes.core_hash, 0);
        assert_eq!(state.module_hashes.gui_hash, 0);
        assert_eq!(state.module_hashes.main_hash, 0);
        assert!(state.loaded_core_path.is_none());
        assert!(state.loaded_gui_path.is_none());
        assert!(state.loaded_device_abi.is_none());
    }

    #[test]
    fn loaded_runner_module_state_records_only_committed_paths_and_device_abi() {
        let hashes = ModuleHashes {
            shared_hash: 11,
            core_hash: 22,
            gui_hash: 33,
            main_hash: 44,
        };

        let state = loaded_runner_module_state(
            &hashes,
            "/tmp/libcore.so",
            "/tmp/libgui.so",
            Some("abi-v1"),
        );

        assert_eq!(state.module_hashes.shared_hash, 11);
        assert_eq!(state.module_hashes.core_hash, 22);
        assert_eq!(state.module_hashes.gui_hash, 33);
        assert_eq!(state.module_hashes.main_hash, 44);
        assert_eq!(state.loaded_core_path.as_deref(), Some("/tmp/libcore.so"));
        assert_eq!(state.loaded_gui_path.as_deref(), Some("/tmp/libgui.so"));
        assert_eq!(state.loaded_device_abi.as_deref(), Some("abi-v1"));
    }

    #[test]
    fn device_abi_breaking_marker_requires_same_session_and_changed_full_abi() {
        assert!(same_session_full_device_abi_changed(
            Some("session-a"),
            Some("session-a"),
            Some("abi-v1"),
            Some("abi-v2")
        ));
        assert!(!same_session_full_device_abi_changed(
            Some("session-a"),
            Some("session-b"),
            Some("abi-v1"),
            Some("abi-v2")
        ));
        assert!(!same_session_full_device_abi_changed(
            Some("session-a"),
            Some("session-a"),
            Some("abi-v1"),
            Some("abi-v1")
        ));
        assert!(!same_session_full_device_abi_changed(
            Some("session-a"),
            Some("session-a"),
            None,
            Some("abi-v2")
        ));
    }

    #[test]
    fn device_abi_restart_marker_handles_changed_or_untracked_full_abi() {
        assert_eq!(
            full_device_abi_restart_marker(
                Some("session-a"),
                Some("session-a"),
                Some("abi-v1"),
                Some("abi-v2")
            ),
            Some(("abi-v1".to_string(), "abi-v2".to_string()))
        );
        assert_eq!(
            full_device_abi_restart_marker(
                Some("session-a"),
                Some("session-a"),
                None,
                Some("abi-v2")
            ),
            Some(("untracked".to_string(), "abi-v2".to_string()))
        );
        assert_eq!(
            full_device_abi_restart_marker(
                Some("session-a"),
                Some("session-b"),
                Some("abi-v1"),
                Some("abi-v2")
            ),
            None
        );
        assert_eq!(
            full_device_abi_restart_marker(
                Some("session-a"),
                Some("session-a"),
                Some("abi-v2"),
                Some("abi-v2")
            ),
            None
        );
    }

    #[test]
    fn gpu_device_load_command_rejects_missing_or_unknown_vendor() {
        assert!(runner_load_command(
            "__gpu_device::advance,init",
            "/tmp/device.hsaco",
            false,
            None,
        )
        .is_err());
        assert!(runner_load_command(
            "__gpu_device:vulkan:advance,init",
            "/tmp/device.hsaco",
            false,
            None,
        )
        .is_err());
    }

    #[test]
    fn runner_session_match_allows_same_session() {
        assert!(runner_session_matches(Some("session-a"), Some("session-a")));
    }

    #[test]
    fn runner_session_match_rejects_cross_session_hmr() {
        assert!(!runner_session_matches(
            Some("session-a"),
            Some("session-b")
        ));
    }

    #[test]
    fn runner_session_match_rejects_missing_requested_or_current_identity() {
        assert!(!runner_session_matches(Some("session-a"), None));
        assert!(!runner_session_matches(None, Some("session-a")));
    }

    #[test]
    fn runner_session_match_preserves_sessionless_compatibility() {
        assert!(runner_session_matches(None, None));
    }

    #[test]
    fn runner_reuse_policy_allows_matching_warm_reload() {
        assert!(runner_reuse_allowed(
            &RunnerReloadPolicy::default(),
            true,
            true,
            true,
            true
        ));
    }

    #[test]
    fn runner_reuse_policy_blocks_non_inprocess_plan() {
        let policy = RunnerReloadPolicy::require_runner_restart(vec!["process_swap".to_string()]);
        assert!(!runner_reuse_allowed(&policy, true, true, true, true));
    }

    #[test]
    fn child_gpu_proof_authority_stays_out_of_compile_datachannel() {
        assert!(!should_forward_runner_stderr_line_to_log_dc(
            "[gpu-runtime-boundary] synthi_gpu_launch kernel=step dispatch=ok"
        ));
        assert!(!should_forward_runner_stderr_line_to_log_dc(
            "[Runner] [HMR-STATUS] {\"status\":\"applied\"}"
        ));
        assert!(!should_forward_runner_stderr_line_to_log_dc(
            "[Runner] [HMR-STATUS] {\"module\":\"device\",\"status\":\"compile-error\"}"
        ));
        assert!(runner_line_contains_protected_gpu_evidence(
            r#"{"type":"diagnostic","nested":{"fullRuntimeProven":false}}"#
        ));
        assert!(runner_line_contains_protected_gpu_evidence(
            r#"{"schemaVersion":"synthi.gpu.hmr.unknown-proof.v99","status":"pending"}"#
        ));
        assert!(should_forward_runner_stderr_line_to_log_dc(
            "[Runner] [HMR-STATUS] {\"module\":\"core\",\"status\":\"applied\"}"
        ));
        assert!(should_forward_runner_stderr_line_to_log_dc(
            "application stderr remains visible"
        ));
    }

    #[test]
    fn protected_runner_protocol_uses_private_channel_and_redacted_summaries() {
        let (general_tx, mut general_rx) = tokio::sync::broadcast::channel(8);
        let (protocol_tx, mut protocol_rx) = tokio::sync::broadcast::channel(8);
        let ack = RunnerProtocolAck::current(
            "sentinel-nonce",
            "sentinel-runtime-session",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .line()
        .unwrap();
        let protocol_lines = [
            ack,
            r#"[Runner] [HMR-STATUS] {"module":"runner","status":"runtime-paused","runtimeControlToken":"sentinel-control-token"}"#.to_string(),
            r#"[Runner] [HMR-STATUS] {"module":"device","status":"applied","runtimeProofMaterial":"sentinel-proof-bytes"}"#.to_string(),
        ];

        for line in protocol_lines {
            assert_eq!(
                route_runner_output_line(&line, &general_tx, &protocol_tx),
                RunnerOutputRoute::ProtectedProtocol
            );
            assert_eq!(protocol_rx.try_recv().unwrap(), line);
            assert!(general_rx.try_recv().is_err());
            let summary = protected_runner_line_log_summary(&line);
            assert!(!summary.contains("sentinel"));
        }

        let protected_evidence_lines = [
            "[Runner] Processing command: gpu_reload_v4 sentinel-command-bytes".to_string(),
            "[gpu-runtime-boundary] dispatch_trace sentinel-runtime-evidence".to_string(),
            r#"{"type":"diagnostic","fullRuntimeProven":false,"value":"sentinel-authority"}"#
                .to_string(),
        ];
        for line in protected_evidence_lines {
            assert_eq!(
                route_runner_output_line(&line, &general_tx, &protocol_tx),
                RunnerOutputRoute::ProtectedEvidence
            );
            assert!(general_rx.try_recv().is_err());
            assert!(protocol_rx.try_recv().is_err());
            assert!(!protected_runner_line_log_summary(&line).contains("sentinel"));
        }

        let visible = "application output remains visible";
        assert_eq!(
            route_runner_output_line(visible, &general_tx, &protocol_tx),
            RunnerOutputRoute::General
        );
        assert_eq!(general_rx.try_recv().unwrap(), visible);
        assert!(protocol_rx.try_recv().is_err());

        let command_summary = runner_command_log_summary("gpu_reload_v4 sentinel-command-bytes");
        assert!(!command_summary.contains("sentinel"));
        assert!(command_summary.contains("sha256=sha256:"));
    }
}
