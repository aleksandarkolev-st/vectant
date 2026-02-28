/**
 * useRuntimeHealing — React hook for HMR runtime healing.
 * 
 * Wires the RuntimeErrorInterceptor singleton into React component
 * lifecycle. Provides reactive state for UI components to show
 * healing status, progress, and results.
 * 
 * Usage:
 *   const { status, attempt, maxAttempts, lastResult, isHealing, toggleAutoHeal }
 *     = useRuntimeHealing({ editorRef, gateway });
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { getRuntimeErrorInterceptor } from '@/services/runtimeErrorInterceptor';

/**
 * @param {Object} opts
 * @param {React.RefObject} opts.editorRef — ref to the Monaco editor instance
 * @param {import('@/services/analyzerGatewayClient').AnalyzerGatewayClient} opts.gateway
 * @param {boolean} [opts.autoHeal=true] — auto-heal on compile errors
 * @param {boolean} [opts.enabled=true] — enable/disable the hook
 * @returns {Object} Reactive healing state + controls
 */
export function useRuntimeHealing({
  editorRef,
  gateway,
  autoHeal = true,
  enabled = true,
} = {}) {
  const interceptor = useMemo(() => getRuntimeErrorInterceptor(), []);
  const [state, setState] = useState(() => interceptor.getState());
  const initializedRef = useRef(false);

  // Initialize the interceptor with dependencies
  useEffect(() => {
    if (!gateway || !editorRef) return;

    interceptor.init({
      gateway,
      getEditor: () => editorRef.current,
      autoHeal,
    });
    initializedRef.current = true;
  }, [interceptor, gateway, editorRef, autoHeal]);

  // Start/stop based on enabled flag
  useEffect(() => {
    if (!initializedRef.current) return;

    if (enabled) {
      interceptor.start();
    } else {
      interceptor.stop();
    }

    return () => {
      interceptor.stop();
    };
  }, [interceptor, enabled]);

  // Subscribe to state changes
  useEffect(() => {
    const unsubscribe = interceptor.subscribe((newState) => {
      setState({ ...newState });
    });
    return unsubscribe;
  }, [interceptor]);

  // Sync autoHeal setting
  useEffect(() => {
    interceptor.autoHeal = autoHeal;
  }, [interceptor, autoHeal]);

  // ── Controls ─────────────────────────────────────────────────────

  const toggleAutoHeal = useCallback(() => {
    interceptor.autoHeal = !interceptor.autoHeal;
    // Force re-render
    setState(prev => ({ ...prev }));
  }, [interceptor]);

  const resetAttempts = useCallback((filePath) => {
    interceptor.resetAttempts(filePath);
    setState(prev => ({ ...prev, attempt: 0 }));
  }, [interceptor]);

  const stop = useCallback(() => {
    interceptor.stop();
    setState(prev => ({ ...prev, status: 'idle' }));
  }, [interceptor]);

  // ── Derived state ────────────────────────────────────────────────

  const isHealing = state.status === 'healing' || state.status === 'applying' || state.status === 'retrying';
  const isSuccess = state.status === 'success';
  const isError = state.status === 'error';
  const canHeal = enabled && initializedRef.current && !isHealing;

  return {
    // Core state
    status: state.status,
    filePath: state.filePath,
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    lastResult: state.lastResult,
    lastError: state.lastError,
    
    // Derived
    isHealing,
    isSuccess,
    isError,
    canHeal,
    isAutoHeal: interceptor.autoHeal,
    isEnabled: interceptor.enabled,
    
    // Controls
    toggleAutoHeal,
    resetAttempts,
    stop,
  };
}

export default useRuntimeHealing;
