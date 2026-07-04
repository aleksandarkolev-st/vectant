import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  actor: vi.fn(),
}));

vi.mock('@/lib/integrations/session', () => ({ resolveActor: h.actor }));

import { GET, POST, __resetTelemetryForTests } from '../route';
import { __resetRateLimits } from '@/lib/integrations/rateLimit';

function req(body, url = 'http://x/api/next-edit/telemetry') {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimits();
  __resetTelemetryForTests();
});

it('rejects unauthenticated telemetry writes and reads', async () => {
  h.actor.mockResolvedValue(null);

  expect((await POST(req({ events: [{ ts: Date.now(), kind: 'emitted' }] }))).status).toBe(401);
  expect((await GET(new Request('http://x/api/next-edit/telemetry'))).status).toBe(401);
});

it('stores only authenticated normalized events in the aggregate', async () => {
  h.actor.mockResolvedValue({ userId: 'u1', email: 'u@example.test' });
  const now = Date.now();

  const post = await POST(req({
    events: [
      { ts: now, kind: 'emitted', userId: 'spoofed', extra: 'ignored' },
      { ts: now, kind: 'validated' },
      { ts: now, kind: 'accepted' },
      { ts: now, kind: 'rejected', reason: 'no_match' },
      { ts: now, kind: 'not-real' },
      { ts: now + 10 * 60 * 1000, kind: 'accepted' },
      { ts: now - 8 * 24 * 60 * 60 * 1000, kind: 'accepted' },
      { ts: now, kind: 'rejected', reason: 'attacker_defined_reason' },
    ],
  }));

  expect(post.status).toBe(200);
  expect(await post.json()).toMatchObject({ ok: true, accepted: 5, ring_size: 5 });

  const get = await GET(new Request('http://x/api/next-edit/telemetry'));
  expect(get.status).toBe(200);
  const body = await get.json();
  expect(body.aggregate).toMatchObject({
    emitted: 1,
    validated: 1,
    accepted: 1,
    reasons: { no_match: 1, unknown: 1 },
  });
});

it('rate limits authenticated telemetry batches by server-side actor identity', async () => {
  h.actor.mockResolvedValue({ userId: 'u1', email: 'u@example.test' });

  for (let i = 0; i < 120; i += 1) {
    const res = await POST(req({ events: [{ ts: Date.now(), kind: 'fire' }] }));
    expect(res.status).toBe(200);
  }

  const limited = await POST(req({ events: [{ ts: Date.now(), kind: 'fire' }] }));
  expect(limited.status).toBe(429);
  expect(await limited.json()).toMatchObject({ error: 'rate_limited' });
});
