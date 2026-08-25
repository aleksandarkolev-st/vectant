import prisma from '@/lib/prisma';
import { resolveCollabGuestAccess } from '@/lib/collabGuestAccess';

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
    if ((await workspaceMembership(actor, target.workspaceSlug)) !== null) return true;
    // Not a workspace member — fall back to live collab-session guest/host
    // access (see collabGuestAccess.js). Any admitted role can read; write
    // access is gated separately in canWriteScope by the host's canEdit grant.
    const collabAccess = await resolveCollabGuestAccess(target.workspaceSlug, actor.workspaceUserId);
    return collabAccess !== null;
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
    if (m) return WRITE_ROLES.has(m.role);
    // Not a workspace member — a collab guest can write only if the host
    // granted them canEdit; the host themself always can (see
    // collabGuestAccess.js / SessionManager's HOST_PERMISSIONS).
    const collabAccess = await resolveCollabGuestAccess(target.workspaceSlug, actor.workspaceUserId);
    return collabAccess?.permissions?.canEdit === true;
  }
  return false;
}
