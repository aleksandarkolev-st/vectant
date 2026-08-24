/**
 * collabGuestAccess — server-only bridge from a Next.js API route to the
 * collab-server's live session state.
 *
 * A guest admitted into a collaboration session (room code, invite link, or
 * knock) never gets a Prisma WorkspaceMembership row — that's only created
 * by the direct email-invite flow (see WorkspaceUsersPanel.handleInviteUser).
 * Without this bridge, every workspace file route 404s for that guest
 * regardless of what permissions the host granted them in the Share modal.
 *
 * This asks the collab-server "is this authenticated caller currently the
 * host or an admitted guest of an active session for this workspace slug,
 * and with what permissions?" — checked live on every call, so access is
 * automatically revoked the instant a guest is kicked or the session ends.
 * See requireWorkspaceAccess() in workspaceAccess.js and canReadScope /
 * canWriteScope in lib/integrations/scope.js for the callers.
 *
 * The identity passed here must be `workspaceUserId` (session.user.id ||
 * email), not the Prisma User.id — see the comment in
 * lib/integrations/session.js. That's the same identifier the collab client
 * already uses everywhere (getCurrentUser().id), so no new client-side
 * plumbing is needed: this is resolved purely from the caller's existing
 * NextAuth session plus the workspace slug.
 */

const COLLAB_URL_ENV_VARS = [
  'COLLAB_SERVER_URL',
  'SYNTHI_COLLAB_SERVER_URL',
  'NEXT_PUBLIC_COLLAB_SERVER_URL',
  'COLLAB_URL',
];

function normalizeServerUrl(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\/+$/, '')
    : '';
}

function resolveCollabServerUrl() {
  for (const name of COLLAB_URL_ENV_VARS) {
    const value = normalizeServerUrl(process.env[name]);
    if (value) return value;
  }
  return '';
}

/**
 * @param {string} workspaceSlug
 * @param {string} workspaceUserId
 * @returns {Promise<{ role: 'host'|'guest', permissions: { canEdit: boolean, canFileOps: boolean, canTerminal: boolean, canGit: boolean } } | null>}
 *   null if the collab-server is unreachable/unconfigured, or the caller is
 *   not currently host/guest of an active session for this slug.
 */
export async function resolveCollabGuestAccess(workspaceSlug, workspaceUserId) {
  if (!workspaceSlug || !workspaceUserId) return null;

  const collabUrl = resolveCollabServerUrl();
  const internalToken = process.env.COLLAB_INTERNAL_TOKEN;
  if (!collabUrl || !internalToken) return null;

  const targetUrl = new URL(
    `/session/workspace-access/${encodeURIComponent(workspaceUserId)}`,
    `${collabUrl}/`,
  );
  targetUrl.searchParams.set('slug', workspaceSlug);

  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'GET',
      headers: { 'x-collab-internal-token': internalToken },
      cache: 'no-store',
    });
  } catch (_) {
    return null;
  }

  if (!response.ok) return null;

  const payload = await response.json().catch(() => null);
  if (!payload || (payload.role !== 'host' && payload.role !== 'guest') || !payload.permissions) {
    return null;
  }
  return payload;
}
