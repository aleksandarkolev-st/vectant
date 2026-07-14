use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::DefaultBodyLimit;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::Response;
use axum::routing::{any, get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use futures_util::Stream;
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::approval::{denied_approval_response, is_safe_approval_id, ApprovalQueue};
use crate::audit::{AuditClass, AuditExport, AuditLog, AuditStoreError, LocalAuditStore};
use crate::port_adapter::native_listener_identity_matches;
use crate::preview::{
    classify_preview_redirect, decide_preview_request_from_header_list_with_token,
    preview_path_allowed, sanitize_response_headers, target_ip_allowed,
    validate_preview_response_size, PortApproval, PortApprovalOptions, PortApprovalRegistry,
    PreviewDecision, PreviewRedirectDecision, PreviewTrafficGuard, MAX_PREVIEW_RESPONSE_BYTES,
};
use crate::scanner::SecretScanner;
use crate::session::SessionGuard;
use crate::workspace::{FileReadRequest, FileReadResponse, WorkspacePolicy};

pub const MAX_JSON_BODY_BYTES: usize = 256 * 1024;
pub const DEFAULT_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
pub const DEFAULT_RATE_LIMIT_REQUESTS: usize = 120;
pub const MIN_APP_VERSION: &str = "0.1.0";
pub const VULNERABLE_APP_VERSIONS: &[&str] = &["0.0.0", "0.0.1", "0.1.1"];
const ALLOWED_LOCAL_APP_ORIGINS: &[&str] = &[
    "https://beta.vectant.dev",
    "https://app.vectant.dev",
    "https://app.vectant.com",
];

#[derive(Debug, Clone, Deserialize)]
pub struct PortApprovalRequest {
    pub request_id: String,
    pub port: u16,
    pub process_identity: String,
    pub service: Option<String>,
    #[serde(default = "default_target_host")]
    pub target_host: String,
    #[serde(default)]
    pub agent_read_allowed: bool,
    #[serde(default)]
    pub support_agent_read_allowed: bool,
    #[serde(default)]
    pub agent_interact_allowed: bool,
    #[serde(default)]
    pub send_response_body_allowed: bool,
    #[serde(default)]
    pub send_screenshot_allowed: bool,
    #[serde(default)]
    pub send_console_errors_allowed: bool,
    #[serde(default)]
    pub state_changing_methods_allowed: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreviewGatewayQuery {
    pub request_id: String,
    pub preview_token: String,
    pub process_identity: String,
    pub target_query: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortApprovalResponse {
    pub decision: String,
    pub request_id: String,
    pub session_id: String,
    pub port: u16,
    pub target_host: String,
    pub preview_host: String,
    pub browser_preview_allowed: bool,
    pub agent_read_allowed: bool,
    pub support_agent_read_allowed: bool,
    pub agent_interact_allowed: bool,
    pub send_response_body_allowed: bool,
    pub state_changing_methods_allowed: bool,
    pub expires_at: String,
    pub persistent: bool,
    pub process_identity_hash: String,
    pub preview_token_included: bool,
    pub service: Option<String>,
    pub bytes_sent: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortApprovalSummary {
    pub port: u16,
    pub target_host: String,
    pub preview_host: String,
    pub browser_preview_allowed: bool,
    pub agent_read_allowed: bool,
    pub support_agent_read_allowed: bool,
    pub agent_interact_allowed: bool,
    pub send_response_body_allowed: bool,
    pub state_changing_methods_allowed: bool,
    pub expires_at: String,
    pub persistent: bool,
    pub process_identity_hash: String,
    pub preview_token_included: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub session: Arc<Mutex<SessionGuard>>,
    pub workspace: Arc<WorkspacePolicy>,
    pub rate_limiter: Arc<Mutex<RateLimiter>>,
    pub audit: Arc<Mutex<AuditLog>>,
    pub audit_store: Option<Arc<LocalAuditStore>>,
    pub approvals: Arc<Mutex<ApprovalQueue>>,
    pub port_approvals: Arc<Mutex<PortApprovalRegistry>>,
    pub preview_traffic: Arc<Mutex<PreviewTrafficGuard>>,
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
            port_approvals: Arc::new(Mutex::new(PortApprovalRegistry::new())),
            preview_traffic: Arc::new(Mutex::new(PreviewTrafficGuard::new())),
            local_control_secret_hash: Arc::new(hash_local_control_secret(
                &generate_local_control_secret(),
            )),
        }
    }

    pub fn new_with_audit_store(
        session: SessionGuard,
        workspace: WorkspacePolicy,
        audit_store: LocalAuditStore,
    ) -> Result<Self, AuditStoreError> {
        let audit = audit_store.load()?;
        Ok(Self {
            session: Arc::new(Mutex::new(session)),
            workspace: Arc::new(workspace),
            rate_limiter: Arc::new(Mutex::new(RateLimiter::new(
                DEFAULT_RATE_LIMIT_REQUESTS,
                DEFAULT_RATE_LIMIT_WINDOW,
            ))),
            audit: Arc::new(Mutex::new(audit)),
            audit_store: Some(Arc::new(audit_store)),
            approvals: Arc::new(Mutex::new(ApprovalQueue::new())),
            port_approvals: Arc::new(Mutex::new(PortApprovalRegistry::new())),
            preview_traffic: Arc::new(Mutex::new(PreviewTrafficGuard::new())),
            local_control_secret_hash: Arc::new(hash_local_control_secret(
                &generate_local_control_secret(),
            )),
        })
    }

    pub fn local_control_secret_matches(&self, secret: &str) -> bool {
        !secret.is_empty()
            && constant_time_eq(
                self.local_control_secret_hash.as_bytes(),
                hash_local_control_secret(secret).as_bytes(),
            )
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
        .route(
            "/v1/session/fast-support/:request_id",
            post(fast_support_session),
        )
        .route(
            "/v1/session/disconnect/:request_id",
            post(disconnect_session),
        )
        .route(
            "/v1/approval/approve/:approval_id/:request_id",
            post(approve_request),
        )
        .route(
            "/v1/approval/deny/:approval_id/:request_id",
            post(deny_request),
        )
        .route(
            "/v1/approval/revoke-all/:request_id",
            post(revoke_all_approvals),
        )
        .route("/v1/port/approve", post(approve_port))
        .route("/v1/port/revoke/:port/:request_id", post(revoke_port))
        .route("/v1/preview/:port/*path", any(preview_gateway))
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

pub async fn shutdown_cleanup(state: &AppState, request_id: &str) -> anyhow::Result<()> {
    validate_safe_request_id(request_id)
        .map_err(|_| anyhow::anyhow!("invalid shutdown request id"))?;
    let session_id = {
        let mut session = state.session.lock().await;
        let session_id = session.session_id().to_string();
        session.disconnect();
        session_id
    };
    state.approvals.lock().await.revoke_all();
    state
        .port_approvals
        .lock()
        .await
        .disconnect_session(&session_id);
    state.preview_traffic.lock().await.clear_all();
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Control,
        Some(request_id.to_string()),
        "Local app shutdown disconnected the support session. Approvals, ports, and preview streams were revoked.",
        true,
    );
    if let Some(store) = &state.audit_store {
        store.persist(&audit)?;
    }
    Ok(())
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
        .validate_control(token, &request_id)
        .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    let session_state = session.state();
    drop(session);
    let ports = {
        let registry = state.port_approvals.lock().await;
        registry
            .approvals()
            .into_iter()
            .map(|approval| PortApprovalSummary {
                port: approval.port,
                target_host: approval.target_host,
                preview_host: approval.preview_host,
                browser_preview_allowed: approval.browser_preview_allowed,
                agent_read_allowed: approval.agent_read_allowed,
                support_agent_read_allowed: approval.support_agent_read_allowed,
                agent_interact_allowed: approval.agent_interact_allowed,
                send_response_body_allowed: approval.send_response_body_allowed,
                state_changing_methods_allowed: approval.state_changing_methods_allowed,
                expires_at: approval.expires_at,
                persistent: approval.persistent,
                process_identity_hash: approval.process_identity_hash,
                preview_token_included: false,
            })
            .collect::<Vec<_>>()
    };
    let audit = state.audit.lock().await;
    Ok(Json(serde_json::json!({
        "session": session_state,
        "workspace": state.workspace.summary(),
        "ports": ports,
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

    let approval_secret = local_approval_secret(&headers)?.to_string();
    let queued_request = {
        let approvals = state.approvals.lock().await;
        approvals.request_for_approval(&approval_id)
    };
    let Some(queued_request) = queued_request else {
        return Ok(Json(denied_approval_response(&request_id, &approval_id)));
    };
    let current_review = state.workspace.read_file_for_review(&queued_request);
    let approved = {
        let mut approvals = state.approvals.lock().await;
        approvals.approve_with_secret_and_current_review(
            &approval_id,
            &approval_secret,
            current_review,
            chrono::Utc::now(),
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
        approvals.deny_with_secret(&approval_id, local_approval_secret(&headers)?)
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

async fn revoke_all_approvals(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    validate_safe_request_id(&request_id)?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    state.approvals.lock().await.revoke_all();
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Control,
        Some(request_id.clone()),
        "Session approvals revoked locally. Future sends require review.",
        true,
    );
    persist_audit(&state, &audit)?;
    Ok(Json(serde_json::json!({
        "decision": "session_approvals_revoked",
        "request_id": request_id,
        "raw_bodies_included": false,
        "bytes_sent": 0
    })))
}

async fn approve_port(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<PortApprovalRequest>,
) -> Result<Json<PortApprovalResponse>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    validate_port_approval_request(&request)?;
    let token = bearer(&headers)?;
    let session_id = {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        session.session_id().to_string()
    };
    let approval = {
        let mut registry = state.port_approvals.lock().await;
        registry.approve_port_grant(
            &session_id,
            request.port,
            &request.process_identity,
            &request.target_host,
            PortApprovalOptions {
                // The shipped gateway is browser-preview-only. Keep these
                // fields in the wire schema for forward compatibility, but do
                // not let a caller turn on agent reads, body export, or writes.
                ..PortApprovalOptions::default()
            },
        )
    };
    let response = PortApprovalResponse {
        decision: "port_approved".to_string(),
        request_id: request.request_id.clone(),
        session_id,
        port: approval.approval.port,
        target_host: approval.approval.target_host,
        preview_host: approval.approval.preview_host,
        browser_preview_allowed: approval.approval.browser_preview_allowed,
        agent_read_allowed: approval.approval.agent_read_allowed,
        support_agent_read_allowed: approval.approval.support_agent_read_allowed,
        agent_interact_allowed: approval.approval.agent_interact_allowed,
        send_response_body_allowed: approval.approval.send_response_body_allowed,
        state_changing_methods_allowed: approval.approval.state_changing_methods_allowed,
        expires_at: approval.approval.expires_at,
        persistent: approval.approval.persistent,
        process_identity_hash: approval.approval.process_identity_hash,
        preview_token_included: false,
        service: request.service.as_deref().map(scrub_for_audit),
        bytes_sent: 0,
    };
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Preview,
        Some(request.request_id),
        format!(
            "Preview port {} approved for {} as {} with explicit AI/support, interaction, response-body, and state-changing capabilities.",
            response.port, response.target_host, response.preview_host
        ),
        true,
    );
    persist_audit(&state, &audit)?;
    Ok(Json(response))
}

async fn revoke_port(
    State(state): State<AppState>,
    Path((port, request_id)): Path<(u16, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    validate_safe_request_id(&request_id)?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    let revoked = state
        .port_approvals
        .lock()
        .await
        .revoke_port(port)
        .is_some();
    state.preview_traffic.lock().await.clear_all();
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Preview,
        Some(request_id.clone()),
        format!("Port approval for 127.0.0.1:{port} revoked locally. Preview tokens and streams were invalidated."),
        true,
    );
    persist_audit(&state, &audit)?;
    Ok(Json(serde_json::json!({
        "decision": if revoked { "port_revoked" } else { "port_not_approved" },
        "request_id": request_id,
        "port": port,
        "preview_token_included": false,
        "bytes_sent": 0
    })))
}

async fn preview_gateway(
    State(state): State<AppState>,
    Path((port, path)): Path<(u16, String)>,
    Query(query): Query<PreviewGatewayQuery>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response<Body>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    validate_preview_query(&query)?;
    let preview_path = format!("/{}", path.trim_start_matches('/'));
    if !preview_path_allowed(&preview_path) {
        return Err(denied(StatusCode::FORBIDDEN, "service_worker_path_blocked"));
    }
    let preview_host = preview_host_from_headers(&headers)?;
    let token = bearer(&headers)?;
    let session_id = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &query.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        session.session_id().to_string()
    };
    let approval = {
        let registry = state.port_approvals.lock().await;
        registry
            .approval_for(&session_id, port, &query.process_identity)
            .cloned()
    };
    if query.process_identity.starts_with("pid=")
        && !native_listener_identity_matches(port, &query.process_identity)
    {
        state.port_approvals.lock().await.revoke_port(port);
        state.preview_traffic.lock().await.clear_all();
        return Err(denied(
            StatusCode::FORBIDDEN,
            "preview_process_identity_changed",
        ));
    }
    let filtered_headers = preview_validation_headers(&headers);
    match decide_preview_request_from_header_list_with_token(
        approval.as_ref(),
        method.as_str(),
        &preview_host,
        approval
            .as_ref()
            .ok_or_else(|| denied(StatusCode::FORBIDDEN, "port_not_approved"))?
            .target_host
            .parse()
            .map_err(|_| denied(StatusCode::FORBIDDEN, "target_host_invalid"))?,
        &filtered_headers,
        &query.preview_token,
    ) {
        PreviewDecision::Allow => {}
        PreviewDecision::Deny(reason) => return Err(denied(StatusCode::FORBIDDEN, reason)),
    }
    let Some(approval) = approval else {
        return Err(denied(StatusCode::FORBIDDEN, "port_not_approved"));
    };
    {
        let mut traffic = state.preview_traffic.lock().await;
        let now = Utc::now().timestamp().try_into().unwrap_or_default();
        if !traffic.allow_request_at(&approval.preview_host, now) {
            return Err(denied(
                StatusCode::TOO_MANY_REQUESTS,
                "preview_rate_limit_exceeded",
            ));
        }
        if !traffic.begin_stream(&approval.preview_host) {
            return Err(denied(
                StatusCode::TOO_MANY_REQUESTS,
                "preview_stream_limit_exceeded",
            ));
        }
    }
    let target_url = preview_target_url(
        &approval.target_host,
        port,
        &preview_path,
        query.target_query.as_deref(),
    )?;
    let stream_lease =
        PreviewStreamLease::new(state.preview_traffic.clone(), approval.preview_host.clone());
    fetch_preview_response(
        &method,
        &target_url,
        &approval,
        &preview_path,
        body,
        stream_lease,
    )
    .await
}

async fn fetch_preview_response(
    method: &Method,
    target_url: &str,
    approval: &PortApproval,
    preview_path: &str,
    request_body: Bytes,
    stream_lease: PreviewStreamLease,
) -> Result<Response<Body>, (StatusCode, Json<serde_json::Value>)> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| denied(StatusCode::BAD_GATEWAY, "preview_client_unavailable"))?;
    let reqwest_method = reqwest::Method::from_bytes(method.as_str().as_bytes())
        .map_err(|_| denied(StatusCode::FORBIDDEN, "invalid_method_blocked"))?;
    let response = client
        .request(reqwest_method, target_url)
        .header(reqwest::header::HOST, &approval.target_host)
        .body(request_body)
        .send()
        .await
        .map_err(|_| denied(StatusCode::BAD_GATEWAY, "preview_target_unreachable"))?;
    validate_preview_response_size(response.content_length(), 0)
        .map_err(|reason| denied(StatusCode::PAYLOAD_TOO_LARGE, reason))?;
    let status = StatusCode::from_u16(response.status().as_u16())
        .map_err(|_| denied(StatusCode::BAD_GATEWAY, "preview_status_invalid"))?;
    let response_headers = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect::<std::collections::HashMap<_, _>>();
    if status.is_redirection() {
        if let Some(location) = response_headers.get("location") {
            return preview_redirect_response(approval, preview_path, location, status);
        }
    }
    let body = if *method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(CappedPreviewBodyStream::new(
            response.bytes_stream(),
            stream_lease,
        ))
    };
    let mut builder = Response::builder().status(status);
    for (name, value) in sanitize_response_headers(&response_headers) {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            builder = builder.header(name, value);
        }
    }
    builder
        .body(body)
        .map_err(|_| denied(StatusCode::BAD_GATEWAY, "preview_response_build_failed"))
}

struct PreviewStreamLease {
    traffic: Arc<Mutex<PreviewTrafficGuard>>,
    preview_host: String,
}

impl PreviewStreamLease {
    fn new(traffic: Arc<Mutex<PreviewTrafficGuard>>, preview_host: String) -> Self {
        Self {
            traffic,
            preview_host,
        }
    }
}

impl Drop for PreviewStreamLease {
    fn drop(&mut self) {
        let traffic = self.traffic.clone();
        let preview_host = self.preview_host.clone();
        tokio::spawn(async move {
            traffic.lock().await.end_stream(&preview_host);
        });
    }
}

struct CappedPreviewBodyStream<S> {
    inner: Pin<Box<S>>,
    bytes_seen: u64,
    terminated: bool,
    _lease: PreviewStreamLease,
}

impl<S> CappedPreviewBodyStream<S> {
    fn new(inner: S, lease: PreviewStreamLease) -> Self {
        Self {
            inner: Box::pin(inner),
            bytes_seen: 0,
            terminated: false,
            _lease: lease,
        }
    }
}

impl<S, E> Stream for CappedPreviewBodyStream<S>
where
    S: Stream<Item = Result<Bytes, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    type Item = Result<Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.terminated {
            return Poll::Ready(None);
        }
        match self.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(bytes))) => {
                self.bytes_seen = self.bytes_seen.saturating_add(bytes.len() as u64);
                if self.bytes_seen > MAX_PREVIEW_RESPONSE_BYTES {
                    self.terminated = true;
                    return Poll::Ready(Some(Err(std::io::Error::other(
                        "preview_response_too_large",
                    ))));
                }
                Poll::Ready(Some(Ok(bytes)))
            }
            Poll::Ready(Some(Err(_))) => {
                self.terminated = true;
                Poll::Ready(Some(Err(std::io::Error::other(
                    "preview_target_read_failed",
                ))))
            }
            Poll::Ready(None) => {
                self.terminated = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

fn preview_redirect_response(
    approval: &PortApproval,
    preview_path: &str,
    location: &str,
    status: StatusCode,
) -> Result<Response<Body>, (StatusCode, Json<serde_json::Value>)> {
    match classify_preview_redirect(approval, preview_path, location) {
        PreviewRedirectDecision::RewriteToPreview(path) => Response::builder()
            .status(status)
            .header("location", path)
            .body(Body::empty())
            .map_err(|_| denied(StatusCode::BAD_GATEWAY, "preview_response_build_failed")),
        PreviewRedirectDecision::ExternalNavigation(url) => Response::builder()
            .status(status)
            .header("location", url)
            .body(Body::empty())
            .map_err(|_| denied(StatusCode::BAD_GATEWAY, "preview_response_build_failed")),
        PreviewRedirectDecision::Block(reason) => Err(denied(StatusCode::FORBIDDEN, reason)),
    }
}

fn validate_preview_query(
    query: &PreviewGatewayQuery,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    validate_safe_request_id(&query.request_id)?;
    if !is_safe_header_token(&query.preview_token, 32, 128) {
        return Err(denied(StatusCode::FORBIDDEN, "preview_token_invalid"));
    }
    if !is_safe_process_identity(&query.process_identity) {
        return Err(denied(StatusCode::BAD_REQUEST, "invalid_process_identity"));
    }
    if let Some(target_query) = &query.target_query {
        if target_query.len() > 2048
            || target_query
                .chars()
                .any(|ch| ch.is_control() || matches!(ch, '#' | '\\'))
        {
            return Err(denied(
                StatusCode::BAD_REQUEST,
                "invalid_preview_target_query",
            ));
        }
    }
    Ok(())
}

fn preview_host_from_headers(
    headers: &HeaderMap,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let authority = headers
        .get("x-vectant-preview-host")
        .or_else(|| headers.get("host"))
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .parse::<axum::http::uri::Authority>()
        .map_err(|_| denied(StatusCode::FORBIDDEN, "preview_host_invalid"))?;
    let host = authority.host();
    if host.len() > 160
        || !host.ends_with(".vectant-preview.dev")
        || host
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\' | '@'))
    {
        return Err(denied(StatusCode::FORBIDDEN, "preview_host_invalid"));
    }
    Ok(host.to_string())
}

fn preview_validation_headers(headers: &HeaderMap) -> Vec<(&str, &str)> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            let lower = name.as_str().to_ascii_lowercase();
            if lower.starts_with("sec-fetch-") || lower.starts_with("sec-ch-") {
                return None;
            }
            if matches!(
                lower.as_str(),
                "origin"
                    | "sec-fetch-site"
                    | "x-vectant-csrf"
                    | "authorization"
                    | "x-vectant-local-control-secret"
                    | "x-vectant-local-approval-secret"
                    | "x-vectant-preview-host"
            ) {
                return None;
            }
            value.to_str().ok().map(|value| (name.as_str(), value))
        })
        .collect()
}

fn preview_target_url(
    target_host: &str,
    port: u16,
    preview_path: &str,
    target_query: Option<&str>,
) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    let mut url = format!("http://{target_host}:{port}{preview_path}");
    if let Some(target_query) = target_query.filter(|value| !value.is_empty()) {
        url.push('?');
        url.push_str(target_query.trim_start_matches('?'));
    }
    Ok(url)
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
        .validate_control(token, &request_id)
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

#[derive(Debug, Deserialize)]
struct FastSupportRequest {
    enabled: bool,
}

async fn fast_support_session(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<FastSupportRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    let token = bearer(&headers)?;
    let mut session = state.session.lock().await;
    session
        .validate_control(token, &request_id)
        .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    session.set_fast_support(request.enabled);
    let session_state = session.state();
    drop(session);
    let summary = if request.enabled {
        "Fast Support enabled for this session. Safe metadata only may be automatic; source files and logs remain approval-gated."
    } else {
        "Fast Support disabled. The session returned to Balanced mode."
    };
    let mut audit = state.audit.lock().await;
    audit.append(AuditClass::Control, Some(request_id), summary, true);
    persist_audit(&state, &audit)?;
    Ok(Json(serde_json::json!({
        "decision": "fast_support_updated",
        "user_visible_message": summary,
        "session": session_state,
        "bytes_sent": 0,
        "raw_body_included": false
    })))
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
            let session_id = session.session_id().to_string();
            session.disconnect();
            state.approvals.lock().await.revoke_all();
            state
                .port_approvals
                .lock()
                .await
                .disconnect_session(&session_id);
            state.preview_traffic.lock().await.clear_all();
        }
    }
    let session_state = session.state();
    drop(session);
    let summary = match action {
        SessionAction::Resume => "Session resumed by local user.",
        SessionAction::Disconnect => {
            "Session disconnected by local user. Approvals and ports must be revoked."
        }
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
    state.port_approvals.lock().await.revoke_all();
    state.preview_traffic.lock().await.clear_all();
    audit.clear();
    audit.append(
        AuditClass::Control,
        Some(request_id.clone()),
        "Local support history deleted according to retention policy.",
        true,
    );
    persist_audit(&state, &audit)?;
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
        store.persist(audit).map_err(|_| {
            denied(
                StatusCode::INTERNAL_SERVER_ERROR,
                "audit_store_persist_failed",
            )
        })?;
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
    if !ALLOWED_LOCAL_APP_ORIGINS.contains(&origin) {
        return Err(denied(StatusCode::FORBIDDEN, "bad_origin"));
    }
    let fetch_site = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !matches!(fetch_site, "same-origin" | "same-site") {
        return Err(denied(StatusCode::FORBIDDEN, "bad_fetch_metadata"));
    }
    let csrf = headers
        .get("x-vectant-csrf")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !is_safe_header_token(csrf, 24, 128) {
        return Err(denied(StatusCode::FORBIDDEN, "missing_csrf"));
    }
    Ok(())
}

fn bearer(headers: &HeaderMap) -> Result<&str, (StatusCode, Json<serde_json::Value>)> {
    let auth = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| denied(StatusCode::UNAUTHORIZED, "missing_bearer"))?;
    let token = auth
        .strip_prefix("Bearer ")
        .ok_or_else(|| denied(StatusCode::UNAUTHORIZED, "missing_bearer"))?;
    if is_safe_header_token(token, 32, 128) {
        Ok(token)
    } else {
        Err(denied(StatusCode::UNAUTHORIZED, "invalid_bearer"))
    }
}

fn local_approval_secret(
    headers: &HeaderMap,
) -> Result<&str, (StatusCode, Json<serde_json::Value>)> {
    headers
        .get("x-vectant-local-approval-secret")
        .and_then(|value| value.to_str().ok())
        .filter(|value| is_safe_header_token(value, 32, 128))
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "local_user_approval_required"))
}

fn validate_approval_id(approval_id: &str) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if is_safe_approval_id(approval_id) {
        Ok(())
    } else {
        Err(denied(StatusCode::BAD_REQUEST, "invalid_approval_id"))
    }
}

fn validate_port_approval_request(
    request: &PortApprovalRequest,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    validate_safe_request_id(&request.request_id)?;
    if request.port == 0 {
        return Err(denied(StatusCode::BAD_REQUEST, "invalid_port"));
    }
    let target_ip = request
        .target_host
        .parse::<std::net::IpAddr>()
        .map_err(|_| denied(StatusCode::BAD_REQUEST, "invalid_target_host"))?;
    if !target_ip_allowed(target_ip) {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "target_host_not_private_or_loopback",
        ));
    }
    if !is_safe_process_identity(&request.process_identity) {
        return Err(denied(StatusCode::BAD_REQUEST, "invalid_process_identity"));
    }
    if let Some(service) = &request.service {
        if service.len() > 80 || service.chars().any(|ch| ch.is_control()) {
            return Err(denied(StatusCode::BAD_REQUEST, "invalid_service"));
        }
    }
    Ok(())
}

fn default_target_host() -> String {
    "127.0.0.1".to_string()
}

fn validate_safe_request_id(request_id: &str) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    if safe_authorization_field(request_id, 3, 128) {
        Ok(())
    } else {
        Err(denied(StatusCode::BAD_REQUEST, "invalid_request_id"))
    }
}

fn is_safe_process_identity(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(|ch| ch.is_control())
}

fn scrub_for_audit(value: &str) -> String {
    SecretScanner::default().redact(value, &SecretScanner::default().scan(value))
}

fn require_local_control_secret(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let secret = headers
        .get("x-vectant-local-control-secret")
        .and_then(|value| value.to_str().ok())
        .filter(|value| is_safe_header_token(value, 32, 128))
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

fn is_safe_header_token(value: &str, min_len: usize, max_len: usize) -> bool {
    value.len() >= min_len
        && value.len() <= max_len
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
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
    pub fn from_headers(
        headers: &HeaderMap,
    ) -> Result<Self, (StatusCode, Json<serde_json::Value>)> {
        let app_version = required_header(headers, "x-vectant-app-version")?;
        if !is_semver_like(app_version) {
            return Err(invalid_header("x-vectant-app-version"));
        }
        let protocol_version = required_header(headers, "x-vectant-protocol-version")?;
        if !is_safe_header_token(protocol_version, 3, 64) {
            return Err(invalid_header("x-vectant-protocol-version"));
        }
        let policy_version = required_header(headers, "x-vectant-policy-version")?;
        if !is_safe_header_token(policy_version, 3, 64) {
            return Err(invalid_header("x-vectant-policy-version"));
        }
        let device_fingerprint = required_header(headers, "x-vectant-device-fingerprint")?;
        if !is_sha256_hex(device_fingerprint, 16) {
            return Err(invalid_header("x-vectant-device-fingerprint"));
        }
        let device_proof = required_header(headers, "x-vectant-device-proof")?;
        if !is_sha256_hex(device_proof, 64) {
            return Err(invalid_header("x-vectant-device-proof"));
        }
        Ok(Self {
            app_version: app_version.to_string(),
            protocol_version: protocol_version.to_string(),
            policy_version: policy_version.to_string(),
            device_fingerprint: device_fingerprint.to_string(),
            device_proof: device_proof.to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalAuthorizationError {
    InvalidRequestShape,
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
            Self::InvalidRequestShape => "invalid_request_shape",
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
    if !valid_request_authorization_shape(request) {
        return Err(LocalAuthorizationError::InvalidRequestShape);
    }
    if request.session_id != session.session_id() {
        return Err(LocalAuthorizationError::SessionMismatch);
    }
    if request.account_id != session.account_id() {
        return Err(LocalAuthorizationError::AccountMismatch);
    }
    if request.org_id != session.org_id() {
        return Err(LocalAuthorizationError::OrgMismatch);
    }
    if request.workspace_id != session.workspace_id()
        || request.workspace_id != workspace.workspace_id()
    {
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
        .any(|version| versions_equal(version, &auth.app_version))
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
    let expected_device_proof =
        session.request_device_proof_for_context(&crate::session::DeviceProofContext {
            request_id: &request.request_id,
            account_id: &request.account_id,
            org_id: &request.org_id,
            workspace_id: &request.workspace_id,
            capability: &request.capability,
            actor: &request.actor,
            expires_at: &request.expires_at,
            protocol_version: &auth.protocol_version,
            policy_version: &auth.policy_version,
        });
    if !constant_time_eq(
        auth.device_proof.as_bytes(),
        expected_device_proof.as_bytes(),
    ) {
        return Err(LocalAuthorizationError::DeviceProofInvalid);
    }
    Ok(())
}

fn valid_request_authorization_shape(request: &FileReadRequest) -> bool {
    safe_authorization_field(&request.request_id, 3, 128)
        && safe_authorization_field(&request.session_id, 3, 128)
        && safe_authorization_field(&request.account_id, 3, 128)
        && safe_authorization_field(&request.org_id, 3, 128)
        && safe_authorization_field(&request.workspace_id, 3, 128)
        && safe_authorization_field(&request.capability, 3, 128)
        && safe_authorization_field(&request.actor, 3, 128)
        && safe_authorization_field(&request.expires_at, 10, 64)
}

fn safe_authorization_field(value: &str, min_len: usize, max_len: usize) -> bool {
    value.len() >= min_len
        && value.len() <= max_len
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':' | '+'))
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

fn invalid_header(name: &str) -> (StatusCode, Json<serde_json::Value>) {
    denied(StatusCode::FORBIDDEN, format!("invalid_{name}"))
}

fn is_semver_like(value: &str) -> bool {
    let parts = value.split('.').collect::<Vec<_>>();
    !parts.is_empty()
        && parts.len() <= 4
        && value.len() <= 32
        && parts.iter().all(|part| {
            !part.is_empty() && part.len() <= 8 && part.chars().all(|ch| ch.is_ascii_digit())
        })
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

fn versions_equal(left: &str, right: &str) -> bool {
    compare_versions(left, right) == 0
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

#[cfg(test)]
mod tests {
    use super::validate_headers;
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn accepts_the_production_app_origin_without_broadening_cross_site_access() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "origin",
            HeaderValue::from_static("https://app.vectant.com"),
        );
        headers.insert("sec-fetch-site", HeaderValue::from_static("same-site"));
        headers.insert(
            "x-vectant-csrf",
            HeaderValue::from_static("csrf_token_12345678901234567890"),
        );
        assert!(validate_headers(&headers).is_ok());

        headers.insert("origin", HeaderValue::from_static("https://evil.example"));
        assert!(validate_headers(&headers).is_err());
    }
}
