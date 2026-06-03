import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(), fetchMock: vi.fn(),
  prisma: { encryptedSecret: { create: vi.fn() }, gitProvider: { create: vi.fn() } },
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: (t) => `c(${t})` }));

import { POST as START } from '../start/route';
import { POST as POLL } from '../poll/route';
beforeEach(() => { vi.clearAllMocks(); global.fetch = h.fetchMock; h.actor.mockResolvedValue({ userId: 'u1' });
  process.env.GITHUB_CLIENT_ID = 'cid'; });

it('start returns the device + user code', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ device_code: 'dc', user_code: 'WX-YZ', verification_uri: 'https://gh/device', interval: 5 }) });
  const res = await START(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(200);
  expect((await res.json())).toMatchObject({ user_code: 'WX-YZ', verification_uri: 'https://gh/device' });
});

it('poll stores tokens + creates the provider on success', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 7200 }) });
  h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'sec' }); h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1' });
  const res = await POLL(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(201);
  expect(h.prisma.gitProvider.create).toHaveBeenCalled();
});

it('poll relays authorization_pending without creating a provider', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'authorization_pending' }) });
  const res = await POLL(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(202);
  expect(h.prisma.gitProvider.create).not.toHaveBeenCalled();
});
