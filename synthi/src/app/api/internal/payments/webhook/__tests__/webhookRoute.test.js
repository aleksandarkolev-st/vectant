import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/lib/programs/stripeSignature', () => ({ verifyStripeSignature: h.verify }));
vi.mock('@/lib/programs/paidEntitlements', () => ({ grantEntitlement: h.grant, revokeEntitlement: h.revoke }));
vi.mock('@/lib/programs/store', () => ({ recordWebhookEventOnce: h.record }));
// paymentWebhook (eventKind/extractContext) is pure — use the real implementation.

import { POST as WEBHOOK } from '../route.js';

const meta = { programId: 'prog1', subjectId: 'u1', reference: 'ref_1', priceCents: '500', currency: 'eur' };
const evt = (type, metadata = meta, id = 'evt_1') => JSON.stringify({ id, type, data: { object: { metadata } } });
const call = (raw) => WEBHOOK({ text: async () => raw, headers: { get: () => 't=1,v1=sig' } });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_1';
  h.verify.mockReturnValue(true);
  h.record.mockResolvedValue(true);
});

describe('POST /api/internal/payments/webhook', () => {
  it('503 when the webhook secret is unset', async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect((await call(evt('payment_intent.succeeded'))).status).toBe(503);
  });

  it('401 on a bad signature (nothing granted)', async () => {
    h.verify.mockReturnValue(false);
    const res = await call(evt('payment_intent.succeeded'));
    expect(res.status).toBe(401);
    expect(h.grant).not.toHaveBeenCalled();
  });

  it('ignores an event type we do not act on', async () => {
    const res = await call(evt('invoice.paid'));
    expect(await res.json()).toEqual({ ignored: true });
    expect(h.grant).not.toHaveBeenCalled();
  });

  it('400 when metadata is missing program/subject', async () => {
    const res = await call(evt('payment_intent.succeeded', {}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('missing_metadata');
  });

  it('purchase → grants the entitlement and records the event', async () => {
    const res = await call(evt('payment_intent.succeeded'));
    expect(await res.json()).toMatchObject({ ok: true, kind: 'purchase', duplicate: false });
    expect(h.grant).toHaveBeenCalledWith(expect.objectContaining({
      programId: 'prog1', subjectId: 'u1', source: 'purchase', reference: 'ref_1', priceCents: 500,
    }));
    expect(h.record).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'evt_1', type: 'purchase' }));
  });

  it('refund → revokes the entitlement', async () => {
    const res = await call(evt('charge.refunded'));
    expect(await res.json()).toMatchObject({ ok: true, kind: 'refund' });
    expect(h.revoke).toHaveBeenCalledWith(expect.objectContaining({ programId: 'prog1', subjectId: 'u1' }));
    expect(h.grant).not.toHaveBeenCalled();
  });

  it('reports a replayed event as duplicate (idempotent)', async () => {
    h.record.mockResolvedValue(false);
    const res = await call(evt('payment_intent.succeeded'));
    expect(await res.json()).toMatchObject({ ok: true, duplicate: true });
  });
});
