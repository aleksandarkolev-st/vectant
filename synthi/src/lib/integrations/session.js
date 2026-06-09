import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import prisma from '@/lib/prisma';

/** Resolve the authenticated actor to { userId, email, workspaceUserId }, or null. */
export async function resolveActor() {
  const session = await getServerSession(authOptions);
  const email = session?.user?.email;
  if (!email) return null;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) return null;
  // workspaceUserId mirrors the value the IDE uses to name the workspace repo dir
  // (page.jsx / Editor.jsx / TerminalPane.jsx all use `session.user.id || email`).
  // Distinct from `userId` (the DB User.id / cuid used for DB FK records).
  const workspaceUserId = session.user.id || email;
  return { userId: user.id, email: user.email, workspaceUserId };
}
