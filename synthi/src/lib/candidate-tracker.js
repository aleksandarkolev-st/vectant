// ============================================================
// candidate-tracker.js
// ============================================================
// Frontend store for tracking candidate lifecycle.  Receives
// CandidateNotification payloads from the WebRTC data channel
// and maintains a reactive view of the current candidate state.
// ============================================================

/**
 * @typedef {'enqueued'|'loading'|'health_checking'|'validated'|'promoted'|'rolled_back'|'discarded'} CandidatePhase
 */

/**
 * @typedef {Object} CandidateInfo
 * @property {string} previewId
 * @property {number} generation
 * @property {CandidatePhase} phase
 * @property {string|null} error
 * @property {number} totalReloadMs
 * @property {string|null} rollbackReason
 */

/** @type {CandidateInfo} */
let _current = {
  previewId: '',
  generation: 0,
  phase: 'enqueued',
  error: null,
  totalReloadMs: 0,
  rollbackReason: null,
};

/** @type {CandidateInfo[]} */
let _history = [];
const MAX_HISTORY = 32;

/** @type {Set<(c: CandidateInfo) => void>} */
const _listeners = new Set();

/**
 * Get current candidate state.
 * @returns {CandidateInfo}
 */
export function getCurrentCandidate() {
  return { ..._current };
}

/**
 * Get candidate history (newest last).
 * @returns {CandidateInfo[]}
 */
export function getCandidateHistory() {
  return [..._history];
}

/**
 * Subscribe to candidate state changes.
 * @param {(c: CandidateInfo) => void} fn
 * @returns {() => void}
 */
export function subscribeCandidateTracker(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function _notify() {
  const snapshot = getCurrentCandidate();
  for (const fn of _listeners) {
    try { fn(snapshot); } catch (_) { /* swallow */ }
  }
}

function _archiveCurrent() {
  if (_current.generation > 0) {
    _history.push({ ..._current });
    if (_history.length > MAX_HISTORY) {
      _history.shift();
    }
  }
}

/**
 * Handle a CandidateNotification from the backend.
 * @param {{ event: string, data: object }} notification
 */
export function handleCandidateNotification(notification) {
  const { event, data } = notification;

  switch (event) {
    case 'Enqueued':
      _archiveCurrent();
      _current = {
        previewId: data.preview_id || '',
        generation: data.generation || 0,
        phase: 'enqueued',
        error: null,
        totalReloadMs: 0,
        rollbackReason: null,
      };
      break;

    case 'Loading':
      _current.phase = 'loading';
      break;

    case 'HealthCheckStarted':
      _current.phase = 'health_checking';
      break;

    case 'HealthCheckCompleted':
      // Phase will be updated by Promoted/RolledBack
      _current.phase = 'validated';
      break;

    case 'Promoted':
      _current.phase = 'promoted';
      _current.totalReloadMs = data.total_reload_ms || 0;
      break;

    case 'RolledBack':
      _current.phase = 'rolled_back';
      _current.rollbackReason = data.reason || 'unknown';
      break;

    case 'Discarded':
      _current.phase = 'discarded';
      _current.rollbackReason = data.reason || 'superseded';
      break;

    default:
      return; // Unknown event — no notification
  }

  _notify();
}

/**
 * Whether a candidate is actively being processed.
 * @returns {boolean}
 */
export function isCandidateActive() {
  return ['enqueued', 'loading', 'health_checking', 'validated'].includes(_current.phase);
}

/**
 * Install window event listener for candidate notifications.
 * @returns {() => void} cleanup
 */
export function installCandidateListener() {
  /** @param {CustomEvent} e */
  function handler(e) {
    if (e.detail && e.detail.event) {
      handleCandidateNotification(e.detail);
    }
  }
  window.addEventListener('synthi:candidate-update', handler);
  return () => window.removeEventListener('synthi:candidate-update', handler);
}
