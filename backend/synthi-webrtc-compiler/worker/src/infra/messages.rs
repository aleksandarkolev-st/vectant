use serde::{Deserialize, Serialize};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;

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
        assert!(!req.require_ai_provider_call);
        assert!(req.ai_provider_call_nonce.is_none());
        assert!(req.ai_provider.is_none());
        assert!(req.ai_model.is_none());
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
