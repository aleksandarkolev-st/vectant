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
