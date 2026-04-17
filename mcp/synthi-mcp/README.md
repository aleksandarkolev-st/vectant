## ⚠️ LOCAL DEV ONLY

This package has **no authentication**. Do not point it at a shared signaling server or a cloud Synthi instance — it is intended for a developer running Synthi + an AI agent side-by-side on the same machine.

An MCP that attaches to a Synthi session inherits that session's capabilities: it can type, click, drive the build, and see the running preview. Agents on untrusted signaling servers become an injection vector into your sessions. The server refuses non-local signaling URLs unless the caller passes `i-understand-no-auth:true` on `synthi_attach` — see **Security** below.

---

## What this is

MCP server that lets an AI coding agent (Claude Code, Codex, Cursor, anything that speaks MCP stdio) **observe** and **drive** a running Synthi preview over WebRTC. Phase 1 ships **23 tools + 6 subscribable resources + a capability manifest**; phase 2+ extends with enriched-tier accessibility introspection, lease-based input arbitration, broker multiplexing, and snapshot/restore — see `AGENT_MCP_ULTRAPLAN.md` at the repo root.

Expected loop:

```
agent.edit("src/App.jsx", ...)          // agent's own file-edit tool
await synthi_report_source_state({...}) // optional, marks the checkpoint
await synthi_compile({...})             // agent-driven compile trigger
await synthi_wait({condition:"hmr"})    // resolves on terminal HMR status
img = await synthi_screenshot({...})    // see the result
```

---

## Install

Requires Node ≥ 20 and a running Synthi stack (e.g., `docker-compose up -d` at the repo root).

```bash
cd mcp/synthi-mcp
npm install
npm run build
```

### Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `SYNTHI_SESSION_ID` | *(none)* | Session id if not passed via `--session`. |
| `SYNTHI_SIGNALING_URL` | `ws://localhost:9000` | Signaling WebSocket URL. |
| `SYNTHI_VISION_BACKEND` | `mock` | Default backend for `synthi_locate`. `mock` / `agent_side` / `claude_api`. |
| `SYNTHI_VISION_MODEL` | `claude-opus-4-7` | Model id used by the `claude_api` backend. |
| `ANTHROPIC_API_KEY` | *(unset)* | Required when any tool call selects the `claude_api` backend. |
| `SYNTHI_PIPELINE_BUDGET_MS` | `80` | Frame-seq gate shim applied after `wait({condition:"hmr"})` resolves `applied`. |

CLI args override env; env overrides defaults.

### Register with your MCP client

#### Claude Code

```bash
claude mcp add synthi -- node /abs/path/to/mcp/synthi-mcp/dist/index.js --session <SESSION_ID>
```

#### Codex / Cursor / other MCP stdio clients

Add an entry to the client's MCP config:

```json
{
  "mcpServers": {
    "synthi": {
      "command": "node",
      "args": ["/abs/path/to/mcp/synthi-mcp/dist/index.js", "--session", "<SESSION_ID>"],
      "env": {
        "SYNTHI_SIGNALING_URL": "ws://localhost:9000",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Swap `--session` for `SYNTHI_SESSION_ID` in `env` if the client prefers env-only config.

---

## Tools

23 tools advertised. Every tool returns `structuredContent`; errors use `{error, ...detail}` with a deterministic priority ladder (see **Correctness** below).

### Lifecycle

- `synthi_attach` — Connect as WebRTC peer (role=`browser`). Returns `{protocol, capabilities, session}` envelope. Required before any other tool.
- `synthi_detach` — Close and release. Idempotent.
- `synthi_reconnect` — Re-negotiate against the current sessionId after a transient socket drop.
- `synthi_health` — mcp_state / wire_state / connectionState / DC readyStates / frames / unsafe_mode.

### Observation

- `synthi_screenshot` — Latest frame as PNG. Optional `{region, max_dim, freshness_max_ms}`. Returns `frame_stale` if the frame age exceeds the SLA.
- `synthi_wait` — Block on one of eight conditions: `hmr`, `log`, `source_state`, `pixel`, `motion_settled`, `scene_change`, `element`, `text` (last is an unsupported stub with a `required_tool_call` fallback).
- `synthi_wait_hmr` — Back-compat alias over `wait({condition:"hmr"})`. Defaults to 60 s for Tier 3 AI-split tolerance.

### Build control

- `synthi_compile` — Dispatch a CompileRequest on the worker's `compile` DC. Fire-and-forget. Auto-emits a `source_state` event for the inputs. Follow up with `synthi_wait({condition:"hmr"})`.

### Input

- `synthi_mouse` — `click / double_click / move / down / up / drag / wheel`. Coordinates from explicit `{x,y}` or a `handle` from `synthi_locate`. Optional `waitFor` runs a `synthi_wait` before the action.
- `synthi_keyboard` — `type / key / chord`. Optional `confirm:{pattern, timeoutMs}` waits for a log match after the action.
- `synthi_click` / `synthi_type` — Back-compat aliases.

### Semantic addressing

- `synthi_locate` — Natural-language → `{bbox, handle_id, region_phash}`. Backends: `mock` (for tests / spike), `agent_side` (agent does the vision), `claude_api` (Anthropic multimodal; requires `ANTHROPIC_API_KEY`). Region-pHash cache keyed on `(frame_content, description)` with TTL 30 s and drift threshold 12.

### Verification

- `synthi_verify` — Predicate engine over `pixel / log / element_visible / and / or`. `ocr` and `scene_matches` return `*_not_implemented` with a `required_tool_call` fallback.

### Event log / telemetry / source state

- `synthi_get_event_log` — Bounded query: `since_seq`, `since_ts`, `kind`, `limit`. Nine kinds: `lifecycle | hmr | input | locator_resolution | console | error | security | source_state | usage`.
- `synthi_get_source_state` — Latest source-state snapshot.
- `synthi_report_source_state` — Agent-side producer: declare edited files when NOT also driving the compile.
- `synthi_get_usage` — Aggregated counters + `vision_cost_usd_estimate` + `hot_seconds` since attach.

### Operational

- `synthi_set_quality` — Record-only today; worker-side negotiation in phase 2.
- `synthi_checkpoint` — Named marker in the event log.
- `synthi_acknowledge_disruption` — Clear `ackRequired` after `crash-recovered` / `full-reload-required`.
- `synthi_get_crash_info` — Latest crash metadata.
- `synthi_reset_guest` — Record-only; worker-side restart in phase 2.

---

## Resources (subscribable URIs)

6 resource streams, exposed via the MCP resources protocol. Subscribe via `notifications/resources/subscribe`; the server pushes `notifications/resources/updated` when events land (screenshot push throttled to 2 Hz).

| URI | Mime | Payload |
|-----|------|---------|
| `synthi://preview/screenshot` | `image/png` | Latest frame. |
| `synthi://preview/hmr` | `application/json` | Latest HMR terminal event. |
| `synthi://preview/console` | `application/json` | Recent console events from build-log. |
| `synthi://preview/events` | `application/json` | Recent event-log entries (all kinds). |
| `synthi://preview/state` | `application/json` | Session snapshot (state, unsafe_mode, attached counts). |
| `synthi://preview/source` | `application/json` | Latest source-state summary. |

---

## Protocol + manifest

`synthi_attach` returns:

```json
{
  "protocol": { "version": 1, "server_supports": [1] },
  "capabilities": {
    "tools": [ ... 23 names ... ],
    "vision_backends": ["mock", "agent_side", "claude_api"],
    "wait_conditions": ["hmr", "log", "source_state", "pixel",
                        "motion_settled", "scene_change", "element"],
    "verify_predicates": ["pixel", "log", "element_visible", "and", "or"],
    "enriched_tier": { "available": false, "reason": "phase_2_plus_only" },
    "frame_seq_gate": { "available": false, "reason": "no_frame_advance_seen_yet",
                        "pipeline_budget_ms": 80 },
    "region_phash_cache": { "available": true, "ttl_ms": 30000, "drift_threshold": 12 },
    "security": { "unsafe_signaling_flag_supported": true,
                  "injection_heuristic_prescreen": true,
                  "keystroke_rate_cap_per_sec": 500, ... },
    "arbitration": { "input_lease_supported": false, "enforcement": "none" },
    "limits": { "event_log_capacity": 1024, "max_screenshot_dim": 3840 }
  },
  "session": { "id": "...", "state": "running", "state_ts": 1700000000000,
               "unsafe_mode": false, "attached_humans": 0, "attached_agents": 1 }
}
```

An agent can branch on capability availability (`capabilities.frame_seq_gate.available`, etc.) rather than probing tool-by-tool. Unknown enum values from the worker never crash — they pass through as the literal string `"unknown"`.

---

## Security

- **Signaling URL allowlist.** Non-local URLs (anything outside loopback / RFC1918 / link-local) require `"i-understand-no-auth": true` on `synthi_attach`. Flagged sessions set `unsafe_mode:true` in the manifest and log a `security:unsafe_attach` event.
- **Injection pre-screen.** Seven canonical prompt-injection patterns scanned over `build-log` free-text fields (`message` / `reason` / `stdout` / `stderr`); matches emit `security:injection_suspected` events.
- **Keystroke anomaly detector.** Burst detection (hard cap 500/s, warn at 400/s) + monotone-repeats (>64 identical keys in a row); violations log `security:rate_limit_warning`.
- **Input gate.** Mouse / keyboard / compile all run the same server-side correctness check: refuses on `session_not_ready`, `session_migrating`, `session_terminated`, or a pending disruption that requires `synthi_acknowledge_disruption`. 17 deterministic error codes with a priority ladder — clients always know which error to resolve first.

---

## Testing

```bash
npm run typecheck    # tsc --noEmit
npm run build        # tsc → dist/
npm test             # vitest run — 245 unit tests (phase-1 complete)
npm run dev          # tsx src/index.ts for iteration
```

Integration test (requires live stack):

```bash
# From repo root:
docker-compose up -d redis postgres y-sweet collab-server signaling-server \
                     ai-engine ai-gateway worker frontend
# Then:
cd mcp/synthi-mcp
SYNTHI_MCP_E2E=1 npm test
```

Real-agent smoke (requires Claude Code CLI + live stack):

```bash
./tests/e2e/claude_code_smoke.sh
```

MCP Inspector (no Synthi stack needed, confirms schemas):

```bash
npx @modelcontextprotocol/inspector node dist/index.js --session fake-session-id
```

Phase-0.5 spike harness (`npm run spike:all`): 5 experiments (frame-seq, locator-cache, region-pHash, p99 load, cost budget) runnable in `sim` or `live` mode. See `tests/spike/README.md`.

---

## Known limitations

Pointer: `AGENT_MCP_STATUS.md` §4 has the authoritative open-items list. Highlights:

- **Observer media requires worker per-peer PC.** MCP still attaches as `role:"browser"` and evicts any existing human browser. Signaling-side observer role is live; the worker-side companion (per-peer `RTCPeerConnection` + RTP fan-out) is the phase 2+ G3 ticket.
- **Frame-seq gate awaits worker emission.** Shim is ready on the MCP side; the gate activates as soon as the worker emits `{type:"frame-advance", frame_seq, ts_ms}` messages on `build-log`.
- **OCR / VLM verify predicates unsupported.** `synthi_verify({kind:"ocr"})` returns `ocr_backend_not_implemented`; `kind:"scene_matches"` returns `verify_scene_matches_unsupported`. Both carry `required_tool_call` fallbacks.
- **No reconnect across process crash.** `synthi_reconnect` recovers transient socket drops; a hard worker/pod crash requires a fresh `synthi_attach`.
- **Single attach per process.** One MCP subprocess drives one session.
- **`synthi_set_quality` / `synthi_reset_guest` are record-only.** Worker control paths land in phase 2.

For the full scope (phases 2–4), see `AGENT_MCP_ULTRAPLAN.md`.

---

## Development layout

```
mcp/synthi-mcp/
├── src/
│   ├── index.ts              # stdio entry
│   ├── server.ts             # tool + resource registration, dispatch
│   ├── tool_registry.ts      # single source of truth for advertised tool names
│   ├── signaling.ts          # WebSocket signaling client
│   ├── peer.ts               # RTCPeerConnection + DC lifecycle
│   ├── frames.ts             # video sink → PNG
│   ├── channels.ts           # terminal / build-log / compile DC facade
│   ├── hmr.ts                # four-wire-family normalizer
│   ├── session.ts            # singleton session state + frame-advance gate
│   ├── protocol/             # version negotiation + capability manifest
│   ├── events/               # ring buffer + discriminated-union event types
│   ├── correctness/          # error table + priority ladder + input gate
│   ├── security/             # signaling-URL classifier, injection heuristics, anomaly detector
│   ├── locate/               # handle + region-pHash cache + vision backends
│   ├── wait/                 # 8-condition resolver engine
│   ├── verify/               # predicate evaluator
│   ├── resources/            # 6-URI registry + read + fan-out
│   ├── tools/                # 23 tool handlers
│   ├── util/                 # pHash + helpers
│   └── wire/                 # input encoder (gui-event envelope)
└── tests/
    ├── unit/                 # 245 tests
    ├── integration/          # docker-compose E2E
    ├── e2e/                  # Claude-Code smoke
    ├── fixtures/             # library-agnostic counter + particle_demo
    └── spike/                # E1/E2/E2b/E3/E4 phase-0.5 harness
```
