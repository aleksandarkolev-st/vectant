import { describe, expect, it } from 'vitest';
import { computeEarnings } from '../earnings';

describe('computeEarnings', () => {
  it('is all zeros for no entitlements', () => {
    expect(computeEarnings([], { takeRateBps: 3000 })).toEqual({
      count: 0, grossCents: 0, platformCents: 0, netCents: 0, takeRateBps: 3000,
    });
  });

  it('counts only active purchases with an integer price', () => {
    const ents = [
      { status: 'active', source: 'purchase', priceCents: 500 },
      { status: 'active', source: 'purchase', priceCents: 1000 },
      { status: 'revoked', source: 'purchase', priceCents: 900 }, // refunded — excluded
      { status: 'active', source: 'grant', priceCents: 900 },     // comped — excluded
      { status: 'active', source: 'purchase', priceCents: null }, // no captured price — excluded
    ];
    const r = computeEarnings(ents, { takeRateBps: 3000 });
    expect(r.count).toBe(2);
    expect(r.grossCents).toBe(1500);
    expect(r.platformCents).toBe(450); // 30%
    expect(r.netCents).toBe(1050);
  });

  it('clamps an out-of-range take-rate to the default', () => {
    const r = computeEarnings([{ status: 'active', source: 'purchase', priceCents: 1000 }], { takeRateBps: 99999 });
    expect(r.takeRateBps).toBe(3000);
    expect(r.platformCents).toBe(300);
  });
});
