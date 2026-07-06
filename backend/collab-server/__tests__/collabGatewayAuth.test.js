'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  COMMAND_SCOPES,
  authorizeCollabGatewayRequest,
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
