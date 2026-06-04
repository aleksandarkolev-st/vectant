## ⚠️ LOCAL DEV ONLY

This package has **no authentication**. Do not point it at a shared signaling server or a cloud Synthi instance — it is intended for a developer running Synthi + an AI agent side-by-side on the same machine.

An MCP that attaches to a Synthi session inherits that session's capabilities: it can type, click, drive the build, and see the running preview. Agents on untrusted signaling servers become an injection vector into your sessions. The server refuses non-local signaling URLs unless the caller passes `i-understand-no-auth:true` on `synthi_attach` — see **Security** below.

The browser workflow tools in this source package include a local CDP harness for collaborators. That harness is not the normal user path. The product path is:

```
agent client -> Synthi MCP -> broker -> Synthi-hosted browser/runtime -> screenshots/events/actions
```

Normal users should not need local Chrome, CDP ports, browser extensions, or access to their own PC to teach Synthi a workflow.

---

## What this is

MCP server that lets an AI coding agent (Claude Code, Codex, Cursor, anything that speaks MCP stdio) **observe** and **drive** a running Synthi preview over WebRTC. It also contains the browser workflow teaching surface: teach a browser workflow once inside the cloud IDE, then compile that demonstration into a workflow contract, Playwright replay, and eventually a private app-specific MCP tool.

The local `synthi_browser_*` CDP attachment path is a development harness for this hosted browser architecture. It keeps the broker, consent, trace, compiler, and replay logic testable without requiring the production hosted runtime to be available on every developer machine.

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

**This is proprietary software distributed only to authorized users of Synthi.** Install through one of the two private channels below. The public `npm` registry is not a supported distribution path — `@synthi/mcp-server` on the public registry is not us. See `PHASE_2A_DISTRIBUTION.txt` at the repo root for the full access-control posture.

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
| `SYNTHI_LEASE_MODE` | `advisory` | Input-lease enforcement level. `advisory`: phase-1 behaviour — multi-acquire allowed, mouse/keyboard log a security event on lease mismatch but still dispatch. `single-holder` (phase 2c): `synthi_acquire_input` rejects when a live lease exists (`lease_already_held`), mouse/keyboard reject when the caller's `lease_id` doesn't match (`input_lease_held_by_other`). Use `takeover: true` to force acquire. Manifest reports `arbitration.enforcement` accordingly. |
| `SYNTHI_QUOTA_MODE` | `off` | Quota gate on tool dispatch (phase 2d). `off`: metrics only. `warn`: log `quota_exceeded` security events but still dispatch. `enforce`: short-circuit with `quota_exceeded` when any limit is breached. |
| `SYNTHI_QUOTA_VISION_COST_USD_PER_HR` | `5.00` | Rolling-3600s cap on vision-inference cost across `claude_api` / `gemini_api` backends. Gates `synthi_locate` + `synthi_describe`. |
| `SYNTHI_QUOTA_TOOL_CALLS_PER_MIN` | `120` | Rolling-60s cap on total tool-call dispatches. Gates every tool. |
| `SYNTHI_QUOTA_SCREENSHOTS_PER_MIN` | `30` | Rolling-60s cap on `synthi_screenshot` calls. Gates only screenshots. |
| `SYNTHI_LOCAL_VISION_URL` | *(unset)* | **Phase 3.** HTTP endpoint for the `local` vision backend (body `{description, hints, frame:{png_base64, width, height}}` → `{bbox, confidence, trace?}`). When unset, `preferred_vision_backend:"local"` fails with `local_vision_backend_not_configured`. |
| `SYNTHI_SNAPSHOT_DIR` | *(unset)* | **Phase 3.** When set, `synthi_snapshot` writes JSON records to this directory (one file per snapshot) so they survive MCP subprocess restarts. Default behaviour is in-memory. |
| `SYNTHI_BROWSER_CDP_URL` | *(unset)* | Developer harness only. Existing Chrome/Chromium CDP endpoint for `synthi_browser_attach`. |
| `SYNTHI_BROWSER_EXECUTABLE` | *(auto-detect)* | Developer harness only. Browser executable used by `npm run live:browser` when no CDP URL is supplied. |
| `SYNTHI_BROWSER_BRIDGE_HOST` | `127.0.0.1` | Developer harness bridge bind host for page-origin teaching events. |
| `SYNTHI_BROWSER_BRIDGE_PORT` | `0` | Developer harness bridge port. `0` means ephemeral. |
| `SYNTHI_BROWSER_BRIDGE_PUBLIC_URL` | *(derived)* | Public URL returned to a local extension or bridge client when bind host/port are not directly reachable. |
| `SYNTHI_BROWSER_BRIDGE_TOKEN` | *(generated)* | Shared token required for page-origin bridge events. |

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

## Browser workflow teaching

Product wedge:

```
Teach Synthi a browser workflow once.
Synthi turns it into a reliable test, replay, or app-specific tool tied to the workspace codebase.
```

The broker is the authority for browser visibility and action. It grants exact-origin consent only; consent does not cross scheme, host, subdomain, or port. Screenshot/DOM capture and diagnostics are separate sub-grants, so a user can allow screenshots while denying console/network summaries, or the reverse.

Typical flow:

```ts
await synthi_browser_request_consent({
  url: "https://preview.example.com",
  screenshot: true,
  diagnostics: true
});
await synthi_browser_snapshot();
await synthi_browser_start_teach();
// Human demonstrates the workflow in the hosted preview.
await synthi_browser_stop_teach();
const { workflow } = await synthi_browser_compile_workflow();
```

The workflow compiler returns:

- a workflow card for the agent panel
- a v7 workflow contract with parameters, success criteria, auth durability, source coverage, mutation boundaries, replay modes, failure classes, counterfactual plan, and source affordance patch suggestions
- generated output availability, including Playwright and source-affordance patch notes

Replay modes:

- `sameSession` replays all supported steps in the current authorized browser session and can include mutations.
- `prefixOnly` stops before the first mutation boundary, suitable for read-only validation and background hardening.
- `coldSession` opens a fresh browser context and also stops before mutation boundaries.

Surface honesty:

- iframe steps without a durable `frameLocator` are blocked for replay.
- popup and multi-tab workflows are blocked by the current same-tab runner.
- closed Shadow DOM is blocked unless a dev bridge or external affordance exists.
- coordinate-only canvas and pointer-drag steps are marked limited and are not presented as hardened.
- cross-origin traces are limited unless each origin has explicit consent.

Local developer smoke:

```bash
cd mcp/synthi-mcp
npm run build
npm run live:browser -- --no-keep-browser
npm run live:browser:workspace -- --slug browser-mcp-live-manual
```

`npm run live:browser` uses the local CDP harness. It seeds a fixture, attaches through the broker, captures a real screenshot, records a teach trace, compiles a workflow contract, generates Playwright, and validates same-session, prefix-only, and cold-session replay. Use `npm run live:browser:install` if the Playwright Chromium cache is missing.

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

Every tool returns `structuredContent`; errors use `{error, ...detail}` with a deterministic priority ladder (see **Correctness** below). The preview tools below are the core WebRTC loop; the browser workflow tools are documented in **Browser workflow teaching**.

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

### Snapshot / restore (phase 3)

- `synthi_snapshot` — Capture the session's observable state (last `source_state`, current frame PNG, event-log seq, wire state). Returns `{snapshot_id, digest, event_log_seq_at_capture, …}`. Optional `label`, `frame_max_dim`, `omit_frame`. Guest process heap is NOT captured — that's CRIU territory; see ultraplan §Snapshot/restore.
- `synthi_restore` — Replay a snapshot: re-emit the captured `source_state` event, optionally drive a compile when the caller re-supplies the files (`recompile_source:true, compile:{language, source, files?}`). `include_frame:true` returns the captured PNG alongside the metadata.
- `synthi_list_snapshots` — Enumerate snapshots captured in this session. Frames omitted by default; `include_frame:true` inlines PNG blobs.

### Escape hatches (phase 3)

- `synthi_request_human` — Block until an operator answers via the queue. Timeouts, caller detail, `escape_hatch_canceled` on session close. Returns `{status:"answered", answer, operator_id?}`.
- `synthi_annotate_and_ask` — Screenshot-annotated variant: caller passes the screenshot (base64 PNG) plus the question; operator replies with `{x, y}` or free-form.
- `synthi_answer_escape_hatch` — Operator-side tool. `{pending_id, answer, operator_id?}` to resolve, `{pending_id, cancel:true, cancel_reason?}` to cancel. Paired with the `synthi://escape-hatch/queue` resource so operator UIs can poll + answer.
- `synthi_recent_human_actions` — Worker-attributed human input since `sinceSeq`. Populated by the phase-2 worker attribution hook.

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
| `synthi://snapshots/list` | `application/json` | **Phase 3.** Metadata for every captured snapshot; frames omitted (call `synthi_list_snapshots({include_frame:true})` for blobs). |
| `synthi://escape-hatch/queue` | `application/json` | **Phase 3.** Pending `request_human` / `annotate_and_ask` entries awaiting operator answer. |

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

## Operator UI

Phase-2 ships a Next.js operator console at `/workspace/<SESSION_ID>/operator` (inside the `synthi` frontend). It connects to the signaling server as a new `operator` role (monitor, not counted in presence, no media fan-out), renders the live `attached_humans` / `attached_agents` counts the server already broadcasts, and exposes a kill switch:

- **Kick `observer` peers** — drops the Synthi MCP (registers as `observer`). Use when an agent is running away.
- **Kick `mcp-agent` peers** — forward-compat for agents on the reserved `mcp-agent` role.
- **Kick the browser** — rarely what you want; included for completeness.

The server hard-disconnects the target: it sends a final `{type:"evicted", reason}` frame and closes the socket, so the MCP surfaces a clean transport error on its next call rather than a generic drop.

Worker and operator roles are non-kickable. Same-pod only today — cross-pod kicks (operator on pod A, MCP on pod B) require the Redis-relayed envelope, tracked in phase 2c follow-ups.

Event log / quota / lease snapshot are not in this first cut — they need a side-channel to the MCP process itself (not the signaling server).

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

Phase-3 live test (`npm run live:phase3`): self-contained harness that spawns the MCP, stands up a stub HTTP grounding server for `SYNTHI_LOCAL_VISION_URL`, round-trips an escape-hatch `request_human → answer` across two JSON-RPC clients on the same subprocess, and — when `SYNTHI_SESSION_ID` is set — drives the snapshot + restore round-trip against a real session. Runs in ~10–15 s.

Phase-3 soak loop (`npm run soak`): long-running `screenshot → locate → wait → snapshot` loop that records per-iteration NDJSON + aggregate p50/p95/p99 per tool. Env: `SOAK_DURATION_MIN`, `SOAK_ITERATION_MS`, `SOAK_SNAPSHOT_EVERY`, `SOAK_LOCATE_BBOX_HINT`. See `tests/soak/README.md`.

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
