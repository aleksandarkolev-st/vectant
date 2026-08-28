/**
 * @fileoverview HMAC-signed checkout reference. Binds the checkout hand-off
 * (programId + subject + server-authoritative price) so the value we send to the
 * external payments app — and that comes back as PaymentIntent metadata — can be
 * verified as ours and untampered. Pure (node:crypto). The secret is
 * PAYMENTS_HANDOFF_SECRET; the reference is deterministic per (program, subject,
 * price), which is exactly the idempotency key we want.
 */

import crypto from 'node:crypto';

const VERSION = 'v1';

function resolveSecret(secret) {
  const s = secret === undefined ? process.env.PAYMENTS_HANDOFF_SECRET : secret;
  return typeof s === 'string' && s ? s : null;
}

/** Sign `{programId, subjectId, priceCents, currency, ...}` → `v1.<body>.<mac>`. */
export function signCheckoutReference(payload, { secret } = {}) {
  const key = resolveSecret(secret);
  if (!key) throw new Error('PAYMENTS_HANDOFF_SECRET is not configured');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(`${VERSION}.${body}`).digest('base64url');
  return `${VERSION}.${body}.${mac}`;
}

/** Verify a reference token. @returns {{ valid: boolean, payload?: object }} */
export function verifyCheckoutReference(token, { secret } = {}) {
  const key = resolveSecret(secret);
  if (!key || typeof token !== 'string') return { valid: false };
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false };
  const [ver, body, mac] = parts;
  if (ver !== VERSION) return { valid: false };
  const expected = crypto.createHmac('sha256', key).update(`${ver}.${body}`).digest('base64url');
  const got = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return { valid: false };
  try {
    return { valid: true, payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) };
  } catch {
    return { valid: false };
  }
}
