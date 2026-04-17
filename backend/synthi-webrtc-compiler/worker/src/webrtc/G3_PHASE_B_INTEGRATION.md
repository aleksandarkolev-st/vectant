# G3 Phase B — Worker Per-Peer PC Integration

**Status:** modules `peer_registry.rs` + `track_fanout.rs` are scaffolded and unit-tested. `main.rs` is NOT wired to them yet — that's the remaining work described below.

**Why this is staged:** the existing worker `main.rs` singletons (one `pc`, one `log_channel_store: Option<Arc<DC>>`, one track per media kind) are load-bearing across the compile pipeline, the HMR orchestrator, and the input routing. Landing per-peer PC support in one commit risks production stability; splitting it means the main branch is always green.

**Companion doc:** `AGENT_MCP_STATUS.md` §4.2. **Design source:** refined-plan §5 (Path B sub-manifest).

---

## Current state

| What | Status | File |
|------|--------|------|
| Signaling-server observer role | ✅ shipped | `backend/synthi-webrtc-compiler/signaling-server/src/main.rs` |
| `PeerRole::{Browser, Observer, McpAgent}` | ✅ scaffolded | `src/webrtc/peer_registry.rs` |
| `PeerRegistry` — insert / evict / attach-DC-track | ✅ scaffolded + tested | `src/webrtc/peer_registry.rs` |
| `TrackFanout` — broadcast → N tracks, drop-on-lag | ✅ scaffolded + tested | `src/webrtc/track_fanout.rs` |
| Single-PC assumption in `main.rs` | ❌ unchanged | `src/main.rs:615, 1140-1260` |
| Single-DC assumption in `log_channel_store` | ❌ unchanged | `src/main.rs:616, 1283-1296` |
| Single-track write-path in media pipelines | ❌ unchanged | `src/android/webrtc/video_pipeline.rs:614` |
| Per-peer offer handling in signal loop | ❌ unchanged | `src/main.rs:600-900` |

---

## Remaining work (the actual migration)

### Step 1 — Replace `log_channel_store` with `PeerRegistry`

**File:** `src/main.rs`

Today:

```rust
let log_channel_store: Arc<Mutex<Option<Arc<RTCDataChannel>>>> = Arc::new(Mutex::new(None));
// ... every emission:
if let Some(dc) = &*store.lock().await { dc.send_text(msg).await; }
```

Target:

```rust
let peer_registry = Arc::new(webrtc::PeerRegistry::new());
// ... every emission:
for dc in peer_registry.all_build_log_dcs() {
    let _ = dc.send_text(msg.clone()).await;
}
```

Call-sites that change (ripgrep `log_channel_store`): `main.rs:711, 854, 909, 917, 1007, 1035, 1266, 1286, 1298`, plus anywhere in `compiler/stages/runner.rs` that borrows it.

**Risk:** a stale DC can block `send_text` — add a per-DC timeout (50 ms) so one broken peer doesn't throttle the rest.

### Step 2 — Per-peer PC creation on `offer` signaling message

**File:** `src/main.rs:600-900` (the signal loop).

Today the loop assumes one `pc` per worker process; the second browser would immediately conflict over SDP state. Replace the singleton `let mut pc = create_peer(...)` with a `peer_id`-keyed branch:

```rust
SignalMessage { msg_type: "offer", peer_id: Some(pid), sdp, .. } => {
    let pc = create_peer(signal_tx_for_peer(pid.clone()), ice.clone()).await?;
    let role = PeerRole::from_wire(role_str);
    let handle = PeerHandle::new(pid.clone(), role, pc.clone());
    match peer_registry.insert(handle) {
        RegistryInsertOutcome::Evicted(old) => { let _ = old.pc.close().await; }
        RegistryInsertOutcome::Inserted => {}
    }
    wire_peer_channels(&pc, peer_registry.clone(), pid.clone(), ...).await?;
    pc.set_remote_description(...).await?;
    let answer = pc.create_answer(...).await?;
    signal_tx.send(SignalMessage { msg_type: "answer", peer_id: Some(pid), sdp: Some(answer.sdp), .. })?;
}
```

The signaling-server already routes with `peer_id` — see `signaling-server/src/main.rs` where `target_key_for_message` picks destination by `(session, role, peer_id)`.

### Step 3 — Per-peer track subscription in media pipelines

**File:** `src/android/webrtc/video_pipeline.rs:614`

Today:

```rust
let rtp_task = tokio::spawn(async move {
    while let Some(buf) = rtp_rx.recv().await {
        if let Ok(mut packet) = Packet::unmarshal(&mut &buf[..]) {
            // ... SSRC fix-up
            let _ = track_clone.write_rtp(&packet).await;
        }
    }
});
```

Target:

```rust
let video_fanout = Arc::new(TrackFanout::new(TrackKind::Video, 64));
// At peer-attach time (step 2), register the track:
let sub = video_fanout.subscribe_track(peer.video_track.clone());
peer_registry.attach_video_track(&pid, peer.video_track.clone());
// Store `sub` in the PeerHandle; drop it on disconnect.

// The rtp_task dispatches once — all peers get it:
let rtp_task = tokio::spawn(async move {
    while let Some(buf) = rtp_rx.recv().await {
        if let Ok(mut packet) = Packet::unmarshal(&mut &buf[..]) {
            // ... SSRC fix-up
            video_fanout.dispatch(packet);
        }
    }
});
```

Same pattern for audio. **Note:** the placeholder tracks at `main.rs:1179-1232` can be dropped in favor of registering real tracks per-peer; the SDP renegotiation already works because each peer has its own PC.

### Step 4 — Per-peer track lifecycle during HMR reloads

**File:** `src/compiler/stages/runner.rs`

On runtime-path HMR reload the runner currently:

1. Closes the old GStreamer pipeline.
2. Creates new `video_track` / `audio_track`.
3. Replaces them on the sender via `replace_track`.

For multi-peer, step 3 becomes "for each peer's video sender, `replace_track` with a new per-peer `TrackLocalStaticRTP`, and re-subscribe each new track to the fanout". The per-peer tracks are disposable; the fanout is persistent.

### Step 5 — Input arbitration (keep MVP behavior)

**File:** `src/main.rs:1655-` (`terminal` DC's `on_message`)

Today: any `gui-event` received on the (singular) terminal DC drives input. For multi-peer MVP: accept from any peer, but log `peer_id` + `role` into the event so post-run analysis can see who sent what. **No lease enforcement** — that's phase 2c (ultraplan §4.18).

### Step 6 — Integration test

**New file:** `src/webrtc/tests/multi_peer.rs` (or under the worker's existing integration tests).

Scenario:

1. Spin up signaling-server + worker in Docker.
2. Connect peer 1 as `role=browser, peer_id=b1`.
3. Connect peer 2 as `role=observer, peer_id=o1`.
4. Dispatch a test RTP packet from the worker pipeline.
5. Assert both peers receive it.
6. Close peer 2; assert peer 1 still receives subsequent packets.
7. Repeat with an HMR build-log message; assert both peers receive it.
8. Peer 1 sends `gui-event`; assert `event.peer_id=b1` shows up in the event log.

### Step 7 — Update `AGENT_MCP_STATUS.md` §4.2

Once step 6 passes, flip the box in the status doc and delete this file (it's a one-shot migration guide).

---

## Risks the refined plan flagged — resolution notes

1. **GStreamer appsink `max-buffers=1` throttling.** Resolved by `TrackFanout`'s broadcast channel: each peer consumes independently from its own `broadcast::Receiver`, slow peers drop-and-catch-up via `RecvError::Lagged`.
2. **Teardown ordering.** `FanoutSubscription` aborts per-peer tasks on drop, so peer-disconnect never touches the shared pipeline. The pipeline itself only goes down when `TrackFanout` is dropped.
3. **ICE trickle race.** Each PC has its own `on_ice_candidate` closure tagged with `peer_id` (step 2); signaling-server already routes by `peer_id`.
4. **DTLS fingerprint reconciliation per-PC.** Automatic — each `RTCPeerConnection` negotiates its own DTLS session. No shared state to reconcile.

---

## Scope deliberately out of this migration

- **Enriched-tier a11y bridge.** Stays phase 2+ (`AGENT_MCP_ULTRAPLAN.md` §8.6).
- **Observer input lease enforcement.** Still wire-only; worker-side enforcement is phase 2c.
- **Cross-session peer migration.** Out of scope; each session is independent.
- **Audio tee to a shared sink.** Phase 2d per ultraplan (fan-out only to peers today, not to a persistent recording).

---

## Unit test evidence for the scaffold

```
cargo test --lib -- webrtc::peer_registry::tests
cargo test --lib -- webrtc::track_fanout::tests
```

6 + 5 tests respectively. See the `#[cfg(test)]` modules in each source file for coverage detail.
