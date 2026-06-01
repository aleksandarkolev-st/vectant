import prisma from '@/lib/prisma';
import { encryptToken, decryptToken } from '@/lib/tokenCrypto';

// R1-10: connections are identified by `id`, never by `name` (names are user-controlled,
// mutable, and may collide across personal/workspace scopes). The personal ∪ workspace
// union below needs no name dedup — rows are already unique by id, and nothing downstream
// keys by name.

/**
 * Shape a DB row for the browser. NEVER returns secret material — only flags
 * and a last-4 hint.
 */
export function toPublic(row) {
  if (!row) return null;
  const { secret, secretId, ...rest } = row;
  return {
    ...rest,
    hasSecret: !!secret,
    secretLast4: secret?.last4 || null,
  };
}

function scopeWhere({ userId, workspaceSlug }) {
  const or = [];
  if (userId) or.push({ scope: 'personal', ownerUserId: userId });
  if (workspaceSlug) or.push({ scope: 'workspace', workspaceSlug });
  // Guard: if neither is provided, match nothing.
  return or.length ? { OR: or } : { id: '__none__' };
}

/** List connections visible to a scope, as public (secret-free) objects. */
export async function listConnections(scope) {
  const rows = await prisma.mcpConnection.findMany({
    where: scopeWhere(scope),
    include: { secret: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toPublic);
}

/** Create a connection (+ optional secret). Returns the public object. */
export async function createConnection(input) {
  const {
    name, url, transport = 'http', scope, ownerUserId = null, workspaceSlug = null,
    authType = 'none', headerName = null, secret = null, toolAllowlist = [], enabled = true,
  } = input;

  let secretId = null;
  if (secret) {
    const created = await prisma.encryptedSecret.create({
      data: { cipher: encryptToken(secret), last4: secret.slice(-4) },
    });
    secretId = created.id;
  }
  const row = await prisma.mcpConnection.create({
    data: { name, url, transport, scope, ownerUserId, workspaceSlug, authType, headerName, secretId, toolAllowlist, enabled },
    include: { secret: true },
  });
  return toPublic(row);
}

/** Update mutable fields (enabled, toolAllowlist, name, and optionally a new secret). */
export async function updateConnection(id, patch) {
  const data = {};
  for (const k of ['name', 'enabled', 'toolAllowlist', 'authType', 'headerName', 'url', 'transport', 'lastHealthState', 'lastHealthAt']) {
    if (patch[k] !== undefined) data[k] = patch[k];
  }
  if (patch.secret) {
    const created = await prisma.encryptedSecret.create({
      data: { cipher: encryptToken(patch.secret), last4: patch.secret.slice(-4) },
    });
    data.secretId = created.id;
  }
  const row = await prisma.mcpConnection.update({ where: { id }, data, include: { secret: true } });
  return toPublic(row);
}

/** Delete a connection (and its secret via cascade-free explicit cleanup). */
export async function deleteConnection(id) {
  const existing = await prisma.mcpConnection.findUnique({ where: { id } });
  await prisma.mcpConnection.delete({ where: { id } });
  if (existing?.secretId) {
    try { await prisma.encryptedSecret.delete({ where: { id: existing.secretId } }); } catch { /* already gone */ }
  }
}

/** Fetch a single row (with secret) for authz checks. Internal use. */
export async function getConnectionRow(id) {
  return prisma.mcpConnection.findUnique({ where: { id }, include: { secret: true } });
}

/**
 * Return resolved, decrypted configs for the hub: only enabled connections with
 * a non-empty allowlist (fail-closed). Each item is hub-ready.
 */
export async function resolveToolConfigs(scope) {
  const rows = await prisma.mcpConnection.findMany({
    where: scopeWhere(scope),
    include: { secret: true },
  });
  return rows
    .filter((r) => r.enabled && Array.isArray(r.toolAllowlist) && r.toolAllowlist.length > 0)
    .map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      transport: r.transport,
      authType: r.authType,
      headerName: r.headerName,
      secret: r.secret ? decryptToken(r.secret.cipher) : null,
      allowlist: r.toolAllowlist,
    }));
}
