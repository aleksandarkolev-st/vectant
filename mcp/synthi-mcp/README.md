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

**This is proprietary software distributed only to authorized users of Synthi.** Install through one of the two private channels below. The public `npm` registry is not a supported distribution path — `@synthi/mcp-server` on the public registry is not us. See `PHASE_2A_DISTRIBUTION.md` at the repo root for the full access-control posture.

All install paths assume a running Synthi stack you have access to (e.g., `docker-compose up -d` at the repo root, or a Synthi environment you've been granted access to). Requires Node ≥ 20 if using the npm channel; Docker ≥ 24 if using the image channel.

### Option 1 — GHCR container image *(recommended)*

```bash
# One-time: authenticate to GitHub Container Registry with a PAT scoped to read:packages.
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_USER" --password-stdin

# Pull a pinned release.
docker pull ghcr.io/synthi-inc/synthi-mcp:v0.1.0
```

The image entry-point is `node /app/dist/index.js`, so stdio MCP works with `docker run -i`. See `docs/CLIENT_CONFIGS.md` for the host-specific wiring.

### Option 2 — GitHub Packages npm *(for hosts without Docker)*

```bash
# Copy the template, then populate with a PAT scoped to read:packages.
cp mcp/synthi-mcp/.npmrc.example ./.npmrc
export GITHUB_TOKEN=ghp_...

npm install @synthi-inc/mcp-server
```

### Option 3 — Source build (collaborators cloning this repo)

```bash
cd mcp/synthi-mcp
npm install
npm run build
```

Use this while actively developing the MCP. End-user consumers should prefer options 1 or 2.

### Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `SYNTHI_SESSION_ID` | *(none)* | Session id if not passed via `--session`. |
| `SYNTHI_SIGNALING_URL` | `ws://localhost:9000` | Signaling WebSocket URL. |
| `SYNTHI_VISION_BACKEND` | `agent_side` | Default backend for `synthi_locate`. `agent_side` / `claude_api` / `gemini_api` / `mock`. See **Vision backend** below. |
| `SYNTHI_VISION_MODEL` | `claude-opus-4-7` | Model id used by the `claude_api` backend. |
| `SYNTHI_GEMINI_MODEL` | `gemini-2.5-flash` | Model id used by the `gemini_api` backend. |
| `ANTHROPIC_API_KEY` | *(unset)* | Required when any tool call selects the `claude_api` backend. |
| `GEMINI_API_KEY` | *(unset)* | Required when any tool call selects the `gemini_api` backend. Falls back to `GOOGLE_API_KEY` if set. |
| `SYNTHI_PIPELINE_BUDGET_MS` | `80` | Frame-seq gate shim applied after `wait({condition:"hmr"})` resolves `applied`. |
| `SYNTHI_PROMETHEUS_PORT` | *(unset)* | Opt-in — when set to a valid port (e.g. `9464`), the MCP exposes `/metrics` + `/healthz` on `127.0.0.1`. |
| `SYNTHI_PROMETHEUS_HOST` | `127.0.0.1` | Bind host for the metrics server. Override only when you intend a scraper on another host. |

CLI args override env; env overrides defaults.

### Register with your MCP client

**Preferred path (GHCR image):**

```bash
# Claude Code — pinned image tag keeps an agent from picking up a breaking change silently.
claude mcp add synthi -- \
  docker run -i --rm --network host \
  -e SYNTHI_SESSION_ID=<SESSION_ID> \
  -e SYNTHI_SIGNALING_URL=ws://localhost:9000 \
  ghcr.io/synthi-inc/synthi-mcp:v0.1.0
```

**Fallback (npm + local `node`, for hosts without Docker):**

```bash
claude mcp add synthi -- npx -y @synthi-inc/mcp-server --session <SESSION_ID>
```

**Source-build (collaborators developing the MCP):**

```bash
claude mcp add synthi -- node /abs/path/to/mcp/synthi-mcp/dist/index.js --session <SESSION_ID>
```

Full per-client config snippets (Codex, Cursor, Gemini CLI, Windsurf) live in `docs/CLIENT_CONFIGS.md`.

---

## Vision backend

`synthi_locate` grounds a natural-language description to a `{bbox, handle_id, region_phash}`. Four backends; pick per-session via `synthi_locate({preferred_vision_backend})` or globally via `SYNTHI_VISION_BACKEND=...`. The three server-side backends are **independent peers** — picking one does not invoke the others.

| Backend | Needs a key? | How it grounds | When to use |
|---------|--------------|----------------|-------------|
| `agent_side` *(default)* | No | Server returns the screenshot with `agent_side_vision_required`. **Your agent (Claude Code / Codex / etc.) uses its own model to decide the bbox** and re-calls `synthi_locate` with `hints.prefer_region` populated. The MCP then caches the handle. | Claude Code and other vision-capable MCP hosts. Zero API-key friction — same pattern as Figma/GitHub MCP servers (we return data, your agent's LLM reasons). |
| `claude_api` | `ANTHROPIC_API_KEY` | MCP calls Anthropic multimodal directly to ground the bbox. Results cached by `(frame_content_hash, description_hash)` for 60 s. Errors with `claude_api_*` prefixes. Default model `claude-opus-4-7`; override with `SYNTHI_VISION_MODEL`. | Non-vision-capable hosts; server-side cache across agent turns; single choke point for vision cost metrics. |
| `gemini_api` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | MCP calls Google Gemini via `@google/genai`. Same cache semantics as `claude_api`; errors with `gemini_api_*` prefixes. Default model `gemini-2.5-flash`; override with `SYNTHI_GEMINI_MODEL`. | Same motivation as `claude_api` but billed through a Google account. `gemini-2.5-flash` tails are materially cheaper for tight loops. |
| `mock` | No | Returns `hints.prefer_region` verbatim; throws if absent. No vision. | Phase-0.5 spike harness + unit tests only. |

**Why `agent_side` is the default.** Most MCP servers in the wild (Figma, GitHub, Linear, Playwright, Sequential-thinking, Memory) do one thing: call a specialized external service or run compute, and hand data back to the host's LLM. The host's LLM does the reasoning — and uses the user's existing subscription to do so. That's the "Claude subscription" path without any `sampling/createMessage` wiring (which Claude Code hasn't implemented today). `synthi_locate` with `agent_side` slots into the same pattern: server returns frame, agent grounds, agent re-calls with a region hint.

**Where `claude_api` / `gemini_api` earn their keep.** If your workflow:
- Runs a non-vision-capable host (some Codex configurations, CI robots).
- Wants the MCP's `(content_hash, description_hash)` cache to survive across agent turns (e.g., locate the same button 50 times without re-grounding).
- Wants a single choke point for `vision_inference_count` + `vision_cost_usd_estimate` in `synthi_get_usage`.

…then set `SYNTHI_VISION_BACKEND=claude_api` (or `gemini_api`) + supply the key. Switching vendors is one env var + nothing else; agents call the same tool.

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
