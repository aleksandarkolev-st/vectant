//! Feature-gated daemon used only by live local integration tests.
//! The production artifact is the Tauri desktop app; this binary is excluded
//! unless `--features live-test-daemon` is explicitly requested.

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
    let workspace_id = "wk_live_test";
    let policy = WorkspacePolicy::new(workspace, workspace_id, SecretScanner::default())?;
    let identity_path = std::env::var("VECTANT_LOCAL_SUPPORT_DEVICE_IDENTITY_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("vectant-live-test-device.json"));
    let identity = DeviceIdentityStore::new(identity_path).load_or_create()?;
    let session = SessionGuard::new_bound_device(
        "acct_live_test",
        "org_live_test",
        workspace_id,
        identity.public_identity().device_fingerprint,
        Duration::from_secs(30 * 60),
    );
    let audit_path = std::env::var("VECTANT_LOCAL_SUPPORT_AUDIT_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("vectant-live-test-audit.json"));
    let state = AppState::new_with_audit_store(
        session,
        policy,
        LocalAuditStore::new(audit_path, 1, SecretScanner::default()),
    );
    let address = bind_loopback(state.clone()).await?;
    println!("LIVE_TEST_DAEMON_READY http://{address}");
    tokio::signal::ctrl_c().await?;
    shutdown_cleanup(&state, "live_test_shutdown").await?;
    Ok(())
}
