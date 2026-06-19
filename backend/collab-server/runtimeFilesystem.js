'use strict';

const gitService = require('./gitService');
const repoCache = require('./repoCache');

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

async function ensureRuntimeFilesystem({
  workspaceSlug,
  filesystemUserId = '',
  runtimeScope = '',
  pin = false,
  reason = 'runtime',
} = {}) {
  const slug = normalize(workspaceSlug);
  if (!slug) {
    return { skipped: true, reason: 'missing_workspace_slug' };
  }

  const userId = normalize(filesystemUserId);
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
