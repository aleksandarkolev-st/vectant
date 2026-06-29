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
