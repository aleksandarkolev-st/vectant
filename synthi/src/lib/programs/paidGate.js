/**
 * @fileoverview Route helper: compose the paywall for a (program, subject). Ties
 * the pricing + entitlement stores to the pure `canInstall` policy so both the
 * install and launch routes gate identically. A free program short-circuits
 * without an entitlement lookup.
 */

import { getPricing, isPaid } from './pricing';
import { getActiveEntitlement } from './paidEntitlements';
import { canInstall, isBillingConfigured } from './entitlements';

/**
 * @returns {Promise<{ ok: boolean, reason?: string, priceCents?: number|null, currency?: string|null }>}
 */
export async function evaluatePaywall({ programId, subjectId, subjectType = 'user' }) {
  const pricing = await getPricing(programId);
  if (!isPaid(pricing)) return { ok: true };
  const entitled = !!(await getActiveEntitlement({ programId, subjectType, subjectId }));
  return canInstall({ isPaid: true, entitled, billingConfigured: isBillingConfigured(), pricing });
}

/** Map a paywall decision to an HTTP { status, body }, or null when allowed. */
export function paywallDenial(decision) {
  if (!decision || decision.ok) return null;
  const status = decision.reason === 'billing_unconfigured' ? 503 : 402;
  return {
    status,
    body: { error: decision.reason, priceCents: decision.priceCents ?? null, currency: decision.currency ?? null },
  };
}
