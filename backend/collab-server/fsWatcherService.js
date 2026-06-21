/**
 * fsWatcherService.js — Filesystem Watcher for Synthi IDE
 *
 * Watches workspace directories (repos/<slug>/) for changes made outside
 * the editor (e.g. via the integrated terminal, git operations, build tools)
 * and notifies connected WebSocket clients so the file tree can refresh.
 *
 * Uses Node.js native fs.watch with recursive option (supported on Windows
 * and macOS). Falls back gracefully on Linux with manual recursive watching.
 *
 * Design:
 *   - One watcher per workspace slug (shared across terminal sessions)
 *   - Debounces rapid-fire events (npm install creates thousands of events)
 *   - Ignores noise: node_modules, .git internals, build output, lock files
 *   - Ref-counted: watcher closes when last terminal session disconnects
 *   - Broadcasts { type: 'fs-change', events: [...] } to all terminal WS
 *     clients connected to that workspace
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Configuration ──────────────────────────────────────────────────────────

/** Debounce window: batch up events this long before broadcasting */
const DEBOUNCE_MS = 500;

/** Max events per batch (prevent massive payloads from npm install etc.) */
const MAX_EVENTS_PER_BATCH = 50;

/**
 * Polling fallback (cross-writer detection). fs.watch/inotify does NOT fire for
 * writes made by ANOTHER pod/container on the shared volume — e.g. a program
 * container writing under /workspace — so the inotify path never sees them. When
 * enabled, each active watcher ALSO stat-diffs its tree on an interval and emits
 * the SAME fs-change events for anything that changed since the last snapshot.
 * Opt-in + env-gated so it is a no-op when off (byte-for-byte current behavior).
 */
const DEFAULT_FS_POLL_INTERVAL_MS = 2000;
/** Floor so a misconfigured tiny interval can't hot-loop the stat walk. */
const MIN_FS_POLL_INTERVAL_MS = 250;

/** True when the polling fallback is enabled (off by default). */
function isFsPollingEnabled() {
  const v = process.env.SYNTHI_FS_POLL_ENABLED;
  return v === '1' || v === 'true';
}

/** Poll interval in ms (default 2000, env-overridable, floored). */
function getFsPollIntervalMs() {
  const raw = Number(process.env.SYNTHI_FS_POLL_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_FS_POLL_INTERVAL_MS;
  return Math.max(MIN_FS_POLL_INTERVAL_MS, raw);
}

/** Directories to completely ignore (never watch or report changes in) */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.dart_tool',
  '.idea',
  '__pycache__',
  '.gradle',
  'build',
  '.pub-cache',
  '.pub',
  '.next',
  '.nuxt',
  'dist',
  'target',      // Rust, Java
  '.turbo',
  'coverage',
  '.cache',
]);

/** File patterns to ignore */
const IGNORED_PATTERNS = [
  /\.lock$/,           // package-lock.json changes are noisy
  /~$/,                // editor temp files
  /\.swp$/,            // vim swap
  /\.swo$/,
  /\.tmp$/,
  /\.DS_Store$/,
];

// ─── Watcher Registry ───────────────────────────────────────────────────────

/**
 * Staging lock — files currently involved in a git stage/unstage operation.
 * While locked, FS watcher events for these paths are suppressed to prevent
 * the editor from flickering due to race conditions between git index updates,
 * auto-flush writes, and frontend React state.
 *
 * Key: "slug:relative/path" → Value: expiry timestamp (Date.now() + TTL)
 */
const stagingLocks = new Map();

/** Default staging lock TTL in ms — auto-expires in case release is missed */
const STAGING_LOCK_TTL_MS = 5000;

/**
 * Git-operation pause — while paused, ALL FS events for that slug are
 * suppressed (not just specific file paths). Used during pull/push/checkout
 * to prevent the watcher from crashing or triggering mass Yjs invalidation.
 *
 * Key: slug → Value: expiry timestamp (Date.now() + TTL)
 */
const gitOperationPauses = new Map();

/** Default git-operation pause TTL (auto-expires in case release is missed) */
const GIT_PAUSE_TTL_MS = 30000;

/**
 * Pause the FS watcher for a slug during a git operation.
 * @param {string} slug
 */
function pauseWatcher(slug) {
  if (!slug) return;
  gitOperationPauses.set(slug, Date.now() + GIT_PAUSE_TTL_MS);
  // Also clear any pending debounced events so stale changes don't fire
  const entry = activeWatchers.get(slug);
  if (entry) {
    if (entry.debounceTimer) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    entry.pendingEvents.clear();
  }
}

/**
 * Resume the FS watcher for a slug after a git operation completes.
 * Uses a short delay to absorb trailing FS events from git.
 * @param {string} slug
 * @param {number} [delayMs=1200] - delay before actually resuming
 */
function resumeWatcher(slug, delayMs = 1200) {
  if (!slug) return;
  setTimeout(() => {
    gitOperationPauses.delete(slug);
    // Clear any events that accumulated during the tail-end of the pause
    const entry = activeWatchers.get(slug);
    if (entry) {
      entry.pendingEvents.clear();
    }
  }, delayMs);
}

/**
 * Check if a slug's watcher is currently paused for a git operation.
 * Also cleans up expired pauses.
 */
function isWatcherPaused(slug) {
  const expiry = gitOperationPauses.get(slug);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    gitOperationPauses.delete(slug);
    return false;
  }
  return true;
}

/**
 * Acquire a staging lock for a specific file.
 * @param {string} slug
 * @param {string} filePath - relative path within the repo
 */
function acquireStagingLock(slug, filePath) {
  if (!slug || !filePath) return;
  const key = `${slug}:${filePath}`;
  stagingLocks.set(key, Date.now() + STAGING_LOCK_TTL_MS);
}

/**
 * Release a staging lock for a specific file (with optional delay).
 * @param {string} slug
 * @param {string} filePath
 * @param {number} [delayMs=800] - delay before releasing to absorb trailing FS events
 */
function releaseStagingLock(slug, filePath, delayMs = 800) {
  if (!slug || !filePath) return;
  const key = `${slug}:${filePath}`;
  setTimeout(() => {
    stagingLocks.delete(key);
  }, delayMs);
}

/**
 * Check if a file is currently staging-locked.
 * Also cleans up expired locks.
 */
function isStagingLocked(slug, relativePath) {
  const key = `${slug}:${relativePath}`;
  const expiry = stagingLocks.get(key);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    stagingLocks.delete(key);
    return false;
  }
  return true;
}

/**
 * @type {Map<string, {
 *   watcher: fs.FSWatcher,
 *   refCount: number,
 *   pendingEvents: Map<string, string>,
 *   debounceTimer: NodeJS.Timeout|null,
 *   listeners: Set<function>,
 *   rootDir: string
 * }>}
 */
const activeWatchers = new Map();
const globalChangeListeners = new Set();

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if a relative file path should be ignored.
 * We allow the top-level ignored dir itself (e.g. "node_modules") so the
 * tree picks up its creation/deletion, but ignore everything inside it.
 *
 * EXCEPTION: .git is ALWAYS ignored at every level to prevent the watcher
 * from crashing or triggering mass Yjs invalidation during git operations.
 */
function shouldIgnore(relativePath) {
  if (!relativePath) return true;

  const parts = relativePath.split(/[\\/]/);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    // .git is ALWAYS fully ignored — even the top-level directory itself.
    // Git operations (pull, push, merge) touch .git internals rapidly and
    // cause the native fs.watch to emit hundreds of events that can crash
    // the watcher or trigger spurious Yjs doc invalidation.
    if (part === '.git') return true;

    // Other ignored dirs: allow the top-level dir itself so the tree UI
    // shows folders appearing/disappearing, but ignore everything inside.
    if (IGNORED_DIRS.has(part) && part !== '.git' && i < parts.length - 1) return true;
  }

  const basename = path.basename(relativePath);
  for (const pattern of IGNORED_PATTERNS) {
    if (pattern.test(basename)) return true;
  }

  return false;
}

/**
 * Classify a fs.watch event into a more useful type by checking the filesystem.
 * Uses async stat to avoid blocking the event loop.
 */
async function classifyEvent(fullPath) {
  try {
    const fsp = require('fs').promises;
    const stat = await fsp.stat(fullPath);
    return stat.isDirectory() ? 'dir' : 'file';
  } catch (_) {
    // File was deleted (stat fails)
    return 'deleted';
  }
}

// ─── Core ───────────────────────────────────────────────────────────────────

/**
 * Start watching a workspace directory. Returns a cleanup function.
 *
 * @param {string} slug      - Workspace slug
 * @param {string} rootDir   - Absolute path to `repos/<slug>/`
 * @param {function} onChange - Called with { type: 'fs-change', slug, events: [{path, kind}] }
 * @returns {function} unsubscribe function
 */
function watchWorkspace(slug, rootDir, onChange) {
  // Check if we already have a watcher for this slug
  let entry = activeWatchers.get(slug);

  if (entry) {
    // Reuse existing watcher, just add the listener
    entry.refCount++;
    entry.listeners.add(onChange);
    console.log(`[FSWatch] Reusing watcher for "${slug}" (refs=${entry.refCount})`);
    return () => unwatchListener(slug, onChange);
  }

  // Verify directory exists
  if (!fs.existsSync(rootDir)) {
    console.warn(`[FSWatch] Directory does not exist, skipping watch: ${rootDir}`);
    return () => {};
  }

  // Create new watcher
  let watcher;
  try {
    watcher = fs.watch(rootDir, {
      recursive: true,     // Supported on Windows + macOS
      persistent: false,   // Don't keep the process alive just for this
    });
  } catch (err) {
    console.error(`[FSWatch] Failed to watch "${rootDir}":`, err.message);
    return () => {};
  }

  entry = {
    watcher,
    refCount: 1,
    pendingEvents: new Map(),  // relativePath → eventType
    debounceTimer: null,
    listeners: new Set([onChange]),
    rootDir,
    snapshot: null,   // polling-fallback baseline (seeded on first poll cycle)
    pollTimer: null,
  };
  activeWatchers.set(slug, entry);

  // Polling fallback: stat-diff the tree on an interval to catch writes inotify
  // misses (another pod/container writing the shared volume). Ref-counted with
  // the watcher (cleared on close); unref'd so it never keeps the process alive.
  if (isFsPollingEnabled()) {
    entry.pollTimer = setInterval(() => runPollCycle(slug), getFsPollIntervalMs());
    if (entry.pollTimer.unref) entry.pollTimer.unref();
  }

  // ── Handle events ─────────────────────────────────────────────────────
  watcher.on('change', (eventType, filename) => {
    if (!filename) return;

    // Skip ALL events while a git operation is in progress for this slug
    if (isWatcherPaused(slug)) return;

    // Normalize path separators
    const relativePath = filename.replace(/\\/g, '/');

    // Skip ignored paths
    if (shouldIgnore(relativePath)) return;

    // Deduplicate: keep the latest event type per path
    entry.pendingEvents.set(relativePath, eventType);

    // Debounce: flush after DEBOUNCE_MS of quiet
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => flushEvents(slug), DEBOUNCE_MS);
  });

  watcher.on('error', (err) => {
    console.error(`[FSWatch] Watcher error for "${slug}":`, err.message);
  });

  watcher.on('close', () => {
    // Cleanup on unexpected close
    if (activeWatchers.has(slug)) {
      console.log(`[FSWatch] Watcher closed for "${slug}"`);
      activeWatchers.delete(slug);
    }
  });

  console.log(`[FSWatch] Watching "${slug}" at ${rootDir}`);
  return () => unwatchListener(slug, onChange);
}

/**
 * Flush accumulated events to all listeners.
 * Uses async classifyEvent with Promise.all for parallel stat calls.
 */
async function flushEvents(slug) {
  const entry = activeWatchers.get(slug);
  if (!entry || entry.pendingEvents.size === 0) return;

  // Snapshot and clear immediately to avoid re-processing on concurrent flush
  const snapshot = new Map(entry.pendingEvents);
  entry.pendingEvents.clear();
  entry.debounceTimer = null;

  // Check for bulk overflow
  if (snapshot.size > MAX_EVENTS_PER_BATCH) {
    const message = { type: 'fs-change', slug, events: [{ path: '/', kind: 'bulk' }] };
    for (const listener of entry.listeners) {
      try { listener(message); } catch (err) { console.error(`[FSWatch] Listener error:`, err.message); }
    }
    return;
  }

  // Build event list — classify in parallel, skip staging-locked files
  const entries = [];
  for (const [relativePath, eventType] of snapshot) {
    if (isStagingLocked(slug, relativePath)) continue;
    entries.push(relativePath);
  }

  if (entries.length === 0) return;

  // Parallel async stat — all syscalls are issued concurrently
  const classified = await Promise.all(
    entries.map(async (relativePath) => {
      const fullPath = path.join(entry.rootDir, relativePath);
      const kind = await classifyEvent(fullPath);
      return { path: relativePath, kind };
    })
  );

  if (classified.length === 0) return;

  dispatchChange(slug, entry, classified);
}

/**
 * Emit a change batch to BOTH the global change listeners (server.js consumers:
 * Y-Sweet invalidation + git refresh, shape `{ slug, rootDir, events }`) and the
 * per-watcher listeners (tree-refresh broadcast, shape `{ type:'fs-change', ... }`).
 * Shared by the inotify flush and the polling fallback so they emit identically.
 */
function dispatchChange(slug, entry, events) {
  for (const listener of globalChangeListeners) {
    try {
      listener({ slug, rootDir: entry.rootDir, events });
    } catch (err) {
      console.error(`[FSWatch] Global listener error:`, err.message);
    }
  }

  const message = { type: 'fs-change', slug, events };
  for (const listener of entry.listeners) {
    try {
      listener(message);
    } catch (err) {
      console.error(`[FSWatch] Listener error:`, err.message);
    }
  }
}

// ─── Polling fallback ─────────────────────────────────────────────────────────

/**
 * Recursively snapshot a directory tree into a Map<relPath, {mtimeMs,size,isDir}>.
 * Honors the same ignore rules as the inotify path: skips everything inside an
 * ignored dir (but records the top-level dir itself, mirroring shouldIgnore) and
 * never descends into IGNORED_DIRS. Best-effort — unreadable entries are skipped.
 */
function buildDirSnapshot(rootDir) {
  const snapshot = new Map();
  const walk = (absDir, relBase) => {
    let dirents;
    try {
      dirents = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const dirent of dirents) {
      const rel = relBase ? `${relBase}/${dirent.name}` : dirent.name;
      if (shouldIgnore(rel)) continue;
      const abs = path.join(absDir, dirent.name);
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (_) {
        continue;
      }
      const isDir = stat.isDirectory();
      snapshot.set(rel, { mtimeMs: stat.mtimeMs, size: stat.size, isDir });
      if (isDir && !IGNORED_DIRS.has(dirent.name)) walk(abs, rel);
    }
  };
  walk(rootDir, '');
  return snapshot;
}

/**
 * Pure diff of two tree snapshots → fs-change events. Added/modified entries are
 * classified `dir`/`file` from the new snapshot; removed entries are `deleted`.
 * Same event shape the inotify path produces (see classifyEvent).
 */
function diffSnapshots(prev, next) {
  const events = [];
  for (const [rel, meta] of next) {
    const before = prev.get(rel);
    if (!before) {
      events.push({ path: rel, kind: meta.isDir ? 'dir' : 'file' });
    } else if (before.mtimeMs !== meta.mtimeMs || before.size !== meta.size) {
      events.push({ path: rel, kind: meta.isDir ? 'dir' : 'file' });
    }
  }
  for (const [rel] of prev) {
    if (!next.has(rel)) events.push({ path: rel, kind: 'deleted' });
  }
  return events;
}

/**
 * Diff two snapshots and apply the same suppression rules as the inotify flush:
 * fully suppressed while paused (git op), ignored paths + staging-locked paths
 * dropped, and collapsed to a single bulk event past MAX_EVENTS_PER_BATCH.
 */
function computePollEvents(slug, prev, next) {
  if (isWatcherPaused(slug)) return [];
  const filtered = diffSnapshots(prev, next).filter(
    (e) => !shouldIgnore(e.path) && !isStagingLocked(slug, e.path),
  );
  if (filtered.length > MAX_EVENTS_PER_BATCH) {
    return [{ path: '/', kind: 'bulk' }];
  }
  return filtered;
}

/**
 * One polling cycle for a watcher: re-snapshot the tree, diff against the stored
 * baseline, advance the baseline, and dispatch any events the SAME way the
 * inotify flush does. The first cycle only seeds the baseline (returns []).
 * `snapshotFn` is injectable for tests; defaults to the real recursive walk.
 * @returns {{path:string,kind:string}[]} the dispatched events
 */
function runPollCycle(slug, snapshotFn) {
  const entry = activeWatchers.get(slug);
  if (!entry) return [];
  const build = snapshotFn || buildDirSnapshot;
  let next;
  try {
    next = build(entry.rootDir);
  } catch (_) {
    return [];
  }
  const prev = entry.snapshot;
  // Advance the baseline every cycle (incl. while paused) so churn that happened
  // during a git pause is absorbed, not replayed when the pause lifts.
  entry.snapshot = next;
  if (!prev) return [];
  const events = computePollEvents(slug, prev, next);
  if (events.length > 0) dispatchChange(slug, entry, events);
  return events;
}

/**
 * Remove a listener and close the watcher if no listeners remain.
 */
function unwatchListener(slug, onChange) {
  const entry = activeWatchers.get(slug);
  if (!entry) return;

  entry.listeners.delete(onChange);
  entry.refCount--;

  if (entry.refCount <= 0) {
    console.log(`[FSWatch] Closing watcher for "${slug}" (no more refs)`);
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    try { entry.watcher.close(); } catch (_) {}
    activeWatchers.delete(slug);
  }
}

/**
 * Stop all watchers (e.g., on server shutdown).
 */
function stopAll() {
  for (const [slug, entry] of activeWatchers) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    try { entry.watcher.close(); } catch (_) {}
  }
  activeWatchers.clear();
  console.log('[FSWatch] All watchers stopped');
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  watchWorkspace,
  stopAll,
  activeWatchers,
  registerChangeListener,
  acquireStagingLock,
  releaseStagingLock,
  isStagingLocked,
  pauseWatcher,
  resumeWatcher,
  isWatcherPaused,
  // Polling fallback (cross-writer detection)
  isFsPollingEnabled,
  getFsPollIntervalMs,
  buildDirSnapshot,
  diffSnapshots,
  computePollEvents,
  runPollCycle,
};

function registerChangeListener(listener) {
  if (typeof listener !== 'function') return () => {};
  globalChangeListeners.add(listener);
  return () => globalChangeListeners.delete(listener);
}
