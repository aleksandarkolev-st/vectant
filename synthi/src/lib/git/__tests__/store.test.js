import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: { gitProvider: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
            encryptedSecret: { create: vi.fn(), deleteMany: vi.fn() } },
  enc: vi.fn((t) => `cipher(${t})`),
}));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: h.enc, decryptToken: (c) => c }));

import { createPatProvider, listProviders, scopeWhere, deleteProvider } from '../store';

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

describe('deleteProvider', () => {
  it('deletes the provider AND its orphaned secret rows', async () => {
    h.prisma.gitProvider.findUnique.mockResolvedValue({ secretId: 's1', refreshSecretId: 'r1' });
    h.prisma.gitProvider.delete.mockResolvedValue({});
    await deleteProvider('g1');
    expect(h.prisma.gitProvider.delete).toHaveBeenCalledWith({ where: { id: 'g1' } });
    expect(h.prisma.encryptedSecret.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s1', 'r1'] } } });
  });
});
