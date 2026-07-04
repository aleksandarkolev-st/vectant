import { afterEach, describe, expect, it } from 'vitest';
import { canPublish, isPlatformAdmin, canInstall, isBillingConfigured } from '../entitlements';

const ORIG = process.env.PLATFORM_ADMIN_EMAILS;
afterEach(() => { process.env.PLATFORM_ADMIN_EMAILS = ORIG; });

describe('canPublish', () => {
  it('returns true for any authenticated actor (paywall is a later concern)', () => {
    expect(canPublish({ userId: 'u1', email: 'a@b.c' })).toBe(true);
  });
  it('returns false without an actor', () => {
    expect(canPublish(null)).toBe(false);
  });
});

describe('isPlatformAdmin', () => {
  it('matches an email in the allow-list (case-insensitive)', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'Boss@x.io, admin@y.io';
    expect(isPlatformAdmin({ email: 'admin@y.io' })).toBe(true);
    expect(isPlatformAdmin({ email: 'BOSS@x.io' })).toBe(true);
  });
  it('rejects a non-listed email', () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'admin@y.io';
    expect(isPlatformAdmin({ email: 'someone@else.io' })).toBe(false);
  });
  it('fails closed when no admins are configured', () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    expect(isPlatformAdmin({ email: 'admin@y.io' })).toBe(false);
  });
});

describe('isBillingConfigured', () => {
  it('is true only when both the checkout URL and webhook secret are set', () => {
    expect(isBillingConfigured({ PAYMENTS_CHECKOUT_URL: 'https://pay/x', STRIPE_WEBHOOK_SECRET: 'whsec_1' })).toBe(true);
  });
  it('is false when either is missing', () => {
    expect(isBillingConfigured({ PAYMENTS_CHECKOUT_URL: 'https://pay/x' })).toBe(false);
    expect(isBillingConfigured({ STRIPE_WEBHOOK_SECRET: 'whsec_1' })).toBe(false);
    expect(isBillingConfigured({})).toBe(false);
  });
});

describe('canInstall', () => {
  const pricing = { priceCents: 500, currency: 'eur' };

  it('allows a free app regardless of billing/entitlement', () => {
    expect(canInstall({ isPaid: false })).toEqual({ ok: true });
  });

  it('allows a paid app when configured and entitled', () => {
    expect(canInstall({ isPaid: true, entitled: true, billingConfigured: true, pricing })).toEqual({ ok: true });
  });

  it('requires payment for a paid app when not entitled (echoes price)', () => {
    const r = canInstall({ isPaid: true, entitled: false, billingConfigured: true, pricing });
    expect(r).toEqual({ ok: false, reason: 'payment_required', priceCents: 500, currency: 'eur' });
  });

  it('fails closed for a paid app when billing is unconfigured (never silently free)', () => {
    const r = canInstall({ isPaid: true, entitled: true, billingConfigured: false, pricing });
    expect(r).toEqual({ ok: false, reason: 'billing_unconfigured' });
  });
});
