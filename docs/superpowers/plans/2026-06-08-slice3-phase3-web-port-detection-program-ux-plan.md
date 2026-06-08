# Slice 3 Phase 3 — Web-Port Auto-Detection + Polished Program Tab UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a managed program's web port light up the App surface automatically as its dev server boots, attribute detected ports to the owning session, run the manifest's health check, and polish the Program session tab (actionable ports, live health badge, web-server waiting state).

**Architecture:** The collab-server already runs a global TCP port scanner (`proxyService`) and a `/port/<N>/` reverse proxy. Phase 3 (a) subscribes the program-runtime manager to `proxyService.onPortsChanged` and adds two **pure** helpers — `attributeSessionPorts` (declared∩detected per session, undeclared→single no-declared session) and `selectWebPort` — so each managed session's `activePorts`/`webPort` update live; (b) adds an injectable HTTP health prober that probes only `PROXY_HOST:<webPort><path>` (path-only, never a manifest-supplied host) and emits `health_changed`; (c) surfaces `healthState` through `mergeProgramSession`; (d) polishes `ProgramSessionPanel`. All new logic lives in pure/injectable units so it is unit-testable without a live network or Docker.

**Tech Stack:** Node.js (`backend/collab-server/`, `node --test` + `node:assert`), Next.js App Router API + React (`synthi/`, Vitest from the `synthi/` dir; jsdom via `react-dom/client` + `act`).

**Constraints (carried from Phase 1/2):**
- Branch `tool-compatibility` only — no branch/merge/PR/finish.
- Disk gate: **TDD only** (`vitest`, `node --test`, `prisma generate|db push`). NO `next build` / `docker build` / `docker compose build`.
- No Prisma schema change expected (`ProgramSession.lastHealthState` already exists).
- Always run `@/`-dependent suites from `synthi/` (vitest v4.1.8 has the `@/` alias; repo-root vitest v2.1.9 does not). cwd resets between Bash calls — `cd` explicitly each time.
- Stage **specific files only** (never `git add -A`). Every commit ends with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- Do not touch the known pre-existing dirty/untracked noise files (`.claude/*`, `.gitignore`, `synthi/public/node-polyfills.js`, `tasks/lessons.md`, the two untracked docs, `packages/mcp-hub/node_modules`).

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `backend/collab-server/programRuntimeManager.js` | Port attribution + web-port selection + continuous recompute + health probing | Modify |
| `backend/collab-server/__tests__/programRuntimeManager.test.js` | Backend unit tests (extends existing 8) | Modify |
| `backend/collab-server/server.js` | Subscribe manager to `proxyService.onPortsChanged`; pass `probeHost`/`httpProbe` into the manager | Modify |
| `synthi/src/lib/programs/routeHelpers.js` | `mergeProgramSession` surfaces `lastHealthState` from the runtime snapshot | Modify |
| `synthi/src/lib/programs/__tests__/routeHelpers.test.js` | Unit test for the health merge | Create (if absent) |
| `synthi/src/app/api/workspace/[slug]/program-sessions/__tests__/programSessionRoutes.test.js` | Route assertions for `lastHealthState` passthrough | Modify |
| `synthi/src/components/programs/ProgramSessionPanel.jsx` | App waiting state, actionable Ports (Open / Set as App), live health badge | Modify |
| `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx` | Panel polish tests (extends existing 2) | Modify |

**Contract additions (NormalizedProgramConfig already carries these — we only thread them through the runtime):**
- Runtime snapshot (`toPublicManagedSession`) gains `healthState: 'unknown' | 'ok' | 'unhealthy'` and keeps `activePorts`/`webPort` (now live). It must NOT expose `health` (config), `healthTimer`, `runtime`, `launchRequest`.
- `mergeProgramSession(session, runtimeSession)` output gains `lastHealthState` = `runtimeSession?.healthState ?? session.lastHealthState ?? null`.

---

## Task 1: Pure port-attribution + web-port-selection helpers

**Files:**
- Modify: `backend/collab-server/programRuntimeManager.js`
- Test: `backend/collab-server/__tests__/programRuntimeManager.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `backend/collab-server/__tests__/programRuntimeManager.test.js` (the file already imports from the manager; add `attributeSessionPorts, selectWebPort` to its existing top-of-file require of `../programRuntimeManager`):

```js
const {
  attributeSessionPorts,
  selectWebPort,
} = require('../programRuntimeManager');

test('attributeSessionPorts assigns declared∩detected ports per session', () => {
  const sessions = [
    { sessionId: 'a', state: 'running', declaredPorts: [3000] },
    { sessionId: 'b', state: 'running', declaredPorts: [5173] },
  ];
  const map = attributeSessionPorts({ sessions, detectedPorts: [3000, 5173, 9999] });
  assert.deepStrictEqual(map.get('a'), [3000]);
  assert.deepStrictEqual(map.get('b'), [5173]);
});

test('attributeSessionPorts gives undeclared detected ports to the single no-declared running session', () => {
  const sessions = [
    { sessionId: 'a', state: 'running', declaredPorts: [3000] },
    { sessionId: 'b', state: 'running', declaredPorts: [] },
  ];
  const map = attributeSessionPorts({ sessions, detectedPorts: [3000, 5173] });
  assert.deepStrictEqual(map.get('a'), [3000]);
  assert.deepStrictEqual(map.get('b'), [5173]);
});

test('attributeSessionPorts leaves undeclared ports unattributed when ambiguous', () => {
  const sessions = [
    { sessionId: 'a', state: 'running', declaredPorts: [] },
    { sessionId: 'b', state: 'running', declaredPorts: [] },
  ];
  const map = attributeSessionPorts({ sessions, detectedPorts: [5173] });
  assert.deepStrictEqual(map.get('a'), []);
  assert.deepStrictEqual(map.get('b'), []);
});

test('attributeSessionPorts ignores stopped sessions', () => {
  const sessions = [
    { sessionId: 'a', state: 'stopped', declaredPorts: [3000] },
    { sessionId: 'b', state: 'running', declaredPorts: [] },
  ];
  const map = attributeSessionPorts({ sessions, detectedPorts: [3000] });
  assert.strictEqual(map.has('a'), false);
  // 3000 is declared by a stopped session → not claimed → undeclared fallback to b
  assert.deepStrictEqual(map.get('b'), [3000]);
});

test('selectWebPort prefers a declared-live port, else the lowest attributed port', () => {
  assert.strictEqual(
    selectWebPort({ runtimeType: 'web', surfaces: ['app'], declaredPorts: [8080] }, [3000, 8080]),
    8080,
  );
  assert.strictEqual(
    selectWebPort({ runtimeType: 'web', surfaces: ['app'], declaredPorts: [] }, [5173, 3000]),
    3000,
  );
});

test('selectWebPort returns null for a portless cli runtime', () => {
  assert.strictEqual(selectWebPort({ runtimeType: 'cli', surfaces: ['logs', 'terminal'], declaredPorts: [] }, [3000]), null);
  assert.strictEqual(selectWebPort({ runtimeType: 'web', surfaces: ['app'], declaredPorts: [] }, []), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: FAIL — `attributeSessionPorts`/`selectWebPort` are `undefined` (TypeError: not a function).

- [ ] **Step 3: Implement the pure helpers**

In `backend/collab-server/programRuntimeManager.js`, add these module-level functions (place them just after the existing `normalizePorts` function, before `cloneEvent`):

```js
const RUNNING_STATES = ['starting', 'running', 'unhealthy'];

function samePorts(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Attribute a globally-detected port set to managed sessions.
 *   1. Each running session claims its declared ports that are currently live.
 *   2. Any still-unclaimed live port is given to the single running session that
 *      declared NO ports (the auto-binding dev-server case); ambiguous → dropped.
 * @returns {Map<string, number[]>} sessionId → attributed ports (sorted, deduped)
 */
function attributeSessionPorts({ sessions = [], detectedPorts = [] } = {}) {
  const detected = new Set(normalizePorts(detectedPorts));
  const running = sessions.filter((s) => RUNNING_STATES.includes(s.state));
  const result = new Map();
  const claimed = new Set();

  for (const session of running) {
    const declared = normalizePorts(session.declaredPorts || []);
    const live = declared.filter((port) => detected.has(port));
    result.set(session.sessionId, live);
    live.forEach((port) => claimed.add(port));
  }

  const undeclaredLive = [...detected].filter((port) => !claimed.has(port));
  const noDeclared = running.filter((s) => normalizePorts(s.declaredPorts || []).length === 0);
  if (undeclaredLive.length && noDeclared.length === 1) {
    const target = noDeclared[0].sessionId;
    result.set(target, normalizePorts([...(result.get(target) || []), ...undeclaredLive]));
  }

  return result;
}

/**
 * Choose the primary web port for the App surface.
 *   - null when there are no attributed ports.
 *   - null for a portless `cli` runtime with no `app` surface (it has no web UI).
 *   - otherwise: first declared port that is live, else the lowest attributed port.
 */
function selectWebPort({ runtimeType = 'cli', surfaces = [], declaredPorts = [] } = {}, attributedPorts = []) {
  const ports = normalizePorts(attributedPorts);
  if (!ports.length) return null;
  const hasWebSurface = (Array.isArray(surfaces) && surfaces.includes('app'))
    || runtimeType === 'web'
    || runtimeType === 'background'
    || normalizePorts(declaredPorts).length > 0;
  if (!hasWebSurface) return null;
  const declaredLive = normalizePorts(declaredPorts).find((port) => ports.includes(port));
  return declaredLive ?? ports[0];
}
```

Add them to `module.exports` (extend the existing export object):

```js
module.exports = {
  createProgramRuntimeManager,
  DEFAULT_HEADLESS_TTL_MS,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_OUTPUT_CAP,
  buildManagedRuntimeEnv,
  composeProgramCommand,
  attributeSessionPorts,
  selectWebPort,
  samePorts,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: PASS — all prior 8 tests plus the 6 new ones.

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/programRuntimeManager.js backend/collab-server/__tests__/programRuntimeManager.test.js
git commit -m "feat(slice3-p3): per-session port attribution + web-port selection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Continuous per-session port recompute + server wiring

**Files:**
- Modify: `backend/collab-server/programRuntimeManager.js`
- Modify: `backend/collab-server/server.js`
- Test: `backend/collab-server/__tests__/programRuntimeManager.test.js`

- [ ] **Step 1: Write the failing test**

Append to `backend/collab-server/__tests__/programRuntimeManager.test.js`. This builds a manager with a fake runtime and drives `recomputeManagedPorts`:

```js
const { createProgramRuntimeManager } = require('../programRuntimeManager');

function makeFakePty() {
  const handlers = {};
  return {
    onData: (fn) => { handlers.data = fn; return { dispose() {} }; },
    onExit: (fn) => { handlers.exit = fn; return { dispose() {} }; },
    kill: () => {},
    _emitData: (chunk) => handlers.data && handlers.data(chunk),
    _emitExit: (payload) => handlers.exit && handlers.exit(payload),
  };
}

function makeManager(overrides = {}) {
  return createProgramRuntimeManager({
    activeSessions: new Map(),
    launchRuntime: async () => ({ ptyProcess: makeFakePty(), stop() {} }),
    now: () => 1000,
    ...overrides,
  });
}

test('recomputeManagedPorts updates a launched program session live and emits ports_updated once per change', async () => {
  const manager = makeManager();
  await manager.launchManagedProgram({
    sessionId: 'ps-1',
    workspaceSlug: 'team',
    config: { packageId: 'web', runtimeType: 'web', surfaces: ['app', 'ports'], ports: [3000], launch: 'npm run dev', env: {} },
  });

  const updated = manager.recomputeManagedPorts([3000, 9999]);
  assert.strictEqual(updated.length, 1);
  const snap = manager.getManagedSession('ps-1');
  assert.deepStrictEqual(snap.activePorts, [3000]);
  assert.strictEqual(snap.webPort, 3000);

  // No change → no new snapshot, no duplicate event.
  const again = manager.recomputeManagedPorts([3000, 9999]);
  assert.strictEqual(again.length, 0);

  const events = manager.listManagedSessionEvents('ps-1');
  assert.strictEqual(events.filter((e) => e.type === 'ports_updated').length, 1);
});

test('recomputeManagedPorts assigns undeclared detected port to a no-declared web session', async () => {
  const manager = makeManager();
  await manager.launchManagedProgram({
    sessionId: 'ps-2',
    workspaceSlug: 'team',
    config: { packageId: 'app', runtimeType: 'web', surfaces: ['app'], ports: [], launch: 'npm start', env: {} },
  });
  manager.recomputeManagedPorts([5173]);
  const snap = manager.getManagedSession('ps-2');
  assert.deepStrictEqual(snap.activePorts, [5173]);
  assert.strictEqual(snap.webPort, 5173);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: FAIL — `manager.recomputeManagedPorts is not a function`.

- [ ] **Step 3: Implement `recomputeManagedPorts` + thread `declaredPorts`/`surfaces` onto the record**

3a. In `launchManagedSession`, accept `surfaces` and store `declaredPorts`/`surfaces` on the record. Change the signature and the record (and `launchRequest`) so restart preserves them:

```js
  async function launchManagedSession({
    sessionId,
    workspaceSlug,
    userId = '',
    command,
    env = {},
    runtimeType = 'cli',
    title = null,
    metadata = null,
    ports = [],
    surfaces = [],
    health = null,
  } = {}) {
```

In the `record` object literal, replace the `activePorts`/`webPort` seed lines and add the new fields:

```js
      activePorts: declaredPorts,
      webPort: selectWebPort({ runtimeType, surfaces, declaredPorts }, declaredPorts),
      declaredPorts,
      surfaces: Array.isArray(surfaces) ? surfaces : [],
      health: health && typeof health === 'object' ? health : null,
      healthState: 'unknown',
      healthTimer: null,
```

In the `launchRequest` object inside the record, add `surfaces` and `health` next to `ports`:

```js
        ports: declaredPorts,
        surfaces: Array.isArray(surfaces) ? surfaces : [],
        health: health && typeof health === 'object' ? health : null,
```

3b. In `launchManagedProgram`, pass `surfaces` and `health` from the config:

```js
    return launchManagedSession({
      sessionId,
      workspaceSlug,
      userId,
      command,
      env: config.env || {},
      runtimeType: config.runtimeType || 'cli',
      title: title || config.displayName || config.packageId || null,
      ports: Array.isArray(config.ports) ? config.ports : [],
      surfaces: Array.isArray(config.surfaces) ? config.surfaces : [],
      health: config.health || null,
      metadata: metadata || {
        packageId: config.packageId || null,
        version: config.version || null,
        source: config.source || null,
      },
    });
```

3c. Update `toPublicManagedSession` to exclude `health` config + `healthTimer` (keep `healthState`):

```js
function toPublicManagedSession(record) {
  if (!record) {
    return null;
  }

  const {
    runtime,
    idleTimer,
    healthTimer,
    health,
    runtimeDataDisposable,
    runtimeExitDisposable,
    launchRequest,
    ...publicRecord
  } = record;

  return {
    ...publicRecord,
    activePorts: [...publicRecord.activePorts],
  };
}
```

3d. Add `recomputeManagedPorts` and rewrite `refreshManagedSessionPorts` to delegate. Replace the existing `refreshManagedSessionPorts` function body with:

```js
  function recomputeManagedPorts(detectedPorts) {
    const sessions = [...managedSessions.values()].map((record) => ({
      sessionId: record.sessionId,
      state: record.state,
      declaredPorts: record.declaredPorts || [],
    }));
    const attribution = attributeSessionPorts({ sessions, detectedPorts });
    const updated = [];

    for (const [sessionId, ports] of attribution) {
      const record = managedSessions.get(sessionId);
      if (!record) {
        continue;
      }
      const nextWebPort = selectWebPort(
        { runtimeType: record.runtimeType, surfaces: record.surfaces || [], declaredPorts: record.declaredPorts || [] },
        ports,
      );
      if (samePorts(record.activePorts, ports) && record.webPort === nextWebPort) {
        continue;
      }
      record.activePorts = ports;
      record.webPort = nextWebPort;
      record.lastActivityAt = now();
      appendManagedSessionEvent(record, 'ports_updated', {
        activePorts: [...ports],
        webPort: nextWebPort,
      });
      updated.push(toPublicManagedSession(record));
    }

    return updated;
  }

  async function refreshManagedSessionPorts(sessionId) {
    const detected = normalizePorts(await Promise.resolve(getActivePorts()));
    recomputeManagedPorts(detected);
    return getManagedSession(sessionId);
  }
```

3e. Add `recomputeManagedPorts` to the manager's returned object (next to `refreshManagedSessionPorts`):

```js
    recomputeManagedPorts,
    refreshManagedSessionPorts,
```

> Note: `getActivePorts` is now called with no argument (it returns the global set; attribution happens in `recomputeManagedPorts`). The server wiring already passes `() => proxyService.getActivePorts()`, which is compatible.

3f. Wire continuous refresh in `backend/collab-server/server.js`. Find where the manager is created (the `getActivePorts: () => proxyService.getActivePorts()` option, ~line 108) and capture the manager instance (it is already assigned, e.g. `managedProgramRuntime`). Immediately after the scanner is started (search for `proxyService.startScanner(`), add:

```js
// Phase 3: push live port changes from the global scanner into managed sessions
proxyService.onPortsChanged((ports) => {
  try {
    managedProgramRuntime.recomputeManagedPorts(ports);
  } catch (err) {
    logger.warn({ err }, 'recomputeManagedPorts failed');
  }
});
```

- [ ] **Step 4: Run the tests + syntax-check the server**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js && node --check backend/collab-server/server.js`
Expected: PASS (all manager tests) and no output from `node --check` (valid syntax).

- [ ] **Step 5: Commit**

```bash
git add backend/collab-server/programRuntimeManager.js backend/collab-server/__tests__/programRuntimeManager.test.js backend/collab-server/server.js
git commit -m "feat(slice3-p3): live per-session port recompute wired to proxy scanner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Injectable HTTP health probing

**Files:**
- Modify: `backend/collab-server/programRuntimeManager.js`
- Modify: `backend/collab-server/server.js`
- Test: `backend/collab-server/__tests__/programRuntimeManager.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `backend/collab-server/__tests__/programRuntimeManager.test.js`:

```js
test('probeManagedSessionHealth flips healthState to ok and emits health_changed', async () => {
  const calls = [];
  const manager = makeManager({
    probeHost: '127.0.0.1',
    httpProbe: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
  });
  await manager.launchManagedProgram({
    sessionId: 'ps-h1',
    workspaceSlug: 'team',
    config: { packageId: 'web', runtimeType: 'web', surfaces: ['app'], ports: [3000], launch: 'npm run dev', env: {}, health: { type: 'http', target: '/healthz', intervalMs: 5000 } },
  });
  manager.recomputeManagedPorts([3000]); // gives webPort 3000

  const snap = await manager.probeManagedSessionHealth('ps-h1');
  assert.strictEqual(snap.healthState, 'ok');
  assert.strictEqual(calls[0], 'http://127.0.0.1:3000/healthz');
  assert.strictEqual(manager.listManagedSessionEvents('ps-h1').filter((e) => e.type === 'health_changed').length, 1);
});

test('probeManagedSessionHealth treats a path-only target and never honours a manifest host', async () => {
  const calls = [];
  const manager = makeManager({
    probeHost: '127.0.0.1',
    httpProbe: async (url) => { calls.push(url); return { ok: false, status: 500 }; },
  });
  await manager.launchManagedProgram({
    sessionId: 'ps-h2',
    workspaceSlug: 'team',
    config: { packageId: 'web', runtimeType: 'web', surfaces: ['app'], ports: [8080], launch: 'x', env: {}, health: { type: 'http', target: 'http://evil.example.com/steal', intervalMs: 5000 } },
  });
  manager.recomputeManagedPorts([8080]);

  const snap = await manager.probeManagedSessionHealth('ps-h2');
  // host stripped → probes only our own port; unhealthy because probe returned 500
  assert.strictEqual(calls[0], 'http://127.0.0.1:8080/steal');
  assert.strictEqual(snap.healthState, 'unhealthy');
});

test('probeManagedSessionHealth is a no-op without a health config or web port', async () => {
  const manager = makeManager({ httpProbe: async () => { throw new Error('should not probe'); } });
  await manager.launchManagedProgram({
    sessionId: 'ps-h3',
    workspaceSlug: 'team',
    config: { packageId: 'cli', runtimeType: 'cli', surfaces: ['logs', 'terminal'], ports: [], launch: 'echo hi', env: {}, health: null },
  });
  const snap = await manager.probeManagedSessionHealth('ps-h3');
  assert.strictEqual(snap.healthState, 'unknown');
});

test('runtime snapshot never leaks the health config object', async () => {
  const manager = makeManager({ httpProbe: async () => ({ ok: true, status: 200 }) });
  await manager.launchManagedProgram({
    sessionId: 'ps-h4',
    workspaceSlug: 'team',
    config: { packageId: 'web', runtimeType: 'web', surfaces: ['app'], ports: [3000], launch: 'x', env: {}, health: { type: 'http', target: '/h', intervalMs: 5000 } },
  });
  const snap = manager.getManagedSession('ps-h4');
  assert.strictEqual(snap.health, undefined);
  assert.strictEqual(snap.healthTimer, undefined);
  assert.strictEqual(snap.healthState, 'unknown');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: FAIL — `manager.probeManagedSessionHealth is not a function`.

- [ ] **Step 3: Implement health probing**

3a. Extend the manager `options` destructure (in `createProgramRuntimeManager`) to add the probe deps:

```js
    launchRuntime = null,
    getActivePorts = () => [],
    baseEnv = process.env,
    probeHost = process.env.PROXY_TARGET_HOST || '127.0.0.1',
    httpProbe = defaultHttpProbe,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
```

3b. Add module-level helpers (near `composeProgramCommand`):

```js
const HEALTH_MIN_INTERVAL_MS = 2000;
const HEALTH_DEFAULT_INTERVAL_MS = 10_000;

function clampHealthInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return HEALTH_DEFAULT_INTERVAL_MS;
  return Math.max(HEALTH_MIN_INTERVAL_MS, ms);
}

/** Coerce a manifest health target to a PATH only — never an absolute URL/host. */
function healthPath(target) {
  let path = String(target || '/').trim();
  path = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // strip scheme://host if present
  if (!path.startsWith('/')) path = `/${path}`;
  return path;
}

function defaultHttpProbe(url) {
  return new Promise((resolve) => {
    try {
      const req = require('http').get(url, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode });
      });
      req.setTimeout(2000, () => { req.destroy(); resolve({ ok: false, status: 0 }); });
      req.on('error', () => resolve({ ok: false, status: 0 }));
    } catch (_) {
      resolve({ ok: false, status: 0 });
    }
  });
}
```

3c. Inside `createProgramRuntimeManager`, add the probe + scheduler functions (place near `refreshManagedSessionPorts`):

```js
  function clearManagedHealthTimer(record) {
    if (record?.healthTimer) {
      clearIntervalFn(record.healthTimer);
      record.healthTimer = null;
    }
  }

  async function probeManagedSessionHealth(sessionId) {
    const record = managedSessions.get(sessionId);
    if (!record) {
      return null;
    }
    if (!record.health || record.health.type !== 'http' || !record.webPort || !RUNNING_STATES.includes(record.state)) {
      return toPublicManagedSession(record);
    }

    const url = `http://${probeHost}:${record.webPort}${healthPath(record.health.target)}`;
    let ok = false;
    try {
      const result = await httpProbe(url);
      ok = !!result && result.ok === true;
    } catch (_) {
      ok = false;
    }

    const nextState = ok ? 'ok' : 'unhealthy';
    if (record.healthState !== nextState) {
      record.healthState = nextState;
      appendManagedSessionEvent(record, 'health_changed', { healthState: nextState });
    }
    return toPublicManagedSession(record);
  }

  function scheduleManagedHealthCheck(record) {
    if (!record?.health || record.health.type !== 'http') {
      return;
    }
    clearManagedHealthTimer(record);
    const interval = clampHealthInterval(record.health.intervalMs);
    const timer = setIntervalFn(() => {
      probeManagedSessionHealth(record.sessionId).catch(() => {});
    }, interval);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
    record.healthTimer = timer;
  }
```

3d. Start the health check at the end of `launchManagedSession`, right after `record.idleTimer = scheduleManagedIdleTimer(sessionId);`:

```js
    record.idleTimer = scheduleManagedIdleTimer(sessionId);
    scheduleManagedHealthCheck(record);
```

3e. Clear the health timer wherever the idle timer is cleared on teardown — add `clearManagedHealthTimer(record);` next to `clearManagedIdleTimer(record);` inside both `finalizeManagedSessionExit` and `stopManagedSession`.

3f. Export `probeManagedSessionHealth` on the manager's returned object:

```js
    probeManagedSessionHealth,
    recomputeManagedPorts,
    refreshManagedSessionPorts,
```

3g. Add the module-level helpers to `module.exports` (for completeness/testing):

```js
  composeProgramCommand,
  attributeSessionPorts,
  selectWebPort,
  samePorts,
  healthPath,
  clampHealthInterval,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: PASS — all backend tests (8 original + Task 1/2/3 additions).

- [ ] **Step 5: Wire real probe deps in the server + syntax-check**

In `backend/collab-server/server.js`, add `probeHost`/`httpProbe` to the manager-creation options (they default sensibly, so this is optional but explicit). Leave `setInterval`/`clearInterval` defaults. Then:

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --check backend/collab-server/server.js`
Expected: no output (valid).

- [ ] **Step 6: Commit**

```bash
git add backend/collab-server/programRuntimeManager.js backend/collab-server/__tests__/programRuntimeManager.test.js backend/collab-server/server.js
git commit -m "feat(slice3-p3): injectable HTTP health probing (path-only, own-port)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Surface `lastHealthState` through the route merge

**Files:**
- Modify: `synthi/src/lib/programs/routeHelpers.js`
- Create (if absent): `synthi/src/lib/programs/__tests__/routeHelpers.test.js`
- Modify: `synthi/src/app/api/workspace/[slug]/program-sessions/__tests__/programSessionRoutes.test.js`

- [ ] **Step 1: Write the failing test**

If `synthi/src/lib/programs/__tests__/routeHelpers.test.js` does NOT exist, create it:

```js
import { describe, expect, it } from 'vitest';
import { mergeProgramSession } from '../routeHelpers';

describe('mergeProgramSession health surfacing', () => {
  it('surfaces the live runtime healthState as lastHealthState', () => {
    const merged = mergeProgramSession(
      { id: 'ps-1', state: 'starting', lastHealthState: null },
      { state: 'running', activePorts: [3000], webPort: 3000, healthState: 'ok' },
    );
    expect(merged.lastHealthState).toBe('ok');
    expect(merged.webPort).toBe(3000);
  });

  it('falls back to the persisted lastHealthState when the runtime has none', () => {
    const merged = mergeProgramSession(
      { id: 'ps-1', state: 'stopped', lastHealthState: 'unhealthy' },
      null,
    );
    expect(merged.lastHealthState).toBe('unhealthy');
  });

  it('is null when neither side has a health state', () => {
    const merged = mergeProgramSession({ id: 'ps-1', state: 'starting' }, { state: 'starting' });
    expect(merged.lastHealthState).toBeNull();
  });
});
```

(If the file already exists, add the `describe` block to it instead.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/routeHelpers.test.js`
Expected: FAIL — `merged.lastHealthState` is `undefined` (not surfaced yet).

- [ ] **Step 3: Implement the merge**

In `synthi/src/lib/programs/routeHelpers.js`, extend `mergeProgramSession`'s `merged` object:

```js
  const merged = {
    ...session,
    activePorts: Array.isArray(runtimeSession?.activePorts) ? [...runtimeSession.activePorts] : [],
    webPort: runtimeSession?.webPort ?? null,
    lastHealthState: runtimeSession?.healthState ?? session.lastHealthState ?? null,
  };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs/__tests__/routeHelpers.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Add a route-level assertion**

In `synthi/src/app/api/workspace/[slug]/program-sessions/__tests__/programSessionRoutes.test.js`, find the GET-by-id test whose `runtimeSession` mock includes `activePorts: [5173], webPort: 5173`. Add `healthState: 'ok'` to that mock and assert it surfaces:

```js
      runtimeSession: { sessionId: 'ps-1', workspaceSlug: 'team', state: 'running', activePorts: [5173], webPort: 5173, healthState: 'ok' },
```

and in the matching expectation:

```js
    expect(body.session).toMatchObject({ id: 'ps-1', state: 'running', activePorts: [5173], webPort: 5173, lastHealthState: 'ok' });
```

- [ ] **Step 6: Run the route suite**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/app/api/workspace/[slug]/program-sessions`
Expected: PASS (the existing program-session route tests, now asserting `lastHealthState`).

- [ ] **Step 7: Commit**

```bash
git add synthi/src/lib/programs/routeHelpers.js "synthi/src/lib/programs/__tests__/routeHelpers.test.js" "synthi/src/app/api/workspace/[slug]/program-sessions/__tests__/programSessionRoutes.test.js"
git commit -m "feat(slice3-p3): surface live healthState as lastHealthState in session merge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Polish the Program session tab (waiting App, actionable Ports, health badge)

**Files:**
- Modify: `synthi/src/components/programs/ProgramSessionPanel.jsx`
- Test: `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx`

- [ ] **Step 1: Write the failing tests**

Append three tests to `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx` (it already has the jsdom `createRoot`/`act` harness, the `h` hoisted mock, and a `flush()` helper). These rely on `data-testid` hooks added in Step 3:

```js
  it('shows a waiting-for-web-server state on the App tab while starting with no web port', async () => {
    h.fetchProgramSession.mockResolvedValue({ id: 'ps-1', state: 'starting', runtimeType: 'web', activePorts: [], webPort: null });
    await act(async () => {
      root.render(React.createElement(ProgramSessionPanel, { workspaceSlug: 'team', sessionId: 'ps-1', title: 'Web App' }));
    });
    await flush();

    expect(container.querySelector('[data-testid="app-waiting"]')).not.toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('lets the user set a detected port as the App surface', async () => {
    h.fetchProgramSession.mockResolvedValue({ id: 'ps-1', state: 'running', runtimeType: 'web', activePorts: [3000, 5173], webPort: 3000 });
    await act(async () => {
      root.render(React.createElement(ProgramSessionPanel, { workspaceSlug: 'team', sessionId: 'ps-1', title: 'Web App' }));
    });
    await flush();

    // Switch to the Ports tab, then "Set as App" for 5173.
    const portsTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent.includes('Ports'));
    await act(async () => { portsTab.click(); });
    const setApp = container.querySelector('[data-testid="set-app-port-5173"]');
    expect(setApp).not.toBeNull();
    await act(async () => { setApp.click(); });
    await flush();

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('src')).toContain('/port/5173/');
  });

  it('renders a health badge reflecting lastHealthState', async () => {
    h.fetchProgramSession.mockResolvedValue({ id: 'ps-1', state: 'running', runtimeType: 'web', activePorts: [3000], webPort: 3000, lastHealthState: 'unhealthy' });
    await act(async () => {
      root.render(React.createElement(ProgramSessionPanel, { workspaceSlug: 'team', sessionId: 'ps-1', title: 'Web App' }));
    });
    await flush();

    const badge = container.querySelector('[data-testid="health-badge"]');
    expect(badge).not.toBeNull();
    expect(badge.getAttribute('data-health')).toBe('unhealthy');
  });
```

> The existing `ProgramSessionPanel.test.jsx` mocks `@/services/programSessionClient` via the hoisted `h`. Ensure `h.getProgramSessionAppUrl` returns a URL containing the port — update the existing mock to `h.getProgramSessionAppUrl.mockImplementation((port) => (typeof port === 'number' ? \`http://localhost:1234/port/${port}/\` : null));` in `beforeEach` so the "Set as App" assertion can check the port in the src.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/ProgramSessionPanel.test.jsx`
Expected: FAIL — `app-waiting` / `set-app-port-5173` / `health-badge` testids not found (null).

- [ ] **Step 3: Implement the polish in `ProgramSessionPanel.jsx`**

3a. Add an App-port override state + a derived app URL near the existing `appUrl`/`ports` memo:

```js
  const [appPortOverride, setAppPortOverride] = useState(null);
  const effectiveWebPort = appPortOverride ?? session?.webPort ?? null;
  const appUrl = useMemo(() => getProgramSessionAppUrl(effectiveWebPort), [effectiveWebPort]);
  const ports = Array.isArray(session?.activePorts) ? session.activePorts : [];
  const healthState = session?.lastHealthState || 'unknown';
  const isStarting = ['starting', 'restarting'].includes(String(session?.state || '').toLowerCase());
```

(Remove the old `const appUrl = useMemo(...)` / `const ports = ...` lines this replaces.)

3b. In the header, next to the state chip, add a health badge:

```jsx
            {session?.state ? (
              <span className="px-1.5 py-0.5 rounded uppercase tracking-wider" style={stateTone(session.state)}>
                {session.state}
              </span>
            ) : null}
            <span
              data-testid="health-badge"
              data-health={healthState}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider"
              style={healthTone(healthState)}
            >
              <HeartPulse className="w-3 h-3" /> {healthState}
            </span>
```

Add a `healthTone` helper next to `stateTone`:

```js
function healthTone(state) {
  switch (String(state || '').toLowerCase()) {
    case 'ok':
      return { background: 'color-mix(in srgb, #4ade80 16%, transparent)', color: 'var(--text-primary)' };
    case 'unhealthy':
      return { background: 'color-mix(in srgb, #ff5757 18%, transparent)', color: 'var(--text-primary)' };
    default:
      return { background: 'var(--bg-elevated)', color: 'var(--text-secondary)' };
  }
}
```

3c. Replace the App-tab body so a starting session shows a waiting state instead of the generic "no web port" copy:

```jsx
        ) : activeTab === 'app' ? (
          appUrl ? (
            <iframe
              title={`${title} app`}
              src={appUrl}
              className="w-full h-full border-0"
              sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              allow="clipboard-read; clipboard-write"
            />
          ) : isStarting ? (
            <div data-testid="app-waiting" className="h-full flex flex-col items-center justify-center gap-2 text-sm px-6 text-center" style={{ color: 'var(--text-muted)' }}>
              <Globe className="w-5 h-5 opacity-60" />
              Waiting for the web server to start…
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-sm px-6 text-center" style={{ color: 'var(--text-muted)' }}>
              No web port is active for this session.
            </div>
          )
```

3d. Make the Ports tab actionable — replace the ports-list rows with Open + Set as App controls:

```jsx
            ) : ports.map((port) => (
              <div key={port} className="rounded-md border px-3 py-2 flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
                <span className="text-sm">Port {port}</span>
                <div className="flex items-center gap-2">
                  {port === effectiveWebPort ? (
                    <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'color-mix(in srgb, #60a5fa 18%, transparent)', color: 'var(--text-primary)' }}>App</span>
                  ) : (
                    <button
                      type="button"
                      data-testid={`set-app-port-${port}`}
                      onClick={() => { setAppPortOverride(port); setActiveTab('app'); }}
                      className="h-7 px-2 rounded border text-[11px]"
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                    >
                      Set as App
                    </button>
                  )}
                  <a
                    href={getProgramSessionAppUrl(port) || '#'}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`open-port-${port}`}
                    className="h-7 px-2 rounded border text-[11px] inline-flex items-center"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
                  >
                    Open
                  </a>
                </div>
              </div>
            ))}
```

3e. In the Health tab, drive the "Last health signal" line from `healthState` (instead of the raw `session?.lastHealthState`) so it shows `unknown` consistently:

```jsx
              <div className="mt-2 text-sm" data-testid="health-detail">{healthState === 'unknown' ? 'No health checks recorded yet' : healthState}</div>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/components/programs/__tests__/ProgramSessionPanel.test.jsx`
Expected: PASS — the 2 original tests + 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/ProgramSessionPanel.jsx "synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx"
git commit -m "feat(slice3-p3): program tab polish — app waiting, actionable ports, health badge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Phase-3 regression + security sweep + review

**Files:**
- Modify: `tasks/todo.md`

- [ ] **Step 1: Backend tests**

Run: `cd /c/Users/HP/source/repos/synthi-ide && node --test backend/collab-server/__tests__/programRuntimeManager.test.js`
Expected: PASS — 8 original + all Phase-3 additions (Tasks 1–3).

- [ ] **Step 2: Targeted frontend/lib suites**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run src/lib/programs src/app/api/workspace src/components/programs src/components/docking-wm`
Expected: PASS — all program/runtime suites green.

- [ ] **Step 3: Full regression**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx vitest run`
Expected: PASS — accept ONLY the known pre-existing empty `src/lib/__tests__/preview-store.test.js` stub failure ("No test suite found in file"). No other failures.

- [ ] **Step 4: Prisma (no schema change expected)**

Run: `cd /c/Users/HP/source/repos/synthi-ide/synthi && npx prisma generate && npx prisma db push`
Expected: client generated; db push → "The database is already in sync with the Prisma schema."

- [ ] **Step 5: Security checklist (confirm each is pinned by a Phase-3 test)**

Confirm and record in `tasks/todo.md`:
- Port attribution never cross-assigns a declared port to another session (declared∩detected per session); undeclared ports only go to a *single* no-declared running session, else dropped (Task 1 tests).
- Health probe targets ONLY `PROXY_HOST:<webPort>` + a path; a manifest-supplied scheme/host is stripped (`healthPath`) — verified by the `http://evil.example.com/steal → http://127.0.0.1:8080/steal` test (Task 3).
- Runtime snapshot never leaks `health` config, `healthTimer`, `runtime`, or `launchRequest` (env) — Task 3 leak test + existing `toPublicManagedSession` redaction.
- Inherited Phase-1/2 guards intact: env scrub, output cap, idle cull, kill switch, role/consent gates (unchanged code paths; regression green).

- [ ] **Step 6: Write the Phase-3 review section + mark tasks done in `tasks/todo.md`**

Add a "Slice 3 Phase 3 — COMPLETE" review block mirroring the Phase-2 format (what landed, verification numbers, deviations/forward notes), check off P3-T1..P3-T6, then commit:

```bash
git add tasks/todo.md
git commit -m "docs(slice3-p3): T6 regression + security sweep — Phase 3 complete

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (against the Phase-3 scope)

**1. Spec coverage** — "web-port auto-detection": Tasks 1–2 (attribution + live recompute wired to the scanner's `onPortsChanged`). "Polished Program tab UX": Task 5 (App waiting state, actionable Ports, health badge) + Task 3/4 (health pipeline feeding the badge). No marketplace/publishing (Phase 5) or GUI capture (Phase 4) — correctly out of scope.

**2. Placeholder scan** — every code step shows complete code; no TBD/"add error handling"/"similar to" placeholders. Server.js edits are localized and verified via `node --check` (the live scanner/network path can't be unit-tested under the disk gate, so the testable logic lives in pure/injectable helpers).

**3. Type consistency** — `attributeSessionPorts({ sessions, detectedPorts }) → Map<sessionId, number[]>`, `selectWebPort({runtimeType,surfaces,declaredPorts}, attributedPorts) → number|null`, `recomputeManagedPorts(detectedPorts) → snapshot[]`, `probeManagedSessionHealth(sessionId) → snapshot|null` with `healthState ∈ {unknown,ok,unhealthy}`. Snapshot field names (`activePorts`, `webPort`, `healthState`) are consistent across manager → `mergeProgramSession` (`lastHealthState`) → panel (`session.lastHealthState` → `healthState`). Record fields `declaredPorts`/`surfaces`/`health`/`healthState`/`healthTimer` are introduced in Task 2/3 and consumed consistently; `health`/`healthTimer` are excluded from the public snapshot in the same task they're introduced.

**4. Test independence** — backend tests construct a self-contained manager via `makeManager`/`makeFakePty`; frontend tests reuse the existing jsdom harness. No test depends on a live network, a real scanner, or Docker.
