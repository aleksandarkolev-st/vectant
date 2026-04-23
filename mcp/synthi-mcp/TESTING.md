# Synthi MCP — Manual QA (Golden Path)

**Purpose.** Per-client manual smoke test before tagging a release.
Complements the automated unit + integration suites (`npm test` /
`SYNTHI_MCP_E2E=1 npm test`). Run this once per supported MCP client
before cutting `v0.X.Y`.

**Supported clients (2026-04-18).** Tier-1 automated: Claude Code.
Tier-1 manual (walk this doc): Codex CLI, Cursor, Gemini CLI,
Windsurf. Backlog `J1` tracks the CI retrofit for the manual ones.

**Environment.** All steps assume:

- `docker-compose up -d` from repo root — full stack running (redis,
  postgres, y-sweet, collab-server, signaling-server, ai-engine,
  ai-gateway, worker, frontend).
- `cd mcp/synthi-mcp && npm install && npm run build`.
- A fresh session: `POST http://localhost:1234/session/create` with the
  `counter_sdl2` fixture slug; capture the returned `sessionId` into
  `$SID`.

**Acceptance.** Every step below must pass on every client before a
release. Failures go in the PR description as `MANUAL_QA_FAIL:
<client>:<step>:<symptom>`.

---

## The 15 steps

### 1. Register the MCP

**Purpose.** Confirms the client can spawn the stdio subprocess + list
tools.

- **Claude Code:** `claude mcp add synthi -- node $(pwd)/dist/index.js --session $SID`
- **Codex CLI:** `~/.codex/mcp.json` entry — `{ "command": "node", "args": ["$(pwd)/dist/index.js", "--session", "$SID"] }`
- **Cursor:** `~/.cursor/mcp.json` — same shape.
- **Gemini CLI:** `~/.gemini/mcp.json` — same shape.
- **Windsurf:** Settings → MCP servers → add with `node ... --session $SID`.

**Pass:** the client's tool list shows 23 `synthi_*` tools. Not more,
not fewer.

### 2. Probe the manifest

Ask the agent (or type into the client's raw-tool UI if available):

> Call `synthi_attach` with no args. Report `protocol.version` and
> the length of `capabilities.vision_backends`.

**Pass:** `protocol.version == 1`; `vision_backends.length == 4`
(`agent_side`, `claude_api`, `gemini_api`, `mock`); `session.state ==
"ready"` or `"running"`; envelope has `unsafe_mode: false` (local dev).

### 3. First screenshot

> Call `synthi_screenshot`. Report `w`, `h`, and the first 16 bytes of
> `data` (base64).

**Pass:** `w=1080`, `h=1920` (SDL2 fixture default); base64 starts with
`iVBORw0KGgo` (PNG magic).

### 4. Health

> Call `synthi_health`. Report `frame_age_ms` and `connection_state`.

**Pass:** `frame_age_ms < 1000`; `connection_state: "connected"`;
`frames.decoded_count >= 1`.

### 5. Simple HMR cycle (file edit through collab-server)

- Shell: `curl -X POST http://localhost:1234/files/write -d '{"sessionId":"'$SID'","path":"src/main.cpp","content":"...counter starts at 10..."}'`
- Agent: `synthi_wait({condition:"hmr",timeoutMs:60000})`.

**Pass:** returns `{status:"applied", elapsedMs < 60000, frame_gate:
{status:"satisfied"|"disabled"}}`. `frame_gate.status:"disabled"` is
acceptable until the worker emits `{type:"frame-advance"}` (task #41).

### 6. Screenshot after HMR

> Call `synthi_screenshot` again. Compare pHash distance vs step 3's
> screenshot — should be `> 4` (counter visibly changed).

**Pass:** the bytes differ. If running the golden-path from an agent,
ask it to describe what changed; the counter digit should match your
edit.

### 7. Click at raw coords

> Call `synthi_click({x: 540, y: 960})` (center of the 1080x1920 frame).

**Pass:** `{ok: true, dispatch_id: "..."}`. Event log gains an `input`
entry of `action:"mouse:click"`.

### 8. Type

> Call `synthi_type({text: "hello"})`.

**Pass:** `{ok: true}`. Event log gains five `key:down`+`key:up` pairs.
Keystroke cadence cap (500 keys/sec) is not triggered.

### 9. Locate (agent_side default, no API key)

> Call `synthi_locate({description: "the counter digit"})`. Report the
> response.

**Pass:** returns `{error: "agent_side_vision_required",
screenshot: "data:..."}` — the default path. Agent can then re-call
with `hints.prefer_region` after grounding on the screenshot.

### 10. Locate (server-side backend — optional)

Skip if neither `ANTHROPIC_API_KEY` nor `GEMINI_API_KEY` is set.

> Call `synthi_locate({description: "the counter digit",
> preferred_vision_backend: "claude_api"})`. Then again with
> `gemini_api`.

**Pass:** both return `{handle_id, bbox: {x,y,w,h}, region_phash,
resolved_via: "region_match"}`. Event log gains one `usage` event per
call with `{cost_usd > 0, input_tokens > 0}`. The `bbox` is within
frame (x+w ≤ 1080, y+h ≤ 1920).

### 11. Verify predicate

> Call `synthi_verify({predicate: {kind: "pixel", x: 10, y: 10,
> color: "#000000", tolerance: 32}})`.

**Pass:** returns `{ok: boolean, evidence: {kind:"pixel", ...}}` with
a concrete observed-color value regardless of ok/not-ok.

### 12. Event-log query

> Call `synthi_get_event_log({limit: 20})`. Report the kinds of the
> last 10 entries.

**Pass:** at least one of each of: `input`, `locator_resolution`
(if step 10 ran), `hmr`, `lifecycle`. Monotonic `seq` field increasing
by 1.

### 13. Source-state introspection

> Call `synthi_get_source_state`.

**Pass:** returns `{last_mtime?, last_changed_files: [...],
content_hash?}`. If step 5's edit went through `synthi_compile`,
`last_changed_files` includes the edited path. Otherwise it may be
empty — documented, not a bug.

### 14. Reconnect (induce transient drop)

- Shell: `docker-compose restart signaling-server` (introduces a ~5 s
  WS outage; the worker's PC ICE stays alive).
- Wait 10 s for reconnection.
- Agent: `synthi_reconnect`.

**Pass:** returns `{ok: true, preserved: {event_log: "kept",
subscriptions: "replayed"}}`. `synthi_screenshot` works again within
2 s of the reconnect response. If the signaling drop was longer than
the ICE restart window, the tool returns `session_terminated` — in
that case the next step is `synthi_attach` again, not a bug.

### 15. Clean detach

> Call `synthi_detach`.

**Pass:** returns `{ok: true, detached: true}`. Running any other tool
immediately after returns `not_attached`. Kill the client; confirm the
worker's peer slot is released (signaling-server log should show
`peer removed: browser / $SID`).

---

## Per-client quirks (as of 2026-04-18)

- **Claude Code:** auto-respawns the stdio subprocess on exit; the
  `session_terminated` → `synthi_attach` recovery flow (step 14) is
  smooth.
- **Codex CLI:** aborts long-running tool calls more aggressively.
  `synthi_wait({timeoutMs: 60000})` may see the abort arrive before
  the HMR resolves — re-run from step 5 if so.
- **Cursor:** caches tool results across turns. If you're iterating,
  clear the chat session between runs to avoid stale screenshots.
- **Gemini CLI:** stdio framing differs slightly; if a tool response
  gets truncated, `/refresh` the server and retry.
- **Windsurf:** smaller context window. The 23-tool list is within
  budget but prompt tax is higher than other clients.

---

## What this doc intentionally does NOT cover

- Chaos testing (packet drops, redis partition, pod relocation). Those
  are `Layer 4` per the ultraplan; hooks land in phase 1, full suite in
  phase 2.
- Performance regression thresholds (frame-age p95, locator p99,
  envelope bytes). Those land as the `H1` benchmark harness in phase 2.
- Per-vendor vision accuracy comparisons. Those are the E3 + E2b
  spike experiments in `tests/spike/`.
- Security fuzzing (adversarial fixture). Fixture builds out in the
  adversarial worker path; covered by the separate `prompt_injection`
  + `wm_class_spoof` integration tests once that fixture ships.

---

## Release gate

Before tagging a release:

- [ ] All 15 steps pass on Claude Code (CI enforces this automatically
      via `tests/e2e/claude_code_smoke.sh`).
- [ ] All 15 steps pass on Codex CLI, Cursor, Gemini CLI, Windsurf
      (manual; record timings + any quirks in the PR description).
- [ ] `npm run typecheck` clean.
- [ ] `npm test` — full unit + integration suite green.
- [ ] `mcp/synthi-mcp/README.md` reflects any new env vars / tool
      descriptions.

If any manual-client step fails in a way that doesn't reproduce on
Claude Code, open a ticket tagged `J1-candidate` — that client likely
needs a harness retrofit before we can promote it to automated.
