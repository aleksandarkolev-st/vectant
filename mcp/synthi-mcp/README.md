## ⚠️ LOCAL DEV ONLY

This package has **no authentication**. Do not point it at a shared signaling server or a cloud Synthi instance. It is intended for a developer running Synthi + an AI agent side-by-side on the same machine.

An MCP that attaches to Synthi inherits the attached session's capabilities: it can type, click, and see the running preview. Agents on untrusted signaling servers become an injection vector into your sessions.

---

## What this is

Minimal MCP server that lets an AI coding agent (Claude Code, Codex, Cursor, etc.) **observe** and **drive** a running Synthi preview over WebRTC. Five tools:

| Tool | Purpose |
|------|---------|
| `synthi_attach` | Connect as a WebRTC peer to an existing Synthi session. |
| `synthi_screenshot` | Return the latest video frame as a PNG. |
| `synthi_wait_hmr` | Block until HMR reaches a terminal status. |
| `synthi_click` | Send a mouse click at Xvfb pixel coordinates. |
| `synthi_type` | Type a string into the session. |

Expected loop:

```
agent.edit("src/App.jsx", ...)        // agent's own Edit tool
await synthi_wait_hmr()               // block until the change is live
img = await synthi_screenshot()       // see the result
```

Nothing else — no semantic locators, no vision grounding, no verify primitives. See `AGENT_MCP_ULTRAPLAN.md` for the broader design space.

---

## Install

Requires Node ≥ 18 and a running Synthi stack (e.g., `docker-compose up -d` at the repo root).

```bash
cd mcp/synthi-mcp
npm install
npm run build
```

### Register with Claude Code

```bash
claude mcp add synthi -- node /abs/path/to/mcp/synthi-mcp/dist/index.js --session <SESSION_ID>
```

Replace `<SESSION_ID>` with a session id from `POST http://localhost:1234/session/create` on the collab server, or pass `--session` at run time.

### Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `SYNTHI_SESSION_ID` | *(none)* | Session id, if not passed via `--session`. |
| `SYNTHI_SIGNALING_URL` | `ws://localhost:9000` | Signaling WebSocket URL. |

CLI args override env; env overrides the built-in defaults.

---

## Tools

### `synthi_attach`

```json
{ "sessionId": "...", "signalingUrl": "ws://localhost:9000" }
→ { "ok": true, "connected": true, "resolution": { "w": 1080, "h": 1920 },
    "sessionId": "...", "signalingUrl": "..." }
```

Opens a WebSocket to the signaling server, registers as `role:"browser"`, exchanges SDP with the worker, sets up the `terminal` outbound DC and the worker-initiated `build-log` inbound DC, and waits for the first video frame. Required before any other tool.

**Path A behavior (MVP):** registers as `browser`, which evicts any existing human browser peer on that session. Human can re-attach after the agent detaches. True co-attach (`observer` role) is deferred to ultraplan ticket `G3`.

### `synthi_screenshot`

```json
{}
→ content: [{ type: "image", data: "<base64 PNG>", mimeType: "image/png" },
             { type: "text", text: "{\"w\":1080,\"h\":1920,\"ts\":...,\"seq\":N}" }]
```

Returns the latest received frame as a PNG. I420 → RGBA via `@roamhq/wrtc`'s native binding, then PNG via sharp.

### `synthi_wait_hmr`

```json
{ "timeoutMs": 60000 }
→ { "status": "applied" | "rejected" | "compile-error"
            | "full-reload-required" | "discarded" | "timeout",
    "elapsedMs": N, "source": "candidate_notification" | "hmr_status" | ... }
```

Subscribes to the `build-log` DC and resolves on the first terminal HMR event, or the timeout. The normalizer parses four wire families (CandidateNotification events, bare HmrStatus, `{type:"hmr-status"}` rollback notifications, `{type:"compile-diagnostics"}` compile failures) and collapses them to the unified status set.

Default timeout is **60 s** to accommodate Tier 3 (AI split + compile + healing) latency; Tier 0 live-memory patches resolve in ~30 ms.

### `synthi_click`

```json
{ "x": 420, "y": 300, "button": "left" }
→ { "ok": true }
```

Sends a mouse-down then mouse-up pair. `button` codes follow X11/SDL: left=1, middle=2, right=3 (mapped internally from the `"left"`/`"middle"`/`"right"` strings).

### `synthi_type`

```json
{ "text": "hello world" }
→ { "ok": true, "charsSent": 11 }
```

Expands `text` into a sequence of `key down`/`key up` events using `ev.key` semantics (the JS DOM key name: single characters stay literal, `"Enter"`, `"Tab"`, etc. stay named). Rate-capped at 500 keys/sec.

---

## Known limitations

- **Single attach per process.** One MCP subprocess drives one session.
- **No reconnect.** If the signaling socket drops mid-session, re-launch the MCP.
- **No frame-seq gate on `wait_hmr`.** Status-only resolution; a small stale-frame risk exists on very fast Tier 0 live-mem paths. See ultraplan §E1.
- **No vision, no locators, no verify primitives.** Agents must work off raw pixels.
- **No input arbitration lease.** If a human is still attached as a second browser (not supported in Path A, but possible in mixed setups), both peers can send input.
- **Localhost-only security posture.** No `--i-understand-no-auth` flag yet. The signaling URL is expected to be local.

For any of the above, see `AGENT_MCP_ULTRAPLAN.md` at the repo root.

---

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm test            # vitest run (unit tests)
npm run dev         # tsx src/index.ts — iterate without build
```

Enable the end-to-end integration test by starting docker-compose at the repo root and setting `SYNTHI_MCP_E2E=1` before `npm test`.

Real-agent smoke:

```bash
./tests/e2e/claude_code_smoke.sh
```
