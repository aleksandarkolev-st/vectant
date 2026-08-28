/**
 * @fileoverview Pure publisher-earnings math. Gross = the sum of captured prices
 * of active purchases; the platform takes `takeRateBps`; net is the remainder.
 * Read-only — actual money movement / payout is the external payments app's job.
 */

/**
 * @param {Array<{status:string,source:string,priceCents:number|null}>} entitlements
 * @param {{ takeRateBps?: number }} opts
 */
export function computeEarnings(entitlements = [], { takeRateBps = 3000 } = {}) {
  const rate = Number.isFinite(takeRateBps) && takeRateBps >= 0 && takeRateBps <= 10000 ? takeRateBps : 3000;
  const purchases = (Array.isArray(entitlements) ? entitlements : []).filter(
    (e) => e && e.status === 'active' && e.source === 'purchase' && Number.isInteger(e.priceCents),
  );
  const grossCents = purchases.reduce((n, e) => n + e.priceCents, 0);
  const platformCents = Math.round((grossCents * rate) / 10000);
  return { count: purchases.length, grossCents, platformCents, netCents: grossCents - platformCents, takeRateBps: rate };
}
