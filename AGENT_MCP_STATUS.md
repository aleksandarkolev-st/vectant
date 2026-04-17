# Synthi MCP — Status

**Status:** phase 0.5 instrumentation + phase 1 code complete (in-process; no live-stack validation yet). Branch `claude/agent-mcp` @ `883056f5`. **245** unit tests green, typecheck green. Worker scaffolding (`worker::webrtc::*`) landed standalone; full main.rs multi-PC wiring staged behind `G3_PHASE_B_INTEGRATION.md`.

**Source of truth for scope:** `AGENT_MCP_ULTRAPLAN.md` (design, approved). **Source of truth for MVP gate:** `AGENT_MCP_MVP.md` (Path A shipped). **Phase 0.5 findings:** `PHASE_0_5_FINDINGS.md` (template + sim run 1). This doc is the merge view.

---

## 1. What's shipped

`mcp/synthi-mcp/` — Node 20+ TypeScript. ~40 source files + 22 unit-test files + 2 fixtures + 5-experiment spike harness. MCP registers as `role:"browser"` and evicts any existing human browser peer on the same session (Path A).

Worker scaffold landed in `backend/synthi-webrtc-compiler/worker/src/webrtc/`:
- `peer_registry.rs` — per-session `PeerRegistry` with browser eviction + observer fan-out. 6 unit tests.
- `track_fanout.rs` — broadcast-based RTP fan-out with drop-on-lag semantics. 5 unit tests.
- `G3_PHASE_B_INTEGRATION.md` — step-by-step guide for the remaining `main.rs` multi-PC wiring (staged intentionally).

### Phase 0.5 — spike infrastructure

- [x] **Fixtures.** Library-agnostic monolithic C++ sources (AI split at runtime):
  - `tests/fixtures/counter/main.cpp` — static UI (background RGB + white rect derived from `counter`).
  - `tests/fixtures/particle_demo/main.cpp` — animated particles + static UI panel.
- [x] **Region-pHash cache.** `src/util/phash.ts` (64-bit DCT pHash + hamming + regionPHash with ±20% padding / 8px floor). `src/locate/cache.ts` — hit/miss/expired/drift, TTL 30 s, drift threshold 12.
- [x] **`synthi_locate`** — mock / agent_side / claude_api backends (claude_api stubbed until phase 1 real impl lands).
- [x] **Spike harness** — E1/E2/E2b/E3/E4 in `tests/spike/`. `npm run spike:all` runs sim-mode end-to-end; live-mode stubs documented. First sim run captured in `PHASE_0_5_FINDINGS.md`.

### Phase 1 — core runtime

- [x] **Protocol + manifest.** `synthi_attach` returns `{protocol:{version:1, server_supports:[1]}, capabilities:{…}, session:{id, state, state_ts, unsafe_mode, attached_humans, attached_agents}}`. Unknown enums pass through as `"unknown"` (no crashes on forward-compat messages).
- [x] **Event log ring buffer.** 1024-entry ring. Discriminated union: `lifecycle | hmr | input | locator_resolution | console | error | security | source_state | usage`. Monotonic seq + kind/since_seq/since_ts filters + live `onAppend` subscriptions.
- [x] **Session lifecycle.** `warming | ready | running | hibernated | migrating | crashed | terminated | unknown` wire states. Crash acknowledgment gate (`ackRequired`) wired through `correctness/input_gate.ts`.
- [x] **Security primitives.** Local-allowlist signaling URL classifier + `i-understand-no-auth` flag (blocks non-local attaches). Keystroke anomaly detector (burst + monotone-repeats). Injection-heuristic pre-screen on `build-log` free-text fields (7 canonical patterns).
- [x] **Correctness error table.** 17 error codes with deterministic priority ladder + `required_tool_call` remediation. Mouse + keyboard honor the central gate.
- [x] **MCP resources.** 6 subscribable URIs (`synthi://preview/{screenshot, hmr, console, events, state, source}`) with `notifications/resources/updated` push + 2 Hz throttle on screenshot.

### Tools (23 advertised)

| Tool | Scope |
|------|-------|
| `synthi_attach` | Protocol + manifest + session envelope, with `requested_protocol_version` + `i-understand-no-auth` inputs. |
| `synthi_detach` | Clean teardown; idempotent. |
| `synthi_reconnect` | WebRTC-layer re-negotiation against same sessionId. `session_terminated` on worker gone. |
| `synthi_health` | mcp_state / wire_state / peer connectionState / DC readyStates / frames / unsafe_mode. |
| `synthi_screenshot` | `{region, max_dim, freshness_max_ms}`. `frame_stale` SLA error. |
| `synthi_wait` | 8 conditions: hmr, log, source_state, pixel, motion_settled, scene_change, element, text (text = unsupported stub → required_tool_call:"synthi_wait" with condition:"log"). |
| `synthi_wait_hmr` | Back-compat alias over wait({condition:"hmr"}). |
| `synthi_mouse` | click/double_click/move/down/up/drag/wheel + `handle` + `waitFor`. |
| `synthi_keyboard` | type/key/chord + `confirm` + `waitFor`. |
| `synthi_click` / `synthi_type` | Back-compat aliases. |
| `synthi_locate` | Handle + region-pHash cache + backend selection. `locator_resolution` events on every dispatch. **`claude_api` backend is now a real Anthropic multimodal call** with per-model pricing + usage event emission. |
| `synthi_compile` | MCP-driven compile trigger (`compile` DC dispatch). Auto-emits a source_state event for the inputs. |
| `synthi_report_source_state` | Agent-side source_state producer for flows that edit without compiling. |
| `synthi_verify` | Predicate engine: pixel / log / element_visible / and / or. ocr → ocr_backend_not_implemented; scene_matches → verify_scene_matches_unsupported. Depth ≤ 4, clauses ≤ 8. |
| `synthi_get_event_log` | Bounded query over the ring. |
| `synthi_get_source_state` | Snapshot of the most recent source_state event. |
| `synthi_get_usage` | Aggregated counters (tool_call / screenshot / vision_inference / egress_bytes) + vision_cost_usd_estimate + hot_seconds. |
| `synthi_set_quality` | Wire only (record-intent, `applied:false`). |
| `synthi_checkpoint` | Named marker in the event log. |
| `synthi_acknowledge_disruption` | Clears `ackRequired`. |
| `synthi_get_crash_info` | Snapshot of `pending_disruption` + `crash_info`. |
| `synthi_reset_guest` | Wire only (record-intent, `applied:false`). |

### Multi-peer signaling

- [x] **Signaling-server observer role.** `backend/synthi-webrtc-compiler/signaling-server/src/main.rs` refactored — peers are Vec<Sender>; `observer` appends, `browser`/`worker` evict; worker → browser+observer fan-out. 4 rust unit tests green.
- [x] **Worker webrtc/ scaffold** — `PeerRegistry` + `TrackFanout` landed standalone, unit-tested, reachable via `worker::webrtc::*`. Resolves the refined-plan risks (GStreamer max-buffers=1 HOL blocking via broadcast+drop-on-lag; teardown ordering via Drop-aborts-task; per-PC DTLS/ICE automatic).
- [ ] **Main.rs multi-PC wiring.** Remaining step: replace `log_channel_store: Option<Arc<DC>>` + singular `pc` with the new registry, per-peer PC creation on `offer`, per-peer track subscription. Migration guide in `backend/synthi-webrtc-compiler/worker/src/webrtc/G3_PHASE_B_INTEGRATION.md`.

### HMR wire coverage (`src/hmr.ts`)

Unchanged from MVP — the four-wire-family classifier remains the truth table. See prior entry in this doc for detail.

### Tests

- **Unit (Node):** **245 passing** across 22 files. New since prior snapshot: `claude_api_backend.test.ts` (26), `compile.test.ts` (10), `frame_seq_gate.test.ts` (14), `source_state.test.ts` (9).
- **Integration (Node, `SYNTHI_MCP_E2E=1`):** docker-compose scaffold, 3 tests; unchanged since MVP.
- **Spike harness (Node):** 5 experiments, sim mode end-to-end; live mode stubbed.
- **Unit (Rust, signaling-server):** 4 passing (role classification, target routing, target_key roundtrip).
- **Unit (Rust, worker webrtc/):** 11 tests scaffolded (6 peer_registry + 5 track_fanout); pre-existing workspace test-target compile errors in `hmr/` modules prevent full `cargo test` run today — module compiles cleanly via `cargo check --lib`.
- **Real-agent smoke:** `tests/e2e/claude_code_smoke.sh` (requires docker-compose + Claude Code CLI).

### Docs

- [x] `mcp/synthi-mcp/README.md` — full phase-1 rewrite (23 tools + 6 resources + manifest + per-client configs + security + testing + known-limitations pointer here).
- [x] `AGENT_MCP_MVP.md` — Path A amendment 2026-04-17.
- [x] `AGENT_MCP_STATUS.md` — this file.
- [x] `PHASE_0_5_FINDINGS.md` — run-1 sim results + live-run TBDs.
- [x] `mcp/synthi-mcp/tests/spike/README.md` — how to run the spike.
- [x] `mcp/synthi-mcp/tests/fixtures/README.md` — fixture shape + library-agnosticism note.

---

## 2. How to test it

Layers from cheapest to slowest. Run from `mcp/synthi-mcp/` unless noted.

### 2.1. Typecheck + build (no docker)

```bash
cd mcp/synthi-mcp
npm install
npm run typecheck
npm run build
```

### 2.2. Unit tests (no docker)

```bash
npm test
```

**185 tests passing** across: `wire.test.ts` (17), `hmr_normalize.test.ts` (24), `phash.test.ts` (12), `locate_cache.test.ts` (5), `locate_engine.test.ts` (5), `event_log.test.ts` (9), `protocol.test.ts` (9), `signaling_url.test.ts` (7), `housekeeping_tools.test.ts` (9), `screenshot.test.ts` (9), `wait.test.ts` (7), `mouse_keyboard.test.ts` (14), `operational_tools.test.ts` (12), `verify.test.ts` (12), `security.test.ts` (11), `resources.test.ts` (8), `correctness.test.ts` (15).

### 2.3. Signaling-server Rust tests (no docker)

```bash
cd backend/synthi-webrtc-compiler/signaling-server
cargo test
```

### 2.4. MCP Inspector (no Synthi stack needed)

```bash
npx @modelcontextprotocol/inspector node dist/index.js --session fake-session-id
```

Confirms the 21 tool schemas + 6 resource URIs are visible.

### 2.5. Spike harness (sim mode, no docker)

```bash
npm run spike:all > findings.json
```

Runs E1/E2/E2b/E3/E4 against synthetic frames + injected build-log events. Caveat: sim validates MCP-side mechanism correctness, not live worker behavior. See `mcp/synthi-mcp/tests/spike/README.md`.

### 2.6. Integration test against live stack (docker-compose)

```bash
docker-compose up -d redis postgres y-sweet collab-server signaling-server \
                     ai-engine ai-gateway worker frontend
# then:
cd mcp/synthi-mcp
SYNTHI_MCP_E2E=1 npm test
```

### 2.7. Real-agent smoke (Claude Code CLI + docker-compose)

```bash
./tests/e2e/claude_code_smoke.sh
```

### 2.8. Spike in live mode

```bash
# With docker-compose up and a counter_sdl2 fixture session created:
SPIKE_MODE=live npm run spike:all
```

E4 (`SYNTHI_MCP_E2E_FIXTURE=1` + `ANTHROPIC_API_KEY=…`) needs both the `claude_api` backend (phase-1 real impl, pending) and `synthi_get_usage` (shipped).

---

## 3. What's left — Phase 0.5 (live-mode runs)

The harness + fixtures are in the tree. Outstanding is **running them against a live stack** and filling the TBD cells in `PHASE_0_5_FINDINGS.md`:

- [ ] Live E1 at 60 fps on counter_sdl2.
- [ ] Live E1b at 30 fps + VFR (conditional on E1 marginal).
- [ ] Live E2 on counter.
- [ ] Live E2b on particle_demo (with tuned padding per sim finding).
- [ ] Live E3 on real Anthropic API (needs phase-1 `claude_api` impl).
- [ ] Live E4 30-min loop (needs phase-1 `claude_api` + shipping — E4 is live-only by design).

Ad-hoc measurements from `AGENT_MCP_ULTRAPLAN.md:1320-1329` also remain live-only (frame-age distribution, signaling-server two-browser-peer confirmation, `pipeline_budget_ms` components, input-queue depth, recal cadence, VFR frame intervals).

---

## 4. What's left — Phase 1 (remaining work)

All listed §4 items from the prior snapshot have landed except the live-stack-dependent deliverables that can only be validated against a running worker.

### 4.1. `claude_api` vision backend (real implementation) — ✅ shipped

- [x] `src/locate/claude_api.ts::ClaudeApiBackendReal` — real Anthropic multimodal call (injectable client for tests, lazy `import('@anthropic-ai/sdk')` in production).
- [x] Content-hash + description-hash keyed cache (60 s TTL).
- [x] Per-model pricing table (opus/sonnet/haiku 4.x + legacy fallbacks); emits `usage` event with `{input_tokens, output_tokens, cost_usd, model}` on every non-cache call.
- [x] `SYNTHI_VISION_MODEL` env (default `claude-opus-4-7`); `ANTHROPIC_API_KEY` required when backend is selected.
- [x] Confidence gate (default 0.3) + bbox clamping to frame rect.
- 26 new unit tests.

### 4.2. Worker per-peer PC registry — ⚠️ scaffolded; main.rs wiring staged

- [x] `worker/src/webrtc/peer_registry.rs` — `PeerRegistry` with browser eviction + observer fan-out + incremental handle population. 6 unit tests.
- [x] `worker/src/webrtc/track_fanout.rs` — broadcast-based RTP fan-out resolving GStreamer `max-buffers=1` HOL blocking (drop-on-lag via `RecvError::Lagged`). 5 unit tests.
- [x] `worker/src/webrtc/G3_PHASE_B_INTEGRATION.md` — step-by-step guide for remaining `main.rs` wiring with current-code file:line pointers.
- [ ] **Main.rs migration.** Replace `log_channel_store: Option<Arc<DC>>` + singular `pc` with the registry; per-peer PC creation on `offer`; per-peer track subscription in media pipelines. This is the high-risk step the scaffold commit deliberately staged away from.
- [ ] Integration test: 1 browser + 1 observer both receive media + HMR status + per-peer tagged input.

### 4.3. Source-state producer — ✅ shipped

- [x] `synthi_compile` auto-emits a `source_state` event with `{last_changed_files, content_hash}` on every dispatch.
- [x] `synthi_report_source_state` — explicit agent-side producer for edit-without-compile flows.
- [x] `synthi_get_source_state` returns real data (no more "not wired" placeholder); surfaces `content_hash` + `source_state_event_count`.

### 4.4. Frame-seq gate (MCP side) — ✅ shipped

- [x] `session.ts`: `setFrameAdvance` / `getFrameAdvance` / `awaitFrameAdvanceAtOrAfter` / `frameSeqGateEnabled` / `pipelineBudgetMs` (default 80 ms, env `SYNTHI_PIPELINE_BUDGET_MS`).
- [x] `wait/engine.ts`: `condition:"hmr"` resolving to `applied` now stalls on a post-reload frame-advance up to the remaining timeout; evidence reports `frame_gate:{status:"satisfied"|"timeout"|"disabled"}`.
- [x] `manifest.ts`: `capabilities.frame_seq_gate.pipeline_budget_ms` + runtime-driven `available` flag.
- [ ] **Worker emission** of `{type:"frame-advance", frame_seq, ts_ms}` alongside RTP writes. One-line add at the GStreamer sink; activates the gate as soon as it ships.
- [ ] `pipeline_budget_ms` calibration probe at worker start (10 samples, p95, fallback 80 ms). MCP honors the negotiated value today; worker needs to emit it during attach.

### 4.5. `synthi_compile` tool — ✅ shipped

- [x] `compile` DC now created in `Peer` (mirrors `compilerClient.js:905` ordering).
- [x] `SessionChannels.sendCompileRequest` + tool handler.
- [x] Input-gate gated, input-validated, auto-emits `input` + `source_state` events.

### 4.6. README refresh — ✅ shipped

- [x] `mcp/synthi-mcp/README.md` rewritten for the 23-tool / 6-resource / manifest surface. Per-client registration snippets (Claude Code + generic stdio JSON). Full env var table. Security section with the allowlist + injection pre-screen + keystroke anomaly detector + input-gate ladder. Known-limitations section with pointers to §4 of this doc.

### 4.7. Enriched tier + a11y

Stays deferred per ultraplan; `capabilities.enriched_tier.available=false` today.

---

## 5. What's left — Phase 2 (~3 weeks)

Unchanged from prior status doc:

- [ ] npm publish `@synthi/mcp-server`.
- [ ] Swing `javax.accessibility` enriched-tier adapter + fixture.
- [ ] `synthi-probe` cooperative library.
- [ ] Broker implementation (multi-agent fan-out).
- [ ] Worker-side input lease enforcement.
- [ ] Audio tee + `synthi_get_audio_level` / `synthi_wait_audio_event`.
- [ ] Operator observability UI.
- [ ] Quota enforcement (metrics-only in phase 1).
- [ ] Chaos testing suite (full).

---

## 6. What's left — Phase 3 (~2 weeks)

- [ ] `synthi_snapshot` / `synthi_restore`.
- [ ] Local vision backend (grounding-DINO, SAM+CLIP).
- [ ] Long-haul soak (1h random workload, 24h autonomous agent).
- [ ] Escape-hatch UI (`synthi_request_human`, `synthi_annotate_and_ask`).

---

## 7. What's left — Phase 4 (~1 week)

- [ ] `mcp-agent` role in signaling-server.
- [ ] Scoped agent-token issuance.
- [ ] Cross-region latency bench.
- [ ] TURN credentials for `mcp-agent`.

---

## 8. Known limitations (phase-1 live-stack dependent)

1. **`claude_api` vision is live.** Requires `ANTHROPIC_API_KEY`. Cost is metered via `usage` events + surfaced by `synthi_get_usage`.
2. **Observer media doesn't flow without worker main.rs wiring.** Registering as `observer` today = SDP/ICE fan-out works + scaffolded fan-out primitives exist, but `main.rs` still uses the singleton `pc`/`log_channel_store`. True co-attach awaits §4.2 main.rs migration.
3. **Frame-seq gate is live on the MCP side but dormant until worker emits `frame-advance`.** `capabilities.frame_seq_gate.available` reflects the real state at attach.
4. **Source-state producer is live** for MCP-driven compiles + explicit agent reports. Human-driven edits via the frontend aren't captured until the collab-server / worker hook ships (additive, §4.3 notes).
5. **`synthi_set_quality` and `synthi_reset_guest` are record-only** until worker control paths exist.
6. **OCR + VLM predicates unsupported.** `synthi_verify({kind:"ocr"})` → `ocr_backend_not_implemented`; `kind:"scene_matches"` → `verify_scene_matches_unsupported`. Both return `required_tool_call` fallbacks.
7. **No reconnect across process crash.** `synthi_reconnect` recovers transient socket drops; a hard worker/pod crash requires a fresh `synthi_attach`.
8. **Path A eviction.** MCP still registers as `browser` today. Observer is wire-only (awaits §4.2 main.rs migration).

---

## 9. Reference — commits landed this session

**This session's follow-up commits** (on top of the phase-1-complete snapshot):

```
883056f5 feat(agent-mcp): worker webrtc/ scaffold — PeerRegistry + TrackFanout
7c7c47ab docs(agent-mcp): README phase-1 refresh (23 tools, 6 resources, manifest)
a1885746 feat(agent-mcp): source-state producer — compile auto-emit + explicit report
32039aa7 feat(agent-mcp): frame-seq gate (MCP side) — post-HMR frame barrier
b4e9af86 feat(agent-mcp): synthi_compile — MCP-driven compile dispatch
bb429d1f feat(agent-mcp): real claude_api vision backend (Anthropic SDK)
```

**Prior phase-1 snapshot:**

```
3f6f1b6a feat(agent-mcp): signaling-server observer role + multi-peer fan-out
b8aeef3b feat(agent-mcp): correctness error table + deterministic priority ladder
0872af64 feat(agent-mcp): MCP resources (6 subscribable URIs) with rate-limited push
c63a826a feat(agent-mcp): security primitives — anomaly + injection heuristics
2f522a43 feat(agent-mcp): synthi_verify predicate engine (phase 1 deterministic)
9fadff75 feat(agent-mcp): operational tools (6) — usage/quality/checkpoint/ack/crash_info/reset
ed9efb32 feat(agent-mcp): synthi_mouse + synthi_keyboard (full surface)
5458061a feat(agent-mcp): synthi_wait generalizes to 8 conditions (hmr + 7 new)
10887eb4 feat(agent-mcp): synthi_screenshot gains region/max_dim/freshness_max_ms
6776ce75 feat(agent-mcp): housekeeping tools (detach/health/reconnect/get_event_log/get_source_state)
535f1919 feat(agent-mcp): protocol version + capability manifest + unsafe_signaling flag
439c868a feat(agent-mcp): event log ring buffer + SessionState enum (phase 1)
704eaedb docs(agent-mcp): PHASE_0_5_FINDINGS.md template + run-1 sim results
01e6cc1c feat(agent-mcp): phase 0.5 spike harness (E1/E2/E2b/E3/E4)
9e92af75 feat(agent-mcp): synthi_locate + region-pHash cache (phase 0.5 spike probe)
696863c1 feat(agent-mcp): phase 0.5 fixtures — library-agnostic counter + particle_demo
```
