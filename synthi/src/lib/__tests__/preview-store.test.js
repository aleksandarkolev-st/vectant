/**
 * Preview Store Integration Tests
 *
 * Test stubs for verifying the frontend lifecycle ownership
 * changes from Wave 02 (commits 011-019).
 *
 * These are designed to run in a jsdom or browser-like env.
 */

import { PreviewLifecycleState } from '@/lib/preview-lifecycle';
import {
  getPreviewState,
  subscribePreviewStore,
  transitionPreview,
  resetPreviewStore,
} from '@/lib/preview-store';

// ── Helpers ──

function assertState(expected, message) {
  const actual = getPreviewState().state;
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

// ── Test cases ──

export function testPreviewStoreTransitions() {
  resetPreviewStore();
  assertState(PreviewLifecycleState.IDLE, 'initial');

  transitionPreview(PreviewLifecycleState.COMPILE_REQUESTED, { previewId: 'test-1' });
  assertState(PreviewLifecycleState.COMPILE_REQUESTED, 'after request');

  transitionPreview(PreviewLifecycleState.COMPILING);
  assertState(PreviewLifecycleState.COMPILING, 'after compiling');

  transitionPreview(PreviewLifecycleState.COMPILE_FINISHED, {
    buildDiagnostics: { diagnostics: [], error_count: 0 },
  });
  assertState(PreviewLifecycleState.COMPILE_FINISHED, 'after finish');

  transitionPreview(PreviewLifecycleState.RELOAD_PLANNED, {
    plannerDecision: 'warm_reload',
  });
  assertState(PreviewLifecycleState.RELOAD_PLANNED, 'after plan');

  transitionPreview(PreviewLifecycleState.RELOAD_APPLYING);
  assertState(PreviewLifecycleState.RELOAD_APPLYING, 'after applying');

  transitionPreview(PreviewLifecycleState.RELOAD_APPLIED, {
    stateSummary: { preserved: true },
  });
  assertState(PreviewLifecycleState.RELOAD_APPLIED, 'after applied');

  // Check metadata
  const state = getPreviewState();
  if (state.previewId !== 'test-1') throw new Error('previewId not preserved');
  if (state.plannerDecision !== 'warm_reload') throw new Error('plannerDecision lost');

  resetPreviewStore();
  console.log('[test] testPreviewStoreTransitions PASSED');
}

export function testPreviewStoreSubscription() {
  resetPreviewStore();
  let callCount = 0;
  const unsub = subscribePreviewStore(() => { callCount++; });

  transitionPreview(PreviewLifecycleState.COMPILING);
  transitionPreview(PreviewLifecycleState.COMPILE_FINISHED);
  unsub();
  transitionPreview(PreviewLifecycleState.IDLE);

  if (callCount !== 2) {
    throw new Error(`Expected 2 notifications, got ${callCount}`);
  }

  resetPreviewStore();
  console.log('[test] testPreviewStoreSubscription PASSED');
}

export function testTransientFieldClearing() {
  resetPreviewStore();

  transitionPreview(PreviewLifecycleState.COMPILE_FAILED, {
    buildDiagnostics: { error_count: 1 },
    rollbackReason: 'test-reason',
  });

  if (!getPreviewState().rollbackReason) throw new Error('rollbackReason not set');

  // Transition to COMPILE_REQUESTED should clear transients
  transitionPreview(PreviewLifecycleState.COMPILE_REQUESTED);
  const s = getPreviewState();
  if (s.rollbackReason) throw new Error('rollbackReason not cleared');
  if (s.buildDiagnostics) throw new Error('buildDiagnostics not cleared');

  resetPreviewStore();
  console.log('[test] testTransientFieldClearing PASSED');
}

export function runAllPreviewTests() {
  testPreviewStoreTransitions();
  testPreviewStoreSubscription();
  testTransientFieldClearing();
  console.log('[test] All preview store tests PASSED');
}
