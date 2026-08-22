'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  agentReattachBindingFromGateway,
  attachTerminalAgent,
  finalizeAgentTerminal,
  normalizeTerminalAgentBinding,
  startAgentTerminalHeartbeat,
} = require('../agentTerminalLifecycle');

const ACCESS_TOKEN = `csa_${'a'.repeat(40)}`;

function gatewayAuth(overrides = {}) {
  return {
    source: 'gateway',
    workspaceSlug: 'team',
    actorUserId: 'owner-1',
    workspaceUserId: 'member-1',
    filesystemUserId: 'shared-owner',
    runtimeScope: 'ws-team-collab-1',
    collabSessionId: 'collab-1',
    agentBinding: {
      projectId: 'project-1',
      provider: 'codex',
      providerSessionRef: 'provider-session-1',
    },
    ...overrides,
  };
}

function attachResult(overrides = {}) {
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
      terminalSessionId: 'terminal-1',
      runtimeSessionId: null,
      runtimeScope: 'ws-team-collab-1',
      agentProvider: 'codex',
      providerSessionRef: 'provider-session-1',
    },
    ...overrides,
  };
}

test('attaches a trusted terminal and returns only its scoped process environment', async () => {
  const calls = [];
  const service = {
    attach: async (input) => { calls.push(input); return attachResult(); },
    heartbeat: async () => ({}),
    detach: async () => ({}),
  };
  const attached = await attachTerminalAgent({
    service,
    gatewayAuth: gatewayAuth(),
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
    resolveBaseUrl: () => 'http://frontend.test/api/workspace/team/codesite',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].terminalSessionId, 'terminal-1');
  assert.equal(calls[0].rotateAgentAccessToken, true);
  assert.equal(attached.binding.displayCallsign, 'CODEX-01');
  assert.deepEqual(attached.scopedEnv, {
    SYNTHI_CODESITE_AGENT_SESSION_ID: 'agent-1',
    SYNTHI_CODESITE_AGENT_TOKEN: ACCESS_TOKEN,
    SYNTHI_CODESITE_WORKSPACE: 'team',
    SYNTHI_WORKSPACE_SLUG: 'team',
    SYNTHI_CODESITE_PROJECT_ID: 'project-1',
    SYNTHI_CODESITE_API_BASE_URL: 'http://frontend.test/api/workspace/team/codesite',
  });
  assert.equal(JSON.stringify(attached.binding).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(attached.state).includes(ACCESS_TOKEN), false);
});

test('ordinary terminals skip the lifecycle service and receive no agent environment', async () => {
  let attachCalls = 0;
  const result = await attachTerminalAgent({
    service: { attach: async () => { attachCalls += 1; } },
    gatewayAuth: gatewayAuth({ agentBinding: null }),
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
  });
  assert.equal(result, null);
  assert.equal(attachCalls, 0);
});

test('resume accepts a null one-time credential while new attachment fails closed', async () => {
  const service = { attach: async () => attachResult({ resumed: true, agentAccessToken: null }) };
  const resumed = await attachTerminalAgent({
    service,
    gatewayAuth: gatewayAuth(),
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
    requireAccessToken: false,
    resolveBaseUrl: () => 'http://frontend.test/api/workspace/team/codesite',
  });
  assert.deepEqual(resumed.scopedEnv, {});
  await assert.rejects(attachTerminalAgent({
    service,
    gatewayAuth: gatewayAuth(),
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
    resolveBaseUrl: () => 'http://frontend.test/api/workspace/team/codesite',
  }), { code: 'AGENT_TERMINAL_ACCESS_TOKEN_REQUIRED' });
});

test('reattach binding comes from the new gateway identity and retained server session only', () => {
  const existingBinding = normalizeTerminalAgentBinding({
    result: attachResult(),
    gatewayAuth: gatewayAuth(),
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
  });
  const requested = agentReattachBindingFromGateway({
    gatewayAuth: gatewayAuth({ actorUserId: 'owner-2' }),
    existingBinding,
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
  });

  assert.equal(requested.ownerUserId, 'owner-2');
  assert.equal(requested.agentSessionId, 'agent-1');
  assert.equal(requested.displayCallsign, 'CODEX-01');
  assert.equal(requested.providerSessionRef, 'provider-session-1');
  assert.equal(agentReattachBindingFromGateway({
    gatewayAuth: gatewayAuth({ agentBinding: null }),
    existingBinding,
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
  }), null);
});

test('normalization rejects forged service identities instead of trusting response data', () => {
  const fields = {
    ownerUserId: 'owner-2',
    projectId: 'project-2',
    agentProvider: 'claude',
    providerSessionRef: 'provider-session-2',
    runtimeScope: 'runtime-2',
    terminalSessionId: 'terminal-2',
  };
  for (const [field, value] of Object.entries(fields)) {
    const result = attachResult({ binding: { ...attachResult().binding, [field]: value } });
    assert.throws(() => normalizeTerminalAgentBinding({
      result,
      gatewayAuth: gatewayAuth(),
      workspaceSlug: 'team',
      terminalSessionId: 'terminal-1',
    }), (error) => {
      assert.equal(String(error.message).includes(value), false);
      return true;
    }, field);
  }
});

test('heartbeat survives until idempotent final detach and carries the exact binding', async () => {
  const heartbeats = [];
  const detaches = [];
  let intervalCallback;
  const cleared = [];
  const service = {
    attach: async () => attachResult(),
    heartbeat: async (input) => { heartbeats.push(input); },
    detach: async (input) => { detaches.push(input); return { ok: true }; },
  };
  const attached = await attachTerminalAgent({
    service,
    gatewayAuth: gatewayAuth(),
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
    resolveBaseUrl: () => 'http://frontend.test/api/workspace/team/codesite',
  });
  const timer = { unref() {} };
  startAgentTerminalHeartbeat(attached.state, {
    setIntervalFn: (callback, delay) => { intervalCallback = callback; assert.equal(delay, 30_000); return timer; },
  });
  intervalCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(heartbeats.length, 1);
  assert.equal(heartbeats[0].agentSessionId, 'agent-1');
  assert.equal(heartbeats[0].gatewayAuth, attached.state.gatewayAuth);

  const first = finalizeAgentTerminal(attached.state, 'pty_exit', {
    clearIntervalFn: (value) => cleared.push(value),
  });
  const second = finalizeAgentTerminal(attached.state, 'ignored_duplicate', {
    clearIntervalFn: (value) => cleared.push(value),
  });
  assert.equal(first, second);
  await first;
  assert.deepEqual(cleared, [timer]);
  assert.equal(detaches.length, 1);
  assert.equal(detaches[0].reason, 'pty_exit');
  assert.equal(detaches[0].ended, true);
  assert.equal(detaches[0].agentSessionId, 'agent-1');
});
