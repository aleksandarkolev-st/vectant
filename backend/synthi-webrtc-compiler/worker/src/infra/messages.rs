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
