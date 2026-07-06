import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import prisma from '@/lib/prisma';

export const WORKSPACE_MANAGE_ROLES = new Set(['owner', 'admin']);

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

async function getAuthenticatedWorkspaceSession() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  return { ok: true, session, email };
}

async function findWorkspaceWithMembership(workspaceSlug, email) {
  return prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
    },
    select: {
      id: true,
      slug: true,
      name: true,
      memberships: {
        where: {
          user: {
            email,
          },
        },
        select: {
          id: true,
          role: true,
        },
        take: 1,
      },
    },
  });
}

async function findWorkspaceWithMembershipById(workspaceId, email) {
  return prisma.workspace.findUnique({
    where: {
      id: workspaceId,
    },
    select: {
      id: true,
      slug: true,
      name: true,
      memberships: {
        where: {
          user: {
            email,
          },
        },
        select: {
          id: true,
          role: true,
        },
        take: 1,
      },
    },
  });
}

export async function requireWorkspaceAccess(workspaceSlug) {
  if (!workspaceSlug) {
    return { ok: false, status: 400, error: 'workspaceId is required' };
  }

  const authenticated = await getAuthenticatedWorkspaceSession();
  if (!authenticated.ok) return authenticated;

  const { session, email } = authenticated;
  const workspace = await findWorkspaceWithMembership(workspaceSlug, email);
  if (!workspace) {
    return { ok: false, status: 404, error: 'Workspace not found' };
  }

  const membership = workspace.memberships?.[0] || null;
  if (!membership) {
    return { ok: false, status: 404, error: 'Workspace not found' };
  }

  return { ok: true, session, email, workspace, membership };
}

export async function requireWorkspaceAccessById(workspaceId) {
  if (!workspaceId) {
    return { ok: false, status: 400, error: 'workspaceId is required' };
  }

  const authenticated = await getAuthenticatedWorkspaceSession();
  if (!authenticated.ok) return authenticated;

  const { session, email } = authenticated;
  const workspace = await findWorkspaceWithMembershipById(workspaceId, email);
  if (!workspace) {
    return { ok: false, status: 404, error: 'Workspace not found' };
  }

  const membership = workspace.memberships?.[0] || null;
  if (!membership) {
    return { ok: false, status: 404, error: 'Workspace not found' };
  }

  return { ok: true, session, email, workspace, membership };
}

async function collabWorkspaceHasFiles(workspaceSlug, userId) {
  const collabUrl = resolveCollabServerUrl();
  if (!collabUrl) {
    return { ok: false, status: 503, error: 'Workspace access source is not configured' };
  }

  let response;
  try {
    response = await fetch(`${collabUrl}/git/${encodeURIComponent(workspaceSlug)}/files-meta`, {
      method: 'GET',
      headers: userId ? { 'x-user-id': userId } : {},
      cache: 'no-store',
    });
  } catch (error) {
    return {
      ok: false,
      status: 503,
      error: 'Workspace access source is unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status === 404 ? 404 : 503,
      error: response.status === 404 ? 'Workspace not found' : 'Workspace access source rejected the request',
    };
  }

  const payload = await response.json().catch(() => null);
  if (payload?.exists === true) {
    return { ok: true };
  }
  if (Array.isArray(payload?.files) && payload.files.length > 0) {
    return { ok: true };
  }
  return { ok: false, status: 404, error: 'Workspace not found' };
}

export async function requireRuntimeWorkspaceAccess(workspaceSlug) {
  if (!workspaceSlug) {
    return { ok: false, status: 400, error: 'workspaceId is required' };
  }

  const authenticated = await getAuthenticatedWorkspaceSession();
  if (!authenticated.ok) return authenticated;

  const { session, email } = authenticated;
  const workspace = await findWorkspaceWithMembership(workspaceSlug, email);
  if (workspace) {
    const membership = workspace.memberships?.[0] || null;
    if (!membership) {
      return { ok: false, status: 404, error: 'Workspace not found' };
    }
    return { ok: true, session, email, workspace, membership };
  }

  const userId = session?.user?.id || email;
  const collabAccess = await collabWorkspaceHasFiles(workspaceSlug, userId);
  if (!collabAccess.ok) return collabAccess;

  return {
    ok: true,
    session,
    email,
    workspace: {
      id: workspaceSlug,
      slug: workspaceSlug,
      name: workspaceSlug,
      source: 'collab',
    },
    membership: {
      id: `collab:${workspaceSlug}:${email}`,
      role: 'member',
      source: 'collab',
    },
  };
}

export async function requireWorkspaceManageAccess(workspaceSlug) {
  const access = await requireWorkspaceAccess(workspaceSlug);
  if (!access.ok) return access;

  const role = access.membership?.role || 'member';
  if (!WORKSPACE_MANAGE_ROLES.has(role)) {
    return { ok: false, status: 403, error: 'Only workspace owners can invite members' };
  }

  return access;
}

export async function requireWorkspaceManageAccessById(workspaceId) {
  const access = await requireWorkspaceAccessById(workspaceId);
  if (!access.ok) return access;

  const role = access.membership?.role || 'member';
  if (!WORKSPACE_MANAGE_ROLES.has(role)) {
    return { ok: false, status: 403, error: 'Only workspace owners can manage this workspace' };
  }

  return access;
}
