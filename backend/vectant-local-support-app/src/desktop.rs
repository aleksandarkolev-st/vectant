use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopSecurityReport {
    pub csp_restrictive: bool,
    pub fs_scope_empty: bool,
    pub shell_open_disabled: bool,
    pub clipboard_disabled: bool,
    pub devtools_disabled: bool,
    pub updater_requires_signature: bool,
    pub renderer_token_access_blocked: bool,
}

impl DesktopSecurityReport {
    pub fn hardened(&self) -> bool {
        self.csp_restrictive
            && self.fs_scope_empty
            && self.shell_open_disabled
            && self.clipboard_disabled
            && self.devtools_disabled
            && self.updater_requires_signature
            && self.renderer_token_access_blocked
    }
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
                        endpoint
                            .as_str()
                            .is_some_and(|url| url.starts_with("https://") && !url.contains("localhost"))
                    })
            });

    Ok(DesktopSecurityReport {
        csp_restrictive: csp_allows_no_remote_code(csp),
        fs_scope_empty,
        shell_open_disabled,
        clipboard_disabled,
        devtools_disabled,
        updater_requires_signature,
        renderer_token_access_blocked: renderer_token_access_blocked(&value),
    })
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

fn is_ed25519_public_key_hex(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn renderer_token_access_blocked(value: &Value) -> bool {
    let Some(commands) = value.pointer("/plugins").or(Some(value)) else {
        return true;
    };
    !commands
        .to_string()
        .to_ascii_lowercase()
        .contains("token")
        && !commands
            .to_string()
            .to_ascii_lowercase()
            .contains("keychain")
}
