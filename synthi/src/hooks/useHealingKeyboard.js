"use client";

import { useEffect, useCallback } from "react";
import { useDispatch, useSelector } from "react-redux";
import {
  selectHealingEnabled,
  selectPendingFixes,
} from "@/redux/healingSelectors";
import { toggleEnabled } from "@/redux/healingSlice";

/**
 * Hook that registers keyboard shortcuts for the self-healing system.
 *
 * Shortcuts:
 *   Ctrl+Shift+H    — Toggle healing on/off
 *   Ctrl+Shift+A    — Accept all pending safe fixes
 *   Ctrl+Shift+Z    — Undo last healing fix
 *   Ctrl+Shift+B    — Run batch healing on workspace
 *
 * @param {Object} options
 * @param {Function} options.onAcceptAll — called when user accepts all fixes
 * @param {Function} options.onUndoLast — called when user undoes last fix
 * @param {Function} options.onRunBatch — called when user runs batch healing
 */
export function useHealingKeyboard({ onAcceptAll, onUndoLast, onRunBatch } = {}) {
  const dispatch = useDispatch();
  const enabled = useSelector(selectHealingEnabled);
  const pendingFixes = useSelector(selectPendingFixes);

  const handleKeyDown = useCallback(
    (e) => {
      // All shortcuts require Ctrl+Shift
      if (!e.ctrlKey || !e.shiftKey) return;

      switch (e.key.toUpperCase()) {
        case "H":
          e.preventDefault();
          dispatch(toggleEnabled());
          break;

        case "A":
          if (pendingFixes?.length > 0 && onAcceptAll) {
            e.preventDefault();
            onAcceptAll();
          }
          break;

        case "Z":
          if (onUndoLast) {
            e.preventDefault();
            onUndoLast();
          }
          break;

        case "B":
          if (onRunBatch) {
            e.preventDefault();
            onRunBatch();
          }
          break;

        default:
          break;
      }
    },
    [dispatch, pendingFixes, onAcceptAll, onUndoLast, onRunBatch]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return {
    enabled,
    shortcuts: [
      { key: "Ctrl+Shift+H", action: "Toggle healing" },
      { key: "Ctrl+Shift+A", action: "Accept all fixes" },
      { key: "Ctrl+Shift+Z", action: "Undo last fix" },
      { key: "Ctrl+Shift+B", action: "Batch heal workspace" },
    ],
  };
}
