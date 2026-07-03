'use strict';

const gitService = require('./gitService');
const repoCache = require('./repoCache');
const codeSiteActivityRegistry = require('./codesiteActivityRegistry');

const hydrationLocks = new Map();
const runtimePins = new Map();

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
  return {
    slug,
    userId: '',
    path: gitService.getRepoPath(slug),
    created: false,
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

async function ensureRuntimeFilesystem({
  workspaceSlug,
  filesystemUserId = '',
  runtimeScope = '',
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
  const activeCodeSiteContext = codeSiteContextFromOptions({ codesiteContext, codeSiteContext });
  if (activeCodeSiteContext?.active) {
    codeSiteActivityRegistry.recordCodeSiteContext({
      ...activeCodeSiteContext,
      workspaceSlug: activeCodeSiteContext.workspaceSlug || slug,
      effectiveUserId: activeCodeSiteContext.effectiveUserId || userId || null,
    }, { source: 'runtime_filesystem_context' });
    const existing = await existingCodeSiteRuntimeFilesystem(slug, userId, reason);
    if (pin && runtimeScope) {
      pinRuntimeFilesystem(runtimeScope, slug, userId);
    }
    return existing;
  }

  if (codeSiteActivityRegistry.isWorkspaceActive(slug)) {
    throw activeWorkspaceRuntimeBlocked(slug, userId, reason);
  }

  const key = pinKey(slug, userId);
  let lock = hydrationLocks.get(key);
  if (!lock) {
    lock = hydrateWorkspace(slug, userId, reason).finally(() => {
      hydrationLocks.delete(key);
    });
    hydrationLocks.set(key, lock);
  }

  const result = await lock;

  if (pin && runtimeScope) {
    pinRuntimeFilesystem(runtimeScope, slug, userId);
  }

  return result;
}

function pinRuntimeFilesystem(runtimeScope, workspaceSlug, filesystemUserId = '') {
  const scope = normalize(runtimeScope);
  const slug = normalize(workspaceSlug);
  if (!scope || !slug) return;

  const userId = normalize(filesystemUserId);
  const next = { slug, userId };
  const existing = runtimePins.get(scope);
  if (existing) {
    if (existing.slug === next.slug && existing.userId === next.userId) return;
    repoCache.unpin(existing.slug, cacheUserId(existing.userId));
  }

  repoCache.pin(next.slug, cacheUserId(next.userId));
  runtimePins.set(scope, next);
}

function releaseRuntimeFilesystem(runtimeScope) {
  const scope = normalize(runtimeScope);
  if (!scope) return;
  const existing = runtimePins.get(scope);
  if (!existing) return;
  repoCache.unpin(existing.slug, cacheUserId(existing.userId));
  runtimePins.delete(scope);
}

function getPinnedRuntimeFilesystems() {
  return [...runtimePins.entries()].map(([runtimeScope, value]) => ({
    runtimeScope,
    workspaceSlug: value.slug,
    filesystemUserId: value.userId || null,
  }));
}

module.exports = {
  ensureRuntimeFilesystem,
  releaseRuntimeFilesystem,
  getPinnedRuntimeFilesystems,
};
