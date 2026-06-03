import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(),
  prisma: { encryptedSecret: { create: vi.fn() }, gitProvider: { create: vi.fn() } },
  fetchMock: vi.fn(), assertSafe: vi.fn(async () => {}),
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: (t) => `c(${t})` }));
vi.mock('@synthi/mcp-hub', () => ({ assertSafeUrl: h.assertSafe }));

import { GET as CALLBACK } from '../callback/route';
beforeEach(() => { vi.clearAllMocks(); global.fetch = h.fetchMock; h.actor.mockResolvedValue({ userId: 'u1' });
  h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'sec' }); h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1' });
  process.env.GITLAB_CLIENT_ID = 'cid'; process.env.GITLAB_CLIENT_SECRET = 'csec'; process.env.NEXTAUTH_URL = 'https://app.example';
});

it('exchanges the code, stores encrypted tokens, creates an oauth provider', async () => {
  h.fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 7200 }) });
  const req = new Request('https://app.example/api/integrations/git/oauth/gitlab/callback?code=abc&state=st', { headers: { cookie: 'git_oauth_state=st' } });
  const res = await CALLBACK(req, { params: Promise.resolve({ provider: 'gitlab' }) });
  expect([302, 303]).toContain(res.status); // redirects back to the app
  expect(h.prisma.encryptedSecret.create).toHaveBeenCalledWith({ data: { cipher: 'c(AT)', last4: 'AT'.slice(-4) } });
  const data = h.prisma.gitProvider.create.mock.calls[0][0].data;
  expect(data).toMatchObject({ providerType: 'gitlab', authType: 'oauth', ownerUserId: 'u1' });
});

it('rejects a state mismatch (CSRF) without exchanging', async () => {
  const req = new Request('https://app.example/api/integrations/git/oauth/gitlab/callback?code=abc&state=BAD', { headers: { cookie: 'git_oauth_state=st' } });
  const res = await CALLBACK(req, { params: Promise.resolve({ provider: 'gitlab' }) });
  expect(res.status).toBe(400);
  expect(h.fetchMock).not.toHaveBeenCalled();
});
