// ============================================================
// HMR IPC PROTOCOL (Phase 12.6 — §7.2 12b)
// ============================================================
//
// Typed message protocol for supervisor ↔ child communication
// over Unix domain sockets. Replaces the Phase 12.5 stdin text
// protocol with versioned, capability-negotiated IPC.
//
// Wire format: 4-byte LE length prefix + JSON payload.
// Forward compatibility: unknown fields silently dropped by serde,
// unknown commands → Error{ENOTSUP}.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION_CURRENT: u8 = 1;
pub const PROTOCOL_VERSION_MIN_SUPPORTED: u8 = 1;

// ── Capabilities ──

pub const CAP_LOAD: &str = "load";
pub const CAP_UNLOAD: &str = "unload";
pub const CAP_RELOAD: &str = "reload";
pub const CAP_BINARY_PATCH: &str = "binary_patch";
pub const CAP_WINDOW_DISCOVERY: &str = "window_discovery";

pub fn default_supervisor_capabilities() -> Vec<String> {
    vec![
        CAP_LOAD.to_string(),
        CAP_UNLOAD.to_string(),
        CAP_RELOAD.to_string(),
        CAP_BINARY_PATCH.to_string(),
    ]
}

pub fn default_child_capabilities() -> Vec<String> {
    vec![
        CAP_LOAD.to_string(),
        CAP_RELOAD.to_string(),
        CAP_WINDOW_DISCOVERY.to_string(),
    ]
}

// ── Commands (supervisor → child) ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum HmrCommand {
    Handshake {
        supervisor_version: u8,
        supervisor_min_supported: u8,
        supervisor_capabilities: Vec<String>,
    },
    Load {
        command_id: u64,
        module_name: String,
        so_path: String,
    },
    Unload {
        command_id: u64,
        module_name: String,
    },
    Reload {
        command_id: u64,
        module_name: String,
        so_path: String,
    },
    PatchBytes {
        command_id: u64,
        module_name: String,
        file_offset: u64,
        bytes_hex: String,
    },
    SetSession {
        command_id: u64,
        session_id: String,
    },
    Shutdown {
        command_id: u64,
    },
}

// ── Responses (child → supervisor) ──

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum HmrResponse {
    HandshakeAck {
        child_version: u8,
        child_min_supported: u8,
        child_capabilities: Vec<String>,
    },
    Ack {
        command_id: u64,
    },
    Error {
        command_id: u64,
        code: String,
        message: String,
    },
    WindowDiscovered {
        x11_window_id: u64,
    },
    ChildReady {
        pid: u32,
    },
}

// ── Error codes ──

pub const ERR_ENOTSUP: &str = "ENOTSUP";
pub const ERR_LOAD_FAILED: &str = "LOAD_FAILED";
pub const ERR_VERSION_MISMATCH: &str = "VERSION_MISMATCH";
pub const ERR_PATCH_FAILED: &str = "PATCH_FAILED";

impl HmrCommand {
    pub fn command_id(&self) -> Option<u64> {
        match self {
            Self::Handshake { .. } => None,
            Self::Load { command_id, .. }
            | Self::Unload { command_id, .. }
            | Self::Reload { command_id, .. }
            | Self::PatchBytes { command_id, .. }
            | Self::SetSession { command_id, .. }
            | Self::Shutdown { command_id, .. } => Some(*command_id),
        }
    }
}

impl HmrResponse {
    pub fn command_id(&self) -> Option<u64> {
        match self {
            Self::HandshakeAck { .. } => None,
            Self::WindowDiscovered { .. } => None,
            Self::ChildReady { .. } => None,
            Self::Ack { command_id } | Self::Error { command_id, .. } => Some(*command_id),
        }
    }
}

/// Check if two protocol versions are compatible.
pub fn versions_compatible(
    local_version: u8,
    local_min: u8,
    remote_version: u8,
    remote_min: u8,
) -> bool {
    local_version >= remote_min && remote_version >= local_min
}

/// Compute the negotiated protocol version (min of both currents).
pub fn negotiated_version(local_version: u8, remote_version: u8) -> u8 {
    local_version.min(remote_version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_roundtrip_json() {
        let cmd = HmrCommand::Load {
            command_id: 42,
            module_name: "core".to_string(),
            so_path: "/build/libcore.so".to_string(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: HmrCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(cmd, decoded);
    }

    #[test]
    fn response_roundtrip_json() {
        let resp = HmrResponse::HandshakeAck {
            child_version: 1,
            child_min_supported: 1,
            child_capabilities: vec!["load".to_string(), "reload".to_string()],
        };
        let json = serde_json::to_string(&resp).unwrap();
        let decoded: HmrResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, decoded);
    }

    #[test]
    fn handshake_command_no_id() {
        let cmd = HmrCommand::Handshake {
            supervisor_version: 1,
            supervisor_min_supported: 1,
            supervisor_capabilities: vec![],
        };
        assert_eq!(cmd.command_id(), None);
    }

    #[test]
    fn load_command_has_id() {
        let cmd = HmrCommand::Load {
            command_id: 7,
            module_name: "gui".to_string(),
            so_path: "/tmp/libgui.so".to_string(),
        };
        assert_eq!(cmd.command_id(), Some(7));
    }

    #[test]
    fn versions_compatible_same() {
        assert!(versions_compatible(1, 1, 1, 1));
    }

    #[test]
    fn versions_compatible_forward() {
        assert!(versions_compatible(2, 1, 1, 1));
    }

    #[test]
    fn versions_incompatible() {
        assert!(!versions_compatible(1, 1, 3, 3));
    }

    #[test]
    fn unknown_fields_ignored() {
        let json = r#"{"type":"Ack","command_id":1,"extra_field":"ignored"}"#;
        let resp: HmrResponse = serde_json::from_str(json).unwrap();
        assert_eq!(resp, HmrResponse::Ack { command_id: 1 });
    }

    #[test]
    fn patch_bytes_roundtrip() {
        let cmd = HmrCommand::PatchBytes {
            command_id: 99,
            module_name: "core".to_string(),
            file_offset: 0x2000,
            bytes_hex: "c3f54840".to_string(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let decoded: HmrCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(cmd, decoded);
    }

    #[test]
    fn window_discovered_response() {
        let resp = HmrResponse::WindowDiscovered {
            x11_window_id: 0x04000001,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("WindowDiscovered"));
        let decoded: HmrResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, decoded);
    }
}
