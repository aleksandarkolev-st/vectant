import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above module-level consts, so the mock state must be
// created with vi.hoisted() to exist before the factory runs — otherwise the factory
// references `prismaMock` in its temporal dead zone ("Cannot access before initialization").
const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    mcpConnection: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
    encryptedSecret: { create: vi.fn(), delete: vi.fn() },
    $transaction: vi.fn(async (fns) => Promise.all(fns)),
  },
}));
vi.mock('@/lib/prisma', () => ({ default: prismaMock }));
vi.mock('@/lib/tokenCrypto', () => ({
  encryptToken: (pt) => `cipher(${pt})`,
  decryptToken: (blob) => String(blob).replace(/^cipher\((.*)\)$/, '$1'),
}));

import { listConnections, resolveToolConfigs, toPublic } from '../connectionStore.js';

beforeEach(() => {
  for (const m of Object.values(prismaMock.mcpConnection)) m.mockReset();
  for (const m of Object.values(prismaMock.encryptedSecret)) m.mockReset();
});

describe('toPublic', () => {
  it('never exposes secret cipher material', () => {
    const pub = toPublic({
      id: 'c1', name: 'GH', url: 'https://x', transport: 'http', scope: 'personal',
      authType: 'bearer', enabled: true, toolAllowlist: ['a'],
      secret: { id: 's1', cipher: 'cipher(tok)', last4: '..ok' },
    });
    expect(pub.secret).toBeUndefined();
    expect(pub.hasSecret).toBe(true);
    expect(pub.secretLast4).toBe('..ok');
    expect(pub.cipher).toBeUndefined();
  });
});

describe('listConnections', () => {
  it('queries personal OR workspace rows for the scope', async () => {
    prismaMock.mcpConnection.findMany.mockResolvedValue([]);
    await listConnections({ userId: 'u1', workspaceSlug: 'w1' });
    const arg = prismaMock.mcpConnection.findMany.mock.calls[0][0];
    expect(arg.where.OR).toEqual([
      { scope: 'personal', ownerUserId: 'u1' },
      { scope: 'workspace', workspaceSlug: 'w1' },
    ]);
  });
});

describe('resolveToolConfigs', () => {
  it('returns only enabled connections with a non-empty allowlist, decrypted', async () => {
    prismaMock.mcpConnection.findMany.mockResolvedValue([
      { id: 'c1', name: 'GH', url: 'https://gh', transport: 'http', authType: 'bearer', headerName: null,
        enabled: true, toolAllowlist: ['create_issue'], secret: { cipher: 'cipher(tok)' } },
      { id: 'c2', name: 'Off', url: 'https://x', transport: 'http', authType: 'none',
        enabled: false, toolAllowlist: ['a'], secret: null },
      { id: 'c3', name: 'NoTools', url: 'https://y', transport: 'http', authType: 'none',
        enabled: true, toolAllowlist: [], secret: null },
    ]);
    const out = await resolveToolConfigs({ userId: 'u1', workspaceSlug: 'w1' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'c1', secret: 'tok', allowlist: ['create_issue'] });
  });
});
