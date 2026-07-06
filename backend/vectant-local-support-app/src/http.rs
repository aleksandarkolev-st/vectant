use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::DefaultBodyLimit;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio::sync::Mutex;

use crate::session::SessionGuard;
use crate::workspace::{FileReadRequest, FileReadResponse, WorkspacePolicy};
use crate::audit::{AuditClass, AuditExport, AuditLog};
use crate::scanner::SecretScanner;

pub const MAX_JSON_BODY_BYTES: usize = 256 * 1024;
pub const DEFAULT_RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);
pub const DEFAULT_RATE_LIMIT_REQUESTS: usize = 120;

#[derive(Clone)]
pub struct AppState {
    pub session: Arc<Mutex<SessionGuard>>,
    pub workspace: Arc<WorkspacePolicy>,
    pub rate_limiter: Arc<Mutex<RateLimiter>>,
    pub audit: Arc<Mutex<AuditLog>>,
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
        }
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
        "workspace": {
            "workspace_id": state.workspace.workspace_id(),
            "root": state.workspace.root_display(),
            "policy_version": crate::POLICY_VERSION,
            "scanner_version": crate::SCANNER_VERSION
        },
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
        session
            .validate(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    let response = state.workspace.read_file_for_review(&request);
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
    Ok(Json(response))
}

async fn pause_session(
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
    session.pause();
    let session_state = session.state();
    drop(session);
    state.audit.lock().await.append(
        AuditClass::Control,
        Some(request_id),
        "Session paused by local user. No data can be sent while paused.",
        true,
    );
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
    let token = bearer(&headers)?;
    let mut session = state.session.lock().await;
    session
        .validate_control(token, &request_id)
        .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    match action {
        SessionAction::Resume => session.resume(),
        SessionAction::Disconnect => session.disconnect(),
    }
    let session_state = session.state();
    drop(session);
    let summary = match action {
        SessionAction::Resume => "Session resumed by local user.",
        SessionAction::Disconnect => "Session disconnected by local user. Approvals and ports must be revoked.",
    };
    state.audit.lock().await.append(AuditClass::Control, Some(request_id), summary, true);
    Ok(Json(serde_json::json!(session_state)))
}

async fn export_history(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<AuditExport>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
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
    Ok(Json(audit.export_incident_bundle(30)))
}

async fn delete_history(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    let mut audit = state.audit.lock().await;
    audit.clear();
    audit.append(
        AuditClass::Control,
        Some(request_id),
        "Local support history deleted according to retention policy.",
        true,
    );
    Ok(Json(serde_json::json!({
        "decision": "deleted",
        "request_id": request_id,
        "raw_bodies_included": false,
        "bytes_sent": 0
    })))
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
