import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { requireWorkspaceAccess, requireWorkspaceManageAccess } from '@/lib/workspaceAccess';

export const runtime = 'nodejs';

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export async function GET(_request, { params }) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccess(workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status || 403 });
  }

  const members = await prisma.workspaceMembership.findMany({
    where: { workspaceId: access.workspace.id },
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      role: true,
      invitedByEmail: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });

  return NextResponse.json({
    workspace: {
      id: access.workspace.id,
      slug: access.workspace.slug,
      name: access.workspace.name,
    },
    currentMember: {
      role: access.membership?.role || 'member',
    },
    members,
  });
}

export async function POST(request, { params }) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceManageAccess(workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status || 403 });
  }

  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  }

  const role = body.role === 'admin' ? 'admin' : 'member';
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email },
    select: { id: true, email: true },
  });

  const membership = await prisma.workspaceMembership.upsert({
    where: {
      userId_workspaceId: {
        userId: user.id,
        workspaceId: access.workspace.id,
      },
    },
    update: {
      invitedByEmail: access.email,
    },
    create: {
      userId: user.id,
      workspaceId: access.workspace.id,
      role,
      invitedByEmail: access.email,
    },
    select: {
      id: true,
      role: true,
      invitedByEmail: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });

  return NextResponse.json({
    ok: true,
    workspace: {
      id: access.workspace.id,
      slug: access.workspace.slug,
      name: access.workspace.name,
    },
    member: membership,
  });
}
