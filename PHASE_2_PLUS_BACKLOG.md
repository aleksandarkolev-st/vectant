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

## Notes on backlog hygiene

- Each ticket above owns its own "Done criteria." When the work lands, the ticket collapses into a commit + a removal from this file.
- New items accumulate here rather than growing the ultraplan. If something belongs in phase 1 scope retroactively (post–phase-0.5), it graduates *out* of this file and into the ultraplan by an explicit edit, not by osmosis.
- This file is not a wish-list. Items here are *committed* to being addressed, just not in phase 1. If an item isn't committed — it doesn't belong here; it belongs in a scratchpad or nowhere.
