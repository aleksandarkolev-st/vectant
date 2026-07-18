use std::collections::{BTreeSet, VecDeque};
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
use futures_util::{Stream, StreamExt};
use rand::{distributions::Alphanumeric, Rng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::approval::{denied_approval_response, is_safe_approval_id, ApprovalQueue};
use crate::audit::{AuditClass, AuditExport, AuditLog, AuditStoreError, LocalAuditStore};
use crate::command_broker::{execute_command_cancellable, CommandRequest};
use crate::full_access::{
    authorize as authorize_full_access, validate_graph_request, FullAccessConsentReceipt,
    FullAccessDenied, FullAccessPolicy, FullAccessState, GraphRequest, ReceiptBinding,
};
use crate::mutation::{MutationRequest, WorkspaceMutationBroker};
use crate::port_adapter::{detect_loopback_listener, native_listener_identity_matches};
use crate::preview::{
    classify_preview_redirect, decide_preview_request_from_header_list_with_token,
    preview_path_allowed, sanitize_response_headers, target_ip_allowed,
    validate_preview_response_size, PortApproval, PortApprovalOptions, PortApprovalRegistry,
    PreviewDecision, PreviewRedirectDecision, PreviewTrafficGuard, MAX_PREVIEW_RESPONSE_BYTES,
};
use crate::process_adapter::ProcessInspectionAdapter;
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

#[derive(Debug, Clone, Deserialize)]
pub struct FullAccessEnrollmentRequest {
    pub request_id: String,
    pub policy: FullAccessPolicy,
    pub receipt: FullAccessConsentReceipt,
}

#[derive(Debug, Clone, Serialize)]
pub struct FullAccessGraphResponse {
    pub request_id: String,
    pub decision: String,
    pub graph_nodes: Vec<crate::full_access::GraphNode>,
    pub raw_bodies_included: bool,
    pub bytes_sent: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct FullAccessNodeResponse {
    pub request_id: String,
    pub decision: String,
    pub node_id: String,
    pub content_sha256: Option<String>,
    pub content: Option<String>,
    pub bytes_sent: usize,
    pub redaction_count: usize,
    pub raw_bodies_included: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FullAccessRevertRequest {
    pub request_id: String,
    pub transaction_id: String,
    pub current_content_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FullAccessPortUseRequest {
    pub request_id: String,
    pub port: u16,
    pub expected_process_identity_hash: String,
    pub path: String,
    pub max_response_bytes: usize,
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
    pub full_access: Arc<Mutex<FullAccessState>>,
    // An empty ceiling is the startup default. The desktop replaces it only
    // after successfully parsing cloud policy, so policy-fetch races fail closed.
    pub cloud_full_access_capabilities:
        Arc<Mutex<Option<BTreeSet<crate::full_access::FullAccessCapability>>>>,
    pub mutation_broker: Arc<Mutex<WorkspaceMutationBroker>>,
    local_control_secret_hash: Arc<String>,
}

impl AppState {
    pub fn new(session: SessionGuard, workspace: WorkspacePolicy) -> Self {
        let workspace = Arc::new(workspace);
        Self {
            session: Arc::new(Mutex::new(session)),
            workspace: workspace.clone(),
            rate_limiter: Arc::new(Mutex::new(RateLimiter::new(
                DEFAULT_RATE_LIMIT_REQUESTS,
                DEFAULT_RATE_LIMIT_WINDOW,
            ))),
            audit: Arc::new(Mutex::new(AuditLog::new(SecretScanner::default()))),
            audit_store: None,
            approvals: Arc::new(Mutex::new(ApprovalQueue::new())),
            port_approvals: Arc::new(Mutex::new(PortApprovalRegistry::new())),
            preview_traffic: Arc::new(Mutex::new(PreviewTrafficGuard::new())),
            full_access: Arc::new(Mutex::new(FullAccessState::default())),
            cloud_full_access_capabilities: Arc::new(Mutex::new(Some(BTreeSet::new()))),
            mutation_broker: Arc::new(Mutex::new(WorkspaceMutationBroker::new(
                workspace.as_ref().clone(),
                chrono::Duration::hours(24),
            ))),
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
        let workspace = Arc::new(workspace);
        Ok(Self {
            session: Arc::new(Mutex::new(session)),
            workspace: workspace.clone(),
            rate_limiter: Arc::new(Mutex::new(RateLimiter::new(
                DEFAULT_RATE_LIMIT_REQUESTS,
                DEFAULT_RATE_LIMIT_WINDOW,
            ))),
            audit: Arc::new(Mutex::new(audit)),
            audit_store: Some(Arc::new(audit_store)),
            approvals: Arc::new(Mutex::new(ApprovalQueue::new())),
            port_approvals: Arc::new(Mutex::new(PortApprovalRegistry::new())),
            preview_traffic: Arc::new(Mutex::new(PreviewTrafficGuard::new())),
            full_access: Arc::new(Mutex::new(FullAccessState::default())),
            cloud_full_access_capabilities: Arc::new(Mutex::new(Some(BTreeSet::new()))),
            mutation_broker: Arc::new(Mutex::new(WorkspaceMutationBroker::new(
                workspace.as_ref().clone(),
                chrono::Duration::hours(24),
            ))),
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

    pub async fn set_cloud_full_access_capabilities(
        &self,
        capabilities: BTreeSet<crate::full_access::FullAccessCapability>,
    ) {
        *self.cloud_full_access_capabilities.lock().await = Some(capabilities.clone());
        let mut full_access = self.full_access.lock().await;
        full_access.policy.allowed_capabilities = full_access
            .policy
            .allowed_capabilities
            .intersection(&capabilities)
            .cloned()
            .collect();
        if full_access
            .receipt
            .as_ref()
            .is_some_and(|receipt| !receipt.capabilities.is_subset(&capabilities))
        {
            full_access.revoke();
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
        .route("/v1/full-access/enroll", post(enroll_full_access))
        .route("/v1/full-access/graph/:request_id", get(full_access_graph))
        .route("/v1/full-access/graph/node", post(full_access_graph_node))
        .route("/v1/full-access/mutation", post(full_access_mutation))
        .route("/v1/full-access/command", post(full_access_command))
        .route(
            "/v1/full-access/port/discover/:port/:request_id",
            get(full_access_port_discover),
        )
        .route("/v1/full-access/port/use", post(full_access_port_use))
        .route("/v1/full-access/mutation/revert", post(full_access_revert))
        .route(
            "/v1/full-access/processes/:request_id",
            get(full_access_processes),
        )
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
    state.full_access.lock().await.revoke();
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

async fn enroll_full_access(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<FullAccessEnrollmentRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    require_local_control_secret(&state, &headers)?;
    validate_safe_request_id(&request.request_id)?;
    if request.receipt.local_confirmation != "native_button"
        || !request
            .receipt
            .capabilities
            .contains(&crate::full_access::FullAccessCapability::Enroll)
    {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "full_access_requires_local_enrollment_confirmation",
        ));
    }
    let token = bearer(&headers)?;
    let auth = LocalRequestAuthorization::from_headers(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint, device_proof_valid) = {
        let mut session = state.session.lock().await;
        session
            .validate_control(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        let receipt_expires_at = request.receipt.expires_at.to_rfc3339();
        let expected_device_proof =
            session.request_device_proof_for_context(&crate::session::DeviceProofContext {
                request_id: &request.request_id,
                account_id: session.account_id(),
                org_id: session.org_id(),
                workspace_id: session.workspace_id(),
                capability: "full_access.enroll",
                actor: &request.receipt.support_actor,
                expires_at: &receipt_expires_at,
                protocol_version: &auth.protocol_version,
                policy_version: &auth.policy_version,
            });
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
            auth.device_fingerprint == session.device_fingerprint()
                && auth.protocol_version == crate::APP_PROTOCOL_VERSION
                && auth.policy_version == crate::POLICY_VERSION
                && constant_time_eq(
                    auth.device_proof.as_bytes(),
                    expected_device_proof.as_bytes(),
                ),
        )
    };
    if !device_proof_valid {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "full_access_device_proof_invalid",
        ));
    }
    let workspace_hash = state.workspace.summary().root_hash;
    if request.receipt.session_id != session_id
        || request.receipt.account_id != account_id
        || request.receipt.organization_id != org_id
        || request.receipt.device_fingerprint != device_fingerprint
        || request.receipt.workspace_hash != workspace_hash
        || request.receipt.app_version != auth.app_version
        || request.receipt.policy_version != crate::POLICY_VERSION
        || request.receipt.scanner_version != crate::SCANNER_VERSION
        || request.receipt.policy_major != request.policy.policy_major
        || request.receipt.reconsent_version != request.policy.mandatory_reconsent_version
        || !request.policy.organization_enabled
        || request.policy.emergency_paused
    {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "full_access_receipt_or_policy_mismatch",
        ));
    }
    if !request
        .policy
        .allowed_actors
        .contains(&request.receipt.support_actor)
        || !request
            .policy
            .allowed_capabilities
            .is_superset(&request.receipt.capabilities)
    {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "full_access_scope_not_allowed_by_policy",
        ));
    }
    if !auto_approval_scope_valid(&request.policy, &request.receipt) {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "auto_approval_scope_not_granted",
        ));
    }
    if let Some(cloud_capabilities) = state.cloud_full_access_capabilities.lock().await.clone() {
        if !request
            .policy
            .allowed_capabilities
            .is_subset(&cloud_capabilities)
            || !request.receipt.capabilities.is_subset(&cloud_capabilities)
        {
            return Err(denied(
                StatusCode::FORBIDDEN,
                "full_access_scope_exceeds_cloud_policy",
            ));
        }
    }
    let graph = state
        .workspace
        .build_capability_graph()
        .map_err(|_| denied(StatusCode::FORBIDDEN, "full_access_graph_build_failed"))?;
    let mut full_access = state.full_access.lock().await;
    if let Some(existing) = &full_access.receipt {
        if existing.revoked_at.is_none()
            && existing.expires_at > Utc::now()
            && (existing.capabilities != request.receipt.capabilities
                || existing.support_actor != request.receipt.support_actor
                || existing.workspace_hash != request.receipt.workspace_hash
                || existing.policy_major != request.receipt.policy_major
                || existing.reconsent_version != request.receipt.reconsent_version
                || existing.auto_approval_enabled != request.receipt.auto_approval_enabled)
        {
            return Err(denied(
                StatusCode::CONFLICT,
                "full_access_reconsent_required",
            ));
        }
    }
    let recorded_receipt = request.receipt.clone();
    full_access.policy = request.policy;
    full_access.receipt = Some(request.receipt);
    full_access.graph = graph;
    full_access.budget = Default::default();
    full_access.process_visibility_paused = false;
    full_access
        .command_cancel
        .store(false, std::sync::atomic::Ordering::Release);
    drop(full_access);
    let mut audit = state.audit.lock().await;
    audit.record_full_access_consent(recorded_receipt);
    audit.append(AuditClass::FullAccess, Some(request.request_id.clone()), "Full Access Support enrolled after local desktop confirmation. Workspace graph is scrubbed and contains no raw bodies.", true);
    persist_audit(&state, &audit)?;
    Ok(Json(
        serde_json::json!({"decision":"full_access_enrolled","request_id":request.request_id,"raw_bodies_included":false,"bytes_sent":0}),
    ))
}

fn auto_approval_scope_valid(
    policy: &FullAccessPolicy,
    receipt: &FullAccessConsentReceipt,
) -> bool {
    !receipt.auto_approval_enabled
        || (receipt
            .capabilities
            .contains(&crate::full_access::FullAccessCapability::AutoApprovalEnable)
            && policy
                .allowed_capabilities
                .contains(&crate::full_access::FullAccessCapability::AutoApprovalEnable))
}

async fn full_access_graph(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<FullAccessGraphResponse>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    validate_safe_request_id(&request_id)?;
    let token = bearer(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint) = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
        )
    };
    let workspace_hash = state.workspace.summary().root_hash;
    let full_access = state.full_access.lock().await;
    let receipt = full_access
        .receipt
        .clone()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "full_access_not_enrolled"))?;
    let binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::GraphRead,
    };
    authorize_full_access(&full_access.policy, &receipt, &binding, Utc::now())
        .map_err(full_access_denied)?;
    let mut nodes = full_access.graph.values().cloned().collect::<Vec<_>>();
    nodes.sort_by(|a, b| a.node_id.cmp(&b.node_id));
    Ok(Json(FullAccessGraphResponse {
        request_id,
        decision: "allowed".into(),
        graph_nodes: nodes,
        raw_bodies_included: false,
        bytes_sent: 0,
    }))
}

async fn full_access_graph_node(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<GraphRequest>,
) -> Result<Json<FullAccessNodeResponse>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    let token = bearer(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint) = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
        )
    };
    let workspace_hash = state.workspace.summary().root_hash;
    let current_graph = state
        .workspace
        .build_capability_graph()
        .map_err(|_| denied(StatusCode::FORBIDDEN, "full_access_graph_refresh_failed"))?;
    let mut full_access = state.full_access.lock().await;
    let receipt = full_access
        .receipt
        .clone()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "full_access_not_enrolled"))?;
    let binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::GraphNodeRequest,
    };
    authorize_full_access(&full_access.policy, &receipt, &binding, Utc::now())
        .map_err(full_access_denied)?;
    if !receipt.auto_approval_enabled {
        return Err(denied(StatusCode::FORBIDDEN, "auto_approval_not_enabled"));
    }
    validate_graph_request(&current_graph, &request, &full_access.policy)
        .map_err(full_access_denied)?;
    let node = current_graph
        .get(&request.node_id)
        .cloned()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "unknown_graph_node"))?;
    let policy = full_access.policy.clone();
    if let Err(error) = full_access.budget.reserve(&policy, request.max_bytes) {
        drop(full_access);
        record_budget_exhaustion(&state, &request.request_id, "graph delivery").await?;
        return Err(full_access_denied(error));
    }
    full_access.graph = current_graph;
    drop(full_access);
    let result = state.workspace.read_graph_node(&node, request.max_bytes);
    let (content, hash) =
        result.map_err(|_| denied(StatusCode::FORBIDDEN, "graph_node_changed_or_unreadable"))?;
    let scan = SecretScanner::default()
        .try_scan(&content)
        .map_err(|_| denied(StatusCode::FORBIDDEN, "scanner_failure"))?;
    if !scan.findings.is_empty() {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "scanner_redaction_required_for_auto_delivery",
        ));
    }
    let bytes_sent = content.len();
    let mut audit = state.audit.lock().await;
    audit.append(AuditClass::FullAccess, Some(request.request_id.clone()), format!("Automatically sent graph node {} under Full Access policy. {} bytes sent; 0 redactions.", node.node_id, bytes_sent), true);
    persist_audit(&state, &audit)?;
    Ok(Json(FullAccessNodeResponse {
        request_id: request.request_id,
        decision: "auto_accepted".into(),
        node_id: node.node_id,
        content_sha256: Some(hash),
        content: Some(content),
        bytes_sent,
        redaction_count: 0,
        raw_bodies_included: true,
    }))
}

async fn full_access_mutation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<MutationRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    let token = bearer(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint) = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
        )
    };
    let workspace_hash = state.workspace.summary().root_hash;
    let graph = state
        .workspace
        .build_capability_graph()
        .map_err(|_| denied(StatusCode::FORBIDDEN, "full_access_graph_refresh_failed"))?;
    let mut full_access = state.full_access.lock().await;
    let receipt = full_access
        .receipt
        .clone()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "full_access_not_enrolled"))?;
    let binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::WorkspaceFileMutate,
    };
    authorize_full_access(&full_access.policy, &receipt, &binding, Utc::now())
        .map_err(full_access_denied)?;
    if !receipt.auto_approval_enabled {
        return Err(denied(StatusCode::FORBIDDEN, "auto_approval_not_enabled"));
    }
    let replacement_bytes = request.replacement.len() as u64;
    let policy = full_access.policy.clone();
    if let Err(error) = full_access.budget.reserve(&policy, replacement_bytes) {
        drop(full_access);
        record_budget_exhaustion(&state, &request.request_id, "workspace mutation").await?;
        return Err(full_access_denied(error));
    }
    full_access.graph = graph.clone();
    drop(full_access);
    let transaction = state
        .mutation_broker
        .lock()
        .await
        .apply(&graph, request.clone())
        .map_err(|error| {
            denied(
                StatusCode::FORBIDDEN,
                format!("full_access_mutation_{error:?}").to_ascii_lowercase(),
            )
        })?;
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Mutation,
        Some(request.request_id.clone()),
        format!(
            "Automatically changed {} under Full Access policy. Transaction {}; {} bytes written; reversible until {}.",
            transaction.relative_path,
            transaction.transaction_id,
            transaction.bytes_written,
            transaction.recovery_expires_at.to_rfc3339(),
        ),
        true,
    );
    persist_audit(&state, &audit)?;
    Ok(Json(serde_json::json!({
        "decision": "auto_mutated",
        "request_id": request.request_id,
        "transaction_id": transaction.transaction_id,
        "before_hash": transaction.before_hash,
        "after_hash": transaction.after_hash,
        "bytes_written": transaction.bytes_written,
        "raw_bodies_included": false
    })))
}

async fn full_access_revert(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<FullAccessRevertRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    validate_safe_request_id(&request.request_id)?;
    let token = bearer(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint) = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
        )
    };
    let workspace_hash = state.workspace.summary().root_hash;
    let full_access = state.full_access.lock().await;
    let receipt = full_access
        .receipt
        .clone()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "full_access_not_enrolled"))?;
    let binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::WorkspaceFileRevert,
    };
    authorize_full_access(&full_access.policy, &receipt, &binding, Utc::now())
        .map_err(full_access_denied)?;
    drop(full_access);
    let transaction = state
        .mutation_broker
        .lock()
        .await
        .revert(&request.transaction_id, &request.current_content_hash)
        .map_err(|error| {
            denied(
                StatusCode::FORBIDDEN,
                format!("full_access_revert_{error:?}").to_ascii_lowercase(),
            )
        })?;
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Mutation,
        Some(request.request_id.clone()),
        format!(
            "Reverted Full Access transaction {} for {} after current-hash verification.",
            transaction.transaction_id, transaction.relative_path
        ),
        true,
    );
    persist_audit(&state, &audit)?;
    Ok(Json(serde_json::json!({
        "decision": "reverted",
        "request_id": request.request_id,
        "transaction_id": transaction.transaction_id,
        "raw_bodies_included": false,
        "bytes_sent": 0
    })))
}

async fn full_access_port_discover(
    State(state): State<AppState>,
    Path((port, request_id)): Path<(u16, String)>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    validate_safe_request_id(&request_id)?;
    let token = bearer(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint) = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
        )
    };
    let workspace_hash = state.workspace.summary().root_hash;
    let full_access = state.full_access.lock().await;
    let receipt = full_access
        .receipt
        .clone()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "full_access_not_enrolled"))?;
    let binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::LocalPortDiscover,
    };
    authorize_full_access(&full_access.policy, &receipt, &binding, Utc::now())
        .map_err(full_access_denied)?;
    // Discovery exposes a listener's stable process identity hash and service
    // class. That metadata is separately consented from the ability to probe
    // a policy-scoped port, so neither capability can substitute for the other.
    let listener_metadata_binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::ProcessListenerMetadata,
    };
    authorize_full_access(
        &full_access.policy,
        &receipt,
        &listener_metadata_binding,
        Utc::now(),
    )
    .map_err(full_access_denied)?;
    if !full_access.policy.allowed_loopback_ports.contains(&port) {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "loopback_port_not_in_policy_scope",
        ));
    }
    drop(full_access);
    let listener = detect_loopback_listener(port)
        .map_err(|_| denied(StatusCode::FORBIDDEN, "loopback_listener_unavailable"))?;
    let mut audit = state.audit.lock().await;
    audit.append(AuditClass::Process, Some(request_id.clone()), format!("Discovered policy-scoped loopback listener on port {port}; process identity is bound locally and raw process fields were excluded."), true);
    persist_audit(&state, &audit)?;
    Ok(Json(
        serde_json::json!({"decision":"auto_accepted","request_id":request_id,"port":port,"process_identity_hash":listener.process_identity_hash,"service":listener.service,"loopback_only":true,"raw_process_fields_included":false,"bytes_sent":0}),
    ))
}

async fn full_access_command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<CommandRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    let token = bearer(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint) = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
        )
    };
    let workspace_hash = state.workspace.summary().root_hash;
    let current_graph = state
        .workspace
        .build_capability_graph()
        .map_err(|_| denied(StatusCode::FORBIDDEN, "full_access_graph_refresh_failed"))?;
    let mut full_access = state.full_access.lock().await;
    let receipt = full_access
        .receipt
        .clone()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "full_access_not_enrolled"))?;
    let binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::CommandExecute,
    };
    authorize_full_access(&full_access.policy, &receipt, &binding, Utc::now())
        .map_err(full_access_denied)?;
    if !receipt.auto_approval_enabled {
        return Err(denied(StatusCode::FORBIDDEN, "auto_approval_not_enabled"));
    }
    let policy = full_access.policy.clone();
    let command_cancel = full_access.command_cancel.clone();
    full_access.graph = current_graph.clone();
    if let Err(error) = full_access.budget.reserve_command(&policy) {
        drop(full_access);
        record_budget_exhaustion(&state, &request.request_id, "command execution").await?;
        return Err(full_access_denied(error));
    }
    if let Err(error) = full_access
        .budget
        .reserve(&policy, request.max_output_bytes as u64)
    {
        full_access.budget.finish_command();
        drop(full_access);
        record_budget_exhaustion(&state, &request.request_id, "command execution").await?;
        return Err(full_access_denied(error));
    }
    drop(full_access);
    let projection = state
        .workspace
        .materialize_command_projection(&current_graph)
        .map_err(|_| {
            denied(
                StatusCode::FORBIDDEN,
                "full_access_command_projection_failed",
            )
        })?;
    let context_result =
        execute_command_cancellable(projection.root(), &policy, request.clone(), command_cancel)
            .await;
    state.full_access.lock().await.budget.finish_command();
    let context = context_result.map_err(|error| {
        denied(
            StatusCode::FORBIDDEN,
            format!("full_access_command_{error:?}").to_ascii_lowercase(),
        )
    })?;
    let mut audit = state.audit.lock().await;
    audit.append(AuditClass::Command, Some(request.request_id.clone()), format!("Automatically ran {} under Full Access policy. Argument hash {}; exit {:?}; {} bytes captured; {} redactions.", context.executable, context.argument_hash, context.exit_code, context.bytes_captured, context.redaction_count), true);
    persist_audit(&state, &audit)?;
    Ok(Json(
        serde_json::json!({"decision":"auto_executed","request_id":request.request_id,"executable":context.executable,"argument_hash":context.argument_hash,"exit_code":context.exit_code,"stdout":context.stdout,"stderr":context.stderr,"bytes_captured":context.bytes_captured,"redaction_count":context.redaction_count,"raw_command_line_included":false}),
    ))
}

async fn full_access_port_use(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<FullAccessPortUseRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    if request.port == 0
        || request.max_response_bytes == 0
        || request.max_response_bytes > MAX_PREVIEW_RESPONSE_BYTES as usize
        || !safe_port_path(&request.path)
    {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "invalid_loopback_port_request",
        ));
    }
    let token = bearer(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint) = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request.request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
        )
    };
    let workspace_hash = state.workspace.summary().root_hash;
    let mut full_access = state.full_access.lock().await;
    let receipt = full_access
        .receipt
        .clone()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "full_access_not_enrolled"))?;
    let binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::LocalPortUse,
    };
    authorize_full_access(&full_access.policy, &receipt, &binding, Utc::now())
        .map_err(full_access_denied)?;
    if !receipt.auto_approval_enabled
        || !full_access
            .policy
            .allowed_loopback_ports
            .contains(&request.port)
    {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "loopback_port_not_auto_approved",
        ));
    }
    let policy = full_access.policy.clone();
    if let Err(error) = full_access
        .budget
        .reserve(&policy, request.max_response_bytes as u64)
    {
        drop(full_access);
        record_budget_exhaustion(&state, &request.request_id, "loopback port use").await?;
        return Err(full_access_denied(error));
    }
    drop(full_access);
    let before = detect_loopback_listener(request.port)
        .map_err(|_| denied(StatusCode::FORBIDDEN, "loopback_listener_unavailable"))?;
    if before.process_identity_hash != request.expected_process_identity_hash {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "loopback_listener_identity_changed",
        ));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| denied(StatusCode::FORBIDDEN, "loopback_client_unavailable"))?;
    let response = client
        .get(format!("http://127.0.0.1:{}{}", request.port, request.path))
        .send()
        .await
        .map_err(|_| denied(StatusCode::FORBIDDEN, "loopback_request_failed"))?;
    if !response.status().is_success()
        || response.headers().contains_key("set-cookie")
        || response.headers().contains_key("location")
    {
        return Err(denied(StatusCode::FORBIDDEN, "loopback_response_denied"));
    }
    if response
        .content_length()
        .is_some_and(|size| size as usize > request.max_response_bytes)
    {
        return Err(denied(StatusCode::FORBIDDEN, "loopback_response_too_large"));
    }
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| denied(StatusCode::FORBIDDEN, "loopback_response_failed"))?;
        if output.len().saturating_add(chunk.len()) > request.max_response_bytes {
            return Err(denied(StatusCode::FORBIDDEN, "loopback_response_too_large"));
        }
        output.extend_from_slice(&chunk);
    }
    let content = String::from_utf8(output)
        .map_err(|_| denied(StatusCode::FORBIDDEN, "loopback_binary_response_denied"))?;
    let scan = SecretScanner::default()
        .try_scan(&content)
        .map_err(|_| denied(StatusCode::FORBIDDEN, "scanner_failure"))?;
    if !scan.findings.is_empty() {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "loopback_response_requires_redaction",
        ));
    }
    let after = detect_loopback_listener(request.port)
        .map_err(|_| denied(StatusCode::FORBIDDEN, "loopback_listener_unavailable"))?;
    if after.process_identity_hash != request.expected_process_identity_hash {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "loopback_listener_identity_changed",
        ));
    }
    let mut audit = state.audit.lock().await;
    audit.append(AuditClass::FullAccess, Some(request.request_id.clone()), format!("Automatically read {} bytes from policy-scoped loopback port {}. Credentials, cookies, redirects, and response headers were blocked.", content.len(), request.port), true);
    persist_audit(&state, &audit)?;
    Ok(Json(
        serde_json::json!({"decision":"auto_accepted","request_id":request.request_id,"port":request.port,"content":content,"bytes_sent":content.len(),"redaction_count":0,"raw_headers_included":false}),
    ))
}

fn safe_port_path(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= 2048
        && !value.contains(['\\', '\0', '#'])
        && !value.contains('?')
        && !value.contains("..")
}

async fn full_access_processes(
    State(state): State<AppState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_headers(&headers)?;
    enforce_rate_limit(&state).await?;
    validate_safe_request_id(&request_id)?;
    let token = bearer(&headers)?;
    let (session_id, account_id, org_id, device_fingerprint) = {
        let mut session = state.session.lock().await;
        session
            .validate(token, &request_id)
            .map_err(|err| denied(StatusCode::UNAUTHORIZED, format!("{err:?}")))?;
        (
            session.session_id().to_string(),
            session.account_id().to_string(),
            session.org_id().to_string(),
            session.device_fingerprint().to_string(),
        )
    };
    let workspace_hash = state.workspace.summary().root_hash;
    let full_access = state.full_access.lock().await;
    let receipt = full_access
        .receipt
        .clone()
        .ok_or_else(|| denied(StatusCode::FORBIDDEN, "full_access_not_enrolled"))?;
    let binding = ReceiptBinding {
        session_id: &session_id,
        account_id: &account_id,
        organization_id: &org_id,
        actor: &receipt.support_actor,
        device_fingerprint: &device_fingerprint,
        workspace_hash: &workspace_hash,
        policy_version: crate::POLICY_VERSION,
        scanner_version: crate::SCANNER_VERSION,
        app_version: &receipt.app_version,
        policy_major: full_access.policy.policy_major,
        reconsent_version: full_access.policy.mandatory_reconsent_version,
        capability: crate::full_access::FullAccessCapability::ProcessInventory,
    };
    authorize_full_access(&full_access.policy, &receipt, &binding, Utc::now())
        .map_err(full_access_denied)?;
    if full_access.process_visibility_paused {
        return Err(denied(
            StatusCode::FORBIDDEN,
            "process_visibility_paused_locally",
        ));
    }
    let max_records = full_access.policy.max_process_records;
    let process_modes = full_access.policy.process_visibility_modes.clone();
    let full_access_ports = full_access.policy.allowed_loopback_ports.clone();
    drop(full_access);
    let approved_ports = state
        .port_approvals
        .lock()
        .await
        .approvals()
        .into_iter()
        .filter(|approval| approval.session_id == session_id)
        .map(|approval| (approval.port, approval.process_identity_hash))
        .collect::<Vec<_>>();
    let records = ProcessInspectionAdapter::list_scoped_processes(
        state.workspace.root(),
        max_records,
        &process_modes,
        &full_access_ports,
        &approved_ports,
    )
    .map_err(|_| denied(StatusCode::FORBIDDEN, "process_inventory_unavailable"))?;
    let count = records.len();
    let mut audit = state.audit.lock().await;
    audit.append(AuditClass::Process, Some(request_id.clone()), format!("Collected {count} sanitized workspace process records under Full Access policy. Command lines, environments, raw paths, and PIDs were excluded."), true);
    persist_audit(&state, &audit)?;
    Ok(Json(
        serde_json::json!({"request_id":request_id,"decision":"auto_accepted","records":records,"raw_process_fields_included":false,"bytes_sent":0}),
    ))
}

fn full_access_denied(error: FullAccessDenied) -> (StatusCode, Json<serde_json::Value>) {
    denied(
        StatusCode::FORBIDDEN,
        format!("full_access_{error:?}").to_ascii_lowercase(),
    )
}

async fn record_budget_exhaustion(
    state: &AppState,
    request_id: &str,
    operation: &str,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Budget,
        Some(request_id.to_string()),
        format!("Full Access budget exhausted before {operation}; automatic delivery was paused locally."),
        true,
    );
    persist_audit(state, &audit)
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
    state.full_access.lock().await.pause();
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
            state.full_access.lock().await.revoke();
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
    state.full_access.lock().await.revoke();
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
    use super::{auto_approval_scope_valid, record_budget_exhaustion, validate_headers, AppState};
    use crate::audit::AuditClass;
    use crate::full_access::{FullAccessCapability, FullAccessConsentReceipt, FullAccessPolicy};
    use crate::scanner::SecretScanner;
    use crate::session::SessionGuard;
    use crate::workspace::WorkspacePolicy;
    use axum::http::{HeaderMap, HeaderValue};
    use std::collections::BTreeSet;
    use std::time::Duration;
    use tempfile::tempdir;

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

    #[test]
    fn auto_approval_requires_its_own_receipt_and_policy_capability() {
        let mut receipt = FullAccessConsentReceipt {
            consent_id: "consent_123".into(),
            session_id: "sess_123".into(),
            account_id: "acct_123".into(),
            organization_id: "org_123".into(),
            support_actor: "support_agent".into(),
            device_fingerprint: "sha256:abc".into(),
            workspace_hash: "sha256:workspace".into(),
            capabilities: BTreeSet::from([FullAccessCapability::Enroll]),
            auto_approval_enabled: true,
            policy_version: "policy".into(),
            scanner_version: "scanner".into(),
            app_version: "0.1.0".into(),
            policy_major: 1,
            reconsent_version: 1,
            created_at: chrono::Utc::now(),
            expires_at: chrono::Utc::now() + chrono::Duration::minutes(1),
            paused_at: None,
            revoked_at: None,
            local_confirmation: "native_button".into(),
        };
        let mut policy = FullAccessPolicy {
            organization_enabled: true,
            ..Default::default()
        };
        policy
            .allowed_capabilities
            .insert(FullAccessCapability::AutoApprovalEnable);
        assert!(!auto_approval_scope_valid(&policy, &receipt));
        receipt
            .capabilities
            .insert(FullAccessCapability::AutoApprovalEnable);
        assert!(auto_approval_scope_valid(&policy, &receipt));
        policy.allowed_capabilities.clear();
        assert!(!auto_approval_scope_valid(&policy, &receipt));
    }

    #[tokio::test]
    async fn budget_exhaustion_is_recorded_without_request_payload() {
        let root = tempdir().unwrap();
        let workspace =
            WorkspacePolicy::new(root.path(), "wk_budget", SecretScanner::default()).unwrap();
        let state = AppState::new(
            SessionGuard::new_bound(
                "acct_budget",
                "org_budget",
                "wk_budget",
                Duration::from_secs(60),
            ),
            workspace,
        );
        record_budget_exhaustion(&state, "req_budget_123", "graph delivery")
            .await
            .unwrap();
        let event = state.audit.lock().await.events().last().cloned().unwrap();
        assert!(matches!(event.class, AuditClass::Budget));
        assert!(event.summary.contains("budget exhausted"));
        assert!(!event.summary.contains("req_budget_123"));
    }
}
