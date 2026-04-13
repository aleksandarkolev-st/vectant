// ============================================================
// dirty-files.js
// ============================================================
// Frontend store tracking which files are dirty (modified since
// last successful compile).  Used by status indicators to show
// pending recompilation state.
// ============================================================

/**
 * @typedef {'core'|'gui'|'shared'|'config'|'resource'|'irrelevant'} FileClass
 */

/**
 * @typedef {Object} DirtyFileInfo
 * @property {string} path
 * @property {FileClass} fileClass
 * @property {number} changedAt - epoch ms
 */

/** @type {Map<string, DirtyFileInfo>} */
const _dirtyFiles = new Map();

/** @type {Set<(files: DirtyFileInfo[]) => void>} */
const _listeners = new Set();

/**
 * Get all dirty files.
 * @returns {DirtyFileInfo[]}
 */
export function getDirtyFiles() {
  return Array.from(_dirtyFiles.values());
}

/**
 * Get dirty files that trigger rebuild.
 * @returns {DirtyFileInfo[]}
 */
export function getRebuildTriggers() {
  return getDirtyFiles().filter(
    (f) => f.fileClass !== 'resource' && f.fileClass !== 'irrelevant'
  );
}

/**
 * Subscribe to dirty file changes.
 * @param {(files: DirtyFileInfo[]) => void} fn
 * @returns {() => void}
 */
export function subscribeDirtyFiles(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _notify() {
  const snapshot = getDirtyFiles();
  for (const fn of _listeners) {
    try { fn(snapshot); } catch (_) { /* swallow */ }
  }
}

/**
 * Mark a file as dirty.
 * @param {string} path
 * @param {FileClass} fileClass
 */
export function markDirty(path, fileClass) {
  _dirtyFiles.set(path, {
    path,
    fileClass: fileClass || 'core',
    changedAt: Date.now(),
  });
  _notify();
}

/**
 * Mark files as clean after successful compile.
 * @param {string[]} [paths] - specific paths, or omit to clear all
 */
export function markClean(paths) {
  if (!paths) {
    _dirtyFiles.clear();
  } else {
    for (const p of paths) {
      _dirtyFiles.delete(p);
    }
  }
  _notify();
}

/**
 * Whether there are files pending recompilation.
 * @returns {boolean}
 */
export function hasPendingChanges() {
  return getRebuildTriggers().length > 0;
}

/**
 * Handle a batch of file change events from the watcher.
 * @param {{ path: string, fileClass: string }[]} changes
 */
export function handleFileChanges(changes) {
  for (const c of changes) {
    _dirtyFiles.set(c.path, {
      path: c.path,
      fileClass: c.fileClass || 'core',
      changedAt: Date.now(),
    });
  }
  if (changes.length > 0) {
    _notify();
  }
}

/**
 * Install window event listener for file changes.
 * @returns {() => void} cleanup
 */
export function installDirtyFileListener() {
  /** @param {CustomEvent} e */
  function handler(e) {
    if (e.detail && Array.isArray(e.detail.changes)) {
      handleFileChanges(e.detail.changes);
    }
  }
  window.addEventListener('synthi:file-changes', handler);
  return () => window.removeEventListener('synthi:file-changes', handler);
}
