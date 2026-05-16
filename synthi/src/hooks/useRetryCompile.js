/**
 * useRetryCompile
 *
 * React hook that subscribes to the preview store and exposes a
 * retry action when the lifecycle is in an error state.
 * The retry re-dispatches a compile request through the
 * CompilerClient, resetting the lifecycle to COMPILE_REQUESTED.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { PreviewLifecycleState } from '@/lib/preview-lifecycle';
import {
  getPreviewState,
  subscribePreviewStore,
  transitionPreview,
  isPreviewError,
} from '@/lib/preview-store';

const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 2000;

/**
 * @param {Object} [options]
 * @param {import('@/services/compilerClient').CompilerClient} [options.compilerClient]
 * @param {boolean} [options.autoRetry=false] - retry automatically on transient errors
 * @returns {{ canRetry: boolean, retryCount: number, isRetrying: boolean, retry: () => void }}
 */
export function useRetryCompile({ compilerClient, autoRetry = false } = {}) {
  const [canRetry, setCanRetry] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [isRetrying, setIsRetrying] = useState(false);
  const autoRetryTimerRef = useRef(null);
  const retryCountRef = useRef(0);

  useEffect(() => {
    function onStateChange(state) {
      const errorState = isPreviewError(state.state);
      setCanRetry(errorState);
      if (!errorState) {
        // Success — reset retry count
        retryCountRef.current = 0;
        setRetryCount(0);
        setIsRetrying(false);
        if (autoRetryTimerRef.current) {
          clearTimeout(autoRetryTimerRef.current);
          autoRetryTimerRef.current = null;
        }
      }
    }

    // Initial state
    onStateChange(getPreviewState());
    return subscribePreviewStore(onStateChange);
  }, []);

  // Auto-retry logic
  useEffect(() => {
    if (!autoRetry || !canRetry || isRetrying) return;
    if (retryCountRef.current >= MAX_AUTO_RETRIES) return;

    autoRetryTimerRef.current = setTimeout(() => {
      doRetry();
    }, AUTO_RETRY_DELAY_MS);

    return () => {
      if (autoRetryTimerRef.current) {
        clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
    };
  }, [autoRetry, canRetry, isRetrying]);

  const doRetry = useCallback(() => {
    const state = getPreviewState();
    if (!isPreviewError(state.state)) return;

    const retryRequest = state.compileRequest || state.lastCompileRequest;
    if (!retryRequest || !compilerClient || typeof compilerClient.compile !== 'function') {
      return;
    }

    retryCountRef.current += 1;
    setRetryCount(retryCountRef.current);
    setIsRetrying(true);

    transitionPreview(PreviewLifecycleState.COMPILE_REQUESTED, {
      previewId: state.previewId,
    });

    // compile() returns a promise — fire and forget here,
    // lifecycle transitions will be driven by incoming events
    compilerClient.compile(retryRequest).catch((err) => {
      console.warn('[useRetryCompile] retry compile failed:', err);
      setIsRetrying(false);
    });
  }, [compilerClient]);

  const retry = useCallback(() => {
    doRetry();
  }, [doRetry]);

  return { canRetry, retryCount, isRetrying, retry };
}
