// ============================================================
// Phase 12.6a — HMR IPC protocol type tests
// ============================================================

use worker::runtime::path_c::hmr_protocol::*;

#[test]
fn command_load_roundtrip() {
    let cmd = HmrCommand::Load {
        command_id: 1,
        module_name: "core".to_string(),
        so_path: "/build/libcore_123.so".to_string(),
    };
    let json = serde_json::to_string(&cmd).unwrap();
    let decoded: HmrCommand = serde_json::from_str(&json).unwrap();
    assert_eq!(cmd, decoded);
    assert_eq!(decoded.command_id(), Some(1));
}

#[test]
fn command_handshake_roundtrip() {
    let cmd = HmrCommand::Handshake {
        supervisor_version: PROTOCOL_VERSION_CURRENT,
        supervisor_min_supported: PROTOCOL_VERSION_MIN_SUPPORTED,
        supervisor_capabilities: default_supervisor_capabilities(),
    };
    let json = serde_json::to_string(&cmd).unwrap();
    let decoded: HmrCommand = serde_json::from_str(&json).unwrap();
    assert_eq!(cmd, decoded);
    assert_eq!(decoded.command_id(), None);
}

#[test]
fn response_ack_roundtrip() {
    let resp = HmrResponse::Ack { command_id: 42 };
    let json = serde_json::to_string(&resp).unwrap();
    let decoded: HmrResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(resp, decoded);
}

#[test]
fn response_error_roundtrip() {
    let resp = HmrResponse::Error {
        command_id: 5,
        code: ERR_LOAD_FAILED.to_string(),
        message: "dlopen failed: libfoo.so not found".to_string(),
    };
    let json = serde_json::to_string(&resp).unwrap();
    let decoded: HmrResponse = serde_json::from_str(&json).unwrap();
    assert_eq!(resp, decoded);
}

#[test]
fn forward_compat_extra_fields_ignored() {
    let json =
        r#"{"type":"Load","command_id":1,"module_name":"core","so_path":"/x","future_field":true}"#;
    let cmd: HmrCommand = serde_json::from_str(json).unwrap();
    assert_eq!(cmd.command_id(), Some(1));
}

#[test]
fn version_compat_basic() {
    assert!(versions_compatible(1, 1, 1, 1));
    assert!(versions_compatible(2, 1, 1, 1));
    assert!(versions_compatible(1, 1, 2, 1));
    assert!(!versions_compatible(1, 1, 3, 3));
    assert!(!versions_compatible(3, 3, 1, 1));
}

#[test]
fn negotiated_version_picks_min() {
    assert_eq!(negotiated_version(1, 2), 1);
    assert_eq!(negotiated_version(3, 1), 1);
    assert_eq!(negotiated_version(2, 2), 2);
}

#[test]
fn patch_bytes_command() {
    let cmd = HmrCommand::PatchBytes {
        command_id: 10,
        module_name: "core".to_string(),
        file_offset: 0x2000,
        bytes_hex: "deadbeef".to_string(),
    };
    let json = serde_json::to_string(&cmd).unwrap();
    assert!(json.contains("PatchBytes"));
    assert!(json.contains("deadbeef"));
}

#[test]
fn default_capabilities_have_expected_entries() {
    let sup = default_supervisor_capabilities();
    assert!(sup.contains(&CAP_LOAD.to_string()));
    assert!(sup.contains(&CAP_RELOAD.to_string()));
    assert!(sup.contains(&CAP_BINARY_PATCH.to_string()));

    let child = default_child_capabilities();
    assert!(child.contains(&CAP_LOAD.to_string()));
    assert!(child.contains(&CAP_WINDOW_DISCOVERY.to_string()));
}
