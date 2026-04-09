// ============================================================
// loop-status.js
// ============================================================
// Frontend module that tracks whether the current compile used
// the deterministic Loop A or AI-assisted Loop B path, and
// exposes it to UI components.
// ============================================================

/**
 * @typedef {'loop-a' | 'loop-b' | 'unknown'} LoopType
 */

/**
 * @typedef {Object} LoopStatus
 * @property {LoopType} loopType
 * @property {string} reason
 * @property {boolean} isDeterministic
 * @property {boolean} isAiAssisted
 * @property {number} loopACount
 * @property {number} loopBCount
 * @property {number} loopARatio
 */

/** @type {LoopStatus} */
let _status = {
  loopType: 'unknown',
  reason: '',
  isDeterministic: false,
  isAiAssisted: false,
  loopACount: 0,
  loopBCount: 0,
  loopARatio: 0,
};

/** @type {Set<(s: LoopStatus) => void>} */
const _listeners = new Set();

/**
 * Get the current loop status.
 * @returns {LoopStatus}
 */
export function getLoopStatus() {
  return { ..._status };
}

/**
 * Subscribe to loop status changes.
 * @param {(s: LoopStatus) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeLoopStatus(listener) {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

/**
 * Update the loop status from a compile enrichment notification.
 * Called by the preview-store-bridge when enrichment data arrives.
 *
 * @param {{ loopType: string, reason: string }} enrichment
 */
export function updateLoopStatus(enrichment) {
  const loopType = enrichment.loopType === 'LoopA' ? 'loop-a'
    : enrichment.loopType === 'LoopB' ? 'loop-b'
    : 'unknown';

  const isA = loopType === 'loop-a';
  const isB = loopType === 'loop-b';

  const loopACount = _status.loopACount + (isA ? 1 : 0);
  const loopBCount = _status.loopBCount + (isB ? 1 : 0);
  const total = loopACount + loopBCount;

  _status = {
    loopType,
    reason: enrichment.reason || '',
    isDeterministic: isA,
    isAiAssisted: isB,
    loopACount,
    loopBCount,
    loopARatio: total > 0 ? loopACount / total : 0,
  };

  for (const listener of _listeners) {
    try { listener({ ..._status }); } catch (_) { /* swallow */ }
  }
}

/**
 * Reset counters (for testing).
 */
export function resetLoopStatus() {
  _status = {
    loopType: 'unknown',
    reason: '',
    isDeterministic: false,
    isAiAssisted: false,
    loopACount: 0,
    loopBCount: 0,
    loopARatio: 0,
  };
}

/**
 * Install a window event listener for loop status notifications
 * dispatched by the compiler client.
 *
 * @returns {() => void} cleanup
 */
export function installLoopStatusListener() {
  /** @param {CustomEvent} e */
  function handler(e) {
    if (e.detail && e.detail.loopType) {
      updateLoopStatus(e.detail);
    }
  }
  window.addEventListener('synthi:loop-status', handler);
  return () => window.removeEventListener('synthi:loop-status', handler);
}
