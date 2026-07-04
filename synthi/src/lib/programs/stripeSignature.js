/**
 * @fileoverview Verify Stripe's `Stripe-Signature` header without pulling in the
 * Stripe SDK (synthi has no `stripe` dependency). Implements Stripe's documented
 * scheme: signed_payload = `${t}.${rawBody}`, HMAC-SHA256(secret) hex, compared
 * timing-safe against the header's `v1` value(s), with a timestamp tolerance to
 * blunt replays. Pure (node:crypto); `nowSec` is injectable for tests.
 */

import crypto from 'node:crypto';

/** Parse `t=…,v1=…,v1=…` into `{ t, v1: [] }`. */
export function parseSigHeader(header) {
  const out = { t: null, v1: [] };
  if (typeof header !== 'string') return out;
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === 't') out.t = v;
    else if (k === 'v1' && v) out.v1.push(v);
  }
  return out;
}

/**
 * @param {string} rawBody - the exact raw request body
 * @param {string} sigHeader - the `Stripe-Signature` header
 * @param {string} secret - STRIPE_WEBHOOK_SECRET
 * @returns {boolean}
 */
export function verifyStripeSignature(rawBody, sigHeader, secret, { toleranceSec = 300, nowSec } = {}) {
  if (!secret || typeof rawBody !== 'string') return false;
  const { t, v1 } = parseSigHeader(sigHeader);
  if (!t || v1.length === 0) return false;
  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Number.isFinite(nowSec) ? nowSec : Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSec) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const want = Buffer.from(expected);
  return v1.some((sig) => {
    const got = Buffer.from(sig);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}
