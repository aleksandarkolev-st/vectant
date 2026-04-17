# Synthi MCP — MVP Spec

**Status:** scope-locked. This is the current build target.
**Supersedes:** `AGENT_MCP_ULTRAPLAN.md` as the implementation plan (the ultraplan is kept as future-scope / design-space reference).
**Branch:** `claude/agent-mcp`
**Date:** 2026-04-16 (v1), updated 2026-04-17 (Path B decision — see below).

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

**Small backend change** *(updated 2026-04-17 per research + user decision; see Path B below).* synthi-mcp registers with signaling as `role: "observer"`, completes SDP exchange, opens data channels. Human browser + MCP observer are co-attached on the same session — no peer eviction.

**Two-browser-peer question — resolved.** Research confirmed (2026-04-17) that `signaling-server` is strictly 1:1 today: `PeerKey = (session_id, role)` with binary `browser|worker`, zero multi-peer infra. The MVP's originally-listed "one-line fix" was optimistic. The agreed change is:

- **`signaling-server/src/main.rs`** — add `observer` role; refactor `PeerKey` to `(session_id, role, peer_id)` OR keep per-role and allow multiple entries for `observer`; fan out SDP/ICE messages to all peers of the target role; unchanged routing for non-SDP/ICE messages. ~20-50 LOC Rust + one integration test (1 browser + 1 observer on same session).
- **Worker side** — new `{type:"frame-advance", frame_seq, ts_ms}` data-channel message alongside RTP writes, so MCP can gate `synthi_wait_hmr` on frame-seq (see ultraplan §WebRTC pipeline reuse for details). For MVP's simpler `synthi_wait_hmr` that resolves on status alone (no frame-seq gate), this message is not strictly required — MVP can ship without it if we accept a small stale-frame risk documented in the ultraplan's E1 experiment.

**Frame-seq gate for MVP.** Optional. MVP's `synthi_wait_hmr` resolves on the `hmr-status` message alone (`applied`/`rejected`/`compile-error`/`full-reload-required`) — per ultraplan E1 experiment, whether the status-only gate is sufficient depends on observed stale-frame rate. MVP ships status-only; if agents hit stale frames in practice, ultraplan phase 1 adds the frame-seq gate.

### Implementation amendment — 2026-04-17 (Path A shipped)

A code audit during the implementation-plan pass (`AGENT_MCP_IMPLEMENTATION_PLAN.md:F3`) established that the MVP's "~20-50 LOC Rust + one integration test" estimate for Path B (observer co-attach) is broken: a WebRTC peer connection is 1:1, so signaling-server fan-out alone does not grant a second peer access to worker media. Enabling true co-attach requires per-peer `RTCPeerConnection` support in the worker (~250-450 LOC, ultraplan phase 2+ ticket `G3`), shifting MVP from ~3-5 days to ~7-10 days.

To preserve the 3-5 day MVP budget, **the implementation ships Path A**: `synthi-mcp` registers with signaling as `role: "browser"` and evicts any existing human browser peer on that session. The human can re-attach after the agent detaches. This mirrors the worker's existing 1:1 reality with zero backend changes. Co-attach stays deferred to ultraplan `G3`.

The `{type:"frame-advance", frame_seq, ts_ms}` worker emission described above remains out of scope — MVP uses the status-only `synthi_wait_hmr` path.

The normalizer's HMR terminal-event set was also widened from the MVP's single-shape `{type:"hmr-status", data:{status}}` to four wire families (see `AGENT_MCP_IMPLEMENTATION_PLAN.md:F2` for the verified truth table). `synthi_wait_hmr` default timeout is **60 s** (up from 30 s) to accommodate Tier 3 AI-split + compile + healing latency.

See `mcp/synthi-mcp/README.md` for installation + `claude mcp add` usage.

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

**~3–5 days of focused work** *(updated 2026-04-17 for Path B; was 2-4 days under the "zero backend changes" assumption).*

- WebRTC peer: ~150 LOC (unchanged).
- MCP plumbing: thin (unchanged).
- Signaling-server `observer` role + SDP/ICE fan-out: ~20-50 LOC Rust + integration test (1 browser + 1 observer on one session). ~1-1.5 days.
- Three-layer MVP test suite + Claude-Code smoke loop. ~1 day.

The extra ~1-2 days over the original 2-4 day estimate covers the signaling-server change. This is the cost of keeping the human + agent co-attached (agent-as-observer product intent) rather than having the agent evict the human (Path A, which would keep the 2-4 day budget but break the UX).

---

## Remaining open question

Original ask: *"click buttons, wait for hmr to complete and so on."* Latest message: *"see in real time its changes."* One is view+input; one reads as view-only. Which MVP scope?

- **View + basic input (default above): 5 tools.** Agent observes AND drives.
- **View-only: 4 tools.** Drop `synthi_click` and `synthi_type`. Agent observes; human clicks.

Lean: **5 tools** — matches the original prompt, adds <½ day. Happy to go view-only if you'd rather ship tighter.

---

## On green light

1. Scaffold `mcp/synthi-mcp/` package.
2. **Add `observer` role + SDP/ICE fan-out to `signaling-server/src/main.rs`** *(v4.2 — Path B)*.
3. Signaling client + WebRTC peer + data channels (MCP registers as `observer`, not `browser`).
4. Five tool handlers.
5. Three-layer test suite (integration test exercises 1 browser + 1 observer co-attached).
6. Demo against a Claude Code session using the counter fixture, human browser kept attached.
7. Stop there. Revisit the ultraplan only if a real agent loop hits a real limit.
