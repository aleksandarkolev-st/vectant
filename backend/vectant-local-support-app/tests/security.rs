use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr};

use tempfile::tempdir;
use vectant_local_support_app::audit::{AuditClass, AuditLog};
use vectant_local_support_app::http::{RateLimiter, MAX_JSON_BODY_BYTES};
use vectant_local_support_app::pair::{PairingError, PairingSession};
use vectant_local_support_app::preview::{
    decide_preview_request, decide_preview_request_from_header_list, redirect_allowed,
    sanitize_response_header_list, sanitize_response_headers, PortApproval, PreviewDecision,
};
use vectant_local_support_app::scanner::SecretScanner;
use vectant_local_support_app::session::{SessionError, SessionGuard};
use vectant_local_support_app::workspace::{FileReadRequest, WorkspacePolicy};

fn request(path: &str) -> FileReadRequest {
    FileReadRequest {
        request_id: format!("req_{path}"),
        session_id: "sess_123".to_string(),
        workspace_id: "wk_123".to_string(),
        capability: "workspace.file.source.read".to_string(),
        path: path.to_string(),
        max_bytes: Some(262_144),
        reason: "Debug test".to_string(),
        actor: "vectant_ai".to_string(),
        expires_at: "2026-07-05T12:00:00Z".to_string(),
    }
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
fn pairing_requires_matching_fingerprint_and_rate_limits() {
    let mut pairing = PairingSession::new(std::time::Duration::from_secs(60));
    let public = pairing.public_code();
    assert_eq!(pairing.verify(&public.code, "bad-fingerprint"), Err(PairingError::Mismatch));
    assert!(pairing.verify(&public.code, &public.fingerprint).is_ok());

    let mut limited = PairingSession::new(std::time::Duration::from_secs(60));
    for _ in 0..5 {
        let _ = limited.verify("bad", "bad");
    }
    assert_eq!(limited.verify("bad", "bad"), Err(PairingError::RateLimited));
}

#[test]
fn preview_blocks_unapproved_private_redirects_and_credentials() {
    let approval = PortApproval::browser_only(5173, "vite:1234");
    let mut headers = HashMap::new();
    headers.insert("Cookie".to_string(), "vectant_session=secret".to_string());

    assert_eq!(
        decide_preview_request(
            Some(&approval),
            "GET",
            &approval.preview_host,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &headers,
        ),
        PreviewDecision::Deny("credential_header_blocked".to_string())
    );

    headers.clear();
    assert_eq!(
        decide_preview_request(
            Some(&approval),
            "POST",
            &approval.preview_host,
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            &headers,
        ),
        PreviewDecision::Deny("state_changing_method_blocked".to_string())
    );

    assert!(!redirect_allowed("http://169.254.169.254/latest/meta-data/"));
    assert!(!redirect_allowed("http://192.168.1.1/admin"));
    assert!(!redirect_allowed("file:///etc/passwd"));
    assert!(redirect_allowed("http://127.0.0.1:5173/ok"));
    assert!(redirect_allowed("http://[::1]:5173/ok"));
}

#[test]
fn preview_blocks_request_smuggling_and_connection_named_headers() {
    let approval = PortApproval::browser_only(5173, "vite:1234");
    let target = IpAddr::V4(Ipv4Addr::LOCALHOST);

    assert_eq!(
        decide_preview_request_from_header_list(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Content-Length", "4"), ("Content-Length", "5")],
        ),
        PreviewDecision::Deny("duplicate_content_length_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Transfer-Encoding", "chunked"), ("Content-Length", "5")],
        ),
        PreviewDecision::Deny("ambiguous_body_length_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Connection", "Authorization")],
        ),
        PreviewDecision::Deny("connection_sensitive_header_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Connection", "X-Shadow-Hop"), ("X-Shadow-Hop", "secret")],
        ),
        PreviewDecision::Deny("connection_named_header_blocked".to_string())
    );
}

#[test]
fn response_headers_strip_cookie_and_block_service_workers() {
    let mut headers = HashMap::new();
    headers.insert("Set-Cookie".to_string(), "vectant_session=bad; Domain=.vectant.com".to_string());
    headers.insert("Content-Type".to_string(), "text/html".to_string());
    let sanitized = sanitize_response_headers(&headers);

    assert!(!sanitized.contains_key("Set-Cookie"));
    assert_eq!(sanitized.get("Service-Worker-Allowed"), Some(&"none".to_string()));
    assert!(sanitized
        .get("Content-Security-Policy")
        .unwrap()
        .contains("worker-src 'none'"));
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
}
