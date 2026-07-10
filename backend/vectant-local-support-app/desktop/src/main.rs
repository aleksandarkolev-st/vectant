#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pairing_client;
mod relay_client;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use pairing_client::{ClaimedPairing, PairingClient};
use relay_client::{ApprovedRelayPayload, RelayClient, RelayDelivery, RelayOutcome, RelayPoll};
use tauri::{Manager, State};
use uuid::Uuid;
use vectant_local_support_app::audit::{AuditClass, LocalAuditStore};
use vectant_local_support_app::desktop::{build_desktop_status_state, plan_desktop_ipc_action};
use vectant_local_support_app::http::{shutdown_cleanup, AppState};
use vectant_local_support_app::ipc::IpcRequest;
use vectant_local_support_app::pair::{DeviceIdentity, DeviceIdentityStore};
use vectant_local_support_app::scanner::SecretScanner;
use vectant_local_support_app::session::SessionGuard;
use vectant_local_support_app::workspace::FileReadRequest;
use vectant_local_support_app::workspace::WorkspacePolicy;

struct DesktopRuntime {
    app_state: RwLock<AppState>,
    device_identity: DeviceIdentity,
    pairing_client: PairingClient,
    relay_client: RelayClient,
    pending_pairing: RwLock<Option<ClaimedPairing>>,
    pending_relay_approvals: RwLock<HashMap<String, PendingRelayApproval>>,
}

#[derive(Clone)]
struct PendingRelayApproval {
    approval_id: String,
    delivery: RelayDelivery,
}

#[tauri::command]
async fn local_support_ipc(
    command: String,
    payload: serde_json::Value,
    runtime: State<'_, DesktopRuntime>,
) -> Result<serde_json::Value, String> {
    if !payload.is_object() {
        return Err("Desktop command payload must be an object.".to_string());
    }

    let request_id = format!("desktop_{}", Uuid::new_v4().simple());
    let app_state = current_app_state(&runtime)?;
    let session_id = app_state.session.lock().await.session_id().to_string();
    let request = IpcRequest {
        command,
        request_id: request_id.clone(),
        session_id,
    };
    let plan = plan_desktop_ipc_action(&request).map_err(|error| error.to_string())?;

    match plan.command.as_str() {
        "session.status" => {}
        "session.pause" => {
            let mut session = app_state.session.lock().await;
            if session.is_active() {
                session.pause();
                drop(session);
                append_control_event(
                    &app_state,
                    &request_id,
                    "Session paused by the local desktop user.",
                )
                .await?;
            }
        }
        "session.resume" => {
            let mut session = app_state.session.lock().await;
            if session.is_active() {
                session.resume();
                drop(session);
                append_control_event(
                    &app_state,
                    &request_id,
                    "Session resumed by the local desktop user.",
                )
                .await?;
            }
        }
        "session.disconnect" => {
            shutdown_cleanup(&app_state, &request_id)
                .await
                .map_err(|_| "Local session cleanup failed closed.".to_string())?;
            *runtime
                .pending_pairing
                .write()
                .map_err(|_| "Pairing state lock failed closed.".to_string())? = None;
            runtime
                .pending_relay_approvals
                .write()
                .map_err(|_| "Relay state lock failed closed.".to_string())?
                .clear();
        }
        "workspace.pick" => {
            let Some(path) = rfd::FileDialog::new()
                .set_title("Choose the project folder Vectant can help with")
                .pick_folder()
            else {
                return desktop_status(&runtime, &app_state).await;
            };
            let replacement = disconnected_state_for_workspace(
                path,
                format!("wk_{}", Uuid::new_v4().simple()),
                runtime.device_identity.public_identity().device_fingerprint,
            )
            .map_err(|_| "The selected workspace could not be opened safely.".to_string())?;
            append_control_event(
                &replacement,
                &request_id,
                "Workspace selected locally. No files were sent.",
            )
            .await?;
            *runtime
                .app_state
                .write()
                .map_err(|_| "Desktop state lock failed closed.".to_string())? =
                replacement.clone();
            *runtime
                .pending_pairing
                .write()
                .map_err(|_| "Pairing state lock failed closed.".to_string())? = None;
            runtime
                .pending_relay_approvals
                .write()
                .map_err(|_| "Relay state lock failed closed.".to_string())?
                .clear();
            return desktop_status(&runtime, &replacement).await;
        }
        "pairing.start" => {
            let workspace = app_state.workspace.summary();
            if workspace.workspace_id == "not_selected" {
                return Err("Choose one workspace before pairing.".to_string());
            }
            let code = payload
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_ascii_uppercase();
            let claim = runtime
                .pairing_client
                .claim(&code, &workspace.workspace_id)
                .await?;
            if claim.workspace_id != workspace.workspace_id {
                return Err(
                    "Pairing challenge workspace did not match the selected workspace.".to_string(),
                );
            }
            *runtime
                .pending_pairing
                .write()
                .map_err(|_| "Pairing state lock failed closed.".to_string())? = Some(claim);
            append_control_event(
                &app_state,
                &request_id,
                "Pairing code claimed locally. Fingerprint confirmation is required.",
            )
            .await?;
        }
        "pairing.confirm" => {
            let claim = runtime
                .pending_pairing
                .read()
                .map_err(|_| "Pairing state lock failed closed.".to_string())?
                .clone()
                .ok_or_else(|| "No pairing fingerprint is waiting for confirmation.".to_string())?;
            let proof = runtime.device_identity.sign_pairing_challenge(
                &claim.pairing_id,
                &claim.server_nonce,
                &claim.browser_session_id,
                &claim.requested_user_id,
            );
            let completed = runtime.pairing_client.complete(&claim, &proof).await?;
            let public = runtime.device_identity.public_identity();
            if completed.workspace_id != claim.workspace_id
                || completed.account_id != claim.account_id
                || completed.org_id != claim.org_id
                || completed.device_fingerprint != public.device_fingerprint
            {
                return Err(
                    "Pairing completion identity did not match the confirmed challenge."
                        .to_string(),
                );
            }
            let expires_at = DateTime::parse_from_rfc3339(&completed.expires_at)
                .map_err(|_| "Pairing expiry was invalid.".to_string())?
                .with_timezone(&Utc);
            let ttl = (expires_at - Utc::now())
                .to_std()
                .map_err(|_| "Pairing challenge expired.".to_string())?;
            let session = SessionGuard::new_paired(
                completed.session_id,
                completed.account_id,
                completed.org_id,
                completed.workspace_id,
                completed.device_fingerprint,
                ttl,
            )
            .map_err(|_| "Paired session identity was invalid.".to_string())?;
            *app_state.session.lock().await = session;
            *runtime
                .pending_pairing
                .write()
                .map_err(|_| "Pairing state lock failed closed.".to_string())? = None;
            append_control_event(
                &app_state,
                &request_id,
                "Pairing fingerprint confirmed locally. Support session connected.",
            )
            .await?;
        }
        "approval.file.review" => {}
        "approval.file.approve" => {
            let approval_id = payload
                .get("approval_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let granted = app_state
                .approvals
                .lock()
                .await
                .grant_for_local_release(approval_id);
            if !granted {
                return Err("Approval is no longer pending. Nothing was sent.".to_string());
            }
            let pending_relay = runtime
                .pending_relay_approvals
                .read()
                .map_err(|_| "Relay state lock failed closed.".to_string())?
                .values()
                .find(|pending| pending.approval_id == approval_id)
                .cloned();
            if let Some(pending) = pending_relay {
                release_relay_approval(&runtime, &app_state, approval_id, &pending).await?;
            } else {
                append_control_event(
                    &app_state,
                    &request_id,
                    "File review approved locally. The payload remains local until request-bound release.",
                )
                .await?;
            }
        }
        "approval.file.deny" => {
            let approval_id = payload
                .get("approval_id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let denied = app_state.approvals.lock().await.deny(approval_id);
            if !denied {
                return Err("Approval is no longer pending. Nothing was sent.".to_string());
            }
            append_control_event(
                &app_state,
                &request_id,
                "File review denied locally. Nothing was sent.",
            )
            .await?;
        }
        "approval.revoke_session" => {
            app_state.approvals.lock().await.revoke_all();
            let session_id = app_state.session.lock().await.session_id().to_string();
            app_state
                .port_approvals
                .lock()
                .await
                .disconnect_session(&session_id);
            append_control_event(
                &app_state,
                &request_id,
                "Session approvals and approved ports were revoked locally.",
            )
            .await?;
        }
        "history.export" => {
            let Some(path) = rfd::FileDialog::new()
                .set_title("Export scrubbed Local Support history")
                .set_file_name("vectant-local-support-history.json")
                .add_filter("JSON", &["json"])
                .save_file()
            else {
                return desktop_status(&runtime, &app_state).await;
            };
            let retention_days = app_state
                .audit_store
                .as_ref()
                .map(|store| store.retention_days())
                .unwrap_or(30);
            let export = app_state
                .audit
                .lock()
                .await
                .export_incident_bundle(retention_days);
            let bytes = serde_json::to_vec_pretty(&export)
                .map_err(|_| "Scrubbed history export could not be serialized.".to_string())?;
            std::fs::write(path, bytes)
                .map_err(|_| "Scrubbed history export could not be written.".to_string())?;
            append_control_event(
                &app_state,
                &request_id,
                "Scrubbed local history was exported by the desktop user.",
            )
            .await?;
        }
        "history.delete" => {
            let confirmed = rfd::MessageDialog::new()
                .set_title("Delete local activity history?")
                .set_description(
                    "This removes Local Support events and approval receipts stored on this computer.",
                )
                .set_buttons(rfd::MessageButtons::YesNo)
                .set_level(rfd::MessageLevel::Warning)
                .show();
            if !matches!(confirmed, rfd::MessageDialogResult::Yes) {
                return desktop_status(&runtime, &app_state).await;
            }
            let Some(store) = &app_state.audit_store else {
                return Err(
                    "Local history storage is unavailable. Nothing was deleted.".to_string()
                );
            };
            store
                .delete()
                .map_err(|_| "Local history deletion failed closed.".to_string())?;
            let mut audit = app_state.audit.lock().await;
            audit.clear();
            audit.append(
                AuditClass::Control,
                Some(request_id.clone()),
                "Local support history deleted according to retention policy.",
                true,
            );
            store
                .persist(&audit)
                .map_err(|_| "Local history deletion marker could not be persisted.".to_string())?;
        }
        _ => {
            return Err(format!(
                "{} is not available until its local workflow is connected.",
                plan.command
            ));
        }
    }

    desktop_status(&runtime, &app_state).await
}

async fn desktop_status(
    runtime: &DesktopRuntime,
    state: &AppState,
) -> Result<serde_json::Value, String> {
    let mut status = build_desktop_status_state(state).await;
    let pending = runtime
        .pending_pairing
        .read()
        .map_err(|_| "Pairing state lock failed closed.".to_string())?
        .clone();
    if let (Some(map), Some(claim)) = (status.as_object_mut(), pending) {
        map.insert(
            "pairing".to_string(),
            serde_json::json!({
                "status": "awaiting_confirmation",
                "fingerprint": claim.fingerprint,
                "account_id": claim.account_id,
                "org_id": claim.org_id,
                "expires_at": claim.expires_at,
            }),
        );
    }
    Ok(status)
}

fn current_app_state(runtime: &DesktopRuntime) -> Result<AppState, String> {
    runtime
        .app_state
        .read()
        .map(|state| state.clone())
        .map_err(|_| "Desktop state lock failed closed.".to_string())
}

async fn append_control_event(
    state: &AppState,
    request_id: &str,
    summary: &str,
) -> Result<(), String> {
    let mut audit = state.audit.lock().await;
    audit.append(
        AuditClass::Control,
        Some(request_id.to_string()),
        summary,
        true,
    );
    if let Some(store) = &state.audit_store {
        store.persist(&audit).map_err(|_| {
            "Local activity could not be persisted. The action was denied.".to_string()
        })?;
    }
    Ok(())
}

fn main() -> anyhow::Result<()> {
    let identity = DeviceIdentityStore::new(device_identity_path()?).load_or_create()?;
    let device_fingerprint = identity.public_identity().device_fingerprint;
    let runtime = DesktopRuntime {
        app_state: RwLock::new(disconnected_state_for_workspace(
            std::env::current_dir()?,
            "not_selected".to_string(),
            device_fingerprint.clone(),
        )?),
        device_identity: identity,
        pairing_client: PairingClient::from_environment().map_err(anyhow::Error::msg)?,
        relay_client: RelayClient::from_environment().map_err(anyhow::Error::msg)?,
        pending_pairing: RwLock::new(None),
        pending_relay_approvals: RwLock::new(HashMap::new()),
    };
    let app = tauri::Builder::default()
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![local_support_ipc])
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { relay_poll_loop(app_handle).await });
            Ok(())
        })
        .build(tauri::generate_context!())?;

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            if let Ok(state) = current_app_state(&app_handle.state::<DesktopRuntime>()) {
                tauri::async_runtime::block_on(async move {
                    let _ = shutdown_cleanup(&state, "desktop_app_exit").await;
                });
            }
        }
    });
    Ok(())
}

async fn relay_poll_loop(app_handle: tauri::AppHandle) {
    loop {
        let runtime = app_handle.state::<DesktopRuntime>();
        if let Ok(app_state) = current_app_state(&runtime) {
            let session_state = {
                let session = app_state.session.lock().await;
                if session.is_active() {
                    Some(session.state())
                } else {
                    None
                }
            };
            if let Some(session) =
                session_state.filter(|state| !state.paused && state.session_id.starts_with("sess_"))
            {
                if let Ok(RelayPoll::Delivery(delivery)) = runtime
                    .relay_client
                    .poll(&runtime.device_identity, &session.session_id)
                    .await
                {
                    let _ = handle_relay_delivery(&runtime, &app_state, &session, *delivery).await;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn handle_relay_delivery(
    runtime: &DesktopRuntime,
    state: &AppState,
    session: &vectant_local_support_app::session::SessionState,
    delivery: RelayDelivery,
) -> Result<(), String> {
    let already_pending = runtime
        .pending_relay_approvals
        .read()
        .map_err(|_| "Relay state lock failed closed.".to_string())?
        .contains_key(&delivery.request_id);
    if already_pending {
        return report_relay_outcome(
            runtime,
            session,
            &delivery,
            "review_pending",
            0,
            0,
            "local_review_required",
        )
        .await;
    }

    let expires_at = DateTime::parse_from_rfc3339(&delivery.expires_at)
        .map_err(|_| "Relay request expiry was invalid.".to_string())?
        .with_timezone(&Utc);
    let context_valid = delivery.session_id == session.session_id
        && delivery.account_id == session.account_id
        && delivery.org_id == session.org_id
        && delivery.workspace_id == session.workspace_id
        && delivery.workspace_id == state.workspace.workspace_id()
        && delivery.device_fingerprint == session.device_fingerprint
        && delivery.protocol_version == vectant_local_support_app::APP_PROTOCOL_VERSION
        && delivery.policy_version == vectant_local_support_app::POLICY_VERSION
        && delivery.app_version == env!("CARGO_PKG_VERSION")
        && expires_at > Utc::now()
        && matches!(
            delivery.capability.as_str(),
            "workspace.file.source.read" | "workspace.log.read"
        );
    if !context_valid {
        return report_relay_outcome(
            runtime,
            session,
            &delivery,
            "denied",
            0,
            0,
            "local_context_validation_failed",
        )
        .await;
    }

    let request = FileReadRequest {
        request_id: delivery.request_id.clone(),
        session_id: delivery.session_id.clone(),
        account_id: delivery.account_id.clone(),
        org_id: delivery.org_id.clone(),
        workspace_id: delivery.workspace_id.clone(),
        device_fingerprint: delivery.device_fingerprint.clone(),
        capability: delivery.capability.clone(),
        path: delivery.target_display.clone(),
        max_bytes: Some(256 * 1024),
        reason: "Vectant support requested this local item.".to_string(),
        actor: delivery.actor.clone(),
        expires_at: delivery.expires_at.clone(),
    };
    let local_review = state.workspace.read_file_for_review(&request);
    let scanner_version = local_review.scanner_version.clone();
    let redaction_count = local_review.redactions.len();
    let response = state
        .approvals
        .lock()
        .await
        .queue_file_review(request, local_review);
    if response.decision == "denied" {
        append_control_event(
            state,
            &delivery.request_id,
            "Relay file request was denied by local policy. Nothing was sent.",
        )
        .await?;
        return report_relay_outcome(
            runtime,
            session,
            &delivery,
            "denied",
            0,
            redaction_count,
            "local_policy_denied",
        )
        .await;
    }

    let approval_id = response
        .approval_id
        .ok_or_else(|| "Relay review did not create a local approval.".to_string())?;
    runtime
        .pending_relay_approvals
        .write()
        .map_err(|_| "Relay state lock failed closed.".to_string())?
        .insert(
            delivery.request_id.clone(),
            PendingRelayApproval {
                approval_id,
                delivery: delivery.clone(),
            },
        );
    append_control_event(
        state,
        &delivery.request_id,
        "Relay file request is waiting for local review. No file content was sent.",
    )
    .await?;
    runtime
        .relay_client
        .report_outcome(
            &runtime.device_identity,
            &session.session_id,
            &RelayOutcome {
                request_id: &delivery.request_id,
                lease_id: &delivery.lease_id,
                decision: "review_pending",
                bytes_sent: 0,
                redaction_count,
                scanner_version: &scanner_version,
                reason: "local_review_required",
            },
        )
        .await
}

async fn report_relay_outcome(
    runtime: &DesktopRuntime,
    session: &vectant_local_support_app::session::SessionState,
    delivery: &RelayDelivery,
    decision: &str,
    bytes_sent: usize,
    redaction_count: usize,
    reason: &str,
) -> Result<(), String> {
    runtime
        .relay_client
        .report_outcome(
            &runtime.device_identity,
            &session.session_id,
            &RelayOutcome {
                request_id: &delivery.request_id,
                lease_id: &delivery.lease_id,
                decision,
                bytes_sent,
                redaction_count,
                scanner_version: &delivery.scanner_version,
                reason,
            },
        )
        .await
}

async fn release_relay_approval(
    runtime: &DesktopRuntime,
    state: &AppState,
    approval_id: &str,
    pending: &PendingRelayApproval,
) -> Result<(), String> {
    let queued_request = state
        .approvals
        .lock()
        .await
        .request_for_approval(approval_id)
        .ok_or_else(|| {
            "Approved relay request was no longer available. Nothing was sent.".to_string()
        })?;
    let current_review = state.workspace.read_file_for_review(&queued_request);
    let released = state
        .approvals
        .lock()
        .await
        .release_granted_at(approval_id, current_review, Utc::now())
        .ok_or_else(|| {
            "Approved file changed or expired before release. Nothing was sent.".to_string()
        })?;
    let (response, receipt) = released;
    let content = response
        .content
        .as_deref()
        .ok_or_else(|| "Approved relay payload was empty. Nothing was sent.".to_string())?;
    let content_sha256 = response
        .content_sha256
        .as_deref()
        .ok_or_else(|| "Approved relay payload hash was missing. Nothing was sent.".to_string())?;
    let bytes_sent = runtime
        .relay_client
        .upload_approved_payload(
            &runtime.device_identity,
            &pending.delivery.session_id,
            &ApprovedRelayPayload {
                request_id: &pending.delivery.request_id,
                content,
                content_sha256,
                redaction_count: response.redactions.len(),
                scanner_version: &response.scanner_version,
            },
        )
        .await?;
    if bytes_sent != content.len() {
        return Err(
            "Relay payload receipt byte count did not match. Session should be disconnected."
                .to_string(),
        );
    }

    runtime
        .pending_relay_approvals
        .write()
        .map_err(|_| "Relay state lock failed closed.".to_string())?
        .remove(&pending.delivery.request_id);
    let mut audit = state.audit.lock().await;
    audit.record_consent(receipt);
    audit.append(
        AuditClass::Data,
        Some(pending.delivery.request_id.clone()),
        format!(
            "Approved redacted file payload sent after final hash revalidation. {bytes_sent} bytes sent; {} redactions.",
            response.redactions.len()
        ),
        true,
    );
    if let Some(store) = &state.audit_store {
        store
            .persist(&audit)
            .map_err(|_| "Sent activity could not be persisted locally.".to_string())?;
    }
    Ok(())
}

fn disconnected_state_for_workspace(
    workspace: PathBuf,
    workspace_id: String,
    device_fingerprint: String,
) -> anyhow::Result<AppState> {
    let policy = WorkspacePolicy::new(workspace, workspace_id.clone(), SecretScanner::default())?;
    let mut session = SessionGuard::new_bound_device(
        "not_paired",
        "not_paired",
        workspace_id,
        device_fingerprint,
        Duration::from_secs(30 * 60),
    );
    session.disconnect();
    let audit_store = LocalAuditStore::new(audit_path()?, 30, SecretScanner::default());
    Ok(AppState::new_with_audit_store(session, policy, audit_store))
}

fn audit_path() -> anyhow::Result<PathBuf> {
    app_data_root().map(|root| root.join("audit.json"))
}

fn device_identity_path() -> anyhow::Result<PathBuf> {
    app_data_root().map(|root| root.join("device-identity.json"))
}

fn app_data_root() -> anyhow::Result<PathBuf> {
    if let Ok(path) = std::env::var("LOCALAPPDATA") {
        return Ok(PathBuf::from(path).join("Vectant").join("LocalSupport"));
    }
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("vectant-local-support"));
    }
    Ok(std::env::current_dir()?.join(".vectant-local-support"))
}
