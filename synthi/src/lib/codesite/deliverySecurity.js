import { createHash, createHmac, randomBytes } from 'crypto';

/**
 * Workstream F.2 — outbound delivery adapter hardening.
 *
 * Plan §7.3: "callback delivery uses allowlisted origins, signed envelopes,
 * replay protection, retries, and a durable failure record" and forbids
 * "arbitrary unreviewed external webhook targets".
 *
 * - Origins come from SYNTHI_CODESITE_DELIVERY_ALLOWED_ORIGINS(_JSON) — a
 *   comma list or JSON array of allowed origins ("https://hooks.example.test"
 *   or "*.example.test" wildcard suffix entries). When unset/empty, ALL
 *   external delivery is refused (fail-closed).
 * - Every outbound request carries an HMAC-SHA256 signature over
 *   timestamp + nonce + SHA-256 body digest, keyed with the shared internal
 *   token (SYNTHI_CODESITE_DELIVERY_SIGNING_SECRET falls back to
 *   SYNTHI_CODESITE_TOKEN). Receivers recompute it to authenticate the sender.
 * - The timestamp window + per-attempt nonce give receivers replay protection;
 *   attempts and failures are recorded durably on the inbox item by
 *   dispatchInboxDeliveryAdapters.
 */

export function deliveryAllowedOrigins() {
  const raw = process.env.SYNTHI_CODESITE_DELIVERY_ALLOWED_ORIGINS_JSON
    || process.env.SYNTHI_CODESITE_DELIVERY_ALLOWED_ORIGINS
    || '';
  const list = raw.trim().startsWith('[')
    ? safeParseArray(raw)
    : String(raw).split(',').map((entry) => entry.trim()).filter(Boolean);
  return new Set(list.map((origin) => origin.replace(/\/+$/, '').toLowerCase()));
}

function safeParseArray(text) {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (_) {
    return [];
  }
}

export function deliverySigningSecret() {
  return process.env.SYNTHI_CODESITE_DELIVERY_SIGNING_SECRET
    || process.env.SYNTHI_CODESITE_TOKEN
    || '';
}

/** Checks an endpoint against the configured allowlist. Fail-closed. */
export function endpointDeliveryAllowed(endpoint, allowlist = deliveryAllowedOrigins()) {
  let parsed;
  try {
    parsed = new URL(String(endpoint || ''));
  } catch (_) {
    return { ok: false, reason: 'endpoint_invalid' };
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'endpoint_protocol_unsupported' };
  }
  if (allowlist.size === 0) {
    return { ok: false, reason: 'delivery_allowlist_not_configured' };
  }
  const origin = `${parsed.protocol}//${parsed.host}`.toLowerCase();
  for (const allowed of allowlist) {
    if (allowed === origin) return { ok: true };
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(1); // ".example.test"
      if (parsed.hostname.toLowerCase().endsWith(suffix)) return { ok: true };
    }
  }
  return { ok: false, reason: 'endpoint_not_allowlisted' };
}

/** HMAC-SHA256 over `${timestamp}.${nonce}.${sha256(bodyText)}`. */
export function signDeliveryEnvelope(bodyText, secret = deliverySigningSecret(), options = {}) {
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce ?? randomBytes(12).toString('hex');
  const digestHex = createHash('sha256').update(bodyText).digest('hex');
  const base = `${timestamp}.${nonce}.${digestHex}`;
  const signature = createHmac('sha256', secret).update(base).digest('hex');
  return {
    'x-codesite-timestamp': String(timestamp),
    'x-codesite-nonce': nonce,
    'x-codesite-body-digest': `sha256:${digestHex}`,
    'x-codesite-signature': `sha256=${signature}`,
  };
}
