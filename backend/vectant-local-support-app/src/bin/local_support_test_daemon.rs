//! Feature-gated daemon used only by live local integration tests.
//! The production artifact is the Tauri desktop app; this binary is excluded
//! unless `--features live-test-daemon` is explicitly requested.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

use vectant_local_support_app::audit::LocalAuditStore;
use vectant_local_support_app::full_access::FullAccessCapability;
use vectant_local_support_app::http::{bind_loopback, shutdown_cleanup, AppState};
use vectant_local_support_app::pair::DeviceIdentityStore;
use vectant_local_support_app::scanner::SecretScanner;
use vectant_local_support_app::session::SessionGuard;
use vectant_local_support_app::workspace::WorkspacePolicy;

const TEST_CONTROL_SECRET: &str = "live-test-control-secret-012345678901234567";
const TEST_PROCESS_IDENTITY: &str = "live-test-upstream";

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
    let upstream_port = std::env::args()
        .nth(2)
        .and_then(|value| value.parse::<u16>().ok());
    let mut state = AppState::new_with_audit_store(
        session,
        policy,
        LocalAuditStore::new(audit_path, 1, SecretScanner::default()),
    )?;
    state.set_local_control_secret_for_test(TEST_CONTROL_SECRET);
    // This feature-gated harness models a successfully parsed, explicit test
    // policy ceiling. Production starts with an empty ceiling and only the
    // desktop policy synchronizer may replace it.
    state
        .set_cloud_full_access_capabilities(BTreeSet::from([
            FullAccessCapability::Enroll,
            FullAccessCapability::AutoApprovalEnable,
            FullAccessCapability::GraphRead,
            FullAccessCapability::GraphNodeRequest,
            FullAccessCapability::CommandExecute,
            FullAccessCapability::CommandContextRead,
            FullAccessCapability::WorkspaceFileMutate,
            FullAccessCapability::WorkspaceFileRevert,
            FullAccessCapability::ProcessInventory,
            FullAccessCapability::ProcessListenerMetadata,
            FullAccessCapability::LocalPortDiscover,
            FullAccessCapability::LocalPortUse,
        ]))
        .await;
    let (session_token, preview_token, preview_host) = if let Some(port) = upstream_port {
        let session_id = state.session.lock().await.session_id().to_string();
        let token = state
            .port_approvals
            .lock()
            .await
            .approve_browser_port_grant(&session_id, port, TEST_PROCESS_IDENTITY);
        let session_token = state
            .session
            .lock()
            .await
            .token_for_pairing_response()
            .to_string();
        (
            session_token,
            token.preview_token,
            token.approval.preview_host,
        )
    } else {
        (String::new(), String::new(), String::new())
    };
    let address = bind_loopback(state.clone()).await?;
    let ready_record = format!(
        "LIVE_TEST_DAEMON_READY http://{address} token={session_token} control={TEST_CONTROL_SECRET} preview_token={preview_token} preview_host={preview_host} process_identity={TEST_PROCESS_IDENTITY}"
    );
    println!("{ready_record}");
    // A redirected stdout is block-buffered on Windows. Flush the readiness
    // record so detached live-validation launchers can reliably discover it
    // before the daemon receives any request or shuts down.
    std::io::stdout().flush()?;
    // Windows Task Scheduler does not provide a dependable attached stdout
    // stream. The feature-gated harness may therefore publish its one-line
    // readiness record to a caller-selected local file for live validation.
    if let Some(path) = std::env::var_os("VECTANT_TEST_DAEMON_READY_FILE") {
        std::fs::write(path, ready_record.as_bytes())?;
    }
    // Remote Windows validation runs without an interactive console. In that
    // environment Ctrl+C can resolve as soon as the SSH command detaches, so
    // an explicit test-only keep-alive mode makes the harness deterministic.
    if std::env::var_os("VECTANT_TEST_DAEMON_KEEP_ALIVE").is_some() {
        std::future::pending::<()>().await;
    }
    tokio::signal::ctrl_c().await?;
    shutdown_cleanup(&state, "live_test_shutdown").await?;
    Ok(())
}
