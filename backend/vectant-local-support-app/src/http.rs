use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use tokio::sync::Mutex;

use crate::session::SessionGuard;
use crate::workspace::{FileReadRequest, FileReadResponse, WorkspacePolicy};

#[derive(Clone)]
pub struct AppState {
    pub session: Arc<Mutex<SessionGuard>>,
    pub workspace: Arc<WorkspacePolicy>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/status/:request_id", get(status))
        .route("/v1/file/review", post(review_file))
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
    let token = bearer(&headers)?;
    let mut session = state.session.lock().await;
    session
        .validate(token, &request_id)
        .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    Ok(Json(serde_json::json!(session.state())))
}

async fn review_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<FileReadRequest>,
) -> Result<Json<FileReadResponse>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    let token = bearer(&headers)?;
    {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
    }
    Ok(Json(state.workspace.read_file_for_review(&request)))
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
