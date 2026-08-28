import prisma from '@/lib/prisma';
import {
  codeSiteEvidenceRefsJson,
  firstCodeSiteRef,
} from '@/lib/codesite/substrateIdentity';

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
  const { dataJson, codeSiteEvidenceRefsJson, ...rest } = row;
  return {
    ...rest,
    data: parseJsonText(dataJson, null),
    codeSiteEvidenceRefs: parseJsonText(codeSiteEvidenceRefsJson, []),
  };
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

export async function deleteProgramSession(id) {
  // ProgramRuntimeEvent rows cascade-delete with the session (schema onDelete: Cascade).
  return prisma.programSession.delete({ where: { id } });
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

export async function appendProgramRuntimeEvent({
  sessionId,
  type,
  data = null,
  codeSiteContext = null,
  codeSiteProjectId = null,
  codeSiteTransactionId = null,
  codeSiteMutationLeaseId = null,
  codeSiteAgentSessionId = null,
  codeSiteEvidenceRefs = null,
}) {
  const codeSiteRefs = normalizeCodeSiteRuntimeRefs({
    codeSiteContext,
    codeSiteProjectId,
    codeSiteTransactionId,
    codeSiteMutationLeaseId,
    codeSiteAgentSessionId,
    codeSiteEvidenceRefs,
  });
  const row = await prisma.programRuntimeEvent.create({
    data: {
      sessionId,
      type,
      dataJson: data == null ? null : JSON.stringify(data),
      ...codeSiteRefs,
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

function normalizeCodeSiteRuntimeRefs(input = {}) {
  const context = input.codeSiteContext && typeof input.codeSiteContext === 'object' && !Array.isArray(input.codeSiteContext)
    ? input.codeSiteContext
    : {};
  return {
    codeSiteProjectId: firstCodeSiteRef(input.codeSiteProjectId, context.codeSiteProjectId, context.projectId),
    codeSiteTransactionId: firstCodeSiteRef(input.codeSiteTransactionId, context.codeSiteTransactionId, context.transactionId),
    codeSiteMutationLeaseId: firstCodeSiteRef(input.codeSiteMutationLeaseId, context.codeSiteMutationLeaseId, context.mutationLeaseId, context.leaseId),
    codeSiteAgentSessionId: firstCodeSiteRef(input.codeSiteAgentSessionId, context.codeSiteAgentSessionId, context.agentSessionId),
    codeSiteEvidenceRefsJson: codeSiteEvidenceRefsJson(input.codeSiteEvidenceRefs || context.codeSiteEvidenceRefs || context.evidenceRefs),
  };
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

/** Browse/search the global published catalog (publisher != 'local'). */
export async function listPublishedPrograms({ q = '', limit = 50 } = {}) {
  const trimmed = String(q || '').trim();
  const rows = await prisma.marketplaceProgram.findMany({
    where: {
      publisher: { not: 'local' },
      // Only programs with a live (last-approved) version are listed — a fresh
      // submission or an in-review update has publishedVersion = null until it
      // reaches `published`.
      publishedVersion: { not: null },
      ...(trimmed
        ? {
            OR: [
              { packageId: { contains: trimmed, mode: 'insensitive' } },
              { displayName: { contains: trimmed, mode: 'insensitive' } },
              { publisher: { contains: trimmed, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { installCount: 'desc' },
    take: limit,
  });
  return rows.map(toPublicMarketplaceProgram);
}

/** The marketplace program row by packageId (or null). Used by pricing/checkout. */
export async function getMarketplaceProgramByPackageId(packageId) {
  return prisma.marketplaceProgram.findUnique({ where: { packageId } });
}

/** Pricing rows for a set of programs (batched — avoids N+1 in the catalog). */
export async function listPricingForPrograms(programIds) {
  if (!Array.isArray(programIds) || programIds.length === 0) return [];
  return prisma.programPricing.findMany({ where: { programId: { in: programIds } } });
}

/** The subset of `programIds` the subject holds an ACTIVE entitlement for. */
export async function listActiveEntitlementProgramIds({ subjectType = 'user', subjectId, programIds }) {
  if (!subjectId || !Array.isArray(programIds) || programIds.length === 0) return [];
  const rows = await prisma.entitlement.findMany({
    where: { subjectType, subjectId, status: 'active', programId: { in: programIds } },
    select: { programId: true },
  });
  return rows.map((r) => r.programId);
}

/**
 * Record a payment webhook event exactly once (idempotency via the unique
 * eventId). Returns true if newly recorded, false if this event was already
 * processed (a Stripe retry / replay).
 */
export async function recordWebhookEventOnce({ eventId, type, reference, payloadJson }) {
  try {
    await prisma.paymentWebhookEvent.create({
      data: { eventId, type, reference: reference || '', payloadJson: payloadJson || '' },
    });
    return true;
  } catch (err) {
    if (err?.code === 'P2002') return false; // duplicate eventId
    throw err;
  }
}

/** Resolve a published program + version + parsed manifest config (or null). */
export async function getPublishedProgramVersion(packageId, version) {
  const program = await prisma.marketplaceProgram.findUnique({ where: { packageId } });
  if (!program || program.publisher === 'local') return null;
  const versionRow = await prisma.programVersion.findUnique({
    where: { programId_version: { programId: program.id, version } },
  });
  if (!versionRow || !versionRow.manifestJson) return null;
  // Never serve an unreviewed / superseded digest: installers only ever resolve
  // a version that is currently in the `published` state.
  if (versionRow.reviewState !== 'published') return null;
  // Only the currently-live version is installable — unpublish / supersede takes
  // effect immediately; no resurrecting an old reviewed digest.
  if (program.publishedVersion && program.publishedVersion !== version) return null;
  const config = parseJsonText(versionRow.manifestJson, null);
  if (!config) return null;
  return { program, version: versionRow, config };
}

/** Bump a program's denormalized install counter (reputation signal). */
export async function incrementInstallCount(programId) {
  return prisma.marketplaceProgram.update({
    where: { id: programId },
    data: { installCount: { increment: 1 } },
  });
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

// ── Community-app submission + review gate (Phase 1) ──

/**
 * Create (or re-submit) a community-app version in `submitted` state. Upserts the
 * MarketplaceProgram (publisher = slug, packageId = @slug/<name>) and creates a
 * new version row carrying the publisher's sourceImageRef + the submitted manifest.
 * Writes the initial null→submitted audit event. Does NOT change the program's
 * live publishedVersion (an update stays invisible until it is approved).
 */
export async function createSubmission({ workspaceSlug, config, sourceImageRef = null, submittedByUserId }) {
  const packageId = publishedPackageId(workspaceSlug, config.packageId);
  const program = await prisma.marketplaceProgram.upsert({
    where: { packageId },
    update: { latestVersion: config.version, displayName: config.displayName || config.packageId, description: config.description || null, publishedByUserId: submittedByUserId },
    create: { packageId, publisher: workspaceSlug, verified: false, latestVersion: config.version, displayName: config.displayName || config.packageId, description: config.description || null, publishedByUserId: submittedByUserId },
  });
  const version = await prisma.programVersion.create({
    data: {
      programId: program.id,
      version: config.version,
      manifestJson: JSON.stringify(config),
      requiredTools: [],
      ports: (config.ports || []).map((p) => String(p)),
      reviewState: 'submitted',
      sourceImageRef,
      submittedByUserId,
    },
  });
  await prisma.programReviewEvent.create({
    data: { versionId: version.id, fromState: null, toState: 'submitted', actorUserId: submittedByUserId, reasonJson: null },
  });
  return { program, version };
}

/** Fetch a version (with its program) for review/orchestration. */
export async function getReviewVersionById(versionId) {
  return prisma.programVersion.findUnique({ where: { id: versionId }, include: { program: true } });
}

/** List versions awaiting manual review, newest first, with their program. */
export async function listPendingReview() {
  return prisma.programVersion.findMany({
    where: { reviewState: 'pending_review' },
    orderBy: { submittedAt: 'desc' },
    include: { program: true },
  });
}

/** Take a published program down: clear its live pointer (drops from marketplace). */
export async function unpublishProgram(packageId) {
  return prisma.marketplaceProgram.update({
    where: { packageId },
    data: { publishedVersion: null, publishedDigest: null },
  });
}

/** Non-terminal submissions for the autonomous sweep (bounded, oldest-first). */
export async function listProcessableSubmissions(limit = 50) {
  return prisma.programVersion.findMany({
    where: { reviewState: { in: ['submitted', 'scanning', 'ai_review'] } },
    orderBy: { submittedAt: 'asc' },
    take: limit,
  });
}

/** List a workspace's submitted versions (any review state) for the status view. */
export async function listSubmissionsForWorkspace(workspaceSlug) {
  return prisma.programVersion.findMany({
    where: { program: { publisher: workspaceSlug } },
    orderBy: { submittedAt: 'desc' },
    include: { program: true },
  });
}

/**
 * Guarded state transition + audit. Updates only if the row is still in
 * `fromState` (idempotent/resumable). Returns true if it transitioned.
 * `patch` carries extra column writes (scanReportJson, reviewNotes, reviewedByUserId…).
 */
export async function transitionReview(versionId, { fromState, toState, actorUserId = null, reason = null, patch = {} }) {
  const data = { reviewState: toState, ...patch };
  if (actorUserId && (toState === 'approved' || toState === 'rejected' || toState === 'published')) {
    data.reviewedByUserId = actorUserId;
    data.reviewedAt = new Date();
  }
  const res = await prisma.programVersion.updateMany({ where: { id: versionId, reviewState: fromState }, data });
  if (!res.count) return false;
  await prisma.programReviewEvent.create({
    data: { versionId, fromState, toState, actorUserId, reasonJson: reason == null ? null : JSON.stringify(reason) },
  });
  return true;
}

/**
 * Flip an approved+rehosted version to `published` and point the program's live
 * version/digest at it (the previously-live version stays untouched until now).
 */
export async function publishApprovedVersion(versionId, { programId, version, actorUserId, hostedImageDigest, publishedManifestJson }) {
  const ok = await transitionReview(versionId, {
    fromState: 'rehosting', toState: 'published', actorUserId,
    patch: { hostedImageDigest, manifestJson: publishedManifestJson },
  });
  if (!ok) return false;
  await prisma.marketplaceProgram.update({
    where: { id: programId },
    data: { publishedVersion: version, publishedDigest: hostedImageDigest, latestVersion: version },
  });
  return true;
}

/** Admin-queue projection: allow-listed fields + parsed scan summary, never the raw manifest. */
export function toReviewQueueItem(row) {
  if (!row) return row;
  return {
    versionId: row.id,
    version: row.version,
    reviewState: row.reviewState,
    submittedByUserId: row.submittedByUserId ?? null,
    sourceImageRef: row.sourceImageRef ?? null,
    submittedAt: row.submittedAt ?? null,
    scanSummary: parseJsonText(row.scanReportJson, null),
    aiSummary: (() => {
      // Redacted: expose only the AI risk score + flags, never the raw provider
      // rationale text (allow-list serialization, like toPublicInstall).
      const ai = parseJsonText(row.aiRiskJson, null);
      return ai ? { riskScore: ai.riskScore ?? null, flags: Array.isArray(ai.flags) ? ai.flags : [] } : null;
    })(),
    packageId: row.program ? row.program.packageId : null,
    publisher: row.program ? row.program.publisher : null,
    displayName: row.program ? (row.program.displayName ?? null) : null,
  };
}
