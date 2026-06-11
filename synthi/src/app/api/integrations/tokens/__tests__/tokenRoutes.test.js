import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  pat: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: { personalAccessToken: h.pat } }));

import { POST, GET } from '../route';
import { DELETE } from '../[id]/route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

function req(body) {
  return new Request('http://x/api/integrations/tokens', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
}

beforeEach(() => {
  __resetRateLimits();
  vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1', email: 'a@b.c' });
});

describe('POST /tokens', () => {
  it('creates a token and returns the plaintext exactly once', async () => {
    h.pat.create.mockResolvedValue({ id: 't1', name: 'laptop', last4: 'abcd', createdAt: new Date() });
    const res = await POST(req({ name: 'laptop' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.token).toMatch(/^synthi_pat_/);
    expect(h.pat.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'u1', name: 'laptop', tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    }));
    expect(h.pat.create.mock.calls[0][0].data).not.toHaveProperty('token');
  });

  it('401 when unauthenticated', async () => {
    h.actor.mockResolvedValue(null);
    const res = await POST(req({ name: 'x' }));
    expect(res.status).toBe(401);
  });

  it('400 when name is missing', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
});

describe('GET /tokens', () => {
  it('lists tokens without hash/plaintext', async () => {
    h.pat.findMany.mockResolvedValue([{ id: 't1', name: 'laptop', last4: 'abcd', createdAt: new Date(), lastUsedAt: null, revokedAt: null }]);
    const res = await GET(new Request('http://x/api/integrations/tokens'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tokens[0]).not.toHaveProperty('tokenHash');
    expect(h.pat.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1' },
      select: expect.objectContaining({ tokenHash: false }),
    }));
  });
});

describe('DELETE /tokens/[id]', () => {
  it('revokes a token the caller owns', async () => {
    h.pat.findUnique.mockResolvedValue({ id: 't1', userId: 'u1' });
    h.pat.update.mockResolvedValue({});
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 't1' }) });
    expect(res.status).toBe(200);
    expect(h.pat.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 't1' }, data: expect.objectContaining({ revokedAt: expect.any(Date) }) }));
  });

  it('403 when the token belongs to someone else', async () => {
    h.pat.findUnique.mockResolvedValue({ id: 't1', userId: 'other' });
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 't1' }) });
    expect(res.status).toBe(403);
  });
});
