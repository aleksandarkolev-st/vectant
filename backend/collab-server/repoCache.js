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

/** Serialise concurrent materialise calls per cache key. */
const _materializeLocks = new Map();

/**
 * Build a composite cache key.
 * @param {string} slug
 * @param {string} [userId]
 * @returns {string}
 */
function _cacheKey(slug, userId) {
  return userId ? `${slug}:${userId}` : slug;
}

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
 * Check whether a slug-level directory contains per-user repo subdirectories.
 * This is used by the dispose callback to avoid deleting repos/<slug>/ when
 * per-user repos (repos/<slug>/<userId>/) exist inside — deleting the parent
 * would wipe out ALL users' working trees.
 *
 * @param {string} dir — Absolute path to the slug-level directory
 * @returns {boolean}
 */
function _hasPerUserRepos(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.some(e => {
      if (!e.isDirectory()) return false;
      // Skip internal dirs
      if (e.name === '_upstream.git' || e.name === 'sessions' || e.name.startsWith('.')) return false;
      // A valid per-user repo has a .git inside
      return fs.existsSync(path.join(dir, e.name, '.git'));
    });
  } catch (_) {
    return false;
  }
}

/**
 * Materialise a working tree from GCS if it doesn't already exist on disk.
 */
async function materialize(slug, repoPath, userId) {
  // Fast path: already on disk with a .git dir
  if (fs.existsSync(path.join(repoPath, '.git'))) {
    return;
  }

  // Ensure parent dir exists
  await fsp.mkdir(repoPath, { recursive: true });

  // Download workspace files from GCS
  if (gcsSync.isGcsConfigured()) {
    const label = userId ? `${slug}/${userId}` : slug;
    console.log(`[RepoCache] Materialising ${label} from GCS → ${repoPath}`);
    try {
      const res = await gcsSync.downloadGcsToRepo(slug, repoPath, { userId });
      console.log(`[RepoCache] GCS download for ${label}: ${res.success} files`);
    } catch (e) {
      console.error(`[RepoCache] GCS materialise failed for ${label}:`, e.message);
      // Continue anyway — the repo dir exists, callers can init/clone as needed
    }
  }

  // If there's a .git tarball in GCS, restore it for fast re-hydration
  try {
    await restoreGitArchive(slug, repoPath, userId);
  } catch (_) {
    // Not critical — if missing, callers can git init / clone
  }
}

/**
 * Restore a .git tarball from GCS (if available).
 */
async function restoreGitArchive(slug, repoPath, userId) {
  if (!gcsSync.isGcsConfigured()) return;
  const result = await gcsSync.restoreGitFromGcs(slug, repoPath, userId);
  if (result.success) {
    const label = userId ? `${slug}/${userId}` : slug;
    console.log(`[RepoCache] Restored .git archive for ${label}`);
  }
  // Not critical — if missing, callers can git init / clone
}

// ── LRU Cache instance ──────────────────────────────────────────────────────

/** Entries that must not be evicted are tracked separately so that the
 *  LRU dispose callback can re-insert without triggering recursive eviction. */
const _safeEntries = new Map();

const cache = new LRUCache({
  max: config.REPO_CACHE_MAX,
  ttl: config.REPO_CACHE_TTL_MS,

  // Only evict entries whose ref count is 0 and that aren't pinned
  allowStale: false,
  noDeleteOnStaleGet: false,
  
  dispose: (entry, key) => {
    if (!entry) return;
    // Safety: don't delete if refs > 0 or pinned.
    // Instead of re-inserting into the LRU (which can cause recursive
    // eviction or get silently dropped), stash in a side-map and
    // re-insert on the next `acquire` / `get`.
    if (entry.refs > 0 || entry.pinned) {
      console.log(`[RepoCache] Refusing to evict in-use entry ${key} (refs=${entry.refs}, pinned=${entry.pinned})`);
      _safeEntries.set(key, entry);
      return;
    }
    // Safety: for slug-level entries (key has no ':'), never delete the
    // directory if it contains per-user repos — doing so would wipe out
    // ALL users' working trees for this workspace.
    if (!key.includes(':') && _hasPerUserRepos(entry.repoPath)) {
      console.log(`[RepoCache] Refusing to evict slug-level entry ${key} — per-user repos exist inside ${entry.repoPath}`);
      _safeEntries.set(key, entry);
      return;
    }
    // Also check if any per-user entries in the cache or _safeEntries
    // reference paths inside this slug directory (belt-and-suspenders).
    const isSlugLevel = !key.includes(':');
    if (isSlugLevel) {
      const slug = key;
      const hasActivePerUser = [...cache.keys(), ..._safeEntries.keys()].some(
        k => k !== key && k.startsWith(slug + ':')
      );
      if (hasActivePerUser) {
        console.log(`[RepoCache] Refusing to evict slug-level entry ${key} — per-user cache entries exist`);
        _safeEntries.set(key, entry);
        return;
      }
    }
    console.log(`[RepoCache] Evicting ${key} from cache, removing ${entry.repoPath}`);
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
 * Acquire a working tree for `slug` (optionally per-user via `userId`).
 * Materialises from GCS if not already on disk.
 * Increments the reference counter.
 *
 * @param {string} slug
 * @param {string} [userId]
 * @returns {Promise<string>} absolute path to the working tree
 */
async function acquire(slug, userId) {
  const key = _cacheKey(slug, userId);
  let entry = cache.get(key);

  // Check if the entry was rescued from eviction while in use
  if (!entry && _safeEntries.has(key)) {
    entry = _safeEntries.get(key);
    _safeEntries.delete(key);
    cache.set(key, entry);  // Re-insert into LRU
  }

  if (entry) {
    // Already in cache — wait until it's materialised, bump ref
    await entry.ready;
    entry.refs++;
    return entry.repoPath;
  }

  // Not in cache — materialise
  const repoPath = userId
    ? path.join(config.REPO_CACHE_DIR, slug, userId)
    : path.join(config.REPO_CACHE_DIR, slug);

  // Serialise concurrent materialise calls for the same key
  if (_materializeLocks.has(key)) {
    await _materializeLocks.get(key);
    // After the lock resolves, the entry should be in the cache
    return acquire(slug, userId);
  }

  let resolveLock;
  const lockPromise = new Promise((r) => { resolveLock = r; });
  _materializeLocks.set(key, lockPromise);

  const readyPromise = materialize(slug, repoPath, userId);

  entry = {
    slug,
    userId: userId || null,
    repoPath,
    refs: 1,
    pinned: false,
    ready: readyPromise,
  };

  cache.set(key, entry);

  try {
    await readyPromise;
  } finally {
    _materializeLocks.delete(key);
    resolveLock();
  }

  return repoPath;
}

/**
 * Release a previously acquired working tree.
 * Decrements the reference counter.
 *
 * @param {string} slug
 * @param {string} [userId]
 */
function release(slug, userId) {
  const key = _cacheKey(slug, userId);
  const entry = cache.get(key) || _safeEntries.get(key);
  if (entry && entry.refs > 0) {
    entry.refs--;
  }
}

/**
 * Pin a cache entry so its working tree is never evicted.
 * Use when a Yjs collab session is active for the workspace.
 *
 * @param {string} slug
 * @param {string} [userId]
 */
function pin(slug, userId) {
  const key = _cacheKey(slug, userId);
  const entry = cache.get(key) || _safeEntries.get(key);
  if (entry) entry.pinned = true;
}

/**
 * Unpin a cache entry, allowing normal LRU eviction.
 *
 * @param {string} slug
 * @param {string} [userId]
 */
function unpin(slug, userId) {
  const key = _cacheKey(slug, userId);
  const entry = cache.get(key) || _safeEntries.get(key);
  if (entry) entry.pinned = false;
}

/**
 * Check whether a cache entry's working tree is currently on disk.
 *
 * @param {string} slug
 * @param {string} [userId]
 * @returns {boolean}
 */
function has(slug, userId) {
  const key = _cacheKey(slug, userId);
  return cache.has(key);
}

/**
 * Get the on-disk path for a cache entry WITHOUT acquiring it.
 * Returns `null` if the entry isn't in the cache.
 *
 * @param {string} slug
 * @param {string} [userId]
 * @returns {string|null}
 */
function peek(slug, userId) {
  const key = _cacheKey(slug, userId);
  const entry = cache.peek(key);
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
