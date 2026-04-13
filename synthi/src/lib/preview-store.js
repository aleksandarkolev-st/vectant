/**
 * Native Preview Lifecycle Store
 *
 * Dedicated store for compiled-preview lifecycle state.
 * This is the single source of truth for the native preview —
 * NOT the JS HMR runtime, not browser module acceptance.
 *
 * Components listen to this store to render lifecycle feedback:
 *   compiling, rebuild scope, warm/cold/managed reload status,
 *   candidate failure, rollback reason, retry action.
 */

import { PreviewLifecycleState, isPreviewAlive, isPreviewBusy, isPreviewError } from '@/lib/preview-lifecycle';

/** @type {PreviewStoreState} */
const INITIAL_STATE = {
  /** Current lifecycle state */
  state: PreviewLifecycleState.IDLE,
  /** Unique preview session ID */
  previewId: null,
  /** Planner decision (e.g. "warm_reload", "cold_reload") */
  plannerDecision: null,
  /** Planner reason bundle */
  reasonBundle: null,
  /** Build diagnostics payload */
  buildDiagnostics: null,
  /** Reload diagnostics (candidate failure, rollback, etc.) */
  reloadDiagnostics: null,
  /** Current candidate generation counter */
  candidateGeneration: 0,
  /** Summary of preserved / reset state after reload */
  stateSummary: null,
  /** Rollback reason if reload was rolled back */
  rollbackReason: null,
  /** Language being compiled */
  language: null,
  /** Adapter family */
  adapterFamily: null,
  /** Timestamp of last state transition */
  lastTransitionMs: Date.now(),
};

/** @type {Set<function>} */
const listeners = new Set();

/** @type {PreviewStoreState} */
let currentState = { ...INITIAL_STATE };

/**
 * Get the current preview store state (snapshot).
 * @returns {PreviewStoreState}
 */
export function getPreviewState() {
  return currentState;
}

/**
 * Subscribe to state changes. Returns an unsubscribe function.
 * @param {function(PreviewStoreState): void} listener
 * @returns {function(): void}
 */
export function subscribePreviewStore(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  const snapshot = currentState;
  listeners.forEach((fn) => {
    try { fn(snapshot); } catch (_) { /* swallow */ }
  });
}

/**
 * Transition to a new lifecycle state.
 *
 * @param {string} nextState - a PreviewLifecycleState value
 * @param {Object} [meta] - optional metadata
 * @param {string} [meta.previewId]
 * @param {string} [meta.message]
 * @param {string} [meta.reasonCode]
 * @param {string} [meta.plannerDecision]
 * @param {Object} [meta.reasonBundle]
 * @param {Object} [meta.buildDiagnostics]
 * @param {Object} [meta.reloadDiagnostics]
 * @param {string} [meta.rollbackReason]
 * @param {Object} [meta.stateSummary]
 * @param {string} [meta.language]
 * @param {string} [meta.adapterFamily]
 * @param {number} [meta.candidateGeneration]
 */
export function transitionPreview(nextState, meta = {}) {
  currentState = {
    ...currentState,
    state: nextState,
    lastTransitionMs: Date.now(),
    ...(meta.previewId != null && { previewId: meta.previewId }),
    ...(meta.plannerDecision != null && { plannerDecision: meta.plannerDecision }),
    ...(meta.reasonBundle != null && { reasonBundle: meta.reasonBundle }),
    ...(meta.buildDiagnostics != null && { buildDiagnostics: meta.buildDiagnostics }),
    ...(meta.reloadDiagnostics != null && { reloadDiagnostics: meta.reloadDiagnostics }),
    ...(meta.rollbackReason != null && { rollbackReason: meta.rollbackReason }),
    ...(meta.stateSummary != null && { stateSummary: meta.stateSummary }),
    ...(meta.language != null && { language: meta.language }),
    ...(meta.adapterFamily != null && { adapterFamily: meta.adapterFamily }),
    ...(meta.candidateGeneration != null && { candidateGeneration: meta.candidateGeneration }),
  };

  // Clear transient fields on recovery transitions
  if (nextState === PreviewLifecycleState.IDLE || nextState === PreviewLifecycleState.COMPILE_REQUESTED) {
    currentState.rollbackReason = null;
    currentState.reloadDiagnostics = null;
  }
  if (nextState === PreviewLifecycleState.COMPILE_REQUESTED) {
    currentState.buildDiagnostics = null;
  }

  notify();
}

/**
 * Reset the store to initial state.
 */
export function resetPreviewStore() {
  currentState = { ...INITIAL_STATE, lastTransitionMs: Date.now() };
  notify();
}

// Re-export predicates for convenience
export { isPreviewAlive, isPreviewBusy, isPreviewError };
