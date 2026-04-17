//! Multi-peer WebRTC scaffolding for the `observer`-role co-attach path.
//!
//! This module is **the worker-side companion** to the signaling-server's
//! observer role (`backend/synthi-webrtc-compiler/signaling-server/src/main.rs`).
//! The signaling-server already routes SDP/ICE between worker, browser, and
//! observer peers; what's missing today — tracked as `AGENT_MCP_STATUS §4.2` —
//! is worker-side scaffolding that can actually own N `RTCPeerConnection`s and
//! fan the RTP stream + HMR status messages to each of them.
//!
//! The modules here are **scaffolding, not wiring**. They compile, pass unit
//! tests, and expose a clean API, but `main.rs` doesn't use them yet — full
//! integration is a multi-PC refactor across 300+ LOC of the main signal
//! loop and carries a real production-stability risk that warrants its own
//! commit cycle. See `G3_PHASE_B_INTEGRATION.md` in this directory for the
//! remaining steps.
//!
//! The API shapes here are tied to the refined-plan Path B sub-manifest and
//! the ultraplan §4.16 presence model, so future wiring is a drop-in rather
//! than a re-design.

pub mod peer_registry;
pub mod track_fanout;

pub use peer_registry::{PeerHandle, PeerRegistry, PeerRole, RegistryInsertOutcome};
pub use track_fanout::{FanoutStats, TrackFanout, TrackKind};
