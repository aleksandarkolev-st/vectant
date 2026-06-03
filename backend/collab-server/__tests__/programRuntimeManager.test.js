'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProgramRuntimeManager,
  DEFAULT_HEADLESS_TTL_MS,
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