import prisma from '@/lib/prisma';

function parseJsonText(text, fallback) {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toPublicPermissionGrant(row) {
  if (!row) return row;
  const { scopesJson, ...rest } = row;
  return { ...rest, scopes: parseJsonText(scopesJson, []) };
}

function toPublicProgramRuntimeEvent(row) {
  if (!row) return row;
  const { dataJson, ...rest } = row;
  return { ...rest, data: parseJsonText(dataJson, null) };
}

export async function createPermissionGrant({ workspaceSlug, scopes = [], grantedByUserId }) {
  const row = await prisma.permissionGrant.create({
    data: {
      workspaceSlug,
      scopesJson: JSON.stringify(scopes || []),
      grantedByUserId,
    },
  });
  return toPublicPermissionGrant(row);
}

export async function listPermissionGrants({ workspaceSlug }) {
  const rows = await prisma.permissionGrant.findMany({
    where: { workspaceSlug },
    orderBy: { grantedAt: 'desc' },
  });
  return rows.map(toPublicPermissionGrant);
}

export async function createProgramSession({ installId = null, workspaceSlug, runtimeType, startedByUserId, state = 'starting' }) {
  return prisma.programSession.create({
    data: {
      installId,
      workspaceSlug,
      runtimeType,
      state,
      startedByUserId,
    },
  });
}

export async function updateProgramSession(id, patch) {
  return prisma.programSession.update({ where: { id }, data: patch });
}

export async function listProgramSessions(workspaceSlug, { stateIn = null, limit = 20 } = {}) {
  return prisma.programSession.findMany({
    where: {
      workspaceSlug,
      ...(Array.isArray(stateIn) && stateIn.length ? { state: { in: stateIn } } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

export async function appendProgramRuntimeEvent({ sessionId, type, data = null }) {
  const row = await prisma.programRuntimeEvent.create({
    data: {
      sessionId,
      type,
      dataJson: data == null ? null : JSON.stringify(data),
    },
  });
  return toPublicProgramRuntimeEvent(row);
}

export async function listProgramRuntimeEvents(sessionId) {
  const rows = await prisma.programRuntimeEvent.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(toPublicProgramRuntimeEvent);
}