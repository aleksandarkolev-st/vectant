# Synthi MCP — Implementation Plan

**Status:** draft v1, ready for review.
**Tracks:** `AGENT_MCP_MVP.md` (scope-locked) — `AGENT_MCP_ULTRAPLAN.md` is design-space only.
**Branch:** `claude/agent-mcp`.
**Date:** 2026-04-17.

> The MVP doc *supersedes* the ultraplan as the implementation plan. This doc is the code-level breakout of the MVP, grounded in a read of the current codebase (signaling-server, worker, browser `compilerClient.js`). Findings that conflict with the MVP doc are surfaced in §Preflight findings below and flagged inline where relevant.

---

## 0. Preflight findings (read first)

Three load-bearing claims in the MVP need adjustment before code lands. These are not fatal — each has a concrete resolution — but they invalidate some "thin wrapper" framing.

### F1. Input wire format in MVP doc is wrong (blocker, easy fix)

**MVP says:**
> Click/key: `{type: 'mouse'|'key', action, x, y, button, key}` on the `"terminal"` DC.

**Actual wire (verified):**
- Browser dispatches on the `terminal` DC (`synthi/src/services/compilerClient.js:549-564` + `synthi/src/app/workspace/[slug]/page.jsx:510-522`):
  ```js
  {
    type: 'gui-event',
    sessionId: <string>,
    event: { type: 'mouse'|'key', action, x, y, button, key, deltaY? }
  }
  ```
- Worker parses the outer `gui-event` envelope at `backend/synthi-webrtc-compiler/worker/src/main.rs:1690` and the inner `event.{type, action, x, y, button, key}` at lines 1753-1790.

**Implication for MCP:** the `click` and `type` tool handlers must wrap payloads in the `gui-event` envelope and carry a `sessionId`. The flat shape in the MVP doc would be silently dropped by the worker.

**Resolution:** encode correctly on day one; unit test asserts golden-byte match against a captured browser frame.

### F2. HMR `applied`/`rejected`/`compile-error` are NOT emitted as canonical `{type:"hmr-status"}` messages (blocker, two options)

**MVP says** `synthi_wait_hmr` resolves on `{type:"hmr-status", data:{status,…}}` where status ∈ {applied, rejected, compile-error, full-reload-required, crash-fatal, state-migrated}.

**Actual emission sites** (grep of `worker/src/**/*.rs` for `hmr-status`):
- `worker/src/hmr/planner_glue.rs:51` → `status: "reload-planned"`
- `worker/src/hmr/rollback_notification.rs:41` → rollback status

That is **the complete set of worker-side `{type:"hmr-status"}` emissions.** No code path emits `applied`, `rejected`, `compile-error`, `full-reload-required`, or `crash-fatal` under that wire shape today.

**How those statuses actually reach the UI** (from `synthi/src/services/compilerClient.js:400-460`):
1. `{type:"hmr-status", ...}` — passed through verbatim (only `reload-planned` + rollback today).
2. `{type:"compile-diagnostics", error_count, ...}` — browser synthesizes a `status:"compile-error"` event when `error_count > 0`.
3. Bare `{status: "applied"|"rejected"|"compile-error"|"crash-recovered"|"state-migrated"|"crash-fatal", ...}` — a "direct HMR status object from runner" shape (no outer `type` field). Browser normalizes by checking `parsed.status` matches the known set.

**Implication for MCP:** subscribing only to `{type:"hmr-status"}` on the `build-log` DC would cause `wait_hmr` to **hang forever** on real builds — `applied` would never arrive. The MVP's "listens to `build-log` DC for HMR events" is true; the status wire shape is not what the MVP says it is.

**Two options to resolve:**
- **Option A (recommended — MCP-only work).** `hmr.ts` replicates the browser normalizer: handle all three shapes (`{type:"hmr-status"}`, `{status:...}` bare, `{type:"compile-diagnostics", error_count>0}`). Golden-byte unit test against recorded build-log traffic. ~½ day.
- **Option B (worker-side fix).** Wrap all runner-side status emissions in canonical `{type:"hmr-status", data:{status, ...}}` on the worker before writing to `build-log`. Cleaner wire protocol; requires auditing every emission site (ultraplan pre-work #2) and updating browser + MCP. ~1–2 days, bigger blast radius.

Plan assumes **Option A** for MVP (scope discipline — MVP is "visual feedback loop, nothing more"). Revisit Option B if post-MVP tooling wants one canonical wire.

### F3. "Observer" role in signaling-server is not only a signaling-server change (blocker, material scope shift)

**MVP says:**
> `signaling-server/src/main.rs` — add `observer` role; refactor `PeerKey`…; fan out SDP/ICE messages to all peers of the target role… ~20-50 LOC Rust + one integration test.

**Ultraplan v4.2 WebRTC pipeline reuse (lines 1100-1106) says:**
> **Multi-peer data-channel fan-out** — Worker has a **single `RTCPeerConnection`**. Phase 2 broker handles per-session fan-out. Phase 2+ (ticket `G3`).

**Verified in code:**
- `worker/src/main.rs:615` — `let mut pc = create_peer(...).await?;` creates one PC.
- `worker/src/main.rs:1152` — `Arc::new(api.new_peer_connection(config).await?)` returns a single PC with hardcoded sendonly video+audio transceivers.
- `worker/src/main.rs:1256` — `pc.on_peer_connection_state_change(...)` installed once.
- Data channels (`build-log`, `compile`, `terminal`, `emulator-input`, ...) all attach to this single PC.

**Implication:** a WebRTC peer connection is 1:1 by definition. "Fan out SDP/ICE to all peers of the target role" in the signaling server does not by itself give a second peer access to worker media. Either:
- (a) **Worker creates a second PC** for the observer offer — the worker-side data-channel / track setup (lines 1282-1500 for build-log + on_data_channel) must be parameterized per-PC. This is **not "zero worker changes"**; it's the non-trivial bit the ultraplan v4.2 explicitly defers to phase 2+ as ticket `G3`.
- (b) **Phase 2 broker decodes once and fans out** — but that's an explicit phase 2+ deliverable.
- (c) **MCP peers with the browser, not the worker** — changes the product shape (MCP observes what the browser renders), adds browser-side work, and loses the "observer of the worker stream" framing.

**MVP's ~20-50 LOC Rust + one integration test estimate is low.** Realistic scope for true co-attach of browser + observer:
- Signaling-server observer role + multi-peer fan-out: ~50-100 LOC Rust + test.
- Worker second-PC support (per-peer tracks, DCs, offer/answer handling, teardown): ~200-400 LOC Rust + test. This is the bulk of the work and is what the ultraplan deferred.
- Total: ~2-4 days added to the MVP estimate for worker changes, on top of the ~1-1.5 days for signaling.

**Plan provides three sub-tracks for the user to pick** (§Milestone 1/2). Default recommendation: **Path A-prime** — ship MVP quickly with the observer taking the browser's slot (requires the human to detach before the agent attaches); Path B (true co-attach) is a follow-up once worker multi-PC support is scoped. This matches the originally-considered Path A from v4.2 and defers the worker work the ultraplan already classified as phase 2+.

If the user insists on Path B (true co-attach) for MVP, the estimate shifts from 3-5 days to ~7-10 days; the worker changes are in scope and must be itemized.

### F4. Branch already has "pre-phase" complete — that means docs, not code

The `claude/agent-mcp` branch commits are 100% documentation (`docs(agent-mcp): v4.4 …` through `plans`). There is no `mcp/` directory, no `packages/` directory, no signaling-server or worker diff against `main`. "Pre-phase complete" = the MVP + ultraplan + design docs are settled; the implementation is green-field. This plan assumes that framing.

---

## 1. Scope

Five MCP tools, Node/TypeScript package, local dev only. Everything outside this list is explicitly deferred to the ultraplan.

| Tool | Purpose |
|------|---------|
| `synthi_attach` | Connect to a Synthi session over WebRTC. |
| `synthi_screenshot` | Return latest video frame as PNG + dims. |
| `synthi_wait_hmr` | Block until HMR reaches a terminal status. |
| `synthi_click` | Send a mouse click at Xvfb coords. |
| `synthi_type` | Send keystrokes. |

**Deferred:** every ultraplan primitive — semantic locators, vision, verify, reconnect, enriched tier, security hardening (beyond README banner), usage counters, presence, lifecycle enum, error priority, broker, etc.

---

## 2. Milestones

| # | Milestone | Owner surface | Gate |
|---|-----------|---------------|------|
| M0 | Preflight resolutions | MVP / Path decision | User chooses F3 path (A' / B) + confirms F2 Option A |
| M1 | Signaling `observer` role (if Path B) | Rust `signaling-server` | Integration test: 1 browser + 1 observer co-attach |
| M2 | Worker multi-PC support (if Path B only) | Rust `worker` | Worker answers two offers simultaneously, delivers media to both |
| M3 | MCP package scaffold | TS `mcp/synthi-mcp/` | `node dist/index.js` starts, MCP inspector lists 5 tools |
| M4 | Signaling client + WebRTC peer + frames | TS | `synthi_attach` completes SDP; `synthi_screenshot` returns a valid PNG |
| M5 | Data channels: terminal (input) + build-log (HMR normalizer) | TS | Keystroke round-trip works; normalized `hmr-status` emitted for all three wire shapes |
| M6 | Five tool handlers wired | TS | All five tools return spec-conformant responses |
| M7 | Tests (unit + integration + real-agent smoke) | TS + docker-compose | Counter fixture passes three-layer test |
| M8 | README + security banner | Docs | LOCAL-DEV-ONLY banner, install + `claude mcp add` snippet |

Commit after every milestone at minimum; ideally after every file manifest group within a milestone. Commit messages follow the repo style: `feat(agent-mcp): …`, `docs(agent-mcp): …`, `test(agent-mcp): …`.

---

## 3. File manifest by milestone

Paths relative to repo root (`/home/dev/synthi/synthi-test/synthi-whole/`).

### M0 — Preflight resolutions (no code; decision only)

No files created. User resolves the three questions in §0 and §Open items. M0 exit = a one-line amendment to `AGENT_MCP_MVP.md` that records the Path choice (A' or B) and the HMR-normalizer approach (Option A in `hmr.ts` or Option B worker-side fix).

### M1 — Signaling `observer` role (Rust) — **Path B only**

Skip this milestone if Path A' is chosen.

| Path | Purpose | Key responsibilities |
|------|---------|----------------------|
| `backend/synthi-webrtc-compiler/signaling-server/src/main.rs` | Add `observer` role; multi-peer fan-out for SDP/ICE. | Refactor `PeerKey = (String, String)` → `PeerKey = (String, String, String)` where the third tuple element is a `peer_id` (generated server-side at register time; `browser`/`worker` keep a stable deterministic id for backcompat). Routing: SDP/ICE from `role=observer` target `worker`. SDP/ICE from `role=worker` fan out to every `browser` + every `observer` in the session. Non-SDP messages keep today's strict-binary routing to preserve legacy-worker bridging. Integration test: 1 browser + 1 observer on same session both receive the worker's SDP answer. |
| `backend/synthi-webrtc-compiler/signaling-server/src/main.rs` (same file, cleanup block) | Preserve legacy-worker bridging (lines 322-349 today). | The `__legacy__` session mapping still points to a single (browser) session; observer traffic to `__legacy__` workers is out of MVP scope (document as "local-dev with SESSION_ID only"). |
| `backend/synthi-webrtc-compiler/signaling-server/tests/observer_fanout.rs` *(new)* | Integration test for multi-peer SDP/ICE fan-out. | Spin up in-process signaling server + Redis container; register 1 browser + 1 observer; worker sends answer; assert both peers receive it; assert `worker` receives ICE from both and routes browser→worker correctly. |

**Ambiguity flagged inline:** the MVP's "one integration test (1 browser + 1 observer)" is a functional test but doesn't cover the media path — see M2. For the signaling-only integration test to be meaningful, it must pair with M2's worker second-PC test.

### M2 — Worker second-PC support (Rust) — **Path B only**

Skip if Path A'. This is the material scope the ultraplan v4.2 deferred to phase 2+ ticket `G3`.

| Path | Purpose | Key responsibilities |
|------|---------|----------------------|
| `backend/synthi-webrtc-compiler/worker/src/webrtc/peer_registry.rs` *(new)* | Per-peer state indexed by `peer_id`. | `struct PeerRegistry { peers: HashMap<String, PeerHandle> }`; `PeerHandle { pc, build_log_dc, compile_dc?, terminal_dc?, … }`. Replaces the current implicit single-PC model. Worker still holds **one video source** (GStreamer pipeline) — each peer gets its own `TrackLocalStaticRTP` forwarded from the same pipeline RTP tee. |
| `backend/synthi-webrtc-compiler/worker/src/webrtc/track_fanout.rs` *(new)* | Fan out the shared RTP stream to N per-peer tracks. | Subscribes to GStreamer `appsink` once; pushes packets to every registered `TrackLocalStaticRTP` in parallel. Existing single-track path becomes a 1-element case. |
| `backend/synthi-webrtc-compiler/worker/src/main.rs` (lines ~600-1500) | Rework the signal loop to create one PC per incoming `offer`. | Today: `let mut pc = create_peer(...)` once at startup (line 615); `create_peer` at lines 1070-1263; data channels attached at 1270-1500. Change to: signal-loop receives `offer` with `peer_id` → `create_peer_for(peer_id)` → register in `PeerRegistry` → attach DCs + track → send answer tagged with `peer_id`. Teardown on `peerconnection:disconnected`. |
| `backend/synthi-webrtc-compiler/worker/src/main.rs` (data-channel routing, lines 1282-1315) | Per-peer `build-log` DC output. | Current code stores a single DC in `log_channel_store: Arc<Mutex<Option<Arc<RTCDataChannel>>>>`. Change to `HashMap<String /* peer_id */, Arc<RTCDataChannel>>` so HMR status emissions fan out to every attached peer. Compile/terminal input DCs stay per-peer-local (browser emits compile; observer only emits terminal input). |
| `backend/synthi-webrtc-compiler/worker/src/main.rs` (input routing, line 1655-) | Input arbitration (MVP: accept from any peer). | No lease enforcement (ultraplan phase 2). MVP accepts the most recent `gui-event` from any peer. Log the source `peer_id` for debugging. |
| `backend/synthi-webrtc-compiler/worker/tests/multi_peer.rs` *(new)* | Two-peer integration test. | Spawn worker + signaling + two ws clients (one role=browser, one role=observer); both negotiate SDP; both receive a crafted HMR `applied` message on build-log; observer sends a `gui-event` mouse click that reaches Xvfb. |

**Ambiguity flagged inline:** the ultraplan deferred this to phase 2+ `G3`. If the user picks Path B for MVP, that decision effectively promotes `G3` into MVP scope. The plan should be honest: this is the expensive part.

### M3 — MCP package scaffold (TypeScript)

| Path | Purpose | Key responsibilities |
|------|---------|----------------------|
| `mcp/synthi-mcp/package.json` *(new)* | Node 20+ TS package manifest. | `name: "@synthi/mcp-server"`, `bin: { "synthi-mcp": "dist/index.js" }`. Deps: `@modelcontextprotocol/sdk`, `@roamhq/wrtc`, `ws`, `sharp`. DevDeps: `typescript`, `tsx`, `vitest`. |
| `mcp/synthi-mcp/tsconfig.json` *(new)* | TS config, ES2022 + Node16 module resolution. | `strict: true`, `target: "es2022"`, `outDir: "dist"`. |
| `mcp/synthi-mcp/vitest.config.ts` *(new)* | Vitest config for unit + integration tests. | Two projects: `unit/` (no docker) and `integration/` (requires docker-compose up). |
| `mcp/synthi-mcp/README.md` *(new — stub; populated in M8)* | Placeholder to be rewritten in M8. | One-line description + "see AGENT_MCP_IMPLEMENTATION_PLAN.md". |
| `mcp/synthi-mcp/src/index.ts` *(new)* | Stdio entrypoint. | Reads `SYNTHI_SESSION_ID` env or `--session <id>` arg; starts MCP server on stdio; installs SIGINT handler for graceful shutdown. ~40 LOC. |
| `mcp/synthi-mcp/src/server.ts` *(new)* | MCP tool registry. | Registers 5 tools with JSONSchema; dispatches to `tools/*.ts` handlers. ~80 LOC. |

**Commit after M3:** `feat(agent-mcp): scaffold mcp/synthi-mcp/ package with MCP inspector-visible tool list`.

### M4 — Signaling client + WebRTC peer + frames (TypeScript)

| Path | Purpose | Key responsibilities |
|------|---------|----------------------|
| `mcp/synthi-mcp/src/signaling.ts` *(new)* | WebSocket signaling client. | Connects to `ws://<host>:9000`; sends `{type:"register", role: "observer" \| "browser", session_id}` (role depends on Path A'/B choice from M0 — see §Open items); forwards `offer`/`answer`/`candidate` frames to/from `peer.ts`. Handles reconnect-on-drop (simple linear backoff; full `synthi_reconnect` deferred). ~120 LOC. |
| `mcp/synthi-mcp/src/peer.ts` *(new)* | `@roamhq/wrtc` `RTCPeerConnection` wrapper. | Creates PC with stock ICE servers (or env-configured); adds video+audio transceivers (`recvonly`); generates offer; applies answer; handles ICE candidates from signaling. Exposes `onVideoTrack` callback + DC accessors. ~150 LOC. |
| `mcp/synthi-mcp/src/frames.ts` *(new)* | `RTCVideoSink` → PNG via sharp. | Subscribes to video track; decodes frames into a ring buffer (size 1, overwrite-latest); `getFrame()` returns the current frame as PNG (sharp conversion from YUV → PNG). Records `{w, h, ts}` metadata. ~100 LOC. |
| `mcp/synthi-mcp/src/session.ts` *(new)* | Lightweight in-process session state. | Holds `{sessionId, signalingUrl, peer, signaling, frames, buildLogDC, terminalDC}`. Singleton per MCP process (MVP: one attach per process). ~40 LOC. |

**Commit after M4:** `feat(agent-mcp): WebRTC peer + signaling + frame sink`.

### M5 — Data channels: terminal (input) + build-log (HMR normalizer)

| Path | Purpose | Key responsibilities |
|------|---------|----------------------|
| `mcp/synthi-mcp/src/wire/input.ts` *(new)* | Input wire format. | Encodes mouse/key events per the **verified** worker wire: `{type:"gui-event", sessionId, event:{type:"mouse"\|"key", action, x, y, button, key}}` — **not** the flat shape from the MVP doc (see §F1). Functions: `encodeClick(x, y, button, sessionId)`, `encodeKey(key, action, sessionId)`, `encodeType(text, sessionId)` (expands a string into `key down/up` pairs per character). |
| `mcp/synthi-mcp/src/hmr.ts` *(new)* | HMR status normalizer + subscription. | Subscribes to `build-log` DC text messages; tries three wire shapes (§F2 Option A): (1) `{type:"hmr-status", data:{status,...}}` → status; (2) bare `{status:"applied"\|"rejected"\|"compile-error"\|"crash-recovered"\|"state-migrated"\|"crash-fatal",...}` → status; (3) `{type:"compile-diagnostics", error_count:>0}` → synthesized `compile-error`. Exposes `onStatus(cb)` and `waitForTerminal({timeoutMs}) → {status, elapsedMs}` resolving on any of {`applied`, `rejected`, `compile-error`, `full-reload-required`, `crash-fatal`, `state-migrated`}. ~120 LOC + comprehensive unit test. |
| `mcp/synthi-mcp/src/channels.ts` *(new)* | DC handle registry. | Collects `{build-log, terminal}` once the PC data channels open. `build-log` is created by the worker (incoming via `on_datachannel` on the MCP's PC); `terminal` is created by the MCP (outgoing). Order matters: see the browser's `compilerClient.js:905-912` for the canonical creation order. |

**Commit after M5:** `feat(agent-mcp): wire input + HMR normalization with three-shape handling`.

### M6 — Five tool handlers

| Path | Purpose | Key responsibilities |
|------|---------|----------------------|
| `mcp/synthi-mcp/src/tools/attach.ts` *(new)* | `synthi_attach({sessionId, signalingUrl?})`. | Reads `SYNTHI_SIGNALING_URL` env or arg; resolves via `signaling.ts` + `peer.ts`; awaits both PC `connected` + `build-log` DC open; returns `{ok:true, resolution:{w,h}, connected:true}` after first video frame (signals real media path). |
| `mcp/synthi-mcp/src/tools/screenshot.ts` *(new)* | `synthi_screenshot()`. | Calls `frames.getFrame()`; returns `{data: base64PNG, mimeType:"image/png", w, h, ts}`. Error `no_frame_yet` if no frame received within 1s. |
| `mcp/synthi-mcp/src/tools/wait_hmr.ts` *(new)* | `synthi_wait_hmr({timeoutMs?: 30000})`. | Delegates to `hmr.waitForTerminal({timeoutMs})`; returns `{status, elapsedMs}` on success, `{status:"timeout", elapsedMs}` on deadline. No frame-seq gate (per MVP scope — E1 deferred). |
| `mcp/synthi-mcp/src/tools/click.ts` *(new)* | `synthi_click({x, y, button?})`. | Builds mouse-down then mouse-up via `wire/input.encodeClick`; sends on `terminal` DC; returns `{ok:true}`. No ack (MVP — worker doesn't ack today). |
| `mcp/synthi-mcp/src/tools/type.ts` *(new)* | `synthi_type({text})`. | Expands `text` into a `key down/up` sequence per char via `wire/input.encodeType`; sends on `terminal` DC; returns `{ok:true}`. Rate limit: 500 keys/sec hard cap (matches ultraplan security §; cheap guard-rail even in MVP). |

**Commit after M6:** `feat(agent-mcp): five MCP tools (attach/screenshot/wait_hmr/click/type)`.

### M7 — Tests

Layer order matches `AGENT_MCP_MVP.md:Testing`.

| Path | Purpose | Key responsibilities |
|------|---------|----------------------|
| `mcp/synthi-mcp/tests/unit/wire.test.ts` *(new)* | Golden-byte parity for input wire. | Captures one session's worth of `synthi:gui-input` payloads from a live browser session (fixture: `tests/fixtures/browser_gui_payloads.json`, recorded once). For each captured event, build the same inputs via `wire/input.ts`; assert byte-identical JSON strings. Catches F1 regressions. |
| `mcp/synthi-mcp/tests/unit/hmr_normalize.test.ts` *(new)* | HMR normalizer covers all three wire shapes. | Feeds `hmr.onStatus` each of: `{"type":"hmr-status","data":{"status":"applied"}}` + `{"status":"applied"}` bare + `{"type":"compile-diagnostics","error_count":2}`; asserts normalized stream emits `applied`, `applied`, `compile-error` in order. |
| `mcp/synthi-mcp/tests/integration/e2e.test.ts` *(new)* | Full docker-compose round trip. | Runs `docker-compose up -d` (reuses existing `/docker-compose.yml`); creates a session via collab-server REST; starts MCP; `synthi_attach` → `synthi_screenshot` → assert PNG ≥ 1KB + dims match resolution → edit a file via collab REST → `synthi_wait_hmr` → assert `applied` within 30s → `synthi_screenshot` → assert pHash distance from baseline > 4. |
| `mcp/synthi-mcp/tests/fixtures/counter_swing/` *(new — copied from ultraplan testing fixtures)* | Swing counter fixture. | Minimal Java Swing app with a button that increments; baseline PNG at `counter-0.png`. Same fixture the ultraplan §Testing references. |
| `mcp/synthi-mcp/tests/e2e/claude_code_smoke.sh` *(new)* | Claude-Code smoke loop. | Bash script: `claude mcp add synthi -- node dist/index.js --session $ID`; pipes a prompt: *"Attach to the preview and describe what you see. Then edit src/Counter.java to start from 10 instead of 0, wait for HMR, and screenshot again."* Shell asserts MCP tool-call trace + final screenshot pHash differs from baseline. |

**Commit after M7:** `test(agent-mcp): three-layer test suite (unit + integration + real-agent smoke)`.

### M8 — README + security banner

| Path | Purpose | Key responsibilities |
|------|---------|----------------------|
| `mcp/synthi-mcp/README.md` *(rewrite)* | Install + security banner + `claude mcp add` snippet. | Sections: (1) ⚠️ **LOCAL DEV ONLY** banner (agent peers are unauthenticated; do not point at shared signaling). (2) Install: `pnpm install`, `pnpm build`. (3) Usage: `claude mcp add synthi -- node dist/index.js --session <id>` + env vars. (4) Tools reference (5 tools, one paragraph each). (5) Known limitations (no frame-seq gate; no reconnect; no vision; no locators — pointers to `AGENT_MCP_ULTRAPLAN.md` for future scope). |
| `AGENT_MCP_MVP.md` *(edit — add M0 resolution paragraph)* | Record the Path choice + HMR-normalizer choice from M0. | One paragraph under the Architecture section noting "Path chosen: A'/B" + link back to this plan. |

**Commit after M8:** `docs(agent-mcp): README + MVP amendment with Path choice`.

---

## 4. Out-of-manifest files (do not touch for MVP)

Tempting but out of scope:

- `backend/collab-server/SessionManager.js` — the MVP doesn't need session lifecycle queries.
- `synthi/src/components/HMRStatusIndicator.jsx` — the HMR status UI is informative only; MCP does not read it.
- `synthi/src/services/compilerClient.js` — adapted *patterns*, not imported. Any change here is out of scope for MVP.
- `backend/synthi-webrtc-compiler/worker/src/hmr/**` — HMR internals are a black box to the MCP; MCP observes on `build-log` DC only.

Anything on the ultraplan's "Files — added/modified" list that's not in this plan's manifest is **post-MVP** and stays untouched.

---

## 5. Open items requiring user decision before M1 starts

1. **F3 Path choice — A' (observer replaces browser) vs. B (true co-attach).** Path B is the product-correct answer but is ~5-7 days larger than the MVP's 3-5 day estimate because of the worker second-PC work that v4.2 deferred to `G3`. Path A' matches the MVP estimate and defers co-attach to post-MVP.
2. **F2 HMR normalization — Option A (MCP-side, MVP scope) vs. Option B (worker-side canonical emission, larger scope).** Recommended: A. Flag if user wants B.
3. **Where should `mcp/synthi-mcp/` live in the monorepo?** The MVP + ultraplan say `mcp/synthi-mcp/`; that's a new top-level directory. If the user prefers `packages/synthi-mcp/` or `backend/synthi-mcp/`, say so before M3.
4. **Golden-byte fixtures** (`browser_gui_payloads.json`, `counter_swing/`) — record once from a live session. Before M7, user confirms which workspace/session to record against.
5. **Frame-seq gate in MVP?** MVP currently ships status-only. Plan matches. If user wants to add the gate for MVP (low risk on static counter fixtures per ultraplan E1), it's a ~½-day add to `hmr.ts` and requires a new worker `{type:"frame-advance"}` DC message (scope creep into worker).
6. **Allowed signaling URLs for MVP.** MVP says localhost-only with a README banner. If we want the `--i-understand-no-auth` flag on day one, it's ~2 hours added to `signaling.ts`. Ultraplan item; recommend defer.

---

## 6. Commit cadence

1. `docs(agent-mcp): implementation plan AGENT_MCP_IMPLEMENTATION_PLAN.md` — this file (now).
2. `docs(agent-mcp): MVP amendment for Path + HMR-normalizer decisions` — after M0.
3. `feat(agent-mcp): signaling-server observer role + multi-peer fan-out` — after M1 (Path B only).
4. `feat(agent-mcp): worker per-peer RTCPeerConnection registry + track fanout` — after M2 (Path B only).
5. `feat(agent-mcp): scaffold mcp/synthi-mcp/ package` — after M3.
6. `feat(agent-mcp): WebRTC peer + signaling + frame sink` — after M4.
7. `feat(agent-mcp): wire input + HMR normalization` — after M5.
8. `feat(agent-mcp): five MCP tools` — after M6.
9. `test(agent-mcp): three-layer test suite` — after M7.
10. `docs(agent-mcp): README with security banner + claude mcp add` — after M8.

Sub-commits within a milestone are welcome (e.g., signaling.ts + peer.ts before frames.ts), especially when a file is net-new and independently testable.

---

## 7. What this plan deliberately does NOT try to do

- It does not re-open the product scope. MVP is scope-locked at 5 tools; the ultraplan is available if the user wants to widen.
- It does not invent new primitives. The three preflight flags (F1/F2/F3) are resolved with MVP-scope-preserving fixes, not by pulling ultraplan primitives forward.
- It does not speculate about performance, reliability SLOs, or phase-2 migration paths. The MVP doc's "stop after 5 tools; revisit only if a real agent loop hits a real limit" framing governs.
- It does not prescribe the user's answers to the §5 open items. The plan is ready to execute once those are resolved.
