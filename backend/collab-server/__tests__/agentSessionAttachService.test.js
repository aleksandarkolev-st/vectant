'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildAgentAttachPayload,
  createAgentSessionAttachService,
} = require('../agentSessionAttachService');
const {
  COMMAND_SCOPES,
  authorizeTerminalGatewayRequest,
} = require('../collabGatewayAuth');

const CONTROL_PLANE = 'http://frontend.test/api/workspace/team/codesite';
const AUTH_TOKEN = 'control-plane-secret';
const JWT_SECRET = 'gateway-test-secret';

function gatewayAuth(overrides = {}) {
  return {
    source: 'gateway',
    workspaceSlug: 'team',
    actorUserId: 'owner-1',
    workspaceUserId: 'member-1',
    filesystemUserId: 'shared-owner',
    runtimeScope: 'ws-team-collab-1',
    collabSessionId: 'abc12345',
    agentBinding: {
      projectId: 'project-1',
      provider: 'codex',
      providerSessionRef: 'codex-session-1',
    },
    ...overrides,
  };
}

function attachInput(overrides = {}) {
  return {
    gatewayAuth: gatewayAuth(),
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
    ...overrides,
  };
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  };
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signGateway(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    aud: 'synthi-gateway',
    typ: 'collab-gateway',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...payload,
  }));
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

test('builds attach identity only from the trusted gateway projection', () => {
  const payload = buildAgentAttachPayload({
    ...attachInput(),
    ownerUserId: 'forged-owner',
    collaborationUserId: 'forged-member',
    effectiveWorkspaceUserId: 'forged-effective',
  });

  assert.equal(payload.projectId, 'project-1');
  assert.deepEqual(payload.body, {
    collaborationMembershipVerified: true,
    ownerUserId: 'owner-1',
    collaborationUserId: 'member-1',
    effectiveWorkspaceUserId: 'shared-owner',
    collaborationSessionId: 'abc12345',
    terminalSessionId: 'terminal-1',
    runtimeSessionId: null,
    runtimeScope: 'ws-team-collab-1',
    agentProvider: 'codex',
    providerSessionRef: 'codex-session-1',
    agentRuntime: 'terminal',
    capabilities: [
      'codesite.context.read',
      'codesite.inbox.read',
      'codesite.events.read',
      'codesite.knowledge.read',
      'codesite.knowledge.write',
      'codesite.inbox.respond',
    ],
    subscriptions: ['project.events', 'agent.inbox'],
    deliveryChannel: { type: 'mcp_poll' },
    executionHost: {
      type: 'workspace_terminal',
      hostId: 'ws-team-collab-1',
      platform: process.platform,
    },
  });
});

test('requests scoped credential rotation only for a newly spawned agent process', () => {
  const rotated = buildAgentAttachPayload({ ...attachInput(), rotateAgentAccessToken: true });
  const resumed = buildAgentAttachPayload({ ...attachInput(), rotateAgentAccessToken: false });
  assert.equal(rotated.body.rotateAgentAccessToken, true);
  assert.equal(Object.hasOwn(resumed.body, 'rotateAgentAccessToken'), false);
});

test('attaches through the trusted control plane without leaking credentials into its result', async () => {
  const calls = [];
  const service = createAgentSessionAttachService({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        resumed: false,
        session: { id: 'agent-1', displayCallsign: 'CODEX-01', status: 'attached' },
        event: { eventType: 'agent_attached' },
      }, 201);
    },
    resolveBaseUrl: () => CONTROL_PLANE,
    authToken: AUTH_TOKEN,
  });

  const result = await service.attach(attachInput());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CONTROL_PLANE}/projects/project-1/agent-sessions/attach`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${AUTH_TOKEN}`);
  assert.equal(JSON.parse(calls[0].options.body).ownerUserId, 'owner-1');
  assert.equal(result.binding.agentSessionId, 'agent-1');
  assert.equal(JSON.stringify(result).includes(AUTH_TOKEN), false);
});

test('heartbeat and detach carry the same exact signed binding', async () => {
  const calls = [];
  const service = createAgentSessionAttachService({
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return jsonResponse({ session: { id: 'agent-1' } });
    },
    resolveBaseUrl: () => CONTROL_PLANE,
    authToken: AUTH_TOKEN,
  });
  const input = { ...attachInput(), agentSessionId: 'agent-1' };

  await service.heartbeat(input);
  await service.detach({ ...input, reason: 'pty_exit', ended: true });

  assert.equal(calls[0].url, `${CONTROL_PLANE}/agent-sessions/agent-1/heartbeat`);
  assert.equal(calls[1].url, `${CONTROL_PLANE}/agent-sessions/agent-1/detach`);
  assert.equal(calls[0].body.providerSessionRef, 'codex-session-1');
  assert.equal(calls[1].body.reason, 'pty_exit');
  assert.equal(calls[1].body.ended, true);
});

test('invalid authority and configuration fail before any control-plane fetch', async () => {
  const cases = [
    attachInput({ gatewayAuth: gatewayAuth({ source: 'internal' }) }),
    attachInput({ workspaceSlug: 'other' }),
    attachInput({ gatewayAuth: gatewayAuth({ collabSessionId: '' }) }),
    attachInput({ gatewayAuth: gatewayAuth({ filesystemUserId: '' }) }),
    attachInput({ gatewayAuth: gatewayAuth({ agentBinding: { projectId: 'project-1' } }) }),
    attachInput({ terminalSessionId: '', runtimeSessionId: '' }),
  ];
  for (const input of cases) {
    let fetchCalls = 0;
    const service = createAgentSessionAttachService({
      fetchImpl: async () => { fetchCalls += 1; return jsonResponse({}); },
      resolveBaseUrl: () => CONTROL_PLANE,
      authToken: AUTH_TOKEN,
    });
    await assert.rejects(service.attach(input));
    assert.equal(fetchCalls, 0);
  }

  let fetchCalls = 0;
  const unconfigured = createAgentSessionAttachService({
    fetchImpl: async () => { fetchCalls += 1; return jsonResponse({}); },
    resolveBaseUrl: () => null,
    authToken: AUTH_TOKEN,
  });
  await assert.rejects(unconfigured.attach(attachInput()), { code: 'AGENT_ATTACH_CONTROL_PLANE_UNCONFIGURED' });
  assert.equal(fetchCalls, 0);

  const noAuth = createAgentSessionAttachService({
    fetchImpl: async () => { fetchCalls += 1; return jsonResponse({}); },
    resolveBaseUrl: () => CONTROL_PLANE,
    authToken: '',
  });
  await assert.rejects(noAuth.attach(attachInput()), { code: 'AGENT_ATTACH_CONTROL_PLANE_AUTH_UNCONFIGURED' });
  assert.equal(fetchCalls, 0);
});

test('control-plane rejection and transport errors stay bounded and redact response content', async () => {
  const rejected = createAgentSessionAttachService({
    fetchImpl: async () => jsonResponse({ secret: 'must-not-appear' }, 403),
    resolveBaseUrl: () => CONTROL_PLANE,
    authToken: AUTH_TOKEN,
  });
  await assert.rejects(rejected.attach(attachInput()), (error) => {
    assert.equal(error.code, 'AGENT_ATTACH_CONTROL_PLANE_REJECTED');
    assert.equal(error.message.includes('must-not-appear'), false);
    return true;
  });

  const unavailable = createAgentSessionAttachService({
    fetchImpl: async () => { throw new Error('network secret'); },
    resolveBaseUrl: () => CONTROL_PLANE,
    authToken: AUTH_TOKEN,
  });
  await assert.rejects(unavailable.attach(attachInput()), (error) => {
    assert.equal(error.code, 'AGENT_ATTACH_CONTROL_PLANE_UNAVAILABLE');
    assert.equal(error.message.includes('network secret'), false);
    return true;
  });
});

test('times out an unavailable control plane with a typed, bounded error', async () => {
  const service = createAgentSessionAttachService({
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('timeout transport detail')));
    }),
    resolveBaseUrl: () => CONTROL_PLANE,
    authToken: AUTH_TOKEN,
    timeoutMs: 5,
  });

  await assert.rejects(service.attach(attachInput()), (error) => {
    assert.equal(error.code, 'AGENT_ATTACH_CONTROL_PLANE_UNAVAILABLE');
    assert.equal(error.message.includes('timeout transport detail'), false);
    return true;
  });
});

test('denied collaboration membership leaves no trusted projection and causes zero attach fetches', async () => {
  const token = signGateway({
    sub: 'owner-1',
    actorUserId: 'owner-1',
    workspaceSlug: 'team',
    scopes: [COMMAND_SCOPES.TERMINAL],
    workspaceUserId: 'member-1',
    filesystemUserId: 'shared-owner',
    runtimeScope: 'ws-team-collab-1',
    collabSessionId: 'abc12345',
    agentBinding: gatewayAuth().agentBinding,
  });
  const request = {
    url: `/terminal?workspace=team&token=${encodeURIComponent(token)}`,
    headers: { host: 'collab.test' },
  };
  const auth = authorizeTerminalGatewayRequest({
    req: request,
    slug: 'team',
    sessionManager: {
      getSession: () => ({ id: 'abc12345', status: 'active', slug: 'team', hostId: 'host-1', guests: [] }),
      checkPermission: () => false,
    },
    env: { AUTH_SECRET: JWT_SECRET, NODE_ENV: 'test' },
  });
  assert.equal(auth.ok, false);
  assert.equal(request.collabGatewayAuth, undefined);

  let fetchCalls = 0;
  const service = createAgentSessionAttachService({
    fetchImpl: async () => { fetchCalls += 1; return jsonResponse({}); },
    resolveBaseUrl: () => CONTROL_PLANE,
    authToken: AUTH_TOKEN,
  });
  await assert.rejects(service.attach({
    gatewayAuth: request.collabGatewayAuth,
    workspaceSlug: 'team',
    terminalSessionId: 'terminal-1',
  }), { code: 'AGENT_ATTACH_GATEWAY_AUTH_REQUIRED' });
  assert.equal(fetchCalls, 0);
});
