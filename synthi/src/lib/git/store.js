import prisma from '@/lib/prisma';
import { encryptToken } from '@/lib/tokenCrypto';

/** Build a Prisma where-clause scoped to the actor (personal) or workspace. */
export function scopeWhere(actor, workspaceSlug) {
  return workspaceSlug
    ? { scope: 'workspace', workspaceSlug }
    : { scope: 'personal', ownerUserId: actor.userId };
}

const LIST_SELECT = {
  id: true, name: true, providerType: true, baseUrl: true, scope: true, workspaceSlug: true,
  authType: true, accountLogin: true, enabled: true, needsRelink: true,
  lastHealthState: true, lastHealthAt: true, createdAt: true,
};

export async function listProviders(actor, workspaceSlug) {
  return prisma.gitProvider.findMany({
    where: scopeWhere(actor, workspaceSlug),
    select: LIST_SELECT,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getProvider(id) {
  return prisma.gitProvider.findUnique({ where: { id } });
}

/** Create a PAT-authed provider: encrypt the token into EncryptedSecret, link it. */
export async function createPatProvider(actor, { providerType, name, baseUrl, token, workspaceSlug = null }) {
  const sec = await prisma.encryptedSecret.create({
    data: { cipher: encryptToken(token), last4: String(token).slice(-4) },
  });
  const row = await prisma.gitProvider.create({
    data: {
      name, providerType, baseUrl: baseUrl || null, authType: 'pat',
      scope: workspaceSlug ? 'workspace' : 'personal',
      ownerUserId: workspaceSlug ? null : actor.userId,
      workspaceSlug: workspaceSlug || null,
      secretId: sec.id,
    },
    select: LIST_SELECT,
  });
  return row;
}

/**
 * Create or update the single OAuth GitProvider row for {ownerUserId, providerType}.
 * Re-running OAuth (web or device flow) for the same user+provider must not create a
 * duplicate row: we update the existing oauth row in place, repoint it at freshly
 * encrypted secrets, and delete the previous EncryptedSecret rows so they don't orphan
 * (the FK is onDelete:SetNull, not Cascade). Returns the persisted row (optionally `select`ed).
 */
export async function upsertOAuthProvider({ ownerUserId, providerType, name, accessToken, refreshToken, expiresIn, oauthScopes }, select) {
  const sec = await prisma.encryptedSecret.create({
    data: { cipher: encryptToken(accessToken), last4: String(accessToken).slice(-4) },
  });
  let refreshSecretId = null;
  if (refreshToken) {
    const r = await prisma.encryptedSecret.create({
      data: { cipher: encryptToken(refreshToken), last4: String(refreshToken).slice(-4) },
    });
    refreshSecretId = r.id;
  }
  const data = {
    name, providerType, authType: 'oauth', scope: 'personal', ownerUserId,
    secretId: sec.id, refreshSecretId,
    accessTokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    needsRelink: false,
    ...(oauthScopes ? { oauthScopes } : {}),
  };

  const existing = await prisma.gitProvider.findFirst({
    where: { ownerUserId, providerType, authType: 'oauth' },
    select: { id: true, secretId: true, refreshSecretId: true },
  });
  if (!existing) {
    return prisma.gitProvider.create({ data, ...(select ? { select } : {}) });
  }
  // Repoint the existing row at the new secrets FIRST, then drop the now-unreferenced old ones.
  const row = await prisma.gitProvider.update({ where: { id: existing.id }, data, ...(select ? { select } : {}) });
  const stale = [existing.secretId, existing.refreshSecretId].filter(Boolean);
  if (stale.length) await prisma.encryptedSecret.deleteMany({ where: { id: { in: stale } } });
  return row;
}

export async function deleteProvider(id) {
  // Capture linked secret ids BEFORE deleting the provider, then remove the
  // orphaned EncryptedSecret rows (the FK is onDelete:SetNull, not Cascade, so
  // they would otherwise leak in the DB).
  const row = await prisma.gitProvider.findUnique({ where: { id }, select: { secretId: true, refreshSecretId: true } });
  await prisma.gitProvider.delete({ where: { id } });
  const ids = [row?.secretId, row?.refreshSecretId].filter(Boolean);
  if (ids.length) await prisma.encryptedSecret.deleteMany({ where: { id: { in: ids } } });
  return true;
}
