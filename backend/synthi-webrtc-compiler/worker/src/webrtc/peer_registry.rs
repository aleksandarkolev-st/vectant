//! Per-session peer registry.
//!
//! The worker tracks `N` `RTCPeerConnection`s per session: one browser
//! (authoritative) + zero or more observers (read-mostly) + optionally
//! `mcp_agent`s (phase-4 scoped role). Each peer gets its own PC,
//! build-log DC, and per-kind `TrackLocalStaticRTP` subscribed to the
//! session-wide `TrackFanout`.
//!
//! `PeerRegistry` is the holder. It enforces the per-role occupancy
//! rules that match the signaling-server's routing logic:
//!
//!   - exactly one `worker` peer (enforced elsewhere — this registry is
//!     the worker's own view of *its peers*, not itself)
//!   - at most one `browser` (newer browser evicts older)
//!   - any number of `observer` (appended without eviction)
//!   - at most one `mcp_agent` per agent-id
//!
//! The registry is **pure data**. It doesn't mutate `RTCPeerConnection`
//! state or close DCs on eviction — callers (main.rs's signal loop +
//! `create_peer`'s connection-state callback) own the lifecycle and call
//! into the registry to record decisions. Late-populated fields
//! (build-log DC, tracks, fanout subs) use interior `Mutex<Option<T>>`
//! so mutation through `Arc<PeerHandle>` leaves the Arc untouched —
//! the `FanoutSubscription` aborts on drop, and we must never drop a
//! live peer's Arc while replacing a sub.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::SystemTime;

use webrtc::data_channel::RTCDataChannel;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;

use super::track_fanout::FanoutSubscription;

/// Role a peer registered as.
///
/// Mirrors `signaling-server/src/main.rs::PeerRole`: two-way enum on that
/// side, three-way here because the worker distinguishes between a human
/// browser and a machine mcp-agent once phase 4 lands (today mcp-agent is
/// not routable; reserved).
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum PeerRole {
    /// Authoritative human browser. At most one per session.
    Browser,
    /// Read-mostly peer (MCP agent or remote pair-programming observer).
    /// Any number per session.
    Observer,
    /// Phase 4 scoped agent role. Not routable today.
    McpAgent,
}

impl PeerRole {
    /// Parse the role string sent on signaling registration. Unknown strings
    /// default to `Observer` (conservative — grants fewer privileges than
    /// `Browser`).
    pub fn from_wire(s: &str) -> Self {
        match s {
            "browser" => Self::Browser,
            "observer" => Self::Observer,
            "mcp_agent" | "mcp-agent" => Self::McpAgent,
            _ => Self::Observer,
        }
    }

    /// `true` if multiple peers of this role may coexist on a session.
    /// Browser is single-slot (eviction on re-register); observer / mcp-agent
    /// are multi-slot.
    pub fn is_multi_slot(self) -> bool {
        matches!(self, Self::Observer | Self::McpAgent)
    }
}

/// One peer's complete state. Populated incrementally: PC first, then
/// build-log DC as it opens, then video/audio tracks + fanout
/// subscriptions when they're attached to the PC's transceivers during
/// `create_peer`.
///
/// Late-populated fields use `Mutex<Option<T>>` so callers can mutate
/// them without cloning the whole handle — `FanoutSubscription` owns a
/// `tokio::task::JoinHandle` that aborts on drop, so a "clone then
/// replace" pattern would sever the fan-out to a peer that's still
/// live. The handle itself stays behind `Arc<PeerHandle>` in the
/// registry; mutation through the Mutex leaves the Arc untouched.
///
/// Dropping the handle (on `registry.remove(peer_id)` or registry
/// shutdown) drops the `video_sub`/`audio_sub` along with it, aborting
/// the per-peer dispatch task and preventing writes to a detached track.
pub struct PeerHandle {
    pub peer_id: String,
    pub role: PeerRole,
    pub pc: Arc<RTCPeerConnection>,
    pub build_log_dc: Mutex<Option<Arc<RTCDataChannel>>>,
    pub video_track: Mutex<Option<Arc<TrackLocalStaticRTP>>>,
    pub audio_track: Mutex<Option<Arc<TrackLocalStaticRTP>>>,
    pub video_sub: Mutex<Option<FanoutSubscription>>,
    pub audio_sub: Mutex<Option<FanoutSubscription>>,
    pub attached_at: SystemTime,
}

impl PeerHandle {
    pub fn new(peer_id: impl Into<String>, role: PeerRole, pc: Arc<RTCPeerConnection>) -> Self {
        Self {
            peer_id: peer_id.into(),
            role,
            pc,
            build_log_dc: Mutex::new(None),
            video_track: Mutex::new(None),
            audio_track: Mutex::new(None),
            video_sub: Mutex::new(None),
            audio_sub: Mutex::new(None),
            attached_at: SystemTime::now(),
        }
    }

    /// Snapshot the current build-log DC, if attached. Cheap — clones
    /// the inner `Arc<RTCDataChannel>` under the mutex and releases.
    pub fn build_log_dc_snapshot(&self) -> Option<Arc<RTCDataChannel>> {
        self.build_log_dc
            .lock()
            .expect("build_log_dc mutex poisoned")
            .clone()
    }

    pub fn video_track_snapshot(&self) -> Option<Arc<TrackLocalStaticRTP>> {
        self.video_track
            .lock()
            .expect("video_track mutex poisoned")
            .clone()
    }

    pub fn audio_track_snapshot(&self) -> Option<Arc<TrackLocalStaticRTP>> {
        self.audio_track
            .lock()
            .expect("audio_track mutex poisoned")
            .clone()
    }
}

/// Outcome of `insert` — tells the caller whether a previous peer was
/// evicted and must be torn down (close PC, remove from signaling).
pub enum RegistryInsertOutcome {
    /// No previous peer occupied this slot.
    Inserted,
    /// A previous single-slot peer (only Browser today) was displaced; the
    /// caller is responsible for closing its PC.
    Evicted(Arc<PeerHandle>),
}

/// Thread-safe holder of all peers attached to this worker's session.
///
/// Stores `Arc<PeerHandle>` so callers can cheaply pass handles around
/// without locking the registry for the duration of a fan-out iteration.
#[derive(Default)]
pub struct PeerRegistry {
    peers: RwLock<HashMap<String, Arc<PeerHandle>>>,
    // Acquire `peers` before this map in every operation that needs both.
    session_data_channels: RwLock<HashMap<String, HashMap<String, Arc<RTCDataChannel>>>>,
}

impl PeerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a newly-registered peer. Returns `Evicted(previous)` when a
    /// single-slot role (Browser) already had a peer.
    ///
    /// Multi-slot roles (Observer / McpAgent) always `Inserted`; the caller
    /// is responsible for ensuring `peer_id` is unique across re-registrations
    /// (the signaling-server assigns unique peer-ids today).
    pub fn insert(&self, handle: PeerHandle) -> RegistryInsertOutcome {
        let new = Arc::new(handle);
        let new_peer_id = new.peer_id.clone();
        let mut peers = self.peers.write().expect("peer registry poisoned");
        let mut session_data_channels = self
            .session_data_channels
            .write()
            .expect("session data channels poisoned");

        // Browser slot eviction: at most one Browser per session. On
        // re-registration we swap the old one out and return it so the
        // caller can close its PC + remove from signaling.
        if matches!(new.role, PeerRole::Browser) {
            if let Some(existing_id) = peers
                .iter()
                .find(|(_, h)| matches!(h.role, PeerRole::Browser))
                .map(|(id, _)| id.clone())
            {
                if existing_id != new_peer_id {
                    let evicted = peers.remove(&existing_id).expect("just located");
                    session_data_channels.remove(&existing_id);
                    session_data_channels.remove(&new_peer_id);
                    peers.insert(new_peer_id, new);
                    return RegistryInsertOutcome::Evicted(evicted);
                }
            }
        }

        session_data_channels.remove(&new_peer_id);
        peers.insert(new_peer_id, new);
        RegistryInsertOutcome::Inserted
    }

    pub fn remove(&self, peer_id: &str) -> Option<Arc<PeerHandle>> {
        let mut peers = self.peers.write().expect("peer registry poisoned");
        let mut session_data_channels = self
            .session_data_channels
            .write()
            .expect("session data channels poisoned");
        let removed = peers.remove(peer_id);
        session_data_channels.remove(peer_id);
        removed
    }

    pub fn get(&self, peer_id: &str) -> Option<Arc<PeerHandle>> {
        self.peers
            .read()
            .expect("peer registry poisoned")
            .get(peer_id)
            .cloned()
    }

    /// Snapshot a registered peer's channel for an opaque, non-empty
    /// capability ID.
    pub fn session_data_channel_snapshot(
        &self,
        peer_id: &str,
        capability_id: &str,
    ) -> Option<Arc<RTCDataChannel>> {
        if capability_id.is_empty() {
            return None;
        }

        let peers = self.peers.read().expect("peer registry poisoned");
        if !peers.contains_key(peer_id) {
            return None;
        }
        let session_data_channels = self
            .session_data_channels
            .read()
            .expect("session data channels poisoned");
        session_data_channels
            .get(peer_id)
            .and_then(|channels| channels.get(capability_id))
            .cloned()
    }

    pub fn contains(&self, peer_id: &str) -> bool {
        self.peers
            .read()
            .expect("peer registry poisoned")
            .contains_key(peer_id)
    }

    pub fn len(&self) -> usize {
        self.peers.read().expect("peer registry poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.peers
            .read()
            .expect("peer registry poisoned")
            .is_empty()
    }

    pub fn clear(&self) {
        let mut peers = self.peers.write().expect("peer registry poisoned");
        let mut session_data_channels = self
            .session_data_channels
            .write()
            .expect("session data channels poisoned");
        peers.clear();
        session_data_channels.clear();
    }

    /// Snapshot every currently-registered peer. Cheap `Arc` clones so
    /// callers can iterate without holding the read lock across `.await`.
    pub fn all_peers(&self) -> Vec<Arc<PeerHandle>> {
        self.peers
            .read()
            .expect("peer registry poisoned")
            .values()
            .cloned()
            .collect()
    }

    /// Snapshot channels for an opaque, non-empty capability ID across all
    /// currently registered peers.
    pub fn all_session_data_channel_snapshots(
        &self,
        capability_id: &str,
    ) -> Vec<Arc<RTCDataChannel>> {
        if capability_id.is_empty() {
            return Vec::new();
        }

        let peers = self.peers.read().expect("peer registry poisoned");
        let session_data_channels = self
            .session_data_channels
            .read()
            .expect("session data channels poisoned");
        peers
            .keys()
            .filter_map(|peer_id| {
                session_data_channels
                    .get(peer_id)
                    .and_then(|channels| channels.get(capability_id))
                    .cloned()
            })
            .collect()
    }

    /// Snapshot all registered build-log DCs. Used when an HMR status event
    /// needs to fan out to every peer (browser + all observers).
    pub fn all_build_log_dcs(&self) -> Vec<Arc<RTCDataChannel>> {
        self.peers
            .read()
            .expect("peer registry poisoned")
            .values()
            .filter_map(|h| h.build_log_dc_snapshot())
            .collect()
    }

    /// Snapshot all registered video tracks. Less useful under
    /// `TrackFanout` (per-peer tasks write directly) but retained for
    /// legacy callers that iterate tracks manually.
    pub fn all_video_tracks(&self) -> Vec<Arc<TrackLocalStaticRTP>> {
        self.peers
            .read()
            .expect("peer registry poisoned")
            .values()
            .filter_map(|h| h.video_track_snapshot())
            .collect()
    }

    pub fn all_audio_tracks(&self) -> Vec<Arc<TrackLocalStaticRTP>> {
        self.peers
            .read()
            .expect("peer registry poisoned")
            .values()
            .filter_map(|h| h.audio_track_snapshot())
            .collect()
    }

    /// Count peers per role. Feeds the `session.attached_humans` and
    /// `session.attached_agents` fields on the `synthi_attach` envelope.
    pub fn count_by_role(&self) -> HashMap<PeerRole, usize> {
        let peers = self.peers.read().expect("peer registry poisoned");
        let mut counts = HashMap::new();
        for h in peers.values() {
            *counts.entry(h.role).or_insert(0) += 1;
        }
        counts
    }

    /// Attach a channel to an already-registered peer under an opaque,
    /// non-empty capability ID when the peer still owns `expected_pc`. A
    /// duplicate peer/capability attachment is a last-write-wins registry
    /// replacement; externally-held channels are not closed by this registry.
    pub fn attach_session_data_channel(
        &self,
        peer_id: &str,
        expected_pc: &Arc<RTCPeerConnection>,
        capability_id: &str,
        dc: Arc<RTCDataChannel>,
    ) -> bool {
        if capability_id.is_empty() {
            return false;
        }

        let peers = self.peers.read().expect("peer registry poisoned");
        let Some(peer) = peers.get(peer_id) else {
            return false;
        };
        if !Arc::ptr_eq(&peer.pc, expected_pc) {
            return false;
        }

        self.session_data_channels
            .write()
            .expect("session data channels poisoned")
            .entry(peer_id.to_owned())
            .or_default()
            .insert(capability_id.to_owned(), dc);
        true
    }

    /// Attach a build-log DC to an already-registered peer. Returns `true`
    /// if the peer existed. Mutation is through the handle's interior mutex
    /// so the Arc in the registry stays untouched.
    pub fn attach_build_log(&self, peer_id: &str, dc: Arc<RTCDataChannel>) -> bool {
        let peers = self.peers.read().expect("peer registry poisoned");
        if let Some(existing) = peers.get(peer_id) {
            *existing
                .build_log_dc
                .lock()
                .expect("build_log_dc mutex poisoned") = Some(dc);
            true
        } else {
            false
        }
    }

    pub fn attach_video_track(&self, peer_id: &str, track: Arc<TrackLocalStaticRTP>) -> bool {
        let peers = self.peers.read().expect("peer registry poisoned");
        if let Some(existing) = peers.get(peer_id) {
            *existing
                .video_track
                .lock()
                .expect("video_track mutex poisoned") = Some(track);
            true
        } else {
            false
        }
    }

    pub fn attach_audio_track(&self, peer_id: &str, track: Arc<TrackLocalStaticRTP>) -> bool {
        let peers = self.peers.read().expect("peer registry poisoned");
        if let Some(existing) = peers.get(peer_id) {
            *existing
                .audio_track
                .lock()
                .expect("audio_track mutex poisoned") = Some(track);
            true
        } else {
            false
        }
    }

    /// Store a `FanoutSubscription` on the peer. Dropping it aborts the
    /// per-peer dispatch task; replacing it aborts the prior task first
    /// (a peer rejoining with a fresh track would otherwise double-write).
    pub fn attach_video_sub(&self, peer_id: &str, sub: FanoutSubscription) -> bool {
        let peers = self.peers.read().expect("peer registry poisoned");
        if let Some(existing) = peers.get(peer_id) {
            *existing.video_sub.lock().expect("video_sub mutex poisoned") = Some(sub);
            true
        } else {
            false
        }
    }

    pub fn attach_audio_sub(&self, peer_id: &str, sub: FanoutSubscription) -> bool {
        let peers = self.peers.read().expect("peer registry poisoned");
        if let Some(existing) = peers.get(peer_id) {
            *existing.audio_sub.lock().expect("audio_sub mutex poisoned") = Some(sub);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webrtc::data_channel::data_channel_state::RTCDataChannelState;

    // The webrtc-rs types can't be constructed without real config; build a
    // PC in a helper so tests that need one pay once. The helper is async
    // because `APIBuilder::new().build().new_peer_connection(...)` is.
    async fn mk_pc() -> Arc<RTCPeerConnection> {
        use webrtc::api::APIBuilder;
        use webrtc::peer_connection::configuration::RTCConfiguration;
        let api = APIBuilder::new().build();
        let pc = api
            .new_peer_connection(RTCConfiguration::default())
            .await
            .expect("new pc");
        Arc::new(pc)
    }

    #[test]
    fn role_parse_roundtrip() {
        assert_eq!(PeerRole::from_wire("browser"), PeerRole::Browser);
        assert_eq!(PeerRole::from_wire("observer"), PeerRole::Observer);
        assert_eq!(PeerRole::from_wire("mcp_agent"), PeerRole::McpAgent);
        assert_eq!(PeerRole::from_wire("mcp-agent"), PeerRole::McpAgent);
        // Unknown falls through to Observer — conservative.
        assert_eq!(PeerRole::from_wire("worker"), PeerRole::Observer);
        assert_eq!(PeerRole::from_wire(""), PeerRole::Observer);
    }

    #[test]
    fn role_multi_slot_matches_signaling_rules() {
        assert!(!PeerRole::Browser.is_multi_slot());
        assert!(PeerRole::Observer.is_multi_slot());
        assert!(PeerRole::McpAgent.is_multi_slot());
    }

    #[tokio::test]
    async fn insert_and_remove_observer() {
        let reg = PeerRegistry::new();
        let pc = mk_pc().await;
        let h = PeerHandle::new("obs-1", PeerRole::Observer, pc);
        match reg.insert(h) {
            RegistryInsertOutcome::Inserted => {}
            RegistryInsertOutcome::Evicted(_) => panic!("observer inserted should not evict"),
        }
        assert_eq!(reg.len(), 1);
        assert!(reg.contains("obs-1"));
        let removed = reg.remove("obs-1");
        assert!(removed.is_some());
        assert!(reg.is_empty());
    }

    #[tokio::test]
    async fn inserting_a_second_browser_evicts_the_first() {
        let reg = PeerRegistry::new();
        reg.insert(PeerHandle::new("b1", PeerRole::Browser, mk_pc().await));
        assert_eq!(reg.len(), 1);

        let outcome = reg.insert(PeerHandle::new("b2", PeerRole::Browser, mk_pc().await));
        match outcome {
            RegistryInsertOutcome::Evicted(evicted) => assert_eq!(evicted.peer_id, "b1"),
            RegistryInsertOutcome::Inserted => panic!("expected eviction"),
        }
        assert_eq!(reg.len(), 1);
        assert!(reg.contains("b2"));
        assert!(!reg.contains("b1"));
    }

    #[tokio::test]
    async fn observers_coexist_with_a_browser() {
        let reg = PeerRegistry::new();
        reg.insert(PeerHandle::new("b1", PeerRole::Browser, mk_pc().await));
        reg.insert(PeerHandle::new("o1", PeerRole::Observer, mk_pc().await));
        reg.insert(PeerHandle::new("o2", PeerRole::Observer, mk_pc().await));
        assert_eq!(reg.len(), 3);
        let counts = reg.count_by_role();
        assert_eq!(counts.get(&PeerRole::Browser).copied().unwrap_or(0), 1);
        assert_eq!(counts.get(&PeerRole::Observer).copied().unwrap_or(0), 2);
    }

    #[tokio::test]
    async fn arbitrary_session_data_channel_capabilities_coexist() {
        let reg = PeerRegistry::new();
        let pc = mk_pc().await;
        let alpha = pc
            .create_data_channel("alpha", None)
            .await
            .expect("alpha data channel");
        let beta = pc
            .create_data_channel("beta", None)
            .await
            .expect("beta data channel");
        let legacy = pc
            .create_data_channel("legacy", None)
            .await
            .expect("legacy data channel");
        reg.insert(PeerHandle::new("peer", PeerRole::Observer, pc.clone()));

        assert!(reg.attach_session_data_channel("peer", &pc, "capability.alpha", alpha.clone()));
        assert!(reg.attach_session_data_channel("peer", &pc, "capability.beta", beta.clone()));
        assert!(reg.attach_build_log("peer", legacy.clone()));

        let observed_alpha = reg
            .session_data_channel_snapshot("peer", "capability.alpha")
            .expect("alpha capability attached");
        let observed_beta = reg
            .session_data_channel_snapshot("peer", "capability.beta")
            .expect("beta capability attached");
        assert!(Arc::ptr_eq(&observed_alpha, &alpha));
        assert!(Arc::ptr_eq(&observed_beta, &beta));
        let observed_legacy = reg
            .get("peer")
            .and_then(|peer| peer.build_log_dc_snapshot())
            .expect("legacy channel attached");
        assert!(Arc::ptr_eq(&observed_legacy, &legacy));
        assert_eq!(reg.all_build_log_dcs().len(), 1);
        assert_eq!(
            reg.all_session_data_channel_snapshots("capability.alpha")
                .len(),
            1
        );
        assert_eq!(
            reg.all_session_data_channel_snapshots("capability.beta")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn attaching_a_session_data_channel_to_an_unknown_peer_returns_false() {
        let reg = PeerRegistry::new();
        let pc = mk_pc().await;
        let dc = pc
            .create_data_channel("unknown", None)
            .await
            .expect("unknown data channel");

        assert!(!reg.attach_session_data_channel("missing", &pc, "capability.test", dc));
        assert!(reg
            .session_data_channel_snapshot("missing", "capability.test")
            .is_none());
        assert!(reg
            .all_session_data_channel_snapshots("capability.test")
            .is_empty());
    }

    #[tokio::test]
    async fn empty_capability_id_is_rejected_without_mutating_registry_state() {
        let reg = PeerRegistry::new();
        let pc = mk_pc().await;
        let dc = pc
            .create_data_channel("empty", None)
            .await
            .expect("empty data channel");
        reg.insert(PeerHandle::new("peer", PeerRole::Observer, pc.clone()));

        assert!(!reg.attach_session_data_channel("peer", &pc, "", dc));
        assert!(reg.session_data_channel_snapshot("peer", "").is_none());
        assert!(reg.all_session_data_channel_snapshots("").is_empty());
    }

    #[tokio::test]
    async fn duplicate_capability_attachment_replaces_registry_entry() {
        let reg = PeerRegistry::new();
        let pc = mk_pc().await;
        let first = pc
            .create_data_channel("first", None)
            .await
            .expect("first data channel");
        let replacement = pc
            .create_data_channel("replacement", None)
            .await
            .expect("replacement data channel");
        reg.insert(PeerHandle::new("peer", PeerRole::Observer, pc.clone()));

        assert!(reg.attach_session_data_channel("peer", &pc, "capability.replace", first.clone()));
        assert!(reg.attach_session_data_channel(
            "peer",
            &pc,
            "capability.replace",
            replacement.clone()
        ));

        let observed = reg
            .session_data_channel_snapshot("peer", "capability.replace")
            .expect("replacement capability attached");
        assert!(Arc::ptr_eq(&observed, &replacement));
        assert!(!Arc::ptr_eq(&observed, &first));
        assert_ne!(first.ready_state(), RTCDataChannelState::Closed);
        assert_eq!(
            reg.all_session_data_channel_snapshots("capability.replace")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn stale_connection_cannot_attach_to_re_registered_peer_id() {
        let reg = PeerRegistry::new();
        let stale_pc = mk_pc().await;
        let stale_dc = stale_pc
            .create_data_channel("stale", None)
            .await
            .expect("stale data channel");
        reg.insert(PeerHandle::new(
            "peer",
            PeerRole::Observer,
            stale_pc.clone(),
        ));

        let current_pc = mk_pc().await;
        let current_dc = current_pc
            .create_data_channel("current", None)
            .await
            .expect("current data channel");
        reg.insert(PeerHandle::new(
            "peer",
            PeerRole::Observer,
            current_pc.clone(),
        ));

        assert!(!reg.attach_session_data_channel("peer", &stale_pc, "capability.shared", stale_dc));
        assert!(reg.attach_session_data_channel(
            "peer",
            &current_pc,
            "capability.shared",
            current_dc.clone()
        ));
        let observed = reg
            .session_data_channel_snapshot("peer", "capability.shared")
            .expect("current capability attached");
        assert!(Arc::ptr_eq(&observed, &current_dc));
    }

    #[tokio::test]
    async fn replacement_and_browser_eviction_erase_session_data_channels() {
        let reg = PeerRegistry::new();
        let first_pc = mk_pc().await;
        let first_dc = first_pc
            .create_data_channel("first", None)
            .await
            .expect("first data channel");
        reg.insert(PeerHandle::new(
            "first",
            PeerRole::Browser,
            first_pc.clone(),
        ));
        assert!(reg.attach_session_data_channel("first", &first_pc, "capability.shared", first_dc));

        let second_pc = mk_pc().await;
        let second_dc = second_pc
            .create_data_channel("second", None)
            .await
            .expect("second data channel");
        let outcome = reg.insert(PeerHandle::new(
            "second",
            PeerRole::Browser,
            second_pc.clone(),
        ));
        assert!(matches!(outcome, RegistryInsertOutcome::Evicted(_)));
        assert!(reg
            .session_data_channel_snapshot("first", "capability.shared")
            .is_none());
        assert!(reg
            .all_session_data_channel_snapshots("capability.shared")
            .is_empty());

        let replacement_pc = mk_pc().await;
        assert!(reg.attach_session_data_channel(
            "second",
            &second_pc,
            "capability.shared",
            second_dc
        ));
        reg.insert(PeerHandle::new("second", PeerRole::Browser, replacement_pc));
        assert!(reg
            .session_data_channel_snapshot("second", "capability.shared")
            .is_none());
        assert!(reg
            .all_session_data_channel_snapshots("capability.shared")
            .is_empty());
    }

    #[tokio::test]
    async fn removal_and_clear_remove_session_data_channel_visibility() {
        let reg = PeerRegistry::new();
        let first_pc = mk_pc().await;
        let first_dc = first_pc
            .create_data_channel("first", None)
            .await
            .expect("first data channel");
        let second_pc = mk_pc().await;
        let second_dc = second_pc
            .create_data_channel("second", None)
            .await
            .expect("second data channel");

        reg.insert(PeerHandle::new(
            "first",
            PeerRole::Observer,
            first_pc.clone(),
        ));
        reg.insert(PeerHandle::new(
            "second",
            PeerRole::Observer,
            second_pc.clone(),
        ));
        assert!(reg.attach_session_data_channel("first", &first_pc, "capability.shared", first_dc));
        assert!(reg.attach_session_data_channel(
            "second",
            &second_pc,
            "capability.shared",
            second_dc
        ));
        assert_eq!(
            reg.all_session_data_channel_snapshots("capability.shared")
                .len(),
            2
        );

        reg.remove("first");
        assert!(reg
            .session_data_channel_snapshot("first", "capability.shared")
            .is_none());
        assert_eq!(
            reg.all_session_data_channel_snapshots("capability.shared")
                .len(),
            1
        );

        reg.clear();
        assert!(reg
            .session_data_channel_snapshot("second", "capability.shared")
            .is_none());
        assert!(reg
            .all_session_data_channel_snapshots("capability.shared")
            .is_empty());
    }

    #[tokio::test]
    async fn re_registering_the_same_browser_id_is_a_no_op_for_eviction() {
        let reg = PeerRegistry::new();
        reg.insert(PeerHandle::new("b1", PeerRole::Browser, mk_pc().await));
        let outcome = reg.insert(PeerHandle::new("b1", PeerRole::Browser, mk_pc().await));
        // Same peer_id re-registers in place; no eviction of self.
        match outcome {
            RegistryInsertOutcome::Inserted => {}
            RegistryInsertOutcome::Evicted(_) => panic!("self re-register should not evict self"),
        }
        assert_eq!(reg.len(), 1);
    }
}
