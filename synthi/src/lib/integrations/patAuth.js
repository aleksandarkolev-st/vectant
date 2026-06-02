import prisma from '@/lib/prisma';
import { hashToken, looksLikePat } from './pat';

/** Extract a Bearer token from the Authorization header, or null. */
export function bearerToken(req) {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Authenticate a PAT-bearing request. Returns { userId } on success, else null.
 * Bumps lastUsedAt (best-effort). Rejects unknown/revoked tokens. Never throws.
 * @param {Request} req
 * @returns {Promise<{userId:string}|null>}
 */
export async function authenticatePat(req) {
  const token = bearerToken(req);
  if (!looksLikePat(token)) return null;
  let row;
  try {
    row = await prisma.personalAccessToken.findUnique({ where: { tokenHash: hashToken(token) } });
  } catch {
    return null;
  }
  if (!row || row.revokedAt) return null;
  // Fire-and-forget; a failed bump must not fail auth.
  prisma.personalAccessToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  return { userId: row.userId };
}
