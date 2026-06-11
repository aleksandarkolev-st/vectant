# Phase 2 — Uniform Docker-Capable Terminal (Terminal-in-Runtime-Container)

**Date:** 2026-06-11
**Status:** Approved design, pending implementation plan
**Predecessor:** [Native Docker Execution Phase 1](2026-06-02-native-docker-execution-phase1-design.md) (hybrid: only `container` programs run in the per-workspace runtime container)
**Flag:** `ENABLE_CONTAINER_RUNTIME` (existing) — Phase 2 is fully dark when off.

## Problem

Today the interactive terminal's PTY is spawned **in the shared `collab-server`**, so:

1. `docker` / `docker compose` typed in the terminal fail (`docker: command not found`) — there is no Docker engine in collab-server, and giving one to the shared multi-tenant server is unsafe.
2. A terminal-launched dev server (`npm run dev`) binds inside collab-server and is forwarded only via the global `/port/<N>/` proxy, which is not per-workspace and lacks the COEP headers the App-tab iframe needs.

Phase 1 already gives each workspace an isolated **rootless Docker runtime container** (`vectant-runtime`) that `container`-type programs run in, with `/wsport/<slug>/<port>/` forwarding (COEP-correct). Phase 2 brings the **terminal** into that same model so Docker "just works" in every terminal and terminal-launched servers forward the same way programs do.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Which terminals run in the runtime container | **Uniform** — every interactive terminal, when the flag is on |
| 2 | Runtime-container cold start (~15–25s for rootless dockerd) | **Pre-warm on workspace open** |
| 3 | Terminal environment | **Full parity** — enrich `vectant-runtime` so nothing regresses + docker works |
| 4 | Terminal-launched server ports | **In-scope** — detect inside the container, forward via `/wsport` + Ports panel |

## Architecture

When `ENABLE_CONTAINER_RUNTIME=1`:

- The workspace's runtime container (`workspace-runtime-<slug>-<user>`, per `workspaceRuntimeContainer.js`) is **pre-warmed when the workspace opens**.
- Each interactive terminal is a **dockerode TTY exec** running `bash -l` inside the runtime container (revised from the original "node-pty spawns docker exec": collab-server has no docker CLI and manages containers via the Docker socket already; `execInRuntime` already returns a PTY-shaped handle). Reuses the permissioned socket path with no new dependency on the shared collab-server image.
- A per-workspace **port monitor** polls listening TCP ports inside the runtime container and surfaces them through the existing `/wsport` proxy and the Ports panel.

When the flag is off, terminals spawn a host shell in collab-server exactly as today (zero behavior change — merge-dark).

## Components

### 1. Runtime image enrichment — `backend/runtime-image/Dockerfile`

Full env parity with what the collab-server terminal has today. Add to `vectant-runtime`:

- **Claude Code CLI** — `npm i -g @anthropic-ai/claude-code` (same install collab-server uses), so `claude` works in the terminal.
- **sudo** — install `sudo`, grant the `rootless` user passwordless sudo (matches the `synthi` user's ad-hoc-install capability today).
- **git identity / config** — replicate collab-server's git setup: `GIT_CONFIG_GLOBAL` with the autocommit `user.name` / `user.email`, plus `NPM_CONFIG_USERCONFIG` / `CLAUDE_CONFIG_DIR` / `HOME` pointed at a writable per-container location.
- Keep the existing Phase-1 pin/gating; node/python/git/lazygit/curl/bash/http-server already present.

The login shell (`bash -l`) sources these so the terminal env matches collab-server. Image-size growth is accepted (decision 3).

### 2. Terminal routing — `workspaceRuntimeContainer.js` (new `execInteractiveShell`) + `terminalService.js` (WSS branch)

- **New `execInteractiveShell(slug, userId, { cols, rows })`** on the runtime manager: a dockerode exec with `Cmd: ['/bin/bash','-l']`, `User: 'rootless'`, `Tty: true`, `AttachStdin/Stdout/Stderr: true`, `WorkingDir: '/workspace'`, `Env: ['TERM=xterm-256color', …friendly PS1]`. Returns the same `onData`/`onExit`/`write`/`kill` handle `execInRuntime` returns, **plus `resize(cols, rows)`** (calls `exec.resize({ h: rows, w: cols })`), and performs an initial `resize` after `start`.
- **`terminalService.createTerminalWSS(deps)`** gains injected deps `{ enableContainerRuntime, workspaceRuntime, flushWorkspaceDocsToDisk }`. In the WSS connection handler, when `enableContainerRuntime && workspaceRuntime`: `ensureRuntimeContainer` → `waitForRuntimeReady` → `execInteractiveShell` and use that handle instead of `createPtyProcess`. The existing resize handler already calls `ptyProcess.resize(cols, rows)`, output forwarding/exit/close all consume the same handle shape unchanged.
- **Off (or no slug):** unchanged `createPtyProcess` host-shell path.

cwd is the container's `/workspace` (the named-volume subpath the runtime container already mounts), so terminal cwd == program cwd == editor working tree. `execInteractiveShell` is unit-tested against a fake dockerode (asserting Cmd/User/WorkingDir/Tty and that `resize` calls `exec.resize`).

### 3. Pre-warm lifecycle — `server.js` (+ tiny frontend hook)

- **Trigger:** the frontend pings a new `POST /program-runtime/<slug>/ensure-runtime` endpoint on workspace mount; the handler calls `ensureRuntimeContainer(slug, userId)` then kicks off `waitForRuntimeReady` in the background and returns immediately (202). Chosen over a notify-WS hook because it is explicit, carries the authenticated `userId` directly, and is trivially unit-testable. (If a workspace-mount notify-WS event already exists, the plan may reuse it instead — same `ensureRuntimeContainer` + background `waitForRuntimeReady` call — but the endpoint is the baseline.)
- Warming is fire-and-forget and idempotent (`ensureRuntimeContainer` already adopts a running/restarted container without a 409). Idle-cull (existing `shouldCull`) tears it down when unused.
- A terminal opened before warmup completes shows a brief `starting runtime…` line, then attaches.

### 4. File-sync for terminals

`flushWorkspaceDocsToDisk(slug, userId)` (committed in `f778d071`) runs when a terminal **session is created**, so `cat` / `git` / a build invoked in the terminal sees current editor content (including unsaved edits living in the yjsWsServer rooms). Reuses the existing flush; no new sync machinery.

### 5. Container port detection + forwarding — new `containerPortMonitor.js`

- Per active workspace runtime container, on an interval, `docker exec <rt> ss -ltn` (fallback `netstat`/`/proc/net/tcp`) → parse the set of listening TCP ports.
- Diff against the last-seen set; emit add/remove events attributed to `(slug, userId)`.
- Surface the live port set to the frontend through the **existing notify/ports channel** the Ports panel / App tab already consume, so detected ports render as clickable entries pointing at `/wsport/<slug>/<port>/` (proxy + COEP headers already implemented in `containerPortProxy.js`).
- The global localhost `/port/` scanner (`proxyService`) stays for the flag-off path; `containerPortMonitor` is the container-runtime equivalent and is gated identically.
- Module is pure/injectable (exec fn injected) so scan→diff→attribute is unit-testable with a fake exec, mirroring how `containerPortProxy` and `workspaceRuntimeContainer` are tested.

## Data flow

```
workspace open
  → ensure-runtime  → ensureRuntimeContainer + waitForRuntimeReady  (pre-warm)

open terminal
  → flushWorkspaceDocsToDisk(slug,user)                    (editor → disk)
  → docker exec -it -w /workspace <rt> bash -l   (PTY in the isolated rootless engine)
  → user runs `docker …` / `npm run dev`

server binds :PORT inside the runtime container
  → containerPortMonitor sees it (ss -ltn)
  → Ports panel shows PORT
  → click → /wsport/<slug>/<port>/  iframe  (COEP credentialless, CORP cross-origin)
```

## Error handling / lifecycle

- **Runtime not ready when terminal opens** → `starting runtime…`, retry `waitForRuntimeReady`, then attach. Hard failure after timeout → clear terminal error, session ends, reopening re-ensures.
- **Runtime container crash / cull** → the `docker exec` PTY exits; terminal shows a disconnect message; reopening re-ensures the container.
- **Port monitor exec failure** (container gone) → monitor stops for that workspace, clears its ports; no crash.
- **Flag off** → every path above reverts to today's collab-server terminal + global port proxy.

## Testing

**Unit (node:test, no daemon):**
- `execInteractiveShell` builds the right dockerode exec (`/bin/bash -l`, `User: rootless`, `WorkingDir: /workspace`, `Tty: true`) and `resize()` calls `exec.resize({h,w})` (fake dockerode); flag-off WSS still uses `createPtyProcess`.
- `containerPortMonitor` scan → diff → attribute with a fake exec returning sample `ss -ltn` output (add/remove/no-change cases; malformed output ignored).
- Env-scrub (`HOST_ENV_DENYLIST`) on the terminal path remains enforced.

**Integration (dev compose stack):**
- Terminal runs `docker run --rm hello-world` → succeeds inside the rootless engine.
- `npm run dev` in a terminal → its port appears in the Ports panel → `/wsport/<slug>/<port>/` serves it in the App tab (no COEP block).
- Editor has an unsaved edit → open terminal → `cat <file>` shows the edit (file-sync).

**No-regression:**
- Flag off → terminal behaves exactly as today (host shell, global `/port/` proxy); existing terminal tests green.

## Rollout

Single flag `ENABLE_CONTAINER_RUNTIME` gates terminal routing, pre-warm, and the port monitor together. Internal phasing for the implementation plan:

- **2a** — runtime image enrichment + terminal routing (`docker exec` PTY) + pre-warm + terminal file-sync flush. Delivers "docker works in every terminal" with full env parity.
- **2b** — `containerPortMonitor` + Ports-panel wiring. Delivers clickable previews for terminal-launched servers.

## Out of scope (YAGNI)

- Moving `web`/`cli`/`tui` **programs** into the runtime container (they remain collab-server PTYs from Phase 1; only the **terminal** moves here in Phase 2).
- Retiring the global `/port/` proxy (kept for the flag-off path).
- Multi-region / GPU / resource-quota tuning of the runtime container.
