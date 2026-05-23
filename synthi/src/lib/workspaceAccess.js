import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import prisma from '@/lib/prisma';

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
    },
  });

  if (!workspace) {
    return { ok: false, status: 404, error: 'Workspace not found' };
  }

  return { ok: true, session, email, workspace };
}
