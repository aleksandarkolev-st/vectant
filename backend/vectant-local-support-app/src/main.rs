use std::path::PathBuf;
use std::time::Duration;

use vectant_local_support_app::http::{bind_loopback, AppState};
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
    let session = SessionGuard::new(workspace_id, Duration::from_secs(30 * 60));
    let token = session.token_for_pairing_response().to_string();
    let state = AppState::new(session, policy);
    let addr = bind_loopback(state).await?;
    println!("Vectant Local Support listening on http://{addr}");
    println!("Development pairing bearer token: {token}");
    tokio::signal::ctrl_c().await?;
    Ok(())
}
