/**
 * Planner Decision Consumer
 *
 * Frontend counterpart that listens for planner decision
 * notifications from the Rust backend (via WebRTC data channel)
 * and routes them into the preview store.
 *
 * The PlannerNotification shape matches the struct defined in
 * hmr/planner_glue.rs.
 */

import { PreviewLifecycleState } from '@/lib/preview-lifecycle';
import { transitionPreview } from '@/lib/preview-store';

/**
 * @typedef {Object} PlannerNotification
 * @property {string} type - always "hmr-status"
 * @property {string} status - "reload-planned"
 * @property {string} decision - "warm_reload" | "cold_reload" | etc.
 * @property {string} decision_code - e.g. "WARM_ELIGIBLE"
 * @property {string} decision_reason - human-readable reason
 * @property {string?} user_message - optional user-facing message
 * @property {string} preview_id
 */

/**
 * Map of Rust-side decision strings to display labels.
 */
export const DECISION_LABELS = Object.freeze({
  warm_reload: 'Warm Reload',
  cold_reload: 'Cold Reload',
  managed_reload: 'Managed Reload',
  process_swap: 'Process Swap',
  full_restart: 'Full Restart',
  reject_build: 'Build Rejected',
});

/**
 * Handle a planner notification from the backend.
 * Routes the decision into the preview store as appropriate.
 *
 * @param {PlannerNotification} notification
 */
export function handlePlannerNotification(notification) {
  if (!notification || notification.type !== 'hmr-status') return;

  if (notification.status === 'reload-planned') {
    transitionPreview(PreviewLifecycleState.RELOAD_PLANNED, {
      plannerDecision: notification.decision,
      reasonBundle: {
        decision_code: notification.decision_code,
        decision_reason: notification.decision_reason,
        user_message: notification.user_message || null,
      },
      previewId: notification.preview_id,
    });
  }
}

/**
 * Install a window event listener for planner notifications.
 * Returns a cleanup function.
 *
 * @returns {function(): void}
 */
export function installPlannerConsumer() {
  if (typeof window === 'undefined') return () => {};

  function onHmrStatus(e) {
    const detail = e.detail;
    if (detail?.status === 'reload-planned') {
      handlePlannerNotification(detail);
    }
  }

  window.addEventListener('synthi:hmr-status', onHmrStatus);
  return () => window.removeEventListener('synthi:hmr-status', onHmrStatus);
}
