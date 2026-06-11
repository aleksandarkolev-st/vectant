# Phase 2b — Terminal-Launched Server Port Forwarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `ENABLE_CONTAINER_RUNTIME=1`, detect TCP ports that servers (e.g. `npm run dev`) open **inside** a workspace's runtime container, push the live port set to the frontend, and surface them in a new standalone **Ports** docking panel where each port opens at `/wsport/<slug>/<port>/`.

**Architecture:** A backend `containerPortMonitor` polls each active runtime container by reading `/proc/net/tcp[6]` (dependency-free — Alpine has no `iproute2`/`ss`) via a new one-shot `runOnce()` exec on the runtime manager, diffs the listening-port set, and on change calls `broadcastContainerPorts(slug, ports)` which pushes a `container-ports` message over the existing per-slug `notifyWss`. The frontend's `collabClient` notify handler dispatches the ports into a new `portsSlice`; a new `PortsPanel` (registered in the docking-wm like the Connected Tools panel) renders them, each opening `getProgramSessionAppUrl(port, { slug, runtimeType: 'container' })` (the existing `/wsport` URL). All flag-gated and DB-independent (rides `notifyWss`, not Prisma).

**Tech Stack:** Node.js, dockerode (Docker socket), node:test, Next.js/React, Redux Toolkit, the docking-wm panel system.

**Scope note:** This is **Phase 2b** of the [terminal-container-runtime spec](../specs/2026-06-11-terminal-container-runtime-design.md) §5. Phase **2a** (terminal-in-container) is already merged. 2b is independently shippable and verifiable even while the frontend's remote DB is unreachable, because the whole path is `notifyWss → Redux → panel` with no database dependency.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `backend/collab-server/workspaceRuntimeContainer.js` | Runtime-container lifecycle + exec | **Modify** — add one-shot `runOnce()` |
| `backend/collab-server/containerPortMonitor.js` | Poll containers, parse `/proc/net/tcp`, diff, emit | **Create** |
| `backend/collab-server/__tests__/containerPortMonitor.test.js` | Parser + diff unit tests | **Create** |
| `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js` | `runOnce` unit test | **Modify** |
| `backend/collab-server/server.js` | `broadcastContainerPorts` + monitor wiring/start | **Modify** |
| `synthi/src/redux/portsSlice.js` | `containerPorts` state | **Create** |
| `synthi/src/redux/store.js` | Register `ports` reducer | **Modify** |
| `synthi/src/services/collabClient.js` | Dispatch `container-ports` notify msg | **Modify** |
| `synthi/src/app/workspace/[slug]/page.jsx` | Wire `onContainerPorts` → dispatch | **Modify** |
| `synthi/src/components/ports/PortsPanel.jsx` | The Ports panel UI | **Create** |
| `synthi/src/components/docking-wm/panels/panel-types.js` | `PORTS` panel-type | **Modify** |
| `synthi/src/components/docking-wm/panels/panel-wrappers.jsx` | `PortsPanelWrapper` + dynamic import | **Modify** |
| `synthi/src/components/docking-wm/panels/ide-panels.js` | Register Ports panel definition | **Modify** |
| `synthi/src/components/docking-wm/components/DockingActivityBar.jsx` | Activity-bar entry + SIDEBAR_PANELS | **Modify** |
| `synthi/src/components/docking-wm/hooks/use-activity-bar-docking.js` | Toggle handler | **Modify** |

---

# SLICE 2b-1 — Backend port detection + push

## Task 1: One-shot `runOnce()` exec on the runtime manager

`execInRuntime` returns a streaming PTY-shaped handle (good for programs/terminals), but the monitor needs a single command's stdout. Add `runOnce`.

**Files:**
- Modify: `backend/collab-server/workspaceRuntimeContainer.js` (add after `execInRuntime`, ~line 268; export it in the returned object ~line 270)
- Test: `backend/collab-server/__tests__/workspaceRuntimeContainer.test.js`

- [ ] **Step 1: Write the failing test**

Append to `__tests__/workspaceRuntimeContainer.test.js` (uses the existing `fakeDocker()` helper; extend the created container's `exec` to stream stdout then end):

```js
test('runOnce execs argv and resolves the collected stdout', async () => {
  let execOpts = null;
  const docker = fakeDocker();
  const origCreate = docker.createContainer;
  docker.createContainer = async (o) => {
    const c = await origCreate(o);
    c.exec = async (opts) => {
      execOpts = opts;
      return {
        start: async () => {
          // Minimal duplex-ish stream: fire data then end on next tick.
          const handlers = {};
          const stream = { on: (ev, cb) => { handlers[ev] = cb; return stream; } };
          setImmediate(() => {
            handlers.data && handlers.data(Buffer.from('hello-stdout'));
            handlers.end && handlers.end();
          });
          return stream;
        },
        inspect: async () => ({ ExitCode: 0 }),
      };
    };
    return c;
  };
  const mgr = createRuntimeManager({ docker });
  await mgr.ensureRuntimeContainer('repo', 'u1');

  const out = await mgr.runOnce('repo', 'u1', ['/bin/sh', '-lc', 'cat /proc/net/tcp']);
  assert.equal(execOpts.Cmd[0], '/bin/sh');
  assert.equal(execOpts.AttachStdout, true);
  assert.equal(execOpts.Tty, false);
  assert.equal(out, 'hello-stdout');
});

test('runOnce throws if the runtime container was not started', async () => {
  const docker = fakeDocker();
  const mgr = createRuntimeManager({ docker });
  await assert.rejects(() => mgr.runOnce('repo', 'u1', ['/bin/sh', '-lc', 'true']), /not started/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: FAIL — `mgr.runOnce is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `workspaceRuntimeContainer.js`, add immediately after `execInteractiveShell` (before `return {...}`):

```js
  /**
   * Run a single command in the runtime container and resolve its collected
   * stdout+stderr as a string. Non-TTY (so the dockerode stream is the raw,
   * un-multiplexed-enough output we just concatenate — adequate for parsing
   * /proc/net/tcp). Used by the container port monitor. Best-effort: resolves
   * '' on stream error so a transient daemon hiccup doesn't reject the poll.
   */
  async function runOnce(slug, userId, argv) {
    const s = sessions.get(keyOf(slug, userId));
    if (!s) throw new Error('runtime container not started');
    s.lastActive = Date.now();
    const exec = await docker.getContainer(s.containerId).exec({
      Cmd: argv,
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    const stream = await exec.start({});
    return await new Promise((resolve) => {
      let buf = '';
      if (stream && typeof stream.on === 'function') {
        stream.on('data', (chunk) => { buf += chunk.toString('utf8'); });
        stream.on('end', () => resolve(buf));
        stream.on('error', () => resolve(buf));
      } else {
        resolve('');
      }
    });
  }
```

Add `runOnce` to the returned object:

```js
  return { ensureRuntimeContainer, waitForRuntimeReady, touch, teardown, cullIdle, execInRuntime, execInteractiveShell, runOnce, _sessions: sessions };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/collab-server && node --test __tests__/workspaceRuntimeContainer.test.js`
Expected: PASS (all prior tests + the 2 new).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/workspaceRuntimeContainer.js backend/collab-server/__tests__/workspaceRuntimeContainer.test.js
git commit -m "feat(runtime): add runOnce() one-shot exec on the runtime manager"
```

---

## Task 2: `containerPortMonitor` — parse `/proc/net/tcp`, diff, emit

**Files:**
- Create: `backend/collab-server/containerPortMonitor.js`
- Test: `backend/collab-server/__tests__/containerPortMonitor.test.js`

- [ ] **Step 1: Write the failing test**

Create `__tests__/containerPortMonitor.test.js`. Sample `/proc/net/tcp` rows: a LISTEN (`st=0A`) on `0.0.0.0:0BB8` (port 3000, forwardable), a LISTEN on `0100007F:1F90` (127.0.0.1:8080, loopback → excluded), and an ESTABLISHED (`st=01`) row (excluded):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseListeningPorts, createContainerPortMonitor } = require('../containerPortMonitor');

const PROC_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid',
  '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000',  // 0.0.0.0:3000 LISTEN
  '   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000',  // 127.0.0.1:8080 LISTEN (loopback)
  '   2: 00000000:1538 0A0B0C0D:D903 01 00000000:00000000 00:00000000 00000000  1000',  // ESTABLISHED (not LISTEN)
].join('\n');

const PROC_TCP6 = [
  '  sl  local_address                         remote_address                        st',
  '   0: 00000000000000000000000000000000:1389 00000000000000000000000000000000:0000 0A',  // [::]:5001 LISTEN
].join('\n');

test('parseListeningPorts extracts non-loopback LISTEN ports from tcp + tcp6', () => {
  const ports = parseListeningPorts(PROC_TCP + '\n' + PROC_TCP6);
  // 3000 (0.0.0.0) + 5001 (::) ; excludes 8080 (loopback) and the ESTABLISHED row.
  assert.deepEqual(ports, [3000, 5001]);
});

test('parseListeningPorts is empty/safe on garbage', () => {
  assert.deepEqual(parseListeningPorts(''), []);
  assert.deepEqual(parseListeningPorts('not a table\nfoo bar'), []);
});

test('monitor emits only on change (add then remove), per workspace', async () => {
  const events = [];
  let stdout = PROC_TCP; // round 1: port 3000 only
  const monitor = createContainerPortMonitor({
    listContainers: () => [{ slug: 'repo', userId: 'u1' }],
    runOnce: async () => stdout,
    onPortsChanged: (slug, userId, ports) => events.push([slug, userId, ports]),
    intervalMs: 0,
  });

  await monitor._scanOnce();                       // 3000 appears
  await monitor._scanOnce();                       // unchanged → no event
  stdout = PROC_TCP + '\n' + PROC_TCP6;            // add 5001
  await monitor._scanOnce();                       // change → event
  stdout = '';                                     // all gone
  await monitor._scanOnce();                       // change → event (empty)

  assert.deepEqual(events, [
    ['repo', 'u1', [3000]],
    ['repo', 'u1', [3000, 5001]],
    ['repo', 'u1', []],
  ]);
});

test('monitor clears ports for a container that disappeared', async () => {
  const events = [];
  let containers = [{ slug: 'repo', userId: 'u1' }];
  const monitor = createContainerPortMonitor({
    listContainers: () => containers,
    runOnce: async () => PROC_TCP,                 // 3000
    onPortsChanged: (slug, userId, ports) => events.push([slug, userId, ports]),
    intervalMs: 0,
  });
  await monitor._scanOnce();                       // [3000]
  containers = [];                                 // container culled
  await monitor._scanOnce();                       // emits [] once
  assert.deepEqual(events, [['repo', 'u1', [3000]], ['repo', 'u1', []]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend/collab-server && node --test __tests__/containerPortMonitor.test.js`
Expected: FAIL — `Cannot find module '../containerPortMonitor'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/collab-server/containerPortMonitor.js`:

```js
'use strict';

/**
 * Detects TCP ports that servers open INSIDE per-workspace runtime containers
 * (e.g. `npm run dev` launched from the in-container terminal) and reports the
 * forwardable set so the frontend can surface them at /wsport/<slug>/<port>/.
 *
 * Detection reads /proc/net/tcp + /proc/net/tcp6 (always present in Linux; the
 * Alpine runtime image has no iproute2/ss). Only LISTEN sockets (st=0A) bound to
 * a non-loopback address (0.0.0.0 / ::) are forwardable — a 127.0.0.1-only bind
 * is unreachable from collab-server across the container network, so we exclude it.
 */

const LISTEN_STATE = '0A';
// Loopback local-address hex: 127.0.0.1 (v4) and ::1 (v6).
const LOOPBACK_V4 = '0100007F';
const LOOPBACK_V6 = '00000000000000000000000001000000';

/** Parse concatenated /proc/net/tcp[6] text → sorted array of forwardable LISTEN ports. */
function parseListeningPorts(text) {
  const ports = new Set();
  for (const rawLine of String(text || '').split('\n')) {
    const cols = rawLine.trim().split(/\s+/);
    // Need at least: sl local_address rem_address st
    if (cols.length < 4) continue;
    const local = cols[1];
    const state = cols[3];
    if (state !== LISTEN_STATE) continue;
    const sep = local.lastIndexOf(':');
    if (sep < 1) continue;
    const ipHex = local.slice(0, sep).toUpperCase();
    const portHex = local.slice(sep + 1);
    if (!/^[0-9A-Fa-f]+$/.test(portHex)) continue;
    // Exclude loopback-only binds (not reachable across the container network).
    if (ipHex === LOOPBACK_V4 || ipHex === LOOPBACK_V6) continue;
    const port = parseInt(portHex, 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function sameSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {object} opts
 * @param {() => Array<{slug:string,userId:string}>} opts.listContainers - active runtime containers
 * @param {(slug:string,userId:string,argv:string[]) => Promise<string>} opts.runOnce - one-shot exec
 * @param {(slug:string,userId:string,ports:number[]) => void} opts.onPortsChanged
 * @param {number} [opts.intervalMs]
 * @param {object} [opts.logger]
 */
function createContainerPortMonitor({
  listContainers,
  runOnce,
  onPortsChanged,
  intervalMs = 3000,
  logger = console,
} = {}) {
  if (typeof listContainers !== 'function') throw new TypeError('listContainers is required');
  if (typeof runOnce !== 'function') throw new TypeError('runOnce is required');
  if (typeof onPortsChanged !== 'function') throw new TypeError('onPortsChanged is required');

  const keyOf = (slug, userId) => `${slug} ${userId}`;
  /** key -> last reported sorted port array */
  const lastPorts = new Map();
  let timer = null;

  async function _scanOnce() {
    const active = listContainers() || [];
    const activeKeys = new Set(active.map((c) => keyOf(c.slug, c.userId)));

    // Containers that went away → emit [] once, then forget.
    for (const key of [...lastPorts.keys()]) {
      if (!activeKeys.has(key)) {
        const [slug, userId] = key.split(' ');
        if (lastPorts.get(key).length) {
          try { onPortsChanged(slug, userId, []); } catch (_) {}
        }
        lastPorts.delete(key);
      }
    }

    for (const { slug, userId } of active) {
      let ports = [];
      try {
        const out = await runOnce(slug, userId, ['/bin/sh', '-lc', 'cat /proc/net/tcp /proc/net/tcp6 2>/dev/null']);
        ports = parseListeningPorts(out);
      } catch (err) {
        // Container vanished mid-scan etc. — skip this round for this workspace.
        continue;
      }
      const key = keyOf(slug, userId);
      const prev = lastPorts.get(key) || [];
      if (!sameSet(prev, ports)) {
        lastPorts.set(key, ports);
        try { onPortsChanged(slug, userId, ports); } catch (_) {}
      }
    }
  }

  function start() {
    if (timer || intervalMs <= 0) return;
    _scanOnce().catch(() => {});
    timer = setInterval(() => _scanOnce().catch((e) => logger.warn && logger.warn('container_port_scan_failed', { err: e && e.message })), intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { start, stop, _scanOnce, _lastPorts: lastPorts };
}

module.exports = { parseListeningPorts, createContainerPortMonitor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend/collab-server && node --test __tests__/containerPortMonitor.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/containerPortMonitor.js backend/collab-server/__tests__/containerPortMonitor.test.js
git commit -m "feat(runtime): containerPortMonitor — detect forwardable in-container LISTEN ports via /proc/net/tcp"
```

---

## Task 3: `broadcastContainerPorts` + wire/start the monitor in server.js

**Files:**
- Modify: `backend/collab-server/server.js` (require + monitor instantiation near `workspaceRuntime` ~line 121; `broadcastContainerPorts` near the other `broadcast*` helpers ~line 928; start the monitor in the boot block near `proxyService.startScanner(PORT)` ~line 4598)

- [ ] **Step 1: Add the require**

Near the other collab requires (by line 14, after `ensureRuntime`):

```js
const { createContainerPortMonitor } = require('./containerPortMonitor');
```

- [ ] **Step 2: Add the broadcast helper**

Add next to `broadcastFileSaved` (after line ~938). Ports are workspace-wide, so no scope filtering — every notify client on the slug receives them:

```js
/**
 * Broadcast the live set of forwardable ports detected inside a workspace's
 * runtime container. The frontend Ports panel renders these at
 * /wsport/<slug>/<port>/. Workspace-wide (no per-user scope filtering).
 */
function broadcastContainerPorts(slug, ports) {
  if (!slug || !notifyWss) return;
  const message = JSON.stringify({ type: 'container-ports', slug, ports: Array.isArray(ports) ? ports : [] });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug) {
      try { ws.send(message); } catch (_) {}
    }
  });
}
```

- [ ] **Step 3: Instantiate the monitor (flag-gated)**

Immediately after the `containerPortProxy` block (~line 135), add:

```js
const containerPortMonitor = ENABLE_CONTAINER_RUNTIME
  ? createContainerPortMonitor({
      // Active runtime containers, keyed `${slug} ${userId}` in the manager.
      listContainers: () => [...workspaceRuntime._sessions.keys()].map((k) => {
        const i = k.indexOf(' ');
        return { slug: k.slice(0, i), userId: k.slice(i + 1) };
      }),
      runOnce: (slug, userId, argv) => workspaceRuntime.runOnce(slug, userId, argv),
      onPortsChanged: (slug, _userId, ports) => broadcastContainerPorts(slug, ports),
      logger,
    })
  : null;
```

- [ ] **Step 4: Start the monitor at boot**

In the boot block right after `proxyService.startScanner(PORT);` (~line 4598):

```js
    if (containerPortMonitor) {
      containerPortMonitor.start();
      logger.info('container_port_monitor_started', {});
    }
```

- [ ] **Step 5: Verify load + run backend suite**

Run: `cd backend/collab-server && node --check server.js && node --test __tests__/containerPortMonitor.test.js __tests__/workspaceRuntimeContainer.test.js`
Expected: `server.js` parses; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/collab-server/server.js
git commit -m "feat(runtime): broadcast container-ports over notifyWss + start the port monitor"
```

---

## Task 4: Live-verify the backend (dev stack)

**Files:** none (verification only).

- [ ] **Step 1: Rebuild + restart collab-server**

```bash
D:\Docker\DockerDesktop\resources\bin\docker.exe compose -f docker-compose.yml build collab-server
D:\Docker\DockerDesktop\resources\bin\docker.exe compose -f docker-compose.yml up -d collab-server
```
Expected: rebuilds and restarts cleanly.

- [ ] **Step 2: Open a terminal in a workspace, start a server, observe the notify push**

Use a WS harness (same approach as Phase 2a) writing to `/app/_portmon-test.js` inside collab-server. It connects the terminal WSS, runs `python3 -m http.server 8000 --bind 0.0.0.0`, then connects the **notifications** WS (`ws://127.0.0.1:1234/notifications?slug=<slug>`) and asserts a `{type:'container-ports', ports:[...8000...]}` message arrives within ~6s. Run it inside the container with `MSYS_NO_PATHCONV=1 docker exec -w /app synthi-ide-collab-server-1 node _portmon-test.js`.
Expected: the harness prints a `container-ports` message containing `8000`. Clean up the harness file (`docker exec -u root ... rm -f /app/_portmon-test.js`).

- [ ] **Step 3: Commit (verification notes)**

Append results to the Phase 2b plan's "Verification Results" section (added in Task 8) — or note here and defer the commit to Task 8.

---

# SLICE 2b-2 — Frontend Ports panel

## Task 5: `portsSlice` + store registration + notify dispatch

**Files:**
- Create: `synthi/src/redux/portsSlice.js`
- Modify: `synthi/src/redux/store.js` (import + register under `ports`)
- Modify: `synthi/src/services/collabClient.js` (dispatch `container-ports`)
- Modify: `synthi/src/app/workspace/[slug]/page.jsx` (`onContainerPorts` handler)

- [ ] **Step 1: Create the slice**

`synthi/src/redux/portsSlice.js`:

```js
import { createSlice } from '@reduxjs/toolkit';

export const initialPortsState = {
  // Forwardable TCP ports detected inside the workspace runtime container.
  containerPorts: [],
};

const portsSlice = createSlice({
  name: 'ports',
  initialState: initialPortsState,
  reducers: {
    setContainerPorts: (state, action) => {
      state.containerPorts = Array.isArray(action.payload) ? action.payload : [];
    },
    clearContainerPorts: (state) => {
      state.containerPorts = [];
    },
  },
});

export const { setContainerPorts, clearContainerPorts } = portsSlice.actions;
export default portsSlice.reducer;
```

- [ ] **Step 2: Register the reducer**

In `synthi/src/redux/store.js`, add the import near the others (after line 11):

```js
import portsReducer from './portsSlice';
```

Add to the `reducer` map (after `compileManifest: compileManifestReducer,`):

```js
    ports: portsReducer,
```

- [ ] **Step 3: Dispatch the notify message in collabClient**

In `synthi/src/services/collabClient.js`, inside `ws.onmessage` (after the `file-saved` block, ~line 1204):

```js
          if (msg.type === 'container-ports' && msg.slug === slug) {
            if (typeof handlers.onContainerPorts === 'function') handlers.onContainerPorts(Array.isArray(msg.ports) ? msg.ports : []);
          }
```

- [ ] **Step 4: Wire the handler in page.jsx**

In `synthi/src/app/workspace/[slug]/page.jsx`, add the import near `setSlug` (line 8 area):

```js
import { setContainerPorts } from '@/redux/portsSlice';
```

Add the handler inside the `collabClient.connectNotifications(slug, { ... })` object (after the `onFileSaved` handler, ~line 1217):

```js
            onContainerPorts: (ports) => {
                dispatch(setContainerPorts(ports));
            },
```

- [ ] **Step 5: Verify the slice loads / no syntax errors**

Run: `cd synthi && node -e "require('@babel/core')" 2>/dev/null; echo "(use lint)"` then `npx eslint src/redux/portsSlice.js src/services/collabClient.js` (page.jsx is excluded by the flat config — its diagnostics-are-semantic-only check from Phase 2a applies).
Expected: no errors in `portsSlice.js` / `collabClient.js`.

- [ ] **Step 6: Commit**

```bash
git add synthi/src/redux/portsSlice.js synthi/src/redux/store.js synthi/src/services/collabClient.js "synthi/src/app/workspace/[slug]/page.jsx"
git commit -m "feat(ports): portsSlice + dispatch container-ports notify into Redux"
```

---

## Task 6: `PortsPanel` component

**Files:**
- Create: `synthi/src/components/ports/PortsPanel.jsx`

- [ ] **Step 1: Create the component**

`synthi/src/components/ports/PortsPanel.jsx` — reads ports + slug from Redux, renders each with Open (new tab) + Copy URL, with an empty state. Reuses `getProgramSessionAppUrl(port, { slug, runtimeType: 'container' })`:

```jsx
'use client';
import { useCallback } from 'react';
import { Network, ExternalLink, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { useAppSelector } from '@/redux/hooks';
import { getProgramSessionAppUrl } from '@/services/programSessionClient';

export default function PortsPanel() {
  const ports = useAppSelector((s) => s.ports?.containerPorts) || [];
  const slug = useAppSelector((s) => s.workspace?.slug) || '';

  const urlFor = useCallback(
    (port) => getProgramSessionAppUrl(port, { slug, runtimeType: 'container' }),
    [slug],
  );

  const open = useCallback((port) => {
    const url = urlFor(port);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, [urlFor]);

  const copy = useCallback(async (port) => {
    const url = urlFor(port);
    try { await navigator.clipboard.writeText(url); toast.success(`Copied ${url}`); }
    catch { toast.error('Copy failed'); }
  }, [urlFor]);

  return (
    <div className="h-full w-full overflow-y-auto p-3" style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}>
      <div className="flex items-center gap-2 mb-3">
        <Network size={16} />
        <span className="text-sm font-medium">Ports</span>
      </div>
      {!slug ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No workspace.</div>
      ) : ports.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No forwarded ports. Start a server in the terminal (e.g. <code>npm run dev</code>, binding 0.0.0.0) and it will appear here.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {ports.map((port) => (
            <div
              key={port}
              data-testid={`port-row-${port}`}
              className="rounded-md border px-3 py-2 flex items-center justify-between gap-3"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
            >
              <span className="text-sm">Port {port}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`open-port-${port}`}
                  onClick={() => open(port)}
                  title="Open in browser"
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded"
                  style={{ background: 'color-mix(in srgb, #60a5fa 18%, transparent)' }}
                >
                  <ExternalLink size={13} /> Open
                </button>
                <button
                  type="button"
                  onClick={() => copy(port)}
                  title="Copy URL"
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded"
                  style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.06))' }}
                >
                  <Copy size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Lint the component**

Run: `cd synthi && npx eslint src/components/ports/PortsPanel.jsx`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add synthi/src/components/ports/PortsPanel.jsx
git commit -m "feat(ports): PortsPanel UI (open/copy /wsport per detected port)"
```

---

## Task 7: Register the Ports panel in the docking-wm

**Files:**
- Modify: `synthi/src/components/docking-wm/panels/panel-types.js`
- Modify: `synthi/src/components/docking-wm/panels/panel-wrappers.jsx`
- Modify: `synthi/src/components/docking-wm/panels/ide-panels.js`
- Modify: `synthi/src/components/docking-wm/components/DockingActivityBar.jsx`
- Modify: `synthi/src/components/docking-wm/hooks/use-activity-bar-docking.js`

- [ ] **Step 1: Add the panel-type**

In `panel-types.js`, add inside the `IDE_PANEL` object (after `INTEGRATIONS: 'integrations',`):

```js
  PORTS: 'ports',
```

- [ ] **Step 2: Add the dynamic import + wrapper**

In `panel-wrappers.jsx`, add the dynamic import near `ConnectedToolsPanel` (~line 101):

```js
const PortsPanel = dynamic(
  () => import('@/components/ports/PortsPanel'),
  { ssr: false, loading: Placeholder },
);
```

And add the wrapper near `IntegrationsPanelWrapper` (after ~line 443):

```jsx
// ────────────────────────────────────────────────────────
//  Ports Panel Wrapper
// ────────────────────────────────────────────────────────

export const PortsPanelWrapper = memo(function PortsPanelWrapper({ data }) {
  return (
    <div
      data-panel-type="ports"
      className="h-full w-full overflow-hidden"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <PortsPanel />
    </div>
  );
});
```

- [ ] **Step 3: Register the panel definition**

In `ide-panels.js`, add `PortsPanelWrapper` to the wrappers import (the import that pulls `ProgramsPanelWrapper`, ~line 31):

```js
  PortsPanelWrapper,
```

Add a definition to the `IDE_PANEL_DEFINITIONS` array (after the `INTEGRATIONS` entry, ~line 240):

```js
  {
    panelType: IDE_PANEL.PORTS,
    displayName: 'Ports',
    icon: 'network',
    category: 'sidebar',
    component: PortsPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
```

- [ ] **Step 4: Add the activity-bar entry**

In `DockingActivityBar.jsx`, ensure `Network` is imported from `lucide-react` (add to the existing `lucide-react` import if absent), then add to `TOP_ITEMS` (after the `integrations` entry, ~line 70):

```js
  { id: 'ports',        panelType: IDE_PANEL.PORTS,        label: 'Ports',           Icon: Network },
```

And add `'ports'` to the `SIDEBAR_PANELS` set (~line 135):

```js
    const SIDEBAR_PANELS = new Set(['explorer', 'search', 'git', 'extensions', 'programs', 'extension-view', 'chat', 'pullrequests', 'ai-healing', 'integrations', 'ports']);
```

- [ ] **Step 5: Add the toggle handler**

In `use-activity-bar-docking.js`, add to the handlers map (after the `integrations` entry, ~line 195):

```js
      ports:         () => togglePanel(IDE_PANEL.PORTS, 'Ports'),
```

- [ ] **Step 6: Verify it builds (registration is consistent)**

Run: `cd synthi && npx eslint src/components/docking-wm/panels/panel-types.js src/components/docking-wm/panels/panel-wrappers.jsx src/components/docking-wm/panels/ide-panels.js src/components/docking-wm/components/DockingActivityBar.jsx src/components/docking-wm/hooks/use-activity-bar-docking.js`
Expected: no errors. (If the project has a fast typecheck/build, run it; otherwise the import/registration consistency is covered by lint + the live check in Task 8.)

- [ ] **Step 7: Commit**

```bash
git add synthi/src/components/docking-wm
git commit -m "feat(ports): register the Ports panel in the docking window manager"
```

---

## Task 8: Live end-to-end verification

**Files:** none (verification only). Append results to this plan.

- [ ] **Step 1: Rebuild + restart the frontend**

```bash
D:\Docker\DockerDesktop\resources\bin\docker.exe compose -f docker-compose.yml build frontend
D:\Docker\DockerDesktop\resources\bin\docker.exe compose -f docker-compose.yml up -d frontend
```
Expected: builds and restarts cleanly. (If the build OOMs, build with `NODE_OPTIONS=--max-old-space-size=4096` per the project's known constraint.)

- [ ] **Step 2: Browser check**

Open `http://localhost:3000/workspace/<slug>`, open the **Ports** entry in the activity bar (network icon) → empty state shows. Open a terminal, run `python3 -m http.server 8000 --bind 0.0.0.0`. Within a few seconds the Ports panel shows **Port 8000**. Click **Open** → a new tab loads `/wsport/<slug>/8000/` and serves the directory listing. Stop the server (Ctrl-C) → Port 8000 disappears from the panel within ~3s.

- [ ] **Step 3: No-regression (flag off)**

Confirm that with `ENABLE_CONTAINER_RUNTIME` unset, `containerPortMonitor` is null and never starts (no `container_port_monitor_started` log), and the Ports panel simply shows the empty state. (Covered structurally by the flag gate; note it.)

- [ ] **Step 4: Record results + commit**

Append a "Verification Results" section to this plan (commands + observed output) and commit:

```bash
git add docs/superpowers/plans/2026-06-11-terminal-container-runtime-phase2b.md
git commit -m "docs: Phase 2b live verification results"
```

---

## Self-Review

**Spec coverage (spec §5):**
- Detect listening TCP ports inside the runtime container → Task 2 (`/proc/net/tcp[6]` parse) + Task 1 (`runOnce`). ✓
- Diff against last-seen, attribute to (slug,userId) → Task 2. ✓
- Surface via the existing notify channel → Task 3 (`broadcastContainerPorts` over `notifyWss`) + Task 5 (collabClient dispatch → Redux). ✓
- Clickable entries → `/wsport/<slug>/<port>/` → Task 6 (`getProgramSessionAppUrl`). ✓
- Gated identically to the flag; flag-off = no monitor → Task 3 Step 3 (ternary on `ENABLE_CONTAINER_RUNTIME`), Task 8 Step 3. ✓
- Pure/injectable for unit tests (fake exec) → Task 2 (`runOnce`/`listContainers`/`onPortsChanged` all injected). ✓

**Placeholder scan:** Every code step has full code. Task 4/Task 8 are verification steps with concrete commands. The one deferred detail — the exact Task-4 WS harness script — mirrors the Phase 2a harness already proven this session; it's a verification aid, not shipped code. No `TODO`/`TBD`.

**Type/name consistency:**
- `runOnce(slug, userId, argv) → Promise<string>` — defined Task 1, consumed Task 2 (monitor) and Task 3 (wiring). ✓
- `parseListeningPorts(text) → number[]` and `createContainerPortMonitor({listContainers, runOnce, onPortsChanged, intervalMs, logger})` with `{ start, stop, _scanOnce, _lastPorts }` — consistent across Task 2 test + impl + Task 3 wiring. ✓
- Message shape `{ type: 'container-ports', slug, ports }` — produced Task 3 (`broadcastContainerPorts`), consumed Task 5 (collabClient `msg.ports`). ✓
- `setContainerPorts(ports)` action — defined Task 5 (slice), consumed Task 5 (page.jsx). State path `s.ports.containerPorts` — written by reducer, read by Task 6 panel. ✓
- `IDE_PANEL.PORTS = 'ports'` — defined Task 7 Step 1, used in panel definition (Step 3), activity bar (Step 4), toggle (Step 5), `data-panel-type="ports"` (Step 2), SIDEBAR_PANELS (Step 4). ✓
- `getProgramSessionAppUrl(port, { slug, runtimeType: 'container' })` → `/wsport/<slug>/<port>/` — existing function, consumed Task 6. ✓
```

---

## Verification Results (2026-06-11)

All 8 tasks implemented and committed. **Unit: 18/18** across the two backend suites
(`workspaceRuntimeContainer.test.js` 17 incl. `runOnce`; `containerPortMonitor.test.js` 5 incl. parse, baseline-subtraction, daemon-warmup, and disappear). Two refinements were made during live verification (committed):
- **Baseline subtraction** — the rootless dockerd (2376) + an ephemeral containerd port listen on 0.0.0.0 at startup; the monitor snapshots them as a per-container baseline and reports only ports opened afterward.
- **Baseline on first non-empty scan** — the daemon takes ~15-25s to come up, so baselining the empty early scans would later report the daemon's own ports as user ports; skip empty scans until it's listening.

**Backend live (dev stack, `ENABLE_CONTAINER_RUNTIME=1`):** a WS harness opened the in-container terminal, ran `python3 -m http.server 8000 --bind 0.0.0.0`, and the notifications WS received `{type:'container-ports', ports:[8000]}` — **only 8000**, infra ports correctly hidden.

**Frontend live (browser, the running stack):**
- The **Ports** entry appears in the activity bar (registered between Connected Tools and Pull Requests).
- Running `python3 -m http.server 8000 --bind 0.0.0.0` in the terminal → the **Ports panel renders "Port 8000"** with Open/Copy (and only 8000 — infra hidden).
- Clicking **Open** targets `/wsport/0naokfjy/8000/`; `curl` of that URL returns **200**, `server: SimpleHTTP/0.6 Python/3.12.13` (the in-container server), the directory-listing body, and the `cross-origin-resource-policy: cross-origin` + `cross-origin-embedder-policy: credentialless` headers for iframe embedding.
- Stopping the server → the panel returns to the **empty state** within ~4s (removal path).

**Notes / environment:**
- The frontend production build initially failed on a **transient Google Fonts `ETIMEDOUT`** (`next/font`) — unrelated to this feature, same outbound-network restriction as the DB/GCP; it cleared on retry (`✓ Compiled successfully`). The build compiled all Ports modules with zero errors.
- DB-independent as designed: the whole path is `notifyWss → Redux → panel`, so this works even though the frontend's remote DB is unreachable in this environment.

**No-regression:** `containerPortMonitor` is null when the flag is unset (never starts); the Ports panel simply shows its empty state.
