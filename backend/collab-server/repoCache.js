/**
 * repoCache.js — LRU-based ephemeral working tree manager.
 *
 * Treats the local `REPO_CACHE_DIR` as a disposable cache.
 * GCS is the durable store; working trees are materialised on demand
 * and evicted when the LRU capacity or TTL is exceeded.
 *
 * Usage:
 *   const repoPath = await repoCache.acquire(slug);
 *   try {
 *     // … git operations on repoPath …
 *   } finally {
 *     repoCache.release(slug);
 *   }
 *
 * `acquire()` returns the local path after ensuring it exists (downloading
 * from GCS if necessary).  `release()` decrements the reference counter so
 * the LRU is allowed to evict the entry when it becomes idle.
 *
 * Pinned slugs (via `pin(slug)`) are never evicted — use this for workspaces
 * with an active Yjs collaboration session.
 */

const { LRUCache } = require('lru-cache');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const gcsSync = require('./gcsSync');

// ── Internal entry shape ─────────────────────────────────────────────────────
// {
//   slug:     string,
//   repoPath: string,        // absolute path on disk
//   refs:     number,         // reference counter (> 0 → in use, cannot evict)
//   pinned:   boolean,        // true → never evict (active collab session)
//   ready:    Promise<void>,  // resolves once materialisation is complete
// }

/** Serialise concurrent materialise calls per-slug. */
const _materializeLocks = new Map();

/**
 * Recursively remove a directory.
 * Uses `fs.rm` (Node 14.14+) with `{ force, recursive }`.
 */
async function rmDir(dir) {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (e) {
    // Best-effort: log and continue.  On Windows, files can be locked.
    console.warn(`[RepoCache] Failed to remove ${dir}: ${e.message}`);
  }
}

/**
 * Materialise a working tree from GCS if it doesn't already exist on disk.
 */
async function materialize(slug, repoPath) {
  // Fast path: already on disk with a .git dir
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    return;
  }

  // Ensure parent dir exists
  await fsp.mkdir(repoPath, { recursive: true });

  // Download workspace files from GCS
  if (gcsSync.isGcsConfigured()) {
    console.log(`[RepoCache] Materialising ${slug} from GCS → ${repoPath}`);
    try {
      const res = await gcsSync.downloadGcsToRepo(slug, repoPath);
      console.log(`[RepoCache] GCS download for ${slug}: ${res.success} files`);
    } catch (e) {
      console.error(`[RepoCache] GCS materialise failed for ${slug}:`, e.message);
      // Continue anyway — the repo dir exists, callers can init/clone as needed
    }
  }

  // If there's a .git tarball in GCS, restore it for fast re-hydration
  try {
    await restoreGitArchive(slug, repoPath);
  } catch (_) {
    // Not critical — if missing, callers can git init / clone
  }
}

/**
 * Restore a .git tarball from GCS (if available).
 * This is a no-op placeholder — archiveGitState() / restoreGitArchive()
 * are wired up in a later commit.
 */
async function restoreGitArchive(slug, repoPath) {
  // Will be implemented in the .git archival commit.
  // For now, skip silently.
}

// ── LRU Cache instance ──────────────────────────────────────────────────────

const cache = new LRUCache({
  max: config.REPO_CACHE_MAX,
  ttl: config.REPO_CACHE_TTL_MS,

  // Only evict entries whose ref count is 0 and that aren't pinned
  allowStale: false,
  noDeleteOnStaleGet: false,
  
  dispose: (entry, slug) => {
    if (!entry) return;
    // Safety: don't delete if refs > 0 or pinned
    if (entry.refs > 0 || entry.pinned) {
      // Re-insert — the eviction was premature
      cache.set(slug, entry);
      return;
    }
    console.log(`[RepoCache] Evicting ${slug} from cache, removing ${entry.repoPath}`);
    rmDir(entry.repoPath).catch(() => {});
  },

  // Don't purge entries that are pinned or in-use
  disposeAfter: (entry, slug) => {
    // Called after disposal — nothing extra needed
  },

  // Don't auto-evict if the entry is still referenced
  noDisposeOnSet: true,
});

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Acquire a working tree for `slug`.
 * Materialises from GCS if not already on disk.
 * Increments the reference counter.
 *
 * @param {string} slug
 * @returns {Promise<string>} absolute path to the working tree
 */
async function acquire(slug) {
  let entry = cache.get(slug);

  if (entry) {
    // Already in cache — wait until it's materialised, bump ref
    await entry.ready;
    entry.refs++;
    return entry.repoPath;
  }

  // Not in cache — materialise
  const repoPath = path.join(config.REPO_CACHE_DIR, slug);

  // Serialise concurrent materialise calls for the same slug
  if (_materializeLocks.has(slug)) {
    await _materializeLocks.get(slug);
    // After the lock resolves, the entry should be in the cache
    return acquire(slug);
  }

  let resolveLock;
  const lockPromise = new Promise((r) => { resolveLock = r; });
  _materializeLocks.set(slug, lockPromise);

  const readyPromise = materialize(slug, repoPath);

  entry = {
    slug,
    repoPath,
    refs: 1,
    pinned: false,
    ready: readyPromise,
  };

  cache.set(slug, entry);

  try {
    await readyPromise;
  } finally {
    _materializeLocks.delete(slug);
    resolveLock();
  }

  return repoPath;
}

/**
 * Release a previously acquired working tree.
 * Decrements the reference counter.
 *
 * @param {string} slug
 */
function release(slug) {
  const entry = cache.get(slug);
  if (entry && entry.refs > 0) {
    entry.refs--;
  }
}

/**
 * Pin a slug so its working tree is never evicted.
 * Use when a Yjs collab session is active for the workspace.
 *
 * @param {string} slug
 */
function pin(slug) {
  const entry = cache.get(slug);
  if (entry) entry.pinned = true;
}

/**
 * Unpin a slug, allowing normal LRU eviction.
 *
 * @param {string} slug
 */
function unpin(slug) {
  const entry = cache.get(slug);
  if (entry) entry.pinned = false;
}

/**
 * Check whether a slug's working tree is currently on disk.
 *
 * @param {string} slug
 * @returns {boolean}
 */
function has(slug) {
  return cache.has(slug);
}

/**
 * Get the on-disk path for a slug WITHOUT acquiring it.
 * Returns `null` if the slug isn't in the cache.
 *
 * @param {string} slug
 * @returns {string|null}
 */
function peek(slug) {
  const entry = cache.peek(slug);
  return entry ? entry.repoPath : null;
}

/**
 * Return cache stats for operational monitoring.
 */
function stats() {
  return {
    size: cache.size,
    max: config.REPO_CACHE_MAX,
    ttlMs: config.REPO_CACHE_TTL_MS,
  };
}

module.exports = {
  acquire,
  release,
  pin,
  unpin,
  has,
  peek,
  stats,
};
