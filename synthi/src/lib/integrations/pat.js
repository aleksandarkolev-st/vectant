import crypto from 'node:crypto';

const PREFIX = 'synthi_pat_';

/** sha256 hex of a token string. Stored + looked up — the plaintext is never persisted. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Generate a new PAT. Returns { token (plaintext — show once), tokenHash, last4 }. */
export function generatePat() {
  const token = PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token), last4: token.slice(-4) };
}

/** Cheap shape pre-check before a DB lookup. */
export function looksLikePat(token) {
  return typeof token === 'string' && token.startsWith(PREFIX) && token.length > PREFIX.length + 20;
}
