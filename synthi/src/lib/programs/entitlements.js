/**
 * @fileoverview Publish entitlement + platform-admin hooks. `canPublish` is the
 * single gate every submit path (UI/API/MCP) must call — it returns true today;
 * a plan/paywall check slots in here later (out of scope). `isPlatformAdmin`
 * gates the cross-workspace review queue (env allow-list; fail-closed).
 */

/** Entitlement to publish. Returns true now; paywall slots in here later. */
export function canPublish(actor) {
  return !!(actor && actor.userId);
}

/** Platform (cross-workspace) admin, by env allow-list of emails. Fail-closed. */
export function isPlatformAdmin(actor) {
  const email = actor?.email && String(actor.email).trim().toLowerCase();
  if (!email) return false;
  const allow = String(process.env.PLATFORM_ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email);
}

/**
 * Is the billing stack configured enough to sell a paid app? We need both edges:
 * the checkout hand-off URL (to send a buyer) and the webhook secret (to receive
 * the grant). Fail-closed: if either is missing, a paid app can't be transacted,
 * so `canInstall` denies it rather than silently treating it as free.
 */
export function isBillingConfigured(env = process.env) {
  return !!(env.PAYMENTS_CHECKOUT_URL && String(env.PAYMENTS_CHECKOUT_URL).trim()
    && env.STRIPE_WEBHOOK_SECRET && String(env.STRIPE_WEBHOOK_SECRET).trim());
}

/**
 * Paywall policy (pure). The caller computes the inputs from the stores/env:
 *   - isPaid: from `pricing.isPaid(pricing)`
 *   - entitled: an active `Entitlement` exists for the subject
 *   - billingConfigured: `isBillingConfigured()`
 * Free apps always install. Paid apps install only with an active entitlement,
 * and never when billing is unconfigured (fail-closed).
 *
 * @returns {{ ok: boolean, reason?: string, priceCents?: number|null, currency?: string|null }}
 */
export function canInstall({ isPaid = false, entitled = false, billingConfigured = false, pricing = null } = {}) {
  if (!isPaid) return { ok: true };
  if (!billingConfigured) return { ok: false, reason: 'billing_unconfigured' };
  if (entitled) return { ok: true };
  return {
    ok: false,
    reason: 'payment_required',
    priceCents: pricing?.priceCents ?? null,
    currency: pricing?.currency ?? null,
  };
}
