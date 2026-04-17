# Agent MCP — Phase 2+ Backlog

**Companion to** `AGENT_MCP_ULTRAPLAN.md`.
**Status:** items deferred from v4 ultraplan review. Ticket-sized, not in phase-1 scope.
**Date:** 2026-04-17

Each entry is a standalone ticket: context, scope, done criteria, dependencies, effort. Entries are *not* prioritized against each other — that happens when phase 1 lands and phase 2 is re-scoped (see `G3`).

---

## D6 — Local vision backend: architecture + pod spec

### Context

Ultraplan commits to `SYNTHI_VISION_BACKEND=local` as a phase-3 target but doesn't specify *which* model, *how* it's hosted, *how* it's mounted into the worker, or *what* the cold-start budget is. `claude_api` default and `agent_side` carry phase 1; `local` is the privacy/cost/latency endgame for self-hosted deployments.

### Scope

1. **Model selection.** Pick between grounding-DINO, SAM+CLIP, or a VLM derivative. Tradeoffs:
   - Grounding-DINO: small (~200MB), good at text-query → bbox. No scene description.
   - SAM+CLIP: segments everything, CLIP similarity to description. More work per frame.
   - Small VLM (e.g., Phi-3-vision): description + locate in one pass. Larger model (~3GB+).
2. **Pod architecture.** Per-worker sidecar, or shared cluster-wide vision pod with RPC, or lazy-loaded on-demand container?
3. **Mount strategy.** Model weights baked into worker image (fast cold start, bloated image) vs. PVC mount (thin image, slower cold start).
4. **Cold-start budget.** First `synthi_locate` after pod creation — worst acceptable latency (proposal: 5s p95).
5. **Eviction policy.** Multiple sessions per worker — shared model instance? Per-session? LRU eviction?
6. **Quality gate.** Benchmark against `claude_api` on the counter_sdl2 fixture — if local accuracy < 80% of claude_api on locator grounding, ship falls back to claude_api rather than offering local.

### Done criteria

- `DESIGN_LOCAL_VISION.md` committed under `docs/`.
- Model-choice + pod-arch decision documented with benchmark numbers.
- Worker-pod manifest change drafted.
- Phase-3 implementation plan generated from the design doc.

### Dependencies

- Phase 1 must have shipped (`claude_api` + `agent_side` working end-to-end as the comparison baseline).
- Worker pod-spec ownership clarified (platform-team review needed for mount strategy).

### Effort estimate

**Design + benchmark:** 1 week. **Implementation:** phase 3 (~1–2 weeks depending on choice).

---

## G3 — Phase 2 re-scoping

### Context

V3.1/v4 phase 2 packed: npm publish + Swing enriched + `synthi-probe` (4 languages) + broker + worker-side lease + audio tee + operator UI + quota enforcement + chaos suite. That's ~3 weeks in the plan but honestly closer to 6–8 weeks if done properly. Under-scoping phase 2 in the plan = over-scoping it in practice = missed dates.

### Scope

Re-plan phase 2 after phase 1 lands. Decompose phase 2 into named sub-phases with independent delivery gates:

- **Phase 2a — Distribution.** npm publish, per-client configs, smoke tests on releases. (~1 week)
- **Phase 2b — Enrichment.** Swing adapter, `synthi-probe` (C + JS first; Java + Python later). (~2 weeks)
- **Phase 2c — Arbitration & scaling.** Broker + worker-side input lease. (~2 weeks)
- **Phase 2d — Observability.** Operator UI + quota enforcement + audio tee. (~2 weeks)
- **Phase 2e — Chaos suite.** Full chaos runner + CI integration. (~1 week)

### Done criteria

Phase-1-post-mortem doc exists. Phase 2 split into a–e with independent gates. Each sub-phase has its own scope + deferral list.

### Dependencies

- Phase 1 must have shipped.
- Phase 0.5 findings (measurements) feed into phase 2a–e planning.

### Effort estimate

**Re-scoping exercise:** 2–3 days. **Execution:** 8–10 weeks across phase 2a–e (vs. the 3-week phase 2 in the plan today — this is the point of the re-scope).

---

## H1 — Performance regression CI

### Context

Phase 1 ships metrics (Prometheus + `synthi_get_usage`). No CI pipeline asserts those metrics don't regress between commits. Phase 2 risk: each incremental feature adds 5ms frame-age latency, or 10% more tool-call count per fixture run, or 5% more vision cost — no alarm fires until production.

### Scope

1. **Benchmark harness.** Canonical 5-minute agent loop against counter_sdl2 fixture. Records:
   - Frame-age p50/p95/p99
   - `synthi_locate` p50/p99
   - Tool-call count
   - Vision-inference count + cost estimate
   - Envelope bytes per tool
   - Memory footprint (MCP + worker peak RSS)
2. **Baseline.** Pin after phase 1 ships; stored in `benchmarks/baseline_v1.json`.
3. **CI gate.** PR runs harness; compares vs. baseline; fails if any metric regresses > 10% (configurable per-metric).
4. **Flaky signal handling.** Run harness 3× on CI; take median; if variance > 20% across runs, mark non-blocking and alert.
5. **Upgrade policy.** Baseline bumps require explicit PR approval — no silent drift.

### Done criteria

- `benchmarks/` directory with harness + baseline.
- CI workflow that runs harness on PRs, fails on regression.
- Dashboard that shows metric drift over the last 30 commits.

### Dependencies

- Phase 1 metrics shipped (Prometheus + `synthi_get_usage` + envelope instrumentation).
- Stable fixture (counter_sdl2) compiled reliably in CI.

### Effort estimate

**1 week.** Harness is the main work; CI integration is standard.

---

## H5 — Distributed tracing

### Context

Agent makes a tool call. Call passes: agent → MCP stdio → MCP signaling client → signaling-server → worker → guest. Debugging a slow or wrong response requires correlating events across 5 processes. Logs alone make this an archaeology exercise.

### Scope

1. **Trace-id propagation.**
   - MCP generates a `trace_id` per tool call (OpenTelemetry-compatible UUID).
   - Trace-id carried in signaling messages (field on envelope).
   - Trace-id carried in data-channel frames (on input dispatches especially).
   - Worker attributes HMR events + input dispatches to trace-id.
   - Guest hook (opt-in, not required): `synthi-probe` exposes a trace-id context for guest-side correlation.
2. **Emission backend.** OpenTelemetry OTLP → choice of Jaeger / Tempo / Honeycomb. Start with local Jaeger for dev.
3. **Sampling.** 100% in dev, configurable in prod (default 10%).
4. **Sensitive-content redaction.** `keyboard.type` contents stripped from traces by default; opt-in via `SYNTHI_TRACE_INCLUDE_KEYSTROKES=1`.

### Done criteria

- Trace spans visible in Jaeger for a full agent loop (attach → locate → click → wait → screenshot → verify).
- Span attributes include `frame_seq`, `dispatch_id`, `session_id`, tool name.
- README section on how to enable + read traces.

### Dependencies

- Phase 1 protocol stable (trace-id is a wire-format addition).
- Signaling-server willing to propagate unknown header fields (protocol forward-compat — already designed for).

### Effort estimate

**1.5–2 weeks.** Worker instrumentation is the heavy part.

---

## I2 — Agent-prompting guide

### Context

Server-enforced correctness means agents see structured errors with `required_tool_call`. That only works if the agent's system prompt + tool-use training actually reads those errors. Client-specific quirks: Claude Code has its own retry logic, Codex CLI has different abort semantics, Cursor caches tool results aggressively, Gemini CLI handles stdio MCP differently than SSE.

Without a guide, every first-time integrator re-learns the same traps.

### Scope

`docs/AGENT_PROMPTING_GUIDE.md` covering:

1. **Per-client setup.** `claude mcp add synthi ...`, Codex `~/.codex/mcp.json`, Cursor `~/.cursor/mcp.json`, Gemini CLI `~/.gemini/mcp.json`, Windsurf config.
2. **System-prompt patterns that work.** Recommended phrasing for agents:
   - *"When a synthi tool returns an error with `required_tool_call`, invoke that tool before retrying the original."*
   - *"Treat `frame_stale` and `process_hung` as hard stops — back off, call `synthi_health`, decide based on output."*
   - *"Prefer `synthi_locate` with hints over raw coordinates; the locator expires 30s or on pHash drift."*
3. **Anti-patterns.**
   - Polling `synthi_screenshot` in a tight loop without checking `synthi_health` freshness.
   - Ignoring `session.unsafe_mode` envelope flag.
   - Calling `synthi_keyboard` in editor without `confirm: true` on shell-risky strings (will fail deterministically).
4. **Cost awareness.**
   - Per-call `claude_api` vision cost estimates; when to prefer `agent_side`.
   - Sample quotas to set on long-running loops.
5. **Trace samples.** Recorded Claude Code trace showing good + bad patterns side-by-side.

### Done criteria

- Guide published in `docs/` with per-client configs tested against live installations.
- Reference trace included showing a successful "edit → HMR → verify" loop.
- "Common mistakes" section with the 5–10 patterns we'll see most.

### Dependencies

- Phase 1 ships (there's nothing to prompt against until then).
- At least one fully-working end-to-end demo on each of the top 3 clients (Claude Code, Cursor, Codex).

### Effort estimate

**1 week** after phase 1 ships. Longer if client-specific quirks surface late.

---

## J1 — Headless mock harnesses for non-Claude-Code MCP clients

### Context

Phase 1 claims "Tier-1 support" across Claude Code, Codex, Cursor, Gemini CLI, and Windsurf, but CI-automates only Claude Code. v4.2 tightened the README to "CI-automated for Claude Code; best-effort manual for others," which is honest but leaves a regression risk: MCP clients handle tool-call streaming, markdown parsing, context windows, and stdio EOF differently. A semantic change landing in phase 1.5 or phase 2 could silently break one of the four manual clients.

### Scope

Build headless mock harnesses that drive each of Codex, Cursor, Gemini CLI, Windsurf against `synthi-mcp`. "Headless" = no real client UI; replay recorded tool-call sequences that exercise the semantics each client cares about (stdio buffering, partial-response handling, tool-list refresh, stderr capture, connection drop behavior).

1. **Harness base.** Common test runner. Per-client adapter reuses the client's actual MCP transport (stdio subprocess) with a recorded-trace driver instead of the real LLM.
2. **Trace catalog.** 5-10 representative agent loops per client (attach → screenshot → click → wait_hmr → verify). Captured once from live sessions; re-played deterministically in CI.
3. **Per-client quirks tested.**
   - Codex: different abort semantics on long-running tool calls.
   - Cursor: aggressive caching of tool results across turns.
   - Gemini CLI: stdio framing differences.
   - Windsurf: smaller context window → tool-list compression matters.
4. **CI integration.** Runs nightly; PR-optional. Regression threshold: any client that passed last commit must pass this commit.

### Done criteria

- Harness runs all four clients in CI without a live LLM.
- Regression catches a deliberately-broken MCP change (e.g., tool-list message format flip).
- Failure output points at the client-specific symptom, not a generic "MCP connection failed."

### Dependencies

- Phase 1 ships (there's nothing to harness against until then).
- Each client's MCP transport layer documented well enough to emulate.

### Effort estimate

**2 weeks** — one week of base harness + trace catalog, one week of per-client adapters and CI integration.

---

## K1 — `synthi_verify.scene_matches` VLM predicate

### Context

v4.2 stripped `scene_matches` from phase 1 `synthi_verify` to keep the server from becoming a black-box VLM reasoning engine. Agents route complex visual reasoning through `synthi_describe` + their own reasoning. If usage evidence from phase 1 + phase 2a-c shows agents repeatedly reconstructing "verify a scene description" via describe + post-hoc reasoning AND the pattern is stable enough that pushing it server-side would be a clean win (caching, shared vision), reintroduce `scene_matches`.

### Scope

1. **Usage audit.** Before implementing: log (with agent consent) tool-call traces that pair `synthi_describe` with agent-side reasoning about the returned summary. Identify traces that are effectively "is scene X described in the frame?" queries.
2. **Cost analysis.** Would a server-side `scene_matches` reduce the total vision inference count per query (cache once, predicate many) vs. current pattern (agent re-describes on each retry)? If <2x reduction, don't implement.
3. **Predicate design.**
   - Input: `{kind: "scene_matches", description: string, threshold?: number}`.
   - Output: `{kind: "scene_matches", matched_phrase, confidence, describe_trace_id}` — describe_trace_id lets agents pull the underlying VLM output for debug.
   - Depth/clause bounds (v4.2): counts as 1 against the depth-4 budget.
4. **Cost control.** Share the same cache key as `synthi_describe` so repeated verify-of-describe patterns share the underlying vision call.
5. **Opt-in behind capability flag.** `capability_manifest.synthi_verify_supports_scene_matches: true` — clients without vision-capable backend don't see the predicate.

### Done criteria

- Usage evidence documented in `docs/K1_USAGE_EVIDENCE.md` before implementation.
- Predicate re-enabled behind capability flag.
- Cost analysis shows ≥2x reduction in vision inferences for the targeted pattern.
- Integration test: `verify({kind:"scene_matches", description:"counter shows 10"})` passes on SDL2 fixture after appropriate HMR cycle.

### Dependencies

- Phase 1 shipped.
- At least 3 months of real agent usage data from phase 1 + 2a deployments.

### Effort estimate

**Usage audit:** ongoing. **Implementation (if greenlit):** 3-5 days.

---

## L1 — Cross-subprocess MCP session persistence

### Context

Phase 1 `synthi-mcp` keeps all session state (capability manifest, event log, locator handles, subscriptions) in Node process memory. A crashed or respawned MCP subprocess starts fresh — agents cannot resume via `synthi_reconnect` because the new process has no session to reconnect to; they must call `synthi_attach`. This is documented (v4.2 §MCP process failure modes), not a bug. But for long-running agent loops (hours of autonomous work), a single Node OOM eats all accumulated session state — locator handles, event-log history, capability manifest — and agents restart reasoning from zero.

### Scope

1. **Decide what's safe to persist.**
   - Event log (safe — it's a ring buffer of serializable events).
   - Locator handles (partially — bboxes + region-pHash can persist; but the underlying `frame_seq` is meaningless across subprocess boundaries without WebRTC-state continuity).
   - Capability manifest (safe — immutable per session).
   - Subscription state (safe — just resource list + seq).
   - RTCPeerConnection (NOT safe — cannot serialize).
2. **Persistence transport.** SQLite file per session in `~/.synthi/sessions/<session_id>.db`. Write-through on every meaningful state change (event-log append, handle resolve, subscription update).
3. **Subprocess handoff for WebRTC.** The hard problem. Options:
   - (a) Keep `RTCPeerConnection` in a long-lived helper daemon; MCP subprocess connects to daemon via Unix socket. Daemon-crash = full reconnect.
   - (b) Fresh subprocess always re-establishes WebRTC (full `synthi_attach`), but inherits session metadata from SQLite — agents don't lose event-log context.
   - (c) File-descriptor passing over Unix socket — transfer the underlying UDP socket to the new subprocess. Feasible on Linux; complicates `@roamhq/wrtc` internals.
4. **`synthi_reconnect` extension.** New mode `synthi_reconnect({subprocess_restart: true})` reads persisted state, reconstructs session metadata, performs fresh `synthi_attach` to pick up a new peer — agents see a coherent session even across process crashes.

### Done criteria

- `~/.synthi/sessions/` persistence layer.
- Option (b) minimum: session metadata persists; WebRTC re-establishes; agent-visible state coherent.
- Integration test: kill MCP mid-session; restart; call `synthi_reconnect({subprocess_restart: true})`; assert event-log history present, capability manifest unchanged, handles marked `stale_requires_reresolve` (not `expired`).

### Dependencies

- Phase 1 shipped.
- Real usage data showing process-crash frequency high enough to justify complexity (if agents never crash MCP subprocesses in practice, this is wasted work).

### Effort estimate

**1.5 weeks** for option (b); **2-3 weeks** for options (a) or (c).

---

## L2 — Reinstate `synthi_set_goal` with operator-UI use case

### Context

v4.2 removed `synthi_set_goal` from phase 1 because declarative intent with no auto-verification and no committed operator-UI contract was tool-surface bloat. If phase 2 operator UI commits to concrete goal-aware features (goal-scoped audit filter, goal-timeline pane, per-goal session summary), `synthi_set_goal` graduates back.

### Scope

1. **Operator-UI commitment first.** Before reintroducing the tool, commit to ≥2 concrete UI features that use the goal field:
   - **Goal timeline:** vertical pane showing goal-scoped session segments with nested tool calls + event log.
   - **Per-goal audit export:** filter session audit log by goal label.
   - **Kill-on-goal-deviation:** operator sets expected-outcome per goal; agent drift triggers alert.
2. **Tool shape.** `synthi_set_goal({description, expected_outcome?})` → `{ok, goal_id, goal_started_at}`. Goals are stack-scoped (nested goals supported); `synthi_end_goal({goal_id})` closes.
3. **Event-log tagging.** All events between `set_goal` and `end_goal` carry `goal_id` field; audit filter uses it.
4. **No auto-verification.** Still agent-driven; `expected_outcome` is advisory (operator sees agent's own claim, can cross-check against reality).

### Done criteria

- Operator UI ships at least 2 of the 3 features above.
- `synthi_set_goal` + `synthi_end_goal` live as Operational tools.
- Integration test: agent sets goal, drives 5 tool calls, ends goal; audit export filtered by `goal_id` returns exactly those 5 + the set/end markers.

### Dependencies

- Phase 2 operator observability UI (`G3` sub-phase 2d).
- Event log carries custom tags (trivial extension).

### Effort estimate

**1 week** for the tool + event-log tagging; operator-UI work counted separately under `G3:2d`.

---

## Notes on backlog hygiene

- Each ticket above owns its own "Done criteria." When the work lands, the ticket collapses into a commit + a removal from this file.
- New items accumulate here rather than growing the ultraplan. If something belongs in phase 1 scope retroactively (post–phase-0.5), it graduates *out* of this file and into the ultraplan by an explicit edit, not by osmosis.
- This file is not a wish-list. Items here are *committed* to being addressed, just not in phase 1. If an item isn't committed — it doesn't belong here; it belongs in a scratchpad or nowhere.
