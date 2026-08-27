const cache = new Map();

function clockMs(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function cacheKey(projectId) {
  return String(projectId || '').trim();
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function evictLeastRecentlyUsed(maxEntries) {
  while (cache.size > maxEntries) {
    const candidates = [...cache.entries()]
      .filter(([, entry]) => !entry.promise)
      .sort(([, left], [, right]) => left.lastAccessAt - right.lastAccessAt);
    const oldest = candidates[0];
    if (!oldest) return;
    cache.delete(oldest[0]);
  }
}

/**
 * Cache one project's routing inputs and coalesce concurrent cold loads.
 * The loader is owned by the control plane; this module deliberately knows
 * nothing about Prisma or agent data.
 */
export async function getCachedExpertiseRoutingState(
  projectId,
  loader,
  { now, ttlMs = 15_000, maxEntries = 64, forceRefresh = false } = {},
) {
  const key = cacheKey(projectId);
  if (!key) return loader();
  const nowValue = clockMs(now);
  const ttl = Math.max(Number(ttlMs) || 0, 1);
  const max = positiveInteger(maxEntries, 64);
  const current = cache.get(key);

  if (!forceRefresh && current?.value !== undefined && current.expiresAt > nowValue) {
    current.lastAccessAt = nowValue;
    return current.value;
  }
  if (current?.promise) return current.promise;

  const promise = Promise.resolve().then(loader);
  cache.set(key, { promise, lastAccessAt: nowValue });
  try {
    const value = await promise;
    cache.set(key, {
      value,
      expiresAt: nowValue + ttl,
      lastAccessAt: nowValue,
    });
    evictLeastRecentlyUsed(max);
    return value;
  } catch (error) {
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  }
}

export function invalidateExpertiseRoutingState(projectId = null) {
  const key = cacheKey(projectId);
  if (key) cache.delete(key);
  else cache.clear();
}

export function clearExpertiseRoutingStateCache() {
  cache.clear();
}

export function expertiseRoutingStateCacheSize() {
  return cache.size;
}
