/**
 * Preview Store Bridge
 *
 * Routes existing `synthi:*` window events from CompilerClient into
 * the preview-store lifecycle state machine.
 *
 * Usage:
 *   import { installPreviewBridge, removePreviewBridge } from '@/lib/preview-store-bridge';
 *   const cleanup = installPreviewBridge();
 *   // on unmount:
 *   cleanup();
 */

import { PreviewLifecycleState } from '@/lib/preview-lifecycle';
import { transitionPreview, resetPreviewStore } from '@/lib/preview-store';
import { hasErrors } from '@/lib/diagnostics-schema';

/**
 * Map existing HMR status strings from the runner to lifecycle states.
 */
const HMR_STATUS_MAP = {
  'applied': PreviewLifecycleState.RELOAD_APPLIED,
  'rejected': PreviewLifecycleState.RELOAD_ROLLED_BACK,
  'compile-error': PreviewLifecycleState.COMPILE_FAILED,
  'crash-recovered': PreviewLifecycleState.CRASH_RECOVERED,
  'crash-fatal': PreviewLifecycleState.CRASH_FATAL,
  'state-migrated': PreviewLifecycleState.RELOAD_APPLIED,
};

function handleCompileDiagnostics(e) {
  const detail = e.detail;
  if (!detail) return;

  if (detail.error_count > 0 || (detail.diagnostics && hasErrors({ diagnostics: detail.diagnostics }))) {
    transitionPreview(PreviewLifecycleState.COMPILE_FAILED, {
      buildDiagnostics: detail,
    });
  } else {
    transitionPreview(PreviewLifecycleState.COMPILE_FINISHED, {
      buildDiagnostics: detail,
    });
  }
}

function handleHmrStatus(e) {
  const detail = e.detail;
  if (!detail) return;

  const status = detail.status;
  const mapped = HMR_STATUS_MAP[status];
  if (mapped) {
    transitionPreview(mapped, {
      rollbackReason: status === 'rejected' ? (detail.reason || 'rejected') : undefined,
      stateSummary: detail.state_summary || undefined,
    });
    return;
  }

  // Generic status strings not in map — e.g. "compiling", "reload-planned"
  if (status === 'compiling') {
    transitionPreview(PreviewLifecycleState.COMPILING);
  } else if (status === 'reload-planned') {
    transitionPreview(PreviewLifecycleState.RELOAD_PLANNED, {
      plannerDecision: detail.decision || null,
      reasonBundle: detail.reason_bundle || null,
    });
  } else if (status === 'reload-applying') {
    transitionPreview(PreviewLifecycleState.RELOAD_APPLYING);
  }
}

function handleHmrUpdate(e) {
  // An HMR update message implies a reload is being applied
  transitionPreview(PreviewLifecycleState.RELOAD_APPLYING);
}

function handleGuiStart(e) {
  // GUI start implies the preview is live — reset to IDLE
  transitionPreview(PreviewLifecycleState.IDLE, {
    previewId: e.detail?.session_id || null,
    language: e.detail?.language || null,
  });
}

function handleGuiEnd(_e) {
  resetPreviewStore();
}

/**
 * Install event listeners that bridge CompilerClient events → preview store.
 * Returns a cleanup function.
 *
 * @returns {function(): void}
 */
export function installPreviewBridge() {
  if (typeof window === 'undefined') return () => {};

  window.addEventListener('synthi:compile-diagnostics', handleCompileDiagnostics);
  window.addEventListener('synthi:hmr-status', handleHmrStatus);
  window.addEventListener('synthi:hmr-update', handleHmrUpdate);
  window.addEventListener('synthi:gui-start', handleGuiStart);
  window.addEventListener('synthi:gui-end', handleGuiEnd);

  return () => {
    window.removeEventListener('synthi:compile-diagnostics', handleCompileDiagnostics);
    window.removeEventListener('synthi:hmr-status', handleHmrStatus);
    window.removeEventListener('synthi:hmr-update', handleHmrUpdate);
    window.removeEventListener('synthi:gui-start', handleGuiStart);
    window.removeEventListener('synthi:gui-end', handleGuiEnd);
  };
}
