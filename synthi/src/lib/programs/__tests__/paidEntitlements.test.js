import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: { entitlement: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));

import {
  getEntitlement, getActiveEntitlement, grantEntitlement, revokeEntitlement,
} from '../paidEntitlements';

beforeEach(() => vi.clearAllMocks());

const subject = { programId: 'prog1', subjectId: 'u1' };
const compoundWhere = { programId_subjectType_subjectId: { programId: 'prog1', subjectType: 'user', subjectId: 'u1' } };

describe('getActiveEntitlement', () => {
  it('returns the row when active', async () => {
    h.prisma.entitlement.findUnique.mockResolvedValue({ id: 'e1', status: 'active' });
    expect(await getActiveEntitlement(subject)).toMatchObject({ id: 'e1' });
    expect(h.prisma.entitlement.findUnique).toHaveBeenCalledWith({ where: compoundWhere });
  });

  it('returns null when revoked or absent', async () => {
    h.prisma.entitlement.findUnique.mockResolvedValue({ id: 'e1', status: 'revoked' });
    expect(await getActiveEntitlement(subject)).toBeNull();
    h.prisma.entitlement.findUnique.mockResolvedValue(null);
    expect(await getActiveEntitlement(subject)).toBeNull();
  });
});

describe('getEntitlement', () => {
  it('reads the subject row by compound key', async () => {
    h.prisma.entitlement.findUnique.mockResolvedValue({ id: 'e1', status: 'revoked' });
    expect(await getEntitlement(subject)).toMatchObject({ status: 'revoked' });
  });
});

describe('grantEntitlement', () => {
  it('upserts an active entitlement on the subject+app key (idempotent)', async () => {
    h.prisma.entitlement.upsert.mockResolvedValue({ id: 'e1' });
    await grantEntitlement({ ...subject, reference: 'ref_1', priceCents: 500, currency: 'eur' });
    const arg = h.prisma.entitlement.upsert.mock.calls[0][0];
    expect(arg.where).toEqual(compoundWhere);
    expect(arg.create).toMatchObject({ programId: 'prog1', subjectId: 'u1', status: 'active', source: 'purchase', reference: 'ref_1' });
    expect(arg.update).toMatchObject({ status: 'active', reference: 'ref_1', revokedAt: null });
  });
});

describe('revokeEntitlement', () => {
  it('marks the subject entitlement revoked (idempotent updateMany)', async () => {
    h.prisma.entitlement.updateMany.mockResolvedValue({ count: 1 });
    await revokeEntitlement(subject);
    const arg = h.prisma.entitlement.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ programId: 'prog1', subjectType: 'user', subjectId: 'u1' });
    expect(arg.data.status).toBe('revoked');
    expect(arg.data.revokedAt).toBeInstanceOf(Date);
  });
});
