import { afterEach, describe, expect, it } from 'vitest';
import { canPublish, isPlatformAdmin } from '../entitlements';

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
