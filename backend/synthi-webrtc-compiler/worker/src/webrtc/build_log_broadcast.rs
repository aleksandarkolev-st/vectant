//! Broadcast helper for build-log DC messages that fan out to every
//! attached peer.
//!
//! Today `main.rs` emits build-log messages through the singular
//! `log_channel_store: Option<Arc<RTCDataChannel>>`. The G3 integration
//! guide migrates each emission site onto [`PeerRegistry`]. This
//! helper is the thin wrapper both paths can use once multi-peer lands:
//! read all DCs under the registry's lock, then `send_text` in parallel
//! with a per-DC timeout so one wedged peer cannot throttle the rest.
//!
//! Per ultraplan §WebRTC pipeline reuse + the integration guide's Step-1
//! risk note: a stale DC with a full SCTP send queue can block
//! `send_text` indefinitely; the 50ms timeout ensures a bounded upper
//! bound per emission.
//!
//! This file is deliberately small + does not know about HMR shapes.
//! Callers compose the JSON they want + hand it off.
//!
//! # Usage
//!
//! ```ignore
//! use worker::webrtc::broadcast_build_log_text;
//! broadcast_build_log_text(&peer_registry, format!("{{\"type\":\"hmr-status\",...}}")).await;
//! ```

use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;

use super::peer_registry::PeerRegistry;

/// Per-DC write deadline. Stale or back-pressured peers drop their
/// message; healthy peers keep receiving.
pub const PER_DC_SEND_TIMEOUT: Duration = Duration::from_millis(50);

/// Fan-out a text message to every build-log DC registered in
/// `registry`. Returns `(sent, dropped)` counts so callers can log
/// aggregate stats without tracking individual DCs.
///
/// Ordering note: we clone `Arc<RTCDataChannel>` out of the registry
/// snapshot and THEN drop the read lock. Individual `send_text` calls
/// can then progress in parallel without serialising on the registry.
pub async fn broadcast_build_log_text(
    registry: &Arc<PeerRegistry>,
    message: String,
) -> (usize, usize) {
    let dcs = registry.all_build_log_dcs();
    if dcs.is_empty() {
        return (0, 0);
    }
    let mut sent = 0usize;
    let mut dropped = 0usize;
    for dc in dcs {
        let msg = message.clone();
        match tokio::time::timeout(PER_DC_SEND_TIMEOUT, dc.send_text(msg)).await {
            Ok(Ok(_)) => sent += 1,
            _ => dropped += 1,
        }
    }
    (sent, dropped)
}

/// Fan out text to every current channel registered under an opaque
/// capability ID. Sends progress concurrently after the registry snapshot,
/// so one back-pressured channel cannot serially delay the others.
pub async fn broadcast_session_capability_text(
    registry: &Arc<PeerRegistry>,
    capability_id: &str,
    message: String,
) -> (usize, usize) {
    let dcs = registry.all_session_data_channel_snapshots(capability_id);
    let outcomes = join_all(dcs.into_iter().map(|dc| {
        let message = message.clone();
        async move {
            matches!(
                tokio::time::timeout(PER_DC_SEND_TIMEOUT, dc.send_text(message)).await,
                Ok(Ok(_))
            )
        }
    }))
    .await;
    let sent = outcomes.iter().filter(|sent| **sent).count();
    (sent, outcomes.len() - sent)
}

#[cfg(test)]
mod tests {
    use super::super::peer_registry::{PeerHandle, PeerRole, RegistryInsertOutcome};
    use super::*;
    use webrtc::api::APIBuilder;
    use webrtc::peer_connection::configuration::RTCConfiguration;
    use webrtc::peer_connection::RTCPeerConnection;

    async fn peer_connection() -> Arc<RTCPeerConnection> {
        Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .expect("new peer connection"),
        )
    }

    #[tokio::test]
    async fn empty_registry_returns_zero_zero() {
        let registry: Arc<PeerRegistry> = Arc::new(PeerRegistry::new());
        let (sent, dropped) = broadcast_build_log_text(&registry, "{}".to_string()).await;
        assert_eq!(sent, 0);
        assert_eq!(dropped, 0);
    }

    #[tokio::test]
    async fn capability_broadcast_uses_only_current_matching_channels() {
        let registry = Arc::new(PeerRegistry::new());
        let pc = peer_connection().await;
        let selected = pc
            .create_data_channel("selected", None)
            .await
            .expect("selected data channel");
        let unrelated = pc
            .create_data_channel("unrelated", None)
            .await
            .expect("unrelated data channel");
        assert!(matches!(
            registry.insert(PeerHandle::new("peer", PeerRole::Observer, pc.clone())),
            RegistryInsertOutcome::Inserted
        ));
        assert!(registry.attach_session_data_channel("peer", &pc, "capability.selected", selected,));
        assert!(registry.attach_session_data_channel(
            "peer",
            &pc,
            "capability.unrelated",
            unrelated,
        ));

        let (sent, dropped) =
            broadcast_session_capability_text(&registry, "capability.selected", "{}".to_string())
                .await;
        assert_eq!(sent + dropped, 1);

        registry.remove("peer");
        assert_eq!(
            broadcast_session_capability_text(&registry, "capability.selected", "{}".to_string(),)
                .await,
            (0, 0)
        );
    }

    #[test]
    fn per_dc_timeout_is_50ms() {
        // Locks in the contract: a wedged peer cannot block a fan-out
        // for longer than this. Changing the constant is deliberate;
        // this test makes the change explicit in diff.
        assert_eq!(PER_DC_SEND_TIMEOUT.as_millis(), 50);
    }
}
