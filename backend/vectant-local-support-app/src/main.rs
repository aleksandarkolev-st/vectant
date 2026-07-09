use std::path::PathBuf;
use std::time::Duration;

use vectant_local_support_app::audit::LocalAuditStore;
use vectant_local_support_app::http::{bind_loopback, shutdown_cleanup, AppState};
use vectant_local_support_app::pair::DeviceIdentityStore;
use vectant_local_support_app::scanner::SecretScanner;
use vectant_local_support_app::session::SessionGuard;
use vectant_local_support_app::workspace::WorkspacePolicy;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let workspace = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let workspace_id = "wk_local";
    let scanner = SecretScanner::default();
    let policy = WorkspacePolicy::new(workspace, workspace_id, scanner)?;
    let device_identity =
        DeviceIdentityStore::new(default_device_identity_path()?).load_or_create()?;
    let device_fingerprint = device_identity.public_identity().device_fingerprint;
    let session = SessionGuard::new_bound_device(
        "acct_local",
        "org_local",
        workspace_id,
        device_fingerprint,
        Duration::from_secs(30 * 60),
    );
    #[cfg(debug_assertions)]
    let token = session.token_for_pairing_response().to_string();
    let audit_store = LocalAuditStore::new(default_audit_path()?, 30, SecretScanner::default());
    let state = AppState::new_with_audit_store(session, policy, audit_store);
    let addr = bind_loopback(state.clone()).await?;
    println!("Vectant Local Support listening on http://{addr}");
    #[cfg(debug_assertions)]
    if std::env::var("VECTANT_LOCAL_SUPPORT_PRINT_DEV_TOKEN")
        .ok()
        .as_deref()
        == Some("1")
    {
        println!("Development pairing bearer token: {token}");
    }
    tokio::signal::ctrl_c().await?;
    shutdown_cleanup(&state, "local_app_shutdown").await?;
    Ok(())
}

fn default_audit_path() -> anyhow::Result<PathBuf> {
    if let Ok(path) = std::env::var("VECTANT_LOCAL_SUPPORT_AUDIT_PATH") {
        return Ok(PathBuf::from(path));
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return Ok(PathBuf::from(local_app_data)
            .join("Vectant")
            .join("LocalSupport")
            .join("audit.json"));
    }
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("vectant-local-support")
            .join("audit.json"));
    }
    Ok(std::env::current_dir()?
        .join(".vectant-local-support")
        .join("audit.json"))
}

fn default_device_identity_path() -> anyhow::Result<PathBuf> {
    if let Ok(path) = std::env::var("VECTANT_LOCAL_SUPPORT_DEVICE_IDENTITY_PATH") {
        return Ok(PathBuf::from(path));
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        return Ok(PathBuf::from(local_app_data)
            .join("Vectant")
            .join("LocalSupport")
            .join("device-identity.json"));
    }
    if let Ok(home) = std::env::var("HOME") {
        return Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("vectant-local-support")
            .join("device-identity.json"));
    }
    Ok(std::env::current_dir()?
        .join(".vectant-local-support")
        .join("device-identity.json"))
}
