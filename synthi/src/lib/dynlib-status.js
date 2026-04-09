// ============================================================
// dynlib-status.js
// ============================================================
// Frontend store tracking the dynamic library swap status for
// the preview panel. Shows swap phase, timing, and rollback
// information.
// ============================================================

/**
 * @typedef {'idle'|'quiescing'|'snapshotting'|'swapping'|'restoring'|'resuming'|'completed'|'failed'|'aborted'} SwapPhase
 */

/**
 * @typedef {Object} DynlibStatus
 * @property {SwapPhase} phase
 * @property {string} module
 * @property {number} elapsedMs
 * @property {boolean} rolledBack
 * @property {string|null} error
 * @property {{ quiesceMs: number, snapshotMs: number, loadMs: number, restoreMs: number }} timing
 */

/** @type {DynlibStatus} */
let _status = {
  phase: 'idle',
  module: '',
  elapsedMs: 0,
  rolledBack: false,
  error: null,
  timing: { quiesceMs: 0, snapshotMs: 0, loadMs: 0, restoreMs: 0 },
};

/** @type {Set<(s: DynlibStatus) => void>} */
const _listeners = new Set();

/**
 * Get current dynamic library swap status.
 * @returns {DynlibStatus}
 */
export function getDynlibStatus() {
  return { ..._status, timing: { ..._status.timing } };
}

/**
 * Subscribe to dynamic library status changes.
 * @param {(s: DynlibStatus) => void} fn
 * @returns {() => void}
 */
export function subscribeDynlibStatus(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Handle incoming swap phase notification from WebRTC.
 * @param {{ module: string, phase: string, elapsedMs?: number, error?: string, rolledBack?: boolean, timing?: object }} msg
 */
export function handleSwapNotification(msg) {
  _status = {
    phase: msg.phase || 'idle',
    module: msg.module || '',
    elapsedMs: msg.elapsedMs || 0,
    rolledBack: msg.rolledBack || false,
    error: msg.error || null,
    timing: {
      quiesceMs: msg.timing?.quiesceMs || 0,
      snapshotMs: msg.timing?.snapshotMs || 0,
      loadMs: msg.timing?.loadMs || 0,
      restoreMs: msg.timing?.restoreMs || 0,
    },
  };

  for (const listener of _listeners) {
    try { listener(getDynlibStatus()); } catch (_) { /* swallow */ }
  }
}

/**
 * Whether a swap is currently in progress.
 * @returns {boolean}
 */
export function isSwapInProgress() {
  return !['idle', 'completed', 'failed', 'aborted'].includes(_status.phase);
}

/**
 * Install a window event listener for swap status from compiler client.
 * @returns {() => void} cleanup
 */
export function installSwapStatusListener() {
  /** @param {CustomEvent} e */
  function handler(e) {
    if (e.detail) {
      handleSwapNotification(e.detail);
    }
  }
  window.addEventListener('synthi:dynlib-swap', handler);
  return () => window.removeEventListener('synthi:dynlib-swap', handler);
}
