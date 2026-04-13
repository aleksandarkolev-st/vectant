// ============================================================
// adapter-status.js — Frontend adapter status store
// ============================================================
// Reactive store tracking which adapter family is active, its
// health, reload count, and last reload time.  Updated via
// WebRTC status messages from the backend.
// ============================================================

const INITIAL_STATE = {
  /** @type {'dynlib'|'managed_runtime'|'process_swap'|'none'} */
  adapterFamily: 'none',
  /** @type {string|null} Language of the loaded module. */
  language: null,
  /** @type {'healthy'|'degraded'|'faulted'|'unknown'} */
  health: 'unknown',
  /** Number of successful reloads since session start. */
  reloadCount: 0,
  /** Number of failed reloads. */
  failedReloadCount: 0,
  /** Timestamp (ms) of last successful reload. */
  lastReloadAt: null,
  /** Duration (ms) of most recent reload. */
  lastReloadMs: null,
  /** Active slot id (for dynlib A/B swap). */
  activeSlot: null,
  /** Whether state was preserved during last reload. */
  statePreserved: null,
};

let state = { ...INITIAL_STATE };
const listeners = new Set();

export function normalizeAdapterFamily(family) {
  if (family == null) return 'none';

  const normalized = String(family).trim().toLowerCase().replace(/[-\s]/g, '_');
  switch (normalized) {
    case 'dynamiclibrary':
    case 'dynamic_library':
    case 'dynlib':
      return 'dynlib';
    case 'managedruntime':
    case 'managed_runtime':
    case 'managed':
      return 'managed_runtime';
    case 'processswap':
    case 'process_swap':
      return 'process_swap';
    default:
      return family;
  }
}

function notify() {
  listeners.forEach((fn) => fn(state));
}

/**
 * Subscribe to adapter status changes.
 * @param {(state: typeof INITIAL_STATE) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribeAdapterStatus(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}

/** Get current snapshot. */
export function getAdapterStatus() {
  return { ...state };
}

/**
 * Handle a backend adapter status notification.
 * Called from the WebRTC message handler when a message with
 * type === 'adapter_status' arrives.
 *
 * @param {object} payload
 */
export function handleAdapterStatusNotification(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (payload.adapter_family != null) {
    state.adapterFamily = normalizeAdapterFamily(payload.adapter_family);
  }
  if (payload.language != null) {
    state.language = payload.language;
  }
  if (payload.health != null) {
    state.health = payload.health;
  }
  if (payload.reload_count != null) {
    state.reloadCount = payload.reload_count;
  }
  if (payload.failed_reload_count != null) {
    state.failedReloadCount = payload.failed_reload_count;
  }
  if (payload.last_reload_at != null) {
    state.lastReloadAt = payload.last_reload_at;
  }
  if (payload.last_reload_ms != null) {
    state.lastReloadMs = payload.last_reload_ms;
  }
  if (payload.active_slot != null) {
    state.activeSlot = payload.active_slot;
  }
  if (payload.state_preserved != null) {
    state.statePreserved = payload.state_preserved;
  }

  notify();
}

/** Reset to initial state (used on disconnect). */
export function resetAdapterStatus() {
  state = { ...INITIAL_STATE };
  notify();
}
