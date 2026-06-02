import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: { gitProvider: { update: vi.fn() }, encryptedSecret: { update: vi.fn(), create: vi.fn() } },
  assertSafe: vi.fn(async () => {}),
  fetchMock: vi.fn(),
}));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: (t) => `c(${t})`, decryptToken: (c) => c.replace(/^c\(|\)$/g, '') }));
vi.mock('@synthi/mcp-hub', () => ({ assertSafeUrl: h.assertSafe }));

import { withFreshToken } from '../token';
import { gitFetch } from '../safeFetch';

beforeEach(() => { vi.clearAllMocks(); global.fetch = h.fetchMock; });

describe('gitFetch', () => {
  it('SSRF-guards the URL before fetching', async () => {
    h.fetchMock.mockResolvedValue({ ok: true });
    await gitFetch('https://gitlab.example/api', { method: 'GET' });
    expect(h.assertSafe).toHaveBeenCalledWith('https://gitlab.example/api');
    expect(h.fetchMock).toHaveBeenCalled();
  });
  it('does NOT fetch when the URL is unsafe', async () => {
    h.assertSafe.mockRejectedValueOnce(new Error('blocked_ip'));
    await expect(gitFetch('http://169.254.169.254/', {})).rejects.toThrow('blocked_ip');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });
});

describe('withFreshToken', () => {
  it('returns the PAT directly (no refresh) for authType=pat', async () => {
    const conn = { id: 'g1', authType: 'pat', secret: { cipher: 'c(pat123)' } };
    expect(await withFreshToken(conn)).toBe('pat123');
    expect(h.prisma.gitProvider.update).not.toHaveBeenCalled();
  });
  it('refreshes an expired OAuth token and persists the new one', async () => {
    h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'NEW', refresh_token: 'R2', expires_in: 7200 }) });
    h.prisma.encryptedSecret.update.mockResolvedValue({});
    const conn = { id: 'g1', providerType: 'gitlab', authType: 'oauth', baseUrl: null,
      accessTokenExpiresAt: new Date(Date.now() - 1000), secretId: 's1', refreshSecretId: 'r1',
      secret: { id: 's1', cipher: 'c(OLD)' }, refreshSecret: { id: 'r1', cipher: 'c(R1)' } };
    expect(await withFreshToken(conn)).toBe('NEW');
    expect(h.prisma.encryptedSecret.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1' } }));
    expect(h.prisma.gitProvider.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'g1' } }));
  });
  it('marks needsRelink and throws when refresh fails', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'invalid_grant' });
    const conn = { id: 'g1', providerType: 'gitlab', authType: 'oauth',
      accessTokenExpiresAt: new Date(Date.now() - 1000), secretId: 's1', refreshSecretId: 'r1',
      secret: { id: 's1', cipher: 'c(OLD)' }, refreshSecret: { id: 'r1', cipher: 'c(R1)' } };
    await expect(withFreshToken(conn)).rejects.toMatchObject({ code: 'needs_relink' });
    expect(h.prisma.gitProvider.update).toHaveBeenCalledWith(expect.objectContaining({ data: { needsRelink: true } }));
  });
});
