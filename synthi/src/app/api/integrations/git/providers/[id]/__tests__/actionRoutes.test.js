import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(), canRead: vi.fn(),
  prisma: { gitProvider: { findUnique: vi.fn() } },
  adapter: { listRepos: vi.fn(), createPullRequest: vi.fn(), getStatus: vi.fn() },
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/git/adapters/index.js', () => ({ getAdapter: () => h.adapter }));

import { GET as REPOS } from '../repos/route';
import { POST as PULLS } from '../pulls/route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

beforeEach(() => { __resetRateLimits(); vi.clearAllMocks();
  h.actor.mockResolvedValue({ userId: 'u1' });
  h.prisma.gitProvider.findUnique.mockResolvedValue({ id: 'g1', providerType: 'gitlab', scope: 'personal', ownerUserId: 'u1', secret: {} });
});

it('repos: dispatches to the adapter for an owned provider', async () => {
  h.adapter.listRepos.mockResolvedValue({ ok: true, repos: [{ id: 1 }] });
  const res = await REPOS(new Request('http://x/api/integrations/git/providers/g1/repos'), { params: Promise.resolve({ id: 'g1' }) });
  expect(res.status).toBe(200);
  expect((await res.json()).repos).toHaveLength(1);
});

it('repos: 403 for a provider owned by another user', async () => {
  h.prisma.gitProvider.findUnique.mockResolvedValue({ id: 'g1', scope: 'personal', ownerUserId: 'other', secret: {} });
  const res = await REPOS(new Request('http://x/api/integrations/git/providers/g1/repos'), { params: Promise.resolve({ id: 'g1' }) });
  expect(res.status).toBe(403);
});

it('pulls: 502 + typed error when the adapter fails', async () => {
  h.adapter.createPullRequest.mockResolvedValue({ ok: false, error: { code: 'forbidden', message: 'gitlab 403' } });
  const res = await PULLS(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo: 'g/p', sourceBranch: 'f', targetBranch: 'main', title: 't' }) }), { params: Promise.resolve({ id: 'g1' }) });
  expect(res.status).toBe(502);
  expect((await res.json()).error).toBe('forbidden');
});
