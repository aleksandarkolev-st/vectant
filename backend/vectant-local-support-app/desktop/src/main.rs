#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::RwLock;
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
    app_state: RwLock<AppState>,
    device_fingerprint: String,
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
        }
        "workspace.pick" => {
            let Some(path) = rfd::FileDialog::new()
                .set_title("Choose the project folder Vectant can help with")
                .pick_folder()
            else {
                return Ok(build_desktop_status_state(&app_state).await);
            };
            let replacement = disconnected_state_for_workspace(
                path,
                format!("wk_{}", Uuid::new_v4().simple()),
                runtime.device_fingerprint.clone(),
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
            return Ok(build_desktop_status_state(&replacement).await);
        }
        _ => {
            return Err(format!(
                "{} is not available until its local workflow is connected.",
                plan.command
            ));
        }
    }

    Ok(build_desktop_status_state(&app_state).await)
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
        device_fingerprint,
    };
    let app = tauri::Builder::default()
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![local_support_ipc])
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
