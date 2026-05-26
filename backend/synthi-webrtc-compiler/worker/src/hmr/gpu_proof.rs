use anyhow::{Context, Result};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub const GPU_HMR_PROOF_SCHEMA_VERSION: &str = "synthi.gpu.hmr.proof.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GpuHmrProofState {
    CompileProven,
    SymbolBound,
    AbiProven,
    DispatchProven,
    OutputProven,
    HostPreservationProven,
    FullRuntimeProven,
}

impl GpuHmrProofState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CompileProven => "gpu-hmr-compile-proven",
            Self::SymbolBound => "gpu-hmr-symbol-bound",
            Self::AbiProven => "gpu-hmr-abi-proven",
            Self::DispatchProven => "gpu-hmr-dispatch-proven",
            Self::OutputProven => "gpu-hmr-output-proven",
            Self::HostPreservationProven => "gpu-hmr-host-preservation-proven",
            Self::FullRuntimeProven => "gpu-hmr-full-runtime-proven",
        }
    }

    pub fn rank(self) -> u8 {
        match self {
            Self::CompileProven => 1,
            Self::SymbolBound => 2,
            Self::AbiProven => 3,
            Self::DispatchProven => 4,
            Self::OutputProven => 5,
            Self::HostPreservationProven => 6,
            Self::FullRuntimeProven => 7,
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
            degraded_state: degraded_state.map(GpuHmrDegradedState::as_str).map(str::to_string),
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
            GpuHmrProofState::DispatchProven.as_str(),
            "gpu-hmr-dispatch-proven"
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
