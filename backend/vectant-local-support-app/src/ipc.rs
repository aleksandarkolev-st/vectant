use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IpcRequest {
    pub command: String,
    pub request_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IpcDecision {
    pub decision: String,
    pub reason: String,
    pub user_visible: bool,
}

const ALLOWED_IPC_COMMANDS: &[&str] = &[
    "session.status",
    "session.pause",
    "session.resume",
    "session.disconnect",
    "pairing.start",
    "pairing.confirm",
    "workspace.pick",
    "workspace.inventory",
    "approval.file.review",
    "approval.file.approve",
    "approval.file.deny",
    "approval.port.review",
    "approval.port.open",
    "approval.port.revoke",
    "approval.revoke_session",
    "full_access.pause",
    "full_access.revoke",
    "full_access.enroll",
    "process.visibility.pause",
    "history.export",
    "history.delete",
    "update.check",
    "update.install",
];

const DANGEROUS_COMMAND_FRAGMENTS: &[&str] = &[
    "exec",
    "shell",
    "command",
    "write",
    "delete",
    "remove",
    "readfile",
    "read_file",
    "openpath",
    "open_path",
    "keychain",
    "clipboard",
    "screen",
    "accessibility",
    "token",
    "bearer",
    "device_private",
    "private_key",
    "credential",
    "secret",
    "local_log",
    "audit_raw",
];

pub fn decide_ipc_request(request: &IpcRequest) -> IpcDecision {
    if !is_safe_ipc_identifier(&request.request_id) || !is_safe_ipc_identifier(&request.session_id)
    {
        return deny("invalid_schema");
    }
    let normalized = request.command.trim().to_ascii_lowercase();
    if normalized.len() > 80
        || !normalized
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '.' || ch == '_')
    {
        return deny("invalid_schema");
    }
    if ALLOWED_IPC_COMMANDS.contains(&normalized.as_str()) {
        return IpcDecision {
            decision: "allow".to_string(),
            reason: "ipc_command_allowed".to_string(),
            user_visible: true,
        };
    }
    if DANGEROUS_COMMAND_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
    {
        return deny("dangerous_ipc_command_blocked");
    }
    deny("ipc_command_not_allowed")
}

fn is_safe_ipc_identifier(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 128
        && trimmed == value
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
}

fn deny(reason: &str) -> IpcDecision {
    IpcDecision {
        decision: "deny".to_string(),
        reason: reason.to_string(),
        user_visible: true,
    }
}
