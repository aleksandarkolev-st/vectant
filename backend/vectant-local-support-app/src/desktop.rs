use serde_json::Value;

use crate::http::AppState;
use crate::ipc::{decide_ipc_request, IpcRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopSecurityReport {
    pub csp_restrictive: bool,
    pub fs_scope_empty: bool,
    pub shell_open_disabled: bool,
    pub clipboard_disabled: bool,
    pub devtools_disabled: bool,
    pub updater_requires_signature: bool,
    pub csp_blocks_loopback_fetch: bool,
    pub renderer_token_access_blocked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopIpcActionPlan {
    pub command: String,
    pub daemon_method: Option<String>,
    pub daemon_path_template: Option<String>,
    pub requires_local_control: bool,
    pub returns_sanitized_state: bool,
    pub user_visible: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DesktopIpcError {
    Denied(String),
    UnsupportedCommand,
}

impl std::fmt::Display for DesktopIpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied(reason) => write!(formatter, "desktop ipc denied: {reason}"),
            Self::UnsupportedCommand => formatter.write_str("desktop ipc command is unsupported"),
        }
    }
}

impl std::error::Error for DesktopIpcError {}

impl DesktopSecurityReport {
    pub fn hardened(&self) -> bool {
        self.csp_restrictive
            && self.fs_scope_empty
            && self.shell_open_disabled
            && self.clipboard_disabled
            && self.devtools_disabled
            && self.csp_blocks_loopback_fetch
            && self.updater_requires_signature
            && self.renderer_token_access_blocked
    }
}

pub async fn build_desktop_status_state(state: &AppState) -> Value {
    let session_guard = state.session.lock().await;
    let connected = session_guard.is_active();
    let session = session_guard.state();
    drop(session_guard);
    let workspace = state.workspace.summary();
    let pending_approvals = state.approvals.lock().await.pending_len();
    let ports = state.port_approvals.lock().await.approvals();
    let events = state.audit.lock().await.events().to_vec();

    sanitize_desktop_ipc_state(&serde_json::json!({
        "connected": connected,
        "paused": session.paused,
        "session": {
            "session_id": session.session_id,
            "account_id": if connected { session.account_id.as_str() } else { "not paired" },
            "org_id": if connected { session.org_id.as_str() } else { "not paired" },
            "workspace_id": if connected { session.workspace_id.as_str() } else { "No folder selected" },
            "device_fingerprint": session.device_fingerprint,
            "protocol_version": session.protocol_version,
            "mode": "Balanced review before send"
        },
        "workspace": {
            "selected": workspace.workspace_id != "not_selected",
            "workspace_id": workspace.workspace_id,
            "display": workspace.display,
            "root_hash": workspace.root_hash,
            "root_path_included": workspace.root_path_included,
            "policy_version": workspace.policy_version,
            "scanner_version": workspace.scanner_version
        },
        "approvals": {
            "pending_count": pending_approvals,
            "content_included": false
        },
        "ports": ports,
        "activity": events,
        "history_controls_available": state.audit_store.is_some(),
        "raw_bodies_included": false
    }))
}

pub fn plan_desktop_ipc_action(
    request: &IpcRequest,
) -> Result<DesktopIpcActionPlan, DesktopIpcError> {
    let decision = decide_ipc_request(request);
    if decision.decision != "allow" {
        return Err(DesktopIpcError::Denied(decision.reason));
    }
    let command = request.command.trim().to_ascii_lowercase();
    let plan = match command.as_str() {
        "session.status" => DesktopIpcActionPlan {
            command,
            daemon_method: Some("GET".to_string()),
            daemon_path_template: Some("/v1/status/{request_id}".to_string()),
            requires_local_control: false,
            returns_sanitized_state: true,
            user_visible: true,
        },
        "session.pause" => control_plan(command, "POST", "/v1/session/pause/{request_id}", true),
        "session.resume" => control_plan(command, "POST", "/v1/session/resume/{request_id}", true),
        "session.disconnect" => {
            control_plan(command, "POST", "/v1/session/disconnect/{request_id}", true)
        }
        "approval.revoke_session" => control_plan(
            command,
            "POST",
            "/v1/approval/revoke-all/{request_id}",
            true,
        ),
        "history.export" => control_plan(command, "GET", "/v1/history/export/{request_id}", true),
        "history.delete" => control_plan(command, "POST", "/v1/history/delete/{request_id}", true),
        "pairing.start"
        | "pairing.confirm"
        | "workspace.pick"
        | "workspace.inventory"
        | "approval.file.review"
        | "approval.port.review" => DesktopIpcActionPlan {
            command,
            daemon_method: None,
            daemon_path_template: None,
            requires_local_control: true,
            returns_sanitized_state: true,
            user_visible: true,
        },
        _ => return Err(DesktopIpcError::UnsupportedCommand),
    };
    Ok(plan)
}

pub fn inspect_tauri_config(config_json: &str) -> Result<DesktopSecurityReport, serde_json::Error> {
    let value: Value = serde_json::from_str(config_json)?;
    let csp = value
        .pointer("/app/security/csp")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let fs_scope_empty = value
        .pointer("/plugins/fs/scope")
        .and_then(Value::as_array)
        .is_some_and(|scope| scope.is_empty());
    let shell_open_disabled = value
        .pointer("/plugins/shell/open")
        .and_then(Value::as_bool)
        .is_some_and(|open| !open);
    let clipboard_disabled = value
        .pointer("/plugins/clipboard/enabled")
        .and_then(Value::as_bool)
        .is_some_and(|enabled| !enabled);
    let devtools_disabled = value
        .pointer("/app/windows/0/devtools")
        .and_then(Value::as_bool)
        .is_some_and(|enabled| !enabled);
    let updater_requires_signature = value
        .pointer("/plugins/updater/active")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && value
            .pointer("/bundle/createUpdaterArtifacts")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && value
            .pointer("/plugins/updater/pubkey")
            .and_then(Value::as_str)
            .is_some_and(is_ed25519_public_key_hex)
        && value
            .pointer("/plugins/updater/endpoints")
            .and_then(Value::as_array)
            .is_some_and(|endpoints| {
                !endpoints.is_empty()
                    && endpoints.iter().all(|endpoint| {
                        endpoint.as_str().is_some_and(|url| {
                            url.starts_with("https://") && !url.contains("localhost")
                        })
                    })
            });

    Ok(DesktopSecurityReport {
        csp_restrictive: csp_allows_no_remote_code(csp),
        fs_scope_empty,
        shell_open_disabled,
        clipboard_disabled,
        devtools_disabled,
        updater_requires_signature,
        csp_blocks_loopback_fetch: csp_blocks_loopback_fetch(csp),
        renderer_token_access_blocked: renderer_token_access_blocked(&value),
    })
}

fn control_plan(
    command: String,
    method: &str,
    path_template: &str,
    returns_sanitized_state: bool,
) -> DesktopIpcActionPlan {
    DesktopIpcActionPlan {
        command,
        daemon_method: Some(method.to_string()),
        daemon_path_template: Some(path_template.to_string()),
        requires_local_control: true,
        returns_sanitized_state,
        user_visible: true,
    }
}

pub fn renderer_command_can_access_secret(command: &str) -> bool {
    let normalized = command.trim().to_ascii_lowercase();
    [
        "token",
        "bearer",
        "device_private",
        "private_key",
        "keychain",
        "credential",
        "secret",
        "local_log",
        "audit_raw",
    ]
    .iter()
    .any(|fragment| normalized.contains(fragment))
}

pub fn sanitize_desktop_ipc_state(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sanitized = serde_json::Map::new();
            for (key, value) in map {
                if desktop_state_key_is_sensitive(key) {
                    continue;
                }
                sanitized.insert(key.clone(), sanitize_desktop_ipc_state(value));
            }
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_desktop_ipc_state).collect()),
        Value::String(text) => Value::String(scrub_desktop_state_string(text)),
        other => other.clone(),
    }
}

fn csp_allows_no_remote_code(csp: &str) -> bool {
    let lower = csp.to_ascii_lowercase();
    lower.contains("default-src 'self'")
        && lower.contains("script-src 'self'")
        && lower.contains("object-src 'none'")
        && lower.contains("base-uri 'none'")
        && lower.contains("frame-ancestors 'none'")
        && lower.contains("worker-src 'none'")
        && !lower.contains("'unsafe-eval'")
        && !lower.contains("'unsafe-inline'")
        && !lower.contains("script-src http:")
        && !lower.contains("script-src https:")
}

fn csp_blocks_loopback_fetch(csp: &str) -> bool {
    let lower = csp.to_ascii_lowercase();
    let connect_src = lower
        .split(';')
        .map(str::trim)
        .find(|directive| directive.starts_with("connect-src "))
        .unwrap_or_default();
    !connect_src.contains("127.0.0.1")
        && !connect_src.contains("localhost")
        && !connect_src.contains("[::1]")
        && !connect_src.contains("::1")
}

fn is_ed25519_public_key_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn renderer_token_access_blocked(value: &Value) -> bool {
    let Some(commands) = value.pointer("/plugins").or(Some(value)) else {
        return true;
    };
    !commands.to_string().to_ascii_lowercase().contains("token")
        && !commands
            .to_string()
            .to_ascii_lowercase()
            .contains("keychain")
}

fn desktop_state_key_is_sensitive(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    normalized.contains("token")
        || normalized.contains("private_key")
        || normalized.contains("device_private")
        || normalized.contains("keychain")
        || normalized.contains("credential")
        || normalized.contains("secret")
        || normalized.contains("raw_body")
        || normalized.contains("raw_bodies")
        || normalized.contains("authorization")
}

fn scrub_desktop_state_string(value: &str) -> String {
    let scanner = crate::scanner::SecretScanner::default();
    let report = scanner.scan(value);
    scanner.redact(value, &report)
}
