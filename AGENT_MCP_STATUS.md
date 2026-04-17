# Synthi MCP — Status

**Status:** phase 0.5 instrumentation + phase 1 code complete (in-process; no live-stack validation yet). Branch `claude/agent-mcp` @ `3f6f1b6a`. 185 unit tests green, typecheck green.

**Source of truth for scope:** `AGENT_MCP_ULTRAPLAN.md` (design, approved). **Source of truth for MVP gate:** `AGENT_MCP_MVP.md` (Path A shipped). **Phase 0.5 findings:** `PHASE_0_5_FINDINGS.md` (template + sim run 1). This doc is the merge view.

---

## 1. What's shipped

`mcp/synthi-mcp/` — Node 20+ TypeScript. ~35 source files + 17 unit-test files + 2 fixtures + 5-experiment spike harness. MCP registers as `role:"browser"` and evicts any existing human browser peer on the same session (Path A).

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

### Tools (21 advertised)

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
| `synthi_locate` | Handle + region-pHash cache + backend selection. `locator_resolution` events on every dispatch. |
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
- [ ] **Worker per-peer PC registry.** Required for observer to actually receive media. Stays `PHASE_2_PLUS_BACKLOG.md:G3` (+4-6 days).

### HMR wire coverage (`src/hmr.ts`)

Unchanged from MVP — the four-wire-family classifier remains the truth table. See prior entry in this doc for detail.

### Tests

- **Unit (Node):** 185 passing across 17 files.
- **Integration (Node, `SYNTHI_MCP_E2E=1`):** docker-compose scaffold, 3 tests; unchanged since MVP.
- **Spike harness (Node):** 5 experiments, sim mode end-to-end; live mode stubbed.
- **Unit (Rust, signaling-server):** 4 passing (role classification, target routing, target_key roundtrip).
- **Real-agent smoke:** `tests/e2e/claude_code_smoke.sh` (requires docker-compose + Claude Code CLI).

### Docs

- [x] `mcp/synthi-mcp/README.md` — install + tool surface (phase-0.5 shape; **needs phase-1 refresh**).
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

Most phase-1 code is in the tree; what's left is either live-stack dependent or explicitly deferred to phase 2+.

### 4.1. `claude_api` vision backend (real implementation)

- [ ] Replace `src/locate/backends.ts::ClaudeApiBackend` stub with Anthropic SDK call. Caching by `(frame_seq, description_hash)`.
- [ ] Emit `usage` event (metric:"vision_inference") with `cost_usd` in detail so `synthi_get_usage` surfaces real numbers.
- [ ] Threading through `ANTHROPIC_API_KEY` and `SYNTHI_VISION_MODEL=claude-opus-4-7`.
- [ ] Unblocks: E3 live, E4 live, all real vision-grounded agent flows.

### 4.2. Worker per-peer PC registry

From `PHASE_2_PLUS_BACKLOG.md:G3` — the worker-side companion to the signaling observer role:

- [ ] `worker/src/webrtc/peer_registry.rs` — `HashMap<peer_id, PeerHandle>`.
- [ ] `worker/src/webrtc/track_fanout.rs` — subscribe once to GStreamer appsink; fan to every registered `TrackLocalStaticRTP`.
- [ ] `worker/src/main.rs` per-peer offer handling + teardown + DC routing (`log_channel_store` → `HashMap<peer_id, Arc<DC>>`).
- [ ] Integration test: 1 browser + 1 observer both receive media.
- [ ] Unblocks: true human+agent co-attach (Path B).

### 4.3. Source-state producer

- [ ] Wire a source-state event emitter — either from collab-server (file-write REST → signaling broadcast → MCP) or from the worker's compile trigger (source_hash changed → build-log message). Currently `synthi_get_source_state` returns a note:"producer not wired" placeholder.

### 4.4. Frame-seq gate (conditional on live E1)

If live E1 → commit:

- [ ] `{type:"frame-advance", frame_seq, ts_ms}` worker emission alongside RTP writes.
- [ ] `synthi_wait({condition:"hmr"})` gates on `ts_cap ≥ t_hmr + pipeline_budget_ms` for applied/state-migrated.
- [ ] `pipeline_budget_ms` calibration at worker start (HMR overlay synthetic probe, 10 samples, p95, fallback 80 ms).

### 4.5. Compound "drive the compile" tool (optional)

- [ ] `synthi_compile` — MCP opens the `compile` DC and dispatches a compile request. Today the frontend drives compile; adding this to the MCP closes the "edit → HMR → screenshot" loop end-to-end without needing a frontend open. Unblocks live-mode spike harness without Puppeteer.

### 4.6. README refresh

- [ ] `mcp/synthi-mcp/README.md` still describes the 5-tool MVP surface. Rewrite to cover the 21 advertised tools + 6 resources + manifest shape + per-client (Claude Code / Codex / Cursor) config snippets.

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

1. **`claude_api` vision is a stub.** `preferred_vision_backend:"claude_api"` returns `claude_api_not_implemented` until real impl lands (§4.1).
2. **Observer media doesn't flow without worker multi-PC.** Registering as `observer` today = SDP/ICE fan-out works, but video/data only routes to the most-recent PC. True co-attach is phase 2+ (§4.2).
3. **`synthi_get_source_state` returns a placeholder** until the producer is wired (§4.3).
4. **`synthi_set_quality` and `synthi_reset_guest` are record-only** until worker control paths exist.
5. **OCR + VLM predicates unsupported.** `synthi_verify({kind:"ocr"})` → `ocr_backend_not_implemented`; `kind:"scene_matches"` → `verify_scene_matches_unsupported`. Both return `required_tool_call` fallbacks.
6. **No reconnect across process crash.** `synthi_reconnect` recovers transient socket drops; a hard worker/pod crash requires a fresh `synthi_attach`.
7. **Path A eviction.** MCP still registers as `browser` today. Observer is wire-only (awaits §4.2).

---

## 9. Reference — commits landed this session

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
