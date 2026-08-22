'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  COMMAND_SCOPES,
  authorizeCollabGatewayRequest,
  authorizeTerminalGatewayRequest,
} = require('../collabGatewayAuth');

const SECRET = 'test-auth-secret';

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sign(payload, secret = SECRET) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    aud: 'synthi-gateway',
    typ: 'collab-gateway',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...payload,
  }));
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(sig)}`;
}

function req({ token = '', url = '/exec/team', headers = {} } = {}) {
  return {
    url,
    headers: {
      host: 'collab.test',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
  };
}

function basePayload(overrides = {}) {
  return {
    sub: 'user-1',
    actorUserId: 'owner-1',
    workspaceSlug: 'team',
    scopes: [COMMAND_SCOPES.EXEC],
    workspaceUserId: 'user-1',
    filesystemUserId: 'user-1',
    runtimeScope: 'ws-team-user-1',
    ...overrides,
  };
}

function auth(options = {}) {
  return authorizeCollabGatewayRequest({
    req: options.req || req({ token: sign(basePayload(options.payload || {})) }),
    parsed: options.parsed || null,
    slug: options.slug || 'team',
    requiredScope: options.requiredScope || COMMAND_SCOPES.EXEC,
    config: options.config || {},
    sessionManager: options.sessionManager || null,
    env: {
      AUTH_SECRET: SECRET,
      NODE_ENV: 'test',
      ...(options.env || {}),
    },
  });
}

test('missing gateway token is rejected before command execution', () => {
  const result = auth({ req: req() });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'collab_gateway_token_required');
});

test('trusted internal token authorizes service-to-service command calls', () => {
  const result = auth({
    req: req({ headers: { 'x-synthi-internal-token': 'service-secret' } }),
    config: { AI_BACKEND_AUTH_TOKEN: 'service-secret' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, 'internal');
});

test('valid scoped gateway token authorizes matching workspace command calls', () => {
  const result = auth();
  assert.equal(result.ok, true);
  assert.equal(result.source, 'gateway');
  assert.equal(result.workspaceUserId, 'user-1');
  assert.equal(result.runtimeScope, 'ws-team-user-1');
});

test('workspace and scope mismatches are rejected', () => {
  assert.equal(auth({ slug: 'other' }).error, 'gateway_workspace_mismatch');
  assert.equal(auth({
    payload: { scopes: [COMMAND_SCOPES.TERMINAL] },
    requiredScope: COMMAND_SCOPES.EXEC,
  }).error, 'gateway_scope_denied');
});

test('caller-controlled identity fields must match gateway token claims', () => {
  const result = auth({
    parsed: {
      userId: 'attacker',
      filesystemUserId: 'user-1',
      runtimeScope: 'ws-team-user-1',
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.error, 'gateway_identity_mismatch');
});

test('collab session authorization requires matching workspace and terminal permission', () => {
  const sessionManager = {
    getSession(id) {
      return id === 'abc12345'
        ? { id, status: 'active', slug: 'team', hostId: 'user-1', guests: [] }
        : null;
    },
    checkPermission(id, userId, perm) {
      return id === 'abc12345' && userId === 'user-1' && perm === 'canTerminal';
    },
  };

  const result = auth({
    req: req({ token: sign(basePayload({ scopes: [COMMAND_SCOPES.TERMINAL], collabSessionId: 'abc12345' })) }),
    requiredScope: COMMAND_SCOPES.TERMINAL,
    sessionManager,
  });
  assert.equal(result.ok, true);
  assert.equal(result.collabSessionId, 'abc12345');

  const denied = auth({
    req: req({ token: sign(basePayload({ scopes: [COMMAND_SCOPES.TERMINAL], collabSessionId: 'abc12345' })) }),
    payload: { scopes: [COMMAND_SCOPES.TERMINAL], collabSessionId: 'abc12345' },
    requiredScope: COMMAND_SCOPES.TERMINAL,
    slug: 'other',
    sessionManager,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'gateway_workspace_mismatch');
});

test('terminal authorization preserves only the trusted identity and signed agent binding', () => {
  const agentBinding = {
    projectId: 'project-1',
    provider: 'codex',
    providerSessionRef: 'codex-session-1',
  };
  const request = req({
    token: sign(basePayload({
      scopes: [COMMAND_SCOPES.TERMINAL],
      collabSessionId: 'abc12345',
      agentBinding,
    })),
    url: '/terminal?workspace=team&collabSessionId=abc12345&codeSiteProjectId=project-1&agentProvider=codex&providerSessionRef=codex-session-1',
  });
  const sessionManager = {
    getSession: () => ({ id: 'abc12345', status: 'active', slug: 'team', hostId: 'user-1', guests: [] }),
    checkPermission: (_id, userId, permission) => userId === 'user-1' && permission === 'canTerminal',
  };
  const result = authorizeTerminalGatewayRequest({
    req: request,
    slug: 'team',
    sessionManager,
    env: { AUTH_SECRET: SECRET, NODE_ENV: 'test' },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(request.collabGatewayAuth, {
    source: 'gateway',
    workspaceSlug: 'team',
    actorUserId: 'owner-1',
    workspaceUserId: 'user-1',
    filesystemUserId: 'user-1',
    runtimeScope: 'ws-team-user-1',
    collabSessionId: 'abc12345',
    agentBinding,
  });
  assert.equal(Object.isFrozen(request.collabGatewayAuth), true);
  assert.equal(Object.hasOwn(request.collabGatewayAuth, 'payload'), false);
});

test('terminal authorization rejects partial, unsigned, and mismatched agent bindings', () => {
  const sessionManager = {
    getSession: () => ({ id: 'abc12345', status: 'active', slug: 'team', hostId: 'user-1', guests: [] }),
    checkPermission: () => true,
  };
  const signedBinding = {
    projectId: 'project-1',
    provider: 'codex',
    providerSessionRef: 'codex-session-1',
  };
  const cases = [
    {
      url: '/terminal?workspace=team&codeSiteProjectId=project-1',
      agentBinding: signedBinding,
    },
    {
      url: '/terminal?workspace=team&codeSiteProjectId=project-1&agentProvider=codex&providerSessionRef=codex-session-1',
      agentBinding: null,
    },
    {
      url: '/terminal?workspace=team&codeSiteProjectId=project-2&agentProvider=codex&providerSessionRef=codex-session-1',
      agentBinding: signedBinding,
    },
  ];

  for (const entry of cases) {
    const request = req({
      token: sign(basePayload({
        scopes: [COMMAND_SCOPES.TERMINAL],
        collabSessionId: 'abc12345',
        ...(entry.agentBinding ? { agentBinding: entry.agentBinding } : {}),
      })),
      url: entry.url,
    });
    const result = authorizeTerminalGatewayRequest({
      req: request,
      slug: 'team',
      sessionManager,
      env: { AUTH_SECRET: SECRET, NODE_ENV: 'test' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'gateway_identity_mismatch');
    assert.equal(result.field, 'agentBinding');
    assert.equal(request.collabGatewayAuth, undefined);
  }
});

test('non-members and internal bypasses never receive an attach-capable gateway projection', () => {
  const deniedRequest = req({
    token: sign(basePayload({ scopes: [COMMAND_SCOPES.TERMINAL], collabSessionId: 'abc12345' })),
  });
  const denied = authorizeTerminalGatewayRequest({
    req: deniedRequest,
    slug: 'team',
    sessionManager: {
      getSession: () => ({ id: 'abc12345', status: 'active', slug: 'team', hostId: 'host-1', guests: [] }),
      checkPermission: () => false,
    },
    env: { AUTH_SECRET: SECRET, NODE_ENV: 'test' },
  });
  assert.equal(denied.ok, false);
  assert.equal(deniedRequest.collabGatewayAuth, undefined);

  const internalRequest = req({ headers: { 'x-synthi-internal-token': 'service-secret' } });
  const internal = authorizeTerminalGatewayRequest({
    req: internalRequest,
    slug: 'team',
    config: { AI_BACKEND_AUTH_TOKEN: 'service-secret' },
    env: { NODE_ENV: 'test' },
  });
  assert.equal(internal.ok, true);
  assert.equal(internalRequest.collabGatewayAuth.source, 'internal');
  assert.equal(internalRequest.collabGatewayAuth.actorUserId, '');
  assert.equal(internalRequest.collabGatewayAuth.agentBinding, null);
});
