use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr};

use tempfile::tempdir;
use vectant_local_support_app::audit::{AuditClass, AuditLog, ConsentReceipt};
use vectant_local_support_app::http::{RateLimiter, MAX_JSON_BODY_BYTES};
use vectant_local_support_app::pair::{
    verify_pairing_proof, DeviceIdentity, PairingError, PairingSession,
};
use vectant_local_support_app::preview::{
    decide_preview_request, decide_preview_request_from_header_list, redirect_allowed,
    port_identity_matches, preview_path_allowed, sanitize_response_header_list,
    sanitize_response_headers, PortApproval, PreviewDecision,
};
use vectant_local_support_app::policy::Classification;
use vectant_local_support_app::scanner::SecretScanner;
use vectant_local_support_app::session::{SessionError, SessionGuard};
use vectant_local_support_app::update::{
    signed_test_manifest, verify_update_manifest, UpdateError,
};
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
fn preview_blocks_websockets_and_port_identity_changes() {
    let approval = PortApproval::browser_only(5173, "vite:1234");
    let target = IpAddr::V4(Ipv4Addr::LOCALHOST);

    assert!(port_identity_matches(&approval, "vite:1234"));
    assert!(!port_identity_matches(&approval, "admin-panel:9999"));

    assert_eq!(
        decide_preview_request_from_header_list(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Upgrade", "websocket")],
        ),
        PreviewDecision::Deny("websocket_blocked".to_string())
    );

    assert_eq!(
        decide_preview_request_from_header_list(
            Some(&approval),
            "GET",
            &approval.preview_host,
            target,
            &[("Sec-WebSocket-Key", "abc")],
        ),
        PreviewDecision::Deny("websocket_blocked".to_string())
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
