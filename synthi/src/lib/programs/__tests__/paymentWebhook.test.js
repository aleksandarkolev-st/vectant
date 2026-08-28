import { describe, expect, it } from 'vitest';
import { eventKind, extractContext } from '../paymentWebhook';

describe('eventKind', () => {
  it('maps the two events we act on, ignores the rest', () => {
    expect(eventKind('payment_intent.succeeded')).toBe('purchase');
    expect(eventKind('charge.refunded')).toBe('refund');
    expect(eventKind('invoice.paid')).toBeNull();
    expect(eventKind(undefined)).toBeNull();
  });
});

describe('extractContext', () => {
  it('reads program/subject/reference/price from metadata', () => {
    const event = {
      data: { object: { currency: 'eur', metadata: { programId: 'prog1', subjectId: 'u1', reference: 'ref_1', priceCents: '500' } } },
    };
    expect(extractContext(event)).toEqual({
      programId: 'prog1', subjectId: 'u1', subjectType: 'user', reference: 'ref_1', priceCents: 500, currency: 'eur',
    });
  });

  it('returns nulls when metadata is absent', () => {
    const ctx = extractContext({ data: { object: {} } });
    expect(ctx.programId).toBeNull();
    expect(ctx.subjectId).toBeNull();
    expect(ctx.priceCents).toBeNull();
  });
});
