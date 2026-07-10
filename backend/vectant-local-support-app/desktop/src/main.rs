#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::time::Duration;

use tauri::{Manager, State};
use uuid::Uuid;
use vectant_local_support_app::audit::{AuditClass, LocalAuditStore};
use vectant_local_support_app::desktop::{build_desktop_status_state, plan_desktop_ipc_action};
use vectant_local_support_app::http::{shutdown_cleanup, AppState};
use vectant_local_support_app::ipc::IpcRequest;
use vectant_local_support_app::pair::DeviceIdentityStore;
use vectant_local_support_app::scanner::SecretScanner;
use vectant_local_support_app::session::SessionGuard;
use vectant_local_support_app::workspace::WorkspacePolicy;

struct DesktopRuntime {
    app_state: AppState,
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
    let session_id = runtime
        .app_state
        .session
        .lock()
        .await
        .session_id()
        .to_string();
    let request = IpcRequest {
        command,
        request_id: request_id.clone(),
        session_id,
    };
    let plan = plan_desktop_ipc_action(&request).map_err(|error| error.to_string())?;

    match plan.command.as_str() {
        "session.status" => {}
        "session.pause" => {
            let mut session = runtime.app_state.session.lock().await;
            if session.is_active() {
                session.pause();
                drop(session);
                append_control_event(
                    &runtime.app_state,
                    &request_id,
                    "Session paused by the local desktop user.",
                )
                .await?;
            }
        }
        "session.resume" => {
            let mut session = runtime.app_state.session.lock().await;
            if session.is_active() {
                session.resume();
                drop(session);
                append_control_event(
                    &runtime.app_state,
                    &request_id,
                    "Session resumed by the local desktop user.",
                )
                .await?;
            }
        }
        "session.disconnect" => {
            shutdown_cleanup(&runtime.app_state, &request_id)
                .await
                .map_err(|_| "Local session cleanup failed closed.".to_string())?;
        }
        _ => {
            return Err(format!(
                "{} is not available until its local workflow is connected.",
                plan.command
            ));
        }
    }

    Ok(build_desktop_status_state(&runtime.app_state).await)
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
    let runtime = DesktopRuntime {
        app_state: initial_disconnected_state()?,
    };
    let app = tauri::Builder::default()
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![local_support_ipc])
        .build(tauri::generate_context!())?;

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = app_handle.state::<DesktopRuntime>().app_state.clone();
            tauri::async_runtime::block_on(async move {
                let _ = shutdown_cleanup(&state, "desktop_app_exit").await;
            });
        }
    });
    Ok(())
}

fn initial_disconnected_state() -> anyhow::Result<AppState> {
    let workspace_id = "not_selected";
    let policy = WorkspacePolicy::new(
        std::env::current_dir()?,
        workspace_id,
        SecretScanner::default(),
    )?;
    let identity = DeviceIdentityStore::new(device_identity_path()?).load_or_create()?;
    let mut session = SessionGuard::new_bound_device(
        "not_paired",
        "not_paired",
        workspace_id,
        identity.public_identity().device_fingerprint,
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
