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

export async function getProgramSession(id) {
  return prisma.programSession.findUnique({ where: { id } });
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

// ── Local program + install helpers (Phase 2) ──
//
// Phase 2 installs from a manifest inside the workspace; the MarketplaceProgram
// row represents the workspace-local program (publisher 'local'). The packageId
// is namespaced per workspace so the global unique index stays workspace-scoped.

/** Build the workspace-scoped marketplace packageId for a local program. */
export function localPackageId(workspaceSlug, packageId) {
  return `local:${workspaceSlug}:${packageId}`;
}

/**
 * Find-or-create the local MarketplaceProgram + upsert its ProgramVersion from a
 * NormalizedProgramConfig. Stores the full normalized config as the version's
 * manifest (server-side only; never returned to clients verbatim).
 */
export async function upsertLocalProgram({ workspaceSlug, config }) {
  const packageId = localPackageId(workspaceSlug, config.packageId);

  const program = await prisma.marketplaceProgram.upsert({
    where: { packageId },
    update: { latestVersion: config.version },
    create: { packageId, publisher: 'local', verified: false, latestVersion: config.version },
  });

  const version = await prisma.programVersion.upsert({
    where: { programId_version: { programId: program.id, version: config.version } },
    update: {
      manifestJson: JSON.stringify(config),
      requiredTools: [],
      ports: (config.ports || []).map((p) => String(p)),
    },
    create: {
      programId: program.id,
      version: config.version,
      manifestJson: JSON.stringify(config),
      requiredTools: [],
      ports: (config.ports || []).map((p) => String(p)),
    },
  });

  return { program, version };
}

// ── Published marketplace helpers (Phase 5) ──
//
// A *published* program is a MarketplaceProgram whose publisher is the source
// workspace slug and whose packageId is namespaced `@<slug>/<name>` — distinct
// from the workspace-local `publisher='local'` / `local:<slug>:<id>` rows.

/** Build the published packageId for a workspace's program. */
export function publishedPackageId(workspaceSlug, packageId) {
  return `@${workspaceSlug}/${packageId}`;
}

/**
 * Publish (or re-publish) a workspace program from its NormalizedProgramConfig.
 * Idempotent upsert; re-publishing the same version updates its manifest, a new
 * version bumps `latestVersion`.
 */
export async function publishProgram({ workspaceSlug, config, publishedByUserId }) {
  const packageId = publishedPackageId(workspaceSlug, config.packageId);

  const program = await prisma.marketplaceProgram.upsert({
    where: { packageId },
    update: {
      latestVersion: config.version,
      displayName: config.displayName || config.packageId,
      description: config.description || null,
      publishedByUserId,
    },
    create: {
      packageId,
      publisher: workspaceSlug,
      verified: false,
      latestVersion: config.version,
      displayName: config.displayName || config.packageId,
      description: config.description || null,
      publishedByUserId,
    },
  });

  const version = await prisma.programVersion.upsert({
    where: { programId_version: { programId: program.id, version: config.version } },
    update: {
      manifestJson: JSON.stringify(config),
      requiredTools: [],
      ports: (config.ports || []).map((p) => String(p)),
    },
    create: {
      programId: program.id,
      version: config.version,
      manifestJson: JSON.stringify(config),
      requiredTools: [],
      ports: (config.ports || []).map((p) => String(p)),
    },
  });

  return { program, version };
}

/** Allow-listed public projection of a published program (never the manifest). */
export function toPublicMarketplaceProgram(row) {
  if (!row) return row;
  return {
    id: row.id,
    packageId: row.packageId,
    publisher: row.publisher,
    verified: row.verified,
    latestVersion: row.latestVersion,
    displayName: row.displayName ?? null,
    description: row.description ?? null,
    installCount: row.installCount ?? 0,
  };
}

export async function createInstall({ programId, workspaceSlug, version, installedByUserId, grantId = null, status = 'installing' }) {
  return prisma.programInstall.create({
    data: { programId, workspaceSlug, version, installedByUserId, grantId, status },
  });
}

export async function updateInstallStatus(installId, status) {
  return prisma.programInstall.update({ where: { id: installId }, data: { status } });
}

export async function getInstall(installId) {
  return prisma.programInstall.findUnique({ where: { id: installId }, include: { program: true } });
}

/** List the workspace-local marketplace programs (publisher 'local'). */
export async function listLocalPrograms(workspaceSlug) {
  return prisma.marketplaceProgram.findMany({
    where: { packageId: { startsWith: `local:${workspaceSlug}:` } },
    orderBy: { updatedAt: 'desc' },
  });
}

/** Fetch a stored program version (its manifestJson is the installed recipe). */
export async function getProgramVersion(programId, version) {
  return prisma.programVersion.findUnique({
    where: { programId_version: { programId, version } },
  });
}

export async function listInstalls(workspaceSlug) {
  return prisma.programInstall.findMany({
    where: { workspaceSlug },
    orderBy: { createdAt: 'desc' },
    include: { program: true },
  });
}

/**
 * Project an install row (optionally with its joined program) to public metadata.
 * Allow-listed fields only — never echoes the version manifest / raw env / secrets.
 */
export function toPublicInstall(row) {
  if (!row) return row;
  const program = row.program || null;
  return {
    id: row.id,
    programId: row.programId,
    workspaceSlug: row.workspaceSlug,
    version: row.version,
    status: row.status,
    installedByUserId: row.installedByUserId,
    grantId: row.grantId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    packageId: program ? program.packageId : null,
    publisher: program ? program.publisher : null,
  };
}