# Phase 2a — Docker-Capable Terminal (Terminal-in-Runtime-Container) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `ENABLE_CONTAINER_RUNTIME=1`, every interactive terminal runs as a `bash -l` session inside the workspace's rootless-Docker runtime container — so `docker`/`docker compose` work in the terminal — with full environment parity (Claude Code CLI, git identity, sudo), pre-warmed on workspace open, and the editor's live content flushed to disk on terminal create.

**Architecture:** A new `execInteractiveShell()` on the runtime manager (`workspaceRuntimeContainer.js`) opens a dockerode TTY exec (`/bin/bash -l`, cwd `/workspace`) and returns the same PTY-shaped handle (`onData`/`onExit`/`write`/`kill`) the runtime manager already returns for programs, plus `resize()`. `terminalService.createTerminalWSS()` takes injected deps and, when the flag is on, routes terminal sessions through that handle instead of the host-shell `createPtyProcess`. A new `POST /program-runtime/:slug/ensure-runtime` endpoint pre-warms the container on workspace mount. The runtime image is enriched for env parity. All behind the existing flag — flag-off behavior is byte-for-byte unchanged (merge-dark).

**Tech Stack:** Node.js, dockerode (Docker socket), node-pty (flag-off path only), node:test, Docker (Alpine `apk` runtime image), docker-compose dev stack.

**Scope note:** This is **Phase 2a** of the [terminal-container-runtime spec](../specs/2026-06-11-terminal-container-runtime-design.md). Phase **2b** (detecting/forwarding terminal-launched server ports via a new `containerPortMonitor` + Ports-panel wiring) is a separate, independently-shippable subsystem and gets its own plan after 2a lands. 2a delivers working, testable software on its own: docker works in the terminal with full env parity.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `backend/collab-server/workspaceRuntimeContainer.js` | Runtime-container lifecycle + exec | **Modify** — add `execInteractiveShell()` |
| `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js` | Runtime-manager unit tests | **Modify** — add `execInteractiveShell` tests |
| `backend/collab-server/terminalService.js` | Terminal PTY ↔ WebSocket bridge | **Modify** — inject deps into `createTerminalWSS`, add container branch |
| `backend/collab-server/__tests__/terminalRouting.test.js` | Terminal container-routing unit test | **Create** |
| `backend/collab-server/server.js` | HTTP routes + service wiring | **Modify** — pass deps to `createTerminalWSS`; add `ensure-runtime` route |
| `backend/collab-server/__tests__/ensureRuntimeRoute.test.js` | Route handler unit test | **Create** |
| `backend/runtime-image/Dockerfile` | Per-workspace runtime image | **Modify** — env parity (Claude CLI, git, sudo, home, PS1) |
| `synthi/src/...` (workspace mount hook) | Frontend pre-warm ping | **Modify** — fire `ensure-runtime` on workspace open |

---

## Task 1: `execInteractiveShell()` on the runtime manager

**Files:**
- Modify: `backend/collab-server/workspaceRuntimeContainer.js` (add function inside `createRuntimeManager`, before the `return {...}` at line 270; add to the returned object)
- Test: `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js`

- [ ] **Step 1: Write the failing test**

Add to `__tests__/workspaceRuntimeContainer.test.js` (the existing `fakeDocker()` helper at the top of the file already supports `createContainer().exec()`; we extend it inline here to capture exec opts and expose `resize`):

```js
test('execInteractiveShell opens a bash -l TTY exec in /workspace as rootless and wires resize', async () => {
  let execOpts = null;
  let resizeArg = null;
  const docker = fakeDocker();
  const origCreate = docker.createContainer;
  docker.createContainer = async (o) => {
    const c = await origCreate(o);
    c.exec = async (opts) => {
      execOpts = opts;
      return {
        start: async () => ({ on: () => {}, write: () => {}, end: () => {} }),
        resize: async ({ h, w }) => { resizeArg = { h, w }; },
        inspect: async () => ({ ExitCode: 0 }),
      };
    };
    return c;
  };
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');

  const handle = await mgr.execInteractiveShell('repo', 'u1', { cols: 120, rows: 40 });

  // Interactive login shell, in the workspace, as the rootless user, with a TTY.
  assert.deepEqual(execOpts.Cmd, ['/bin/bash', '-l']);
  assert.equal(execOpts.WorkingDir, '/workspace');
  assert.equal(execOpts.User, 'rootless');
  assert.equal(execOpts.Tty, true);
  assert.equal(execOpts.AttachStdin, true);
  assert.ok(execOpts.Env.includes('TERM=xterm-256color'), 'TERM must be set for a real terminal');

  // PTY-shaped handle + resize.
  assert.equal(typeof handle.ptyProcess.onData, 'function');
  assert.equal(typeof handle.ptyProcess.onExit, 'function');
  assert.equal(typeof handle.ptyProcess.write, 'function');
  assert.equal(typeof handle.ptyProcess.kill, 'function');
  assert.equal(typeof handle.ptyProcess.resize, 'function');

  // Initial size is applied after start (h=rows, w=cols — Docker's resize order).
  assert.deepEqual(resizeArg, { h: 40, w: 120 });
  handle.ptyProcess.resize(80, 24);
  assert.deepEqual(resizeArg, { h: 24, w: 80 });
});

test('execInteractiveShell throws if the runtime container was not started', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await assert.rejects(() => mgr.execInteractiveShell('repo', 'u1', { cols: 80, rows: 24 }), /not started/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: FAIL — `mgr.execInteractiveShell is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `workspaceRuntimeContainer.js`, inside `createRuntimeManager`, add this function immediately after `execInRuntime` (after line 268, before `return {...}`). It mirrors `execInRuntime`'s handle construction but for an interactive login shell with resize:

```js
  /**
   * Open an interactive login shell (`bash -l`) inside the runtime container for
   * the in-app terminal. Unlike execInRuntime (which runs one program command),
   * this is a long-lived TTY the user drives directly, so it adds resize(). The
   * shell's environment (PATH, git identity, claude CLI, sudo) comes from the
   * runtime IMAGE via `bash -l`, not from collab-server's process — so there is
   * nothing host-leaked to scrub here; we only set TERM + a friendly PS1.
   * @returns {{ ptyProcess: {onData,onExit,write,kill,resize}, stop } }
   */
  async function execInteractiveShell(slug, userId, { cols = 80, rows = 24 } = {}) {
    const s = sessions.get(keyOf(slug, userId));
    if (!s) throw new Error('runtime container not started');
    s.lastActive = Date.now();

    // ~/<workspace> style prompt parity with the host-shell terminal. /workspace
    // is the mount target; show it as "~/workspace" so the path reads cleanly.
    const PS1 = String.raw`\[\e[36m\]~/workspace\[\e[0m\]$ `;
    const exec = await docker.getContainer(s.containerId).exec({
      Cmd: ['/bin/bash', '-l'],
      User: 'rootless',
      Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', `PS1=${PS1}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: '/workspace',
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    // Apply the initial terminal size once the exec is live. Docker's resize
    // API is { h: rows, w: cols }. Best-effort — a daemon hiccup here must not
    // kill the session.
    try { await exec.resize({ h: rows, w: cols }); } catch (_) {}

    const dataCbs = new Set();
    const exitCbs = new Set();
    stream.on('data', (chunk) => { for (const cb of dataCbs) cb(chunk.toString('utf8')); });
    stream.on('end', async () => {
      let exitCode = null;
      try { exitCode = (await exec.inspect()).ExitCode; } catch (_) {}
      for (const cb of exitCbs) cb({ exitCode });
    });

    const ptyProcess = {
      onData: (cb) => { dataCbs.add(cb); return { dispose: () => dataCbs.delete(cb) }; },
      onExit: (cb) => { exitCbs.add(cb); return { dispose: () => exitCbs.delete(cb) }; },
      write: (data) => { try { stream.write(data); } catch (_) {} },
      kill: () => { try { stream.end(); } catch (_) {} },
      resize: (c, r) => { exec.resize({ h: r, w: c }).catch(() => {}); },
    };
    return { ptyProcess, stop: () => ptyProcess.kill() };
  }
```

Then add `execInteractiveShell` to the returned object on line 270:

```js
  return { ensureRuntimeContainer, waitForRuntimeReady, touch, teardown, cullIdle, execInRuntime, execInteractiveShell, _sessions: sessions };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: PASS — all existing tests plus the two new ones.

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/workspaceRuntimeContainer.js backend/collab-server/__tests__/workspaceRuntimeContainer.test.js
git commit -m "feat(runtime): add execInteractiveShell (bash -l TTY exec with resize) for the in-container terminal"
```

---

## Task 2: Route the terminal WSS into the runtime container (flag-gated)

`createTerminalWSS()` currently takes no args and always uses `createPtyProcess` (host shell). We inject deps and add a container branch in the **new-session** path (the reattach/headless path at lines 1178–1279 is unchanged — those sessions already have a live `ptyProcess`).

**Files:**
- Modify: `backend/collab-server/terminalService.js` (`createTerminalWSS` signature line 1145; new-session spawn at lines 1281–1304; exports line 1441)
- Test: `backend/collab-server/__tests__/terminalRouting.test.js` (create)

- [ ] **Step 1: Write the failing test**

The container routing decision is a small pure helper we extract so it is testable without a live WebSocket. Create `__tests__/terminalRouting.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldUseContainerTerminal } = require('../terminalService');

test('shouldUseContainerTerminal requires the flag, a runtime manager, and a slug', () => {
  const rt = {};
  assert.equal(shouldUseContainerTerminal({ enableContainerRuntime: true, workspaceRuntime: rt, workspaceSlug: 'repo' }), true);
  // missing flag
  assert.equal(shouldUseContainerTerminal({ enableContainerRuntime: false, workspaceRuntime: rt, workspaceSlug: 'repo' }), false);
  // missing runtime manager (flag on but container runtime not constructed)
  assert.equal(shouldUseContainerTerminal({ enableContainerRuntime: true, workspaceRuntime: null, workspaceSlug: 'repo' }), false);
  // missing slug (can't resolve a per-workspace container)
  assert.equal(shouldUseContainerTerminal({ enableContainerRuntime: true, workspaceRuntime: rt, workspaceSlug: '' }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/collab-server && node --test __tests__/terminalRouting.test.js`
Expected: FAIL — `shouldUseContainerTerminal is not a function`.

- [ ] **Step 3: Write minimal implementation**

(3a) Add the pure helper near the top of `terminalService.js` (after the `activeSessions` declaration around line 65):

```js
/**
 * Decide whether a terminal session should run inside the per-workspace runtime
 * container (Phase 2a) vs the local host shell. Requires the flag, a constructed
 * runtime manager, and a slug to key the container on. Pure for testability.
 */
function shouldUseContainerTerminal({ enableContainerRuntime, workspaceRuntime, workspaceSlug }) {
  return Boolean(enableContainerRuntime && workspaceRuntime && workspaceSlug);
}
```

(3b) Change the WSS factory to accept injected deps. Replace the signature at line 1145:

```js
function createTerminalWSS({ enableContainerRuntime = false, workspaceRuntime = null, flushWorkspaceDocsToDisk = null } = {}) {
```

(3c) In the **new-session** path, replace the spawn block at lines 1288–1304 (`// ── Spawn PTY ──` through its `catch`) with a branch. The container branch flushes editor docs, ensures+waits for the runtime, opens the interactive shell, and adapts the handle; the else branch is the original `createPtyProcess` call verbatim:

```js
    // ── Spawn PTY (host shell) or attach an in-container shell ───────────
    let ptyProcess, shell;
    if (shouldUseContainerTerminal({ enableContainerRuntime, workspaceRuntime, workspaceSlug })) {
      try {
        // Editor edits live in the yjsWsServer rooms until saved; flush them to
        // disk so `cat`/`git`/builds in this terminal see current content.
        if (flushWorkspaceDocsToDisk) {
          await flushWorkspaceDocsToDisk(workspaceSlug, requestedUserId).catch(() => {});
        }
        ws.send(JSON.stringify({ type: 'status', message: 'starting runtime…' }));
        await workspaceRuntime.ensureRuntimeContainer(workspaceSlug, requestedUserId);
        await workspaceRuntime.waitForRuntimeReady(workspaceSlug, requestedUserId);
        const handle = await workspaceRuntime.execInteractiveShell(workspaceSlug, requestedUserId, {
          cols: initialCols, rows: initialRows,
        });
        ptyProcess = handle.ptyProcess;
        shell = 'bash';
      } catch (err) {
        console.error(`[Terminal] container shell failed for session ${sessionId}:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to start container terminal: ' + err.message }));
        ws.close(1011, 'container shell failed');
        return;
      }
    } else {
      try {
        ({ ptyProcess, shell } = createPtyProcess({
          cwd,
          cols: initialCols,
          rows: initialRows,
          shellType: requestedShellType,
          workspaceName,
          workspaceSlug,
        }));
      } catch (err) {
        console.error(`[Terminal] Failed to spawn PTY for session ${sessionId}:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to spawn shell: ' + err.message }));
        ws.close(1011, 'PTY spawn failed');
        return;
      }
    }
```

The container `ptyProcess` exposes `onData`/`onExit`/`write`/`resize`/`kill` (Task 1), so the downstream code (lines 1306–1344+: fs-watch, `activeSessions.set`, `ready`, `onData`, `onExit`, resize handler) consumes it unchanged. `kill` (not `destroy`) matches what the `ws.on('close')` handlers already call.

(3d) Export the helper. In the exports object (line 1441 area), add `shouldUseContainerTerminal`:

```js
  createTerminalWSS,
  shouldUseContainerTerminal,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/collab-server && node --test __tests__/terminalRouting.test.js __tests__/workspaceRuntimeContainer.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/terminalService.js backend/collab-server/__tests__/terminalRouting.test.js
git commit -m "feat(terminal): route terminals into the runtime container when ENABLE_CONTAINER_RUNTIME=1"
```

---

## Task 3: Wire deps into `createTerminalWSS` from server.js

`server.js` already builds `workspaceRuntime` (line 114), reads `ENABLE_CONTAINER_RUNTIME` (line 113), and defines `flushWorkspaceDocsToDisk` (committed in `f778d071`). It calls `createTerminalWSS()` with no args at line 4144. Pass the deps through.

**Files:**
- Modify: `backend/collab-server/server.js:4144`

- [ ] **Step 1: Make the change**

Replace line 4144:

```js
const terminalWss = createTerminalWSS();
```

with:

```js
const terminalWss = createTerminalWSS({
  enableContainerRuntime: ENABLE_CONTAINER_RUNTIME,
  workspaceRuntime,
  flushWorkspaceDocsToDisk,
});
```

- [ ] **Step 2: Verify it loads (syntax + module wiring)**

Run: `cd backend/collab-server && node --check server.js && echo "server.js OK"`
Expected: `server.js OK`.

- [ ] **Step 3: Verify flag-off is unchanged**

Run: `cd backend/collab-server && node --test __tests__/terminalRouting.test.js`
Expected: PASS — `shouldUseContainerTerminal(... enableContainerRuntime:false ...)` is `false`, so with the flag unset the WSS still uses `createPtyProcess`.

- [ ] **Step 4: Commit**

```bash
git add backend/collab-server/server.js
git commit -m "feat(terminal): inject container-runtime + doc-flush deps into the terminal WSS"
```

---

## Task 4: `POST /program-runtime/:slug/ensure-runtime` pre-warm endpoint

Pre-warm the runtime container when the workspace opens so the first terminal doesn't eat the full cold start. The handler kicks off ensure + readiness in the background and returns `202` immediately.

**Files:**
- Modify: `backend/collab-server/server.js` (add a route alongside the other `program-runtime` routes; `launch-program` is at line 1690 — add after it. Extract the body parse + handler into a small testable function near `flushWorkspaceDocsToDisk`.)
- Test: `backend/collab-server/__tests__/ensureRuntimeRoute.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `__tests__/ensureRuntimeRoute.test.js`. We test the extracted handler (pure-ish: it takes the runtime manager + slug/userId and triggers a background warm), not the HTTP plumbing:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { handleEnsureRuntime } = require('../ensureRuntime');

function fakeRuntime() {
  const calls = { ensure: [], wait: [] };
  return {
    calls,
    ensureRuntimeContainer: async (slug, userId) => { calls.ensure.push([slug, userId]); },
    waitForRuntimeReady: async (slug, userId) => { calls.wait.push([slug, userId]); return true; },
  };
}

test('handleEnsureRuntime triggers ensure + background readiness and returns warming', async () => {
  const rt = fakeRuntime();
  const res = await handleEnsureRuntime({ workspaceRuntime: rt, slug: 'repo', userId: 'u1' });
  assert.equal(res.status, 202);
  assert.equal(res.body.warming, true);
  assert.deepEqual(rt.calls.ensure[0], ['repo', 'u1']);
  // readiness is awaited in the background; give the microtask queue a tick
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(rt.calls.wait[0], ['repo', 'u1']);
});

test('handleEnsureRuntime is a no-op (200) when container runtime is disabled', async () => {
  const res = await handleEnsureRuntime({ workspaceRuntime: null, slug: 'repo', userId: 'u1' });
  assert.equal(res.status, 200);
  assert.equal(res.body.enabled, false);
});

test('handleEnsureRuntime 400s on a missing slug', async () => {
  const rt = fakeRuntime();
  const res = await handleEnsureRuntime({ workspaceRuntime: rt, slug: '', userId: 'u1' });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/collab-server && node --test __tests__/ensureRuntimeRoute.test.js`
Expected: FAIL — `Cannot find module '../ensureRuntime'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/collab-server/ensureRuntime.js`:

```js
'use strict';

/**
 * Pre-warm a workspace's runtime container. Called by the frontend on workspace
 * mount so the first terminal doesn't eat the ~15-25s rootless-dockerd cold
 * start. Fire-and-forget: ensure the container, then warm the daemon in the
 * BACKGROUND (don't make the HTTP request hang for 25s). Idempotent — ensure
 * adopts an already-running container.
 *
 * @returns {Promise<{status:number, body:object}>}
 */
async function handleEnsureRuntime({ workspaceRuntime, slug, userId }) {
  if (!workspaceRuntime) return { status: 200, body: { enabled: false } };
  if (!slug) return { status: 400, body: { error: 'missing slug' } };
  await workspaceRuntime.ensureRuntimeContainer(slug, userId || '');
  // Warm the daemon in the background; the terminal path also waits for ready,
  // so a slow warm here just means the first terminal shows "starting runtime…".
  workspaceRuntime.waitForRuntimeReady(slug, userId || '').catch(() => {});
  return { status: 202, body: { warming: true } };
}

module.exports = { handleEnsureRuntime };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/collab-server && node --test __tests__/ensureRuntimeRoute.test.js`
Expected: PASS.

- [ ] **Step 5: Wire the route into server.js**

(5a) Add the require near the other collab-server requires (top of `server.js`, by line 14):

```js
const { handleEnsureRuntime } = require('./ensureRuntime');
```

(5b) Add the route immediately after the `launch-program` handler block (after line ~1731). Match the existing `programRuntimeMatch`/`launchProgramMatch` style — parse slug from the URL and `userId` from the JSON body:

```js
  // POST /program-runtime/:slug/ensure-runtime  { userId? }  → pre-warm container
  const ensureRuntimeMatch = /^\/program-runtime\/([^/]+)\/ensure-runtime$/.exec(programRuntimeUrl.pathname);
  if (ensureRuntimeMatch && req.method === 'POST') {
    const slug = decodeURIComponent(ensureRuntimeMatch[1]);
    let body = {};
    try { body = await readJsonBody(req); } catch (_) { body = {}; }
    try {
      const { status, body: out } = await handleEnsureRuntime({
        workspaceRuntime, slug, userId: body.userId || '',
      });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      logger.warn('ensure_runtime_failed', { slug }, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ensure_runtime_failed' }));
    }
    return;
  }
```

NOTE for the implementer: confirm the JSON-body helper name actually used by the nearby `launch-program` handler (search `readJsonBody`/`parseJsonBody`/`readBody` around lines 1690–1731) and reuse that exact name; the `programRuntimeUrl` variable is already in scope (used by `launchProgramMatch`).

- [ ] **Step 6: Verify wiring**

Run: `cd backend/collab-server && node --check server.js && node --test __tests__/ensureRuntimeRoute.test.js`
Expected: `server.js` parses; tests PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/collab-server/ensureRuntime.js backend/collab-server/__tests__/ensureRuntimeRoute.test.js backend/collab-server/server.js
git commit -m "feat(runtime): add POST /program-runtime/:slug/ensure-runtime pre-warm endpoint"
```

---

## Task 5: Frontend pre-warm ping on workspace mount

Fire the `ensure-runtime` endpoint once when the workspace opens. Fire-and-forget; failure is non-fatal (terminal path re-ensures).

**Files:**
- Modify: the workspace mount/load module in `synthi/src/` (the implementer locates the existing workspace-open effect; see Step 1).

- [ ] **Step 1: Locate the workspace-open hook and the collab-server base URL**

Run (from repo root):
```bash
grep -rn "program-runtime/.*launch-program\|/program-runtime/\|COLLAB_SERVER_URL\|collabBaseUrl\|localhost:1234" synthi/src | head -20
```
Use the same base-URL constant and the same `userId` source the existing `launch-program` client call uses. Identify the workspace page mount effect (e.g. `synthi/src/app/workspace/[slug]/…`) where the slug is known.

- [ ] **Step 2: Add the pre-warm call**

In the workspace-open effect, after the slug + userId are known, add a one-shot fetch (adapt the base URL / userId accessor to whatever Step 1 found — do NOT invent a new config):

```js
// Pre-warm the per-workspace runtime container so the first terminal doesn't
// wait out the rootless-dockerd cold start. Fire-and-forget; the terminal path
// re-ensures, so a failure here is non-fatal.
useEffect(() => {
  if (!slug) return;
  fetch(`${COLLAB_BASE_URL}/program-runtime/${encodeURIComponent(slug)}/ensure-runtime`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  }).catch(() => {});
}, [slug, userId]);
```

- [ ] **Step 3: Verify it builds**

Run: `cd synthi && npm run lint -- --max-warnings=0 2>&1 | tail -5` (or the project's configured lint/build check). If the repo has no lint script, run `cd synthi && npx next build 2>&1 | tail -15` and confirm no error in the changed file.
Expected: no errors introduced by the change.

- [ ] **Step 4: Commit**

```bash
git add synthi/src
git commit -m "feat(workspace): pre-warm the runtime container on workspace open"
```

---

## Task 6: Runtime image env parity (Claude Code CLI, git, sudo, home, PS1)

Enrich `vectant-runtime` so the in-container terminal matches the collab-server terminal's tooling, plus docker. Alpine base → `apk`; rootless user is `rootless` (UID 1000).

**Files:**
- Modify: `backend/runtime-image/Dockerfile`

- [ ] **Step 1: Add the env-parity layers**

Insert the following **after** the existing `npm install -g http-server` line (line 33) and **before** the `ENV DOCKER_HOST=...` line (line 37), while still `USER root`:

```dockerfile
# ── Terminal env parity (Phase 2a) ───────────────────────────────────────────
# The in-app terminal runs as `bash -l` inside this container, so it must match
# the collab-server terminal's tooling.

# Claude Code CLI — exposed in the terminal (lands in /usr/local/bin, on PATH).
RUN npm install -g @anthropic-ai/claude-code

# sudo for ad-hoc installs from the terminal, passwordless for the rootless user
# (this container is the user's own isolated sandbox).
RUN apk add --no-cache sudo \
 && echo 'rootless ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/rootless \
 && chmod 0440 /etc/sudoers.d/rootless

# Git identity (system-level so it applies regardless of HOME), matching the
# collab-server autocommit identity.
RUN git config --system user.email "synthi@overview-synti.com" \
 && git config --system user.name "Synthi Autocommit"

# Ensure the rootless user has a writable HOME for git/npm/claude config, and a
# friendly login-shell prompt so the terminal reads "~/workspace $".
RUN mkdir -p /home/rootless \
 && chown -R rootless:rootless /home/rootless \
 && printf 'export PS1="\\[\\e[36m\\]~/workspace\\[\\e[0m\\]\\$ "\n' > /etc/profile.d/00-vectant-prompt.sh
ENV HOME=/home/rootless
```

- [ ] **Step 2: Build the image**

Run: `D:\Docker\DockerDesktop\resources\bin\docker.exe build -t vectant-runtime:local backend/runtime-image`
Expected: build succeeds; final lines show the image tagged `vectant-runtime:local`.

- [ ] **Step 3: Verify the tools landed (smoke test)**

Run:
```bash
D:\Docker\DockerDesktop\resources\bin\docker.exe run --rm --entrypoint sh vectant-runtime:local -lc "which docker claude git sudo bash node && git config --system user.name"
```
Expected: paths printed for `docker`, `claude`, `git`, `sudo`, `bash`, `node`, and `Synthi Autocommit`.

- [ ] **Step 4: Commit**

```bash
git add backend/runtime-image/Dockerfile
git commit -m "feat(runtime-image): env parity for the in-container terminal (claude CLI, git, sudo, home, prompt)"
```

---

## Task 7: End-to-end live verification (dev compose stack)

Prove the feature works against the running stack. `ENABLE_CONTAINER_RUNTIME=1` must be set for collab-server (confirm it is in `docker-compose.yml`; Phase 1 set it).

**Files:** none (verification only).

- [ ] **Step 1: Rebuild + restart collab-server with the new code**

Run:
```bash
D:\Docker\DockerDesktop\resources\bin\docker.exe compose -f docker-compose.yml build collab-server
D:\Docker\DockerDesktop\resources\bin\docker.exe compose -f docker-compose.yml up -d collab-server
```
Expected: collab-server rebuilds and restarts cleanly.

- [ ] **Step 2: Confirm the runtime image is current**

Already built in Task 6 Step 2. If collab-server pulls/builds its own copy, ensure `vectant-runtime:local` is the freshly built tag (Task 6).

- [ ] **Step 3: Pre-warm endpoint smoke test**

Run (replace `<slug>`/`<userId>` with a real workspace, e.g. the test workspace `n964u0lg` / `242593757`):
```bash
node -e "const http=require('http');const d=JSON.stringify({userId:'242593757'});const r=http.request('http://127.0.0.1:1234/program-runtime/n964u0lg/ensure-runtime',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':d.length}},x=>{let b='';x.on('data',c=>b+=c);x.on('end',()=>console.log(x.statusCode,b));});r.write(d);r.end();"
```
Expected: `202 {"warming":true}`.

- [ ] **Step 4: Browser — open a terminal and run docker**

Open `http://localhost:3000/workspace/n964u0lg`, open a terminal, and run:
```
docker run --rm hello-world
```
Expected: the terminal shows the "Hello from Docker!" message (the rootless engine inside the runtime container ran it). Also run `claude --version`, `git config user.name`, and `sudo whoami` to confirm env parity (`root` from sudo).

- [ ] **Step 5: File-sync in the terminal**

In the editor, type into a file (e.g. `notes.txt`) WITHOUT saving. Open a new terminal and `cat notes.txt`.
Expected: the terminal shows the unsaved editor content (the create-time flush wrote it to disk).

- [ ] **Step 6: Record results**

Append a short verification note (commands run + observed output) to `tasks/todo.md` under a "Phase 2a verification" heading and commit:

```bash
git add tasks/todo.md
git commit -m "docs: Phase 2a terminal-in-container live verification results"
```

---

## Self-Review

**Spec coverage:**
- Runtime image enrichment (spec §1) → Task 6. ✓
- Terminal routing via dockerode interactive exec (spec §2) → Tasks 1–3. ✓
- Pre-warm on workspace open (spec §3) → Tasks 4–5. ✓
- File-sync for terminals (spec §4) → Task 2 Step 3c (flush call). ✓
- Port detection/forwarding (spec §5) → **Phase 2b, separate plan** (documented in Scope note). ✓ (intentionally deferred)
- Error handling: "starting runtime…" status + clear failure close (Task 2); pre-warm non-fatal (Tasks 4–5). ✓
- Testing: unit (Tasks 1,2,4) + live integration (Task 7) + flag-off no-regression (Task 3 Step 3). ✓

**Placeholder scan:** Task 5 (frontend) intentionally defers exact base-URL/userId accessors to a `grep` discovery step rather than inventing config — this is a directed lookup with a concrete command, not a placeholder. Task 4 Step 5b flags confirming the JSON-body helper name — also a directed lookup. All code steps contain real code.

**Type/name consistency:** `execInteractiveShell(slug, userId, {cols,rows})` returns `{ ptyProcess: {onData,onExit,write,kill,resize}, stop }` — consumed in Task 2 as `handle.ptyProcess`; `resize(cols,rows)` maps to `exec.resize({h:rows,w:cols})` consistently (Tasks 1 & 2). `shouldUseContainerTerminal` signature identical in test (Task 2 Step 1) and impl (Step 3a). `handleEnsureRuntime({workspaceRuntime,slug,userId})` identical across test (Task 4 Step 1) and impl (Step 3). Container handle uses `kill` (not `destroy`), matching `ws.on('close')` handlers in terminalService.

---

## Verification Results (2026-06-11)

All 7 tasks implemented and committed (`7a9c02c2`, `fa303b95`, `4d45b631`, `fc884a1a`, `c788785c`, `8396f2a5`, + this doc).

**Unit tests — 19/19 pass** (`node --test` on the three suites):
- `workspaceRuntimeContainer.test.js` (15) — incl. `execInteractiveShell` bash -l / rootless / `/workspace` / TTY / resize-order, and not-started guard.
- `terminalRouting.test.js` (1) — `shouldUseContainerTerminal` gating (flag + manager + slug).
- `ensureRuntimeRoute.test.js` (3) — 202 warming + background readiness, 200 disabled no-op, 400 missing slug.

**Runtime image** built `vectant-runtime:local` (576MB→897MB). `claude-code` npm install = 23s (no hang — the earlier multi-hour stall was two concurrent builds saturating the daemon + a session reload orphaning the tracked tasks, not a real build hang). Smoke test: `docker`,`claude`(2.1.173),`git`,`sudo`,`bash`,`node`,`npm` all present; `git config --system user.name`→`Synthi Autocommit`; `sudo whoami`→`root`; `HOME=/home/rootless`; prompt file installed.

**Live (dev compose, `ENABLE_CONTAINER_RUNTIME=1`, collab-server rebuilt):**
- `POST /program-runtime/0naokfjy/ensure-runtime` → `202 {"warming":true}`; runtime container `workspace-runtime-0naokfjy-242593757` created.
- Terminal WSS (driven by a WS client exactly like the frontend): `status: starting runtime…` → `ready` → ran `docker run --rm hello-world` → **"Hello from Docker!"** (rootless daemon inside the runtime container). Prompt rendered `~/workspace$` (env-parity PS1).
- Same terminal: `claude --version`→`2.1.173`, `git config user.name`→`Synthi Autocommit`, `sudo whoami`→`root`, `pwd`→`/workspace`.
- `ls /workspace` shows the real working tree (`.git`, `cpp`, `pom.xml`, `src`) == per-user repo `/data/repos/0naokfjy/242593757` (terminal cwd == editor tree). Create-time `flushWorkspaceDocsToDisk` ran with no errors in collab logs (no `container shell failed`, no exceptions).

**Caveat (honest):** the literal "type unsaved text in the editor → `cat` in terminal" round-trip needs a live Yjs editing client and was not exercised end-to-end in a browser. The create-time flush call is wired (Task 2) and runs without error; the flush itself reuses the pre-existing, already-tested `flushWorkspaceDocsToDisk` used by the program-launch path.

**No-regression:** flag-off path unchanged — `shouldUseContainerTerminal` returns false without the flag, so the WSS still uses `createPtyProcess`; unit test asserts this.
