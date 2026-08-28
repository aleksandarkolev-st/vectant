import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: { gitProvider: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
            encryptedSecret: { create: vi.fn(), deleteMany: vi.fn() } },
  enc: vi.fn((t) => `cipher(${t})`),
}));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: h.enc, decryptToken: (c) => c }));

import { createPatProvider, listProviders, scopeWhere, deleteProvider, upsertOAuthProvider } from '../store';

beforeEach(() => { vi.clearAllMocks(); h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'sec1' }); });

describe('scopeWhere', () => {
  it('personal scopes to the owner; workspace scopes to the slug', () => {
    expect(scopeWhere({ userId: 'u1' }, null)).toEqual({ scope: 'personal', ownerUserId: 'u1' });
    expect(scopeWhere({ userId: 'u1' }, 'team')).toEqual({ scope: 'workspace', workspaceSlug: 'team' });
  });
});

describe('createPatProvider', () => {
  it('encrypts the token, stores last4, and persists authType=pat', async () => {
    h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1', name: 'gl', providerType: 'gitlab', accountLogin: null });
    await createPatProvider({ userId: 'u1' }, { providerType: 'gitlab', name: 'gl', baseUrl: null, token: 'glpat-XYZ1234' });
    expect(h.enc).toHaveBeenCalledWith('glpat-XYZ1234');
    expect(h.prisma.encryptedSecret.create).toHaveBeenCalledWith({ data: { cipher: 'cipher(glpat-XYZ1234)', last4: '1234' } });
    const data = h.prisma.gitProvider.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ providerType: 'gitlab', authType: 'pat', scope: 'personal', ownerUserId: 'u1', secretId: 'sec1' });
    expect(data).not.toHaveProperty('token');
  });
});

describe('listProviders', () => {
  it('selects scoped rows WITHOUT secret material', async () => {
    h.prisma.gitProvider.findMany.mockResolvedValue([]);
    await listProviders({ userId: 'u1' }, null);
    const arg = h.prisma.gitProvider.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ scope: 'personal', ownerUserId: 'u1' });
    expect(arg.select.secretId).toBeFalsy();
    expect(arg.select.secret).toBeFalsy();
  });
});

describe('upsertOAuthProvider', () => {
  it('creates a new oauth provider when none exists, storing encrypted access+refresh tokens', async () => {
    h.prisma.gitProvider.findFirst.mockResolvedValue(null);
    h.prisma.encryptedSecret.create.mockResolvedValueOnce({ id: 'accSec' }).mockResolvedValueOnce({ id: 'refSec' });
    h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1' });
    const row = await upsertOAuthProvider({ ownerUserId: 'u1', providerType: 'gitlab', name: 'GitLab', accessToken: 'AT', refreshToken: 'RT', expiresIn: 7200, oauthScopes: ['api'] });
    expect(h.prisma.encryptedSecret.create).toHaveBeenCalledWith({ data: { cipher: 'cipher(AT)', last4: 'AT'.slice(-4) } });
    const data = h.prisma.gitProvider.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ ownerUserId: 'u1', providerType: 'gitlab', authType: 'oauth', scope: 'personal', secretId: 'accSec', refreshSecretId: 'refSec', oauthScopes: ['api'], needsRelink: false });
    expect(h.prisma.gitProvider.update).not.toHaveBeenCalled();
    expect(h.prisma.encryptedSecret.deleteMany).not.toHaveBeenCalled();
    expect(row).toEqual({ id: 'g1' });
  });

  it('updates the existing oauth row and deletes the old secret rows (no duplicate, no orphans)', async () => {
    h.prisma.gitProvider.findFirst.mockResolvedValue({ id: 'old', secretId: 's0', refreshSecretId: 'r0' });
    h.prisma.encryptedSecret.create.mockResolvedValueOnce({ id: 'accSec' }).mockResolvedValueOnce({ id: 'refSec' });
    h.prisma.gitProvider.update.mockResolvedValue({ id: 'old' });
    const row = await upsertOAuthProvider({ ownerUserId: 'u1', providerType: 'github', name: 'GitHub', accessToken: 'AT2', refreshToken: 'RT2', expiresIn: 3600 });
    expect(h.prisma.gitProvider.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerUserId: 'u1', providerType: 'github', authType: 'oauth' } }));
    expect(h.prisma.gitProvider.create).not.toHaveBeenCalled();
    const upd = h.prisma.gitProvider.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'old' });
    expect(upd.data).toMatchObject({ secretId: 'accSec', refreshSecretId: 'refSec', needsRelink: false });
    expect(h.prisma.encryptedSecret.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s0', 'r0'] } } });
    expect(row).toEqual({ id: 'old' });
  });

  it('omits the refresh secret when no refresh token is returned', async () => {
    h.prisma.gitProvider.findFirst.mockResolvedValue(null);
    h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'accSec' });
    h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1' });
    await upsertOAuthProvider({ ownerUserId: 'u1', providerType: 'github', name: 'GitHub', accessToken: 'AT' });
    expect(h.prisma.encryptedSecret.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.gitProvider.create.mock.calls[0][0].data.refreshSecretId).toBeNull();
  });
});

describe('deleteProvider', () => {
  it('deletes the provider AND its orphaned secret rows', async () => {
    h.prisma.gitProvider.findUnique.mockResolvedValue({ secretId: 's1', refreshSecretId: 'r1' });
    h.prisma.gitProvider.delete.mockResolvedValue({});
    await deleteProvider('g1');
    expect(h.prisma.gitProvider.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
    expect(h.prisma.encryptedSecret.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s1', 'r1'] } } });
  });
});
