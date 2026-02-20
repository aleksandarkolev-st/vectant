'use client';

/**
 * @fileoverview Layout undo/redo system.
 *
 * Maintains a history stack of layout snapshots so users can
 * undo accidental panel moves, splits, or closes.
 *
 * Uses a ring buffer with configurable max history size (default 30)
 * to keep memory bounded.
 *
 * Keyboard: Ctrl+Z (undo layout), Ctrl+Shift+Z (redo layout)
 * These only fire when the docking system is focused, not when
 * a Monaco editor or text input has focus.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { setLayout, selectLayout } from '../state/layout-slice';

// ────────────────────────────────────────────────────────
//  History buffer
// ────────────────────────────────────────────────────────

/**
 * Create a bounded history buffer.
 * @param {number} maxSize
 */
function createHistoryBuffer(maxSize = 30) {
  return {
    past: [],
    future: [],
    maxSize,
  };
}

/**
 * Push a snapshot to the history buffer.
 * Clears the redo (future) stack.
 */
function pushState(buffer, snapshot) {
  buffer.past.push(snapshot);
  if (buffer.past.length > buffer.maxSize) {
    buffer.past.shift(); // Drop oldest
  }
  buffer.future = []; // Clear redo stack on new action
}

function canUndo(buffer) {
  return buffer.past.length > 0;
}

function canRedo(buffer) {
  return buffer.future.length > 0;
}

/**
 * Undo: pop from past, push current to future.
 * @returns {Object | null} the snapshot to restore
 */
function undo(buffer, current) {
  if (!canUndo(buffer)) return null;
  const prev = buffer.past.pop();
  buffer.future.push(current);
  return prev;
}

/**
 * Redo: pop from future, push current to past.
 * @returns {Object | null} the snapshot to restore
 */
function redo(buffer, current) {
  if (!canRedo(buffer)) return null;
  const next = buffer.future.pop();
  buffer.past.push(current);
  return next;
}

// ────────────────────────────────────────────────────────
//  Hook
// ────────────────────────────────────────────────────────

/**
 * Layout undo/redo hook.
 *
 * @param {Object} options
 * @param {number} [options.maxHistory=30] - Max undo steps
 * @param {boolean} [options.enabled=true]
 * @param {number} [options.debounceMs=500] - Minimum interval between saves
 * @returns {{ canUndo: boolean, canRedo: boolean, undo: () => void, redo: () => void, saveSnapshot: () => void }}
 */
export function useLayoutHistory(options = {}) {
  const { maxHistory = 30, enabled = true, debounceMs = 500 } = options;
  const dispatch = useDispatch();
  const layout = useSelector(selectLayout);

  const bufferRef = useRef(createHistoryBuffer(maxHistory));
  const lastSaveRef = useRef(0);
  const isRestoringRef = useRef(false);
  const currentLayoutRef = useRef(null);
  currentLayoutRef.current = layout;

  /**
   * Save a snapshot of the current layout.
   * Called automatically by the docking system after meaningful actions.
   */
  const saveSnapshot = useCallback(() => {
    if (!enabled || isRestoringRef.current) return;

    const now = Date.now();
    if (now - lastSaveRef.current < debounceMs) return;
    lastSaveRef.current = now;

    const snapshot = JSON.parse(JSON.stringify(currentLayoutRef.current));
    pushState(bufferRef.current, snapshot);
  }, [enabled, debounceMs]);

  const performUndo = useCallback(() => {
    if (!canUndo(bufferRef.current)) return;
    const current = JSON.parse(JSON.stringify(currentLayoutRef.current));
    const prev = undo(bufferRef.current, current);
    if (prev) {
      isRestoringRef.current = true;
      dispatch(setLayout(prev));
      // Allow new saves after a brief delay
      requestAnimationFrame(() => { isRestoringRef.current = false; });
    }
  }, [dispatch]);

  const performRedo = useCallback(() => {
    if (!canRedo(bufferRef.current)) return;
    const current = JSON.parse(JSON.stringify(currentLayoutRef.current));
    const next = redo(bufferRef.current, current);
    if (next) {
      isRestoringRef.current = true;
      dispatch(setLayout(next));
      requestAnimationFrame(() => { isRestoringRef.current = false; });
    }
  }, [dispatch]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    if (!enabled) return;

    const handleKey = (e) => {
      // Don't capture undo/redo when inside text inputs or Monaco
      const active = document.activeElement;
      if (active) {
        const tag = active.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (active.classList.contains('monaco-editor') ||
            active.closest?.('.monaco-editor')) return;
      }

      const isMac = /mac/i.test(navigator.platform || '');
      const ctrl = isMac ? e.metaKey : e.ctrlKey;

      // Ctrl+Z / Cmd+Z → undo layout
      if (ctrl && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        performUndo();
        return;
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z → redo layout
      if (ctrl && e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        performRedo();
        return;
      }
    };

    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [enabled, performUndo, performRedo]);

  // Auto-snapshot on layout change (debounced)
  const debounceTimerRef = useRef(null);
  useEffect(() => {
    if (!enabled || isRestoringRef.current) return;

    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      saveSnapshot();
    }, debounceMs);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, [layout, enabled, debounceMs, saveSnapshot]);

  return {
    canUndo: canUndo(bufferRef.current),
    canRedo: canRedo(bufferRef.current),
    undo: performUndo,
    redo: performRedo,
    saveSnapshot,
  };
}
