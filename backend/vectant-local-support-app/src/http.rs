use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::DefaultBodyLimit;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use rand::{distributions::Alphanumeric, Rng};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::audit::{AuditClass, AuditExport, AuditLog, LocalAuditStore};
use crate::approval::{denied_approval_response, is_safe_approval_id, ApprovalQueue};
use crate::scanner::SecretScanner;
use crate::session::SessionGuard;
use crate::workspace::{FileReadRequest, FileReadResponse, WorkspacePolicy};

pub const MAX_JSON_BODY_BYTES: usize = 256 * 1024;
pub const DEFAULT_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
pub const DEFAULT_RATE_LIMIT_REQUESTS: usize = 120;
pub const MIN_APP_VERSION: &str = "0.1.0";
pub const VULNERABLE_APP_VERSIONS: &[&str] = &["0.0.0", "0.0.1", "0.1.1"];

#[derive(Clone)]
pub struct AppState {
    pub session: Arc<Mutex<SessionGuard>>,
    pub workspace: Arc<WorkspacePolicy>,
    pub rate_limiter: Arc<Mutex<RateLimiter>>,
    pub audit: Arc<Mutex<AuditLog>>,
    pub audit_store: Option<Arc<LocalAuditStore>>,
    pub approvals: Arc<Mutex<ApprovalQueue>>,
    local_control_secret_hash: Arc<String>,
}

impl AppState {
    pub fn new(session: SessionGuard, workspace: WorkspacePolicy) -> Self {
        Self {
            session: Arc::new(Mutex::new(session)),
            workspace: Arc::new(workspace),
            rate_limiter: Arc::new(Mutex::new(RateLimiter::new(
                DEFAULT_RATE_LIMIT_REQUESTS,
                DEFAULT_RATE_LIMIT_WINDOW,
            ))),
            audit: Arc::new(Mutex::new(AuditLog::new(SecretScanner::default()))),
            audit_store: None,
            approvals: Arc::new(Mutex::new(ApprovalQueue::new())),
            local_control_secret_hash: Arc::new(hash_local_control_secret(&generate_local_control_secret())),
        }
    }

    pub fn new_with_audit_store(
        session: SessionGuard,
        workspace: WorkspacePolicy,
        audit_store: LocalAuditStore,
    ) -> Self {
        let audit = audit_store
            .load()
            .unwrap_or_else(|_| AuditLog::new(SecretScanner::default()));
        Self {
            session: Arc::new(Mutex::new(session)),
            workspace: Arc::new(workspace),
            rate_limiter: Arc::new(Mutex::new(RateLimiter::new(
                DEFAULT_RATE_LIMIT_REQUESTS,
                DEFAULT_RATE_LIMIT_WINDOW,
            ))),
            audit: Arc::new(Mutex::new(audit)),
            audit_store: Some(Arc::new(audit_store)),
            approvals: Arc::new(Mutex::new(ApprovalQueue::new())),
            local_control_secret_hash: Arc::new(hash_local_control_secret(&generate_local_control_secret())),
        }
    }

    pub fn local_control_secret_matches(&self, secret: &str) -> bool {
        !secret.is_empty() && *self.local_control_secret_hash == hash_local_control_secret(secret)
    }

    pub fn set_local_control_secret_for_test(&mut self, secret: &str) {
        self.local_control_secret_hash = Arc::new(hash_local_control_secret(secret));
    }
}

#[derive(Debug)]
pub struct RateLimiter {
    max_requests: usize,
    window: Duration,
    accepted_at: VecDeque<Instant>,
}

impl RateLimiter {
    pub fn new(max_requests: usize, window: Duration) -> Self {
        Self {
            max_requests,
            window,
            accepted_at: VecDeque::new(),
        }
    }

    pub fn allow_at(&mut self, now: Instant) -> bool {
        while let Some(oldest) = self.accepted_at.front() {
            if now.saturating_duration_since(*oldest) < self.window {
                break;
            }
            self.accepted_at.pop_front();
        }
        if self.accepted_at.len() >= self.max_requests {
            return false;
        }
        self.accepted_at.push_back(now);
        true
    }

    pub fn allow_now(&mut self) -> bool {
        self.allow_at(Instant::now())
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/status/:request_id", get(status))
        .route("/v1/file/review", post(review_file))
        .route("/v1/session/pause/:request_id", post(pause_session))
        .route("/v1/session/resume/:request_id", post(resume_session))
        .route("/v1/session/disconnect/:request_id", post(disconnect_session))
        .route("/v1/approval/approve/:approval_id/:request_id", post(approve_request))
        .route("/v1/approval/deny/:approval_id/:request_id", post(deny_request))
        .route("/v1/history/export/:request_id", get(export_history))
        .route("/v1/history/delete/:request_id", post(delete_history))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .with_state(state)
}

pub async fn bind_loopback(state: AppState) -> anyhow::Result<SocketAddr> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, router(state)).await;
    });
    Ok(addr)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "service": "vectant-local-support-app",
        "protocol": crate::APP_PROTOCOL_VERSION
    }))
}

async fn status(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    let token = bearer(&headers)?;
    let mut session = state.session.lock().await;
    session
        .validate(token, &request_id)
        .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    let session_state = session.state();
    drop(session);
    let audit = state.audit.lock().await;
    Ok(Json(serde_json::json!({
        "session": session_state,
        "workspace": state.workspace.summary(),
        "history": {
            "events": audit.events(),
            "consent_receipts": audit.consent_receipts(),
            "raw_bodies_included": false
        }
    })))
}

async fn review_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<FileReadRequest>,
) -> Result<Json<FileReadResponse>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        let auth = LocalRequestAuthorization::from_headers(&headers)?;
        validate_file_request_authorization(
            &session,
            state.workspace.as_ref(),
            &request,
            &auth,
            Utc::now(),
        )
        .map_err(|err| denied(StatusCode::FORBIDDEN, err.as_str()))?;
        session
            .validate(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    let local_review = state.workspace.read_file_for_review(&request);
    let response = {
        let mut approvals = state.approvals.lock().await;
        approvals.queue_file_review(request.clone(), local_review)
    };
    let mut audit = state.audit.lock().await;
    let class = if response.decision == "denied" {
        AuditClass::Denied
    } else if response.redactions.is_empty() {
        AuditClass::Data
    } else {
        AuditClass::Redaction
    };
    audit.append(
        class,
        Some(response.request_id.clone()),
        format!(
            "{} {} for {}. {} bytes prepared for local review; {} redactions.",
            response.decision,
            request.capability,
            response.path_display,
            response.bytes_sent,
            response.redactions.len()
        ),
        true,
    );
    persist_audit(&state, &audit)?;
    Ok(Json(response))
}

async fn approve_request(
    State(state): State<AppState>,
    Path((approval_id, request_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<FileReadResponse>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    validate_approval_id(&approval_id)?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }

    let approved = {
        let mut approvals = state.approvals.lock().await;
        approvals.approve_with_secret(
            &approval_id,
            local_approval_secret(&headers)?,
        )
    };
    let Some((response, receipt)) = approved else {
        return Ok(Json(denied_approval_response(&request_id, &approval_id)));
    };
    let mut audit = state.audit.lock().await;
    audit.record_consent(receipt);
    persist_audit(&state, &audit)?;
    Ok(Json(response))
}

async fn deny_request(
    State(state): State<AppState>,
    Path((approval_id, request_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<FileReadResponse>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    validate_approval_id(&approval_id)?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    let denied_pending = {
        let mut approvals = state.approvals.lock().await;
        approvals.deny_with_secret(
            &approval_id,
            local_approval_secret(&headers)?,
        )
    };
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Control,
        Some(request_id.clone()),
        format!("Approval {approval_id} denied locally. Nothing was sent."),
        true,
    );
    persist_audit(&state, &audit)?;
    if denied_pending {
        Ok(Json(denied_approval_response(&request_id, &approval_id)))
    } else {
        Err(denied(StatusCode::NOT_FOUND, "approval_not_pending"))
    }
}

async fn pause_session(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    let token = bearer(&headers)?;
    let mut session = state.session.lock().await;
    session
        .validate(token, &request_id)
        .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    session.pause();
    let session_state = session.state();
    drop(session);
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Control,
        Some(request_id),
        "Session paused by local user. No data can be sent while paused.",
        true,
    );
    persist_audit(&state, &audit)?;
    Ok(Json(serde_json::json!(session_state)))
}

async fn resume_session(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    control_session(state, request_id, headers, SessionAction::Resume).await
}

async fn disconnect_session(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    control_session(state, request_id, headers, SessionAction::Disconnect).await
}

#[derive(Clone, Copy)]
enum SessionAction {
    Resume,
    Disconnect,
}

async fn control_session(
    state: AppState,
    request_id: String,
    headers: HeaderMap,
    action: SessionAction,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    let token = bearer(&headers)?;
    let mut session = state.session.lock().await;
    session
        .validate_control(token, &request_id)
        .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    match action {
        SessionAction::Resume => session.resume(),
        SessionAction::Disconnect => {
            session.disconnect();
            state.approvals.lock().await.revoke_all();
        }
    }
    let session_state = session.state();
    drop(session);
    let summary = match action {
        SessionAction::Resume => "Session resumed by local user.",
        SessionAction::Disconnect => "Session disconnected by local user. Approvals and ports must be revoked.",
    };
    let mut audit = state.audit.lock().await;
    audit.append(AuditClass::Control, Some(request_id), summary, true);
    persist_audit(&state, &audit)?;
    Ok(Json(serde_json::json!(session_state)))
}

async fn export_history(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AuditExport>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Control,
        Some(request_id),
        "Scrubbed local support history exported. Raw bodies were not included.",
        true,
    );
    persist_audit(&state, &audit)?;
    Ok(Json(audit.export_incident_bundle(30)))
}

async fn delete_history(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    let mut audit = state.audit.lock().await;
    state.approvals.lock().await.revoke_all();
    audit.clear();
    audit.append(
        AuditClass::Control,
        Some(request_id),
        "Local support history deleted according to retention policy.",
        true,
    );
    if let Some(store) = &state.audit_store {
        store
            .delete()
            .map_err(|_| denied(StatusCode::INTERNAL_SERVER_ERROR, "audit_store_delete_failed"))?;
    }
    Ok(Json(serde_json::json!({
        "decision": "deleted",
        "request_id": request_id,
        "raw_bodies_included": false,
        "bytes_sent": 0
    })))
}

fn persist_audit(
    state: &AppState,
    audit: &AuditLog,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if let Some(store) = &state.audit_store {
        store
            .persist(audit)
            .map_err(|_| denied(StatusCode::INTERNAL_SERVER_ERROR, "audit_store_persist_failed"))?;
    }
    Ok(())
}

async fn enforce_rate_limit(state: &AppState) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let mut limiter = state.rate_limiter.lock().await;
    if limiter.allow_now() {
        Ok(())
    } else {
        Err(denied(StatusCode::TOO_MANY_REQUESTS, "rate_limit_exceeded"))
    }
}

fn validate_headers(headers: &HeaderMap) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if origin != "https://beta.vectant.dev" && origin != "https://app.vectant.dev" {
        return Err(denied(StatusCode::FORBIDDEN, "bad_origin"));
    }
    let fetch_site = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("same-origin");
    if matches!(fetch_site, "cross-site" | "none") {
        return Err(denied(StatusCode::FORBIDDEN, "bad_fetch_metadata"));
    }
    let csrf = headers
        .get("x-vectant-csrf")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if csrf.len() < 24 {
        return Err(denied(StatusCode::FORBIDDEN, "missing_csrf"));
    }
    Ok(())
}

fn bearer(headers: &HeaderMap) -> Result<&str, (StatusCode, Json<serde_json::Value>)> {
    let auth = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| denied(StatusCode::UNAUTHORIZED, "missing_bearer"))?;
    auth.strip_prefix("Bearer ")
        .ok_or_else(|| denied(StatusCode::UNAUTHORIZED, "missing_bearer"))
}

fn local_approval_secret(headers: &HeaderMap) -> Result<&str, (StatusCode, Json<serde_json::Value>)> {
    headers
        .get("x-vectant-local-approval-secret")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() >= 32 && value.len() <= 128)
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "local_user_approval_required"))
}

fn validate_approval_id(approval_id: &str) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if is_safe_approval_id(approval_id) {
        Ok(())
    } else {
        Err(denied(StatusCode::BAD_REQUEST, "invalid_approval_id"))
    }
}

fn require_local_control_secret(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let secret = headers
        .get("x-vectant-local-control-secret")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() >= 32 && value.len() <= 128)
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "local_user_control_required"))?;
    if state.local_control_secret_matches(secret) {
        Ok(())
    } else {
        Err(denied(StatusCode::FORBIDDEN, "local_user_control_required"))
    }
}

fn generate_local_control_secret() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(48)
        .map(char::from)
        .collect()
}

fn hash_local_control_secret(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vectant-local-support-local-control-secret:");
    hasher.update(value.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRequestAuthorization {
    pub app_version: String,
    pub protocol_version: String,
    pub policy_version: String,
    pub device_fingerprint: String,
    pub device_proof: String,
}

impl LocalRequestAuthorization {
    pub fn from_headers(headers: &HeaderMap) -> Result<Self, (StatusCode, Json<serde_json::Value>)> {
        Ok(Self {
            app_version: required_header(headers, "x-vectant-app-version")?.to_string(),
            protocol_version: required_header(headers, "x-vectant-protocol-version")?.to_string(),
            policy_version: required_header(headers, "x-vectant-policy-version")?.to_string(),
            device_fingerprint: required_header(headers, "x-vectant-device-fingerprint")?.to_string(),
            device_proof: required_header(headers, "x-vectant-device-proof")?.to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalAuthorizationError {
    SessionMismatch,
    AccountMismatch,
    OrgMismatch,
    WorkspaceMismatch,
    ExpiredRequest,
    InvalidRequestExpiry,
    AppVersionTooOld,
    AppVersionBlocked,
    ProtocolVersionMismatch,
    PolicyVersionMismatch,
    DeviceMismatch,
    DeviceProofInvalid,
}

impl LocalAuthorizationError {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SessionMismatch => "session_mismatch",
            Self::AccountMismatch => "account_mismatch",
            Self::OrgMismatch => "org_mismatch",
            Self::WorkspaceMismatch => "workspace_mismatch",
            Self::ExpiredRequest => "expired_request",
            Self::InvalidRequestExpiry => "invalid_request_expiry",
            Self::AppVersionTooOld => "app_version_too_old",
            Self::AppVersionBlocked => "app_version_blocked",
            Self::ProtocolVersionMismatch => "protocol_version_mismatch",
            Self::PolicyVersionMismatch => "policy_version_mismatch",
            Self::DeviceMismatch => "device_mismatch",
            Self::DeviceProofInvalid => "device_proof_invalid",
        }
    }
}

pub fn validate_file_request_authorization(
    session: &SessionGuard,
    workspace: &WorkspacePolicy,
    request: &FileReadRequest,
    auth: &LocalRequestAuthorization,
    now: DateTime<Utc>,
) -> Result<(), LocalAuthorizationError> {
    if request.session_id != session.session_id() {
        return Err(LocalAuthorizationError::SessionMismatch);
    }
    if request.account_id != session.account_id() {
        return Err(LocalAuthorizationError::AccountMismatch);
    }
    if request.org_id != session.org_id() {
        return Err(LocalAuthorizationError::OrgMismatch);
    }
    if request.workspace_id != session.workspace_id() || request.workspace_id != workspace.workspace_id() {
        return Err(LocalAuthorizationError::WorkspaceMismatch);
    }
    if request.device_fingerprint != auth.device_fingerprint {
        return Err(LocalAuthorizationError::DeviceMismatch);
    }
    let expires_at = DateTime::parse_from_rfc3339(&request.expires_at)
        .map_err(|_| LocalAuthorizationError::InvalidRequestExpiry)?
        .with_timezone(&Utc);
    if expires_at <= now {
        return Err(LocalAuthorizationError::ExpiredRequest);
    }
    if compare_versions(&auth.app_version, MIN_APP_VERSION) < 0 {
        return Err(LocalAuthorizationError::AppVersionTooOld);
    }
    if VULNERABLE_APP_VERSIONS
        .iter()
        .any(|version| *version == auth.app_version)
    {
        return Err(LocalAuthorizationError::AppVersionBlocked);
    }
    if auth.protocol_version != crate::APP_PROTOCOL_VERSION {
        return Err(LocalAuthorizationError::ProtocolVersionMismatch);
    }
    if auth.policy_version != crate::POLICY_VERSION {
        return Err(LocalAuthorizationError::PolicyVersionMismatch);
    }
    if !is_sha256_hex(&auth.device_fingerprint, 16) {
        return Err(LocalAuthorizationError::DeviceMismatch);
    }
    if !is_sha256_hex(&auth.device_proof, 64) {
        return Err(LocalAuthorizationError::DeviceProofInvalid);
    }
    if auth.device_fingerprint != session.device_fingerprint() {
        return Err(LocalAuthorizationError::DeviceMismatch);
    }
    if auth.device_proof
        != session.request_device_proof_for_context(
            &request.request_id,
            &request.account_id,
            &request.org_id,
            &request.workspace_id,
            &request.capability,
            &request.actor,
            &request.expires_at,
            &auth.protocol_version,
            &auth.policy_version,
        )
    {
        return Err(LocalAuthorizationError::DeviceProofInvalid);
    }
    Ok(())
}

fn is_sha256_hex(value: &str, hex_len: usize) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == hex_len && digest.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn required_header<'a>(
    headers: &'a HeaderMap,
    name: &str,
) -> Result<&'a str, (StatusCode, Json<serde_json::Value>)> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, format!("missing_{name}")))
}

fn compare_versions(left: &str, right: &str) -> i8 {
    let left_parts = parse_version(left);
    let right_parts = parse_version(right);
    for index in 0..left_parts.len().max(right_parts.len()) {
        let left_value = *left_parts.get(index).unwrap_or(&0);
        let right_value = *right_parts.get(index).unwrap_or(&0);
        if left_value > right_value {
            return 1;
        }
        if left_value < right_value {
            return -1;
        }
    }
    0
}

fn parse_version(value: &str) -> Vec<u32> {
    value
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

fn denied(status: StatusCode, reason: impl ToString) -> (StatusCode, Json<serde_json::Value>) {
    (
        status,
        Json(serde_json::json!({
            "decision": "denied",
            "reason": reason.to_string(),
            "bytes_sent": 0
        })),
    )
}
