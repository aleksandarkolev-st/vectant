import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(), canRead: vi.fn(),
  store: { listProviders: vi.fn(), createPatProvider: vi.fn(), getProvider: vi.fn(), deleteProvider: vi.fn() },
  assertSafe: vi.fn(async () => {}),
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));
vi.mock('@/lib/git/store', () => h.store);
vi.mock('@synthi/mcp-hub', () => ({ assertSafeUrl: h.assertSafe }));

import { GET, POST } from '../route';
import { DELETE } from '../[id]/route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

const req = (body) => new Request('http://x/api/integrations/git/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
beforeEach(() => { __resetRateLimits(); vi.clearAllMocks(); h.actor.mockResolvedValue({ userId: 'u1' }); });

it('GET 401 when unauthenticated', async () => { h.actor.mockResolvedValue(null); expect((await GET(new Request('http://x/api/integrations/git/providers'))).status).toBe(401); });

it('POST creates a PAT provider after SSRF-checking baseUrl', async () => {
  h.store.createPatProvider.mockResolvedValue({ id: 'g1', name: 'gl' });
  const res = await POST(req({ providerType: 'gitlab', name: 'gl', baseUrl: 'https://gl.example', token: 'glpat-1234' }));
  expect(res.status).toBe(201);
  expect(h.assertSafe).toHaveBeenCalledWith('https://gl.example');
  expect(h.store.createPatProvider).toHaveBeenCalled();
});

it('POST 400 on missing token/providerType', async () => { expect((await POST(req({ name: 'x' }))).status).toBe(400); });

it('DELETE 403 when the row belongs to someone else', async () => {
  h.store.getProvider.mockResolvedValue({ id: 'g1', scope: 'personal', ownerUserId: 'other' });
  const res = await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'g1' }) });
  expect(res.status).toBe(403);
});
