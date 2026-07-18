// ============================================================
// ADAPTER TRAIT
// ============================================================
// Unified trait that all adapter families implement.  The
// planner calls into adapters through this trait, never through
// language-specific or family-specific branches.
// ============================================================

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::hmr::adapter_matrix::{AdapterFamily, CapabilityTier};
use crate::hmr::build_manifest::BuildManifest;

// ── Adapter lifecycle events ────────────────────────────────

/// Optional in-memory artifact payload carried alongside a reload request.
///
/// The byte payload is intentionally skipped during serde so status messages
/// and diagnostics can expose the blob id/hash without serializing large
/// compiled artifacts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReloadArtifactBlob {
    /// Content-addressed id for the artifact bytes.
    pub blob_id: String,
    /// SHA-256 content hash, formatted as `sha256:<hex>`.
    pub content_hash: String,
    /// Artifact bytes available to adapters that support RAM loaders.
    #[serde(skip_serializing, skip_deserializing, default)]
    pub bytes: Vec<u8>,
}

pub const RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.reload_output_oracle_profile_commitment.v1";
pub const RELOAD_OUTPUT_ORACLE_PROOF_CONTEXT_SCHEMA_VERSION: &str =
    "synthi.gpu_hmr.reload_output_oracle_proof_context.v1";
pub const GPU_HMR_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH_ENV: &str =
    "SYNTHI_GPU_HMR_RUNTIME_OUTPUT_ORACLE_PATH";
pub const GPU_HMR_RUNTIME_OUTPUT_ORACLE_PROFILE_DEFAULT_PATH: &str =
    "/tmp/synthi-gpu-hmr-runtime-output-oracle.json";

pub fn configured_gpu_hmr_runtime_output_oracle_profile_path() -> PathBuf {
    std::env::var(GPU_HMR_RUNTIME_OUTPUT_ORACLE_PROFILE_PATH_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(GPU_HMR_RUNTIME_OUTPUT_ORACLE_PROFILE_DEFAULT_PATH))
}

/// Hash-only commitment to an output oracle fixed before candidate publication.
///
/// This does not authorize output proof by itself. The GPU adapter must verify
/// every field against the exact candidate, capsule contract, and profile bytes
/// before it may execute an authoritative output probe.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReloadOutputOracleProfileCommitment {
    #[serde(default)]
    pub schema_version: String,
    #[serde(default)]
    pub candidate_artifact_sha256: String,
    #[serde(default)]
    pub fission_output_oracle_contract_sha256: String,
    #[serde(default)]
    pub profile_bytes_sha256: String,
    #[serde(default)]
    pub edit_id: String,
}

/// Content binding between a verified proof and the exact capsule fields sent
/// to the target process. The target still compares `runtime_session_id`
/// against the independently transported reload envelope before mutation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReloadOutputOracleProofContext {
    #[serde(default)]
    pub schema_version: String,
    #[serde(default)]
    pub proof_id: String,
    #[serde(default)]
    pub proof_created_at: String,
    #[serde(default)]
    pub runtime_session_id: String,
    #[serde(default)]
    pub binding_sha256: String,
}

/// Optional proof/capsule identity metadata for a hot-reload publication.
///
/// Adapters may ignore fields they cannot use, but GPU epoch publication
/// proof records this metadata when present so validation can distinguish a
/// real generation capsule from a path-only module swap.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReloadCapsuleMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fission_island_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fission_verifier_evidence_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_verifier_evidence_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deterministic_verifier_evidence_refs: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fission_source_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fission_selection_decision_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fission_output_oracle_contract: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_oracle_profile_commitment: Option<ReloadOutputOracleProfileCommitment>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub output_oracle_proof_context: Option<ReloadOutputOracleProofContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abi_membrane_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependency_closure_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proof_hash: Option<String>,
}

/// Process-local evidence minted by the reload router. It is deliberately not
/// serializable so a project request cannot manufacture firewall authority.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReloadFirewallEvidence {
    cpu_hmr_used: Option<bool>,
    full_rebuild_used: Option<bool>,
    process_restarted: Option<bool>,
    route: Option<String>,
    evidence_source: Option<String>,
    process_id_before: Option<u32>,
    process_id_after: Option<u32>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct VerifiedReloadFirewallReceipt {
    receipt_id: String,
    cpu_hmr_used: bool,
    full_rebuild_used: bool,
    process_restarted: bool,
    route: String,
    evidence_source: String,
    process_id_before: u32,
    process_id_after: u32,
}

impl VerifiedReloadFirewallReceipt {
    pub(crate) fn receipt_id(&self) -> &str {
        &self.receipt_id
    }

    pub(crate) fn cpu_hmr_used(&self) -> bool {
        self.cpu_hmr_used
    }

    pub(crate) fn full_rebuild_used(&self) -> bool {
        self.full_rebuild_used
    }

    pub(crate) fn process_restarted(&self) -> bool {
        self.process_restarted
    }

    pub(crate) fn route(&self) -> &str {
        &self.route
    }

    pub(crate) fn evidence_source(&self) -> &str {
        &self.evidence_source
    }

    pub(crate) fn process_id_before(&self) -> u32 {
        self.process_id_before
    }

    pub(crate) fn process_id_after(&self) -> u32 {
        self.process_id_after
    }
}

impl ReloadFirewallEvidence {
    pub const GPU_DEVICE_SIDECAR_ROUTE: &'static str = "gpu_device_sidecar_reload";

    pub(crate) fn from_gpu_device_sidecar_boundary(
        evidence_source: impl Into<String>,
        process_id_before: u32,
        process_id_after: u32,
    ) -> Self {
        Self {
            cpu_hmr_used: Some(false),
            full_rebuild_used: Some(false),
            process_restarted: Some(process_id_before != process_id_after),
            route: Some(Self::GPU_DEVICE_SIDECAR_ROUTE.to_string()),
            evidence_source: Some(evidence_source.into()),
            process_id_before: Some(process_id_before),
            process_id_after: Some(process_id_after),
        }
    }

    pub(crate) fn verify_gpu_device_sidecar_boundary(
        &self,
        current_process_id: u32,
    ) -> Result<VerifiedReloadFirewallReceipt, &'static str> {
        let evidence_source = self
            .evidence_source
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("reload_firewall_evidence_source_missing")?;
        let process_id_before = self
            .process_id_before
            .ok_or("reload_firewall_process_id_before_missing")?;
        let process_id_after = self
            .process_id_after
            .ok_or("reload_firewall_process_id_after_missing")?;
        if self.cpu_hmr_used != Some(false)
            || self.full_rebuild_used != Some(false)
            || self.process_restarted != Some(false)
            || self.route.as_deref() != Some(Self::GPU_DEVICE_SIDECAR_ROUTE)
        {
            return Err("reload_firewall_route_not_gpu_device_sidecar");
        }
        if process_id_before != current_process_id || process_id_after != current_process_id {
            return Err("reload_firewall_process_identity_mismatch");
        }

        let material = json!({
            "schemaVersion": "synthi.gpu_hmr.reload_firewall_receipt.v1",
            "route": Self::GPU_DEVICE_SIDECAR_ROUTE,
            "evidenceSource": evidence_source,
            "processIdBefore": process_id_before,
            "processIdAfter": process_id_after,
            "cpuHmrUsed": false,
            "fullRebuildUsed": false,
            "processRestarted": false,
        });
        Ok(VerifiedReloadFirewallReceipt {
            receipt_id: format!(
                "reload-firewall-receipt:{}",
                sha256_prefixed(stable_json_string(&material).as_bytes())
            ),
            cpu_hmr_used: false,
            full_rebuild_used: false,
            process_restarted: false,
            route: Self::GPU_DEVICE_SIDECAR_ROUTE.to_string(),
            evidence_source: evidence_source.to_string(),
            process_id_before,
            process_id_after,
        })
    }
}

const RELOAD_CAPSULE_METADATA_TOKEN_PREFIX: &str = "capsulev1_";

fn stable_json_string(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
        }
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_json_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let fields = keys
                .into_iter()
                .map(|key| {
                    let encoded_key =
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
                    let encoded_value = stable_json_string(map.get(key).unwrap_or(&Value::Null));
                    format!("{encoded_key}:{encoded_value}")
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
    }
}

fn sha256_prefixed(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{:x}", hasher.finalize())
}

/// Returns the canonical content hash for a typed output-oracle contract.
/// Callers and validators share this function so object key insertion order
/// cannot create different commitments for the same contract.
pub fn reload_output_oracle_contract_content_hash(contract: &Value) -> Option<String> {
    contract
        .is_object()
        .then(|| sha256_prefixed(stable_json_string(contract).as_bytes()))
}

fn canonical_sha256(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn canonical_gpu_proof_id(value: &str) -> Option<&str> {
    let digest = value.strip_prefix("gpu-proof:")?;
    (digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')))
    .then_some(digest)
}

fn proof_context_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.chars().any(char::is_whitespace)
        && !value.chars().any(char::is_control)
}

fn output_oracle_proof_context_material(metadata: &ReloadCapsuleMetadata) -> Option<Value> {
    let context = metadata.output_oracle_proof_context.as_ref()?;
    let commitment = metadata.output_oracle_profile_commitment.as_ref()?;
    Some(json!({
        "schemaVersion": RELOAD_OUTPUT_ORACLE_PROOF_CONTEXT_SCHEMA_VERSION,
        "proofId": context.proof_id,
        "proofCreatedAt": context.proof_created_at,
        "runtimeSessionId": context.runtime_session_id,
        "proofHash": metadata.proof_hash,
        "fissionIslandId": metadata.fission_island_id,
        "fissionVerifierEvidenceId": metadata.fission_verifier_evidence_id,
        "selectedVerifierEvidenceId": metadata.selected_verifier_evidence_id,
        "deterministicVerifierEvidenceRefs": metadata.deterministic_verifier_evidence_refs,
        "fissionSourcePaths": metadata.fission_source_paths,
        "fissionSelectionDecisionHash": metadata.fission_selection_decision_hash,
        "fissionOutputOracleContract": metadata.fission_output_oracle_contract,
        "outputOracleProfileCommitment": commitment,
        "abiMembraneHash": metadata.abi_membrane_hash,
        "dependencyClosureHash": metadata.dependency_closure_hash,
    }))
}

fn output_oracle_proof_context_hash(metadata: &ReloadCapsuleMetadata) -> Option<String> {
    let material = output_oracle_proof_context_material(metadata)?;
    Some(sha256_prefixed(stable_json_string(&material).as_bytes()))
}

/// Binds a registry-validated proof identity to every durable capsule field
/// consumed by output-oracle publication. This function does not grant proof
/// authority; the runner must also validate the independently transported
/// runtime-session identity.
pub fn bind_reload_output_oracle_proof_context(
    metadata: &mut ReloadCapsuleMetadata,
    proof_id: &str,
    proof_created_at: &str,
    runtime_session_id: &str,
) -> bool {
    let Some(mut normalized) = normalized_reload_capsule_metadata_fields(metadata) else {
        return false;
    };
    normalized.output_oracle_proof_context = None;
    *metadata = normalized;
    let Some(proof_digest) = canonical_gpu_proof_id(proof_id) else {
        return false;
    };
    let expected_proof_hash = format!("sha256:{proof_digest}");
    if chrono::DateTime::parse_from_rfc3339(proof_created_at).is_err()
        || !proof_context_token(runtime_session_id)
        || metadata.output_oracle_profile_commitment.is_none()
        || metadata.fission_output_oracle_contract.is_none()
        || metadata.proof_hash.as_deref() != Some(expected_proof_hash.as_str())
    {
        return false;
    }
    metadata.output_oracle_proof_context = Some(ReloadOutputOracleProofContext {
        schema_version: RELOAD_OUTPUT_ORACLE_PROOF_CONTEXT_SCHEMA_VERSION.to_string(),
        proof_id: proof_id.to_string(),
        proof_created_at: proof_created_at.to_string(),
        runtime_session_id: runtime_session_id.to_string(),
        binding_sha256: String::new(),
    });
    let Some(binding_sha256) = output_oracle_proof_context_hash(metadata) else {
        metadata.output_oracle_proof_context = None;
        return false;
    };
    metadata
        .output_oracle_proof_context
        .as_mut()
        .expect("proof context inserted above")
        .binding_sha256 = binding_sha256;
    reload_output_oracle_proof_context_valid(metadata, Some(runtime_session_id))
}

/// Recomputes the complete proof/capsule binding and optionally checks the
/// runtime session received through an independent runner-protocol field.
pub fn reload_output_oracle_proof_context_valid(
    metadata: &ReloadCapsuleMetadata,
    expected_runtime_session_id: Option<&str>,
) -> bool {
    let Some(context) = metadata.output_oracle_proof_context.as_ref() else {
        return false;
    };
    let Some(commitment) = metadata.output_oracle_profile_commitment.as_ref() else {
        return false;
    };
    let Some(proof_digest) = canonical_gpu_proof_id(&context.proof_id) else {
        return false;
    };
    let Some(contract_sha256) = metadata
        .fission_output_oracle_contract
        .as_ref()
        .and_then(reload_output_oracle_contract_content_hash)
    else {
        return false;
    };
    let expected_proof_hash = format!("sha256:{proof_digest}");
    context.schema_version == RELOAD_OUTPUT_ORACLE_PROOF_CONTEXT_SCHEMA_VERSION
        && chrono::DateTime::parse_from_rfc3339(&context.proof_created_at).is_ok()
        && proof_context_token(&context.runtime_session_id)
        && expected_runtime_session_id.is_none_or(|expected| expected == context.runtime_session_id)
        && metadata.proof_hash.as_deref() == Some(expected_proof_hash.as_str())
        && commitment.schema_version == RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION
        && canonical_sha256(&commitment.candidate_artifact_sha256)
        && commitment.fission_output_oracle_contract_sha256 == contract_sha256
        && canonical_sha256(&commitment.profile_bytes_sha256)
        && normalized_reload_source_edit_id(Some(&commitment.edit_id)).is_some()
        && canonical_sha256(&context.binding_sha256)
        && output_oracle_proof_context_hash(metadata).as_deref()
            == Some(context.binding_sha256.as_str())
}

/// Recomputes the durable capsule binding and ties it to the independently
/// transported reload envelope. None of these fields grants authority alone.
pub fn reload_output_oracle_proof_context_valid_for_reload(
    metadata: &ReloadCapsuleMetadata,
    expected_runtime_session_id: &str,
    expected_artifact_content_hash: &str,
    expected_source_edit_id: &str,
) -> bool {
    let Some(commitment) = metadata.output_oracle_profile_commitment.as_ref() else {
        return false;
    };
    reload_output_oracle_proof_context_valid(metadata, Some(expected_runtime_session_id))
        && canonical_sha256(expected_artifact_content_hash)
        && commitment.candidate_artifact_sha256 == expected_artifact_content_hash
        && normalized_reload_source_edit_id(Some(expected_source_edit_id)).is_some()
        && commitment.edit_id == expected_source_edit_id
}

fn non_empty_token(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "none")
}

fn normalized_reload_capsule_metadata_fields(
    metadata: &ReloadCapsuleMetadata,
) -> Option<ReloadCapsuleMetadata> {
    let normalized = ReloadCapsuleMetadata {
        fission_island_id: non_empty_token(metadata.fission_island_id.clone()),
        fission_verifier_evidence_id: non_empty_token(
            metadata.fission_verifier_evidence_id.clone(),
        ),
        selected_verifier_evidence_id: non_empty_token(
            metadata.selected_verifier_evidence_id.clone(),
        ),
        deterministic_verifier_evidence_refs: non_empty_string_vec(
            metadata.deterministic_verifier_evidence_refs.clone(),
        ),
        fission_source_paths: non_empty_string_vec(metadata.fission_source_paths.clone()),
        fission_selection_decision_hash: non_empty_token(
            metadata.fission_selection_decision_hash.clone(),
        ),
        fission_output_oracle_contract: non_empty_json_object(
            metadata.fission_output_oracle_contract.clone(),
        ),
        output_oracle_profile_commitment: metadata.output_oracle_profile_commitment.clone().map(
            |commitment| ReloadOutputOracleProfileCommitment {
                schema_version: commitment.schema_version.trim().to_string(),
                candidate_artifact_sha256: commitment.candidate_artifact_sha256.trim().to_string(),
                fission_output_oracle_contract_sha256: commitment
                    .fission_output_oracle_contract_sha256
                    .trim()
                    .to_string(),
                profile_bytes_sha256: commitment.profile_bytes_sha256.trim().to_string(),
                edit_id: commitment.edit_id.trim().to_string(),
            },
        ),
        output_oracle_proof_context: metadata.output_oracle_proof_context.clone().map(|context| {
            ReloadOutputOracleProofContext {
                schema_version: context.schema_version.trim().to_string(),
                proof_id: context.proof_id.trim().to_string(),
                proof_created_at: context.proof_created_at.trim().to_string(),
                runtime_session_id: context.runtime_session_id.trim().to_string(),
                binding_sha256: context.binding_sha256.trim().to_string(),
            }
        }),
        abi_membrane_hash: non_empty_token(metadata.abi_membrane_hash.clone()),
        dependency_closure_hash: non_empty_token(metadata.dependency_closure_hash.clone()),
        proof_hash: non_empty_token(metadata.proof_hash.clone()),
    };
    (normalized.fission_island_id.is_some()
        || normalized.fission_verifier_evidence_id.is_some()
        || normalized.selected_verifier_evidence_id.is_some()
        || normalized.deterministic_verifier_evidence_refs.is_some()
        || normalized.fission_source_paths.is_some()
        || normalized.fission_selection_decision_hash.is_some()
        || normalized.fission_output_oracle_contract.is_some()
        || normalized.output_oracle_profile_commitment.is_some()
        || normalized.output_oracle_proof_context.is_some()
        || normalized.abi_membrane_hash.is_some()
        || normalized.dependency_closure_hash.is_some()
        || normalized.proof_hash.is_some())
    .then_some(normalized)
}

fn normalized_reload_capsule_metadata(
    metadata: &ReloadCapsuleMetadata,
) -> Option<ReloadCapsuleMetadata> {
    let normalized = normalized_reload_capsule_metadata_fields(metadata)?;
    match (
        normalized.output_oracle_profile_commitment.as_ref(),
        normalized.output_oracle_proof_context.as_ref(),
    ) {
        (Some(_), Some(_)) if reload_output_oracle_proof_context_valid(&normalized, None) => {
            Some(normalized)
        }
        (None, None) => Some(normalized),
        _ => None,
    }
}

fn non_empty_string_vec(value: Option<Vec<String>>) -> Option<Vec<String>> {
    let values = value?
        .into_iter()
        .filter_map(|value| non_empty_token(Some(value)))
        .collect::<Vec<_>>();
    (!values.is_empty()).then_some(values)
}

fn non_empty_json_object(value: Option<Value>) -> Option<Value> {
    match value {
        Some(Value::Object(map)) if !map.is_empty() => Some(Value::Object(map)),
        _ => None,
    }
}

pub fn encode_reload_capsule_metadata_token(metadata: &ReloadCapsuleMetadata) -> Option<String> {
    let metadata = normalized_reload_capsule_metadata(metadata)?;
    let json = serde_json::to_vec(&metadata).ok()?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    Some(format!("{RELOAD_CAPSULE_METADATA_TOKEN_PREFIX}{payload}"))
}

pub fn decode_reload_capsule_metadata_token(token: &str) -> Option<ReloadCapsuleMetadata> {
    let payload = token
        .trim()
        .strip_prefix(RELOAD_CAPSULE_METADATA_TOKEN_PREFIX)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.as_bytes())
        .ok()?;
    let metadata = serde_json::from_slice::<ReloadCapsuleMetadata>(&bytes).ok()?;
    normalized_reload_capsule_metadata(&metadata)
}

/// Normalizes a content-addressed source-edit token received through an
/// independent request transport.
///
/// This is correlation input, not proof authority. The GPU adapter must still
/// validate the complete commitment before using this identity in proof output.
pub fn normalized_reload_source_edit_id(value: Option<&str>) -> Option<String> {
    let raw = value?;
    let digest = raw.strip_prefix("source-edit:sha256:")?;
    (digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')))
    .then(|| raw.to_string())
}

/// High-level reload request that the planner feeds to an adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterReloadRequest {
    /// Unique reload ID for correlation.
    pub reload_id: String,
    /// Proof-derived source edit identity, kept separate from reload correlation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_edit_id: Option<String>,
    /// Module that changed.
    pub module_id: String,
    /// Paths of changed files.
    pub changed_files: Vec<String>,
    /// Build manifest from the latest compilation.
    pub build_manifest: BuildManifest,
    /// Optional RAM artifact payload for adapters with byte/blob loaders.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub artifact_blob: Option<ReloadArtifactBlob>,
    /// Optional capsule proof metadata for generation-published reloads.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub capsule_metadata: Option<ReloadCapsuleMetadata>,
    /// Process-local firewall evidence. Serialized requests cannot set it.
    #[serde(skip)]
    pub(crate) firewall_evidence: ReloadFirewallEvidence,
    /// Whether state preservation is requested.
    pub preserve_state: bool,
    /// Timeout for this reload (millis).
    pub timeout_ms: u64,
}

impl AdapterReloadRequest {
    /// Creates an untrusted reload request with no process-local proof authority.
    ///
    /// Runtime routing code must explicitly transition it onto the process-local
    /// GPU device-sidecar route after parsing any serialized input.
    pub fn new(
        reload_id: impl Into<String>,
        module_id: impl Into<String>,
        changed_files: Vec<String>,
        build_manifest: BuildManifest,
        preserve_state: bool,
        timeout_ms: u64,
    ) -> Self {
        Self {
            reload_id: reload_id.into(),
            source_edit_id: None,
            module_id: module_id.into(),
            changed_files,
            build_manifest,
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: ReloadFirewallEvidence::default(),
            preserve_state,
            timeout_ms,
        }
    }

    /// Selects the process-local GPU device-sidecar route without accepting
    /// serialized or caller-supplied proof fields.
    pub fn into_gpu_device_sidecar_route(mut self) -> Self {
        let process_id = std::process::id();
        self.firewall_evidence = ReloadFirewallEvidence::from_gpu_device_sidecar_boundary(
            "adapter_reload_request:gpu_device_sidecar_route",
            process_id,
            process_id,
        );
        self
    }
}

/// Result of an adapter reload attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AdapterReloadResult {
    /// Reload succeeded with optional state-round-trip info.
    Success {
        reload_ms: u64,
        state_preserved: bool,
    },
    /// Reload failed but the old artifact is still running.
    Failed { error: String, recoverable: bool },
    /// Adapter cannot handle this reload; escalate to cold path.
    Unsupported { reason: String },
}

/// Health of an adapter after a reload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AdapterHealth {
    Healthy,
    Degraded,
    Faulted,
    Unknown,
}

/// Adapter info exposed to the planner / telemetry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterInfo {
    pub name: String,
    pub family: AdapterFamily,
    pub capability_tier: CapabilityTier,
    pub supported_languages: Vec<String>,
    pub extra: HashMap<String, String>,
}

// ── The trait ────────────────────────────────────────────────

/// Every adapter family implements this trait.  The planner
/// dispatches through it without knowing the concrete type.
pub trait Adapter: Send + Sync {
    /// Static metadata about this adapter.
    fn info(&self) -> AdapterInfo;

    /// Called once before the first reload.  Sets up any long-lived
    /// resources (e.g. a JVM, a dlopen handle, a child process).
    fn initialize(&mut self) -> Result<(), String>;

    /// Tear down resources.
    fn shutdown(&mut self) -> Result<(), String>;

    /// Perform a hot reload.
    fn reload(&mut self, req: &AdapterReloadRequest) -> AdapterReloadResult;

    /// Export current state from the running artifact.
    fn snapshot_state(&self) -> Result<Vec<u8>, String>;

    /// Import state into the (possibly new) artifact.
    fn restore_state(&mut self, data: &[u8]) -> Result<(), String>;

    /// Quick liveness check after the last reload.
    fn healthcheck(&self) -> AdapterHealth;

    /// Human-readable status line for diagnostics.
    fn status_line(&self) -> String {
        format!("{}: {:?}", self.info().name, self.healthcheck())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dummy adapter to verify the trait compiles.
    struct NoopAdapter;

    impl Adapter for NoopAdapter {
        fn info(&self) -> AdapterInfo {
            AdapterInfo {
                name: "noop".into(),
                family: AdapterFamily::DynamicLibrary,
                capability_tier: CapabilityTier::Tier0,
                supported_languages: vec![],
                extra: HashMap::new(),
            }
        }
        fn initialize(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn shutdown(&mut self) -> Result<(), String> {
            Ok(())
        }
        fn reload(&mut self, _req: &AdapterReloadRequest) -> AdapterReloadResult {
            AdapterReloadResult::Unsupported {
                reason: "noop".into(),
            }
        }
        fn snapshot_state(&self) -> Result<Vec<u8>, String> {
            Ok(vec![])
        }
        fn restore_state(&mut self, _data: &[u8]) -> Result<(), String> {
            Ok(())
        }
        fn healthcheck(&self) -> AdapterHealth {
            AdapterHealth::Unknown
        }
    }

    #[test]
    fn noop_adapter_trait_object() {
        let mut adapter: Box<dyn Adapter> = Box::new(NoopAdapter);
        assert_eq!(adapter.info().name, "noop");
        assert!(adapter.initialize().is_ok());
        assert_eq!(adapter.healthcheck(), AdapterHealth::Unknown);
    }

    #[test]
    fn gpu_device_sidecar_firewall_evidence_carries_boundary() {
        let evidence =
            ReloadFirewallEvidence::from_gpu_device_sidecar_boundary("unit-test", 100, 100);
        assert_eq!(evidence.cpu_hmr_used, Some(false));
        assert_eq!(evidence.full_rebuild_used, Some(false));
        assert_eq!(evidence.process_restarted, Some(false));
        assert_eq!(
            evidence.route.as_deref(),
            Some(ReloadFirewallEvidence::GPU_DEVICE_SIDECAR_ROUTE)
        );
        assert_eq!(evidence.evidence_source.as_deref(), Some("unit-test"));
        assert_eq!(evidence.process_id_before, Some(100));
        assert_eq!(evidence.process_id_after, Some(100));
        let receipt = evidence
            .verify_gpu_device_sidecar_boundary(100)
            .expect("verified process-local receipt");
        assert!(receipt
            .receipt_id()
            .starts_with("reload-firewall-receipt:sha256:"));
        assert_eq!(
            receipt.route(),
            ReloadFirewallEvidence::GPU_DEVICE_SIDECAR_ROUTE
        );
        assert!(!receipt.cpu_hmr_used());
        assert!(!receipt.full_rebuild_used());
        assert!(!receipt.process_restarted());
    }

    #[test]
    fn gpu_device_sidecar_firewall_evidence_marks_process_change() {
        let evidence =
            ReloadFirewallEvidence::from_gpu_device_sidecar_boundary("unit-test", 100, 101);
        assert_eq!(evidence.process_restarted, Some(true));
        assert_eq!(
            evidence.verify_gpu_device_sidecar_boundary(101),
            Err("reload_firewall_route_not_gpu_device_sidecar")
        );
    }

    #[test]
    fn serialized_reload_request_cannot_supply_firewall_authority() {
        let request = AdapterReloadRequest {
            reload_id: "reload-id".into(),
            source_edit_id: None,
            module_id: "module-id".into(),
            changed_files: vec!["source.ext".into()],
            build_manifest: BuildManifest::for_language("preview-id", "rust"),
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: ReloadFirewallEvidence::from_gpu_device_sidecar_boundary(
                "trusted-router",
                100,
                100,
            ),
            preserve_state: true,
            timeout_ms: 1_000,
        };
        let mut serialized = serde_json::to_value(&request).expect("serialize request");
        assert!(serialized.get("firewall_evidence").is_none());
        serialized.as_object_mut().unwrap().insert(
            "firewall_evidence".to_string(),
            json!({
                "cpu_hmr_used": false,
                "full_rebuild_used": false,
                "process_restarted": false,
                "route": ReloadFirewallEvidence::GPU_DEVICE_SIDECAR_ROUTE,
                "evidence_source": "forged-request",
                "process_id_before": 100,
                "process_id_after": 100,
            }),
        );
        serialized.as_object_mut().unwrap().insert(
            "firewallEvidence".to_string(),
            json!({
                "cpuHmrUsed": false,
                "fullRebuildUsed": false,
                "processRestarted": false,
                "route": ReloadFirewallEvidence::GPU_DEVICE_SIDECAR_ROUTE,
                "evidenceSource": "forged-request-alias",
                "processIdBefore": 100,
                "processIdAfter": 100,
            }),
        );
        let decoded: AdapterReloadRequest =
            serde_json::from_value(serialized).expect("deserialize request");
        assert_eq!(decoded.firewall_evidence, ReloadFirewallEvidence::default());
        assert!(decoded
            .firewall_evidence
            .verify_gpu_device_sidecar_boundary(100)
            .is_err());
    }

    #[test]
    fn public_reload_request_constructor_starts_without_firewall_authority() {
        let request = AdapterReloadRequest::new(
            "reload-id",
            "module-id",
            vec!["source.ext".into()],
            BuildManifest::for_language("preview-id", "rust"),
            true,
            1_000,
        );

        assert_eq!(request.firewall_evidence, ReloadFirewallEvidence::default());
        assert!(request
            .firewall_evidence
            .verify_gpu_device_sidecar_boundary(100)
            .is_err());

        let routed = request.into_gpu_device_sidecar_route();
        let receipt = routed
            .firewall_evidence
            .verify_gpu_device_sidecar_boundary(std::process::id())
            .expect("process-local route must mint a valid receipt");
        assert_eq!(
            receipt.evidence_source(),
            "adapter_reload_request:gpu_device_sidecar_route"
        );
    }

    #[test]
    fn reload_capsule_metadata_token_round_trips_non_empty_fields() {
        let proof_digest = "d".repeat(64);
        let contract = json!({
            "kind": "compute_readback",
            "outputTargetId": "buffer:result",
            "causalOutputChangeRequired": true,
        });
        let mut metadata =
            ReloadCapsuleMetadata {
                fission_island_id: Some(" fission-island:sha256:abc ".into()),
                fission_output_oracle_contract: Some(contract.clone()),
                output_oracle_profile_commitment: Some(ReloadOutputOracleProfileCommitment {
                    schema_version: RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION.into(),
                    candidate_artifact_sha256: format!("sha256:{}", "a".repeat(64)),
                    fission_output_oracle_contract_sha256:
                        reload_output_oracle_contract_content_hash(&contract).unwrap(),
                    profile_bytes_sha256: format!("sha256:{}", "c".repeat(64)),
                    edit_id: format!("source-edit:sha256:{}", "e".repeat(64)),
                }),
                abi_membrane_hash: Some("sha256:def".into()),
                dependency_closure_hash: Some("".into()),
                proof_hash: Some(format!("sha256:{proof_digest}")),
                ..Default::default()
            };
        assert!(bind_reload_output_oracle_proof_context(
            &mut metadata,
            &format!("gpu-proof:{proof_digest}"),
            "2026-07-16T12:00:00.000Z",
            "runtime-session:test",
        ));

        let token = encode_reload_capsule_metadata_token(&metadata).expect("capsule token");
        assert!(token.starts_with("capsulev1_"));
        assert!(!token.contains(':'));
        assert!(!token.contains(' '));

        let decoded =
            decode_reload_capsule_metadata_token(&token).expect("decoded capsule metadata");
        assert_eq!(
            decoded.fission_island_id.as_deref(),
            Some("fission-island:sha256:abc")
        );
        assert_eq!(decoded.abi_membrane_hash.as_deref(), Some("sha256:def"));
        assert_eq!(decoded.dependency_closure_hash, None);
        assert_eq!(
            decoded.proof_hash.as_deref(),
            Some(format!("sha256:{proof_digest}").as_str())
        );
        assert!(reload_output_oracle_proof_context_valid(
            &decoded,
            Some("runtime-session:test")
        ));
        assert!(!reload_output_oracle_proof_context_valid(
            &decoded,
            Some("runtime-session:replay")
        ));
        assert_eq!(
            decoded.output_oracle_profile_commitment,
            Some(ReloadOutputOracleProfileCommitment {
                schema_version: RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION.into(),
                candidate_artifact_sha256: format!("sha256:{}", "a".repeat(64)),
                fission_output_oracle_contract_sha256: reload_output_oracle_contract_content_hash(
                    &contract
                )
                .unwrap(),
                profile_bytes_sha256: format!("sha256:{}", "c".repeat(64)),
                edit_id: format!("source-edit:sha256:{}", "e".repeat(64)),
            })
        );
    }

    #[test]
    fn reload_capsule_metadata_rejects_incomplete_oracle_commitment_context() {
        let metadata = ReloadCapsuleMetadata {
            output_oracle_profile_commitment: Some(ReloadOutputOracleProfileCommitment {
                schema_version: " invalid-schema ".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(encode_reload_capsule_metadata_token(&metadata).is_none());
    }

    #[test]
    fn reload_capsule_proof_context_rejects_cross_session_and_field_splices() {
        let proof_digest = "d".repeat(64);
        let contract = json!({
            "kind": "compute_readback",
            "outputTargetId": "buffer:result",
            "causalOutputChangeRequired": true,
        });
        let mut metadata =
            ReloadCapsuleMetadata {
                fission_island_id: Some(format!("fission-island:sha256:{}", "1".repeat(64))),
                fission_verifier_evidence_id: Some(format!(
                    "fission-verifier:sha256:{}",
                    "2".repeat(64)
                )),
                fission_output_oracle_contract: Some(contract.clone()),
                output_oracle_profile_commitment: Some(ReloadOutputOracleProfileCommitment {
                    schema_version: RELOAD_OUTPUT_ORACLE_PROFILE_COMMITMENT_SCHEMA_VERSION.into(),
                    candidate_artifact_sha256: format!("sha256:{}", "a".repeat(64)),
                    fission_output_oracle_contract_sha256:
                        reload_output_oracle_contract_content_hash(&contract).unwrap(),
                    profile_bytes_sha256: format!("sha256:{}", "c".repeat(64)),
                    edit_id: format!("source-edit:sha256:{}", "e".repeat(64)),
                }),
                proof_hash: Some(format!("sha256:{proof_digest}")),
                ..Default::default()
            };
        assert!(bind_reload_output_oracle_proof_context(
            &mut metadata,
            &format!("gpu-proof:{proof_digest}"),
            "2026-07-16T12:00:00.000Z",
            "runtime-session:a",
        ));
        assert!(reload_output_oracle_proof_context_valid(
            &metadata,
            Some("runtime-session:a")
        ));
        assert!(!reload_output_oracle_proof_context_valid(
            &metadata,
            Some("runtime-session:b")
        ));

        let mut changed_context = metadata.clone();
        changed_context
            .output_oracle_proof_context
            .as_mut()
            .unwrap()
            .runtime_session_id = "runtime-session:b".to_string();
        assert!(!reload_output_oracle_proof_context_valid(
            &changed_context,
            Some("runtime-session:b")
        ));

        let mut changed_capsule = metadata.clone();
        changed_capsule.fission_verifier_evidence_id =
            Some(format!("fission-verifier:sha256:{}", "3".repeat(64)));
        assert!(!reload_output_oracle_proof_context_valid(
            &changed_capsule,
            Some("runtime-session:a")
        ));

        let mut changed_contract_commitment = metadata;
        changed_contract_commitment
            .output_oracle_profile_commitment
            .as_mut()
            .unwrap()
            .fission_output_oracle_contract_sha256 = format!("sha256:{}", "f".repeat(64));
        assert!(!reload_output_oracle_proof_context_valid(
            &changed_contract_commitment,
            Some("runtime-session:a")
        ));
    }

    #[test]
    fn reload_capsule_metadata_decodes_legacy_payload_without_oracle_commitment() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"fission_island_id":"legacy-island"}"#);
        let token = format!("{RELOAD_CAPSULE_METADATA_TOKEN_PREFIX}{payload}");

        let decoded =
            decode_reload_capsule_metadata_token(&token).expect("legacy capsule metadata");
        assert_eq!(decoded.fission_island_id.as_deref(), Some("legacy-island"));
        assert!(decoded.output_oracle_profile_commitment.is_none());
    }

    #[test]
    fn reload_request_source_edit_identity_is_distinct_and_legacy_optional() {
        let manifest = BuildManifest::new(
            "preview",
            "rust",
            "dynamic_library",
            0,
            crate::hmr::build_manifest::BuildSlot::Core,
            "artifact.so",
            "sha256:artifact",
        );
        let request = AdapterReloadRequest {
            reload_id: "reload-correlation-7".into(),
            source_edit_id: Some("source-edit:proof-bound".into()),
            module_id: "core".into(),
            changed_files: vec![],
            build_manifest: manifest,
            artifact_blob: None,
            capsule_metadata: None,
            firewall_evidence: Default::default(),
            preserve_state: false,
            timeout_ms: 1000,
        };
        let mut value = serde_json::to_value(&request).expect("serialized reload request");
        assert_eq!(value["reload_id"], "reload-correlation-7");
        assert_eq!(value["source_edit_id"], "source-edit:proof-bound");

        value.as_object_mut().unwrap().remove("source_edit_id");
        let legacy: AdapterReloadRequest =
            serde_json::from_value(value).expect("legacy reload request");
        assert_eq!(legacy.reload_id, "reload-correlation-7");
        assert_eq!(legacy.source_edit_id, None);
    }

    #[test]
    fn independent_source_edit_identity_requires_canonical_sha256_shape() {
        let canonical = format!("source-edit:sha256:{}", "a1".repeat(32));
        assert_eq!(
            normalized_reload_source_edit_id(Some(&canonical)).as_deref(),
            Some(canonical.as_str())
        );

        let invalid = vec![
            String::new(),
            "source-edit:sha256:".to_string(),
            format!("source-edit:sha256:{}", "a".repeat(63)),
            format!("source-edit:sha256:{}", "a".repeat(65)),
            format!("source-edit:sha256:{}", "A".repeat(64)),
            format!(" source-edit:sha256:{}", "a".repeat(64)),
            format!("source-edit:sha256:{} ", "a".repeat(64)),
            format!("source-edit:sha256:{}g", "a".repeat(63)),
        ];
        for invalid in invalid {
            assert_eq!(normalized_reload_source_edit_id(Some(&invalid)), None);
        }
        assert_eq!(normalized_reload_source_edit_id(None), None);
    }

    #[test]
    fn reload_capsule_metadata_token_omits_empty_metadata() {
        assert!(encode_reload_capsule_metadata_token(&ReloadCapsuleMetadata::default()).is_none());
        assert!(decode_reload_capsule_metadata_token("not-a-capsule-token").is_none());
    }
}
