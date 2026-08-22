import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getToken, requireRuntimeWorkspaceAccess, sign } = vi.hoisted(() => ({
  getToken: vi.fn(),
  requireRuntimeWorkspaceAccess: vi.fn(),
  sign: vi.fn(() => 'signed-token'),
}));

vi.mock('next-auth/jwt', () => ({ getToken }));
vi.mock('jsonwebtoken', () => ({ default: { sign } }));
vi.mock('@/lib/workspaceAccess', () => ({ requireRuntimeWorkspaceAccess }));

import { GET } from '../route';

describe('workspace gateway token agent binding', () => {
  const previousAuthSecret = process.env.AUTH_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTH_SECRET = 'test-auth-secret';
    getToken.mockResolvedValue({ userId: 'owner-1' });
    requireRuntimeWorkspaceAccess.mockResolvedValue({
      ok: true,
      session: { user: { id: 'member-1' } },
    });
  });

  afterEach(() => {
    if (previousAuthSecret == null) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousAuthSecret;
  });

  it('issues an all-or-none signed agent binding for a collaboration terminal', async () => {
    const response = await GET(new Request(
      'http://test/api/auth/token?workspaceSlug=team&scopes=collab:terminal&collabSessionId=abc12345&codeSiteProjectId=project-1&agentProvider=CoDeX&providerSessionRef=codex-session-1',
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.agentBinding).toEqual({
      projectId: 'project-1',
      provider: 'codex',
      providerSessionRef: 'codex-session-1',
    });
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'owner-1',
      workspaceUserId: 'member-1',
      collabSessionId: 'abc12345',
      agentBinding: payload.agentBinding,
    }), 'test-auth-secret', expect.objectContaining({ audience: 'synthi-gateway' }));
  });

  it('rejects partial, malformed, and oversized bindings before signing', async () => {
    const urls = [
      'http://test/api/auth/token?workspaceSlug=team&scopes=collab:terminal&collabSessionId=abc12345&codeSiteProjectId=project-1',
      'http://test/api/auth/token?workspaceSlug=team&scopes=collab:terminal&collabSessionId=abc12345&codeSiteProjectId=project-1&agentProvider=bad%20provider&providerSessionRef=ref-1',
      `http://test/api/auth/token?workspaceSlug=team&scopes=collab:terminal&collabSessionId=abc12345&codeSiteProjectId=project-1&agentProvider=codex&providerSessionRef=${'x'.repeat(257)}`,
    ];
    for (const url of urls) {
      const response = await GET(new Request(url));
      expect(response.status).toBe(400);
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it('requires terminal scope and a collaboration session for an agent binding', async () => {
    const suffix = 'codeSiteProjectId=project-1&agentProvider=codex&providerSessionRef=codex-session-1';
    const responses = await Promise.all([
      GET(new Request(`http://test/api/auth/token?workspaceSlug=team&scopes=collab:exec&collabSessionId=abc12345&${suffix}`)),
      GET(new Request(`http://test/api/auth/token?workspaceSlug=team&scopes=collab:terminal&${suffix}`)),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400]);
    expect(sign).not.toHaveBeenCalled();
  });

  it('keeps ordinary terminal tokens free of agent binding claims', async () => {
    const response = await GET(new Request(
      'http://test/api/auth/token?workspaceSlug=team&scopes=collab:terminal&collabSessionId=abc12345',
    ));
    const payload = await response.json();
    const signedPayload = sign.mock.calls[0][0];

    expect(response.status).toBe(200);
    expect(payload).not.toHaveProperty('agentBinding');
    expect(signedPayload).not.toHaveProperty('agentBinding');
  });
});
