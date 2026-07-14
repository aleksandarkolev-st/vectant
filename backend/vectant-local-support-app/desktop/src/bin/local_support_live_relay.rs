//! Feature-gated probe for live staging relay tests.
//! This uses the production RelayClient and device-proof implementation but is
//! excluded from the desktop production package.

#[path = "../relay_client.rs"]
#[allow(dead_code)]
mod relay_client;

use std::path::PathBuf;

use relay_client::{
    ApprovedRelayPayload, RelayClient, RelayControlCommand, RelayOutcome, RelayPoll,
};
use sha2::{Digest, Sha256};
use vectant_local_support_app::pair::DeviceIdentityStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let endpoint = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("relay endpoint is required"))?;
    let identity_path = PathBuf::from(
        args.next()
            .ok_or_else(|| anyhow::anyhow!("identity path is required"))?,
    );
    let session_id = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("session id is required"))?;
    let action = args
        .next()
        .ok_or_else(|| anyhow::anyhow!("relay action is required"))?;
    let identity = DeviceIdentityStore::new(identity_path).load_or_create()?;
    let client = RelayClient::new(&endpoint).map_err(anyhow::Error::msg)?;

    match action.as_str() {
        "identity" => {
            println!(
                "LIVE_RELAY_IDENTITY {}",
                serde_json::to_string(&identity.public_identity())?
            );
        }
        "poll" => match client
            .poll(&identity, &session_id)
            .await
            .map_err(anyhow::Error::msg)?
        {
            RelayPoll::Idle => println!(r#"{{"decision":"relay_idle"}}"#),
            RelayPoll::Revoked => println!(r#"{{"decision":"relay_revoked"}}"#),
            RelayPoll::Control(command) => {
                println!("{}", serde_json::to_string(&*command)?);
            }
            RelayPoll::Delivery(delivery) => {
                println!("{}", serde_json::to_string(&*delivery)?);
            }
        },
        "outcome" => {
            let request_id = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("request id is required"))?;
            let lease_id = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("lease id is required"))?;
            let decision = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("outcome decision is required"))?;
            client
                .report_outcome(
                    &identity,
                    &session_id,
                    &RelayOutcome {
                        request_id: &request_id,
                        lease_id: &lease_id,
                        decision: &decision,
                        bytes_sent: 0,
                        redaction_count: 1,
                        scanner_version: "scanner-live-test",
                        reason: "local_review_required",
                    },
                )
                .await
                .map_err(anyhow::Error::msg)?;
            println!(
                "{}",
                serde_json::json!({ "decision": decision, "bytes_sent": 0 })
            );
        }
        "control-outcome" => {
            let command_id = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("control command id is required"))?;
            let lease_id = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("control lease id is required"))?;
            let decision = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("control outcome decision is required"))?;
            let reason = args
                .next()
                .unwrap_or_else(|| "live_relay_control_test".to_string());
            client
                .report_control_outcome(
                    &identity,
                    &session_id,
                    &RelayControlCommand {
                        command_id,
                        session_id: session_id.clone(),
                        account_id: "acct_live_relay".to_string(),
                        org_id: "org_live_relay".to_string(),
                        workspace_id: "wk_live_relay".to_string(),
                        device_fingerprint: identity.public_identity().device_fingerprint,
                        action: "pause_session".to_string(),
                        port: None,
                        expires_at: "2099-01-01T00:00:00Z".to_string(),
                        lease_id,
                    },
                    &decision,
                    &reason,
                )
                .await
                .map_err(anyhow::Error::msg)?;
            println!(
                "{}",
                serde_json::json!({ "decision": decision, "reason": reason })
            );
        }
        "upload" => {
            let request_id = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("request id is required"))?;
            let content = args
                .next()
                .ok_or_else(|| anyhow::anyhow!("content is required"))?;
            let content_sha256 =
                format!("sha256:{}", hex::encode(Sha256::digest(content.as_bytes())));
            let bytes_sent = client
                .upload_approved_payload(
                    &identity,
                    &session_id,
                    &ApprovedRelayPayload {
                        request_id: &request_id,
                        content: &content,
                        content_sha256: &content_sha256,
                        redaction_count: 1,
                        scanner_version: "scanner-live-test",
                    },
                )
                .await
                .map_err(anyhow::Error::msg)?;
            println!(
                "{}",
                serde_json::json!({ "decision": "sent", "bytes_sent": bytes_sent })
            );
        }
        other => return Err(anyhow::anyhow!("unsupported relay action: {other}")),
    }
    Ok(())
}
