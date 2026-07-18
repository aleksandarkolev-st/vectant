use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

pub const RUNNER_PROTOCOL_ACK_SCHEMA_VERSION: &str = "synthi.runner.protocol_ack.v3";
pub const GPU_RELOAD_V4_SCHEMA_VERSION: &str = "synthi.runner.gpu_reload.v4";
pub const GPU_RELOAD_V4_RESULT_SCHEMA_VERSION: &str = "synthi.runner.gpu_reload_result.v4";
pub const GPU_RUNTIME_PROOF_MATERIAL_V1_SCHEMA_VERSION: &str =
    "synthi.runner.gpu_runtime_proof_material.v1";
pub const GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION: &str =
    "synthi.runner.gpu_artifact_load_result.v1";
pub const GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY: &str =
    "gpu_reload.independent_edit_identity.v1";
pub const GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY: &str = "gpu_reload.artifact_content_hash.v1";
pub const GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY: &str =
    "gpu_load.correlated_terminal.v1";
pub const GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY: &str =
    "gpu_reload.challenge_bound_envelope.v1";
pub const GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY: &str = "gpu_reload.bound_proof_material.v1";
pub const RUNNER_PROTOCOL_ACK_PREFIX: &str = "[synthi-runner-protocol-ack] ";
pub const RUNNER_RUNTIME_CONTROL_ACK_SCHEMA_VERSION: &str = "synthi.runner.runtime_control_ack.v1";
pub const RUNNER_RUNTIME_CONTROL_ACK_PREFIX: &str = "[synthi-runner-runtime-control-ack] ";
pub const RUNNER_RUNTIME_CONTROL_SESSION_ENV: &str = "SYNTHI_RUNNER_RUNTIME_CONTROL_SESSION_ID";
pub const RUNNER_PROTOCOL_CURRENT_VERSION: u32 = 5;
pub const RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerProtocolAck {
    pub schema_version: String,
    pub nonce: String,
    pub current_version: u32,
    pub min_supported_version: u32,
    pub runner_pid: u32,
    pub runner_runtime_session_id: String,
    pub runner_challenge: String,
    pub capabilities: Vec<String>,
}

impl RunnerProtocolAck {
    pub fn current(
        nonce: impl Into<String>,
        runner_runtime_session_id: impl Into<String>,
        runner_challenge: impl Into<String>,
    ) -> Self {
        Self {
            schema_version: RUNNER_PROTOCOL_ACK_SCHEMA_VERSION.to_string(),
            nonce: nonce.into(),
            current_version: RUNNER_PROTOCOL_CURRENT_VERSION,
            min_supported_version: RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION,
            runner_pid: std::process::id(),
            runner_runtime_session_id: runner_runtime_session_id.into(),
            runner_challenge: runner_challenge.into(),
            capabilities: vec![
                GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY.to_string(),
                GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY.to_string(),
                GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY.to_string(),
                GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY.to_string(),
                GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY.to_string(),
            ],
        }
    }

    pub fn line(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self).map(|json| format!("{RUNNER_PROTOCOL_ACK_PREFIX}{json}"))
    }

    pub fn supports_strict_gpu_reload(&self, nonce: &str, expected_pid: u32) -> bool {
        self.schema_version == RUNNER_PROTOCOL_ACK_SCHEMA_VERSION
            && self.nonce == nonce
            && self.current_version >= RUNNER_PROTOCOL_CURRENT_VERSION
            && self.min_supported_version <= RUNNER_PROTOCOL_CURRENT_VERSION
            && self.runner_pid == expected_pid
            && valid_protocol_token(&self.runner_runtime_session_id)
            && canonical_runner_challenge(&self.runner_challenge)
            && self
                .capabilities
                .iter()
                .any(|capability| capability == GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY)
            && self
                .capabilities
                .iter()
                .any(|capability| capability == GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY)
            && self
                .capabilities
                .iter()
                .any(|capability| capability == GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY)
            && self
                .capabilities
                .iter()
                .any(|capability| capability == GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY)
            && self
                .capabilities
                .iter()
                .any(|capability| capability == GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY)
    }
}

pub fn parse_runner_protocol_ack(line: &str) -> Option<RunnerProtocolAck> {
    let json = line.strip_prefix(RUNNER_PROTOCOL_ACK_PREFIX)?;
    serde_json::from_str(json).ok()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunnerRuntimeControlStatus {
    #[serde(rename = "runtime-paused")]
    Paused,
    #[serde(rename = "runtime-resumed")]
    Resumed,
}

impl RunnerRuntimeControlStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paused => "runtime-paused",
            Self::Resumed => "runtime-resumed",
        }
    }

    fn expected_paused(self) -> bool {
        matches!(self, Self::Paused)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerRuntimeControlAck {
    pub schema_version: String,
    pub status: RunnerRuntimeControlStatus,
    pub runtime_control_token: String,
    pub runtime_paused: bool,
    pub gpu_reload_inflight_count: u64,
    pub runner_pid: u32,
    pub runner_control_session_id: String,
}

impl RunnerRuntimeControlAck {
    pub fn current(
        status: RunnerRuntimeControlStatus,
        runtime_control_token: impl Into<String>,
        runtime_paused: bool,
        gpu_reload_inflight_count: usize,
        runner_control_session_id: impl Into<String>,
    ) -> Result<Self, String> {
        let ack = Self {
            schema_version: RUNNER_RUNTIME_CONTROL_ACK_SCHEMA_VERSION.to_string(),
            status,
            runtime_control_token: runtime_control_token.into(),
            runtime_paused,
            gpu_reload_inflight_count: u64::try_from(gpu_reload_inflight_count)
                .map_err(|_| "runner runtime-control inflight count exceeds u64".to_string())?,
            runner_pid: std::process::id(),
            runner_control_session_id: runner_control_session_id.into(),
        };
        ack.validate()?;
        Ok(ack)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != RUNNER_RUNTIME_CONTROL_ACK_SCHEMA_VERSION {
            return Err("runner runtime-control ACK schema mismatch".to_string());
        }
        if !canonical_runner_runtime_control_token(&self.runtime_control_token) {
            return Err("runner runtime-control ACK token is invalid".to_string());
        }
        if self.runtime_paused != self.status.expected_paused() {
            return Err("runner runtime-control ACK state contradicts status".to_string());
        }
        if self.runner_pid == 0 {
            return Err("runner runtime-control ACK process identity is invalid".to_string());
        }
        if !canonical_runner_runtime_control_session_id(&self.runner_control_session_id) {
            return Err("runner runtime-control ACK control session is invalid".to_string());
        }
        Ok(())
    }

    pub fn line(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map(|json| format!("{RUNNER_RUNTIME_CONTROL_ACK_PREFIX}{json}"))
            .map_err(|error| format!("serializing runner runtime-control ACK: {error}"))
    }

    pub fn matches_expected(
        &self,
        status: RunnerRuntimeControlStatus,
        token: &str,
        runner_pid: u32,
        runner_control_session_id: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.status == status
            && self.runtime_control_token == token
            && self.runner_pid == runner_pid
            && self.runner_control_session_id == runner_control_session_id
    }
}

pub fn parse_runner_runtime_control_ack(line: &str) -> Option<RunnerRuntimeControlAck> {
    let json = line.strip_prefix(RUNNER_RUNTIME_CONTROL_ACK_PREFIX)?;
    let ack: RunnerRuntimeControlAck = serde_json::from_str(json).ok()?;
    ack.validate().ok()?;
    Some(ack)
}

pub fn canonical_runner_runtime_control_token(value: &str) -> bool {
    let Some(random_hex) = value.strip_prefix("runner-control:") else {
        return false;
    };
    random_hex.len() == 32
        && random_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn canonical_runner_runtime_control_session_id(value: &str) -> bool {
    let Some(random_hex) = value.strip_prefix("runner-control-session:") else {
        return false;
    };
    random_hex.len() == 32
        && random_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuReloadV4Payload {
    pub schema_version: String,
    pub request_id: String,
    pub operation: String,
    pub mode: String,
    pub vendor: String,
    pub artifact_path: String,
    pub artifact_content_hash: String,
    pub kernels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abi_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capsule_token: Option<String>,
    pub source_edit_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub proof_runtime_session_id: Option<String>,
    pub runner_runtime_session_id: String,
    pub runner_challenge: String,
    pub envelope_sha256: String,
}

impl GpuReloadV4Payload {
    pub fn new(
        request_id: String,
        operation: &str,
        mode: &str,
        vendor: &str,
        artifact_path: &str,
        artifact_content_hash: String,
        kernels: Vec<String>,
        abi_fingerprint: Option<String>,
        capsule_token: Option<String>,
        source_edit_id: String,
        proof_runtime_session_id: Option<String>,
        runner_runtime_session_id: String,
        runner_challenge: String,
    ) -> Result<Self, String> {
        let mut payload = Self {
            schema_version: GPU_RELOAD_V4_SCHEMA_VERSION.to_string(),
            request_id,
            operation: operation.to_string(),
            mode: mode.to_string(),
            vendor: vendor.to_string(),
            artifact_path: artifact_path.to_string(),
            artifact_content_hash,
            kernels,
            abi_fingerprint,
            capsule_token,
            source_edit_id,
            proof_runtime_session_id,
            runner_runtime_session_id,
            runner_challenge,
            envelope_sha256: String::new(),
        };
        payload.envelope_sha256 = payload.expected_envelope_sha256();
        payload.validate()?;
        Ok(payload)
    }

    fn expected_envelope_sha256(&self) -> String {
        let material = json!({
            "schemaVersion": self.schema_version,
            "requestId": self.request_id,
            "operation": self.operation,
            "mode": self.mode,
            "vendor": self.vendor,
            "artifactPath": self.artifact_path,
            "artifactContentHash": self.artifact_content_hash,
            "kernels": self.kernels,
            "abiFingerprint": self.abi_fingerprint,
            "capsuleToken": self.capsule_token,
            "sourceEditId": self.source_edit_id,
            "proofRuntimeSessionId": self.proof_runtime_session_id,
            "runnerRuntimeSessionId": self.runner_runtime_session_id,
            "runnerChallenge": self.runner_challenge,
        });
        let bytes = serde_json::to_vec(&material).unwrap_or_default();
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != GPU_RELOAD_V4_SCHEMA_VERSION {
            return Err("GPU reload V4 schema mismatch".to_string());
        }
        if !matches!(self.operation.as_str(), "cold_load" | "hot_reload") {
            return Err("GPU reload V4 operation is invalid".to_string());
        }
        if !matches!(self.mode.as_str(), "full" | "partial") {
            return Err("GPU reload V4 mode is invalid".to_string());
        }
        if self.operation == "cold_load" && self.mode != "full" {
            return Err("GPU reload V4 cold load cannot publish a partial artifact".to_string());
        }
        if !matches!(self.vendor.as_str(), "cuda" | "rocm") {
            return Err("GPU reload V4 vendor is invalid".to_string());
        }
        if self.artifact_path.is_empty() || self.artifact_path.chars().any(char::is_control) {
            return Err("GPU reload V4 artifact path is invalid".to_string());
        }
        if !canonical_sha256_content_hash(&self.artifact_content_hash) {
            return Err("GPU reload V4 artifact content hash is invalid".to_string());
        }
        if self
            .kernels
            .iter()
            .any(|kernel| kernel.is_empty() || kernel.chars().any(char::is_control))
        {
            return Err("GPU reload V4 kernel list is invalid".to_string());
        }
        for value in [
            self.abi_fingerprint.as_deref(),
            self.capsule_token.as_deref(),
            self.proof_runtime_session_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty()
                || value.chars().any(char::is_whitespace)
                || value.chars().any(char::is_control)
            {
                return Err("GPU reload V4 optional token is invalid".to_string());
            }
        }
        if !canonical_gpu_reload_request_id(&self.request_id) {
            return Err("GPU reload V4 request identity is invalid".to_string());
        }
        if !canonical_source_edit_id(&self.source_edit_id) {
            return Err("GPU reload V4 source edit identity is invalid".to_string());
        }
        if self.capsule_token.is_some() != self.proof_runtime_session_id.is_some() {
            return Err(
                "GPU reload V4 proof capsule/runtime session binding is incomplete".to_string(),
            );
        }
        if self.operation == "hot_reload" && self.capsule_token.is_none() {
            return Err("GPU reload V4 hot reload requires a proof capsule".to_string());
        }
        if !valid_protocol_token(&self.runner_runtime_session_id) {
            return Err("GPU reload V4 runner runtime session is invalid".to_string());
        }
        if !canonical_runner_challenge(&self.runner_challenge) {
            return Err("GPU reload V4 runner challenge is invalid".to_string());
        }
        if !canonical_sha256_content_hash(&self.envelope_sha256)
            || self.envelope_sha256 != self.expected_envelope_sha256()
        {
            return Err("GPU reload V4 envelope content binding is invalid".to_string());
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_vec(self)
            .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
            .map_err(|error| format!("serializing GPU reload V4 payload: {error}"))
    }

    pub fn decode(encoded: &str) -> Result<Self, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|error| format!("decoding GPU reload V4 payload: {error}"))?;
        let payload: Self = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parsing GPU reload V4 payload: {error}"))?;
        payload.validate()?;
        Ok(payload)
    }
}

fn valid_protocol_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && !value.chars().any(char::is_whitespace)
        && !value.chars().any(char::is_control)
}

fn canonical_runner_challenge(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub fn canonical_sha256_content_hash(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuReloadV2Expectation {
    pub request_id: String,
    pub source_edit_id: String,
    pub artifact_content_hash: String,
}

impl GpuReloadV2Expectation {
    pub fn new(
        request_id: String,
        source_edit_id: String,
        artifact_content_hash: String,
    ) -> Result<Self, String> {
        if !canonical_gpu_reload_request_id(&request_id) {
            return Err("GPU reload expectation request identity is invalid".to_string());
        }
        if !canonical_source_edit_id(&source_edit_id) {
            return Err("GPU reload expectation source edit identity is invalid".to_string());
        }
        if !canonical_sha256_content_hash(&artifact_content_hash) {
            return Err("GPU reload expectation artifact content hash is invalid".to_string());
        }
        Ok(Self {
            request_id,
            source_edit_id,
            artifact_content_hash,
        })
    }
}

pub fn canonical_gpu_reload_request_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("gpu-reload:request:") else {
        return false;
    };
    digest.len() == 32
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn canonical_source_edit_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("source-edit:sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

const GPU_RUNTIME_PROOF_MATERIAL_MAX_BYTES: usize = 16 * 1024 * 1024;
const GPU_RUNTIME_PROOF_MATERIAL_MAX_ENCODED_BYTES: usize =
    (GPU_RUNTIME_PROOF_MATERIAL_MAX_BYTES * 4 + 2) / 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuRuntimeProofMaterialV1 {
    pub schema_version: String,
    pub proof_json_base64: String,
    pub proof_json_sha256: String,
    pub proof_byte_length: u64,
    pub command_envelope_sha256: String,
    pub runner_pid: u32,
    pub runner_runtime_session_id: String,
    pub runner_challenge: String,
    pub terminal_binding_sha256: String,
}

impl GpuRuntimeProofMaterialV1 {
    pub fn new(
        proof: &serde_json::Value,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        full_runtime_proof_id: &str,
        command_envelope_sha256: impl Into<String>,
        runner_pid: u32,
        runner_runtime_session_id: impl Into<String>,
        runner_challenge: impl Into<String>,
    ) -> Result<Self, String> {
        let proof_bytes = serde_json::to_vec(proof)
            .map_err(|error| format!("serializing protected GPU runtime proof: {error}"))?;
        if proof_bytes.len() > GPU_RUNTIME_PROOF_MATERIAL_MAX_BYTES {
            return Err("protected GPU runtime proof exceeds the protocol byte limit".to_string());
        }
        let mut material = Self {
            schema_version: GPU_RUNTIME_PROOF_MATERIAL_V1_SCHEMA_VERSION.to_string(),
            proof_json_base64: URL_SAFE_NO_PAD.encode(&proof_bytes),
            proof_json_sha256: format!("sha256:{:x}", Sha256::digest(&proof_bytes)),
            proof_byte_length: proof_bytes.len() as u64,
            command_envelope_sha256: command_envelope_sha256.into(),
            runner_pid,
            runner_runtime_session_id: runner_runtime_session_id.into(),
            runner_challenge: runner_challenge.into(),
            terminal_binding_sha256: String::new(),
        };
        material.terminal_binding_sha256 = material.expected_terminal_binding_sha256(
            request_id,
            source_edit_id,
            artifact_content_hash,
            full_runtime_proof_id,
            &material.command_envelope_sha256,
        );
        material.validate_for(
            request_id,
            source_edit_id,
            artifact_content_hash,
            full_runtime_proof_id,
            &material.command_envelope_sha256,
        )?;
        Ok(material)
    }

    fn expected_terminal_binding_sha256(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        full_runtime_proof_id: &str,
        command_envelope_sha256: &str,
    ) -> String {
        let material = json!({
            "schemaVersion": self.schema_version,
            "requestId": request_id,
            "sourceEditId": source_edit_id,
            "artifactContentHash": artifact_content_hash,
            "fullRuntimeProofId": full_runtime_proof_id,
            "commandEnvelopeSha256": command_envelope_sha256,
            "proofJsonSha256": self.proof_json_sha256,
            "proofByteLength": self.proof_byte_length,
            "runnerPid": self.runner_pid,
            "runnerRuntimeSessionId": self.runner_runtime_session_id,
            "runnerChallenge": self.runner_challenge,
        });
        let bytes = serde_json::to_vec(&material).unwrap_or_default();
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    pub fn validate_for(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        full_runtime_proof_id: &str,
        command_envelope_sha256: &str,
    ) -> Result<(), String> {
        if self.schema_version != GPU_RUNTIME_PROOF_MATERIAL_V1_SCHEMA_VERSION {
            return Err("GPU runtime proof material schema mismatch".to_string());
        }
        if !canonical_gpu_reload_request_id(request_id)
            || !canonical_source_edit_id(source_edit_id)
            || !canonical_sha256_content_hash(artifact_content_hash)
            || !canonical_runtime_proof_id(full_runtime_proof_id)
            || !canonical_sha256_content_hash(command_envelope_sha256)
            || self.command_envelope_sha256 != command_envelope_sha256
        {
            return Err("GPU runtime proof material terminal identity is invalid".to_string());
        }
        if self.runner_pid == 0
            || !valid_protocol_token(&self.runner_runtime_session_id)
            || !canonical_runner_challenge(&self.runner_challenge)
        {
            return Err("GPU runtime proof material runner identity is invalid".to_string());
        }
        if self.proof_json_base64.len() > GPU_RUNTIME_PROOF_MATERIAL_MAX_ENCODED_BYTES {
            return Err(
                "protected GPU runtime proof exceeds the protocol encoded-byte limit".to_string(),
            );
        }
        let proof_bytes = URL_SAFE_NO_PAD
            .decode(self.proof_json_base64.as_bytes())
            .map_err(|error| format!("decoding protected GPU runtime proof: {error}"))?;
        if proof_bytes.len() > GPU_RUNTIME_PROOF_MATERIAL_MAX_BYTES
            || self.proof_byte_length != proof_bytes.len() as u64
            || self.proof_json_sha256 != format!("sha256:{:x}", Sha256::digest(&proof_bytes))
        {
            return Err("GPU runtime proof material byte identity mismatch".to_string());
        }
        let proof: serde_json::Value = serde_json::from_slice(&proof_bytes)
            .map_err(|error| format!("parsing protected GPU runtime proof: {error}"))?;
        if proof.get("proofId").and_then(serde_json::Value::as_str) != Some(full_runtime_proof_id) {
            return Err("GPU runtime proof material proof identity mismatch".to_string());
        }
        if !canonical_sha256_content_hash(&self.terminal_binding_sha256)
            || self.terminal_binding_sha256
                != self.expected_terminal_binding_sha256(
                    request_id,
                    source_edit_id,
                    artifact_content_hash,
                    full_runtime_proof_id,
                    command_envelope_sha256,
                )
        {
            return Err("GPU runtime proof material terminal binding mismatch".to_string());
        }
        Ok(())
    }

    pub fn decode_for(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
        full_runtime_proof_id: &str,
        command_envelope_sha256: &str,
    ) -> Result<serde_json::Value, String> {
        self.validate_for(
            request_id,
            source_edit_id,
            artifact_content_hash,
            full_runtime_proof_id,
            command_envelope_sha256,
        )?;
        let proof_bytes = URL_SAFE_NO_PAD
            .decode(self.proof_json_base64.as_bytes())
            .map_err(|error| format!("decoding protected GPU runtime proof: {error}"))?;
        serde_json::from_slice(&proof_bytes)
            .map_err(|error| format!("parsing protected GPU runtime proof: {error}"))
    }

    pub fn matches_runner_context(
        &self,
        runner_pid: u32,
        runner_runtime_session_id: &str,
        runner_challenge: &str,
    ) -> bool {
        self.runner_pid == runner_pid
            && self.runner_runtime_session_id == runner_runtime_session_id
            && self.runner_challenge == runner_challenge
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuReloadV2Result {
    pub schema_version: String,
    pub status: String,
    pub module: String,
    pub request_id: String,
    pub source_edit_id: String,
    pub artifact_content_hash: String,
    pub full_runtime_proof_accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_runtime_proof_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub runtime_proof_material: Option<GpuRuntimeProofMaterialV1>,
    pub gpu_hmr_success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl GpuReloadV2Result {
    pub fn applied(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        full_runtime_proof_id: impl Into<String>,
        runtime_proof_material: GpuRuntimeProofMaterialV1,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_RELOAD_V4_RESULT_SCHEMA_VERSION.to_string(),
            status: "applied".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            artifact_content_hash: artifact_content_hash.into(),
            full_runtime_proof_accepted: true,
            full_runtime_proof_id: Some(full_runtime_proof_id.into()),
            runtime_proof_material: Some(runtime_proof_material),
            gpu_hmr_success: true,
            reason: None,
        };
        result.validate()?;
        Ok(result)
    }

    pub fn rejected(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        reason: impl Into<String>,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_RELOAD_V4_RESULT_SCHEMA_VERSION.to_string(),
            status: "rejected".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            artifact_content_hash: artifact_content_hash.into(),
            full_runtime_proof_accepted: false,
            full_runtime_proof_id: None,
            runtime_proof_material: None,
            gpu_hmr_success: false,
            reason: Some(reason.into()),
        };
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != GPU_RELOAD_V4_RESULT_SCHEMA_VERSION {
            return Err("GPU reload V4 result schema mismatch".to_string());
        }
        if self.module != "device"
            || !canonical_gpu_reload_request_id(&self.request_id)
            || !canonical_source_edit_id(&self.source_edit_id)
            || !canonical_sha256_content_hash(&self.artifact_content_hash)
        {
            return Err("GPU reload V4 terminal identity mismatch".to_string());
        }
        match self.status.as_str() {
            "applied"
                if self.full_runtime_proof_accepted
                    && self.gpu_hmr_success
                    && self.reason.is_none()
                    && self
                        .full_runtime_proof_id
                        .as_deref()
                        .is_some_and(canonical_runtime_proof_id) =>
            {
                let material = self
                    .runtime_proof_material
                    .as_ref()
                    .ok_or_else(|| "GPU reload V4 terminal omitted proof material".to_string())?;
                material.validate_for(
                    &self.request_id,
                    &self.source_edit_id,
                    &self.artifact_content_hash,
                    self.full_runtime_proof_id
                        .as_deref()
                        .expect("validated applied proof ID"),
                    &material.command_envelope_sha256,
                )
            }
            "rejected"
                if !self.full_runtime_proof_accepted
                    && !self.gpu_hmr_success
                    && self.full_runtime_proof_id.is_none()
                    && self.runtime_proof_material.is_none()
                    && self.reason.as_deref().is_some_and(nonempty_safe_text) =>
            {
                Ok(())
            }
            "applied" | "rejected" => {
                Err("GPU reload V4 terminal proof fields are inconsistent".to_string())
            }
            _ => Err("GPU reload V4 terminal status is invalid".to_string()),
        }
    }

    pub fn matches(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.request_id == request_id
            && self.source_edit_id == source_edit_id
            && self.artifact_content_hash == artifact_content_hash
    }

    pub fn matches_expectation(&self, expectation: &GpuReloadV2Expectation) -> bool {
        self.matches(
            &expectation.request_id,
            &expectation.source_edit_id,
            &expectation.artifact_content_hash,
        )
    }

    pub fn to_json(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|error| format!("serializing GPU reload V2 result: {error}"))
    }

    pub fn from_json(value: &str) -> Result<Self, String> {
        let result: Self = serde_json::from_str(value)
            .map_err(|error| format!("parsing GPU reload V2 result: {error}"))?;
        result.validate()?;
        Ok(result)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuArtifactLoadV1Result {
    pub schema_version: String,
    pub status: String,
    pub module: String,
    pub request_id: String,
    pub source_edit_id: String,
    pub artifact_content_hash: String,
    pub accepted_for_gpu_hmr: bool,
    pub gpu_hmr_success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl GpuArtifactLoadV1Result {
    pub fn loaded(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION.to_string(),
            status: "loaded".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            artifact_content_hash: artifact_content_hash.into(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            reason: None,
        };
        result.validate()?;
        Ok(result)
    }

    pub fn rejected(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        artifact_content_hash: impl Into<String>,
        reason: impl Into<String>,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION.to_string(),
            status: "rejected".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            artifact_content_hash: artifact_content_hash.into(),
            accepted_for_gpu_hmr: false,
            gpu_hmr_success: false,
            reason: Some(reason.into()),
        };
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != GPU_ARTIFACT_LOAD_V1_RESULT_SCHEMA_VERSION {
            return Err("GPU artifact load V1 result schema mismatch".to_string());
        }
        if self.module != "device"
            || !canonical_gpu_reload_request_id(&self.request_id)
            || !canonical_source_edit_id(&self.source_edit_id)
            || !canonical_sha256_content_hash(&self.artifact_content_hash)
            || self.accepted_for_gpu_hmr
            || self.gpu_hmr_success
        {
            return Err("GPU artifact load V1 result identity or authority mismatch".to_string());
        }
        match self.status.as_str() {
            "loaded" if self.reason.is_none() => Ok(()),
            "rejected" if self.reason.as_deref().is_some_and(nonempty_safe_text) => Ok(()),
            "loaded" | "rejected" => {
                Err("GPU artifact load V1 result fields are inconsistent".to_string())
            }
            _ => Err("GPU artifact load V1 result status is invalid".to_string()),
        }
    }

    pub fn matches(
        &self,
        request_id: &str,
        source_edit_id: &str,
        artifact_content_hash: &str,
    ) -> bool {
        self.validate().is_ok()
            && self.request_id == request_id
            && self.source_edit_id == source_edit_id
            && self.artifact_content_hash == artifact_content_hash
    }

    pub fn to_json(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_string(self)
            .map_err(|error| format!("serializing GPU artifact load V1 result: {error}"))
    }

    pub fn from_json(value: &str) -> Result<Self, String> {
        let result: Self = serde_json::from_str(value)
            .map_err(|error| format!("parsing GPU artifact load V1 result: {error}"))?;
        result.validate()?;
        Ok(result)
    }
}

fn canonical_runtime_proof_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("gpu-runtime-proof:sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn nonempty_safe_text(value: &str) -> bool {
    !value.trim().is_empty() && !value.chars().any(char::is_control)
}

pub fn decode_runner_command_token(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_nibble(*bytes.get(index + 1)?)?;
            let low = hex_nibble(*bytes.get(index + 2)?)?;
            out.push((high << 4) | low);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source_edit_id() -> String {
        format!("source-edit:sha256:{}", "a".repeat(64))
    }

    fn fixture_request_id(value: char) -> String {
        format!("gpu-reload:request:{}", value.to_string().repeat(32))
    }

    fn runner_runtime_session_id() -> String {
        "pid123-456".to_string()
    }

    fn runner_challenge() -> String {
        "1".repeat(32)
    }

    fn runtime_control_token() -> String {
        format!("runner-control:{}", "c".repeat(32))
    }

    fn runner_control_session_id() -> String {
        format!("runner-control-session:{}", "e".repeat(32))
    }

    fn proof_material(
        request_id: &str,
        source_edit_id: &str,
        artifact_hash: &str,
        proof_id: &str,
    ) -> GpuRuntimeProofMaterialV1 {
        GpuRuntimeProofMaterialV1::new(
            &json!({"proofId": proof_id, "evidence": "runtime-proof-bytes"}),
            request_id,
            source_edit_id,
            artifact_hash,
            proof_id,
            format!("sha256:{}", "e".repeat(64)),
            std::process::id(),
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap()
    }

    #[test]
    fn gpu_reload_v4_round_trip_preserves_exact_typed_payload() {
        let payload = GpuReloadV4Payload::new(
            fixture_request_id('1'),
            "hot_reload",
            "partial",
            "rocm",
            "/tmp/path with space/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            vec!["gpu::shade".to_string()],
            Some("sha256:abi".to_string()),
            Some("capsulev1_payload".to_string()),
            source_edit_id(),
            Some("runtime-session:test".to_string()),
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap();
        let encoded = payload.encode().unwrap();
        assert!(!encoded.chars().any(char::is_whitespace));
        assert_eq!(GpuReloadV4Payload::decode(&encoded).unwrap(), payload);
    }

    #[test]
    fn gpu_reload_v4_rejects_noncanonical_or_conflicting_identity() {
        assert!(GpuReloadV4Payload::new(
            fixture_request_id('1'),
            "cold_load",
            "full",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            Vec::new(),
            None,
            None,
            "source-edit:sha256:short".to_string(),
            None,
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .is_err());

        let mut payload = GpuReloadV4Payload::new(
            fixture_request_id('2'),
            "cold_load",
            "full",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            Vec::new(),
            None,
            None,
            source_edit_id(),
            None,
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap();
        payload.request_id = format!("gpu-reload:request:{}", "z".repeat(32));
        assert!(payload.encode().is_err());
    }

    #[test]
    fn gpu_reload_v4_rejects_incomplete_capsule_session_pairs() {
        let base = GpuReloadV4Payload::new(
            fixture_request_id('3'),
            "hot_reload",
            "partial",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            Vec::new(),
            None,
            Some("capsulev1_payload".to_string()),
            source_edit_id(),
            Some("runtime-session:test".to_string()),
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap();

        let mut missing_session = base.clone();
        missing_session.proof_runtime_session_id = None;
        assert!(missing_session.encode().is_err());

        let mut missing_capsule = base;
        missing_capsule.capsule_token = None;
        assert!(missing_capsule.encode().is_err());
    }

    #[test]
    fn gpu_reload_v4_envelope_rejects_every_mutation_relevant_field_splice() {
        let payload = GpuReloadV4Payload::new(
            fixture_request_id('4'),
            "hot_reload",
            "partial",
            "rocm",
            "/tmp/device.hsaco",
            format!("sha256:{}", "b".repeat(64)),
            vec!["gpu::shade".to_string()],
            Some("sha256:abi".to_string()),
            Some("capsulev1_payload".to_string()),
            source_edit_id(),
            Some("runtime-session:test".to_string()),
            runner_runtime_session_id(),
            runner_challenge(),
        )
        .unwrap();

        let mut mutations = Vec::new();
        let mut value = payload.clone();
        value.schema_version = "synthi.runner.gpu_reload.invalid".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.request_id = fixture_request_id('5');
        mutations.push(value);
        let mut value = payload.clone();
        value.operation = "cold_load".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.mode = "full".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.vendor = "cuda".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.kernels = vec!["gpu::other".to_string()];
        mutations.push(value);
        let mut value = payload.clone();
        value.abi_fingerprint = Some("sha256:other".to_string());
        mutations.push(value);
        let mut value = payload.clone();
        value.capsule_token = Some("capsulev1_other".to_string());
        mutations.push(value);
        let mut value = payload.clone();
        value.proof_runtime_session_id = Some("runtime-session:other".to_string());
        mutations.push(value);
        let mut value = payload.clone();
        value.artifact_path = "/tmp/other.hsaco".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.artifact_content_hash = format!("sha256:{}", "c".repeat(64));
        mutations.push(value);
        let mut value = payload.clone();
        value.source_edit_id = format!("source-edit:sha256:{}", "d".repeat(64));
        mutations.push(value);
        let mut value = payload.clone();
        value.runner_runtime_session_id = "pid999-999".to_string();
        mutations.push(value);
        let mut value = payload.clone();
        value.runner_challenge = "2".repeat(32);
        mutations.push(value);
        let mut value = payload.clone();
        value.envelope_sha256 = format!("sha256:{}", "f".repeat(64));
        mutations.push(value);

        for mutation in mutations {
            assert!(mutation.encode().is_err());
        }
    }

    #[test]
    fn protocol_ack_is_bound_to_nonce_pid_version_and_capability() {
        let ack =
            RunnerProtocolAck::current("nonce-a", runner_runtime_session_id(), runner_challenge());
        let line = ack.line().unwrap();
        let parsed = parse_runner_protocol_ack(&line).unwrap();
        assert!(parsed.supports_strict_gpu_reload("nonce-a", std::process::id()));
        assert!(!parsed.supports_strict_gpu_reload("nonce-b", std::process::id()));
        assert!(!parsed.supports_strict_gpu_reload("nonce-a", std::process::id() + 1));

        for required in [
            GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY,
            GPU_RELOAD_ARTIFACT_CONTENT_HASH_CAPABILITY,
            GPU_ARTIFACT_LOAD_CORRELATED_TERMINAL_CAPABILITY,
            GPU_RELOAD_CHALLENGE_BOUND_ENVELOPE_CAPABILITY,
            GPU_RELOAD_BOUND_PROOF_MATERIAL_CAPABILITY,
        ] {
            let mut missing_capability = parsed.clone();
            missing_capability
                .capabilities
                .retain(|capability| capability != required);
            assert!(!missing_capability.supports_strict_gpu_reload("nonce-a", std::process::id()));
        }
    }

    #[test]
    fn runtime_control_ack_is_typed_and_bound_to_token_process_session_and_state() {
        let token = runtime_control_token();
        let ack = RunnerRuntimeControlAck::current(
            RunnerRuntimeControlStatus::Paused,
            &token,
            true,
            2,
            runner_control_session_id(),
        )
        .unwrap();
        let line = ack.line().unwrap();
        let parsed = parse_runner_runtime_control_ack(&line).unwrap();

        assert!(parsed.matches_expected(
            RunnerRuntimeControlStatus::Paused,
            &token,
            std::process::id(),
            &runner_control_session_id(),
        ));
        assert!(!parsed.matches_expected(
            RunnerRuntimeControlStatus::Resumed,
            &token,
            std::process::id(),
            &runner_control_session_id(),
        ));
        assert!(!parsed.matches_expected(
            RunnerRuntimeControlStatus::Paused,
            &format!("runner-control:{}", "d".repeat(32)),
            std::process::id(),
            &runner_control_session_id(),
        ));
        assert!(!parsed.matches_expected(
            RunnerRuntimeControlStatus::Paused,
            &token,
            std::process::id() + 1,
            &runner_control_session_id(),
        ));
        assert!(!parsed.matches_expected(
            RunnerRuntimeControlStatus::Paused,
            &token,
            std::process::id(),
            &format!("runner-control-session:{}", "f".repeat(32)),
        ));
    }

    #[test]
    fn runtime_control_ack_rejects_loose_or_malformed_protocol_shapes() {
        let token = runtime_control_token();
        let ack = RunnerRuntimeControlAck::current(
            RunnerRuntimeControlStatus::Paused,
            &token,
            true,
            0,
            runner_control_session_id(),
        )
        .unwrap();

        assert!(parse_runner_runtime_control_ack(&serde_json::to_string(&ack).unwrap()).is_none());
        assert!(parse_runner_runtime_control_ack(
            r#"[Runner] [HMR-STATUS] {"status":"runtime-paused","runtimeControlToken":"runner-control:cccccccccccccccccccccccccccccccc"}"#,
        )
        .is_none());

        let mut unknown_field = serde_json::to_value(&ack).unwrap();
        unknown_field["acceptedForGpuHmr"] = serde_json::Value::Bool(true);
        let unknown_line = format!(
            "{RUNNER_RUNTIME_CONTROL_ACK_PREFIX}{}",
            serde_json::to_string(&unknown_field).unwrap()
        );
        assert!(parse_runner_runtime_control_ack(&unknown_line).is_none());

        let mut invalid = ack.clone();
        invalid.runtime_control_token = "runner-control-1".to_string();
        assert!(invalid.line().is_err());
        let mut invalid = ack.clone();
        invalid.runtime_paused = false;
        assert!(invalid.line().is_err());
        let mut invalid = ack.clone();
        invalid.runner_pid = 0;
        assert!(invalid.line().is_err());
        let mut invalid = ack;
        invalid.runner_control_session_id = "contains whitespace".to_string();
        assert!(invalid.line().is_err());
    }

    #[test]
    fn runtime_control_token_requires_exact_128_bit_lowercase_hex_shape() {
        assert!(canonical_runner_runtime_control_token(
            &runtime_control_token()
        ));
        assert!(!canonical_runner_runtime_control_token(
            "runner-control:ccccccccccccccccccccccccccccccc"
        ));
        assert!(!canonical_runner_runtime_control_token(
            "runner-control:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
        ));
        assert!(!canonical_runner_runtime_control_token(
            "runner-control-cccccccccccccccccccccccccccccccc"
        ));
    }

    #[test]
    fn runtime_control_session_requires_exact_128_bit_lowercase_hex_shape() {
        assert!(canonical_runner_runtime_control_session_id(
            &runner_control_session_id()
        ));
        assert!(!canonical_runner_runtime_control_session_id(
            "runner-control-session:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        ));
        assert!(!canonical_runner_runtime_control_session_id(
            "runner-control-session:EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"
        ));
        assert!(!canonical_runner_runtime_control_session_id(
            "runner-runtime-session:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        ));
    }

    #[test]
    fn gpu_reload_v2_terminal_result_is_bound_to_request_source_and_runtime_proof() {
        let source_edit_id = source_edit_id();
        let request_id = fixture_request_id('3');
        let artifact_hash = format!("sha256:{}", "a".repeat(64));
        let proof_id = format!("gpu-runtime-proof:sha256:{}", "b".repeat(64));
        let material = proof_material(&request_id, &source_edit_id, &artifact_hash, &proof_id);
        let applied = GpuReloadV2Result::applied(
            &request_id,
            &source_edit_id,
            &artifact_hash,
            &proof_id,
            material,
        )
        .unwrap();
        let encoded = applied.to_json().unwrap();
        let decoded = GpuReloadV2Result::from_json(&encoded).unwrap();
        assert_eq!(decoded, applied);
        assert!(decoded.matches(&request_id, &source_edit_id, &artifact_hash));
        assert!(!decoded.matches(&fixture_request_id('4'), &source_edit_id, &artifact_hash));
        assert!(!decoded.matches(
            &request_id,
            &source_edit_id,
            &format!("sha256:{}", "c".repeat(64))
        ));

        let mut forged = decoded;
        forged.full_runtime_proof_accepted = false;
        assert!(forged.to_json().is_err());
        assert!(GpuReloadV2Result::applied(
            &request_id,
            &source_edit_id,
            &artifact_hash,
            "proof:declared",
            proof_material(&request_id, &source_edit_id, &artifact_hash, &proof_id),
        )
        .is_err());

        let rejected = GpuReloadV2Result::rejected(
            &request_id,
            &source_edit_id,
            &artifact_hash,
            "strict proof missing",
        )
        .unwrap();
        assert!(!rejected.gpu_hmr_success);
        assert!(rejected.full_runtime_proof_id.is_none());
        assert!(rejected.runtime_proof_material.is_none());
    }

    #[test]
    fn gpu_runtime_proof_material_rejects_byte_context_and_runner_splices() {
        let source_edit_id = source_edit_id();
        let request_id = fixture_request_id('6');
        let artifact_hash = format!("sha256:{}", "c".repeat(64));
        let proof_id = format!("gpu-runtime-proof:sha256:{}", "d".repeat(64));
        let material = proof_material(&request_id, &source_edit_id, &artifact_hash, &proof_id);
        assert_eq!(
            material
                .decode_for(
                    &request_id,
                    &source_edit_id,
                    &artifact_hash,
                    &proof_id,
                    &material.command_envelope_sha256,
                )
                .unwrap()["proofId"],
            proof_id
        );

        let mut mutations = Vec::new();
        let mut value = material.clone();
        value.proof_json_base64.push('A');
        mutations.push(value);
        let mut value = material.clone();
        value.proof_byte_length += 1;
        mutations.push(value);
        let mut value = material.clone();
        value.proof_json_sha256 = format!("sha256:{}", "e".repeat(64));
        mutations.push(value);
        let mut value = material.clone();
        value.command_envelope_sha256 = format!("sha256:{}", "f".repeat(64));
        mutations.push(value);
        let mut value = material.clone();
        value.runner_pid = 0;
        mutations.push(value);
        let mut value = material.clone();
        value.runner_runtime_session_id = "runtime session with spaces".to_string();
        mutations.push(value);
        let mut value = material.clone();
        value.runner_challenge = "f".repeat(32);
        mutations.push(value);
        let mut value = material.clone();
        value.terminal_binding_sha256 = format!("sha256:{}", "0".repeat(64));
        mutations.push(value);

        for mutation in mutations {
            assert!(mutation
                .validate_for(
                    &request_id,
                    &source_edit_id,
                    &artifact_hash,
                    &proof_id,
                    &material.command_envelope_sha256,
                )
                .is_err());
        }
        assert!(material
            .validate_for(
                &fixture_request_id('7'),
                &source_edit_id,
                &artifact_hash,
                &proof_id,
                &material.command_envelope_sha256,
            )
            .is_err());
        assert!(material
            .validate_for(
                &request_id,
                &source_edit_id,
                &format!("sha256:{}", "1".repeat(64)),
                &proof_id,
                &material.command_envelope_sha256,
            )
            .is_err());
        assert!(material
            .validate_for(
                &request_id,
                &source_edit_id,
                &artifact_hash,
                &proof_id,
                &format!("sha256:{}", "2".repeat(64)),
            )
            .is_err());

        let mut oversized = material;
        oversized.proof_json_base64 = "*".repeat(GPU_RUNTIME_PROOF_MATERIAL_MAX_ENCODED_BYTES + 1);
        assert_eq!(
            oversized
                .validate_for(
                    &request_id,
                    &source_edit_id,
                    &artifact_hash,
                    &proof_id,
                    &oversized.command_envelope_sha256,
                )
                .unwrap_err(),
            "protected GPU runtime proof exceeds the protocol encoded-byte limit"
        );
    }

    #[test]
    fn cold_gpu_artifact_load_terminal_is_correlated_but_never_claims_hmr() {
        let request_id = fixture_request_id('5');
        let source_edit_id = source_edit_id();
        let artifact_hash = format!("sha256:{}", "d".repeat(64));
        let loaded =
            GpuArtifactLoadV1Result::loaded(&request_id, &source_edit_id, &artifact_hash).unwrap();
        let decoded = GpuArtifactLoadV1Result::from_json(&loaded.to_json().unwrap()).unwrap();
        assert!(decoded.matches(&request_id, &source_edit_id, &artifact_hash));
        assert!(!decoded.accepted_for_gpu_hmr);
        assert!(!decoded.gpu_hmr_success);

        let rejected = GpuArtifactLoadV1Result::rejected(
            &request_id,
            &source_edit_id,
            &artifact_hash,
            "artifact bytes mismatched",
        )
        .unwrap();
        assert_eq!(rejected.status, "rejected");
        assert!(!rejected.gpu_hmr_success);
    }
}
