import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import prisma from '@/lib/prisma';

export const WORKSPACE_MANAGE_ROLES = new Set(['owner', 'admin']);

export async function requireWorkspaceAccess(workspaceSlug) {
  if (!workspaceSlug) {
    return { ok: false, status: 400, error: 'workspaceId is required' };
  }

  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  const workspace = await prisma.workspace.findFirst({
    where: {
      slug: workspaceSlug,
      memberships: {
        some: {
          user: {
            email,
          },
        },
      },
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

  if (!workspace) {
    return { ok: false, status: 404, error: 'Workspace not found' };
  }

  const membership = workspace.memberships?.[0] || null;
  return { ok: true, session, email, workspace, membership };
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
