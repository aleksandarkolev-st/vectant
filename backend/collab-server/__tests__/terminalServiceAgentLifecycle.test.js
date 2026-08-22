'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const {
  activeSessions,
  createTerminalWSS,
} = require('../terminalService');

const ACCESS_TOKEN = `csa_${'t'.repeat(40)}`;
const PROVIDER_SESSION_REF = 'provider-session-private-1';

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.frames = [];
    this.closes = [];
  }

  send(value, options) {
    this.frames.push({ value, options });
  }

  close(code, reason) {
    this.readyState = WebSocket.CLOSED;
    this.closes.push({ code, reason });
  }
}

class FakePty {
  constructor() {
    this.pid = 4321;
    this.dataListeners = new Set();
    this.exitListeners = new Set();
    this.killed = false;
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitExit(exitCode = 0, signal = 0) {
    for (const listener of [...this.exitListeners]) listener({ exitCode, signal });
  }

  write() {}
  resize() {}
  kill() { this.killed = true; }
}

function gatewayAuth(overrides = {}) {
  return Object.freeze({
    source: 'gateway',
    workspaceSlug: 'team',
    actorUserId: 'owner-1',
    workspaceUserId: 'member-1',
    filesystemUserId: 'shared-owner',
    runtimeScope: 'ws-team-collab-1',
    collabSessionId: 'collab-1',
    agentBinding: Object.freeze({
      projectId: 'project-1',
      provider: 'codex',
      providerSessionRef: PROVIDER_SESSION_REF,
    }),
    ...overrides,
  });
}

function request(auth = gatewayAuth(), sessionId = '') {
  const params = new URLSearchParams({
    workspace: 'team',
    userId: auth.workspaceUserId,
    filesystemUserId: auth.filesystemUserId,
    runtimeScope: auth.runtimeScope,
    cols: '100',
    rows: '30',
  });
  if (sessionId) params.set('sessionId', sessionId);
  return {
    url: `/terminal?${params}`,
    headers: {},
    collabGatewayAuth: auth,
  };
}

function attachResponse(input) {
  return {
    resumed: false,
    agentAccessToken: ACCESS_TOKEN,
    session: {
      id: 'agent-1',
      displayCallsign: 'CODEX-01',
      activeMutationLeaseId: null,
      activeTransactionId: null,
    },
    binding: {
      agentSessionId: 'agent-1',
      projectId: 'project-1',
      collaborationSessionId: 'collab-1',
      ownerUserId: 'owner-1',
      collaborationUserId: 'member-1',
      effectiveWorkspaceUserId: 'shared-owner',
      terminalSessionId: input.terminalSessionId,
      runtimeSessionId: null,
      runtimeScope: 'ws-team-collab-1',
      agentProvider: 'codex',
      providerSessionRef: PROVIDER_SESSION_REF,
    },
  };
}

function harness(serviceOverrides = {}, dependencyOverrides = {}) {
  const events = [];
  const ptys = [];
  const service = {
    attach: async (input) => {
      events.push({ type: 'attach', input });
      return attachResponse(input);
    },
    heartbeat: async (input) => { events.push({ type: 'heartbeat', input }); return {}; },
    detach: async (input) => { events.push({ type: 'detach', input }); return {}; },
    ...serviceOverrides,
  };
  const terminal = createTerminalWSS({
    agentSessionAttachService: service,
    ensureRuntimeFilesystemImpl: async () => ({ activeWorkspaceRoot: 'C:\\workspace' }),
    releaseRuntimeFilesystemImpl: async () => {},
    buildRuntimeLaunchImpl: async () => ({
      env: { BASE_ENV: 'present' },
      releasePort() {},
    }),
    createTerminalProcessImpl: async (input) => {
      events.push({ type: 'spawn', input });
      const ptyProcess = new FakePty();
      ptys.push(ptyProcess);
      return { ptyProcess, shell: 'pwsh.exe' };
    },
    watchWorkspaceImpl: () => () => {},
    ...dependencyOverrides,
  });
  return { ...terminal, events, ptys, service };
}

function textFrames(ws) {
  return ws.frames
    .map((frame) => frame.value)
    .filter((value) => typeof value === 'string')
    .join('\n');
}

test.before(() => {
  process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://frontend.test/api/workspace/{workspace_slug}/codesite';
});

test.afterEach(() => {
  for (const session of activeSessions.values()) {
    if (session.codeSiteAgentLifecycle?.heartbeatTimer) {
      clearInterval(session.codeSiteAgentLifecycle.heartbeatTimer);
    }
  }
  activeSessions.clear();
});

test.after(() => {
  delete process.env.SYNTHI_CODESITE_API_BASE_URL;
});

test('agent terminal attaches before spawn and injects only the scoped child credential', async () => {
  const { handleTerminalConnection, events, ptys } = harness();
  const ws = new FakeWebSocket();
  await handleTerminalConnection(ws, request());

  assert.deepEqual(events.map((event) => event.type).slice(0, 2), ['attach', 'spawn']);
  const attach = events.find((event) => event.type === 'attach');
  const spawn = events.find((event) => event.type === 'spawn');
  assert.equal(attach.input.rotateAgentAccessToken, true);
  assert.equal(spawn.input.env.SYNTHI_CODESITE_AGENT_SESSION_ID, 'agent-1');
  assert.equal(spawn.input.env.SYNTHI_CODESITE_AGENT_TOKEN, ACCESS_TOKEN);
  assert.equal(spawn.input.env.SYNTHI_CODESITE_PROJECT_ID, 'project-1');
  assert.equal(spawn.input.env.SYNTHI_CODESITE_WORKSPACE, 'team');
  assert.equal(spawn.input.env.SYNTHI_CODESITE_API_BASE_URL, 'http://frontend.test/api/workspace/team/codesite');
  assert.equal(spawn.input.env.BASE_ENV, 'present');
  assert.equal(textFrames(ws).includes(ACCESS_TOKEN), false);
  assert.equal(textFrames(ws).includes(PROVIDER_SESSION_REF), false);
  assert.equal([...activeSessions.values()][0].codeSiteAgentBinding.displayCallsign, 'CODEX-01');

  ptys[0].emitExit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === 'detach').length, 1);
});

test('ordinary terminal skips agent lifecycle and receives no scoped agent environment', async () => {
  const { handleTerminalConnection, events, ptys } = harness();
  const ws = new FakeWebSocket();
  await handleTerminalConnection(ws, request(gatewayAuth({ agentBinding: null })));

  assert.equal(events.filter((event) => event.type === 'attach').length, 0);
  const spawn = events.find((event) => event.type === 'spawn');
  assert.equal(Object.hasOwn(spawn.input.env, 'SYNTHI_CODESITE_AGENT_TOKEN'), false);
  ptys[0].emitExit();
});

test('retained terminal reattach reuses the PTY without rotating or re-registering the agent', async () => {
  const { handleTerminalConnection, events, ptys } = harness();
  const firstWs = new FakeWebSocket();
  await handleTerminalConnection(firstWs, request());
  const ready = firstWs.frames.map((frame) => frame.value).find((value) => typeof value === 'string' && value.includes('"type":"ready"'));
  const sessionId = JSON.parse(ready).sessionId;
  firstWs.emit('close', 1006);
  assert.equal(events.filter((event) => event.type === 'detach').length, 0);

  const secondWs = new FakeWebSocket();
  await handleTerminalConnection(secondWs, request(gatewayAuth(), sessionId));

  assert.equal(events.filter((event) => event.type === 'attach').length, 1);
  assert.equal(events.filter((event) => event.type === 'spawn').length, 1);
  assert.equal(activeSessions.get(sessionId).pty, ptys[0]);
  assert.equal(secondWs.closes.length, 0);
  ptys[0].emitExit();
});

test('mismatched signed owner cannot take over a retained agent terminal', async () => {
  const { handleTerminalConnection, events, ptys } = harness();
  const firstWs = new FakeWebSocket();
  await handleTerminalConnection(firstWs, request());
  const sessionId = [...activeSessions.keys()][0];
  firstWs.emit('close', 1006);

  const deniedWs = new FakeWebSocket();
  await handleTerminalConnection(deniedWs, request(gatewayAuth({ actorUserId: 'owner-2' }), sessionId));

  assert.equal(deniedWs.closes[0].code, 1008);
  assert.equal(events.filter((event) => event.type === 'spawn').length, 1);
  assert.equal(activeSessions.get(sessionId).pty, ptys[0]);
  assert.equal(textFrames(deniedWs).includes('owner-2'), false);
  ptys[0].emitExit();
});

test('spawn failure compensates the successful attachment without leaking failure details', async () => {
  const secretDetail = `${ACCESS_TOKEN}:${PROVIDER_SESSION_REF}`;
  const { handleTerminalConnection, events } = harness({}, {
    createTerminalProcessImpl: async () => { throw new Error(secretDetail); },
  });
  const ws = new FakeWebSocket();
  await handleTerminalConnection(ws, request());

  assert.deepEqual(events.map((event) => event.type), ['attach', 'detach']);
  assert.equal(events[1].input.reason, 'terminal_spawn_failed');
  assert.equal(events[1].input.ended, true);
  assert.equal(textFrames(ws).includes(ACCESS_TOKEN), false);
  assert.equal(textFrames(ws).includes(PROVIDER_SESSION_REF), false);
  assert.equal(activeSessions.size, 0);
});

test('watcher failure kills the spawned PTY and compensates the attachment', async () => {
  const { handleTerminalConnection, events, ptys } = harness({}, {
    watchWorkspaceImpl: () => { throw new Error(`${ACCESS_TOKEN}:${PROVIDER_SESSION_REF}`); },
  });
  const ws = new FakeWebSocket();
  await handleTerminalConnection(ws, request());

  assert.deepEqual(events.map((event) => event.type), ['attach', 'spawn', 'detach']);
  assert.equal(events[2].input.reason, 'terminal_watcher_failed');
  assert.equal(ptys[0].killed, true);
  assert.equal(activeSessions.size, 0);
  assert.equal(textFrames(ws).includes(ACCESS_TOKEN), false);
  assert.equal(textFrames(ws).includes(PROVIDER_SESSION_REF), false);
});

test('attach failure creates no filesystem or process and exposes only a bounded error', async () => {
  let filesystemCalls = 0;
  const { handleTerminalConnection, events } = harness({
    attach: async () => { throw new Error(`${ACCESS_TOKEN}:${PROVIDER_SESSION_REF}`); },
  }, {
    ensureRuntimeFilesystemImpl: async () => { filesystemCalls += 1; return {}; },
  });
  const ws = new FakeWebSocket();
  await handleTerminalConnection(ws, request());

  assert.equal(filesystemCalls, 0);
  assert.equal(events.length, 0);
  assert.equal(ws.closes[0].code, 1008);
  assert.equal(textFrames(ws).includes(ACCESS_TOKEN), false);
  assert.equal(textFrames(ws).includes(PROVIDER_SESSION_REF), false);
});
