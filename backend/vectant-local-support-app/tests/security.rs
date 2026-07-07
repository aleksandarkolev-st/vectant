use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr};

use tempfile::tempdir;
use vectant_local_support_app::audit::{AuditClass, AuditLog, AuditStoreError, ConsentReceipt, LocalAuditStore};
use vectant_local_support_app::approval::{ApprovalQueue, ApprovalStatus};
use vectant_local_support_app::desktop::{inspect_tauri_config, renderer_command_can_access_secret};
use vectant_local_support_app::http::{
    validate_file_request_authorization, LocalAuthorizationError, LocalRequestAuthorization,
    RateLimiter, MAX_JSON_BODY_BYTES,
};
use vectant_local_support_app::ipc::{decide_ipc_request, IpcRequest};
use vectant_local_support_app::lifecycle::{
    disconnect_cleanup, uninstall_cleanup, PendingApprovalQueue,
};
use vectant_local_support_app::pair::{
    verify_pairing_proof, DeviceIdentity, PairingError, PairingSession,
};
use vectant_local_support_app::preview::{
    classify_preview_redirect, decide_preview_request, decide_preview_request_from_header_list,
    decide_preview_request_from_header_list_with_token, decide_preview_request_with_token,
    redirect_allowed, port_identity_matches, preview_path_allowed, preview_token_matches,
    sanitize_response_header_list, sanitize_response_headers, validate_preview_response_size,
    PortApproval, PortApprovalRegistry, PreviewDecision, PreviewRedirectDecision, PreviewTrafficGuard,
    MAX_ACTIVE_PREVIEW_STREAMS_PER_HOST, MAX_PREVIEW_REQUESTS_PER_MINUTE_PER_HOST,
    MAX_PREVIEW_RESPONSE_BYTES,
};
use vectant_local_support_app::policy::Classification;
use vectant_local_support_app::scanner::SecretScanner;
use vectant_local_support_app::session::{SessionError, SessionGuard};
use vectant_local_support_app::update::{
    signed_test_manifest, verify_update_manifest, UpdateError,
};
use vectant_local_support_app::workspace::{resolve_relative, FileReadRequest, WorkspacePolicy};

fn request(path: &str) -> FileReadRequest {
    FileReadRequest {
        request_id: format!("req_{path}"),
        session_id: "sess_123".to_string(),
        account_id: "acct_local".to_string(),
        org_id: "org_local".to_string(),
        workspace_id: "wk_123".to_string(),
        capability: "workspace.file.source.read".to_string(),
        path: path.to_string(),
        max_bytes: Some(262_144),
        reason: "Debug test".to_string(),
        actor: "vectant_ai".to_string(),
        expires_at: "2030-07-05T12:00:00Z".to_string(),
    }
}

fn local_auth(session: &SessionGuard, request_id: &str) -> LocalRequestAuthorization {
    LocalRequestAuthorization {
        app_version: "0.1.0".to_string(),
        protocol_version: vectant_local_support_app::APP_PROTOCOL_VERSION.to_string(),
        policy_version: vectant_local_support_app::POLICY_VERSION.to_string(),
        device_fingerprint: session.device_fingerprint().to_string(),
        device_proof: session.request_device_proof(request_id),
    }
}

fn preview_token(port: u16, process_identity: &str) -> String {
    format!("local-preview-token-{port}-{process_identity}")
}

#[test]
fn blocks_traversal_and_secret_files() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("app.rs"), "fn main() {}\n").unwrap();
    fs::write(dir.path().join(".env"), "OPENAI_API_KEY=sk-testsecret000000000000000\n").unwrap();
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();

    let traversal = policy.read_file_for_review(&request("../.ssh/id_ed25519"));
    assert_eq!(traversal.decision, "denied");
    assert_eq!(traversal.bytes_sent, 0);

    let env = policy.read_file_for_review(&request(".env"));
    assert_eq!(env.decision, "denied");
    assert_eq!(env.bytes_sent, 0);
    assert!(env.content.is_none());
}

#[test]
fn blocks_device_unc_named_pipe_and_drive_paths() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("app.rs"), "fn main() {}\n").unwrap();
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();

    for path in [
        r"\\server\share\secrets.txt",
        r"\\?\C:\Users\alex\.ssh\id_ed25519",
        r"\\.\pipe\vectant",
        r"\??\C:\Windows\win.ini",
        r"C:\Users\alex\.aws\credentials",
        "C:relative-drive-path.txt",
    ] {
        assert!(resolve_relative(policy.root(), path).is_err(), "path should be blocked: {path}");
        let response = policy.read_file_for_review(&request(path));
        assert_eq!(response.decision, "denied");
        assert_eq!(response.bytes_sent, 0);
        assert!(response.content.is_none());
    }
}

#[cfg(unix)]
#[test]
fn blocks_symlink_escape_from_workspace() {
    use std::os::unix::fs::symlink;

    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("credentials"), "aws_access_key_id = AKIA1234567890ABCDEF\n").unwrap();
    symlink(outside.path().join("credentials"), workspace.path().join("linked-credentials")).unwrap();
    let policy = WorkspacePolicy::new(workspace.path(), "wk_123", SecretScanner::default()).unwrap();

    let response = policy.read_file_for_review(&request("linked-credentials"));
    assert_eq!(response.decision, "denied");
    assert_eq!(response.bytes_sent, 0);
    assert!(response.content.is_none());
    assert!(resolve_relative(policy.root(), "linked-credentials").is_err());
}

#[cfg(windows)]
#[test]
fn blocks_junction_escape_from_workspace() {
    use std::process::Command;

    let workspace = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::write(outside.path().join("credentials.txt"), "aws_access_key_id = AKIA1234567890ABCDEF\n").unwrap();
    let link = workspace.path().join("outside-link");
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&link)
        .arg(outside.path())
        .status()
        .unwrap();
    assert!(status.success(), "mklink /J should create a junction for the escape test");

    let policy = WorkspacePolicy::new(workspace.path(), "wk_123", SecretScanner::default()).unwrap();
    let response = policy.read_file_for_review(&request("outside-link/credentials.txt"));
    assert_eq!(response.decision, "denied");
    assert_eq!(response.bytes_sent, 0);
    assert!(response.content.is_none());
    assert!(resolve_relative(policy.root(), "outside-link/credentials.txt").is_err());
}

#[test]
fn redacts_secrets_before_review_payload() {
    let dir = tempdir().unwrap();
    fs::write(
        dir.path().join("server.log"),
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\npostgres://user:pass@localhost/db\n",
    )
    .unwrap();
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();
    let mut req = request("server.log");
    req.capability = "workspace.log.read".to_string();
    let response = policy.read_file_for_review(&req);

    assert_eq!(response.decision, "redact_then_approval");
    let content = response.content.unwrap();
    assert!(content.contains("[REDACTED:authorization_header]"));
    assert!(content.contains("[REDACTED:database_url]"));
    assert!(!content.contains("postgres://user:pass"));
}

#[test]
fn approval_queue_keeps_review_content_local_until_approval() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("server.log"), "Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n").unwrap();
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();
    let mut req = request("server.log");
    req.capability = "workspace.log.read".to_string();
    req.session_id = "sess_queue".to_string();
    let local_review = policy.read_file_for_review(&req);
    assert!(local_review.content.is_some());

    let mut queue = ApprovalQueue::new();
    let public = queue.queue_file_review(req.clone(), local_review);
    let approval_id = public.approval_id.clone().unwrap();

    assert_eq!(public.decision, "approval_queued");
    assert_eq!(public.bytes_sent, 0);
    assert!(public.content.is_none());
    assert_eq!(queue.pending_len(), 1);
    assert_eq!(queue.get(&approval_id).unwrap().status, ApprovalStatus::Pending);

    let (approved, receipt) = queue.approve(&approval_id).unwrap();
    assert_eq!(approved.approval_id.as_deref(), Some(approval_id.as_str()));
    assert!(approved.content.unwrap().contains("[REDACTED:authorization_header]"));
    assert_eq!(receipt.approval_id, approval_id);
    assert_eq!(receipt.request_id, req.request_id);
    assert_eq!(receipt.session_id, "sess_queue");
    assert_eq!(receipt.capability, "workspace.log.read");
    assert_eq!(receipt.scope, "once");
}

#[test]
fn approval_queue_deny_and_revoke_invalidate_queued_content() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("app.rs"), "fn main() {}\n").unwrap();
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();
    let mut queue = ApprovalQueue::new();

    let req = request("app.rs");
    let public = queue.queue_file_review(req.clone(), policy.read_file_for_review(&req));
    let approval_id = public.approval_id.clone().unwrap();

    assert!(queue.deny(&approval_id));
    let denied = queue.get(&approval_id).unwrap();
    assert_eq!(denied.status, ApprovalStatus::Denied);
    assert!(denied.local_review.content.is_none());
    assert!(queue.approve(&approval_id).is_none());

    let mut second_req = request("app.rs");
    second_req.request_id = "req_second".to_string();
    let second_public = queue.queue_file_review(second_req.clone(), policy.read_file_for_review(&second_req));
    let second_approval_id = second_public.approval_id.clone().unwrap();
    queue.revoke_all();
    let revoked = queue.get(&second_approval_id).unwrap();
    assert_eq!(revoked.status, ApprovalStatus::Revoked);
    assert!(revoked.local_review.content.is_none());
    assert_eq!(queue.pending_len(), 0);
}

#[test]
fn blocks_sensitive_filename_variants_and_cloud_credentials() {
    let dir = tempdir().unwrap();
    fs::create_dir_all(dir.path().join(".aws")).unwrap();
    fs::write(
        dir.path().join("production.env.backup"),
        "DATABASE_URL=postgres://u:p@localhost/db\n",
    )
    .unwrap();
    fs::write(
        dir.path().join(".aws").join("credentials"),
        "aws_access_key_id = AKIA1234567890ABCDEF\n",
    )
    .unwrap();
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();

    for path in ["production.env.backup", ".aws/credentials"] {
        let response = policy.read_file_for_review(&request(path));
        assert_eq!(response.decision, "denied");
        assert_eq!(response.bytes_sent, 0);
        assert!(response.content.is_none());
    }
}

#[test]
fn blocks_default_ignored_and_sensitive_artifact_paths() {
    let dir = tempdir().unwrap();
    for path in [
        ".docker/config.json",
        ".npmrc",
        ".pypirc",
        ".netrc",
        ".git-credentials",
        ".git/config",
        ".git/objects/aa/object",
        ".git/logs/HEAD",
        ".git/hooks/pre-commit",
        ".vscode/settings.json",
        "node_modules/pkg/index.js",
        "dist/app.js",
        "build/app.js",
        ".next/server/app.js",
        "coverage/lcov.info",
        "data.sqlite",
        "dump.sql",
        "backup.bak",
        "server.crt",
        "known_hosts",
        "Thumbs.db",
    ] {
        let full = dir.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(&full, "local artifact that must not leave the machine\n").unwrap();
    }
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();

    for path in [
        ".docker/config.json",
        ".npmrc",
        ".pypirc",
        ".netrc",
        ".git-credentials",
        ".git/config",
        ".git/objects/aa/object",
        ".git/logs/HEAD",
        ".git/hooks/pre-commit",
        ".vscode/settings.json",
        "node_modules/pkg/index.js",
        "dist/app.js",
        "build/app.js",
        ".next/server/app.js",
        "coverage/lcov.info",
        "data.sqlite",
        "dump.sql",
        "backup.bak",
        "server.crt",
        "known_hosts",
        "Thumbs.db",
    ] {
        let response = policy.read_file_for_review(&request(path));
        assert_eq!(response.decision, "denied", "{path} should be denied");
        assert_eq!(response.bytes_sent, 0);
        assert!(response.content.is_none());
    }
}

#[test]
fn blocks_archive_binary_and_huge_files() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("bundle.zip"), b"PK\x03\x04").unwrap();
    fs::write(dir.path().join("image.bin"), b"hello\0secret").unwrap();
    fs::write(dir.path().join("huge.log"), vec![b'a'; 262_145]).unwrap();
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();

    for path in ["bundle.zip", "image.bin", "huge.log"] {
        let response = policy.read_file_for_review(&request(path));
        assert_eq!(response.decision, "denied");
        assert_eq!(response.bytes_sent, 0);
        assert!(response.content.is_none());
    }
}

#[test]
fn scanner_redacts_required_secret_fixtures() {
    let scanner = SecretScanner::default();
    let content = [
        "GitHub=ghp_abcdefghijklmnopqrstuvwxyz123456",
        "OpenAI=sk-abcdefghijklmnopqrstuvwxyz123456",
        "Jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
        "AWS=AKIA1234567890ABCDEF",
        "-----BEGIN PRIVATE KEY-----",
        "Database=postgres://user:pass@localhost/db",
        "Cookie: session_id=super-secret-cookie",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        "NPM=npm_abcdefghijklmnopqrstuvwxyz",
        r#"{ "type": "service_account", "project_id": "demo" }"#,
    ]
    .join("\n");

    let report = scanner.scan(&content);
    let kinds: Vec<_> = report.findings.iter().map(|finding| finding.kind.as_str()).collect();
    for expected in [
        "github_token",
        "openai_api_key",
        "jwt",
        "aws_access_key",
        "private_key",
        "database_url",
        "cookie",
        "authorization_header",
        "npm_token",
        "firebase_service_account",
    ] {
        assert!(kinds.contains(&expected), "missing scanner fixture {expected}");
    }

    let redacted = scanner.redact(&content, &report);
    for raw in [
        "ghp_abcdefghijklmnopqrstuvwxyz123456",
        "sk-abcdefghijklmnopqrstuvwxyz123456",
        "eyJhbGciOiJIUzI1NiJ9",
        "AKIA1234567890ABCDEF",
        "-----BEGIN PRIVATE KEY-----",
        "postgres://user:pass@localhost/db",
        "super-secret-cookie",
        "abcdefghijklmnopqrstuvwxyz",
        "npm_abcdefghijklmnopqrstuvwxyz",
        r#""type": "service_account""#,
    ] {
        assert!(!redacted.contains(raw), "raw scanner fixture leaked: {raw}");
    }
}

#[test]
fn scanner_failure_denies_file_reads() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("app.ts"), "export const ok = true;\n").unwrap();
    let policy = WorkspacePolicy::new(
        dir.path(),
        "wk_123",
        SecretScanner::unavailable("scanner-test"),
    )
    .unwrap();

    let response = policy.read_file_for_review(&request("app.ts"));
    assert_eq!(response.decision, "denied");
    assert_eq!(response.bytes_sent, 0);
    assert!(response.content.is_none());
    assert!(response
        .user_visible_message
        .unwrap()
        .contains("secret scanner was unavailable"));
}

#[test]
fn session_rejects_bad_token_replay_and_pause() {
    let mut session = SessionGuard::new("wk_123", std::time::Duration::from_secs(60));
    let token = session.token_for_pairing_response().to_string();

    assert_eq!(session.validate("wrong", "req_1"), Err(SessionError::BadToken));
    assert!(session.validate(&token, "req_1").is_ok());
    assert_eq!(session.validate(&token, "req_1"), Err(SessionError::Replay));
    session.pause();
    assert_eq!(session.validate(&token, "req_2"), Err(SessionError::Paused));
}

#[test]
fn session_control_can_resume_from_paused_state() {
    let mut session = SessionGuard::new("wk_123", std::time::Duration::from_secs(60));
    let token = session.token_for_pairing_response().to_string();

    session.pause();
    assert_eq!(session.validate(&token, "req_data"), Err(SessionError::Paused));
    assert!(session.validate_control(&token, "req_resume").is_ok());
    session.resume();
    assert!(session.validate(&token, "req_after_resume").is_ok());
    assert!(session.validate_control(&token, "req_disconnect").is_ok());
    session.disconnect();
    assert_eq!(session.validate_control(&token, "req_after_disconnect"), Err(SessionError::Expired));
}

#[test]
fn disconnect_cleanup_revokes_tokens_streams_and_pending_approvals() {
    let mut session = SessionGuard::new("wk_123", std::time::Duration::from_secs(60));
    let token = session.token_for_pairing_response().to_string();
    let session_id = session.session_id().to_string();
    let mut registry = PortApprovalRegistry::new();
    let approval = registry.approve_browser_port(&session_id, 5173, "vite:1234");
    let mut traffic = PreviewTrafficGuard::new();
    let mut pending = PendingApprovalQueue::new();

    pending.push("appr_file_1");
    assert!(traffic.begin_stream(&approval.preview_host));
    assert_eq!(traffic.active_stream_count(&approval.preview_host), 1);
    assert!(registry.approval_for(&session_id, 5173, "vite:1234").is_some());

    let report = disconnect_cleanup(&mut session, &mut registry, &mut traffic, &mut pending);

    assert_eq!(pending.len(), 0);
    assert_eq!(traffic.active_stream_count(&approval.preview_host), 0);
    assert!(registry.approval_for(&session_id, 5173, "vite:1234").is_none());
    assert_eq!(
        session.validate_control(&token, "req_after_cleanup"),
        Err(SessionError::Expired)
    );
    assert!(report.cloud_token_revoked);
    assert!(report.local_token_revoked);
    assert!(report.preview_tokens_revoked);
    assert!(report.agent_tokens_revoked);
    assert!(report.preview_streams_stopped);
    assert!(report.pending_approvals_cleared);
    assert!(report.session_disconnected);
    assert!(!report.hidden_daemon_running);
}

#[test]
fn uninstall_cleanup_leaves_no_hidden_daemon_state() {
    let mut session = SessionGuard::new("wk_123", std::time::Duration::from_secs(60));
    let session_id = session.session_id().to_string();
    let mut registry = PortApprovalRegistry::new();
    let approval = registry.approve_browser_port(&session_id, 3000, "next:3000");
    let mut traffic = PreviewTrafficGuard::new();
    let mut pending = PendingApprovalQueue::new();

    pending.push("appr_port_1");
    assert!(traffic.begin_stream(&approval.preview_host));

    let report = uninstall_cleanup(&mut session, &mut registry, &mut traffic, &mut pending);

    assert_eq!(pending.len(), 0);
    assert_eq!(traffic.active_stream_count(&approval.preview_host), 0);
    assert!(registry.approval_for(&session_id, 3000, "next:3000").is_none());
    assert!(!report.hidden_daemon_running);
}

#[test]
fn desktop_ipc_allows_only_narrow_commands() {
    let allowed = decide_ipc_request(&IpcRequest {
        command: "session.pause".to_string(),
        request_id: "req_pause".to_string(),
        session_id: "sess_123".to_string(),
    });
    assert_eq!(allowed.decision, "allow");

    for command in [
        "fs.readFile",
        "workspace.writeFile",
        "shell.exec",
        "openPath",
        "clipboard.read",
        "screen.capture",
        "accessibility.enable",
        "keychain.read",
    ] {
        let denied = decide_ipc_request(&IpcRequest {
            command: command.to_string(),
            request_id: format!("req_{command}"),
            session_id: "sess_123".to_string(),
        });
        assert_eq!(denied.decision, "deny");
        assert_eq!(denied.user_visible, true);
    }
}

#[test]
fn desktop_tauri_config_keeps_renderer_unprivileged() {
    let config = include_str!("../desktop/tauri.conf.json");
    let report = inspect_tauri_config(config).unwrap();

    assert!(report.csp_restrictive);
    assert!(report.fs_scope_empty);
    assert!(report.shell_open_disabled);
    assert!(report.clipboard_disabled);
    assert!(report.devtools_disabled);
    assert!(report.renderer_token_access_blocked);
}

#[test]
fn desktop_ipc_blocks_renderer_secret_and_device_key_access() {
    for command in [
        "session.token.read",
        "pairing.bearer.export",
        "device_private_key.read",
        "keychain.entry.get",
        "credentials.dump",
        "local_log.read",
        "audit_raw.export",
        "approval.file.review;fs.readFile",
        "workspace.pick/../../secret",
    ] {
        assert!(
            renderer_command_can_access_secret(command)
                || command.contains(';')
                || command.contains('/'),
            "test command should model a dangerous renderer action: {command}"
        );
        let denied = decide_ipc_request(&IpcRequest {
            command: command.to_string(),
            request_id: format!("req_{command}"),
            session_id: "sess_123".to_string(),
        });
        assert_eq!(denied.decision, "deny", "{command} must be denied");
        assert!(denied.user_visible);
    }
}

#[test]
fn local_api_rate_limiter_denies_after_window_budget() {
    let start = std::time::Instant::now();
    let mut limiter = RateLimiter::new(2, std::time::Duration::from_secs(60));

    assert!(limiter.allow_at(start));
    assert!(limiter.allow_at(start + std::time::Duration::from_secs(1)));
    assert!(!limiter.allow_at(start + std::time::Duration::from_secs(2)));
    assert!(limiter.allow_at(start + std::time::Duration::from_secs(61)));
}

#[test]
fn local_api_body_limit_matches_file_review_cap() {
    assert_eq!(MAX_JSON_BODY_BYTES, 262_144);
}

#[test]
fn local_file_requests_bind_to_session_workspace_expiry_versions_and_device_proof() {
    let dir = tempdir().unwrap();
    fs::write(dir.path().join("app.rs"), "fn main() {}\n").unwrap();
    let policy = WorkspacePolicy::new(dir.path(), "wk_123", SecretScanner::default()).unwrap();
    let session = SessionGuard::new("wk_123", std::time::Duration::from_secs(60));
    let mut req = request("app.rs");
    req.session_id = session.session_id().to_string();
    let auth = local_auth(&session, &req.request_id);
    let now = chrono::DateTime::parse_from_rfc3339("2026-07-05T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);

    assert!(validate_file_request_authorization(&session, &policy, &req, &auth, now).is_ok());

    let mut wrong_session = req.clone();
    wrong_session.session_id = "sess_attacker".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &wrong_session, &auth, now),
        Err(LocalAuthorizationError::SessionMismatch)
    );

    let mut wrong_account = req.clone();
    wrong_account.account_id = "acct_attacker".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &wrong_account, &auth, now),
        Err(LocalAuthorizationError::AccountMismatch)
    );

    let mut wrong_org = req.clone();
    wrong_org.org_id = "org_attacker".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &wrong_org, &auth, now),
        Err(LocalAuthorizationError::OrgMismatch)
    );

    let mut wrong_workspace = req.clone();
    wrong_workspace.workspace_id = "wk_other".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &wrong_workspace, &auth, now),
        Err(LocalAuthorizationError::WorkspaceMismatch)
    );

    let mut expired = req.clone();
    expired.expires_at = "2026-07-05T11:59:59Z".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &expired, &auth, now),
        Err(LocalAuthorizationError::ExpiredRequest)
    );

    let mut invalid_expiry = req.clone();
    invalid_expiry.expires_at = "not-a-date".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &invalid_expiry, &auth, now),
        Err(LocalAuthorizationError::InvalidRequestExpiry)
    );

    let mut old_app = auth.clone();
    old_app.app_version = "0.0.9".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &req, &old_app, now),
        Err(LocalAuthorizationError::AppVersionTooOld)
    );

    let mut blocked_app = auth.clone();
    blocked_app.app_version = "0.1.1".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &req, &blocked_app, now),
        Err(LocalAuthorizationError::AppVersionBlocked)
    );

    let mut stale_protocol = auth.clone();
    stale_protocol.protocol_version = "local-support-old".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &req, &stale_protocol, now),
        Err(LocalAuthorizationError::ProtocolVersionMismatch)
    );

    let mut stale_policy = auth.clone();
    stale_policy.policy_version = "2026.01.01".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &req, &stale_policy, now),
        Err(LocalAuthorizationError::PolicyVersionMismatch)
    );

    let mut wrong_device = auth.clone();
    wrong_device.device_fingerprint = "sha256:wrong-device".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &req, &wrong_device, now),
        Err(LocalAuthorizationError::DeviceMismatch)
    );

    let mut malformed_device = auth.clone();
    malformed_device.device_fingerprint = "dev-not-a-fingerprint".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &req, &malformed_device, now),
        Err(LocalAuthorizationError::DeviceMismatch)
    );

    let mut bad_proof = auth.clone();
    bad_proof.device_proof = "sha256:bad-proof".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &req, &bad_proof, now),
        Err(LocalAuthorizationError::DeviceProofInvalid)
    );

    let mut malformed_proof = auth;
    malformed_proof.device_proof = "not-a-proof".to_string();
    assert_eq!(
        validate_file_request_authorization(&session, &policy, &req, &malformed_proof, now),
        Err(LocalAuthorizationError::DeviceProofInvalid)
    );
}

#[test]
fn pairing_requires_matching_fingerprint_and_rate_limits() {
    let mut pairing = PairingSession::new(std::time::Duration::from_secs(60));
    let public = pairing.public_code();
    assert_eq!(pairing.verify(&public.code, "bad-fingerprint"), Err(PairingError::Mismatch));
    assert!(pairing.verify(&public.code, &public.fingerprint).is_ok());
    assert_eq!(
        pairing.verify(&public.code, &public.fingerprint),
        Err(PairingError::Consumed)
    );

    let mut limited = PairingSession::new(std::time::Duration::from_secs(60));
    for _ in 0..5 {
        let _ = limited.verify("bad", "bad");
    }
    assert_eq!(limited.verify("bad", "bad"), Err(PairingError::RateLimited));
}

#[test]
fn pairing_proof_binds_device_key_to_challenge() {
    let device = DeviceIdentity::generate();
    let proof = device.sign_pairing_challenge("pair_123", "nonce_123", "browser_123", "user_123");

    assert!(verify_pairing_proof(&proof).is_ok());

    let mut tampered = proof.clone();
    tampered.browser_session_id = "browser_456".to_string();
    assert_eq!(verify_pairing_proof(&tampered), Err(PairingError::BadSignature));

    let mut wrong_user = proof;
    wrong_user.requested_user_id = "user_456".to_string();
    assert_eq!(verify_pairing_proof(&wrong_user), Err(PairingError::BadSignature));
}

#[test]
fn preview_blocks_unapproved_private_redirects_and_credentials() {
    let token = preview_token(5173, "vite:1234");
    let approval = PortApproval::browser_only_with_token(5173, "vite:1234", &token);
    let mut headers = HashMap::new();
    headers.insert("Cookie".to_string(), "vectant_session=secret".to_string());

    assert_eq!(
        decide_preview_request_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &headers,
            &token,
        ),
        PreviewDecision::Deny("credential_header_blocked".to_string())
    );

    headers.clear();
    assert_eq!(
        decide_preview_request_with_token(
            Some(&approval),
            "POST",
            &approval.preview_host,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &headers,
            &token,
        ),
        PreviewDecision::Deny("state_changing_method_blocked".to_string())
    );

    assert!(!redirect_allowed("http://169.254.169.254/latest/meta-data/"));
    assert!(!redirect_allowed("http://192.168.1.1/admin"));
    assert!(!redirect_allowed("http://2130706433/admin"));
    assert!(!redirect_allowed("http://0x7f.0.0.1/admin"));
    assert!(!redirect_allowed("http://0177.0.0.1/admin"));
    assert!(!redirect_allowed("http://user:pass@127.0.0.1:5173/secret"));
    assert!(!redirect_allowed("file:///etc/passwd"));
    assert!(redirect_allowed("http://127.0.0.1:5173/ok"));
    assert!(redirect_allowed("http://[::1]:5173/ok"));
}

#[test]
fn preview_redirect_classifier_rewrites_only_approved_loopback_targets() {
    let token = preview_token(5173, "vite:1234");
    let approval = PortApproval::browser_only_with_token(5173, "vite:1234", &token);

    assert_eq!(
        classify_preview_redirect(&approval, "/docs/index.html", "/assets/app.js"),
        PreviewRedirectDecision::RewriteToPreview("/assets/app.js".to_string())
    );
    assert_eq!(
        classify_preview_redirect(&approval, "/docs/index.html", "next.html"),
        PreviewRedirectDecision::RewriteToPreview("/docs/next.html".to_string())
    );
    assert_eq!(
        classify_preview_redirect(&approval, "/docs/index.html", "http://127.0.0.1:5173/ok?x=1"),
        PreviewRedirectDecision::RewriteToPreview("/ok?x=1".to_string())
    );
    assert_eq!(
        classify_preview_redirect(&approval, "/docs/index.html", "http://localhost:5173/ok"),
        PreviewRedirectDecision::RewriteToPreview("/ok".to_string())
    );
    assert_eq!(
        classify_preview_redirect(&approval, "/docs/index.html", "http://[::1]:5173/ok"),
        PreviewRedirectDecision::RewriteToPreview("/ok".to_string())
    );
}

#[test]
fn preview_redirect_classifier_blocks_proxy_abuse_and_separates_external_navigation() {
    let token = preview_token(5173, "vite:1234");
    let approval = PortApproval::browser_only_with_token(5173, "vite:1234", &token);

    for location in [
        "http://127.0.0.1:3000/wrong-port",
        "https://127.0.0.1:3000/wrong-port",
        "http://192.168.1.1/admin",
        "https://192.168.1.1/admin",
        "http://10.0.0.5/",
        "https://10.0.0.5/",
        "http://169.254.169.254/latest/meta-data/",
        "https://169.254.169.254/latest/meta-data/",
        "http://2130706433/admin",
        "http://0x7f.0.0.1/admin",
        "http://0177.0.0.1/admin",
        "file:///etc/passwd",
        "mailto:security@example.com",
        "http://user:pass@127.0.0.1:5173/secret",
    ] {
        assert!(
            matches!(
                classify_preview_redirect(&approval, "/docs/index.html", location),
                PreviewRedirectDecision::Block(_)
            ),
            "{location} should be blocked"
        );
    }

    assert_eq!(
        classify_preview_redirect(&approval, "/docs/index.html", "https://example.com/docs"),
        PreviewRedirectDecision::ExternalNavigation("https://example.com/docs".to_string())
    );
}

#[test]
fn preview_requires_short_lived_token_for_browser_requests() {
    let token = preview_token(5173, "vite:1234");
    let approval = PortApproval::browser_only_with_token(5173, "vite:1234", &token);
    let target = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let headers = HashMap::new();
    let mut registry = PortApprovalRegistry::new();
    let grant = registry.approve_browser_port_grant("sess_123", 5174, "vite:5174");

    assert!(preview_token_matches(&grant.approval, &grant.preview_token));
    assert_ne!(grant.approval.preview_token_hash, grant.preview_token);
    assert!(preview_token_matches(&approval, &token));
    assert!(!preview_token_matches(&approval, "wrong-token"));
    assert_eq!(
        decide_preview_request(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &headers,
        ),
        PreviewDecision::Deny("preview_token_invalid".to_string())
    );
    assert_eq!(
        decide_preview_request_from_header_list(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[],
        ),
        PreviewDecision::Deny("preview_token_invalid".to_string())
    );
    assert_eq!(
        decide_preview_request_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &headers,
            "wrong-token",
        ),
        PreviewDecision::Deny("preview_token_invalid".to_string())
    );
    assert_eq!(
        decide_preview_request_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &headers,
            &token,
        ),
        PreviewDecision::Allow
    );
}

#[test]
fn preview_blocks_request_smuggling_and_connection_named_headers() {
    let token = preview_token(5173, "vite:1234");
    let approval = PortApproval::browser_only_with_token(5173, "vite:1234", &token);
    let target = IpAddr::V4(Ipv4Addr::LOCALHOST);

    assert_eq!(
        decide_preview_request_from_header_list_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Content-Length", "4"), ("Content-Length", "5")],
            &token,
        ),
        PreviewDecision::Deny("duplicate_content_length_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Transfer-Encoding", "chunked"), ("Content-Length", "5")],
            &token,
        ),
        PreviewDecision::Deny("ambiguous_body_length_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Connection", "Authorization")],
            &token,
        ),
        PreviewDecision::Deny("connection_sensitive_header_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Connection", "X-Shadow-Hop"), ("X-Shadow-Hop", "secret")],
            &token,
        ),
        PreviewDecision::Deny("connection_named_header_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("X-Forwarded-For", "10.0.0.4")],
            &token,
        ),
        PreviewDecision::Deny("credential_header_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Sec-Fetch-Site", "same-origin")],
            &token,
        ),
        PreviewDecision::Deny("browser_security_header_blocked".to_string())
    );
}

#[test]
fn preview_blocks_websockets_and_port_identity_changes() {
    let token = preview_token(5173, "vite:1234");
    let approval = PortApproval::browser_only_with_token(5173, "vite:1234", &token);
    let target = IpAddr::V4(Ipv4Addr::LOCALHOST);

    assert!(port_identity_matches(&approval, "vite:1234"));
    assert!(!port_identity_matches(&approval, "admin-panel:9999"));

    assert_eq!(
        decide_preview_request_from_header_list_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Upgrade", "websocket")],
            &token,
        ),
        PreviewDecision::Deny("websocket_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list_with_token(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Sec-WebSocket-Key", "abc")],
            &token,
        ),
        PreviewDecision::Deny("websocket_blocked".to_string())
    );
}

#[test]
fn port_approvals_are_session_scoped_revocable_and_process_bound() {
    let mut registry = PortApprovalRegistry::new();
    let approval = registry.approve_browser_port("sess_123", 5173, "vite:1234");

    assert!(!approval.persistent);
    assert_eq!(approval.expires_at, "session_end");
    assert!(approval.invalidate_on_port_close);
    assert!(approval.invalidate_on_process_change);
    assert!(!approval.agent_read_allowed);
    assert!(!approval.support_agent_read_allowed);
    assert!(!approval.agent_interact_allowed);
    assert!(!approval.send_response_body_allowed);
    assert!(!approval.send_screenshot_allowed);
    assert!(!approval.send_console_errors_allowed);

    assert!(registry
        .approval_for("sess_123", 5173, "vite:1234")
        .is_some());
    assert!(registry
        .approval_for("sess_123", 5173, "admin-panel:9999")
        .is_none());
    assert!(registry.approval_for("other_session", 5173, "vite:1234").is_none());

    registry.revoke_port(5173);
    assert!(registry.approval_for("sess_123", 5173, "vite:1234").is_none());

    registry.approve_browser_port("sess_123", 5173, "vite:1234");
    registry.port_closed(5173);
    assert!(registry.approval_for("sess_123", 5173, "vite:1234").is_none());

    registry.approve_browser_port("sess_123", 5173, "vite:1234");
    registry.disconnect_session("sess_123");
    assert!(registry.approval_for("sess_123", 5173, "vite:1234").is_none());
}

#[test]
fn preview_traffic_guard_limits_request_rate_streams_and_response_bytes() {
    let mut guard = PreviewTrafficGuard::new();
    let host = "br-local-p5173.vectant-preview.dev";

    for _ in 0..MAX_PREVIEW_REQUESTS_PER_MINUTE_PER_HOST {
        assert!(guard.allow_request_at(host, 1_000));
    }
    assert!(!guard.allow_request_at(host, 1_000));
    assert!(guard.allow_request_at(host, 1_061));

    for _ in 0..MAX_ACTIVE_PREVIEW_STREAMS_PER_HOST {
        assert!(guard.begin_stream(host));
    }
    assert!(!guard.begin_stream(host));
    guard.end_stream(host);
    assert!(guard.begin_stream(host));

    assert!(validate_preview_response_size(Some(MAX_PREVIEW_RESPONSE_BYTES), 4).is_ok());
    assert_eq!(
        validate_preview_response_size(Some(MAX_PREVIEW_RESPONSE_BYTES + 1), 0),
        Err("preview_response_too_large".to_string())
    );
    assert_eq!(
        validate_preview_response_size(None, MAX_PREVIEW_RESPONSE_BYTES + 1),
        Err("preview_response_too_large".to_string())
    );
}

#[test]
fn response_headers_strip_cookie_and_block_service_workers() {
    let mut headers = HashMap::new();
    headers.insert("Set-Cookie".to_string(), "vectant_session=bad; Domain=.vectant.com".to_string());
    headers.insert("Location".to_string(), "http://192.168.1.1/admin".to_string());
    headers.insert("X-Frame-Options".to_string(), "SAMEORIGIN".to_string());
    headers.insert("Clear-Site-Data".to_string(), "\"cookies\"".to_string());
    headers.insert("Content-Type".to_string(), "text/html".to_string());
    let sanitized = sanitize_response_headers(&headers);

    assert!(!sanitized.contains_key("Set-Cookie"));
    assert!(!sanitized.contains_key("Location"));
    assert!(!sanitized.contains_key("X-Frame-Options"));
    assert!(!sanitized.contains_key("Clear-Site-Data"));
    assert_eq!(sanitized.get("Service-Worker-Allowed"), Some(&"none".to_string()));
    assert_eq!(sanitized.get("Cache-Control"), Some(&"no-store".to_string()));
    assert_eq!(sanitized.get("Referrer-Policy"), Some(&"no-referrer".to_string()));
    assert_eq!(sanitized.get("X-Content-Type-Options"), Some(&"nosniff".to_string()));
    assert!(sanitized
        .get("Permissions-Policy")
        .unwrap()
        .contains("camera=()"));
    assert!(sanitized
        .get("Content-Security-Policy")
        .unwrap()
        .contains("worker-src 'none'"));
}

#[test]
fn preview_blocks_service_worker_script_paths() {
    for path in ["/sw.js", "/service-worker.js?cache=1", "/static/serviceworker.js"] {
        assert!(!preview_path_allowed(path), "service worker path should be blocked: {path}");
    }
    assert!(preview_path_allowed("/assets/app.js"));
}

#[test]
fn response_headers_strip_hop_by_hop_and_connection_named_headers() {
    let sanitized = sanitize_response_header_list(&[
        ("Connection", "X-Internal-Trace, Keep-Alive"),
        ("X-Internal-Trace", "secret"),
        ("Keep-Alive", "timeout=5"),
        ("Transfer-Encoding", "chunked"),
        ("Content-Type", "text/html"),
    ]);

    assert!(!sanitized.contains_key("Connection"));
    assert!(!sanitized.contains_key("X-Internal-Trace"));
    assert!(!sanitized.contains_key("Keep-Alive"));
    assert!(!sanitized.contains_key("Transfer-Encoding"));
    assert_eq!(sanitized.get("Content-Type"), Some(&"text/html".to_string()));
}

#[test]
fn audit_log_scrubs_secret_material() {
    let mut log = AuditLog::new(SecretScanner::default());
    log.append(
        AuditClass::Denied,
        Some("req_log".to_string()),
        "Denied Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        true,
    );
    let event = &log.events()[0];
    assert!(event.summary.contains("[REDACTED:authorization_header]"));
    assert!(!event.summary.contains("abcdefghijklmnopqrstuvwxyz"));
    assert!(event.event_hash.starts_with("sha256:"));
    assert!(log.export_incident_bundle(30).verify_hash_chain());
}

#[test]
fn audit_export_contains_consent_receipts_and_detects_tampering() {
    let mut log = AuditLog::new(SecretScanner::default());
    log.record_consent(ConsentReceipt {
        approval_id: "appr_123".to_string(),
        request_id: "req_log".to_string(),
        session_id: "sess_123".to_string(),
        actor: "support_agent".to_string(),
        capability: "workspace.log.read".to_string(),
        target_display: "dev-server.log".to_string(),
        classification: Classification::L3,
        content_sha256: Some("sha256:content".to_string()),
        scope: "once".to_string(),
        granted_at: chrono::Utc::now(),
        expires_at: "session_end".to_string(),
        policy_version: "2026.07.05".to_string(),
        scanner_version: "scanner-2026.07.05".to_string(),
    });
    log.append(
        AuditClass::Denied,
        Some("req_env".to_string()),
        "Blocked .env. Nothing was sent.",
        true,
    );

    let export = log.export_incident_bundle(30);
    assert!(export.verify_hash_chain());
    assert!(!export.raw_bodies_included);
    assert_eq!(export.consent_receipts.len(), 1);
    assert_eq!(export.consent_receipts[0].approval_id, "appr_123");

    let mut tampered = export.clone();
    tampered.events[0].summary = "Consent silently changed".to_string();
    assert!(!tampered.verify_hash_chain());
}

#[test]
fn audit_delete_clears_prior_events_and_keeps_new_chain_valid() {
    let mut log = AuditLog::new(SecretScanner::default());
    log.append(
        AuditClass::Data,
        Some("req_before_delete".to_string()),
        "Sent package metadata after local review.",
        true,
    );
    assert_eq!(log.events().len(), 1);

    log.clear();
    log.append(
        AuditClass::Control,
        Some("req_delete".to_string()),
        "Local support history deleted according to retention policy.",
        true,
    );

    let export = log.export_incident_bundle(0);
    assert_eq!(export.events.len(), 1);
    assert!(export.verify_hash_chain());
    assert!(!export.raw_bodies_included);
    assert!(!serde_json::to_string(&export).unwrap().contains("Sent package metadata"));
}

#[test]
fn local_audit_store_persists_scrubbed_hash_chained_history() {
    let dir = tempdir().unwrap();
    let store = LocalAuditStore::new(
        dir.path().join("audit.json"),
        30,
        SecretScanner::default(),
    );
    let mut log = AuditLog::new(SecretScanner::default());
    log.append(
        AuditClass::Denied,
        Some("req_store_secret".to_string()),
        "Blocked Authorization: Bearer abcdefghijklmnopqrstuvwxyz before send.",
        true,
    );

    store.persist(&log).unwrap();
    let raw = fs::read_to_string(store.path()).unwrap();
    assert!(raw.contains("[REDACTED:authorization_header]"));
    assert!(!raw.contains("abcdefghijklmnopqrstuvwxyz"));

    let loaded = store.load().unwrap();
    let export = loaded.export_incident_bundle(store.retention_days());
    assert!(export.verify_hash_chain());
    assert_eq!(export.events.len(), 1);
    assert!(!export.raw_bodies_included);
}

#[test]
fn local_audit_store_rejects_tampered_history_and_delete_removes_file() {
    let dir = tempdir().unwrap();
    let store = LocalAuditStore::new(
        dir.path().join("audit.json"),
        0,
        SecretScanner::default(),
    );
    let mut log = AuditLog::new(SecretScanner::default());
    log.append(AuditClass::Control, Some("req_audit".to_string()), "Session paused.", true);
    store.persist(&log).unwrap();

    let mut export = log.export_incident_bundle(0);
    export.events[0].summary = "tampered summary".to_string();
    fs::write(store.path(), serde_json::to_vec_pretty(&export).unwrap()).unwrap();
    assert!(matches!(store.load(), Err(AuditStoreError::HashChainInvalid)));

    store.delete().unwrap();
    assert!(!store.path().exists());
    assert_eq!(store.load().unwrap().events().len(), 0);
}

#[test]
fn update_manifest_requires_valid_signature_and_blocks_downgrades() {
    let (trusted_key, manifest) = signed_test_manifest("0.2.0", "0.1.0", Vec::new());
    assert!(verify_update_manifest(&trusted_key, "0.1.0", &manifest).is_ok());

    let mut tampered = manifest.clone();
    tampered.artifact_sha256 = format!("sha256:{}", "b".repeat(64));
    assert_eq!(
        verify_update_manifest(&trusted_key, "0.1.0", &tampered),
        Err(UpdateError::BadSignature)
    );

    let (_, downgrade) = signed_test_manifest("0.0.9", "0.1.0", Vec::new());
    assert_eq!(
        verify_update_manifest(&trusted_key, "0.1.0", &downgrade),
        Err(UpdateError::Downgrade)
    );
}

#[test]
fn update_manifest_rejects_malformed_artifact_hash_and_unknown_channel() {
    let (trusted_key, mut bad_hash) = signed_test_manifest("0.2.0", "0.1.0", Vec::new());
    bad_hash.artifact_sha256 = "sha256:not-hex".to_string();
    assert_eq!(
        verify_update_manifest(&trusted_key, "0.1.0", &bad_hash),
        Err(UpdateError::InvalidArtifactHash)
    );

    let (trusted_key, mut bad_channel) = signed_test_manifest("0.2.0", "0.1.0", Vec::new());
    bad_channel.channel = "nightly".to_string();
    assert_eq!(
        verify_update_manifest(&trusted_key, "0.1.0", &bad_channel),
        Err(UpdateError::UnsupportedChannel)
    );
}

#[test]
fn update_manifest_supports_emergency_version_revocation() {
    let (trusted_key, manifest) =
        signed_test_manifest("0.2.0", "0.1.0", vec!["0.1.0".to_string()]);
    assert_eq!(
        verify_update_manifest(&trusted_key, "0.1.0", &manifest),
        Err(UpdateError::VersionRevoked)
    );

    let (trusted_key, manifest) = signed_test_manifest("0.2.0", "0.2.0", Vec::new());
    assert_eq!(
        verify_update_manifest(&trusted_key, "0.1.0", &manifest),
        Err(UpdateError::UnsupportedCurrentVersion)
    );
}
