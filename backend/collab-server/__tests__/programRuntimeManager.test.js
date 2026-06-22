'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProgramRuntimeManager,
  DEFAULT_HEADLESS_TTL_MS,
  composeProgramCommand,
  attributeSessionPorts,
  selectWebPort,
  samePorts,
} = require('../programRuntimeManager');

function createTimerHarness() {
  const timers = [];

  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = {
        callback,
        delay,
        cleared: false,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        },
      };

      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      if (timer) {
        timer.cleared = true;
      }
    },
  };
}

function createDisposable() {
  return {
    disposeCalls: 0,
    dispose() {
      this.disposeCalls += 1;
    },
  };
}

function createPty() {
  return {
    killCalls: 0,
    kill() {
      this.killCalls += 1;
    },
  };
}

function createManagedRuntimeHandle() {
  const dataListeners = [];
  const exitListeners = [];

  const ptyProcess = {
    killCalls: 0,
    onData(listener) {
      dataListeners.push(listener);
      return {
        dispose() {
          const index = dataListeners.indexOf(listener);
          if (index !== -1) {
            dataListeners.splice(index, 1);
          }
        },
      };
    },
    onExit(listener) {
      exitListeners.push(listener);
      return {
        dispose() {
          const index = exitListeners.indexOf(listener);
          if (index !== -1) {
            exitListeners.splice(index, 1);
          }
        },
      };
    },
    kill() {
      this.killCalls += 1;
    },
  };

  return {
    cwd: 'C:/workspace',
    shell: 'powershell.exe',
    ptyProcess,
    emitData(data) {
      for (const listener of [...dataListeners]) {
        listener(data);
      }
    },
    emitExit(payload) {
      for (const listener of [...exitListeners]) {
        listener(payload);
      }
    },
  };
}

// Phase 3: a self-contained manager with no real timers (port/health tests
// drive recompute/probe directly; injected timer fns are inert).
function makeManager(overrides = {}) {
  return createProgramRuntimeManager({
    activeSessions: new Map(),
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {},
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    now: () => 1000,
    launchRuntime: async () => createManagedRuntimeHandle(),
    getActivePorts: () => [],
    logger: { warn() {} },
    ...overrides,
  });
}

// Slice-1 (real programs) — the sysbox path stamps the runtime handle's scope onto
// the session, and pod-detected ports are attributed only within that scope.
test('launchManagedSession stamps runtimeScope from the runtime handle', async () => {
  const mgr = makeManager({ launchRuntime: async () => ({ ...createManagedRuntimeHandle(), runtimeScope: 'scope-1' }) });
  const s = await mgr.launchManagedSession({ sessionId: 'p1', workspaceSlug: 'w', command: 'docker compose up', runtimeType: 'container' });
  assert.equal(s.runtimeScope, 'scope-1');
});

test('recomputeRuntimeScopePorts attributes pod ports only to same-scope sessions', async () => {
  const mgr = makeManager({
    launchRuntime: async ({ sessionId }) => ({ ...createManagedRuntimeHandle(), runtimeScope: sessionId === 'p1' ? 'scope-1' : 'scope-2' }),
  });
  await mgr.launchManagedSession({ sessionId: 'p1', workspaceSlug: 'w', command: 'x', runtimeType: 'container' });
  await mgr.launchManagedSession({ sessionId: 'p2', workspaceSlug: 'w', command: 'x', runtimeType: 'container' });
  mgr.recomputeRuntimeScopePorts('scope-1', [3000]);
  assert.deepEqual(mgr.getManagedSession('p1').activePorts, [3000]);
  assert.deepEqual(mgr.getManagedSession('p2').activePorts, []);
});

// Convergence win (merge): the per-workspace dockerd inside the Sysbox pod
// listens on 2376 (TLS). It must never be attributed to a program as an "app
// port", so infra ports are filtered out of the pod scan before attribution.
test('recomputeRuntimeScopePorts drops infra ports (dockerd 2376) before attribution', async () => {
  const mgr = makeManager({
    launchRuntime: async () => ({ ...createManagedRuntimeHandle(), runtimeScope: 'scope-1' }),
  });
  await mgr.launchManagedSession({ sessionId: 'p1', workspaceSlug: 'w', command: 'x', runtimeType: 'container' });
  mgr.recomputeRuntimeScopePorts('scope-1', [2376, 8080]);
  assert.deepEqual(mgr.getManagedSession('p1').activePorts, [8080]);
});

// Slice 3 (GUI dev-tool streaming): a container program's webGui flag rides onto
// the session so the panel renders the interactive KasmVNC surface.
test('launchManagedSession carries webGui onto the public session', async () => {
  const mgr = makeManager();
  const s = await mgr.launchManagedSession({ sessionId: 'g1', workspaceSlug: 'w', command: 'docker run x', runtimeType: 'container', webGui: true });
  assert.equal(s.webGui, true);
});

test('launchManagedSession defaults webGui to false', async () => {
  const mgr = makeManager();
  const s = await mgr.launchManagedSession({ sessionId: 'g2', workspaceSlug: 'w', command: 'x', runtimeType: 'container' });
  assert.equal(s.webGui, false);
});

test('kills orphaned headless sessions after the TTL', () => {
  const activeSessions = new Map();
  const timers = createTimerHarness();
  const ptyProcess = createPty();
  const bufferDisposable = createDisposable();
  const warnings = [];
  const runtimeManager = createProgramRuntimeManager({
    activeSessions,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  const lifecycle = runtimeManager.createHeadlessSessionLifecycle('sess-1', {
    ptyProcess,
    bufferDisposable,
  });

  activeSessions.set('sess-1', {
    headless: true,
    ...lifecycle,
  });

  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].delay, DEFAULT_HEADLESS_TTL_MS);
  assert.equal(timers.timers[0].unrefCalled, true);

  timers.timers[0].callback();

  assert.equal(bufferDisposable.disposeCalls, 1);
  assert.equal(ptyProcess.killCalls, 1);
  assert.equal(activeSessions.has('sess-1'), false);
  assert.match(warnings[0], /Headless session sess-1 orphaned/);
});

test('does not reap a session that has already attached to a websocket', () => {
  const activeSessions = new Map();
  const timers = createTimerHarness();
  const ptyProcess = createPty();
  const bufferDisposable = createDisposable();
  const runtimeManager = createProgramRuntimeManager({
    activeSessions,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { warn() {} },
  });

  const lifecycle = runtimeManager.createHeadlessSessionLifecycle('sess-2', {
    ptyProcess,
    bufferDisposable,
  });

  activeSessions.set('sess-2', {
    headless: false,
    ...lifecycle,
  });

  timers.timers[0].callback();

  assert.equal(bufferDisposable.disposeCalls, 0);
  assert.equal(ptyProcess.killCalls, 0);
  assert.equal(activeSessions.has('sess-2'), true);
});

test('promoting a headless session clears the timer and stops buffering once', () => {
  const activeSessions = new Map();
  const timers = createTimerHarness();
  const bufferDisposable = createDisposable();
  const runtimeManager = createProgramRuntimeManager({
    activeSessions,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { warn() {} },
  });

  const lifecycle = runtimeManager.createHeadlessSessionLifecycle('sess-3', {
    ptyProcess: createPty(),
    bufferDisposable,
  });

  const session = {
    headless: true,
    ...lifecycle,
  };

  runtimeManager.promoteHeadlessSession(session);
  runtimeManager.promoteHeadlessSession(session);

  assert.equal(timers.timers[0].cleared, true);
  assert.equal(bufferDisposable.disposeCalls, 1);
});

test('launchManagedSession scrubs env, tracks output, and captures ports', async () => {
  let nowMs = 10_000;
  const activeSessions = new Map();
  const timers = createTimerHarness();
  const runtime = createManagedRuntimeHandle();
  const launches = [];
  const runtimeManager = createProgramRuntimeManager({
    activeSessions,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    idleTtlMs: 5_000,
    outputCap: 5,
    now: () => nowMs,
    launchRuntime: async (launchSpec) => {
      launches.push(launchSpec);
      return runtime;
    },
    getActivePorts: () => [5173, 3000, 3000],
    logger: { warn() {} },
  });

  const session = await runtimeManager.launchManagedSession({
    sessionId: 'ps-1',
    workspaceSlug: 'team',
    userId: 'user-1',
    command: 'npm run dev',
    env: {
      SAFE_FLAG: '1',
      DATABASE_URL: 'postgres://secret',
      DOCKER_HOST: 'unix:///var/run/docker.sock',
      CUSTOM_SOCKET: '/var/run/docker.sock',
    },
  });

  assert.equal(session.sessionId, 'ps-1');
  assert.equal(session.state, 'starting');
  assert.equal(launches.length, 1);
  assert.equal(launches[0].env.SAFE_FLAG, '1');
  assert.equal('DATABASE_URL' in launches[0].env, false);
  assert.equal('DOCKER_HOST' in launches[0].env, false);
  assert.equal('CUSTOM_SOCKET' in launches[0].env, false);
  assert.equal(timers.timers[0].delay, 5_000);

  nowMs += 100;
  runtime.emitData('1234');
  nowMs += 100;
  runtime.emitData('567');

  const afterOutput = runtimeManager.getManagedSession('ps-1');
  assert.equal(afterOutput.state, 'running');
  assert.equal(afterOutput.output, '34567');
  assert.equal(afterOutput.outputTruncated, true);

  const withPorts = await runtimeManager.refreshManagedSessionPorts('ps-1');
  assert.deepEqual(withPorts.activePorts, [3000, 5173]);
  assert.equal(withPorts.webPort, 3000);

  const events = runtimeManager.listManagedSessionEvents('ps-1');
  assert.deepEqual(events.map((event) => event.type), [
    'launched',
    'state_changed',
    'output_truncated',
    'ports_updated',
  ]);
  assert.equal(events[0].data.command, undefined);
  assert.equal(events[0].data.env, undefined);
});

test('restartManagedSession relaunches the runtime and stopManagedSession kills it', async () => {
  const activeSessions = new Map();
  const timers = createTimerHarness();
  const runtimeA = createManagedRuntimeHandle();
  const runtimeB = createManagedRuntimeHandle();
  const launches = [];
  const runtimeManager = createProgramRuntimeManager({
    activeSessions,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => 20_000,
    launchRuntime: async (launchSpec) => {
      launches.push(launchSpec);
      return launches.length === 1 ? runtimeA : runtimeB;
    },
    getActivePorts: () => [],
    logger: { warn() {} },
  });

  await runtimeManager.launchManagedSession({
    sessionId: 'ps-2',
    workspaceSlug: 'team',
    userId: 'user-1',
    command: 'npm run dev',
  });

  const restarted = await runtimeManager.restartManagedSession('ps-2');

  assert.equal(runtimeA.ptyProcess.killCalls, 1);
  assert.equal(launches.length, 2);
  assert.equal(restarted.sessionId, 'ps-2');
  assert.equal(restarted.state, 'starting');

  const stopped = await runtimeManager.stopManagedSession('ps-2', { reason: 'user_stop' });

  assert.equal(runtimeB.ptyProcess.killCalls, 1);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.stopReason, 'user_stop');
});

test('idle culls inactive managed sessions and runtime exits mark crashes', async () => {
  let nowMs = 30_000;
  const activeSessions = new Map();
  const timers = createTimerHarness();
  const runtime = createManagedRuntimeHandle();
  const runtimeManager = createProgramRuntimeManager({
    activeSessions,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    idleTtlMs: 5_000,
    now: () => nowMs,
    launchRuntime: async () => runtime,
    getActivePorts: () => [],
    logger: { warn() {} },
  });

  await runtimeManager.launchManagedSession({
    sessionId: 'ps-3',
    workspaceSlug: 'team',
    userId: 'user-1',
    command: 'npm run dev',
  });

  nowMs += 6_000;
  await timers.timers[0].callback();

  const culled = runtimeManager.getManagedSession('ps-3');
  assert.equal(runtime.ptyProcess.killCalls, 1);
  assert.equal(culled.state, 'stopped');
  assert.equal(culled.stopReason, 'idle_cull');

  const runtime2 = createManagedRuntimeHandle();
  const runtimeManager2 = createProgramRuntimeManager({
    activeSessions,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => nowMs,
    launchRuntime: async () => runtime2,
    getActivePorts: () => [],
    logger: { warn() {} },
  });

  await runtimeManager2.launchManagedSession({
    sessionId: 'ps-4',
    workspaceSlug: 'team',
    userId: 'user-1',
    command: 'npm run dev',
  });
  runtime2.emitExit({ exitCode: 1 });

  const crashed = runtimeManager2.getManagedSession('ps-4');
  assert.equal(crashed.state, 'crashed');
  assert.equal(crashed.exitCode, 1);
});

test('composeProgramCommand sequences workingDir, install steps, then launch', () => {
  assert.equal(
    composeProgramCommand({ workingDir: 'apps/web', install: ['npm ci', 'npm run build'], launch: 'npm run dev' }),
    'cd "apps/web" && npm ci && npm run build && npm run dev',
  );
  assert.equal(composeProgramCommand({ install: [], launch: './run.sh' }), './run.sh');
  assert.equal(composeProgramCommand({ launch: 'serve' }), 'serve');
});

test('launchManagedProgram composes the recipe, scrubs declared env, and seeds declared ports', async () => {
  const activeSessions = new Map();
  const timers = createTimerHarness();
  const runtime = createManagedRuntimeHandle();
  const launches = [];
  const runtimeManager = createProgramRuntimeManager({
    activeSessions,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => 40_000,
    launchRuntime: async (spec) => {
      launches.push(spec);
      return runtime;
    },
    getActivePorts: () => [],
    logger: { warn() {} },
  });

  const session = await runtimeManager.launchManagedProgram({
    sessionId: 'ps-prog',
    workspaceSlug: 'team',
    userId: 'u1',
    config: {
      packageId: 'web',
      version: '1.0.0',
      displayName: 'Web',
      runtimeType: 'web',
      workingDir: 'apps/web',
      install: ['npm ci'],
      launch: 'npm run dev',
      env: { SAFE: '1', DATABASE_URL: 'postgres://secret' },
      ports: [3000],
      surfaces: [],
      health: null,
      permissions: ['program.launch'],
      source: 'vectant.programs.json',
      sourceHints: {},
    },
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, 'cd "apps/web" && npm ci && npm run dev');
  assert.equal(launches[0].env.SAFE, '1');
  assert.equal('DATABASE_URL' in launches[0].env, false);
  assert.equal(launches[0].runtimeType, 'web');
  assert.equal(session.title, 'Web');
  assert.deepEqual(session.activePorts, [3000]);
  assert.equal(session.webPort, 3000);
});

// ── Phase 3: port attribution + web-port selection (pure helpers) ──

test('attributeSessionPorts assigns declared∩detected ports per session', () => {
  const sessions = [
    { sessionId: 'a', state: 'running', declaredPorts: [3000] },
    { sessionId: 'b', state: 'running', declaredPorts: [5173] },
  ];
  const map = attributeSessionPorts({ sessions, detectedPorts: [3000, 5173, 9999] });
  assert.deepEqual(map.get('a'), [3000]);
  assert.deepEqual(map.get('b'), [5173]);
});

test('attributeSessionPorts gives undeclared detected ports to the single no-declared running session', () => {
  const sessions = [
    { sessionId: 'a', state: 'running', declaredPorts: [3000] },
    { sessionId: 'b', state: 'running', declaredPorts: [] },
  ];
  const map = attributeSessionPorts({ sessions, detectedPorts: [3000, 5173] });
  assert.deepEqual(map.get('a'), [3000]);
  assert.deepEqual(map.get('b'), [5173]);
});

test('attributeSessionPorts leaves undeclared ports unattributed when ambiguous', () => {
  const sessions = [
    { sessionId: 'a', state: 'running', declaredPorts: [] },
    { sessionId: 'b', state: 'running', declaredPorts: [] },
  ];
  const map = attributeSessionPorts({ sessions, detectedPorts: [5173] });
  assert.deepEqual(map.get('a'), []);
  assert.deepEqual(map.get('b'), []);
});

test('attributeSessionPorts ignores stopped sessions', () => {
  const sessions = [
    { sessionId: 'a', state: 'stopped', declaredPorts: [3000] },
    { sessionId: 'b', state: 'running', declaredPorts: [] },
  ];
  const map = attributeSessionPorts({ sessions, detectedPorts: [3000] });
  assert.equal(map.has('a'), false);
  // 3000 is declared by a stopped session → not claimed → undeclared fallback to b
  assert.deepEqual(map.get('b'), [3000]);
});

test('selectWebPort prefers a declared-live port, else the lowest attributed port', () => {
  assert.equal(selectWebPort({ declaredPorts: [8080] }, [3000, 8080]), 8080);
  assert.equal(selectWebPort({ declaredPorts: [] }, [5173, 3000]), 3000);
});

test('selectWebPort returns null only when there are no attributed ports', () => {
  assert.equal(selectWebPort({ declaredPorts: [] }, []), null);
  assert.equal(selectWebPort({ declaredPorts: [3000] }, [3000]), 3000);
});

test('samePorts compares ordered port lists', () => {
  assert.equal(samePorts([3000, 5173], [3000, 5173]), true);
  assert.equal(samePorts([3000], [3000, 5173]), false);
  assert.equal(samePorts([5173, 3000], [3000, 5173]), false);
});

// ── Phase 3: continuous per-session port recompute ──

test('recomputeManagedPorts detects a live port for a launched program and emits ports_updated once per change', async () => {
  const manager = makeManager();
  await manager.launchManagedProgram({
    sessionId: 'ps-1',
    workspaceSlug: 'team',
    config: { packageId: 'web', runtimeType: 'web', ports: [], launch: 'npm run dev', env: {} },
  });

  let snap = manager.getManagedSession('ps-1');
  assert.deepEqual(snap.activePorts, []);
  assert.equal(snap.webPort, null);

  const updated = manager.recomputeManagedPorts([3000]);
  assert.equal(updated.length, 1);
  snap = manager.getManagedSession('ps-1');
  assert.deepEqual(snap.activePorts, [3000]);
  assert.equal(snap.webPort, 3000);

  // idempotent — same detection → no new snapshot/event
  assert.equal(manager.recomputeManagedPorts([3000]).length, 0);
  assert.equal(manager.listManagedSessionEvents('ps-1').filter((e) => e.type === 'ports_updated').length, 1);
});

test('recomputeManagedPorts keeps a declared port and ignores foreign detected ports', async () => {
  const manager = makeManager();
  await manager.launchManagedProgram({
    sessionId: 'ps-2',
    workspaceSlug: 'team',
    config: { packageId: 'app', runtimeType: 'web', ports: [8080], launch: 'npm start', env: {} },
  });
  // 9999 is foreign and there is no no-declared session → dropped.
  manager.recomputeManagedPorts([8080, 9999]);
  const snap = manager.getManagedSession('ps-2');
  assert.deepEqual(snap.activePorts, [8080]);
  assert.equal(snap.webPort, 8080);
});

// ── Phase 3: injectable HTTP health probing ──

test('probeManagedSessionHealth flips healthState to ok and emits health_changed', async () => {
  const calls = [];
  const manager = makeManager({
    probeHost: '127.0.0.1',
    httpProbe: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
  });
  await manager.launchManagedProgram({
    sessionId: 'ps-h1',
    workspaceSlug: 'team',
    config: { packageId: 'web', runtimeType: 'web', ports: [3000], launch: 'npm run dev', env: {}, health: { type: 'http', target: '/healthz', intervalMs: 5000 } },
  });

  const snap = await manager.probeManagedSessionHealth('ps-h1');
  assert.equal(snap.healthState, 'ok');
  assert.equal(calls[0], 'http://127.0.0.1:3000/healthz');
  assert.equal(manager.listManagedSessionEvents('ps-h1').filter((e) => e.type === 'health_changed').length, 1);
});

test('probeManagedSessionHealth treats the target as a path and never honours a manifest host', async () => {
  const calls = [];
  const manager = makeManager({
    probeHost: '127.0.0.1',
    httpProbe: async (url) => { calls.push(url); return { ok: false, status: 500 }; },
  });
  await manager.launchManagedProgram({
    sessionId: 'ps-h2',
    workspaceSlug: 'team',
    config: { packageId: 'web', runtimeType: 'web', ports: [8080], launch: 'x', env: {}, health: { type: 'http', target: 'http://evil.example.com/steal', intervalMs: 5000 } },
  });

  const snap = await manager.probeManagedSessionHealth('ps-h2');
  assert.equal(calls[0], 'http://127.0.0.1:8080/steal'); // host stripped, own port used
  assert.equal(snap.healthState, 'unhealthy');
});

test('probeManagedSessionHealth is a no-op without a health config or web port', async () => {
  const manager = makeManager({ httpProbe: async () => { throw new Error('should not probe'); } });
  await manager.launchManagedProgram({
    sessionId: 'ps-h3',
    workspaceSlug: 'team',
    config: { packageId: 'cli', runtimeType: 'cli', ports: [], launch: 'echo hi', env: {}, health: null },
  });
  const snap = await manager.probeManagedSessionHealth('ps-h3');
  assert.equal(snap.healthState, 'unknown');
});

test('runtime snapshot never leaks the health config object', async () => {
  const manager = makeManager({ httpProbe: async () => ({ ok: true, status: 200 }) });
  await manager.launchManagedProgram({
    sessionId: 'ps-h4',
    workspaceSlug: 'team',
    config: { packageId: 'web', runtimeType: 'web', ports: [3000], launch: 'x', env: {}, health: { type: 'http', target: '/h', intervalMs: 5000 } },
  });
  const snap = manager.getManagedSession('ps-h4');
  assert.equal(snap.health, undefined);
  assert.equal(snap.healthTimer, undefined);
  assert.equal(snap.healthState, 'unknown');
});

test('buildManagedRuntimeEnv strips any recipe-supplied DOCKER_HOST (container provides it by inheritance)', () => {
  const { buildManagedRuntimeEnv } = require('../programRuntimeManager');
  // A program must never be able to choose the Docker endpoint via env. Container
  // programs inherit the runtime-container image's own rootless DOCKER_HOST, so a
  // recipe-supplied DOCKER_HOST is always scrubbed — including TCP daemon APIs and
  // the host socket, which a value-only denylist would miss.
  for (const dh of [
    'unix:///run/user/1000/docker.sock', // even the "good" value is dropped — comes from the image instead
    'unix:///var/run/docker.sock',       // host socket
    'tcp://host.docker.internal:2375',   // host Docker REST API
    'tcp://172.17.0.1:2375',             // docker bridge gateway
  ]) {
    const out = buildManagedRuntimeEnv({}, { DOCKER_HOST: dh });
    assert.equal(out.DOCKER_HOST, undefined, `DOCKER_HOST=${dh} must be stripped`);
  }

  // DOCKER_SOCKET / DOCKER_CERT_PATH stay fully blocked by key too.
  const sock = buildManagedRuntimeEnv({}, { DOCKER_SOCKET: '/run/user/1000/docker.sock', DOCKER_CERT_PATH: '/x' });
  assert.equal(sock.DOCKER_SOCKET, undefined);
  assert.equal(sock.DOCKER_CERT_PATH, undefined);
});

// ── Stream auto-login: per-session KasmVNC credential (Task 2) ──

test('webGui container launch injects a random KASM_PASSWORD and exposes kasmAuth via resolveStreamAuth', async () => {
  const launches = [];
  const mgr = makeManager({ launchRuntime: async (spec) => { launches.push(spec); return createManagedRuntimeHandle(); } });

  const s = await mgr.launchManagedSession({
    sessionId: 'g1', workspaceSlug: 'wsa', command: 'docker run x',
    runtimeType: 'container', webGui: true, ports: [6901],
  });

  // injected into the env handed to launchRuntime (for the `-e KASM_PASSWORD` passthrough)
  assert.match(launches[0].env.KASM_PASSWORD, /^[A-Za-z0-9]{24}$/);
  // resolvable by slug + declared port, user is the gui-base default
  const auth = mgr.resolveStreamAuth('wsa', 6901);
  assert.equal(auth.user, 'vectant');
  assert.equal(auth.password, launches[0].env.KASM_PASSWORD);
  // SECURITY: the public snapshot (sent to the browser) must never carry the secret
  assert.equal(s.kasmAuth, undefined);
  assert.equal(mgr.getManagedSession('g1').kasmAuth, undefined);
});

test('resolveStreamAuth returns null for non-webGui or non-container sessions', async () => {
  const mgr = makeManager();
  await mgr.launchManagedSession({ sessionId: 'c1', workspaceSlug: 'wsb', command: 'x', runtimeType: 'container', webGui: false, ports: [9000] });
  await mgr.launchManagedSession({ sessionId: 'w1', workspaceSlug: 'wsc', command: 'x', runtimeType: 'web', webGui: true, ports: [3000] });
  assert.equal(mgr.resolveStreamAuth('wsb', 9000), null);
  assert.equal(mgr.resolveStreamAuth('wsc', 3000), null);
});

test('resolveStreamAuth matches on port and stops resolving after the session stops', async () => {
  const mgr = makeManager();
  await mgr.launchManagedSession({ sessionId: 'g2', workspaceSlug: 'wsd', command: 'x', runtimeType: 'container', webGui: true, ports: [6902] });
  assert.equal(mgr.resolveStreamAuth('wsd', 6901), null);   // wrong port
  assert.ok(mgr.resolveStreamAuth('wsd', 6902));            // right port
  assert.equal(mgr.resolveStreamAuth('other', 6902), null); // wrong slug

  await mgr.stopManagedSession('g2', { reason: 'user_stop' });
  assert.equal(mgr.resolveStreamAuth('wsd', 6902), null);   // stopped → gone
});

test('a regular (non-webGui) container launch does not inject KASM_PASSWORD', async () => {
  const launches = [];
  const mgr = makeManager({ launchRuntime: async (spec) => { launches.push(spec); return createManagedRuntimeHandle(); } });
  await mgr.launchManagedSession({ sessionId: 'p1', workspaceSlug: 'w', command: 'x', runtimeType: 'container', webGui: false, ports: [9000] });
  assert.equal('KASM_PASSWORD' in launches[0].env, false);
});

test('restarting a webGui container session preserves webGui and rotates the credential', async () => {
  const mgr = makeManager();
  await mgr.launchManagedSession({ sessionId: 'g3', workspaceSlug: 'wse', command: 'docker run x', runtimeType: 'container', webGui: true, ports: [6901] });
  const before = mgr.resolveStreamAuth('wse', 6901);
  assert.ok(before);

  const restarted = await mgr.restartManagedSession('g3');
  assert.equal(restarted.webGui, true);              // webGui must survive restart (behavior guarantee #3)
  const after = mgr.resolveStreamAuth('wse', 6901);
  assert.ok(after);                                  // still resolvable after restart
  assert.notEqual(after.password, before.password);  // rotated, not reused
});
