use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const GPU_HMR_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof.v1";
pub const GPU_HMR_ACCEPTANCE_LEDGER_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.acceptance_ledger.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GpuHmrProofState {
    CompileProven,
    SymbolBound,
    AbiProven,
    EpochSwapProven,
    DispatchObserved,
    DispatchSafeProven,
    OutputOracleProven,
    HostPreservationProven,
    FullRuntimeProven,
}

impl GpuHmrProofState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CompileProven => "gpu-hmr-compile-proven",
            Self::SymbolBound => "gpu-hmr-symbol-bound",
            Self::AbiProven => "gpu-hmr-abi-proven",
            Self::EpochSwapProven => "gpu-hmr-epoch-swap-proven",
            Self::DispatchObserved => "gpu-hmr-dispatch-observed",
            Self::DispatchSafeProven => "gpu-hmr-dispatch-safe-proven",
            Self::OutputOracleProven => "gpu-hmr-output-oracle-proven",
            Self::HostPreservationProven => "gpu-hmr-host-preservation-proven",
            Self::FullRuntimeProven => "gpu-hmr-full-runtime-proven",
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::CompileProven => 1,
            Self::SymbolBound => 2,
            Self::AbiProven => 3,
            Self::EpochSwapProven => 4,
            Self::DispatchObserved => 5,
            Self::DispatchSafeProven => 6,
            Self::OutputOracleProven => 7,
            Self::HostPreservationProven => 8,
            Self::FullRuntimeProven => 9,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GpuHmrDegradedState {
    FakeLaunchPath,
    UnknownArgProvenance,
    AbiUnverified,
    DispatchUnobserved,
    OutputUnobserved,
    HostReplaced,
    EpochRetirementPending,
    EpochSwapUnverified,
    RamIoUnavailable,
    OriginalHostPathUnattached,
    VisualOnly,
}

impl GpuHmrDegradedState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FakeLaunchPath => "gpu-hmr-fake-launch-path",
            Self::UnknownArgProvenance => "gpu-hmr-unknown-arg-provenance",
            Self::AbiUnverified => "gpu-hmr-abi-unverified",
            Self::DispatchUnobserved => "gpu-hmr-dispatch-unobserved",
            Self::OutputUnobserved => "gpu-hmr-output-unobserved",
            Self::HostReplaced => "gpu-hmr-host-replaced",
            Self::EpochRetirementPending => "gpu-hmr-epoch-retirement-pending",
            Self::EpochSwapUnverified => "gpu-hmr-epoch-swap-unverified",
            Self::RamIoUnavailable => "gpu-hmr-ram-io-unavailable",
            Self::OriginalHostPathUnattached => "gpu-hmr-original-host-path-unattached",
            Self::VisualOnly => "gpu-hmr-visual-only",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuHmrProofTelemetry {
    #[serde(rename = "schemaVersion")]
    pub schema_version: &'static str,
    #[serde(rename = "proofId", skip_serializing_if = "Option::is_none")]
    pub proof_id: Option<String>,
    #[serde(rename = "proofArtifactPath", skip_serializing_if = "Option::is_none")]
    pub proof_artifact_path: Option<String>,
    #[serde(rename = "resultState")]
    pub result_state: String,
    #[serde(rename = "degradedState", skip_serializing_if = "Option::is_none")]
    pub degraded_state: Option<String>,
    #[serde(rename = "degradedReason", skip_serializing_if = "Option::is_none")]
    pub degraded_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

impl GpuHmrProofTelemetry {
    pub fn new(
        result_state: GpuHmrProofState,
        degraded_state: Option<GpuHmrDegradedState>,
        degraded_reason: Option<String>,
        label: Option<String>,
    ) -> Self {
        Self {
            schema_version: GPU_HMR_PROOF_SCHEMA_VERSION,
            proof_id: None,
            proof_artifact_path: None,
            result_state: result_state.as_str().to_string(),
            degraded_state: degraded_state
                .map(GpuHmrDegradedState::as_str)
                .map(str::to_string),
            degraded_reason,
            label,
        }
    }

    pub fn with_artifact_ref(mut self, proof_id: String, proof_artifact_path: String) -> Self {
        self.proof_id = Some(proof_id);
        self.proof_artifact_path = Some(proof_artifact_path);
        self
    }

    pub fn to_log_line(&self) -> String {
        serde_json::json!({
            "type": "gpu_hmr_proof",
            "schemaVersion": self.schema_version,
            "proofId": self.proof_id,
            "proofArtifactPath": self.proof_artifact_path,
            "resultState": self.result_state,
            "degradedState": self.degraded_state,
            "degradedReason": self.degraded_reason,
            "label": self.label,
        })
        .to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuHmrProofEvidenceRef {
    #[serde(rename = "evidenceId")]
    pub evidence_id: String,
    pub kind: String,
    #[serde(rename = "contentHash")]
    pub content_hash: String,
    #[serde(rename = "producerSubsystem")]
    pub producer_subsystem: String,
    pub timestamp: String,
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(rename = "filePath", skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(rename = "artifactUri", skip_serializing_if = "Option::is_none")]
    pub artifact_uri: Option<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuHmrProofStageResult {
    #[serde(rename = "stageId")]
    pub stage_id: String,
    #[serde(rename = "stageName")]
    pub stage_name: String,
    pub status: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "completedAt")]
    pub completed_at: String,
    #[serde(rename = "inputArtifactIds")]
    pub input_artifact_ids: Vec<String>,
    #[serde(rename = "outputArtifactIds")]
    pub output_artifact_ids: Vec<String>,
    #[serde(rename = "evidenceRefs")]
    pub evidence_refs: Vec<String>,
    #[serde(rename = "degradedState", skip_serializing_if = "Option::is_none")]
    pub degraded_state: Option<String>,
    #[serde(rename = "degradedReason", skip_serializing_if = "Option::is_none")]
    pub degraded_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuHmrProofArtifact {
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    #[serde(rename = "proofId")]
    pub proof_id: String,
    #[serde(rename = "workspaceSlug")]
    pub workspace_slug: String,
    #[serde(rename = "runtimeSessionId")]
    pub runtime_session_id: String,
    #[serde(rename = "sourceEditId")]
    pub source_edit_id: String,
    #[serde(rename = "selectedArtifactId")]
    pub selected_artifact_id: String,
    #[serde(rename = "resultState")]
    pub result_state: String,
    #[serde(rename = "degradedState", skip_serializing_if = "Option::is_none")]
    pub degraded_state: Option<String>,
    #[serde(rename = "degradedReason", skip_serializing_if = "Option::is_none")]
    pub degraded_reason: Option<String>,
    #[serde(rename = "stageResults")]
    pub stage_results: Vec<GpuHmrProofStageResult>,
    #[serde(rename = "evidenceRefs")]
    pub evidence_refs: Vec<GpuHmrProofEvidenceRef>,
    #[serde(rename = "visualEvidenceRefs")]
    pub visual_evidence_refs: Vec<GpuHmrProofEvidenceRef>,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuHmrProofArtifactInput {
    pub workspace_slug: String,
    pub runtime_session_id: String,
    pub source_edit_id: String,
    pub selected_artifact_id: String,
    pub result_state: String,
    pub degraded_state: Option<String>,
    pub degraded_reason: Option<String>,
    pub stage_results: Vec<GpuHmrProofStageResult>,
    pub evidence_refs: Vec<GpuHmrProofEvidenceRef>,
    pub visual_evidence_refs: Vec<GpuHmrProofEvidenceRef>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuHmrProofArtifactWrite {
    pub proof_id: String,
    pub path: PathBuf,
    pub relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuHmrAcceptanceLedgerInput {
    pub hot_reload: bool,
    pub artifact_id_after: String,
    pub loader_artifact_id: Option<String>,
    pub epoch_publish_artifact_id: Option<String>,
    pub dispatch_artifact_id: Option<String>,
    pub output_artifact_id: Option<String>,
    pub output_oracle_passed: bool,
    pub output_after_dispatch: bool,
    pub retirement_proven: bool,
    pub cpu_hmr_used: Option<bool>,
    pub full_rebuild_used: Option<bool>,
    pub process_restarted: Option<bool>,
    pub firewall_route: Option<String>,
    pub firewall_evidence_source: Option<String>,
    pub firewall_process_id_before: Option<u32>,
    pub firewall_process_id_after: Option<u32>,
    pub process_id: Option<String>,
    pub device_identity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuHmrAcceptanceLedger {
    #[serde(rename = "schemaVersion")]
    pub schema_version: String,
    #[serde(rename = "ledgerId")]
    pub ledger_id: String,
    #[serde(rename = "hotReload")]
    pub hot_reload: bool,
    #[serde(rename = "artifactIdAfter")]
    pub artifact_id_after: String,
    #[serde(rename = "loaderArtifactId", skip_serializing_if = "Option::is_none")]
    pub loader_artifact_id: Option<String>,
    #[serde(rename = "epochPublishArtifactId", skip_serializing_if = "Option::is_none")]
    pub epoch_publish_artifact_id: Option<String>,
    #[serde(rename = "dispatchArtifactId", skip_serializing_if = "Option::is_none")]
    pub dispatch_artifact_id: Option<String>,
    #[serde(rename = "outputArtifactId", skip_serializing_if = "Option::is_none")]
    pub output_artifact_id: Option<String>,
    #[serde(rename = "outputOraclePassed")]
    pub output_oracle_passed: bool,
    #[serde(rename = "outputAfterDispatch")]
    pub output_after_dispatch: bool,
    #[serde(rename = "retirementProven")]
    pub retirement_proven: bool,
    #[serde(rename = "cpuHmrUsed")]
    pub cpu_hmr_used: bool,
    #[serde(rename = "cpuHmrAbsenceEvidencePresent")]
    pub cpu_hmr_absence_evidence_present: bool,
    #[serde(rename = "fullRebuildUsed")]
    pub full_rebuild_used: bool,
    #[serde(rename = "fullRebuildAbsenceEvidencePresent")]
    pub full_rebuild_absence_evidence_present: bool,
    #[serde(rename = "processRestarted")]
    pub process_restarted: bool,
    #[serde(rename = "processRestartAbsenceEvidencePresent")]
    pub process_restart_absence_evidence_present: bool,
    #[serde(rename = "firewallRoute", skip_serializing_if = "Option::is_none")]
    pub firewall_route: Option<String>,
    #[serde(rename = "firewallEvidenceSource", skip_serializing_if = "Option::is_none")]
    pub firewall_evidence_source: Option<String>,
    #[serde(
        rename = "firewallProcessIdBefore",
        skip_serializing_if = "Option::is_none"
    )]
    pub firewall_process_id_before: Option<u32>,
    #[serde(
        rename = "firewallProcessIdAfter",
        skip_serializing_if = "Option::is_none"
    )]
    pub firewall_process_id_after: Option<u32>,
    #[serde(rename = "processId", skip_serializing_if = "Option::is_none")]
    pub process_id: Option<String>,
    #[serde(rename = "deviceIdentity", skip_serializing_if = "Option::is_none")]
    pub device_identity: Option<String>,
    #[serde(rename = "failedInvariants")]
    pub failed_invariants: Vec<String>,
    #[serde(rename = "gpuHmrSuccess")]
    pub gpu_hmr_success: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

impl GpuHmrAcceptanceLedger {
    pub fn new(input: GpuHmrAcceptanceLedgerInput) -> Self {
        let mut failed = Vec::new();
        if input.hot_reload {
            match input.cpu_hmr_used {
                Some(true) => failed.push("cpu_hmr_used".to_string()),
                Some(false) => {}
                None => failed.push("cpu_hmr_absence_evidence_missing".to_string()),
            }
            match input.full_rebuild_used {
                Some(true) => failed.push("full_rebuild_used".to_string()),
                Some(false) => {}
                None => failed.push("full_rebuild_absence_evidence_missing".to_string()),
            }
            match input.process_restarted {
                Some(true) => failed.push("process_restarted".to_string()),
                Some(false) => {}
                None => failed.push("process_restart_absence_evidence_missing".to_string()),
            }
            let firewall_route = input
                .firewall_route
                .as_deref()
                .unwrap_or_default()
                .trim();
            if firewall_route.is_empty() {
                failed.push("firewall_route_missing".to_string());
            } else if firewall_route
                != crate::hmr::adapter_trait::ReloadFirewallEvidence::GPU_DEVICE_SIDECAR_ROUTE
            {
                failed.push("firewall_route_not_gpu_device_sidecar".to_string());
            }
            if input
                .firewall_evidence_source
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                failed.push("firewall_evidence_source_missing".to_string());
            }
            match (
                input.firewall_process_id_before,
                input.firewall_process_id_after,
            ) {
                (Some(before), Some(after)) if before == after => {}
                (Some(_), Some(_)) => failed.push("process_restarted".to_string()),
                _ => failed.push("firewall_process_boundary_missing".to_string()),
            }
            if input.artifact_id_after.trim().is_empty() {
                failed.push("artifact_after_missing".to_string());
            }
            if input.loader_artifact_id.as_deref() != Some(input.artifact_id_after.as_str()) {
                failed.push("loader_artifact_mismatch".to_string());
            }
            if input.epoch_publish_artifact_id.as_deref() != Some(input.artifact_id_after.as_str()) {
                failed.push("epoch_publish_artifact_mismatch".to_string());
            }
            if input.dispatch_artifact_id.as_deref() != Some(input.artifact_id_after.as_str()) {
                failed.push("dispatch_artifact_mismatch".to_string());
            }
            if input.output_artifact_id.as_deref() != Some(input.artifact_id_after.as_str()) {
                failed.push("output_artifact_mismatch".to_string());
            }
            if !input.output_oracle_passed {
                failed.push("output_oracle_not_passed".to_string());
            }
            if !input.output_after_dispatch {
                failed.push("output_not_after_dispatch".to_string());
            }
            if !input.retirement_proven {
                failed.push("epoch_retirement_unproven".to_string());
            }
            if input.process_id.as_deref().unwrap_or_default().trim().is_empty() {
                failed.push("process_identity_missing".to_string());
            }
            if input
                .device_identity
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                failed.push("device_identity_missing".to_string());
            }
        }
        let gpu_hmr_success = input.hot_reload && failed.is_empty();
        let created_at = now_rfc3339();
        let material = json!({
            "schemaVersion": GPU_HMR_ACCEPTANCE_LEDGER_SCHEMA_VERSION,
            "hotReload": input.hot_reload,
            "artifactIdAfter": input.artifact_id_after,
            "loaderArtifactId": input.loader_artifact_id,
            "epochPublishArtifactId": input.epoch_publish_artifact_id,
            "dispatchArtifactId": input.dispatch_artifact_id,
            "outputArtifactId": input.output_artifact_id,
            "outputOraclePassed": input.output_oracle_passed,
            "outputAfterDispatch": input.output_after_dispatch,
            "retirementProven": input.retirement_proven,
            "cpuHmrUsed": input.cpu_hmr_used.unwrap_or(false),
            "cpuHmrAbsenceEvidencePresent": input.cpu_hmr_used.is_some(),
            "fullRebuildUsed": input.full_rebuild_used.unwrap_or(false),
            "fullRebuildAbsenceEvidencePresent": input.full_rebuild_used.is_some(),
            "processRestarted": input.process_restarted.unwrap_or(false),
            "processRestartAbsenceEvidencePresent": input.process_restarted.is_some(),
            "firewallRoute": input.firewall_route,
            "firewallEvidenceSource": input.firewall_evidence_source,
            "firewallProcessIdBefore": input.firewall_process_id_before,
            "firewallProcessIdAfter": input.firewall_process_id_after,
            "processId": input.process_id,
            "deviceIdentity": input.device_identity,
            "failedInvariants": failed,
            "gpuHmrSuccess": gpu_hmr_success,
            "createdAt": created_at,
        });
        Self {
            schema_version: GPU_HMR_ACCEPTANCE_LEDGER_SCHEMA_VERSION.to_string(),
            ledger_id: format!("gpu-hmr-ledger:{}", stable_json_hash(&material)),
            hot_reload: material["hotReload"].as_bool().unwrap_or(false),
            artifact_id_after: material["artifactIdAfter"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            loader_artifact_id: material["loaderArtifactId"].as_str().map(str::to_string),
            epoch_publish_artifact_id: material["epochPublishArtifactId"]
                .as_str()
                .map(str::to_string),
            dispatch_artifact_id: material["dispatchArtifactId"].as_str().map(str::to_string),
            output_artifact_id: material["outputArtifactId"].as_str().map(str::to_string),
            output_oracle_passed: material["outputOraclePassed"].as_bool().unwrap_or(false),
            output_after_dispatch: material["outputAfterDispatch"].as_bool().unwrap_or(false),
            retirement_proven: material["retirementProven"].as_bool().unwrap_or(false),
            cpu_hmr_used: material["cpuHmrUsed"].as_bool().unwrap_or(false),
            cpu_hmr_absence_evidence_present: material["cpuHmrAbsenceEvidencePresent"]
                .as_bool()
                .unwrap_or(false),
            full_rebuild_used: material["fullRebuildUsed"].as_bool().unwrap_or(false),
            full_rebuild_absence_evidence_present: material["fullRebuildAbsenceEvidencePresent"]
                .as_bool()
                .unwrap_or(false),
            process_restarted: material["processRestarted"].as_bool().unwrap_or(false),
            process_restart_absence_evidence_present: material["processRestartAbsenceEvidencePresent"]
                .as_bool()
                .unwrap_or(false),
            firewall_route: material["firewallRoute"].as_str().map(str::to_string),
            firewall_evidence_source: material["firewallEvidenceSource"]
                .as_str()
                .map(str::to_string),
            firewall_process_id_before: material["firewallProcessIdBefore"]
                .as_u64()
                .and_then(|value| u32::try_from(value).ok()),
            firewall_process_id_after: material["firewallProcessIdAfter"]
                .as_u64()
                .and_then(|value| u32::try_from(value).ok()),
            process_id: material["processId"].as_str().map(str::to_string),
            device_identity: material["deviceIdentity"].as_str().map(str::to_string),
            failed_invariants: serde_json::from_value(material["failedInvariants"].clone())
                .unwrap_or_default(),
            gpu_hmr_success: material["gpuHmrSuccess"].as_bool().unwrap_or(false),
            created_at: material["createdAt"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        }
    }

    pub fn to_log_line(&self) -> String {
        serde_json::json!({
            "type": "gpu_hmr_acceptance_ledger",
            "schemaVersion": self.schema_version,
            "ledgerId": self.ledger_id,
            "hotReload": self.hot_reload,
            "artifactIdAfter": self.artifact_id_after,
            "loaderArtifactId": self.loader_artifact_id,
            "epochPublishArtifactId": self.epoch_publish_artifact_id,
            "dispatchArtifactId": self.dispatch_artifact_id,
            "outputArtifactId": self.output_artifact_id,
            "outputOraclePassed": self.output_oracle_passed,
            "outputAfterDispatch": self.output_after_dispatch,
            "retirementProven": self.retirement_proven,
            "cpuHmrUsed": self.cpu_hmr_used,
            "cpuHmrAbsenceEvidencePresent": self.cpu_hmr_absence_evidence_present,
            "fullRebuildUsed": self.full_rebuild_used,
            "fullRebuildAbsenceEvidencePresent": self.full_rebuild_absence_evidence_present,
            "processRestarted": self.process_restarted,
            "processRestartAbsenceEvidencePresent": self.process_restart_absence_evidence_present,
            "firewallRoute": self.firewall_route,
            "firewallEvidenceSource": self.firewall_evidence_source,
            "firewallProcessIdBefore": self.firewall_process_id_before,
            "firewallProcessIdAfter": self.firewall_process_id_after,
            "processId": self.process_id,
            "deviceIdentity": self.device_identity,
            "failedInvariants": self.failed_invariants,
            "gpuHmrSuccess": self.gpu_hmr_success,
            "createdAt": self.created_at,
        })
        .to_string()
    }
}

impl GpuHmrProofArtifact {
    pub fn new(input: GpuHmrProofArtifactInput) -> Self {
        let created_at = input.created_at.unwrap_or_else(now_rfc3339);
        let proof_material = json!({
            "schemaVersion": GPU_HMR_PROOF_SCHEMA_VERSION,
            "workspaceSlug": input.workspace_slug,
            "runtimeSessionId": input.runtime_session_id,
            "sourceEditId": input.source_edit_id,
            "selectedArtifactId": input.selected_artifact_id,
            "resultState": input.result_state,
            "degradedState": input.degraded_state,
            "degradedReason": input.degraded_reason,
            "stageResults": input.stage_results,
            "evidenceRefs": input.evidence_refs,
            "visualEvidenceRefs": input.visual_evidence_refs,
            "createdAt": created_at,
        });
        let proof_id = format!("gpu-proof:{}", stable_json_hash(&proof_material));

        Self {
            schema_version: GPU_HMR_PROOF_SCHEMA_VERSION.to_string(),
            proof_id,
            workspace_slug: proof_material["workspaceSlug"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            runtime_session_id: proof_material["runtimeSessionId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            source_edit_id: proof_material["sourceEditId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            selected_artifact_id: proof_material["selectedArtifactId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            result_state: proof_material["resultState"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            degraded_state: proof_material["degradedState"].as_str().map(str::to_string),
            degraded_reason: proof_material["degradedReason"]
                .as_str()
                .map(str::to_string),
            stage_results: serde_json::from_value(proof_material["stageResults"].clone())
                .unwrap_or_default(),
            evidence_refs: serde_json::from_value(proof_material["evidenceRefs"].clone())
                .unwrap_or_default(),
            visual_evidence_refs: serde_json::from_value(
                proof_material["visualEvidenceRefs"].clone(),
            )
            .unwrap_or_default(),
            created_at: proof_material["createdAt"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
        }
    }

    pub fn validate_contract(&self) -> Result<()> {
        if self.schema_version != GPU_HMR_PROOF_SCHEMA_VERSION {
            anyhow::bail!(
                "unsupported GPU HMR proof artifact schemaVersion: {}",
                self.schema_version
            );
        }
        if self.proof_id.trim().is_empty()
            || self.workspace_slug.trim().is_empty()
            || self.runtime_session_id.trim().is_empty()
            || self.source_edit_id.trim().is_empty()
            || self.selected_artifact_id.trim().is_empty()
            || self.result_state.trim().is_empty()
            || self.created_at.trim().is_empty()
        {
            anyhow::bail!("GPU HMR proof artifact is missing required identity fields");
        }
        for stage in &self.stage_results {
            if stage.stage_id.trim().is_empty()
                || stage.stage_name.trim().is_empty()
                || stage.status.trim().is_empty()
                || stage.started_at.trim().is_empty()
                || stage.completed_at.trim().is_empty()
            {
                anyhow::bail!("GPU HMR proof artifact contains an incomplete stage record");
            }
        }
        for evidence in self
            .evidence_refs
            .iter()
            .chain(self.visual_evidence_refs.iter())
        {
            if evidence.evidence_id.trim().is_empty()
                || evidence.kind.trim().is_empty()
                || evidence.content_hash.trim().is_empty()
                || evidence.producer_subsystem.trim().is_empty()
                || evidence.timestamp.trim().is_empty()
                || evidence.summary.trim().is_empty()
            {
                anyhow::bail!("GPU HMR proof artifact contains an incomplete evidence ref");
            }
        }
        Ok(())
    }
}

pub async fn write_proof_artifact(
    workspace: &Path,
    artifact: &GpuHmrProofArtifact,
) -> Result<GpuHmrProofArtifactWrite> {
    artifact.validate_contract()?;

    let proof_dir = workspace.join(".synthi").join("gpu-hmr").join("proofs");
    tokio::fs::create_dir_all(&proof_dir)
        .await
        .with_context(|| format!("creating GPU HMR proof directory {}", proof_dir.display()))?;

    let proof_path = proof_dir.join(format!("{}.json", safe_path_component(&artifact.proof_id)));
    let latest_path = workspace
        .join(".synthi")
        .join("gpu-hmr")
        .join("latest.json");
    let bytes =
        serde_json::to_vec_pretty(artifact).context("serializing GPU HMR proof artifact")?;

    write_json_atomic(&proof_path, &bytes).await?;
    write_json_atomic(&latest_path, &bytes).await?;

    Ok(GpuHmrProofArtifactWrite {
        proof_id: artifact.proof_id.clone(),
        relative_path: relative_path(workspace, &proof_path),
        path: proof_path,
    })
}

pub async fn read_proof_artifact(path: &Path) -> Result<GpuHmrProofArtifact> {
    let bytes = tokio::fs::read(path)
        .await
        .with_context(|| format!("reading GPU HMR proof artifact {}", path.display()))?;
    let artifact: GpuHmrProofArtifact =
        serde_json::from_slice(&bytes).context("parsing GPU HMR proof artifact")?;
    artifact.validate_contract()?;
    Ok(artifact)
}

pub async fn read_latest_proof_artifact(workspace: &Path) -> Result<GpuHmrProofArtifact> {
    read_proof_artifact(
        &workspace
            .join(".synthi")
            .join("gpu-hmr")
            .join("latest.json"),
    )
    .await
}

pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn sha256_hex_str(value: &str) -> String {
    sha256_hex_bytes(value.as_bytes())
}

pub fn stable_json_hash(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    sha256_hex_bytes(&bytes)
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn safe_path_component(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

async fn write_json_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp_path = path.with_extension("json.tmp");
    tokio::fs::write(&tmp_path, bytes)
        .await
        .with_context(|| format!("writing GPU HMR proof temp file {}", tmp_path.display()))?;
    match tokio::fs::rename(&tmp_path, path).await {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            let _ = tokio::fs::remove_file(path).await;
            tokio::fs::rename(&tmp_path, path).await.with_context(|| {
                format!(
                    "replacing GPU HMR proof artifact {} after initial rename failed: {}",
                    path.display(),
                    rename_error
                )
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_state_names_match_runtime_correctness_contract() {
        assert_eq!(
            GpuHmrProofState::CompileProven.as_str(),
            "gpu-hmr-compile-proven"
        );
        assert_eq!(
            GpuHmrProofState::DispatchObserved.as_str(),
            "gpu-hmr-dispatch-observed"
        );
        assert_eq!(
            GpuHmrProofState::DispatchSafeProven.as_str(),
            "gpu-hmr-dispatch-safe-proven"
        );
        assert_eq!(
            GpuHmrProofState::OutputOracleProven.as_str(),
            "gpu-hmr-output-oracle-proven"
        );
        assert_eq!(
            GpuHmrProofState::FullRuntimeProven.as_str(),
            "gpu-hmr-full-runtime-proven"
        );
        assert!(GpuHmrProofState::FullRuntimeProven.rank() > GpuHmrProofState::SymbolBound.rank());
    }

    #[test]
    fn degraded_state_names_match_runtime_correctness_contract() {
        assert_eq!(
            GpuHmrDegradedState::FakeLaunchPath.as_str(),
            "gpu-hmr-fake-launch-path"
        );
        assert_eq!(
            GpuHmrDegradedState::UnknownArgProvenance.as_str(),
            "gpu-hmr-unknown-arg-provenance"
        );
        assert_eq!(
            GpuHmrDegradedState::EpochSwapUnverified.as_str(),
            "gpu-hmr-epoch-swap-unverified"
        );
        assert_eq!(
            GpuHmrDegradedState::RamIoUnavailable.as_str(),
            "gpu-hmr-ram-io-unavailable"
        );
        assert_eq!(
            GpuHmrDegradedState::OriginalHostPathUnattached.as_str(),
            "gpu-hmr-original-host-path-unattached"
        );
        assert_eq!(
            GpuHmrDegradedState::VisualOnly.as_str(),
            "gpu-hmr-visual-only"
        );
    }

    #[test]
    fn telemetry_log_line_is_machine_parseable() {
        let telemetry = GpuHmrProofTelemetry::new(
            GpuHmrProofState::SymbolBound,
            Some(GpuHmrDegradedState::DispatchUnobserved),
            Some("runtime_dispatch_not_observed".to_string()),
            Some("gpu-hmr-partial".to_string()),
        );
        let line = telemetry.to_log_line();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "gpu_hmr_proof");
        assert_eq!(value["schemaVersion"], "synthi.gpu.hmr.proof.v1");
        assert!(value["proofId"].is_null());
        assert_eq!(value["resultState"], "gpu-hmr-symbol-bound");
        assert_eq!(value["degradedState"], "gpu-hmr-dispatch-unobserved");
        assert_eq!(value["label"], "gpu-hmr-partial");
    }

    #[test]
    fn telemetry_log_line_carries_artifact_refs() {
        let telemetry = GpuHmrProofTelemetry::new(
            GpuHmrProofState::CompileProven,
            Some(GpuHmrDegradedState::DispatchUnobserved),
            Some("runtime_dispatch_not_observed".to_string()),
            None,
        )
        .with_artifact_ref(
            "gpu-proof:abc".to_string(),
            ".synthi/gpu-hmr/proofs/gpu-proof_abc.json".to_string(),
        );

        let value: serde_json::Value = serde_json::from_str(&telemetry.to_log_line()).unwrap();
        assert_eq!(value["proofId"], "gpu-proof:abc");
        assert_eq!(
            value["proofArtifactPath"],
            ".synthi/gpu-hmr/proofs/gpu-proof_abc.json"
        );
    }

    fn accepted_ledger_input() -> GpuHmrAcceptanceLedgerInput {
        GpuHmrAcceptanceLedgerInput {
            hot_reload: true,
            artifact_id_after: "artifact:sha256:after".to_string(),
            loader_artifact_id: Some("artifact:sha256:after".to_string()),
            epoch_publish_artifact_id: Some("artifact:sha256:after".to_string()),
            dispatch_artifact_id: Some("artifact:sha256:after".to_string()),
            output_artifact_id: Some("artifact:sha256:after".to_string()),
            output_oracle_passed: true,
            output_after_dispatch: true,
            retirement_proven: true,
            cpu_hmr_used: Some(false),
            full_rebuild_used: Some(false),
            process_restarted: Some(false),
            firewall_route: Some(
                crate::hmr::adapter_trait::ReloadFirewallEvidence::GPU_DEVICE_SIDECAR_ROUTE
                    .to_string(),
            ),
            firewall_evidence_source: Some("gpu_proof_test:accepted_ledger_input".to_string()),
            firewall_process_id_before: Some(42),
            firewall_process_id_after: Some(42),
            process_id: Some("pid:1".to_string()),
            device_identity: Some("device:test".to_string()),
        }
    }

    #[test]
    fn acceptance_ledger_accepts_full_hot_reload_event_chain() {
        let ledger = GpuHmrAcceptanceLedger::new(accepted_ledger_input());
        assert!(ledger.gpu_hmr_success);
        assert!(ledger.failed_invariants.is_empty());
        let value: serde_json::Value = serde_json::from_str(&ledger.to_log_line()).unwrap();
        assert_eq!(value["type"], "gpu_hmr_acceptance_ledger");
        assert_eq!(
            value["schemaVersion"],
            GPU_HMR_ACCEPTANCE_LEDGER_SCHEMA_VERSION
        );
        assert_eq!(value["gpuHmrSuccess"], true);
        assert_eq!(value["cpuHmrAbsenceEvidencePresent"], true);
        assert_eq!(value["fullRebuildAbsenceEvidencePresent"], true);
        assert_eq!(value["processRestartAbsenceEvidencePresent"], true);
    }

    #[test]
    fn acceptance_ledger_rejects_missing_firewall_evidence() {
        let mut input = accepted_ledger_input();
        input.cpu_hmr_used = None;
        input.full_rebuild_used = None;
        input.process_restarted = None;
        input.firewall_route = None;
        input.firewall_evidence_source = None;
        input.firewall_process_id_before = None;
        input.firewall_process_id_after = None;
        let ledger = GpuHmrAcceptanceLedger::new(input);
        assert!(!ledger.gpu_hmr_success);
        assert!(ledger
            .failed_invariants
            .contains(&"cpu_hmr_absence_evidence_missing".to_string()));
        assert!(ledger
            .failed_invariants
            .contains(&"full_rebuild_absence_evidence_missing".to_string()));
        assert!(ledger
            .failed_invariants
            .contains(&"process_restart_absence_evidence_missing".to_string()));
        assert!(ledger
            .failed_invariants
            .contains(&"firewall_route_missing".to_string()));
        assert!(ledger
            .failed_invariants
            .contains(&"firewall_evidence_source_missing".to_string()));
        assert!(ledger
            .failed_invariants
            .contains(&"firewall_process_boundary_missing".to_string()));
    }

    #[test]
    fn acceptance_ledger_rejects_non_gpu_firewall_route() {
        let mut input = accepted_ledger_input();
        input.firewall_route = Some("cpu_hmr_or_host_reload".to_string());
        let ledger = GpuHmrAcceptanceLedger::new(input);
        assert!(!ledger.gpu_hmr_success);
        assert!(ledger
            .failed_invariants
            .contains(&"firewall_route_not_gpu_device_sidecar".to_string()));
    }

    #[test]
    fn acceptance_ledger_rejects_process_boundary_change() {
        let mut input = accepted_ledger_input();
        input.firewall_process_id_after = Some(43);
        let ledger = GpuHmrAcceptanceLedger::new(input);
        assert!(!ledger.gpu_hmr_success);
        assert!(ledger
            .failed_invariants
            .contains(&"process_restarted".to_string()));
    }

    #[test]
    fn acceptance_ledger_rejects_hot_reload_without_output_oracle() {
        let mut input = accepted_ledger_input();
        input.output_oracle_passed = false;
        input.output_after_dispatch = false;
        input.output_artifact_id = None;
        let ledger = GpuHmrAcceptanceLedger::new(input);
        assert!(!ledger.gpu_hmr_success);
        assert!(ledger
            .failed_invariants
            .contains(&"output_oracle_not_passed".to_string()));
        assert!(ledger
            .failed_invariants
            .contains(&"output_not_after_dispatch".to_string()));
        assert!(ledger
            .failed_invariants
            .contains(&"output_artifact_mismatch".to_string()));
    }

    #[test]
    fn proof_artifact_contains_required_contract_fields() {
        let created_at = "2026-05-26T00:00:00Z".to_string();
        let artifact = sample_artifact(created_at.clone());
        artifact.validate_contract().unwrap();

        assert_eq!(artifact.schema_version, GPU_HMR_PROOF_SCHEMA_VERSION);
        assert!(artifact.proof_id.starts_with("gpu-proof:"));
        assert_eq!(artifact.workspace_slug, "workspace-a");
        assert_eq!(artifact.runtime_session_id, "runtime-session:session-a");
        assert_eq!(artifact.source_edit_id, "source-edit:hash-a");
        assert_eq!(artifact.selected_artifact_id, "artifact:sha256:artifact-a");
        assert_eq!(artifact.result_state, "gpu-hmr-symbol-bound");
        assert_eq!(artifact.created_at, created_at);
        assert_eq!(artifact.stage_results[0].stage_id, "device-compile");
        assert_eq!(
            artifact.evidence_refs[0].producer_subsystem,
            "worker.compile_device"
        );
    }

    #[test]
    fn proof_id_is_stable_for_same_material() {
        let left = sample_artifact("2026-05-26T00:00:00Z".to_string());
        let right = sample_artifact("2026-05-26T00:00:00Z".to_string());
        let changed = sample_artifact("2026-05-26T00:00:01Z".to_string());

        assert_eq!(left.proof_id, right.proof_id);
        assert_ne!(left.proof_id, changed.proof_id);
    }

    #[tokio::test]
    async fn proof_artifact_writer_round_trips_latest() {
        let temp = tempfile::tempdir().unwrap();
        let artifact = sample_artifact("2026-05-26T00:00:00Z".to_string());
        let written = write_proof_artifact(temp.path(), &artifact).await.unwrap();

        assert_eq!(written.proof_id, artifact.proof_id);
        assert!(written.relative_path.starts_with(".synthi/gpu-hmr/proofs/"));

        let exact = read_proof_artifact(&written.path).await.unwrap();
        let latest = read_latest_proof_artifact(temp.path()).await.unwrap();
        assert_eq!(exact, artifact);
        assert_eq!(latest, artifact);
    }

    fn sample_artifact(created_at: String) -> GpuHmrProofArtifact {
        GpuHmrProofArtifact::new(GpuHmrProofArtifactInput {
            workspace_slug: "workspace-a".to_string(),
            runtime_session_id: "runtime-session:session-a".to_string(),
            source_edit_id: "source-edit:hash-a".to_string(),
            selected_artifact_id: "artifact:sha256:artifact-a".to_string(),
            result_state: "gpu-hmr-symbol-bound".to_string(),
            degraded_state: Some("gpu-hmr-dispatch-unobserved".to_string()),
            degraded_reason: Some("runtime_dispatch_not_observed".to_string()),
            stage_results: vec![GpuHmrProofStageResult {
                stage_id: "device-compile".to_string(),
                stage_name: "Device artifact compile".to_string(),
                status: "passed".to_string(),
                started_at: created_at.clone(),
                completed_at: created_at.clone(),
                input_artifact_ids: vec!["source-edit:hash-a".to_string()],
                output_artifact_ids: vec!["artifact:sha256:artifact-a".to_string()],
                evidence_refs: vec!["evidence:artifact-a".to_string()],
                degraded_state: None,
                degraded_reason: None,
            }],
            evidence_refs: vec![GpuHmrProofEvidenceRef {
                evidence_id: "evidence:artifact-a".to_string(),
                kind: "device-artifact".to_string(),
                content_hash: "sha256:artifact-a".to_string(),
                producer_subsystem: "worker.compile_device".to_string(),
                timestamp: created_at.clone(),
                session_id: Some("runtime-session:session-a".to_string()),
                file_path: Some("build/device.hsaco".to_string()),
                artifact_uri: Some("artifact:sha256:artifact-a".to_string()),
                summary: "Compiled device artifact bytes".to_string(),
                metadata: None,
            }],
            visual_evidence_refs: Vec::new(),
            created_at: Some(created_at),
        })
    }
}
