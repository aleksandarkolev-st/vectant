use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const RUNNER_PROTOCOL_ACK_SCHEMA_VERSION: &str = "synthi.runner.protocol_ack.v2";
pub const GPU_RELOAD_V2_SCHEMA_VERSION: &str = "synthi.runner.gpu_reload.v2";
pub const GPU_RELOAD_V2_RESULT_SCHEMA_VERSION: &str = "synthi.runner.gpu_reload_result.v2";
pub const GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY: &str =
    "gpu_reload.independent_edit_identity.v1";
pub const RUNNER_PROTOCOL_ACK_PREFIX: &str = "[synthi-runner-protocol-ack] ";
pub const RUNNER_PROTOCOL_CURRENT_VERSION: u32 = 2;
pub const RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerProtocolAck {
    pub schema_version: String,
    pub nonce: String,
    pub current_version: u32,
    pub min_supported_version: u32,
    pub runner_pid: u32,
    pub capabilities: Vec<String>,
}

impl RunnerProtocolAck {
    pub fn current(nonce: impl Into<String>) -> Self {
        Self {
            schema_version: RUNNER_PROTOCOL_ACK_SCHEMA_VERSION.to_string(),
            nonce: nonce.into(),
            current_version: RUNNER_PROTOCOL_CURRENT_VERSION,
            min_supported_version: RUNNER_PROTOCOL_MIN_SUPPORTED_VERSION,
            runner_pid: std::process::id(),
            capabilities: vec![GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY.to_string()],
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
            && self
                .capabilities
                .iter()
                .any(|capability| capability == GPU_RELOAD_INDEPENDENT_EDIT_IDENTITY_CAPABILITY)
    }
}

pub fn parse_runner_protocol_ack(line: &str) -> Option<RunnerProtocolAck> {
    let json = line.strip_prefix(RUNNER_PROTOCOL_ACK_PREFIX)?;
    serde_json::from_str(json).ok()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuReloadV2Payload {
    pub schema_version: String,
    pub request_id: String,
    pub mode: String,
    pub vendor: String,
    pub artifact_path: String,
    pub kernels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abi_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capsule_token: Option<String>,
    pub source_edit_id: String,
}

impl GpuReloadV2Payload {
    pub fn new(
        request_id: String,
        mode: &str,
        vendor: &str,
        artifact_path: &str,
        kernels: Vec<String>,
        abi_fingerprint: Option<String>,
        capsule_token: Option<String>,
        source_edit_id: String,
    ) -> Result<Self, String> {
        let payload = Self {
            schema_version: GPU_RELOAD_V2_SCHEMA_VERSION.to_string(),
            request_id,
            mode: mode.to_string(),
            vendor: vendor.to_string(),
            artifact_path: artifact_path.to_string(),
            kernels,
            abi_fingerprint,
            capsule_token,
            source_edit_id,
        };
        payload.validate()?;
        Ok(payload)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != GPU_RELOAD_V2_SCHEMA_VERSION {
            return Err("GPU reload V2 schema mismatch".to_string());
        }
        if !matches!(self.mode.as_str(), "full" | "partial") {
            return Err("GPU reload V2 mode is invalid".to_string());
        }
        if !matches!(self.vendor.as_str(), "cuda" | "rocm") {
            return Err("GPU reload V2 vendor is invalid".to_string());
        }
        if self.artifact_path.is_empty() || self.artifact_path.chars().any(char::is_control) {
            return Err("GPU reload V2 artifact path is invalid".to_string());
        }
        if self
            .kernels
            .iter()
            .any(|kernel| kernel.is_empty() || kernel.chars().any(char::is_control))
        {
            return Err("GPU reload V2 kernel list is invalid".to_string());
        }
        for value in [
            self.abi_fingerprint.as_deref(),
            self.capsule_token.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty()
                || value.chars().any(char::is_whitespace)
                || value.chars().any(char::is_control)
            {
                return Err("GPU reload V2 optional token is invalid".to_string());
            }
        }
        if !canonical_gpu_reload_request_id(&self.request_id) {
            return Err("GPU reload V2 request identity is invalid".to_string());
        }
        if !canonical_source_edit_id(&self.source_edit_id) {
            return Err("GPU reload V2 source edit identity is invalid".to_string());
        }
        Ok(())
    }

    pub fn encode(&self) -> Result<String, String> {
        self.validate()?;
        serde_json::to_vec(self)
            .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
            .map_err(|error| format!("serializing GPU reload V2 payload: {error}"))
    }

    pub fn decode(encoded: &str) -> Result<Self, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded.as_bytes())
            .map_err(|error| format!("decoding GPU reload V2 payload: {error}"))?;
        let payload: Self = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parsing GPU reload V2 payload: {error}"))?;
        payload.validate()?;
        Ok(payload)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuReloadV2Expectation {
    pub request_id: String,
    pub source_edit_id: String,
}

impl GpuReloadV2Expectation {
    pub fn new(request_id: String, source_edit_id: String) -> Result<Self, String> {
        if !canonical_gpu_reload_request_id(&request_id) {
            return Err("GPU reload V2 expectation request identity is invalid".to_string());
        }
        if !canonical_source_edit_id(&source_edit_id) {
            return Err("GPU reload V2 expectation source edit identity is invalid".to_string());
        }
        Ok(Self {
            request_id,
            source_edit_id,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GpuReloadV2Result {
    pub schema_version: String,
    pub status: String,
    pub module: String,
    pub request_id: String,
    pub source_edit_id: String,
    pub full_runtime_proof_accepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_runtime_proof_id: Option<String>,
    pub gpu_hmr_success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl GpuReloadV2Result {
    pub fn applied(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        full_runtime_proof_id: impl Into<String>,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_RELOAD_V2_RESULT_SCHEMA_VERSION.to_string(),
            status: "applied".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            full_runtime_proof_accepted: true,
            full_runtime_proof_id: Some(full_runtime_proof_id.into()),
            gpu_hmr_success: true,
            reason: None,
        };
        result.validate()?;
        Ok(result)
    }

    pub fn rejected(
        request_id: impl Into<String>,
        source_edit_id: impl Into<String>,
        reason: impl Into<String>,
    ) -> Result<Self, String> {
        let result = Self {
            schema_version: GPU_RELOAD_V2_RESULT_SCHEMA_VERSION.to_string(),
            status: "rejected".to_string(),
            module: "device".to_string(),
            request_id: request_id.into(),
            source_edit_id: source_edit_id.into(),
            full_runtime_proof_accepted: false,
            full_runtime_proof_id: None,
            gpu_hmr_success: false,
            reason: Some(reason.into()),
        };
        result.validate()?;
        Ok(result)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != GPU_RELOAD_V2_RESULT_SCHEMA_VERSION {
            return Err("GPU reload V2 result schema mismatch".to_string());
        }
        if self.module != "device"
            || !canonical_gpu_reload_request_id(&self.request_id)
            || !canonical_source_edit_id(&self.source_edit_id)
        {
            return Err("GPU reload V2 terminal identity mismatch".to_string());
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
                Ok(())
            }
            "rejected"
                if !self.full_runtime_proof_accepted
                    && !self.gpu_hmr_success
                    && self.full_runtime_proof_id.is_none()
                    && self.reason.as_deref().is_some_and(nonempty_safe_text) =>
            {
                Ok(())
            }
            "applied" | "rejected" => {
                Err("GPU reload V2 terminal proof fields are inconsistent".to_string())
            }
            _ => Err("GPU reload V2 terminal status is invalid".to_string()),
        }
    }

    pub fn matches(&self, request_id: &str, source_edit_id: &str) -> bool {
        self.validate().is_ok()
            && self.request_id == request_id
            && self.source_edit_id == source_edit_id
    }

    pub fn matches_expectation(&self, expectation: &GpuReloadV2Expectation) -> bool {
        self.matches(&expectation.request_id, &expectation.source_edit_id)
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

    #[test]
    fn gpu_reload_v2_round_trip_preserves_exact_typed_payload() {
        let payload = GpuReloadV2Payload::new(
            fixture_request_id('1'),
            "partial",
            "rocm",
            "/tmp/path with space/device.hsaco",
            vec!["gpu::shade".to_string()],
            Some("sha256:abi".to_string()),
            Some("capsulev1_payload".to_string()),
            source_edit_id(),
        )
        .unwrap();
        let encoded = payload.encode().unwrap();
        assert!(!encoded.chars().any(char::is_whitespace));
        assert_eq!(GpuReloadV2Payload::decode(&encoded).unwrap(), payload);
    }

    #[test]
    fn gpu_reload_v2_rejects_noncanonical_or_conflicting_identity() {
        assert!(GpuReloadV2Payload::new(
            fixture_request_id('1'),
            "full",
            "rocm",
            "/tmp/device.hsaco",
            Vec::new(),
            None,
            None,
            "source-edit:sha256:short".to_string(),
        )
        .is_err());

        let mut payload = GpuReloadV2Payload::new(
            fixture_request_id('2'),
            "full",
            "rocm",
            "/tmp/device.hsaco",
            Vec::new(),
            None,
            None,
            source_edit_id(),
        )
        .unwrap();
        payload.request_id = format!("gpu-reload:request:{}", "z".repeat(32));
        assert!(payload.encode().is_err());
    }

    #[test]
    fn protocol_ack_is_bound_to_nonce_pid_version_and_capability() {
        let ack = RunnerProtocolAck::current("nonce-a");
        let line = ack.line().unwrap();
        let parsed = parse_runner_protocol_ack(&line).unwrap();
        assert!(parsed.supports_strict_gpu_reload("nonce-a", std::process::id()));
        assert!(!parsed.supports_strict_gpu_reload("nonce-b", std::process::id()));
        assert!(!parsed.supports_strict_gpu_reload("nonce-a", std::process::id() + 1));

        let mut missing_capability = parsed;
        missing_capability.capabilities.clear();
        assert!(!missing_capability.supports_strict_gpu_reload("nonce-a", std::process::id()));
    }

    #[test]
    fn gpu_reload_v2_terminal_result_is_bound_to_request_source_and_runtime_proof() {
        let source_edit_id = source_edit_id();
        let request_id = fixture_request_id('3');
        let proof_id = format!("gpu-runtime-proof:sha256:{}", "b".repeat(64));
        let applied = GpuReloadV2Result::applied(&request_id, &source_edit_id, &proof_id).unwrap();
        let encoded = applied.to_json().unwrap();
        let decoded = GpuReloadV2Result::from_json(&encoded).unwrap();
        assert_eq!(decoded, applied);
        assert!(decoded.matches(&request_id, &source_edit_id));
        assert!(!decoded.matches(&fixture_request_id('4'), &source_edit_id));

        let mut forged = decoded;
        forged.full_runtime_proof_accepted = false;
        assert!(forged.to_json().is_err());
        assert!(
            GpuReloadV2Result::applied(&request_id, &source_edit_id, "proof:declared").is_err()
        );

        let rejected =
            GpuReloadV2Result::rejected(&request_id, &source_edit_id, "strict proof missing")
                .unwrap();
        assert!(!rejected.gpu_hmr_success);
        assert!(rejected.full_runtime_proof_id.is_none());
    }
}
