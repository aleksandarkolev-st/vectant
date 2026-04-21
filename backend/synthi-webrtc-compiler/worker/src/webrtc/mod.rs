//! Multi-peer WebRTC wiring for the `observer`-role co-attach path.
//!
//! This module is **the worker-side companion** to the signaling-server's
//! observer role (`backend/synthi-webrtc-compiler/signaling-server/src/main.rs`).
//! The signaling-server routes SDP/ICE between worker, browser, and
//! observer peers, stamping each forwarded message with the sender's
//! `peer_id` + `role`; the worker consumes those stamps to maintain
//! N `RTCPeerConnection`s (one per peer) and fan the RTP stream + HMR
//! status messages to each of them through:
//!
//!   - [`PeerRegistry`] — owns `Arc<PeerHandle>`s keyed by `peer_id`,
//!     enforces single-slot Browser eviction vs. multi-slot Observer.
//!   - [`TrackFanout`] — `broadcast::Sender<Arc<Packet>>` driving per-peer
//!     dispatch tasks; GStreamer writes once, every peer's subscribed
//!     track receives the packet independently.
//!   - [`broadcast_build_log_text`] — per-DC 50ms-timeout fan-out so a
//!     wedged peer's build-log DC can't throttle the rest.
//!
//! See `AGENT_MCP_STATUS.md` §4.2 for the full shipped surface.

pub mod build_log_broadcast;
pub mod peer_registry;
pub mod track_fanout;

pub use build_log_broadcast::{broadcast_build_log_text, PER_DC_SEND_TIMEOUT};
pub use peer_registry::{PeerHandle, PeerRegistry, PeerRole, RegistryInsertOutcome};
pub use track_fanout::{FanoutStats, TrackFanout, TrackKind};

/// Fallback peer_id for legacy clients (pre-Phase-B Synthi frontend) that
/// don't stamp `peer_id` on their offers. The signal loop routes under
/// this key when `parsed.peer_id` is `None`, preserving byte-identical
/// wire behavior for existing browsers. Once the frontend always stamps,
/// this constant can be removed.
pub const DEFAULT_BROWSER_PEER_ID: &str = "default-browser";
