import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getPricing: vi.fn(),
  isPaid: vi.fn(),
  getActiveEntitlement: vi.fn(),
  isBillingConfigured: vi.fn(),
}));
vi.mock('@/lib/programs/pricing', () => ({ getPricing: h.getPricing, isPaid: h.isPaid }));
vi.mock('@/lib/programs/paidEntitlements', () => ({ getActiveEntitlement: h.getActiveEntitlement }));
vi.mock('@/lib/programs/entitlements', async (orig) => ({
  ...(await orig()),
  isBillingConfigured: h.isBillingConfigured,
}));

import { evaluatePaywall, paywallDenial } from '../paidGate';

beforeEach(() => {
  vi.clearAllMocks();
  h.isBillingConfigured.mockReturnValue(true);
});

describe('evaluatePaywall', () => {
  it('allows a free program without checking entitlement', async () => {
    h.getPricing.mockResolvedValue(null);
    h.isPaid.mockReturnValue(false);
    expect(await evaluatePaywall({ programId: 'prog1', subjectId: 'u1' })).toEqual({ ok: true });
    expect(h.getActiveEntitlement).not.toHaveBeenCalled();
  });

  it('allows a paid program when entitled', async () => {
    h.getPricing.mockResolvedValue({ priceCents: 500, currency: 'eur' });
    h.isPaid.mockReturnValue(true);
    h.getActiveEntitlement.mockResolvedValue({ id: 'e1', status: 'active' });
    expect(await evaluatePaywall({ programId: 'prog1', subjectId: 'u1' })).toEqual({ ok: true });
  });

  it('requires payment for a paid program when not entitled', async () => {
    h.getPricing.mockResolvedValue({ priceCents: 500, currency: 'eur' });
    h.isPaid.mockReturnValue(true);
    h.getActiveEntitlement.mockResolvedValue(null);
    const r = await evaluatePaywall({ programId: 'prog1', subjectId: 'u1' });
    expect(r).toMatchObject({ ok: false, reason: 'payment_required', priceCents: 500 });
  });

  it('fails closed when billing is unconfigured', async () => {
    h.getPricing.mockResolvedValue({ priceCents: 500, currency: 'eur' });
    h.isPaid.mockReturnValue(true);
    h.getActiveEntitlement.mockResolvedValue({ status: 'active' });
    h.isBillingConfigured.mockReturnValue(false);
    expect((await evaluatePaywall({ programId: 'prog1', subjectId: 'u1' })).reason).toBe('billing_unconfigured');
  });
});

describe('paywallDenial', () => {
  it('returns null when allowed', () => {
    expect(paywallDenial({ ok: true })).toBeNull();
  });
  it('maps payment_required → 402 with price', () => {
    expect(paywallDenial({ ok: false, reason: 'payment_required', priceCents: 500, currency: 'eur' }))
      .toEqual({ status: 402, body: { error: 'payment_required', priceCents: 500, currency: 'eur' } });
  });
  it('maps billing_unconfigured → 503', () => {
    expect(paywallDenial({ ok: false, reason: 'billing_unconfigured' }).status).toBe(503);
  });
});
