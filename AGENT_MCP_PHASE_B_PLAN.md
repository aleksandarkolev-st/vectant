# Agent MCP — Phase B Migration Plan (Commits 2–9)

**Status:** Commit 1 (peer_id on the signaling wire, forward-compat only) + the
side-fix (MCP TURN creds + live-test auto-open) shipped on branch
`claude/explore-mcp-architecture-bA4TW`. This doc is the durable plan for the
remaining 8 commits, written so a fresh session can pick up without re-reading
the full investigation thread.

**Source of truth:** `backend/synthi-webrtc-compiler/worker/src/webrtc/G3_PHASE_B_INTEGRATION.md`
is the original migration guide from when the scaffold landed. This plan
refines it with concrete `file:line` targets from the current tree and a
strict commit ordering that keeps the main branch green between steps.

---

## Context snapshot — what's already wired

| Component | File(s) | State |
|---|---|---|
| `PeerRegistry` + `PeerHandle` + `PeerRole` | `worker/src/webrtc/peer_registry.rs` | ✅ tested (6 unit tests) |
| `TrackFanout` + `FanoutSubscription` | `worker/src/webrtc/track_fanout.rs` | ✅ tested (5 unit tests) |
| `broadcast_build_log_text` helper | `worker/src/webrtc/build_log_broadcast.rs` | ✅ shipped |
| Signaling-server observer role + presence | `signaling-server/src/main.rs` | ✅ shipped |
| `peer_id` field on the wire | all three (post-Commit 1) | ✅ shipped, forward-compat only |
| MCP `iceServers` plumbing | `mcp/synthi-mcp/src/{session,tools/attach,signaling}.ts` | ✅ shipped |
| live-test auto-open + presence poll | `mcp/synthi-mcp/scripts/live-test.mjs` | ✅ shipped |
| Worker singleton PC in `main.rs` | `worker/src/main.rs:618, 888-1094` | ❌ unchanged — Commit 2 target |
| Worker singleton `log_channel_store` reads | `worker/src/main.rs:711, 854, 909, 917, 1007, 1035, 1266, 1286, 1298` | ⚠️ one migrated (`:723`), rest legacy |
| Single-track write-path in media pipeline | `worker/src/android/webrtc/video_pipeline.rs:614` | ❌ unchanged — Commit 5 target |
| Placeholder track attach in `create_peer` | `worker/src/main.rs:1211-1264` | ❌ unchanged — Commit 5 target |
| HMR `replace_track` on runtime reload | `worker/src/compiler/stages/runner.rs` | ❌ unchanged — Commit 6 target |
| Terminal DC input dispatch | `worker/src/main.rs:1655-` | ❌ unchanged — Commit 7 target |

**Key invariant to preserve across every commit:** the human-browser happy
path must keep rendering the counter locally. Break it and we lose the ability
to debug the MCP at all.

---

## Commit ordering (strict)

Each step is sized so that the tree compiles and the singleton-PC hot path
still works after landing it. Observer co-attach + multi-peer fan-out only
becomes observable starting at Commit 5.

### Commit 2 — per-peer PC routing in worker signal loop

**Target files:** `worker/src/main.rs` only (no deletes yet).

**Scope:**
- Replace the outer-scope singleton `let mut pc = create_peer(...)` at
  `main.rs:618` with a `let peer_registry: Arc<PeerRegistry> = Arc::new(PeerRegistry::new())`
  and a helper `active_pc(peer_registry) -> Option<Arc<RTCPeerConnection>>`.
  Keep `log_channel_store` for now — Commit 4 deletes it.
- In the `"offer"` arm (`main.rs:900-1005`), branch on `parsed.peer_id`:
  - `Some(pid)` → `peer_registry.get(&pid)` or create via `create_peer`
    + wire via `wire_peer_channels(..., peer_id=pid)` (Commit 3 adds the
    param; stub `pid = DEFAULT_BROWSER_PEER_ID` for now), insert handle,
    evict old if `RegistryInsertOutcome::Evicted(old)` → `old.pc.close()`.
  - `None` → fall back to `DEFAULT_BROWSER_PEER_ID` (pre-Commit-1 clients
    that don't echo `peer_id` still land here).
- In `"candidate"` (`main.rs:1006-1010`), look up PC by `peer_id` from the
  registry; fall back to `DEFAULT_BROWSER_PEER_ID`.
- In `"reset"` (`main.rs:1011-1094`), iterate `peer_registry` and close
  all PCs. Collapse the two duplicate create-peer paths into one helper.
- Delete the `current_remote_fingerprint` state + the fingerprint-changed
  branch (`main.rs:888, 909-971, 1002-1003, 1020`). Same-peer re-offer is
  supported by webrtc-rs; different-peer = different `peer_id` = different
  slot.
- Worker's outbound `answer`/`candidate` must now stamp `peer_id` so the
  signaling-server can route back correctly in Phase B. Use a
  `signal_tx_for_peer(pid)` wrapper that wraps `signal_tx.clone()` and
  stamps `peer_id: Some(pid.clone())` on every `SignalMessage` it sends.
  Each `create_peer` call gets its own wrapper; `on_ice_candidate` uses
  the wrapper instead of the raw `signal_tx`.

**Compile-check:** `cargo check -p worker` must pass. `cargo test -p worker --lib webrtc::` must still pass.

**Behavior check:** human-browser counter still renders, because the
`None` peer_id fallback keeps the pre-Commit-1 happy path intact. MCP
attach should also still work because Commit 1 already made the server
mint `peer_id` in the `registered` ack; clients that echo it into
`offer`/`candidate` get routed per-peer.

**Staged risk:** the fingerprint-based PC rotation deletion is the riskiest
bit. Mitigate by keeping the code path but making it a no-op branch: leave
the `extract_fingerprint` function defined but unused, with a `#[allow(dead_code)]`
note pointing at this commit. Follow-up refactor commit (bundled into
Commit 9) fully removes.

---

### Commit 3 — `wire_peer_channels` takes `peer_id`

**Target files:** `worker/src/main.rs:1297-1709` (the function + its two callers).

**Scope:**
- Add `peer_id: String` parameter.
- Drop `log_channel_store: Arc<Mutex<Option<Arc<RTCDataChannel>>>>` from
  the signature. It still exists at outer scope (deleted in Commit 4);
  for now each call-site passes `Arc::clone(&log_channel_store)` OR gets
  threaded individually.
  - Cleanest: keep the param for Commit 3, remove it in Commit 4 in a
    single sweep. Halves the diff vs. merging both.
- Swap `DEFAULT_BROWSER_PEER_ID` → `peer_id` at:
  - `main.rs:1335` (`registry.attach_build_log(DEFAULT_BROWSER_PEER_ID, dc)`)
  - `main.rs:1709` (on_data_channel build-log open)
- Callers at `main.rs:869, 942, 1067` updated to pass the peer_id derived
  from the inbound offer.

**Compile-check:** `cargo check -p worker` passes.

---

### Commit 4 — migrate remaining `log_channel_store` reads to `broadcast_build_log_text`

**Target files:** `worker/src/main.rs`, `worker/src/compiler/stages/runner.rs`
(if it borrows the store — verify with `rg log_channel_store`).

**Sites (from G3 doc + `rg log_channel_store`):** `main.rs:711, 854, 909, 917,
1007, 1035, 1266, 1286, 1298`. `main.rs:723` already migrated — use as the
reference pattern.

**Pattern:**

```rust
// before
if let Some(dc) = &*log_channel_store.lock().await {
    let _ = dc.send_text(msg).await;
}
// after
let _ = broadcast_build_log_text(&peer_registry, msg).await;
```

After the last read is gone, delete the declaration at `main.rs:619` and the
parameter from `wire_peer_channels`. Delete the three `*guard = None` /
`*guard = Some(dc.clone())` write sites — the registry handles DC lifecycle
through `attach_build_log` / peer removal.

**Compile-check:** grep confirms zero `log_channel_store` references remain
(`grep -rn log_channel_store backend/synthi-webrtc-compiler/worker/` → empty).

---

### Commit 5 — per-peer video + audio track fan-out

**Target files:** `worker/src/main.rs`, `worker/src/android/webrtc/video_pipeline.rs:614`,
any audio pipeline equivalent (grep for `write_rtp` in `worker/src/android/webrtc/`
+ `worker/src/runtime/`).

**⚠️ Read first:** I have NOT read `video_pipeline.rs` or the runtime audio path
end-to-end in this session. Before writing code, read both entirely. They own
the GStreamer appsink → RTP plumbing that keeps the human-browser stream
alive; regressing them blacks out the preview.

**Scope:**
- At worker boot: `let video_fanout = Arc::new(TrackFanout::new(TrackKind::Video, 64));`
  and `audio_fanout` equivalent. Thread into `create_peer` + `wire_peer_channels`.
- Replace placeholder tracks in `create_peer` (`main.rs:1211-1264`) with real
  per-peer `TrackLocalStaticRTP` constructed inline. After
  `sender.replace_track(Some(real_track))`, call
  `video_fanout.subscribe_track(real_track.clone())` and store the returned
  `FanoutSubscription` on the `PeerHandle` (extend `PeerHandle` with
  `video_sub: Option<FanoutSubscription>` + `audio_sub`).
- Call `peer_registry.attach_video_track(&peer_id, real_track)` + audio equivalent
  so `all_video_tracks()` snapshots surface them.
- In `video_pipeline.rs:614`, replace the singleton-track `write_rtp` with
  `video_fanout.dispatch(packet)`. One dispatch, N subscribers.
- On `on_peer_connection_state_change(Failed | Closed)`, call
  `peer_registry.remove(&peer_id)` → dropping the `PeerHandle` drops the
  `FanoutSubscription` → the per-peer task aborts. Verify the `Drop` impl on
  `FanoutSubscription` does abort the task (`track_fanout.rs:94-98` confirms).

**Compile-check:** `cargo check -p worker` passes. `cargo test -p worker --lib webrtc::track_fanout` still passes.

**Behavior check:** human-browser counter still renders. Second peer attached
via MCP also receives frames (exercise via `live-test.mjs` with a second
browser tab open alongside).

**Staged risk:** this is the commit most likely to regress the human path.
Gate it behind an env-var feature flag `SYNTHI_WORKER_MULTI_PEER=true` for
this commit only; flip the default on in Commit 9 after all integration
tests pass.

---

### Commit 6 — per-peer HMR track replacement

**Target files:** `worker/src/compiler/stages/runner.rs` (the `replace_track`
site — grep to locate).

**⚠️ Read first:** Same caveat as Commit 5 — I have NOT read `runner.rs`. The
`replace_track` call on HMR reload is load-bearing for runtime-path hot
reloading; regressing it breaks the core product feature.

**Scope:**
- On HMR reload, today: close old GStreamer pipeline, create new
  `video_track` / `audio_track`, `replace_track` on the (singular) sender.
- New flow: iterate `peer_registry.all_video_tracks()`, for each peer's
  sender call `replace_track(new_per_peer_track)`, then re-subscribe each
  new track to `video_fanout`. The fanout itself persists across HMR
  reloads; tracks are disposable.
- If `PeerHandle` stores the old `FanoutSubscription`, drop it before
  subscribing the new track — otherwise the old task keeps running against
  a dead track.

**Compile-check:** `cargo check -p worker` passes. HMR integration test
passes (locate under `worker/tests/` or the spike tests).

---

### Commit 7 — input dispatch tags `peer_id` + `role`

**Target files:** `worker/src/main.rs:1655-` (terminal DC `on_message` arm),
`worker/src/infra/messages.rs` (or wherever `GuiEvent` / input struct lives —
grep for `gui-event`).

**Scope:**
- `wire_peer_channels` already knows the `peer_id` (Commit 3). Thread it
  into the `on_message` closure for the terminal DC.
- When decoding a `gui-event` or `input` message, decorate the parsed event
  with `source_peer_id: String` + `source_role: PeerRole` before dispatching.
- StructuredLogger/event log: include the new fields in the record (find the
  site via `grep structured_logger.*gui-event`).
- **No lease enforcement.** Any peer can dispatch input in MVP. Lease +
  observer-read-only is phase 2c per ultraplan §4.18 — explicitly out of
  scope here.

**Compile-check:** `cargo check -p worker` passes.

---

### Commit 8 — multi-peer integration test

**Target files:** new file `worker/src/webrtc/tests/multi_peer.rs` or
`worker/tests/multi_peer.rs` (match the existing test harness layout; check
if an integration tests dir already exists under `worker/`).

**Scenario** (verbatim from `G3_PHASE_B_INTEGRATION.md` §Step 6, restated so
this doc is self-contained):

1. Spin up signaling-server + worker in a test container set (or use the
   existing test harness under `worker/tests/`).
2. Connect peer 1 as `role=browser, peer_id=b1`.
3. Connect peer 2 as `role=observer, peer_id=o1`.
4. Dispatch a test RTP packet through the worker's video pipeline.
5. Assert both peers receive it (fanout is working).
6. Close peer 2; assert peer 1 still receives subsequent packets
   (subscription drop is clean).
7. Emit an HMR build-log message from the worker; assert both peers
   receive it (build-log fanout is working).
8. Peer 1 sends `gui-event`; assert the event log records
   `source_peer_id=b1`.

**Note:** step 1 may require Docker. If the existing worker tests don't use
Docker, mock signaling + skip Docker bring-up.

---

### Commit 9 — cleanup + flip status + delete migration guide

**Target files:** `worker/src/webrtc/G3_PHASE_B_INTEGRATION.md` (delete),
`AGENT_MCP_STATUS.md` §4.2, `AGENT_MCP_REMAINING_WORK.md` §7 (mark done),
this file (delete).

**Scope:**
- `rm worker/src/webrtc/G3_PHASE_B_INTEGRATION.md` — its job is done.
- Flip `AGENT_MCP_STATUS.md:79` from ⚠️ to ✅.
- Remove any `#[allow(dead_code)]` stubs from Commit 2 that can now be fully
  deleted.
- If Commit 5's `SYNTHI_WORKER_MULTI_PEER` feature flag is in place, flip
  its default on and/or delete the flag entirely.
- `rm AGENT_MCP_PHASE_B_PLAN.md` (this file).

---

## Cross-cutting concerns

### Why Commit 1 shipped `peer_id` as forward-compat only

The signaling-server mints `peer_id` on register and echoes it in the
`registered` ack, but `target_roles_for` still routes purely on
`(session, role)`. Rationale: landing the wire field first means every
downstream commit (2, 3, 5) can start stamping / reading `peer_id` without
coordinating a flag-day flip across three codebases. If Phase B stalls
mid-way, the field just exists as dead wire metadata — no regression.

### Why Commit 2 deletes the fingerprint branch

The existing `current_remote_fingerprint` + `fingerprint_changed` logic in
`main.rs:909-971` was a kludge that tried to detect "the browser reloaded
and a new DTLS fingerprint arrived." Once we have per-peer PCs keyed by
`peer_id`, a new browser is just a new `peer_id` → new PC slot → no need to
detect-and-teardown. Deleting saves ~50 LOC and removes a subtle race where
concurrent offer + candidate arrival could land the candidate on the wrong
(being-torn-down) PC.

### Risk: gated-on flag rollout

Commits 5 + 6 are the ones that can regress the human-browser hot path.
Two mitigations possible:

1. **Env-var feature flag** (`SYNTHI_WORKER_MULTI_PEER`) per Commit 5's risk
   note. Simple to land, easy to bisect, one env var to flip.
2. **Staged track replacement**: keep the placeholder track path alive
   alongside the fanout path for one commit, so the fanout is parallel-
   populated but not yet authoritative. Then flip authority in a follow-up.
   More commits, but each is smaller.

Recommend (1) for speed.

### What to test between each commit

Minimum regression check, runnable from Windows host against docker-compose
up:

```bash
# 1. cargo check + unit tests
cd backend/synthi-webrtc-compiler/worker && cargo check && cargo test --lib webrtc::
cd ../signaling-server && cargo check

# 2. MCP typecheck
cd mcp/synthi-mcp && npx tsc --noEmit

# 3. End-to-end
cd mcp/synthi-mcp && node scripts/live-test.mjs
# Expect: counter renders in auto-opened browser → MCP attaches → HMR edit
# → post-edit screenshot differs from baseline (hamming > 4).
```

### Deliberately deferred

- **Enriched-tier a11y bridge.** Ultraplan §8.6.
- **Observer input lease enforcement.** Ultraplan §4.18 (phase 2c).
- **Cross-session peer migration.** Each session stays independent.
- **Audio tee to shared sink.** Ultraplan §4.19 (phase 2d). Fanout writes to
  peer tracks only today, not to a persistent recording pipe.
- **MCP-agent distinct role.** `PeerRole::McpAgent` is defined but not
  routable. Browser + observer are the two slot types actually used.

---

## Diagnostic quick-reference

If a post-commit test regresses, the most useful log lines to grep:

| Log source | Grep pattern | Tells you |
|---|---|---|
| `worker` stderr | `[WebRTC-signal]` | Offer / answer / ICE / teardown progression per peer |
| `worker` stderr | `Peer Connection State:` | Per-PC state transitions (`Connecting` → `Connected` or stall) |
| `worker` stderr | `on_data_channel.*label=` | Per-DC open events — useful to confirm build-log arrives for each peer |
| `signaling-server` stdout | `[Signaling].*Registered` | Register events + presence counts |
| `signaling-server` stdout | `[Signaling].*forward` | Per-message routing (source role → target role, local vs redis) |
| MCP stderr | `peer_connect_timeout` / `signaling_closed_before_connect` | Attach-side failures |

Stall at `Connecting` with no `Connected` for >30s = almost always an ICE
failure. Check coturn is up (`docker compose ps coturn`) and that the MCP
env has `SYNTHI_TURN_URL=turn:localhost:3478` pointing at the host-reachable
coturn port.
