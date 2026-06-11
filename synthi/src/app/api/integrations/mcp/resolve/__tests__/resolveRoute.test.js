import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ auth: vi.fn(), resolve: vi.fn(), canRead: vi.fn() }));
vi.mock('@/lib/integrations/patAuth', () => ({ authenticatePat: h.auth }));
vi.mock('@/lib/integrations/connectionStore', () => ({ resolveToolConfigs: h.resolve }));
vi.mock('@/lib/integrations/scope', () => ({ canReadScope: h.canRead }));

import { GET } from '../route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

function req(slug) {
  const qs = slug ? `?workspaceSlug=${encodeURIComponent(slug)}` : '';
  return new Request(`http://x/api/integrations/mcp/resolve${qs}`, { headers: { authorization: 'Bearer synthi_pat_xxxxxxxxxxxxxxxxxxxxxxxx' } });
}

beforeEach(() => { __resetRateLimits(); vi.clearAllMocks(); h.resolve.mockResolvedValue([{ id: 'c1', name: 'gh' }]); });

it('401 when the PAT is invalid', async () => {
  h.auth.mockResolvedValue(null);
  const res = await GET(req());
  expect(res.status).toBe(401);
  expect(h.resolve).not.toHaveBeenCalled();
});

it('returns personal-only configs when no workspaceSlug is given', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect((await res.json()).configs).toEqual([{ id: 'c1', name: 'gh' }]);
  expect(h.resolve).toHaveBeenCalledWith({ userId: 'u1', workspaceSlug: null });
});

it('includes the workspace scope only for a member', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(true);
  await GET(req('team'));
  expect(h.resolve).toHaveBeenCalledWith({ userId: 'u1', workspaceSlug: 'team' });
});

it('degrades a non-member workspaceSlug to personal-only', async () => {
  h.auth.mockResolvedValue({ userId: 'u1' });
  h.canRead.mockResolvedValue(false);
  await GET(req('team'));
  expect(h.resolve).toHaveBeenCalledWith({ userId: 'u1', workspaceSlug: null });
});
