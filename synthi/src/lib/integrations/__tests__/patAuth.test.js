import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashToken, generatePat } from '../pat';

const h = vi.hoisted(() => ({ pat: { findUnique: vi.fn(), update: vi.fn() } }));
vi.mock('@/lib/prisma', () => ({ default: { personalAccessToken: h.pat } }));

import { authenticatePat, bearerToken } from '../patAuth';

function reqWith(authHeader) {
  return new Request('http://x', authHeader ? { headers: { authorization: authHeader } } : undefined);
}

beforeEach(() => { vi.clearAllMocks(); h.pat.update.mockResolvedValue({}); });

describe('bearerToken', () => {
  it('extracts a Bearer token', () => {
    expect(bearerToken(reqWith('Bearer abc'))).toBe('abc');
    expect(bearerToken(reqWith('bearer xyz'))).toBe('xyz');
    expect(bearerToken(reqWith(''))).toBe(null);
    expect(bearerToken(reqWith('Basic abc'))).toBe(null);
  });
});

describe('authenticatePat', () => {
  it('resolves a valid token to its userId and bumps lastUsedAt', async () => {
    const { token } = generatePat();
    h.pat.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', revokedAt: null });
    const actor = await authenticatePat(reqWith(`Bearer ${token}`));
    expect(actor).toEqual({ userId: 'u1' });
    expect(h.pat.findUnique).toHaveBeenCalledWith({ where: { tokenHash: hashToken(token) } });
    expect(h.pat.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1' } }));
  });

  it('returns null for an unknown token', async () => {
    const { token } = generatePat();
    h.pat.findUnique.mockResolvedValue(null);
    expect(await authenticatePat(reqWith(`Bearer ${token}`))).toBe(null);
  });

  it('returns null for a revoked token', async () => {
    const { token } = generatePat();
    h.pat.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', revokedAt: new Date() });
    expect(await authenticatePat(reqWith(`Bearer ${token}`))).toBe(null);
  });

  it('returns null without doing a lookup for a non-PAT bearer', async () => {
    expect(await authenticatePat(reqWith('Bearer not-a-pat'))).toBe(null);
    expect(h.pat.findUnique).not.toHaveBeenCalled();
  });
});
