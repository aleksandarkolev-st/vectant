/**
 * usePreviewLifecycle
 *
 * React hook providing the current compiled-preview lifecycle state,
 * derived predicates, and the transition function for direct consumers.
 *
 * This is the recommended way for React components to subscribe to
 * the native preview lifecycle.
 */

import { useState, useEffect } from 'react';
import {
  getPreviewState,
  subscribePreviewStore,
  transitionPreview,
  resetPreviewStore,
  isPreviewAlive,
  isPreviewBusy,
  isPreviewError,
} from '@/lib/preview-store';

/**
 * @returns {{
 *   state: string,
 *   previewId: string|null,
 *   plannerDecision: string|null,
 *   language: string|null,
 *   adapterFamily: string|null,
 *   buildDiagnostics: Object|null,
 *   rollbackReason: string|null,
 *   candidateGeneration: number,
 *   isAlive: boolean,
 *   isBusy: boolean,
 *   isError: boolean,
 *   transition: function,
 *   reset: function,
 * }}
 */
export function usePreviewLifecycle() {
  const [snapshot, setSnapshot] = useState(getPreviewState);

  useEffect(() => {
    // Sync on mount in case state changed between render and effect
    setSnapshot(getPreviewState());
    return subscribePreviewStore(setSnapshot);
  }, []);

  return {
    ...snapshot,
    isAlive: isPreviewAlive(snapshot.state),
    isBusy: isPreviewBusy(snapshot.state),
    isError: isPreviewError(snapshot.state),
    transition: transitionPreview,
    reset: resetPreviewStore,
  };
}
