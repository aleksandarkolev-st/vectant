/**
 * Preview Lifecycle Schema
 *
 * Canonical lifecycle states for compiled (native) previews.
 * Every compiled-language path must emit these states.
 * The UI consumes these values directly — no ad-hoc string matching.
 *
 * This file is the single source of truth for both the status indicator
 * and any preview store that tracks native preview state.
 */

/** @readonly @enum {string} */
export const PreviewLifecycleState = Object.freeze({
  /** No active preview session. */
  IDLE: 'idle',
  /** A save was detected and a compile request has been queued. */
  COMPILE_REQUESTED: 'compile_requested',
  /** The build plane is actively compiling dirty units. */
  COMPILING: 'compiling',
  /** Compilation finished successfully; a candidate artifact is ready. */
  COMPILE_FINISHED: 'compile_finished',
  /** Compilation failed; diagnostics are available. */
  COMPILE_FAILED: 'compile_failed',
  /** The runtime planner has decided on a reload strategy. */
  RELOAD_PLANNED: 'reload_planned',
  /** The runtime is actively applying the candidate. */
  RELOAD_APPLYING: 'reload_applying',
  /** The candidate was promoted successfully. */
  RELOAD_APPLIED: 'reload_applied',
  /** The candidate failed health checks; old preview preserved. */
  RELOAD_ROLLED_BACK: 'reload_rolled_back',
  /** Runtime crashed but recovered using last known-good candidate. */
  CRASH_RECOVERED: 'crash_recovered',
  /** Runtime crashed fatally — full restart required. */
  CRASH_FATAL: 'crash_fatal',
  /** A full restart was performed (last resort). */
  FULL_RESTART: 'full_restart',
});

/**
 * Returns true if the preview is in a state where the user can interact.
 * @param {string} state
 * @returns {boolean}
 */
export function isPreviewAlive(state) {
  return state !== PreviewLifecycleState.CRASH_FATAL
      && state !== PreviewLifecycleState.FULL_RESTART;
}

/**
 * Returns true if the system is actively building or reloading.
 * @param {string} state
 * @returns {boolean}
 */
export function isPreviewBusy(state) {
  return state === PreviewLifecycleState.COMPILE_REQUESTED
      || state === PreviewLifecycleState.COMPILING
      || state === PreviewLifecycleState.RELOAD_PLANNED
      || state === PreviewLifecycleState.RELOAD_APPLYING;
}

/**
 * Returns true if the last operation resulted in an error state.
 * @param {string} state
 * @returns {boolean}
 */
export function isPreviewError(state) {
  return state === PreviewLifecycleState.COMPILE_FAILED
      || state === PreviewLifecycleState.RELOAD_ROLLED_BACK
      || state === PreviewLifecycleState.CRASH_RECOVERED
      || state === PreviewLifecycleState.CRASH_FATAL;
}
