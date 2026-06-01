import prisma from '@/lib/prisma';

// Roles permitted to mutate a workspace connection (R1-9). Plain 'member' is read-only.
const WRITE_ROLES = new Set(['owner', 'admin']);

/**
 * Look up the actor's membership row (including its role) for a workspace slug.
 * Returns the membership object, or null if the workspace/membership doesn't exist.
 * @param {{userId?:string}} actor
 * @param {string} [workspaceSlug]
 * @returns {Promise<{userId:string, role:string}|null>}
 */
async function workspaceMembership(actor, workspaceSlug) {
  if (!actor?.userId || !workspaceSlug) return null;
  const ws = await prisma.workspace.findUnique({
    where: { slug: workspaceSlug },
    include: { memberships: { where: { userId: actor.userId } } },
  });
  if (!ws || !ws.memberships || ws.memberships.length === 0) return null;
  return ws.memberships[0];
}

/**
 * Can the user VIEW / LIST / TEST a connection with this scope? (member-level, R1-9)
 * - personal: only the owner.
 * - workspace: any member (any role).
 * @param {{userId?:string}} actor
 * @param {{scope:string, ownerUserId?:string, workspaceSlug?:string}} target
 * @returns {Promise<boolean>}
 */
export async function canReadScope(actor, target) {
  if (!actor?.userId || !target) return false;
  if (target.scope === 'personal') return target.ownerUserId === actor.userId;
  if (target.scope === 'workspace') {
    return (await workspaceMembership(actor, target.workspaceSlug)) !== null;
  }
  return false;
}

/**
 * Can the user CREATE / EDIT / DELETE / ENABLE / change-allowlist a connection with
 * this scope? (R1-9)
 * - personal: only the owner.
 * - workspace: a member whose role is 'owner' or 'admin' (plain members are read-only).
 * @param {{userId?:string}} actor
 * @param {{scope:string, ownerUserId?:string, workspaceSlug?:string}} target
 * @returns {Promise<boolean>}
 */
export async function canWriteScope(actor, target) {
  if (!actor?.userId || !target) return false;
  if (target.scope === 'personal') return target.ownerUserId === actor.userId;
  if (target.scope === 'workspace') {
    const m = await workspaceMembership(actor, target.workspaceSlug);
    return !!m && WRITE_ROLES.has(m.role);
  }
  return false;
}
