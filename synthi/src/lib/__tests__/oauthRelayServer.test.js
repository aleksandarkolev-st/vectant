import { describe, expect, it, beforeEach } from 'vitest';

import {
  createRelaySessionPayload,
  findExpectedLoopbackCallback,
  markRelaySessionConsumed,
  relaySessionConsumed,
  validateCallbackAgainstExpected,
  verifyRelaySessionToken,
} from '../oauthRelayServer';

const access = {
  email: 'owner@example.test',
  session: {
    user: {
      id: 'user-123',
      email: 'owner@example.test',
    },
  },
  workspace: {
    id: 'workspace-id',
    slug: 'demo',
  },
};

function runtimeScopeForDemoUser() {
  let hash = 2166136261;
  for (const char of 'demo') {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const workspacePart = `ws-${(hash >>> 0).toString(36)}`;

  hash = 2166136261;
  for (const char of 'user-123') {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${workspacePart}-user-${(hash >>> 0).toString(36)}`;
}

describe('oauthRelayServer', () => {
  beforeEach(() => {
    process.env.SYNTHI_OAUTH_RELAY_SECRET = 'test-relay-secret';
  });

  it('extracts expected localhost callbacks from auth URLs without provider assumptions', () => {
    const expected = findExpectedLoopbackCallback(
      'https://provider.example/oauth?client_id=cli&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid',
    );

    expect(expected).toEqual({
      host: 'localhost',
      port: 1455,
      pathPrefix: '/auth/callback',
    });
  });

  it('creates signed workspace-scoped relay sessions', () => {
    const session = createRelaySessionPayload({
      access,
      requestBody: {
        workspaceSlug: 'demo',
        runtimeScope: runtimeScopeForDemoUser(),
        runtimeKind: 'private',
        authUrl: 'https://provider.example/start?callback_url=http%3A%2F%2F127.0.0.1%3A4545%2Fdone',
      },
    });

    expect(session.ok).toBe(true);
    expect(session.sessionId).toMatch(/^relay_/);
    const verified = verifyRelaySessionToken(session.sessionId);
    expect(verified.ok).toBe(true);
    expect(verified.payload.workspaceSlug).toBe('demo');
    expect(verified.payload.expectedCallback).toMatchObject({
      host: '127.0.0.1',
      port: 4545,
      pathPrefix: '/done',
    });
  });

  it('rejects callbacks that do not match the expected loopback port', () => {
    const result = validateCallbackAgainstExpected(
      'http://localhost:3333/auth/callback?code=redacted',
      { host: 'localhost', port: 1455, pathPrefix: '/auth/callback' },
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'callback_port_mismatch',
    });
  });

  it('marks successful relay sessions as consumed', () => {
    const session = createRelaySessionPayload({
      access,
      requestBody: {
        workspaceSlug: 'demo',
        runtimeScope: runtimeScopeForDemoUser(),
        runtimeKind: 'private',
      },
    });

    expect(session.ok).toBe(true);
    expect(relaySessionConsumed(session.sessionId).ok).toBe(true);
    expect(markRelaySessionConsumed(session.sessionId).ok).toBe(true);
    expect(relaySessionConsumed(session.sessionId)).toMatchObject({
      ok: false,
      error: 'relay_session_consumed',
    });
  });
});

