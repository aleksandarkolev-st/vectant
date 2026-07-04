import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  prisma: { programPricing: { upsert: vi.fn(), findUnique: vi.fn() } },
}));
vi.mock('@/lib/prisma', () => ({ default: h.prisma }));

import {
  parsePricingInput, platformTakeBps, isPaid, upsertPricing, getPricing, PricingError,
} from '../pricing';

beforeEach(() => vi.clearAllMocks());

describe('parsePricingInput', () => {
  it('accepts a valid input and applies defaults', () => {
    const r = parsePricingInput({ priceCents: 500 });
    expect(r).toEqual({ priceCents: 500, currency: 'eur', model: 'one_time', payoutAccountRef: null, active: true });
  });

  it('lowercases + accepts a known currency and a payout account', () => {
    const r = parsePricingInput({ priceCents: 500, currency: 'USD', payoutAccountRef: ' acct_123 ', active: false });
    expect(r.currency).toBe('usd');
    expect(r.payoutAccountRef).toBe('acct_123');
    expect(r.active).toBe(false);
  });

  it('rejects a non-integer / negative price', () => {
    expect(() => parsePricingInput({ priceCents: 1.5 })).toThrow(PricingError);
    expect(() => parsePricingInput({ priceCents: -1 })).toThrow(PricingError);
    expect(() => parsePricingInput({ priceCents: '5' })).toThrow(PricingError);
  });

  it('rejects an unknown currency', () => {
    expect(() => parsePricingInput({ priceCents: 5, currency: 'xyz' })).toThrow(/currency/i);
  });

  it('rejects an unsupported pricing model (v1 = one_time only)', () => {
    expect(() => parsePricingInput({ priceCents: 5, model: 'subscription' })).toThrow(/model/i);
  });

  it('rejects a blank payout account when provided', () => {
    expect(() => parsePricingInput({ priceCents: 5, payoutAccountRef: '   ' })).toThrow(/payout/i);
  });
});

describe('platformTakeBps', () => {
  it('defaults to 3000 bps', () => {
    expect(platformTakeBps({})).toBe(3000);
  });
  it('reads a valid env override', () => {
    expect(platformTakeBps({ PROGRAM_PLATFORM_TAKE_BPS: '1500' })).toBe(1500);
  });
  it('falls back to default on out-of-range/invalid', () => {
    expect(platformTakeBps({ PROGRAM_PLATFORM_TAKE_BPS: '20000' })).toBe(3000);
    expect(platformTakeBps({ PROGRAM_PLATFORM_TAKE_BPS: 'abc' })).toBe(3000);
  });
});

describe('isPaid', () => {
  it('is true only for an active, positive price', () => {
    expect(isPaid({ active: true, priceCents: 100 })).toBe(true);
  });
  it('is false for free (0), inactive, or missing pricing', () => {
    expect(isPaid({ active: true, priceCents: 0 })).toBe(false);
    expect(isPaid({ active: false, priceCents: 100 })).toBe(false);
    expect(isPaid(null)).toBe(false);
  });
});

describe('upsertPricing', () => {
  it('upserts parsed data with the platform take-rate from env', async () => {
    h.prisma.programPricing.upsert.mockResolvedValue({ id: 'p1' });
    await upsertPricing('prog1', { priceCents: 500, currency: 'usd' }, { env: { PROGRAM_PLATFORM_TAKE_BPS: '2500' } });
    const arg = h.prisma.programPricing.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ programId: 'prog1' });
    expect(arg.create).toMatchObject({ programId: 'prog1', priceCents: 500, currency: 'usd', takeRateBps: 2500 });
    expect(arg.update).toMatchObject({ priceCents: 500, takeRateBps: 2500 });
    expect(arg.update.programId).toBeUndefined();
  });

  it('throws (never writes) on invalid input', async () => {
    await expect(upsertPricing('prog1', { priceCents: -5 })).rejects.toThrow(PricingError);
    expect(h.prisma.programPricing.upsert).not.toHaveBeenCalled();
  });
});

describe('getPricing', () => {
  it('reads by programId', async () => {
    h.prisma.programPricing.findUnique.mockResolvedValue({ id: 'p1' });
    await getPricing('prog1');
    expect(h.prisma.programPricing.findUnique).toHaveBeenCalledWith({ where: { programId: 'prog1' } });
  });
});
