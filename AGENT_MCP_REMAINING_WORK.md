# Synthi MCP — Remaining Work (research pass 2026-04-18)

**Status:** exhaustive gap report between `AGENT_MCP_ULTRAPLAN.md` (v4.5 phase-1 scope) and what actually exists in-tree at branch tip `a4b67cbd` (updated after session 2026-04-18).
**Companion docs:** `AGENT_MCP_STATUS.md` (shipped items), `PHASE_2_PLUS_BACKLOG.md` (explicitly-deferred tickets), `PHASE_0_5_FINDINGS.md` (live-run gaps).
**Scope of this doc:** **not** cherry-picked "cheap/high-value" items — a full inventory of what the ultraplan calls phase-1, with honest classification for each (shipped / staged / missing / deferred).

---

## Session 2026-04-18 update

Sections below reflect the state at commit `157df722`. Twelve follow-up commits landed during session 2026-04-18. **What shipped (each entry that was flagged below is now resolved):**

- §3 MCP infrastructure: **Request-id registry + claude_api cancellation** (commit `72ab9c90`). **Prometheus `/metrics` endpoint + locator counters** (commit `546ac206`). **Graceful shutdown** now extractable + unit-tested (commit `c5410d8a`).
- §4.1 Staged: **Frame-advance emission** on worker side (commit `c7bbe0ab`); §4.4 gate is now live end-to-end.
- §4.2 Not started: **Input dispatch-ack** infrastructure (commit `913b5a30`); tool-layer opt-in deferred.
- §4 Signaling: **Protocol-version handshake** (commit `9fe76041`); **presence count reporting** (commit `a4b67cbd`).
- §7 Documentation: **`docs/E3_README_VARIANTS.md`** pre-drafted (commit `82ebb4b8`); **`TESTING.md`** manual-QA golden path (commit `d090c19e`).
- **Bonus: `gemini_api` vision backend** (commit `9a073f6b`) — peer of `claude_api`, not on the ultraplan but symmetric. **Default vision backend flipped to `agent_side`** (commit `d4e0c3fb`) to eliminate the API-key friction for vision-capable hosts.

**What's still open:**

- §4.2 main.rs multi-PC migration (scaffold at `883056f5`, integration guide at `worker/src/webrtc/G3_PHASE_B_INTEGRATION.md`) — deliberately staged; 300+ LOC across load-bearing singletons.
- Tool-layer consumption of dispatch-ack (synthi_mouse / keyboard awaiting worker acks before resolving) — infra is ready; tool wiring is additive.
- Worker: input-dispatch ack on the audio path (video only today); pipeline-budget calibration probe at worker start; WM_CLASS spoof check; window-tree focus lock; guest root-PID capture; structural-change pHash gate at HMR applied; warming-progress + migrating-state propagation.
- Remaining 6 ultraplan phase-1 tools: `synthi_describe`, `synthi_acquire_input`, `synthi_release_input`, `synthi_request_human`, `synthi_annotate_and_ask`, `synthi_recent_human_actions`.
- Phase 0.5 live runs (E1/E1b/E2/E2b/E3/E4) — require `docker-compose up -d` + fixtures.
- Adversarial fixture for prompt_injection + wm_class_spoof integration tests.
- Collab-server session lifecycle REST + warm endpoint + migrating-state hook.

**Test count:** 245 → 328 unit tests; 13 Rust signaling-server tests (up from 4). Typecheck + `cargo check` clean.

---

## 0. Sampling backend — verified upstream blocker

**Finding.** `@modelcontextprotocol/sdk` exposes `server.createMessage(...)` and a full `CreateMessageRequestParams` schema with image content blocks (`types.d.ts:3578-3660`, `server/index.d.ts:140-150`). The MCP spec's `sampling/createMessage` is the standardised way for an MCP server to ask the host to make an LLM call on its behalf — the host decides which model + fulfills with its own credentials (subscription or API key).

**But:** Claude Code does **not** implement the client-side handler today. Tracked upstream at anthropics/claude-code#1785, no ETA. So an MCP running *inside Claude Code* cannot reach the user's Claude subscription via sampling. Raw `ANTHROPIC_API_KEY` remains the only path for Claude Code users until that ships.

**Options:**

1. **Ship `ClaudeSamplingBackend` as a selectable option anyway.** Claude Desktop + some other hosts *do* implement the sampling primitive. A user running synthi-mcp through Claude Desktop could bypass the API-key requirement. Downside: mostly dead code for the primary target audience (Claude Code users) until #1785 ships; extra surface to maintain.
2. **Wait for #1785.** When it lands, flip the default. Cost: nothing to build now; users with subscription keep paying the extra API bill in the meantime.
3. **`SYNTHI_VISION_BACKEND=agent_side` as the documented fallback.** This already works: the MCP returns the frame as base64 and the agent calls its own vision. No API key on the MCP side, the agent's subscription *does* pay for the vision call (because the agent is making it, not the MCP server). **This is what we already ship.** The only loss is the server-side region-pHash cache (no cache possible when the agent owns the vision call).

**Recommendation:** deferred. Document `agent_side` as the "no API key" path in the README (already mostly there — see `mcp/synthi-mcp/README.md` env-var table). Revisit option 1 after #1785 OR once we have usage data showing agents prefer claude_api badly enough that "extra API key" is a real friction point.

---

## 1. Gap classification

Every entry below is scored on two independent axes:

- **Landability.** Can it land without backend changes? *(MCP-only | backend-coupled | cross-service)*.
- **Scope.** *(phase-1 missing | phase-1 staged | phase-2+ deferred | backlog ticket)*.

The rest of this doc is organised by code region, not by priority. Priority selection is up to the user.

---

## 2. Tool surface gaps

### 2.1 Missing from phase-1 scope (6 tools)

The ultraplan §Tool surface lists 24 phase-1 tools (13 core universal + 6 operational + 2 arbitration wire + 3 escape-hatch wire). We advertise 23, but 5 are back-compat aliases (click/type/wait_hmr) or bonuses (compile/report_source_state), leaving **6 explicit phase-1 tools unshipped**:

| Tool | Group | Surface shape | Landability | Notes |
|------|-------|---------------|-------------|-------|
| `synthi_describe` | Core universal (#12) | `{mode?:"server_side"\|"agent_side"}` → server: `{summary, entities, frame_seq}`; agent_side: `{screenshot, frame_seq, entities: WorkerEntity[]}`. Cached per frame-seq. | MCP-only (server_side needs vision backend; agent_side needs worker entity hints, which are worker-coupled). **Phase-1 partial** — agent_side mode w/o entities ships alone; server_side description reuses claude_api. | Today `synthi_verify({kind:"scene_matches"})` returns `required_tool_call:"synthi_describe"` — that tool name is advertised in an error but **not implemented**. Shipping it closes the loop. |
| `synthi_acquire_input` | Arbitration wire | `{lease_ms}` → `{lease_id, expires_at}` | MCP-only (phase-1 wire: record-only in event log; enforcement is phase-2c per `G3`). | Single tool, small surface. Needed only if we want phase-2 retrofit to not break the wire. |
| `synthi_release_input` | Arbitration wire | `{lease_id?}` → `{ok}` | MCP-only (same). | Trivial partner of the above. |
| `synthi_request_human` | Escape hatch | `{question, screenshot?}` → `{answer, responder_id, elapsed_ms}` or `{declined}` | **Cross-service**: needs collab-server/frontend host UI to route the prompt. Phase-1 "wire" means accept input + error `escape_hatch_backend_not_implemented`; phase-3 UI lands the real thing. | Today we have nothing. Shipping the wire stub is <20 LOC but gives agents a failure mode to branch on. |
| `synthi_annotate_and_ask` | Escape hatch | `{screenshot, question}` → `{click_coords:{x,y}, elapsed_ms}` | Cross-service (same reasoning — phase-3 UI lands the real thing). | Wire stub is cheap. |
| `synthi_recent_human_actions` | Escape hatch | `{sinceSeq?}` → `{actions: HumanAction[]}` | Cross-service (requires worker to tag human-authored input events, or collab-server to stream them). | Wire stub is cheap. Real backing requires input-source attribution the worker doesn't emit today. |

**Path-A MCP-only wire-only shipment for all 6:** ~150 LOC + schema + 6 tests. Adds `session.protocol.server_supports` without bumping the version because these are new tool names, not new protocol semantics.

### 2.2 Bonus tools already advertised (not in ultraplan)

We added two during the implementation pass:

- `synthi_compile` — MCP-driven compile trigger. Useful when the agent has just reported a source state but wants to force a compile without relying on the auto-compile heuristic.
- `synthi_report_source_state` — explicit agent-side producer for edit-without-compile flows.

Plus three back-compat aliases from the MVP:

- `synthi_click`, `synthi_type` — aliases to `synthi_mouse({action:"click"})` / `synthi_keyboard({action:"type"})`.
- `synthi_wait_hmr` — alias to `synthi_wait({condition:"hmr"})`.

Aliases should probably be kept through phase 1 (MVP consumers exist); consider dropping at phase-2 npm publish (`G3:2a`).

### 2.3 Enriched-tier tools (phase 2+ by design)

`synthi_query`, `synthi_act`, `synthi_get_audio_level`, `synthi_wait_audio_event`, `synthi_get_process_state`, `synthi_get_metrics`, `synthi_get_labels`, `synthi_fill_form`, `synthi_click_text`. All runtime-advertised when a cooperative enriched-tier backend is present — deferred to phase 2 per ultraplan §Enriched.

### 2.4 Snapshot/restore (phase 3 by design)

`synthi_snapshot`, `synthi_restore`. Phase 3.

---

## 3. MCP infrastructure gaps

These are gaps inside `mcp/synthi-mcp/src/` — code we could ship without touching the backend.

| Gap | Ultraplan section | Present state | Action |
|-----|-------------------|---------------|--------|
| `delta` envelope for tool responses | §Tool surface, Response envelope | Only `full` shape today; `delta` exists for resource subscriptions via `notifications/resources/updated`. High-frequency tools (`synthi_health`) could benefit but aren't hurting anyone today. | Defer until a profile shows envelope bytes are a real cost. |
| Change-only emission inside `full` | §Response envelope | Session envelope sends all fields on every response. | ~50 LOC to track per-client last-sent snapshot + omit unchanged fields. |
| `envelope.ts` helper | §Files | Logic is scattered across `session.ts` + `tools/shared.ts`. | Consolidation refactor, not a feature. |
| `packages/synthi-ui-coords/` workspace package | §Files | Doesn't exist. Frontend and MCP would both benefit from shared letterbox coord math. | Blocked on pnpm workspace decision; defer. Current MCP doesn't do letterbox (worker sends raw coords). |
| `werift` fallback for `@roamhq/wrtc` | §Risks | Not wired. `@roamhq/wrtc` bus-factor is a real risk (M/H per risk table). | ~1-2 days to add an env-selectable backend. Gate: has `@roamhq/wrtc` given us trouble yet? No. Defer. |
| Request-id registry + cancellation | §Files `cancel.ts`, §Testing `cancellation.test.ts` | Partial: `AbortController` in `wait/engine.ts`, but no global registry + no way to cancel an in-flight `synthi_locate` (claude_api call keeps running even if agent abandons). Spec says: "cancel mid-`synthi_locate`; assert outbound Claude API call is aborted (no billing on cancelled request)." | ~80 LOC to pipe an AbortSignal through the claude_api backend + register it against `request_id`. |
| Graceful shutdown | §Files `shutdown.ts` | `index.ts:41-50` has a SIGINT/SIGTERM handler that calls `session.detach()`. Close-ordering (DC → PC → WS) is correct in `peer.ts` but not guaranteed in tests. | Add a smoke test that assigns a signal handler; asserts clean teardown under SIGTERM. |
| Protocol version handshake on signaling client | §Architecture | `synthi_attach` returns a protocol block, but the WS signaling register envelope doesn't carry a version. A newer worker could reject an older MCP. | Worker + signaling-server would need to co-evolve here; coupled gap. Defer. |
| Warming-progress fields in envelope | §Response envelope | Advertised but never populated because the worker doesn't emit warming-stage events. Envelope carries the field shape. | Blocked on worker `warming-progress reporter`; MCP-side is ready. |
| Prometheus `/metrics` endpoint | §Cost observability, §Files `usage.ts` | Counters exist (`synthi_get_usage` reports them) but no `http.createServer` scraping endpoint. | ~30 LOC to add an opt-in `PROMETHEUS_PORT=9464` listener in `index.ts`. Blocks nothing but blocks the test `quota_metrics.test.ts` from being live. |
| Locator re-resolution Prometheus counters | §Testing `locator_metrics.test.ts` | No histogram + no labels today. The cache exists, but metrics don't count by `mode` / `reason`. v4.4 adds sum invariants — we have neither the counters nor the invariants. | Needed alongside the `/metrics` endpoint. |
| Shared coord math | §Files `coords.ts` | Not present — MCP sends raw pixel coords directly without letterbox math. Frontend has its own letterbox logic. | Non-blocking: MCP and browser both render against Xvfb at matching resolution. Letterbox math matters when the target surface ≠ Xvfb surface (mobile viewport, downscaled frame). Defer until it breaks. |
| MCP resources `delta` envelope tightening | §MCP resources | We emit `text/plain` or `application/json` payloads but don't truly `delta` — we send the full current snapshot on every push. | Low-value until envelope bytes are a problem. |

---

## 4. Worker (backend/synthi-webrtc-compiler/worker/) gaps

These are the load-bearing worker-side changes the ultraplan commits to phase 1.

### 4.1 Staged / ready-to-wire

| Gap | Current state | Migration guide |
|-----|---------------|-----------------|
| Multi-PC + observer co-attach | **peer_id wire end-to-end (signaling stamp + direct-route + worker stamp + MCP auto-stamp + input peer-tagging + live-test 2-observer smoke) shipped**; `worker/src/webrtc/{peer_registry,track_fanout}.rs` scaffolded + unit-tested; `main.rs` still uses singleton `pc` + `log_channel_store` for the media + compile-reply paths. | `worker/src/webrtc/G3_PHASE_B_INTEGRATION.md` — remaining steps: per-peer PC routing in offer/candidate/reset arms, migrate 6 log_channel_store compile-DC readers to `registry.get(&peer_id).build_log_dc`, wire TrackFanout in video_pipeline.rs, verify HMR replace_track collapses. ~300 LOC; follow-up PR. |
| Frame-advance emission `{type:"frame-advance", frame_seq, ts_ms}` | MCP gate is live and dormant. Worker must emit at GStreamer appsink. | One-line add at the appsink callback: after `track.write_rtp(...)`, call `if let Some(dc) = build_log_dc { dc.send_text(...) }`. Activates §4.4 gate immediately. |

### 4.2 Not started (phase-1 backend scope)

| Gap | Ultraplan ref | Why it matters |
|-----|---------------|----------------|
| Input dispatch ack on every input | §Tool surface ("Dispatch-ack from worker on every input"), §Testing `cancellation.test.ts` | Currently input is fire-and-forget. Without an ack, the MCP can't know the worker actually received + executed the event. `synthi_mouse`/`synthi_keyboard` return `dispatch_id` but the worker never confirms it. |
| Window-tree-aware focus lock | §Security | The ultraplan's "correct boundary" for input injection. Stopgap in place: worker forwards to whatever window has focus. Phase-1 real: worker tracks guest root PID + descendant windows + gates input dispatch on that set. |
| `WM_CLASS` spoof check via `/proc/<pid>/exe` | §Security (v4) | Defense-in-depth against a malicious guest setting `WM_CLASS="code"` to bypass shell-pattern checks. ~100 LOC Rust. |
| Context-aware sensitive-action | §Security | MCP has the heuristic (`src/wire/input.ts` + `src/security/injection.ts`); worker has no `WM_CLASS` emission alongside frames. Incomplete without the worker half. |
| Seccomp profile (permissive default) | §Security | Not started. Ships iteratively per language fixture. |
| Source-state reporter with `last_changed_files` (worker side) | §Source state, §Modified backend | MCP has the producer (compile auto-emits + `synthi_report_source_state`). Human-driven edits via frontend → collab-server → worker are uncovered until the worker emits source-state events on compile-trigger. |
| Reset-guest support | §Tools (`synthi_reset_guest`) | MCP tool ships as record-intent (`applied:false`). Worker must accept a control-plane reset-guest message + restart the guest process. |
| Synthetic HMR-overlay calibration hook | §Implementation phases, §Phase 0.5 ad-hoc | `pipeline_budget_ms` is a fallback 80ms default. Worker should measure paint/encode/transport on warm-up + report, so MCP can honor the real number. |
| Warming-progress reporter | §Session lifecycle | MCP envelope carries the field; worker must emit. Session states `warming` / stage transitions flow here. |
| `migrating` state propagation | §Session lifecycle | Worker pod relocation → MCP needs to know. Today `migrating` is an advertised wire state but no code path sets it. |
| Structural-change pHash gate at HMR `applied` | §Correctness | 16-threshold full-frame + 8-threshold region-pHash flush gate on queued inputs. pHash-unavailable → fail-closed. Unshipped; input-during-compile is currently "fire and hope." |
| Frame-at-queue capture | §Correctness | Same gate — requires worker to snapshot the current frame at input-queue time, compare to applied-frame. |

**Signaling-server:**

| Gap | State |
|-----|-------|
| Protocol version handshake | Not started. |
| Presence count reporting | Not started. |
| Multi-peer observer fan-out | ✅ shipped commit `3f6f1b6a`. |

**Collab-server (`backend/collab-server/`):**

| Gap | State |
|-----|-------|
| Session lifecycle REST query | Not started. MCP can't ask collab-server whether a session is `warming` / `migrating` / `terminated` without fabricating it from worker signals. |
| Warm endpoint | Not started. Would let the MCP pre-warm a hibernated worker before a long-running agent loop starts. |
| Migrating-state hook | Not started. Worker relocation currently is invisible upstream. |

---

## 5. Test coverage gaps

We have **245 unit tests** across 22 files and **3 integration tests** (`SYNTHI_MCP_E2E=1`). The ultraplan §Testing lists **30+ layer-2 integration tests** as phase-1 scope (one per correctness-table row, minimum). Present vs missing:

**Shipped (in `tests/integration/`):** basic e2e. Does not cover correctness-table rows individually.

**Missing layer-2 integration tests (explicit in ultraplan §Layer 2 — integration):**

- `connect.test.ts`, `reconnect.test.ts`, `click_sdl2.test.ts`, `click_swing.test.ts` (swing deferred), `verify_sdl2.test.ts`, `source_state.test.ts`, `hmr_correctness.test.ts`, `input_during_compile.test.ts`, `frame_stale.test.ts`, `process_hung.test.ts`, `session_migrating.test.ts`, `focus_drift.test.ts`, `sensitive_action.test.ts`, `wm_class_spoof.test.ts`, `session_lifecycle.test.ts`, `protocol_version.test.ts`, `multi_agent.test.ts`, `quota_metrics.test.ts`, `prompt_injection.test.ts`, `non_local_signaling.test.ts`, `reset_guest.test.ts`, `vision_backend.test.ts`, `cancellation.test.ts`, `pipeline_budget_calibration.test.ts`, `locator_hints.test.ts`, `presence_counts.test.ts`.

Plus the v4.1/v4.2/v4.3/v4.4 additions:

- `input_structural_change.test.ts`, `input_phash_unavailable.test.ts`, `reconnect_zero_survivors.test.ts`, `region_phash_animated.test.ts`, `pHash_region_hint.test.ts`, `locator_resolution_cached_hits.test.ts`, `multi_peer_signaling.test.ts`, `frame_advance_message.test.ts`, `vision_cost_measurement.test.ts`, `locator_metrics.test.ts`, `reconnect_subsequent_state.test.ts`.

**Total layer-2 integration gap: ~35 tests.** Many are fixture-coupled (need `counter_sdl2` + `adversarial` in a running worker) and gate on worker changes listed above.

**Chaos tests (§Layer 4):** phase-1 hooks only; full suite is phase 2.

**Soak tests (§Layer 5):** phase 3.

**Manual QA (§Layer 6, `TESTING.md`):** 15-step golden path per client harness. Not written.

---

## 6. Phase 0.5 live-run gaps

`PHASE_0_5_FINDINGS.md` is a template. Run 1 (sim mode) populated. Live runs pending:

- **E1 live** @ 60fps on counter_sdl2 — gates frame-seq gate ship decision.
- **E1b live** @ 30fps + VFR (conditional — runs if E1 marginal).
- **E2 live** on counter_sdl2 — gates region-pHash cache ship.
- **E2b live** on particle_demo — gates region-pHash on animated UI.
- **E3 live** on real Anthropic API — gates `claude_api` default vs flip to `agent_side`.
- **E4 live** 30-min cost loop — gates phase-2 `MAX_VISION_COST_USD_PER_HR` enforcement default.

Ad-hoc live-only measurements (§Phase 0.5 ad-hoc): frame-age distribution end-to-end, two-browser-peer confirmation (Path A sanity), pipeline_budget_ms components via HMR overlay, input-queue depth B2, F2 recal cadence, F4 VFR frame intervals.

All blocked on `docker-compose up -d` + fixture compilation. The harness + fixtures are in-tree; no code work needed before running.

---

## 7. Fixtures + documentation gaps

### 7.1 Fixtures

| Fixture | State | Scope |
|---------|-------|-------|
| `counter` (C++ SDL2 static) | ✅ shipped | phase 0.5 + phase 1 universal-tier bar |
| `particle_demo` (C++ SDL2 animated) | ✅ shipped | phase 0.5 E2b |
| `counter_swing` (Java Swing a11y) | ❌ not shipped | phase 2 enriched-tier (§Fixtures) |
| `adversarial` | ❌ not shipped | phase-1 prompt-injection + WM_CLASS spoof tests (`prompt_injection.test.ts`, `wm_class_spoof.test.ts`) — gated on fixture |

### 7.2 Documentation

| Doc | State | Scope |
|-----|-------|-------|
| `mcp/synthi-mcp/README.md` | ✅ phase-1 rewrite shipped | — |
| `TESTING.md` (manual QA 15-step golden-path per client) | ❌ not written | phase 1 |
| Both README variants (claude_api default + agent_side default) | ❌ not drafted | E3 decision avoidance (§E3 remediation prep) |
| Per-client configs tested against live installs | ⚠️ only Claude Code automated | phase-1 scope per v4.2; non-CC-clients = backlog ticket `J1` |
| `docs/AGENT_PROMPTING_GUIDE.md` | ❌ not written | backlog `I2` |
| `docs/DESIGN_LOCAL_VISION.md` | ❌ not written | backlog `D6` |

---

## 8. Phase 2+ deferred (explicitly)

Per `PHASE_2_PLUS_BACKLOG.md`:

- **D6** — Local vision backend architecture + pod spec. ~1 week design + phase 3 implementation.
- **G3** — Phase 2 re-scoping (2a–e sub-phases). Required before phase 2 execution.
- **H1** — Performance regression CI. 1 week.
- **H5** — Distributed tracing (trace-id propagation, OpenTelemetry). 1.5–2 weeks.
- **I2** — Agent-prompting guide (per-client, anti-patterns, cost awareness). 1 week.
- **J1** — Headless mock harnesses for Codex/Cursor/Gemini/Windsurf CI. 2 weeks.
- **K1** — `synthi_verify.scene_matches` VLM predicate (needs usage audit first). 3–5 days after audit.
- **L1** — Cross-subprocess session persistence. 1.5 weeks (option b) to 2–3 weeks (options a/c).
- **L2** — Reinstate `synthi_set_goal` (gated on operator-UI commit). 1 week post-G3:2d.

---

## 9. Ultraplan pre-work items (phase-1 gating)

§Empirical pre-work lists 8 items. Status:

1. Two-"browser"-peer allowance — ✅ resolved 2026-04-17 (Path B committed, observer role shipped).
2. HMR status emission audit — ✅ resolved (F2 table in implementation plan v2).
3. Existing usage counters — ❌ not done. Would surface whether collab-server/worker already counts tool calls/egress/hot-time. Today `synthi_get_usage` counts on the MCP side only.
4. Encoder timestamp availability — ⚠️ partial (v4.2 research identified hook sites; bridging message unshipped).
5. Guest root-PID capture — ❌ not done. Needed for focus lock.
6. Binary fingerprint registry — ❌ not done. Needed for WM_CLASS spoof check.
7. Presence count source — ❌ not done.
8. MCP process crash recovery pattern per top-4 clients — ⚠️ Claude Code verified; others best-effort (backlog `J1`).

Each of items 3/5/6/7 is a 0.5–1 day investigation, not construction. Each unblocks a phase-1 worker change above.

---

## 10. What a sensible "phase-1 completion" cut looks like

If the goal is "phase-1 is shipped against the ultraplan," the honest work remaining falls into these buckets, in rough dependency order:

**A. MCP-only tool + infrastructure (lands standalone):**
- `synthi_describe` (both modes).
- `synthi_acquire_input` / `synthi_release_input` (wire stubs).
- `synthi_request_human` / `synthi_annotate_and_ask` / `synthi_recent_human_actions` (wire stubs + `escape_hatch_backend_not_implemented` error for the real path).
- Request-id registry + cancellation piped into claude_api.
- Prometheus `/metrics` endpoint + locator counters with sum-invariant tests.
- Graceful shutdown test.
- Both README variants drafted for E3 decision.
- `TESTING.md` manual QA.

**Estimated effort:** 3–5 focused days.

**B. Worker scaffold completion (staged via `G3_PHASE_B_INTEGRATION.md`):**
- `main.rs` multi-PC migration (log_channel_store → PeerRegistry; per-peer PC on offer; per-peer track sub).
- Frame-advance emission.
- Input dispatch ack.
- Window-tree-aware focus lock + guest root-PID capture (pre-work #5).
- WM_CLASS spoof check + binary fingerprint registry (pre-work #6).
- Source-state reporter with last_changed_files.
- Reset-guest support.
- Warming-progress reporter + migrating-state propagation.
- Structural-change pHash gate + frame-at-queue capture + pHash-unavailable fail-closed.
- Pipeline-budget calibration probe.

**Estimated effort:** 2–3 focused weeks of Rust work.

**C. Signaling + collab-server glue:**
- Protocol version handshake on signaling.
- Presence count reporting.
- Collab-server session lifecycle REST + warm endpoint + migrating hook.

**Estimated effort:** 3–5 days.

**D. Integration tests landed alongside the features in A–C.** Roughly 35 tests at ~1–2 hrs each; ~1 week real-time.

**E. Live-mode phase 0.5 runs + the adversarial fixture:**
- Bring up docker-compose against counter_sdl2 + particle_demo.
- Run E1/E1b/E2/E2b/E3/E4.
- Update `PHASE_0_5_FINDINGS.md` with real numbers.
- Build `adversarial` fixture + run `prompt_injection` + `wm_class_spoof` tests.

**Estimated effort:** 2–3 days if everything stands up cleanly; open-ended if the spike surfaces genuinely new questions.

**Overall phase-1 completion:** 4–6 weeks of focused work, consistent with the ultraplan's original "~4 weeks" phase-1 estimate (slightly over because we've shifted some work to make the scaffold clean).

---

## 11. What we're NOT counting here

- Phase 2 (distribution, enrichment, arbitration enforcement, operator UI, quota enforcement, audio tee) — `G3` sub-phases, ~8–10 weeks.
- Phase 3 (snapshot/restore, local vision, soak, escape-hatch UI) — ~2 weeks per ultraplan, realistically longer once local vision design lands.
- Phase 4 (remote auth: `mcp-agent` role, scoped agent-token, TURN).

These are in the ultraplan but outside the "ship phase 1" scope.

---

## 12. Meta — research process + caveats

Sources re-read for this pass:
- `AGENT_MCP_ULTRAPLAN.md` (§Tool surface 399-561, §Server-enforced correctness 561-612, §Security 612-704, §Files 1225-1302, §Implementation phases 1303-1446, §Risks 1574-1606, §Open items 1608-1671, §Testing plan 1463-1572).
- `AGENT_MCP_MVP.md` (full).
- `AGENT_MCP_STATUS.md` (full).
- `PHASE_2_PLUS_BACKLOG.md` (full).
- `PHASE_0_5_FINDINGS.md` (full).
- `mcp/synthi-mcp/src/tool_registry.ts` (23 entries).
- `mcp/synthi-mcp/src/server.ts` (scanned for tool name references).
- `mcp/synthi-mcp/src/{correctness,events,resources,security,verify,protocol,locate,wait,util,wire}/` listings.
- `mcp/synthi-mcp/tests/{unit,integration,spike,e2e,fixtures}/` listings.
- `backend/synthi-webrtc-compiler/worker/src/webrtc/{peer_registry.rs,track_fanout.rs,mod.rs,G3_PHASE_B_INTEGRATION.md}`.

Sampling SDK verification:
- `mcp/synthi-mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts:137-150` — `server.createMessage` exists.
- `.../types.d.ts:3578-3660` + `spec.types.d.ts:1440-1560` — full schema with image content blocks.
- Upstream issue anthropics/claude-code#1785 — Claude Code client handler not implemented.

**Caveats:**
- "23 advertised tools" is the actual registration at `tool_registry.ts`; a closed-loop audit against `server.ts` schema declarations would catch drift if someone registered a schema without adding to the registry. Not audited here.
- Worker file:line pointers in `G3_PHASE_B_INTEGRATION.md` were verified once (2026-04-18 session); later commits may have shifted lines.
- `ClaudeCode sampling not implemented` was verified via an agent that read docs + release notes + the upstream issue — not by directly exercising `server.createMessage` against Claude Code. (Direct test = best-verify; time was limited; upstream issue is authoritative enough.)
