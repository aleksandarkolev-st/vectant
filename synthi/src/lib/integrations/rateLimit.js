/**
 * Dependency-free fixed-window rate limiter for the integrations API and external
 * tool calls (Plan 1a addendum R1-A / R1-3).
 *
 * NOTE: state lives in an in-memory Map, so limits are **per-process / per-instance**,
 * NOT distributed across replicas. This is acceptable for v1; a Redis-backed limiter
 * is a later hardening item. Buckets are reset lazily on access (no background timer).
 */

/** @type {Map<string, { count: number, resetAt: number }>} */
const buckets = new Map();

/**
 * Record one hit against `key` and report whether it is within the limit.
 * @param {string} key                 caller-chosen bucket key, e.g. `user:<id>:crud`
 * @param {{limit:number, windowMs:number}} opts
 * @returns {{ ok: boolean, retryAfterMs?: number }}
 */
export function checkLimit(key, { limit, windowMs }) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
  }
  bucket.count += 1;
  return { ok: true };
}

/**
 * Default limit groups (env-overridable). Callers pick a group + build the key.
 * - crud:    integrations CRUD (create/edit/delete/list)
 * - test:    outbound connection test (health probe)
 * - extcall: external MCP tool executions
 */
export const RATE_LIMITS = {
  crud: { limit: Number(process.env.SYNTHI_RL_CRUD) || 30, windowMs: 60_000 },
  test: { limit: Number(process.env.SYNTHI_RL_TEST) || 10, windowMs: 60_000 },
  extcall: { limit: Number(process.env.SYNTHI_RL_EXTCALL) || 60, windowMs: 60_000 },
};

/** Test-only: clear all buckets. */
export function __resetRateLimits() {
  buckets.clear();
}
