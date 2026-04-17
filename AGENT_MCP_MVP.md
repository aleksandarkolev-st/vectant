# Synthi MCP — MVP Spec

**Status:** scope-locked. This is the current build target.
**Supersedes:** `AGENT_MCP_ULTRAPLAN.md` as the implementation plan (the ultraplan is kept as future-scope / design-space reference).
**Branch:** `claude/agent-mcp`
**Date:** 2026-04-16

---

## What this is

A minimal MCP server that connects to the existing Synthi WebRTC preview stream so AI coding agents (Claude Code, Codex, Cursor, etc.) can **see their code changes happen in real time**.

The agent already has code editing — its own tools (Edit/Write/filesystem) handle that. Synthi MCP closes only the visual feedback loop:

```
agent edits code → Synthi HMR → agent screenshots → agent sees the result
```

Nothing more.

---

## Scope (exactly this)

**5 tools. No semantic layer. No security hardening. No protocol versioning. No lifecycle states. No quotas.**

| Tool               | Input                                   | Output                         | Purpose                                                        |
|--------------------|-----------------------------------------|--------------------------------|----------------------------------------------------------------|
| `synthi_attach`    | `{sessionId, signalingUrl?}`            | `{ok, resolution, connected}`  | Connect as headless browser peer to an existing session.       |
| `synthi_screenshot`| `{}`                                     | PNG + `{w, h, ts}`             | Latest frame.                                                  |
| `synthi_wait_hmr`  | `{timeoutMs?: 30000}`                    | `{status, elapsedMs}`          | Block until HMR fires `applied` / `rejected` / `compile-error`.|
| `synthi_click`     | `{x, y, button?}`                        | `{ok}`                         | Click at Xvfb pixel coords.                                    |
| `synthi_type`      | `{text}`                                 | `{ok}`                         | Type a string.                                                 |

Expected agent loop:

```
agent.edit("src/App.jsx", ...)       // via Claude Code's own Edit tool
await synthi_wait_hmr()              // block until change is live
img = await synthi_screenshot()      // see the result
// optionally click/type to exercise the UI, then loop
```

---

## Explicitly out of scope

Everything in `AGENT_MCP_ULTRAPLAN.md`:
- Semantic locators, vision grounding, VLM scene description
- Compound auto-waiting actions (Playwright-style)
- Full `wait` family (motion_settled, pixel, scene_change, source_reflected, element, …)
- Security: focus lock, guest seccomp, sensitive-action interstitial, injection heuristics
- Protocol version negotiation, session lifecycle enum
- Cost observability, quotas
- Broker / multi-agent fan-out
- Enriched-tier adapters, `synthi-probe`
- Operator observability UI
- Snapshot / restore
- Cross-topology latency budgets
- Escape hatches (`request_human`, `annotate_and_ask`)
- Input arbitration lease

Those are good designs and they may ship later. They do not block MVP. If real agents hit real limits, we revisit the ultraplan and lift pieces out as needed.

---

## Architecture

```
 agent ──MCP stdio──> synthi-mcp ──ws──> signaling-server ──WebRTC──> worker (existing)
                      │
                      ├─ receives video track   (@roamhq/wrtc RTCVideoSink → PNG)
                      ├─ sends input on "terminal" DC   (existing wire format)
                      └─ listens to "build-log" DC for HMR events
```

**Zero backend changes.** synthi-mcp registers with signaling as `role: "browser"`, completes SDP exchange, opens data channels — mirrors the existing browser exactly. If two-browser-peer registration turns out to be blocked by the signaling server (empirical unknown), we document it and either (a) kick the human when the agent attaches, or (b) add a second-peer allowance on the signaling server as a one-line fix.

---

## Implementation

**Package:** `mcp/synthi-mcp/` — Node 20+, TypeScript.
**Deps:** `@modelcontextprotocol/sdk`, `@roamhq/wrtc`, `ws`, `sharp`.
**Size target:** ~400 LOC source across 7 files.

```
mcp/synthi-mcp/
├── package.json
├── tsconfig.json
├── README.md            # install + loud security banner (local dev only)
└── src/
    ├── index.ts         # stdio entry, reads SYNTHI_SESSION_ID / --session
    ├── server.ts        # MCP tool registry
    ├── signaling.ts     # WS + SDP exchange
    ├── peer.ts          # RTCPeerConnection + data channels
    ├── frames.ts        # RTCVideoSink → PNG via sharp
    ├── hmr.ts           # build-log parse, applied/rejected promise
    └── tools/
        ├── attach.ts
        ├── screenshot.ts
        ├── wait_hmr.ts
        ├── click.ts
        └── type.ts
```

**Wire formats (verbatim from existing browser client):**
- Click/key: `{type: 'mouse'|'key', action, x, y, button, key}` on the `"terminal"` DC.
- HMR: `{type: 'hmr-status', data: {status, message?}}` on the `"build-log"` DC. Resolve `wait_hmr` on `status ∈ {applied, rejected, compile-error, full-reload-required}`.

**Security posture:** local dev only. README banner: *"Do not point at a shared signaling server — no agent auth yet."*

---

## Testing

Three layers, minimal, all real.

1. **Unit (`wire.test.ts`).** Golden-byte match for every produced click/key/type JSON against payloads captured from a live browser session.
2. **Integration (`e2e.test.ts`).** docker-compose up → create a session → `synthi_attach` → `synthi_screenshot` (assert non-empty PNG, correct dims) → edit a source file via collab REST → `synthi_wait_hmr` (assert returns `applied` within budget) → `synthi_screenshot` again (assert pHash differs from baseline).
3. **Real-agent smoke.** `claude mcp add synthi -- node dist/index.js --session $ID`; prompt: *"Attach to the preview and describe what you see. Then wait for HMR and screenshot again."* Verify the trace shows the right tool calls and the final screenshot reflects a post-HMR state.

Fixture: keep it dead simple — the existing Swing counter fixture from the ultraplan testing section, but *only* asserting on the screenshot (no side-channel `/tmp` file). If the agent can see "1" turn into "2" after it edits the counter's increment amount, MVP works.

---

## Estimate

**2–4 days of focused work.** WebRTC peer is ~150 LOC; MCP plumbing is thin; the bulk is the integration test and the Claude-Code smoke loop.

---

## Remaining open question

Original ask: *"click buttons, wait for hmr to complete and so on."* Latest message: *"see in real time its changes."* One is view+input; one reads as view-only. Which MVP scope?

- **View + basic input (default above): 5 tools.** Agent observes AND drives.
- **View-only: 4 tools.** Drop `synthi_click` and `synthi_type`. Agent observes; human clicks.

Lean: **5 tools** — matches the original prompt, adds <½ day. Happy to go view-only if you'd rather ship tighter.

---

## On green light

1. Scaffold `mcp/synthi-mcp/` package.
2. Signaling client + WebRTC peer + data channels.
3. Five tool handlers.
4. Three-layer test suite.
5. Demo against a Claude Code session using the counter fixture.
6. Stop there. Revisit the ultraplan only if a real agent loop hits a real limit.
