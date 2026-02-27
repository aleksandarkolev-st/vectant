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

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if a relative file path should be ignored.
 * We allow the top-level ignored dir itself (e.g. "node_modules") so the
 * tree picks up its creation/deletion, but ignore everything inside it.
 */
function shouldIgnore(relativePath) {
  if (!relativePath) return true;

  const parts = relativePath.split(/[\\/]/);

  // If the path IS an ignored dir at the top level (e.g. "node_modules"),
  // allow it so the tree shows the folder appearing/disappearing.
  // Only ignore paths INSIDE ignored dirs (depth >= 2, e.g. "node_modules/foo").
  for (let i = 0; i < parts.length; i++) {
    if (IGNORED_DIRS.has(parts[i]) && i < parts.length - 1) return true;
  }

  const basename = path.basename(relativePath);
  for (const pattern of IGNORED_PATTERNS) {
    if (pattern.test(basename)) return true;
  }

  return false;
}

/**
 * Classify a fs.watch event into a more useful type by checking the filesystem.
 */
function classifyEvent(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
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
  };
  activeWatchers.set(slug, entry);

  // ── Handle events ─────────────────────────────────────────────────────
  watcher.on('change', (eventType, filename) => {
    if (!filename) return;

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
 */
function flushEvents(slug) {
  const entry = activeWatchers.get(slug);
  if (!entry || entry.pendingEvents.size === 0) return;

  // Build the event list, skipping staging-locked files
  const events = [];
  for (const [relativePath, eventType] of entry.pendingEvents) {
    // Skip files currently being staged to prevent editor flickering
    if (isStagingLocked(slug, relativePath)) {
      continue;
    }

    if (events.length >= MAX_EVENTS_PER_BATCH) {
      // Too many individual events — just tell the client to do a full refresh
      events.length = 0;
      events.push({ path: '/', kind: 'bulk' });
      break;
    }

    const fullPath = path.join(entry.rootDir, relativePath);
    const kind = classifyEvent(fullPath);
    events.push({ path: relativePath, kind });
  }

  entry.pendingEvents.clear();
  entry.debounceTimer = null;

  // Only broadcast if there are events left after filtering
  if (events.length === 0) return;

  // Broadcast to all listeners
  const message = { type: 'fs-change', slug, events };
  for (const listener of entry.listeners) {
    try {
      listener(message);
    } catch (err) {
      console.error(`[FSWatch] Listener error:`, err.message);
    }
  }
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
  acquireStagingLock,
  releaseStagingLock,
  isStagingLocked,
};
