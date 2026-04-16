# AGENT MCP ULTRAPLAN — v2

**Status:** v2 drafted, supersedes v1. Awaiting approval to execute phase 1.
**Author:** Claude Opus 4.7 (1M context)
**Date:** 2026-04-16
**Branch:** `claude/agent-mcp`

**Reading order:**
1. `VISION.md` — what this system is and why (north star)
2. This doc — how we build it (architecture + phases + testing)
3. `AGENT_MCP_FEEDBACK_NOTES.md` — why choices look like this (derivation & history)

v1 of this plan was critiqued in two waves. The technical consequences are captured in the notes; this doc is the revised plan in its own right, not a diff against v1. If you've read VISION.md you can read this top-to-bottom.

---

## TL;DR

Build `@synthi/mcp-server` — a Node/TypeScript MCP package that attaches to a Synthi session, primarily as a **headless browser peer** (MVP), evolving into a **broker-backed fan-out** for multi-agent sessions (phase 2+).

Primary tool surface is **Playwright-style**: compound verbs with built-in auto-waiting, retries, and lazy locators. Coordinate-level pokes exist as escape hatches, not defaults.

**Server enforces correctness** for every case where "trust the agent to do it right" would otherwise appear — HMR-window input queuing, frame-freshness SLAs, focus lock, quota backoff.

Ships **day one**: tiered capability model, protocol versioning, session lifecycle states, cost observability, guest-to-agent security (focus lock + sandbox + sensitive-action interstitial), structured error taxonomy.

**Universal** across clients: Claude Code, Codex, Cursor, Gemini CLI, Windsurf — all consume the same stdio MCP surface.

---

## Non-goals (this revision)

- Record/replay with full determinism (event log yes; deterministic replay no).
- Remote multi-tenant auth (phase 4, still deferred).
- A universal remote desktop. The abstraction is automation, not VNC.

---

## Architecture

### MVP topology (phase 1)

```
┌───────────────────────────────┐   MCP stdio (SSE/HTTP alt)
│ Agent                         │ ─────────────────────────┐
│  Claude Code │ Codex │ Cursor │                          │
│  Gemini CLI  │ Windsurf │ …   │                          │
└───────────────────────────────┘                          ▼
                                        ┌───────────────────────────────────┐
                                        │ synthi-mcp (Node/TS, NEW)         │
                                        │  @modelcontextprotocol/sdk        │
                                        │  ws → signaling-server            │
                                        │  @roamhq/wrtc | werift (fallback) │
                                        │  Tool registry:                   │
                                        │   - Core 10 (universal)           │
                                        │   - Operational 6                 │
                                        │   - Escape 3                      │
                                        │   - Enriched (cap-advertised)     │
                                        │  Server-side vision (Claude API)  │
                                        │  Event log ring buffer            │
                                        │  Protocol-version negotiation     │
                                        └───────────────┬───────────────────┘
                                                        │ ws:9000 + WebRTC
                                                        ▼
                                        ┌───────────────────────────────────┐
                                        │ signaling-server (Rust)           │
                                        │  + protocol-version handshake     │
                                        └───────────────┬───────────────────┘
                                                        │
                                                        ▼
                                        ┌───────────────────────────────────┐
                                        │ worker (Rust)                     │
                                        │  + input dispatch ack             │
                                        │  + focus lock                     │
                                        │  + guest seccomp sandbox          │
                                        │  + sensitive-action interstitial  │
                                        │  + HMR frame-seq tagging          │
                                        │  + per-session usage counters     │
                                        └───────────────────────────────────┘
```

### Target topology (phase 2+, broker fan-out)

```
agent ─┐                       ┌── RTCPeerConnection ── signaling ── worker
agent ─┤── synthi-broker ──────┤
agent ─┤   (shared peer,       ├── vision cache
agent ─┘    decoded once,      ├── event log
            fanned N clients)  └── input arbiter (lease-based)
```

Wire protocol in phase 1 already carries frame-seq, dispatch-id, and session-state in every tool response so the broker retrofit doesn't require a protocol break.

---

## Tiered capability model

All three tiers are first-class. Agents learn which tiers are live for a given session from the **capability manifest** returned by `synthi_attach`.

| Tier           | Availability                              | Contents                                                                                                         |
|----------------|-------------------------------------------|------------------------------------------------------------------------------------------------------------------|
| **Universal**  | Always (SDL2/C++/games included)          | Pixels, input injection, perceptual sync primitives, server-side visual locator, VLM scene narration, event log |
| **Enriched**   | When runtime cooperates (detected)        | Swing `javax.accessibility`, Android `uiautomator`, web DevTools, process/audio/metrics hooks                    |
| **Cooperative** | When guest links `synthi-probe` (opt-in) | User-registered labeled rects, custom scene markers, explicit ready signals                                      |

---

## Tool surface

**Every tool response carries this envelope** (invariant; simplifies agent error handling):

```ts
{
  ok: boolean,
  data: ToolSpecificData,
  session: {
    state: "warming" | "ready" | "running" | "hibernated" | "crashed" | "terminated",
    state_ts: number,
    frame_age_ms: number,
    hmr_status: "applied" | "compiling" | "...",
    protocol_version: string,
  },
  usage: { tool_calls_this_hour: number, egress_bytes_this_hour: number, vision_calls_this_hour: number },
  dispatch_id: string,   // for input tools, returned by worker after actual execution
  frame_seq: number,     // monotonic frame counter; enables freshness gating
  request_id: string,
  error?: { code: StructuredErrorCode, retry_after_ms?: number, detail?: string }
}
```

### Core universal tools (10)

| Tool                  | Shape                                                                                              | Notes                                                                                                 |
|-----------------------|----------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| `synthi_attach`       | `{sessionId?, signalingUrl?, clientVersion, supportedProtocols: number[]}` → capability manifest   | Negotiates protocol version. Warms hibernated worker or returns structured error.                     |
| `synthi_detach`       | `{}` → `{ok}`                                                                                       | Graceful: closes DC, PC, WS.                                                                          |
| `synthi_health`       | `{}` → `{frame_age_ms, dc_rtt_ms, last_hmr_age_ms, decoder_state, process_state, quota_headroom}` | The backoff-signal tool.                                                                              |
| `synthi_get_event_log`| `{sinceTs?, sinceSeq?, types?}` → `{events: Event[]}`                                               | Ring buffer of HMR transitions, console lines, input dispatches, lifecycle events.                    |
| `synthi_mouse`        | `{action: "click"\|"double"\|"move"\|"scroll"\|"drag", x, y, x2?, y2?, button?, delta?, waitFor?: "stable"\|"change"\|"pixel_at"\|"element", waitTimeoutMs?, retry?}` | Compound. Auto-waits per `waitFor`. Returns `dispatch_id` from worker ack.                            |
| `synthi_keyboard`     | `{action: "type"\|"key"\|"chord", text?, key?, chord?, confirm?: boolean, retry?}`                  | `confirm: true` required for strings matching sensitive-action heuristics.                            |
| `synthi_screenshot`   | `{format?: "png"\|"webp", region?, max_dim?, freshness_max_ms?}`                                    | PNG default. Rejects with `frame_stale` if freshness SLA violated.                                    |
| `synthi_wait`         | `{condition: "hmr"\|"motion_settled"\|"pixel"\|"scene_change"\|"text"\|"log"\|"element", …, timeoutMs?: 30000}` | Unified wait. `hmr` resolves only after sink frame-seq ≥ `applied` frame-seq (see §Correctness).      |
| `synthi_locate`       | `{description, hints?, top_k?}` → `{handles: LocatorHandle[]}`                                      | Returns **handles** that re-resolve at action time, not frozen bboxes. Cache shared per frame.        |
| `synthi_describe`     | `{}` → `{summary: string, entities: StructuredEntity[], frame_seq}`                                 | VLM scene narration. Cached per frame. One call per frame budget.                                     |

`LocatorHandle` shape: `{id: string, description: string, resolve_policy: "at_action" | "pinned", expires_ts}`. Actions (`synthi_mouse.click`, etc.) accept `handle` instead of `x,y` and the server resolves on dispatch.

### Operational tools (6) — ship with phase 1

| Tool                              | Purpose                                                                     |
|-----------------------------------|-----------------------------------------------------------------------------|
| `synthi_get_usage`                | Per-session counters: tool calls, vision inferences, egress, hot-time.      |
| `synthi_set_quality`              | `{target_fps?, target_bitrate?, target_resolution?}` — bandwidth knobs.     |
| `synthi_set_goal`                 | Intent declaration for observability + caching.                             |
| `synthi_checkpoint`               | Named checkpoint marker in event log.                                       |
| `synthi_acknowledge_disruption`   | Required after `crash-recovered`/`full-reload-required` before input accepted. |
| `synthi_get_crash_info`           | `{crashed_at_ts, signal, last_hmr_state, ...}`                              |

### Input arbitration (phase 1 wire, phase 2 enforcement)

| Tool                    | Purpose                                                                |
|-------------------------|------------------------------------------------------------------------|
| `synthi_acquire_input`  | `{lease_ms}` — wire shape shipped phase 1; worker enforcement phase 2. |
| `synthi_release_input`  | `{}`                                                                    |

### Escape hatches (3) — phase 1 wire, phase 3 UI

| Tool                        | Purpose                                                                    |
|-----------------------------|----------------------------------------------------------------------------|
| `synthi_request_human`      | Post question + screenshot to host UI; block until response.               |
| `synthi_annotate_and_ask`   | Host UI overlays screenshot; human clicks; coords returned.                |
| `synthi_recent_human_actions` | Read-only log of human inputs (learn from demonstration).                |

### Enriched (runtime-advertised in manifest)

- `synthi_query` / `synthi_act` — structured querying (a11y/uiautomator/DevTools)
- `synthi_get_audio_level` / `synthi_wait_audio_event` — GStreamer audio tee
- `synthi_get_process_state` / `synthi_get_metrics` — CPU/GPU/memory
- `synthi_get_labels` — cooperative, reads `synthi-probe` labels
- `synthi_fill_form` / `synthi_click_text` — compound idioms

### Snapshot/restore (phase 3)

- `synthi_snapshot` → token (git commit + guest process snapshot — 80% solution)
- `synthi_restore(token)`

### MCP resources (subscribable)

- `synthi://preview/screenshot` — latest frame (auto-updating)
- `synthi://preview/hmr` — current HMR status (push, not poll)
- `synthi://preview/console` — tail log
- `synthi://preview/events` — subscribable event log
- `synthi://preview/state` — lifecycle state

---

## Server-enforced correctness (replaces "document the pattern")

Every case below has a defined server response. Agents handle structured errors; they do not need to remember rules.

| Condition                                    | Server behavior                                                                                         |
|----------------------------------------------|---------------------------------------------------------------------------------------------------------|
| Input during `compiling` HMR                 | Queue and apply after `applied`, OR return `{error:"input_rejected_hmr_pending", retry_after_ms}`.      |
| Screenshot when frame age > SLA              | Return `{error:"frame_stale", last_fresh_ts, stale_ms}`. Never stale bytes silently.                    |
| Click outside viewport                       | `{error:"click_out_of_bounds", viewport:{w,h}}`. Never silent xdotool no-op.                            |
| Keys with no focused window                  | Reject with `{error:"no_focus_target"}`. (Decision: never implicitly refocus.)                          |
| Input during `crash-recovered`               | Reject until `synthi_acknowledge_disruption()` called. Event published on recovery.                     |
| Input while session `warming`                | Queue briefly (500ms); then reject with `{error:"session_not_ready", state:"warming"}`.                 |
| `wait_hmr` when applied→paint→encode pending | Resolve only after sink frame-seq ≥ frame-seq at `applied` event. Never return on bare status alone.    |
| Quota exceeded                               | `{error:"quota_exceeded", quota:"screenshots_per_min", retry_after_ms}`. Never silent.                  |
| Protocol version mismatch                    | `{error:"unsupported_protocol", server_supports:[1,2,...]}`. Fail attach loudly.                        |
| Sensitive-action input without `confirm:true`| `{error:"confirmation_required", matched_patterns:["shell_metachars","rm"]}`.                           |

This is **non-negotiable**. Every case becomes a test in the integration suite (§Testing).

---

## Security — Day One

Phase-4 auth protects *agent → signaling*. This section covers the more dangerous vector: **guest → agent** (prompt injection via rendered content).

### Focus lock (phase 1, worker)

- Input injection routes **only** to the guest program's primary window.
- If focus drifts (guest spawns child window, user opens external app on Xvfb), input is gated. Server emits `focus_lost` event; agent must re-attach intent.
- Implementation: worker tracks the guest's Xvfb window ID from program start; xdotool `--window <id>` for every injection; refuse injection if active focus ≠ guest window ID.

### Guest sandboxing (phase 1, worker)

- Tight seccomp profile on guest process: no `execve` of shells, no raw network sockets, no `ptrace`, no `mount`.
- Mount namespace: guest sees project dir + standard runtime libs; no `/home`, `/etc/secret`, `/var/run/docker.sock`.
- cgroups: CPU share cap, memory cap, no `/sys/fs/cgroup` write.
- If attacker achieves guest code exec, their reach is constrained to project dir and synthetic `/tmp`.

### Sensitive-action interstitial (phase 1, MCP + worker)

- `synthi_keyboard.type` with text matching heuristics (`;`, `|`, `&`, `$(`, backticks, `sudo`, `rm -rf`, `curl \| sh`, URL patterns) → requires `confirm:true`.
- Without `confirm:true`: `{error:"confirmation_required", matched_patterns}`.
- With `confirm:true`: proceed, but **log to host UI for audit**.
- Same gate applies server-side on the worker (belt + suspenders).

### Rate limits + anomaly detection (phase 1)

- Keystroke cadence cap: max 500 keys/sec.
- Pattern detector: rolling buffer of last 256 keys; match against dangerous-string regex; flag + throttle.

### Screenshot injection-heuristic pre-screen (phase 1)

- Before returning a screenshot to the agent, run a lightweight OCR pass over candidate overlay regions (top-right, banners, modal centers) looking for: `"ignore previous"`, `"system:"`, `"<\|"`, `"new instructions:"`.
- Match → tag the response with `{suspicious_content: {regions, matched_patterns}}` and let the agent decide. Don't block; raise the bar.

### README security warning (phase 1)

Loud banner in the package README:

> **⚠️ LOCAL DEVELOPMENT ONLY UNTIL PHASE 4.**
> The signaling layer does not currently authenticate agent peers. Do not point synthi-mcp at a shared cloud signaling server. Session hijack is possible.

---

## Protocol versioning

- `synthi_attach` request: `{supportedProtocols: number[]}`.
- Server response: `{protocol_version: number}` or `{error:"unsupported_protocol", server_supports:[...]}`.
- Tool surface is **versioned**: tools gain fields over time; old clients get a restricted projection.
- Wire forward compat: unknown HMR status values, unknown tool responses → treated as `"unknown"` by old clients, never a crash. Values only added, never repurposed.
- Server emits v1-compat translations when targeting older clients.

Ship protocol version 1 at MVP. Every breaking change increments; additive change does not.

---

## Session lifecycle

Explicit enum carried in every tool response:

```
SessionState =
  | "warming"      # spawner starting worker pod
  | "ready"        # worker up, no guest program running
  | "running"      # worker up, guest program running
  | "hibernated"   # pod scaled to zero
  | "crashed"      # worker or guest errored (details via synthi_get_crash_info)
  | "terminated"   # session deleted
```

- `synthi_attach` on `hibernated` session: warm it (calls `POST /api/spawner/ensure`) or fail with `{error:"session_cold", can_warm:true}`.
- `crashed` → next calls return state + `crash_info` pointer; input rejected until acknowledge.
- `terminated` → next calls return `{error:"session_terminated"}`; agent stops trying.

---

## Cost observability

Shipped phase 1 (metrics + usage tool). Phase 2 adds quota enforcement.

| Metric                         | Scope               | Exposure                                       |
|--------------------------------|---------------------|------------------------------------------------|
| `tool_calls_by_tool`           | session × agent     | Prometheus, `synthi_get_usage`                  |
| `vision_inferences`            | session × agent     | Prometheus, `synthi_get_usage`                  |
| `egress_bytes`                 | session × agent     | Prometheus                                      |
| `worker_hot_ms_attributed`     | session × agent     | Prometheus                                      |
| `frame_age_p50/p95/p99`        | session             | Prometheus                                      |
| `quota_utilization_%`          | session × agent     | Envelope field on every response (`quota_headroom`) |

**Quota knobs** (phase 2 enforcement):
- `MAX_SCREENSHOTS_PER_MIN = 60`
- `MAX_VISION_CALLS_PER_HR = 240`
- `MAX_EGRESS_MB_PER_HR = 500`

Exceed → structured `quota_exceeded` error with `retry_after_ms`.

---

## Cross-topology latency budgets

| Topology           | RTT     | `synthi_mouse.click` p50 | `synthi_wait.hmr` p50        |
|--------------------|---------|--------------------------|------------------------------|
| Local              | ≤20ms   | <50ms                    | worker HMR time + 1 frame    |
| Cloud same-region  | ≤50ms   | ≤2× local                | ≤2× local                    |
| Cross-region       | ≤200ms  | document + `synthi_set_quality` to trade quality for responsiveness | document |

Phase-4 adds explicit cross-region testing. Phase 1 documents the budgets and ships `synthi_set_quality`.

---

## Operator observability (phase 2, UI)

Named phase-2 scope. Not optional for autonomous production operation.

- Live presence badge in host session toolbar. Which agents attached, client identity, start time.
- Real-time tool-call feed. Tool name + arg digest + duration. `synthi_keyboard.type` args redacted unless human opts in.
- Pre-click preview overlay. 100ms before `synthi_mouse.click` fires, highlight target bbox on human's video view. Human can abort.
- Session audit log. Browsable, exportable.
- Kill switch. One click: agent(s) disconnected, input queue flushed, WS closed, event logged.

---

## Synchronization primitives (the unified `synthi_wait`)

`synthi_wait` takes a discriminated `condition` arg:

| Condition           | Resolves when…                                                                               |
|---------------------|-----------------------------------------------------------------------------------------------|
| `hmr`               | HMR status is terminal AND sink frame-seq ≥ frame-seq-at-event (paint+encode+transport settled). |
| `motion_settled`    | Per-pixel delta over `roi` under threshold for N consecutive frames.                         |
| `pixel`             | `{x, y}` matches `color` within `tolerance`.                                                 |
| `scene_change`      | Embedding distance from baseline exceeds threshold.                                          |
| `text`              | OCR in `region` matches `pattern` regex.                                                     |
| `log`               | Guest stdout/stderr matches `pattern` regex.                                                 |
| `element`           | Locator handle resolves to a stable bounding box (enriched tier when available).             |

Default `timeoutMs: 30000`. All conditions respect session state — reject early on `terminated`.

---

## Semantic addressing (the `synthi_locate` path)

**Phase 1 backend:** call out to Claude API (vision) on the MCP server. Candidate bboxes returned with confidence. Cached per frame-seq.

**Phase 3 backend:** swap to local grounding model (grounding-DINO / SAM + CLIP). Same interface; no protocol change.

**Locator lifecycle:**

```
agent: synthi_locate({description: "Increment button"})
  → server: runs vision once per frame, caches
  → returns [{handle_id: "h_abc", description: "Increment button", resolve_policy: "at_action"}]

agent: synthi_mouse({action: "click", handle: "h_abc", waitFor: "element"})
  → server: re-resolves handle at dispatch time (new frame, new vision pass OR cached if same frame-seq)
  → applies click at currently resolved bbox
  → returns {ok, dispatch_id, frame_seq, resolved_bbox}
```

Stale bbox → no silent miss. Handle expires after `expires_ts`; agent must re-locate.

---

## Multi-agent fan-out (phase 2, protocol-committed in phase 1)

**Phase 1 (MVP):** one `synthi-mcp` subprocess per agent. Each is a browser peer. OK for 1–2 agents; wasteful at 5.

**Phase 2 (broker):** one `synthi-broker` process per session. Holds the single RTCPeerConnection. Decodes video once. Maintains shared vision cache. Serves N agent clients over local IPC (UNIX domain socket) or HTTP.

Input arbitration: broker-side `synthi_acquire_input` lease enforced. Human always preempts. Agents queue.

**Phase 1 requirements to make phase 2 non-breaking:**
- `dispatch_id` in every input response.
- `frame_seq` in every frame-bearing response.
- `protocol_version` negotiated on attach.
- Capability manifest includes `"broker_capable"` flag.

---

## Files — added / modified

### New (under `mcp/synthi-mcp/`)

```
mcp/synthi-mcp/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md               # loud security banner + per-client configs
├── TESTING.md
├── src/
│   ├── index.ts                 # stdio entrypoint
│   ├── server.ts                # MCP server + tool registry + version negotiation
│   ├── session.ts               # Session state, capability manifest
│   ├── envelope.ts              # Response envelope builder (state, usage, dispatch_id, frame_seq)
│   ├── signaling.ts             # WS client + version handshake
│   ├── peer.ts                  # RTCPeerConnection (@roamhq/wrtc primary, werift fallback)
│   ├── frames.ts                # RTCVideoSink, frame-seq counter, PNG/WebP encode, freshness SLA
│   ├── eventLog.ts              # Ring buffer
│   ├── wait.ts                  # Unified wait dispatcher (hmr+frame-seq gate, motion, pixel, scene, text, log, element)
│   ├── locate.ts                # Vision backend adapter (Claude API), handle registry, lazy resolve
│   ├── describe.ts              # VLM scene narration, cache
│   ├── usage.ts                 # Counters + Prometheus emitter
│   ├── quality.ts               # synthi_set_quality bitrate/fps negotiation
│   ├── security.ts              # Sensitive-action regex, injection-heuristic pre-screen
│   ├── lease.ts                 # Input lease client (wire shape)
│   ├── coords.ts                # Shared letterbox math (imported from workspace pkg)
│   ├── cancel.ts                # Request-id registry, abort propagation
│   ├── shutdown.ts              # Graceful PC+WS close on SIGTERM
│   ├── tools/
│   │   ├── attach.ts, detach.ts, health.ts
│   │   ├── mouse.ts, keyboard.ts
│   │   ├── screenshot.ts
│   │   ├── wait.ts
│   │   ├── locate.ts, describe.ts
│   │   ├── get_event_log.ts
│   │   ├── get_usage.ts, set_quality.ts
│   │   ├── set_goal.ts, checkpoint.ts
│   │   ├── acknowledge_disruption.ts, get_crash_info.ts
│   │   ├── acquire_input.ts, release_input.ts
│   │   └── request_human.ts, annotate_and_ask.ts, recent_human_actions.ts
│   └── wire/
│       ├── input.ts         # Mouse/key JSON encoders (strict types)
│       ├── hmr.ts           # HMR event types, frame-seq tagging
│       ├── events.ts        # Event log schemas
│       └── protocol.ts      # Version negotiation, envelope schema
└── tests/
    ├── unit/
    │   ├── wire.test.ts, coords.test.ts, waitHmr.test.ts
    │   ├── locate.test.ts, security.test.ts, envelope.test.ts
    ├── integration/
    │   ├── connect.test.ts, click.test.ts, hmr.test.ts
    │   ├── security.test.ts           # sensitive-action interstitial
    │   ├── session_lifecycle.test.ts  # warming/hibernated/crashed/terminated
    │   ├── quota.test.ts              # metrics correctness
    │   ├── protocol_version.test.ts
    │   ├── multi_agent.test.ts        # input contention without lease enforcement (phase 1)
    │   └── chaos.test.ts              # scaffold for phase-2 chaos layer
    └── fixtures/
        ├── counter_swing/   # Java Swing, a11y-enabled (enriched-tier test)
        └── counter_sdl2/    # C++ SDL2, no a11y (universal-tier test — the important one)
```

### Workspace package (shared coord math)

- `packages/synthi-ui-coords/` — TypeScript module with letterbox-coord algorithm.
- Consumed by: `synthi/src/components/DraggableVideoWidget.jsx` (replaces inline impl) AND `mcp/synthi-mcp/src/coords.ts`. One source of truth.

### Modified — backend

| File                                                                                      | Change                                                                                                   |
|-------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| `backend/synthi-webrtc-compiler/signaling-server/src/main.rs`                             | Protocol version handshake; empirically verify whether two `"browser"` role peers are already allowed on one session — document the finding and gate on it. |
| `backend/synthi-webrtc-compiler/worker/src/**`                                            | Input dispatch ack emit; focus-lock enforcement (xdotool `--window <id>`); HMR frame-seq tagging on `build-log`; per-session usage counters; sensitive-action worker-side check; seccomp profile for guest process. |
| `backend/synthi-webrtc-compiler/worker/src/compiler/stages/runner.rs`                     | Capture guest Xvfb window ID at program start; seccomp wrapper on guest spawn.                          |
| `backend/collab-server/SessionManager.js`                                                 | Session lifecycle state queryable via REST; warm endpoint.                                               |
| `backend/collab-server/collabSessionService.js`                                           | `GET /session/:id/state`; `POST /session/:id/warm` (wraps existing spawner).                             |

### Modified — frontend (phase 2)

- `synthi/src/components/SessionToolbar.*` — "Connect agent" button (copies config snippet for current session).
- New: `synthi/src/components/AgentObservabilityPanel.*` — presence, feed, pre-click overlay, kill switch.
- `synthi/src/components/DraggableVideoWidget.jsx` — swap inline letterbox math for workspace package import.

---

## Implementation phases

### Phase 0 — Scaffold  *(done: branch exists; this doc committed)*

- `claude/agent-mcp` branch created from main (done).
- `mcp/synthi-mcp/` package scaffold.
- Smoke test: stdio server with `synthi_ping`. Verified via `@modelcontextprotocol/inspector`.

### Phase 1 — MVP with correctness, security, versioning, observability  *(~10–14 days)*

Everything listed above lands in phase 1 *except* the items explicitly deferred below.

**In scope (phase 1):**
- Universal-tier core 10 tools + operational 6 + escape hatches (wire only) + arbitration wire (no enforcement).
- Capability manifest + protocol version negotiation.
- Playwright-style compound actions; lazy locators; auto-waiting.
- Unified `synthi_wait` with frame-seq gate on `hmr`.
- Server-side vision via Claude API.
- Event log ring buffer + MCP resource subscriptions.
- Server-enforced correctness table (every row → worker/MCP enforcement + integration test).
- Security: focus lock, guest seccomp, sensitive-action interstitial, injection-heuristic pre-screen, rate limits.
- Cost observability: Prometheus metrics + `synthi_get_usage`.
- Session lifecycle enum in every response; `synthi_attach` warms hibernated workers.
- PNG default, perceptual-hash diff, `synthi_set_quality`.
- Workspace package for shared letterbox math.
- Dispatch-ack from worker on every input.
- Request-id registry + cancellation on client disconnect.
- Graceful shutdown (SIGTERM → close PC, DC, WS; unregister from signaling).
- README with loud security banner + per-client config snippets (Claude Code, Codex, Cursor, Gemini CLI, Windsurf).
- Empirical verification of v1 assumptions:
  - Does signaling allow two `"browser"` peers per session today? (If yes, proceed. If no, fix via protocol version bump or phase-4 `mcp-agent` role.)
  - Are all 10 HMR statuses actually emitted on `build-log`? Audit each emission site.

**Deferred (phase 2+):**
- Quota enforcement (metrics only in phase 1).
- Enriched-tier a11y adapters (Swing first).
- `synthi-probe` cooperative library.
- Broker implementation.
- Input lease enforcement on worker.
- Operator observability UI.
- Audio tee.
- Chaos test suite (hooks in phase 1, full suite phase 2).
- Snapshot/restore (phase 3).
- Local vision grounding (phase 3, Claude API first).
- Phase-4 `mcp-agent` role + scoped token.

### Phase 2 — Distribution, enrichment, arbitration, operator UI  *(~10–14 days)*

- npm publish `@synthi/mcp-server`.
- Swing `javax.accessibility` enriched-tier adapter (fixture drives this).
- `synthi-probe` cooperative library (C, C++, Java, JS).
- Broker implementation (one PC per session, N agent clients over UNIX socket).
- Worker-side input lease enforcement.
- Audio tee via GStreamer; `synthi_get_audio_level`, `synthi_wait_audio_event`.
- Frontend operator observability UI.
- Frontend "Connect agent" button.
- Quota enforcement on the metrics infrastructure from phase 1.
- Chaos testing suite.

### Phase 3 — Robustness, snapshot/restore, local vision  *(~7–10 days)*

- Snapshot/restore (git commit + guest process restart — 80% solution).
- Local grounding model swap-in for `synthi_locate` / `synthi_describe`.
- Long-haul soak tests.
- Escape-hatch UI implementation (host-side `request_human`, `annotate_and_ask`).

### Phase 4 — Remote multi-tenant auth  *(~3–5 days, optional for single-tenant deploys)*

- `mcp-agent` role in signaling.
- Scoped agent-token issuance in collab-server.
- Cross-region latency test bench with tc-netem.
- TURN credentials for `mcp-agent` identity.

---

## Testing plan

### Fixtures

Two reference fixtures, both compiled and run in the worker:

1. **`counter_swing/`** — Java Swing, a11y-enabled. Exercises enriched tier when attached to a Swing runtime. Increments counter; writes to `/tmp/...counter.txt` as belt-and-suspenders only.
2. **`counter_sdl2/`** — C++ SDL2, no a11y. **The important one.** Exercises universal tier: `synthi_locate` + perceptual waits + pixel input. If tests pass against this fixture, the universal-tier thesis is real.

**Primary assertion is visual** (pHash against golden, or OCR on counter region). Side-channel `/tmp` file is secondary.

### Layer 1 — unit (vitest)

- `wire.test.ts` — golden byte-for-byte matches for every input wire shape vs. recorded browser traffic.
- `coords.test.ts` — letterbox math parity between frontend and MCP (shared package).
- `waitHmr.test.ts` — frame-seq gate semantics: `applied` alone doesn't resolve; sink frame-seq ≥ event frame-seq required.
- `locate.test.ts` — handle lifecycle: resolve at action time, expire, re-issue.
- `security.test.ts` — sensitive-action regex coverage; confirm required for shell metachars.
- `envelope.test.ts` — every tool response carries required envelope fields.
- `hmrStates.test.ts` — parser handles all 10 HMR statuses + `"unknown"` forward-compat.

### Layer 2 — integration (real docker-compose)

One test per row of the server-enforced correctness table, minimum. Plus:

- `connect.test.ts` — attach → manifest → protocol version → screenshot.
- `click_sdl2.test.ts` — universal-tier: `synthi_locate({description:"Increment"})` → `synthi_mouse({handle, action:"click", waitFor:"stable"})` → pHash against golden counter=1. **No a11y, no /tmp assertion.**
- `click_swing.test.ts` — enriched-tier: same test via `synthi_query`/`synthi_act` path.
- `hmr_correctness.test.ts` — edit source, `synthi_wait({condition:"hmr"})`, assert returns only after fresh frame.
- `input_during_compile.test.ts` — send click during HMR `compiling`; assert queued-or-rejected per spec.
- `frame_stale.test.ts` — wedge GStreamer (SIGSTOP encoder); `synthi_screenshot` returns `frame_stale` error.
- `focus_drift.test.ts` — guest spawns child window; input delivery gated until refocus; event emitted.
- `sensitive_action.test.ts` — `synthi_keyboard.type("rm -rf /")` without `confirm` → rejected; with `confirm` → allowed + logged.
- `session_lifecycle.test.ts` — attach to warming, hibernated, crashed, terminated sessions; each returns correct structured error.
- `protocol_version.test.ts` — old client (v1) against new server (v2) gets restricted tool set; unknown enum → `"unknown"`, not crash.
- `multi_agent.test.ts` — two MCP clients on same session; phase 1 documents the race; phase 2 asserts lease fairness.
- `quota_metrics.test.ts` — counters increment correctly; Prometheus scrape matches.
- `reconnect.test.ts` — kill worker pod; MCP auto-renegotiates on re-up without restart.
- `prompt_injection.test.ts` — **adversarial fixture renders "Ignore previous instructions..." text**; assert screenshot response carries `suspicious_content` tag; assert focus lock prevents stray keystrokes.

### Layer 3 — end-to-end (real agent harnesses)

- Claude Code: `claude mcp add synthi ...`; prompt "Test the counter app"; assert trace includes `synthi_locate` → `synthi_mouse` (not raw coords) and passes.
- Codex via `~/.codex/mcp_servers.toml`.
- Cursor, Gemini CLI, Windsurf — same test.
- Ship the verified trace in README as the "hello world."

### Layer 4 — chaos (phase 2 full suite, hooks in phase 1)

Wrapper around the integration suite that injects:
- Latency (tc-netem: 50ms, 200ms, 500ms RTT).
- DC packet drops (1%, 5%, 10%).
- Frame freezes (SIGSTOP/SIGCONT encoder).
- Worker kills (mid-action).
- Redis partition.
- Payload corruption.

Assert: no agent makes a wrong decision on stale data. Either the tool returns a structured error, or the test catches a regression.

### Layer 5 — soak (phase 3)

- 1-hour run with random inputs + HMR edits + screenshots.
- Assert memory flat, no FD leaks, no orphan data channels, peer-connection-state distribution healthy.
- 24-hour autonomous agent test against the counter fixture; assert agent completes an assigned workflow without human intervention.

### Layer 6 — manual QA checklist

`TESTING.md` with a 15-step golden path per client harness.

---

## Risks & mitigations (v2)

| Risk                                                      | Likelihood | Impact | Mitigation                                                                                                             |
|-----------------------------------------------------------|------------|--------|------------------------------------------------------------------------------------------------------------------------|
| Phase-1 scope overruns                                    | M          | M      | Scope locked in this doc. Deferred items listed explicitly. Agent for each phase = Plan subagent to ensure trade-offs are surfaced. |
| `@roamhq/wrtc` bus-factor                                 | M          | H      | `werift` (pure-JS WebRTC) included as fallback, selectable via env.                                                     |
| Vision backend cost (Claude API per frame)                | M          | M      | Frame-seq caching. Quota on `synthi_locate`/`synthi_describe`. Local model replacement phase 3.                          |
| Signaling doesn't allow 2 `"browser"` peers (v1 assumption false) | M    | M      | Empirically verify in phase 1 before writing MCP peer code. If false: ship phase-4 `mcp-agent` role early.               |
| HMR status coverage incomplete                            | M          | M      | Audit each status emission site in worker; tests cover all 10 including `"unknown"` forward-compat.                     |
| Focus-lock false positives                                | L          | M      | Fallback UX: if focus lost, surface event + block input; agent calls `synthi_acknowledge_disruption` to unblock.         |
| Seccomp profile blocks legitimate guest syscalls          | M          | M      | Start with permissive profile matching current behavior; tighten iteratively with fixtures covering the language matrix.|
| Input lease retrofit painful                              | M          | M      | Wire shipped in phase 1 (not enforced); phase 2 adds worker enforcement without protocol break.                         |
| Adversarial prompt injection bypasses heuristics          | M          | H      | Defense-in-depth: heuristic pre-screen + focus lock + sandbox + sensitive-action interstitial. No single layer is sufficient. |

---

## Empirical pre-work for phase 1

Before writing phase-1 MCP peer code, verify (≤1 day, documented in a short `PHASE1_PREWORK.md`):

1. Does `signaling-server/src/main.rs` allow two `role:"browser"` peers on one `session_id`? Read the peer-routing logic; test by running two browser tabs on one session.
2. Of the 10 HMR statuses listed in `HMRStatusIndicator.jsx`, which are *actually emitted* by the worker on `build-log` today? Audit each worker-side emission site. Reconcile the frontend catalog against emissions.
3. Is there an existing per-session usage counter in collab-server or worker? If yes, extend; if no, add.
4. Does the worker already capture the guest's Xvfb window ID? If yes, wire to focus-lock; if no, add at `runner.rs` program-start.

Findings published in `PHASE1_PREWORK.md`; failure on any point either fixes the plan or triggers a scope bump.

---

## Open items (requires user direction)

Most v1/v2 open questions are committed in this doc. Remaining:

1. **SDL2 fixture** — is the worker toolchain ready to compile a minimal C++ SDL2 program inside the pod? If not, phase 1 adds toolchain installation (small bump).
2. **Seccomp scope** — happy to ship a permissive-by-default profile tightened over phase 1, or do we want to target a specific hardening level out of the gate?
3. **Vision backend identity** — Claude API for phase 1 (lowest friction, highest quality). Want me to proceed with that choice?
4. **Operator UI scope for phase 2** — minimum-viable (presence badge + kill switch only) or full set (presence + feed + pre-click preview + audit log + kill)?

---

## Approval checklist

Before I execute phase 1:

- [ ] Phase-1 scope acceptable (up from ~4 days in v1 to ~10–14 days in v2, with materially more shipped).
- [ ] Worker-side changes in phase 1 scope accepted (focus lock, seccomp, HMR frame-seq tagging, dispatch ack, usage counters, sensitive-action check).
- [ ] Claude API for server-side vision in phase 1 accepted.
- [ ] 4 open items above answered.
- [ ] Any additional scope changes from you.

On green light: empirical pre-work → phase 1 → demo end-to-end against SDL2 fixture (universal tier) and Swing fixture (enriched tier) → wait for go on phase 2.

---

## Appendix — wire format citations (preserved from v1)

- Signaling register/SDP: `backend/synthi-webrtc-compiler/signaling-server/src/main.rs:41–63`
- Signaling session mux + Redis relay: `signaling-server/src/main.rs:80–200`
- Browser data-channel routing: `synthi/src/services/compilerClient.js:300–359, 549–563, 735–751`
- Worker spawner call: `synthi/src/services/compilerClient.js:175–199`
- Desktop input consumer (xdotool): `backend/synthi-webrtc-compiler/worker/src/compiler/java/input.rs:30–108`
- JS-key → SDL mapping: `backend/synthi-webrtc-compiler/worker/src/main.rs:217–277`
- Android input consumer (ADB/gRPC): `backend/synthi-webrtc-compiler/worker/src/android/webrtc/input.rs:82–428`
- GStreamer + Xvfb init: `backend/synthi-webrtc-compiler/worker/src/compiler/stages/runner.rs:180–250`
- HMR listeners (frontend): `synthi/src/hooks/useHMR.js:240–306`
- HMR status catalog (UI reference): `synthi/src/components/HMRStatusIndicator.jsx:20–167`
- Session creation + inviteToken: `backend/collab-server/SessionManager.js:130–150`
- Permission model: `backend/collab-server/SessionManager.js:31–46`
- Letterbox coord math (source of truth → shared workspace package): `synthi/src/components/DraggableVideoWidget.jsx:73–117`
