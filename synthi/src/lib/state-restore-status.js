// ============================================================
// state-restore-status.js
// ============================================================
// Frontend store tracking the state restore lifecycle during
// HMR.  Shows whether state was preserved, migrated, or lost.
// ============================================================

/**
 * @typedef {'idle'|'capturing'|'restoring'|'migrating'|'restored'|'discarded'|'error'} RestorePhase
 */

/**
 * @typedef {Object} RestoreStatus
 * @property {RestorePhase} phase
 * @property {string|null} moduleId
 * @property {string|null} strategy - 'direct'|'migrate'|'discard'
 * @property {string[]} warnings
 * @property {string[]} lostFields
 * @property {number} durationMs
 * @property {number} updatedAt - epoch ms
 */

/** @type {RestoreStatus} */
let _status = {
  phase: 'idle',
  moduleId: null,
  strategy: null,
  warnings: [],
  lostFields: [],
  durationMs: 0,
  updatedAt: 0,
};

/** @type {Set<(status: RestoreStatus) => void>} */
const _listeners = new Set();

function _notify() {
  const snap = { ..._status };
  for (const fn of _listeners) {
    try { fn(snap); } catch (_) { /* swallow */ }
  }
}

/**
 * Get current restore status.
 * @returns {RestoreStatus}
 */
export function getRestoreStatus() {
  return { ..._status };
}

/**
 * Subscribe to restore status changes.
 * @param {(status: RestoreStatus) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribeRestoreStatus(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Update restore status (called from compiler client).
 * @param {Partial<RestoreStatus>} update
 */
export function updateRestoreStatus(update) {
  _status = { ..._status, ...update, updatedAt: Date.now() };
  _notify();
}

/**
 * Reset to idle.
 */
export function resetRestoreStatus() {
  _status = {
    phase: 'idle',
    moduleId: null,
    strategy: null,
    warnings: [],
    lostFields: [],
    durationMs: 0,
    updatedAt: Date.now(),
  };
  _notify();
}

/**
 * Handle restore notification from WebRTC data channel.
 * @param {Object} notification
 */
export function handleRestoreNotification(notification) {
  if (!notification || !notification.type) return;

  const restoreType = notification.type === 'state_restore_status'
    ? notification.restore_type || notification.type
    : notification.type;
  const moduleId = notification.module || notification.module_id || null;

  switch (restoreType) {
    case 'snapshot_capturing':
      updateRestoreStatus({
        phase: 'capturing',
        moduleId,
      });
      break;

    case 'restore_started':
      updateRestoreStatus({
        phase: 'restoring',
        moduleId,
        strategy: notification.strategy || null,
      });
      break;

    case 'migration_started':
      updateRestoreStatus({
        phase: 'migrating',
        moduleId,
        strategy: 'migrate',
      });
      break;

    case 'restore_complete':
      updateRestoreStatus({
        phase: 'restored',
        moduleId,
        strategy: notification.strategy || 'direct',
        warnings: notification.warnings || [],
        lostFields: notification.lost_fields || [],
        durationMs: notification.duration_ms || 0,
      });
      break;

    case 'restore_discarded':
      updateRestoreStatus({
        phase: 'discarded',
        moduleId,
        strategy: 'discard',
        warnings: notification.reasons || [],
      });
      break;

    case 'restore_error':
      updateRestoreStatus({
        phase: 'error',
        moduleId,
        warnings: [notification.error || 'unknown error'],
      });
      break;

    default:
      break;
  }
}

/**
 * Install window event listener for restore notifications.
 * @returns {() => void} cleanup
 */
export function installRestoreListener() {
  /** @param {CustomEvent} e */
  function handler(e) {
    const payload = e.detail?.data || e.detail;
    if (payload) {
      handleRestoreNotification(payload);
    }
  }
  window.addEventListener('synthi:state-restore', handler);
  return () => window.removeEventListener('synthi:state-restore', handler);
}
