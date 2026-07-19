use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;

pub const GPU_PROOF_TRANSPORT_REQUEST_NONCE_PREFIX: &str = "gpu-proof-transport-request:";

pub fn gpu_proof_transport_request_nonce_valid(value: &str) -> bool {
    let Some(nonce) = value.strip_prefix(GPU_PROOF_TRANSPORT_REQUEST_NONCE_PREFIX) else {
        return false;
    };
    nonce.len() == 32
        && nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Deserialize)]
pub struct IceServerEnv {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SignalMessage {
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdp_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate: Option<RTCIceCandidateInit>,
    /// Per-connection peer identifier assigned by the signaling-server on
    /// register and stamped onto every forwarded SDP/ICE message. Present
    /// on the wire today for forward-compat with G3 Phase B (per-peer PC
    /// routing in the worker); ignored by the current singleton-PC hot
    /// path. See `webrtc/G3_PHASE_B_INTEGRATION.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peer_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileRef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct CompileRequest {
    pub language: String,
    pub filename: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub files: Vec<FileEntry>,
    /// Additional compile inputs already materialized in the worker workspace.
    /// The handler resolves these into `files` only after verifying the
    /// workspace-relative path and optional integrity metadata.
    #[serde(default)]
    pub file_refs: Vec<FileRef>,
    #[serde(default)]
    pub is_gui: bool,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub supports_h265: Option<bool>,
    // #[serde(default)]
    // pub use_ai_split: bool,
    // Add use_ai_split back if it was in the original code, but I missed it in the read.
    // Checking previous read_file output: yes, `use_ai_split` is there.
    #[serde(default)]
    pub use_ai_split: bool,
    /// Require a fresh AI split call instead of accepting a cached split result.
    /// Validation harnesses use this when proving model/request provenance.
    #[serde(
        default,
        alias = "force_ai_split",
        alias = "force_fresh_ai_split",
        alias = "require_fresh_ai_split"
    )]
    pub bypass_ai_split_cache: bool,
    /// Bypass Synthi's device artifact cache and execute the device compiler
    /// under the recorded cache-control contract. This does not claim an
    /// observed external cache miss or complete toolchain-input closure.
    #[serde(default)]
    pub bypass_device_compile_cache: bool,
    /// Require the split result to come from an observed AI provider call.
    /// This is an evidence-mode constraint; deterministic splitting remains
    /// the default when the caller does not request provider execution.
    #[serde(
        default,
        alias = "require_provider_call",
        alias = "force_ai_provider_call"
    )]
    pub require_ai_provider_call: bool,
    /// Caller-generated nonce that binds a required provider call to the
    /// concrete compile request. The worker rejects missing or malformed
    /// nonces whenever `require_ai_provider_call` is enabled.
    #[serde(default, alias = "provider_call_nonce", alias = "aiProviderCallNonce")]
    pub ai_provider_call_nonce: Option<String>,
    /// MCP-generated nonce that correlates any later parent-observed GPU proof
    /// with this concrete compile dispatch. It is transport context only and
    /// cannot authorize GPU HMR by itself.
    #[serde(
        default,
        alias = "gpuProofTransportNonce",
        deserialize_with = "deserialize_optional_gpu_proof_transport_nonce"
    )]
    pub gpu_proof_transport_nonce: Option<String>,
    /// Explicit AI provider selected by the caller for split requests.
    #[serde(
        default,
        alias = "provider",
        alias = "provider_name",
        alias = "aiProvider"
    )]
    pub ai_provider: Option<String>,
    /// Explicit AI model selected by the caller for split requests.
    #[serde(default, alias = "model", alias = "model_name", alias = "aiModel")]
    pub ai_model: Option<String>,
    /// Explicit user request for AI-assisted compilation (Loop B).
    #[serde(default)]
    pub user_requested_ai: bool,
    /// Explicit user request for deterministic compilation (Loop A).
    #[serde(default)]
    pub user_requested_deterministic: bool,
    /// Force GPU source edits through the AI GPU delta path instead of the
    /// local direct-device fast path. Intended for verifier/agentic validation.
    #[serde(default, alias = "use_gpu_ai_delta", alias = "force_ai_delta")]
    pub force_gpu_ai_delta: bool,
    /// Frontend preference for the GPU HMR pipeline. Defaults true so existing
    /// clients get detector/manifest driven GPU behavior.
    #[serde(default = "default_prefer_gpu_pipeline")]
    pub prefer_gpu_pipeline: bool,
    /// Human-readable GPU mode from the UI: "auto" or "disabled".
    #[serde(default)]
    pub gpu_mode: Option<String>,
    /// Optional target GPU architecture (for example "gfx1201" or "sm_80").
    #[serde(default)]
    pub gpu_arch: Option<String>,
    /// Optional compile recipe supplied directly by deterministic callers.
    /// Same JSON shape as `.synthi_split_meta.json::compile_manifest`.
    #[serde(default, alias = "manifest")]
    pub compile_manifest: Option<serde_json::Value>,
    /// Source-first request metadata forwarded across the compile wire.
    /// This wire-only field is not interpreted as compile or runtime authority.
    #[serde(default, deserialize_with = "deserialize_optional_json_object")]
    pub source_first_request_intent: Option<serde_json::Value>,
    /// Target platform for execution: "native" (default), "react-native-emulator", etc.
    #[serde(default)]
    pub target: Option<String>,
    /// Project root path for mobile builds (relative to workspace)
    #[serde(default)]
    pub project_root: Option<String>,
    /// Workspace slug for builds that need to resolve synced workspace file refs.
    #[serde(default)]
    pub slug: Option<String>,
}

fn default_prefer_gpu_pipeline() -> bool {
    true
}

fn deserialize_optional_json_object<'de, D>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if value.is_object() {
        Ok(Some(value))
    } else {
        Err(D::Error::custom("expected a JSON object"))
    }
}

fn deserialize_optional_gpu_proof_transport_nonce<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if value
        .as_deref()
        .is_some_and(|value| !gpu_proof_transport_request_nonce_valid(value))
    {
        return Err(D::Error::custom(
            "invalid GPU proof transport request nonce",
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_request() -> serde_json::Value {
        json!({
            "language": "cpp",
            "filename": "main.cpp",
            "source": "int main(){return 0;}"
        })
    }

    #[test]
    fn compile_request_defaults_to_ai_split_cache_enabled() {
        let req: CompileRequest = serde_json::from_value(base_request()).expect("compile request");

        assert!(!req.bypass_ai_split_cache);
        assert!(!req.bypass_device_compile_cache);
        assert!(!req.require_ai_provider_call);
        assert!(req.ai_provider_call_nonce.is_none());
        assert!(req.gpu_proof_transport_nonce.is_none());
        assert!(req.ai_provider.is_none());
        assert!(req.ai_model.is_none());
    }

    #[test]
    fn compile_request_requires_honest_device_cache_bypass_field() {
        let mut canonical = base_request();
        canonical
            .as_object_mut()
            .expect("object")
            .insert("bypass_device_compile_cache".to_string(), json!(true));
        let req: CompileRequest =
            serde_json::from_value(canonical).expect("canonical compile request");
        assert!(req.bypass_device_compile_cache);

        for field in ["force_fresh_device_compile", "require_fresh_device_compile"] {
            let mut raw = base_request();
            raw.as_object_mut()
                .expect("object")
                .insert(field.to_string(), json!(true));

            let req: CompileRequest = serde_json::from_value(raw).expect("compile request");

            assert!(
                !req.bypass_device_compile_cache,
                "misleading legacy alias must not assert a cache miss: {field}"
            );
        }
    }

    #[test]
    fn compile_request_accepts_fresh_ai_split_cache_policy_aliases() {
        for field in [
            "bypass_ai_split_cache",
            "force_ai_split",
            "force_fresh_ai_split",
            "require_fresh_ai_split",
        ] {
            let mut raw = base_request();
            raw.as_object_mut()
                .expect("object")
                .insert(field.to_string(), json!(true));

            let req: CompileRequest = serde_json::from_value(raw).expect("compile request");

            assert!(req.bypass_ai_split_cache, "alias {field}");
        }
    }

    #[test]
    fn compile_request_accepts_provider_call_requirement_aliases() {
        for field in [
            "require_ai_provider_call",
            "require_provider_call",
            "force_ai_provider_call",
        ] {
            let mut raw = base_request();
            raw.as_object_mut()
                .expect("object")
                .insert(field.to_string(), json!(true));

            let req: CompileRequest = serde_json::from_value(raw).expect("compile request");

            assert!(req.require_ai_provider_call, "alias {field}");
        }
    }

    #[test]
    fn compile_request_accepts_provider_call_nonce_aliases() {
        for field in [
            "ai_provider_call_nonce",
            "provider_call_nonce",
            "aiProviderCallNonce",
        ] {
            let mut raw = base_request();
            raw.as_object_mut().expect("object").insert(
                field.to_string(),
                json!("provider-call:0123456789abcdef0123456789abcdef"),
            );

            let req: CompileRequest = serde_json::from_value(raw).expect("compile request");

            assert_eq!(
                req.ai_provider_call_nonce.as_deref(),
                Some("provider-call:0123456789abcdef0123456789abcdef"),
                "alias {field}"
            );
        }
    }

    #[test]
    fn compile_request_accepts_gpu_proof_transport_nonce_alias() {
        for field in ["gpu_proof_transport_nonce", "gpuProofTransportNonce"] {
            let mut raw = base_request();
            raw.as_object_mut().expect("object").insert(
                field.to_string(),
                json!("gpu-proof-transport-request:0123456789abcdef0123456789abcdef"),
            );

            let req: CompileRequest = serde_json::from_value(raw).expect("compile request");

            assert_eq!(
                req.gpu_proof_transport_nonce.as_deref(),
                Some("gpu-proof-transport-request:0123456789abcdef0123456789abcdef"),
                "alias {field}"
            );
        }
    }

    #[test]
    fn compile_request_rejects_invalid_gpu_proof_transport_nonce() {
        for value in [
            "",
            "gpu-proof-transport-request:",
            "gpu-proof-transport-request:ABCDEF0123456789abcdef0123456789",
            "gpu-proof-transport-request:0123456789abcdef0123456789abcdeg",
            "provider-call:0123456789abcdef0123456789abcdef",
        ] {
            let mut raw = base_request();
            raw.as_object_mut()
                .expect("object")
                .insert("gpu_proof_transport_nonce".to_string(), json!(value));

            assert!(
                serde_json::from_value::<CompileRequest>(raw).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn compile_request_accepts_provider_and_model_aliases() {
        for (provider_field, model_field) in [
            ("ai_provider", "ai_model"),
            ("provider", "model"),
            ("provider_name", "model_name"),
            ("aiProvider", "aiModel"),
        ] {
            let mut raw = base_request();
            let object = raw.as_object_mut().expect("object");
            object.insert(provider_field.to_string(), json!("generic-provider"));
            object.insert(model_field.to_string(), json!("generic-model"));

            let req: CompileRequest = serde_json::from_value(raw).expect("compile request");

            assert_eq!(req.ai_provider.as_deref(), Some("generic-provider"));
            assert_eq!(req.ai_model.as_deref(), Some("generic-model"));
        }
    }
}
