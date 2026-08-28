import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearExpertiseRoutingStateCache,
  expertiseRoutingStateCacheSize,
  getCachedExpertiseRoutingState,
  invalidateExpertiseRoutingState,
} from '../expertiseIndexCache';

describe('expertise routing state cache', () => {
  afterEach(() => {
    clearExpertiseRoutingStateCache();
  });

  it('coalesces concurrent cold loads and reuses a project entry until expiry', async () => {
    const loader = vi.fn(async () => ({ loadedAt: 1 }));
    const [first, second] = await Promise.all([
      getCachedExpertiseRoutingState('project-a', loader, { now: 100, ttlMs: 50 }),
      getCachedExpertiseRoutingState('project-a', loader, { now: 100, ttlMs: 50 }),
    ]);

    expect(first).toEqual({ loadedAt: 1 });
    expect(second).toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(getCachedExpertiseRoutingState('project-a', loader, { now: 149, ttlMs: 50 }))
      .resolves.toBe(first);
    expect(loader).toHaveBeenCalledTimes(1);
    await expect(getCachedExpertiseRoutingState('project-a', loader, { now: 150, ttlMs: 50 }))
      .resolves.toEqual({ loadedAt: 1 });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('isolates projects and invalidates only the changed project', async () => {
    const loader = vi.fn(async () => ({ call: loader.mock.calls.length }));
    await getCachedExpertiseRoutingState('project-a', loader, { now: 100 });
    await getCachedExpertiseRoutingState('project-b', loader, { now: 100 });
    expect(expertiseRoutingStateCacheSize()).toBe(2);

    invalidateExpertiseRoutingState('project-a');
    await getCachedExpertiseRoutingState('project-b', loader, { now: 101 });
    await getCachedExpertiseRoutingState('project-a', loader, { now: 101 });

    expect(loader).toHaveBeenCalledTimes(3);
    expect(expertiseRoutingStateCacheSize()).toBe(2);
  });

  it('does not retain failed loads', async () => {
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ recovered: true });

    await expect(getCachedExpertiseRoutingState('project-a', loader, { now: 100 }))
      .rejects.toThrow('database unavailable');
    await expect(getCachedExpertiseRoutingState('project-a', loader, { now: 101 }))
      .resolves.toEqual({ recovered: true });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
