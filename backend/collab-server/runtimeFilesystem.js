'use strict';

const gitService = require('./gitService');
const repoCache = require('./repoCache');
const codeSiteActivityRegistry = require('./codesiteActivityRegistry');
const { createWorkspaceInstructionProjectionRuntime } = require('./workspaceInstructionProjectionRuntime');

const hydrationLocks = new Map();
const runtimePins = new Map();
const runtimeProjectionRoots = new Map();
const projectionCleanupLocks = new Map();
let workspaceInstructionProjectionRuntime = createWorkspaceInstructionProjectionRuntime();

function normalize(value) {
  return String(value || '').trim();
}

function cacheUserId(userId) {
  const normalized = normalize(userId);
  return normalized || undefined;
}

function pinKey(slug, userId) {
  return `${slug}:${userId || ''}`;
}

function hasRuntimePin(slug, userId) {
  return [...runtimePins.values()].some((entry) => entry.slug === slug && entry.userId === userId);
}

async function waitForProjectionCleanup(key) {
  const cleanup = projectionCleanupLocks.get(key);
  if (cleanup) await cleanup;
}

function scheduleProjectionCleanup({ slug, userId, activeWorkspacePaths = [''] }) {
  const key = pinKey(slug, userId);
  const previous = projectionCleanupLocks.get(key) || Promise.resolve();
  const cleanup = previous.catch(() => {}).then(async () => {
    // A replacement terminal may have claimed this workspace while a previous
    // session was closing. Its reconciliation owns the projection again.
    if (hasRuntimePin(slug, userId)) {
      return { skipped: true, reason: 'workspace_runtime_still_pinned' };
    }
    try {
      const repositoryRoot = gitService.getEffectiveRepoPath(slug, userId || null);
      const projections = [];
      for (const activeWorkspacePath of activeWorkspacePaths) {
        const cleanupInput = {
          workspaceId: slug,
          repositoryRoot,
        };
        if (activeWorkspacePath) cleanupInput.activeWorkspacePath = activeWorkspacePath;
        projections.push(await workspaceInstructionProjectionRuntime.cleanup(cleanupInput));
      }
      return projections.length === 1 ? projections[0] : { skipped: false, projections };
    } catch (error) {
      // Runtime teardown must not become a failed terminal shutdown. A later
      // workspace open reconciles stale blocks safely after a crash or retry.
      console.warn(`[RuntimeFS] Instruction projection cleanup failed for ${slug}${userId ? `/${userId}` : ''}: ${error?.message || error}`);
      return { skipped: false, error: 'workspace_instruction_projection_cleanup_failed' };
    }
  });
  projectionCleanupLocks.set(key, cleanup);
  cleanup.finally(() => {
    if (projectionCleanupLocks.get(key) === cleanup) projectionCleanupLocks.delete(key);
  });
  return cleanup;
}

async function hydrateWorkspace(slug, userId, reason = 'runtime') {
  const label = userId ? `${slug}/user-scoped` : slug;
  console.log(`[RuntimeFS] Hydrating ${label} (${reason})`);

  if (userId) {
    await gitService.initRepo(slug, null, userId);
    const result = await gitService.ensureUserRepo(slug, userId);
    return {
      slug,
      userId,
      path: result.path,
      created: Boolean(result.created),
    };
  }

  await gitService.initRepo(slug, null, null);
  const repoPath = gitService.getRepoPath(slug);
  return {
    slug,
    userId: '',
    path: repoPath,
    created: false,
  };
}

async function reconcileRuntimeInstructionProjection(result, activeWorkspacePath = '') {
  const projectionInput = {
    workspaceId: result.slug,
    repositoryRoot: result.path,
  };
  if (activeWorkspacePath) projectionInput.activeWorkspacePath = activeWorkspacePath;
  let projection;
  try {
    projection = await workspaceInstructionProjectionRuntime.reconcile(projectionInput);
  } catch (error) {
    // Passive instruction projection is an enhancement — it must never fail a
    // runtime/terminal hydration. Log and continue with the plain checkout.
    console.warn(
      `[RuntimeFS] Instruction projection reconcile failed for ${result.slug}`
      + `${activeWorkspacePath ? ` (${activeWorkspacePath})` : ''}: ${error?.code || error?.message || error}`,
    );
    return {
      ...result,
      activeWorkspacePath: activeWorkspacePath || '',
      instructionProjection: { skipped: true, reason: 'reconcile_failed' },
    };
  }
  // Runtime callers may surface this result in diagnostics.  Preserve only
  // operational metadata: terminal instruction content remains in the
  // physical document and must never be copied into a status payload.
  return {
    ...result,
    activeWorkspaceRoot: projection.activeWorkspaceRoot || result.path,
    activeWorkspacePath: projection.activeWorkspacePath || activeWorkspacePath || '',
    instructionProjection: {
      skipped: Boolean(projection.skipped),
      reason: projection.reason || null,
      rollout: projection.rollout || null,
      projections: Array.isArray(projection.projections)
        ? projection.projections.map(({ path: projectionPath, ownership }) => ({ path: projectionPath, ownership }))
        : [],
    },
  };
}

function codeSiteContextFromOptions(options = {}) {
  const context = options.codesiteContext || options.codeSiteContext || options.codeSite || options.codesite || null;
  return context && typeof context === 'object' ? context : null;
}

async function isRuntimeFilesystemInitialized(slug, userId) {
  if (userId && typeof gitService.isUserRepoInitialized === 'function') {
    return gitService.isUserRepoInitialized(slug, userId);
  }
  if (typeof gitService.isRepoInitialized === 'function') {
    return gitService.isRepoInitialized(slug, userId || null);
  }
  return false;
}

async function existingCodeSiteRuntimeFilesystem(slug, userId, reason) {
  const initialized = await isRuntimeFilesystemInitialized(slug, userId);
  if (!initialized) {
    const error = new Error(
      `CodeSite runtime filesystem blocked: ${slug}${userId ? '/' + userId : ''} is not provisioned for ${reason}. Provision it through a CodeSite git_provisioning clearance before launching runtime overlay sessions.`,
    );
    error.code = 'CODESITE_RUNTIME_FILESYSTEM_PROVISIONING_REQUIRED';
    error.status = 409;
    throw error;
  }
  return {
    slug,
    userId,
    path: gitService.getEffectiveRepoPath(slug, userId || null),
    created: false,
    reusedExisting: true,
    codeSiteProvisioningSkipped: true,
  };
}

function activeWorkspaceRuntimeBlocked(slug, userId, reason) {
  const error = new Error(
    `CodeSite runtime filesystem blocked: active transaction owns ${slug}${userId ? '/' + userId : ''} for ${reason}. Launch through a CodeSite overlay/runtime route or close the transaction before real-tree hydration.`,
  );
  error.code = 'CODESITE_RUNTIME_FILESYSTEM_ACTIVE_TRANSACTION';
  error.status = 409;
  error.details = {
    workspaceSlug: slug,
    filesystemUserId: userId || null,
    reason,
    activeTransactions: codeSiteActivityRegistry.activeTransactionsForWorkspace(slug),
  };
  return error;
}

async function refreshActiveWorkspaceAuthority(slug, context = null) {
  try {
    await codeSiteActivityRegistry.refreshWorkspaceFromControlPlane(slug, {
      controlPlaneUrl: context?.controlPlaneUrl,
      controlPlaneTrusted: context?.controlPlaneTrusted,
      authToken: context?.authToken,
      cookie: context?.cookie,
      requireAuthority: true,
    });
  } catch (error) {
    const blocked = activeWorkspaceRuntimeBlocked(slug, context?.effectiveUserId || '', 'active_authority_unavailable');
    blocked.status = 503;
    blocked.details.authorityError = error.code || error.message;
    throw blocked;
  }
}

async function ensureRuntimeFilesystem({
  workspaceSlug,
  filesystemUserId = '',
  runtimeScope = '',
  activeWorkspacePath = '',
  pin = false,
  reason = 'runtime',
  codesiteContext = null,
  codeSiteContext = null,
} = {}) {
  const slug = normalize(workspaceSlug);
  if (!slug) {
    return { skipped: true, reason: 'missing_workspace_slug' };
  }

  const userId = normalize(filesystemUserId);
  const key = pinKey(slug, userId);
  await waitForProjectionCleanup(key);
  const activeCodeSiteContext = codeSiteContextFromOptions({ codesiteContext, codeSiteContext });
  if (activeCodeSiteContext?.active) {
    await refreshActiveWorkspaceAuthority(slug, activeCodeSiteContext);
    const existing = await existingCodeSiteRuntimeFilesystem(slug, userId, reason);
    if (pin && runtimeScope) {
      pinRuntimeFilesystem(runtimeScope, slug, userId, activeWorkspacePath);
    }
    return existing;
  }

  await refreshActiveWorkspaceAuthority(slug, activeCodeSiteContext);
  if (codeSiteActivityRegistry.isWorkspaceActive(slug)) {
    throw activeWorkspaceRuntimeBlocked(slug, userId, reason);
  }

  let lock = hydrationLocks.get(key);
  if (!lock) {
    lock = hydrateWorkspace(slug, userId, reason)
      .finally(() => {
        hydrationLocks.delete(key);
      });
    hydrationLocks.set(key, lock);
  }

  const hydrated = await lock;
  // Hydration is shared by all terminal launches for a workspace, but the
  // projection must be evaluated per launch because different users can open
  // different nested directories inside the same repository concurrently.
  const result = await reconcileRuntimeInstructionProjection(hydrated, activeWorkspacePath);

  if (pin && runtimeScope) {
    pinRuntimeFilesystem(runtimeScope, slug, userId, result.activeWorkspacePath || activeWorkspacePath);
  }

  return result;
}

function pinRuntimeFilesystem(runtimeScope, workspaceSlug, filesystemUserId = '', activeWorkspacePath = '') {
  const scope = normalize(runtimeScope);
  const slug = normalize(workspaceSlug);
  if (!scope || !slug) return;

  const userId = normalize(filesystemUserId);
  const next = { slug, userId, activeWorkspacePath: normalize(activeWorkspacePath) };
  const existing = runtimePins.get(scope);
  if (existing) {
    if (
      existing.slug === next.slug
      && existing.userId === next.userId
      && existing.activeWorkspacePath === next.activeWorkspacePath
    ) return;
    releaseRuntimeFilesystem(scope);
  }

  repoCache.pin(next.slug, cacheUserId(next.userId));
  runtimePins.set(scope, next);
  const roots = runtimeProjectionRoots.get(pinKey(next.slug, next.userId)) || new Map();
  roots.set(next.activeWorkspacePath, (roots.get(next.activeWorkspacePath) || 0) + 1);
  runtimeProjectionRoots.set(pinKey(next.slug, next.userId), roots);
}

function releaseRuntimeFilesystem(runtimeScope) {
  const scope = normalize(runtimeScope);
  if (!scope) return Promise.resolve({ skipped: true, reason: 'missing_runtime_scope' });
  const existing = runtimePins.get(scope);
  if (!existing) return Promise.resolve({ skipped: true, reason: 'runtime_scope_not_pinned' });
  repoCache.unpin(existing.slug, cacheUserId(existing.userId));
  runtimePins.delete(scope);
  const workspaceKey = pinKey(existing.slug, existing.userId);
  const roots = runtimeProjectionRoots.get(workspaceKey);
  const knownActiveWorkspacePaths = Array.from(roots?.keys() || [existing.activeWorkspacePath]);
  if (roots) {
    const remaining = (roots.get(existing.activeWorkspacePath) || 1) - 1;
    if (remaining > 0) roots.set(existing.activeWorkspacePath, remaining);
    else roots.delete(existing.activeWorkspacePath);
  }
  if (hasRuntimePin(existing.slug, existing.userId)) {
    return Promise.resolve({ skipped: true, reason: 'workspace_runtime_still_pinned' });
  }
  runtimeProjectionRoots.delete(workspaceKey);
  return scheduleProjectionCleanup({
    ...existing,
    activeWorkspacePaths: knownActiveWorkspacePaths.length ? knownActiveWorkspacePaths : [existing.activeWorkspacePath],
  });
}

function getPinnedRuntimeFilesystems() {
  return [...runtimePins.entries()].map(([runtimeScope, value]) => ({
    runtimeScope,
    workspaceSlug: value.slug,
    filesystemUserId: value.userId || null,
    activeWorkspacePath: value.activeWorkspacePath || '',
  }));
}

function setWorkspaceInstructionProjectionRuntimeForTests(runtime) {
  const previous = workspaceInstructionProjectionRuntime;
  workspaceInstructionProjectionRuntime = runtime || createWorkspaceInstructionProjectionRuntime();
  return () => { workspaceInstructionProjectionRuntime = previous; };
}

module.exports = {
  ensureRuntimeFilesystem,
  releaseRuntimeFilesystem,
  getPinnedRuntimeFilesystems,
  setWorkspaceInstructionProjectionRuntimeForTests,
};
