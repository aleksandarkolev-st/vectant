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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub name: String,
    pub content: String,
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
    /// Target platform for execution: "native" (default), "react-native-emulator", etc.
    #[serde(default)]
    pub target: Option<String>,
    /// Project root path for mobile builds (relative to workspace)
    #[serde(default)]
    pub project_root: Option<String>,
    /// Workspace slug for mobile builds (to download synced files)
    #[serde(default)]
    pub slug: Option<String>,
}
