/**
 * @fileoverview Hook for auto-persisting layout state to localStorage.
 * Debounced to avoid excessive writes.
 */

'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { selectLayout, setLayout } from '../state/layout-slice';
import {
  saveLayoutToStorage,
  loadLayoutFromStorage,
  clearLayoutFromStorage,
  serializeLayout,
} from '../utils/serialization';

/**
 * Hook that persists layout state to localStorage with debouncing.
 *
 * @param {Object} options
 * @param {string} options.workspaceSlug - unique workspace identifier
 * @param {number} [options.debounceMs] - debounce delay (default 500ms)
 * @param {boolean} [options.enabled] - enable/disable persistence (default true)
 * @returns {{ save: function, load: function, clear: function, isLoaded: boolean }}
 */
export function useLayoutPersistence({
  workspaceSlug,
  debounceMs = 500,
  enabled = true,
}) {
  const dispatch = useDispatch();
  const layout = useSelector(selectLayout);
  const timerRef = useRef(null);
  const isLoadedRef = useRef(false);
  const previousLayoutRef = useRef(null);

  // ── Auto-save on state change (debounced) ──────────

  useEffect(() => {
    if (!enabled || !workspaceSlug) return;
    if (!isLoadedRef.current) return; // Don't save until initial load

    // Quick equality check to avoid unnecessary saves
    const serialized = JSON.stringify(serializeLayout(layout));
    if (serialized === previousLayoutRef.current) return;
    previousLayoutRef.current = serialized;

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      saveLayoutToStorage(workspaceSlug, layout);
    }, debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [layout, workspaceSlug, debounceMs, enabled]);

  // ── Load on mount ──────────────────────────────────

  useEffect(() => {
    if (!enabled || !workspaceSlug) return;

    const saved = loadLayoutFromStorage(workspaceSlug);
    if (saved) {
      dispatch(setLayout(saved));
      previousLayoutRef.current = JSON.stringify(serializeLayout(saved));
    }
    isLoadedRef.current = true;
  }, [workspaceSlug, enabled, dispatch]);

  // ── Manual controls ────────────────────────────────

  const save = useCallback(() => {
    if (!workspaceSlug) return;
    saveLayoutToStorage(workspaceSlug, layout);
    previousLayoutRef.current = JSON.stringify(serializeLayout(layout));
  }, [workspaceSlug, layout]);

  const load = useCallback(() => {
    if (!workspaceSlug) return null;
    const saved = loadLayoutFromStorage(workspaceSlug);
    if (saved) {
      dispatch(setLayout(saved));
    }
    return saved;
  }, [workspaceSlug, dispatch]);

  const clear = useCallback(() => {
    if (!workspaceSlug) return;
    clearLayoutFromStorage(workspaceSlug);
  }, [workspaceSlug]);

  // ── Save on page unload ────────────────────────────

  useEffect(() => {
    if (!enabled || !workspaceSlug) return;

    const handleBeforeUnload = () => {
      // Synchronous save on unload
      saveLayoutToStorage(workspaceSlug, layout);
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [enabled, workspaceSlug, layout]);

  return {
    save,
    load,
    clear,
    isLoaded: isLoadedRef.current,
  };
}

export default useLayoutPersistence;
