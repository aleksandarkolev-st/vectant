import { describe, it, expect, vi, beforeEach } from 'vitest';
const h = vi.hoisted(() => ({
  actor: vi.fn(), fetchMock: vi.fn(), assertSafe: vi.fn(async () => {}),
  prisma: { encryptedSecret: { create: vi.fn(), deleteMany: vi.fn() }, gitProvider: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() } },
}));
vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));
vi.mock('@/lib/tokenCrypto', () => ({ encryptToken: (t) => `c(${t})` }));
vi.mock('@synthi/mcp-hub', () => ({ assertSafeUrl: h.assertSafe }));

import { POST as START } from '../start/route';
import { POST as POLL } from '../poll/route';
beforeEach(() => { vi.clearAllMocks(); global.fetch = h.fetchMock; h.actor.mockResolvedValue({ userId: 'u1' });
  h.prisma.gitProvider.findFirst.mockResolvedValue(null);
  process.env.GITHUB_ID = 'cid'; delete process.env.GITHUB_CLIENT_ID; });

it('start returns the device + user code', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ device_code: 'dc', user_code: 'WX-YZ', verification_uri: 'https://gh/device', interval: 5 }) });
  const res = await START(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(200);
  expect((await res.json())).toMatchObject({ user_code: 'WX-YZ', verification_uri: 'https://gh/device' });
});

it('sends the NextAuth GITHUB_ID as client_id for GitHub (not GITHUB_CLIENT_ID)', async () => {
  process.env.GITHUB_ID = 'ghid';
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ device_code: 'dc', user_code: 'X', verification_uri: 'u', interval: 5 }) });
  await START(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ provider: 'github' }) });
  expect(h.fetchMock.mock.calls[0][1].body.toString()).toContain('client_id=ghid');
});

it('SSRF-guards the device-start request via gitFetch', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ device_code: 'dc', user_code: 'X', verification_uri: 'u', interval: 5 }) });
  await START(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ provider: 'github' }) });
  expect(h.assertSafe).toHaveBeenCalledWith('https://github.com/login/device/code');
});

it('poll stores tokens + creates the provider on success', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 7200 }) });
  h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'sec' }); h.prisma.gitProvider.create.mockResolvedValue({ id: 'g1' });
  const res = await POLL(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(201);
  expect(h.prisma.gitProvider.create).toHaveBeenCalled();
});

it('poll updates the existing oauth provider on re-link instead of creating a duplicate', async () => {
  h.prisma.gitProvider.findFirst.mockResolvedValue({ id: 'old', secretId: 's0', refreshSecretId: 'r0' });
  h.prisma.encryptedSecret.create.mockResolvedValue({ id: 'sec' });
  h.prisma.gitProvider.update.mockResolvedValue({ id: 'old', name: 'GitHub', providerType: 'github' });
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ access_token: 'AT2', expires_in: 7200 }) });
  const res = await POLL(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(201);
  expect(h.prisma.gitProvider.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'old' } }));
  expect(h.prisma.gitProvider.create).not.toHaveBeenCalled();
  expect(h.prisma.encryptedSecret.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s0', 'r0'] } } });
});

it('poll relays authorization_pending without creating a provider', async () => {
  h.fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'authorization_pending' }) });
  const res = await POLL(new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) }), { params: Promise.resolve({ provider: 'github' }) });
  expect(res.status).toBe(202);
  expect(h.prisma.gitProvider.create).not.toHaveBeenCalled();
});
