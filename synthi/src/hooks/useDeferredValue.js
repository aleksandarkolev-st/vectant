// src/hooks/useDeferredValue.js
// React 18/19 Concurrent Rendering helpers for zero-latency typing.
//
// These hooks ensure that non-critical UI updates (file tree decorators,
// status bar counters, git diffs) are scheduled at a lower priority than
// the Monaco editor's keystroke → model → render loop.
//
// Usage:
//   const deferredDiagnostics = useDeferredSelector(selectDiagnostics);
//   const transitionDispatch = useTransitionDispatch();

import { useCallback, useDeferredValue, useTransition, useMemo, useRef, useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';

/**
 * useDeferredSelector — reads a Redux selector but defers the value
 * through React's concurrent lane so re-renders from this state
 * never block high-priority work (typing, scrolling).
 *
 * @param {Function} selector  Redux selector
 * @param {Function} [equalityFn]  Optional equality function
 * @returns  The deferred value from the selector
 */
export function useDeferredSelector(selector, equalityFn) {
  const liveValue = useSelector(selector, equalityFn);
  return useDeferredValue(liveValue);
}

/**
 * useTransitionDispatch — wraps Redux dispatch in startTransition
 * so dispatched actions trigger renders in the transition lane.
 *
 * Call `transitionDispatch(action)` for any non-critical update:
 *   • Git status refresh
 *   • File tree decoration updates
 *   • Diagnostic summary recalculation
 *   • Extension status bar items
 *
 * @returns {{ transitionDispatch: Function, isPending: boolean }}
 */
export function useTransitionDispatch() {
  const dispatch = useDispatch();
  const [isPending, startTransition] = useTransition();

  const transitionDispatch = useCallback(
    (action) => {
      startTransition(() => {
        dispatch(action);
      });
    },
    [dispatch, startTransition],
  );

  return { transitionDispatch, isPending };
}

/**
 * useLowPriorityState — useState variant where set triggers a transition.
 * Perfect for computed summaries (diagnostic counts, word counts, etc.)
 * that should never block the editor repaint.
 *
 * @param {*} initialValue
 * @returns {[value, setValueInTransition, isPending]}
 */
export function useLowPriorityState(initialValue) {
  const [value, setValue] = useState(initialValue);
  const deferred = useDeferredValue(value);
  const [isPending, startTransition] = useTransition();

  const setLow = useCallback(
    (next) => {
      startTransition(() => {
        setValue(next);
      });
    },
    [startTransition],
  );

  return [deferred, setLow, isPending];
}

/**
 * useIdleCallback — schedules a callback via requestIdleCallback
 * (with rAF fallback) so truly expensive work only runs when the
 * browser is idle. Automatically cleans up on unmount.
 *
 * @param {Function} callback
 * @param {Object} [options]
 * @param {number} [options.timeout]  Maximum ms before forcing execution
 */
export function useIdleCallback(callback, { timeout = 2000 } = {}) {
  const cbRef = useRef(callback);
  cbRef.current = callback;

  const schedule = useCallback(() => {
    const ric =
      typeof requestIdleCallback === 'function'
        ? requestIdleCallback
        : (fn) => setTimeout(fn, 1);
    const cic =
      typeof cancelIdleCallback === 'function'
        ? cancelIdleCallback
        : clearTimeout;

    const id = ric(() => cbRef.current(), { timeout });
    return () => cic(id);
  }, [timeout]);

  return schedule;
}
