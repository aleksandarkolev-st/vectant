import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkLimit, __resetRateLimits, RATE_LIMITS } from '../rateLimit.js';

beforeEach(() => {
  __resetRateLimits();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('checkLimit', () => {
  it('allows up to the limit, then blocks with a retryAfterMs', () => {
    const opts = { limit: 3, windowMs: 1000 };
    expect(checkLimit('k', opts).ok).toBe(true);
    expect(checkLimit('k', opts).ok).toBe(true);
    expect(checkLimit('k', opts).ok).toBe(true);
    const blocked = checkLimit('k', opts);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('resets after the window elapses', () => {
    const opts = { limit: 1, windowMs: 1000 };
    expect(checkLimit('k', opts).ok).toBe(true);
    expect(checkLimit('k', opts).ok).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(checkLimit('k', opts).ok).toBe(true);
  });

  it('tracks keys independently', () => {
    const opts = { limit: 1, windowMs: 1000 };
    expect(checkLimit('a', opts).ok).toBe(true);
    expect(checkLimit('b', opts).ok).toBe(true); // different key, own budget
    expect(checkLimit('a', opts).ok).toBe(false);
    expect(checkLimit('b', opts).ok).toBe(false);
  });

  it('exposes sane default limit groups', () => {
    expect(RATE_LIMITS.crud.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.test.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.extcall.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.crud.windowMs).toBe(60_000);
  });
});
