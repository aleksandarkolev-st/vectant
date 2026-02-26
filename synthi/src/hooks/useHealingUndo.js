// src/hooks/useHealingUndo.js
// Hook for undoing self-healing fixes.  Works in tandem with the
// useSelfHealing hook and the healingSlice undo stack.

import { useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectCanUndo,
  selectTopUndo,
  selectUndoStack,
} from '@/redux/healingSelectors';
import {
  popUndo,
  recordUndone,
  addHealingEvent,
  enqueueToast,
} from '@/redux/healingSlice';

/**
 * @param {Object} opts
 * @param {React.RefObject} opts.editorRef – ref to the Monaco editor instance
 */
export function useHealingUndo({ editorRef } = {}) {
  const dispatch = useDispatch();
  const canUndo = useSelector(selectCanUndo);
  const topUndo = useSelector(selectTopUndo);
  const undoStack = useSelector(selectUndoStack);

  /**
   * Undo the most recently applied healing fix by restoring the
   * original text at the recorded range.
   *
   * @returns {boolean} Whether the undo succeeded
   */
  const undoLastFix = useCallback(() => {
    if (!canUndo || !topUndo) return false;

    const editor = editorRef?.current;
    if (!editor) return false;

    const model = editor.getModel();
    if (!model) return false;

    const monaco =
      window.monaco || (typeof globalThis !== 'undefined' && globalThis.monaco);
    if (!monaco) return false;

    try {
      const { originalText, range, fixId } = topUndo;
      const { startLine, startCol, endLine, endCol } = range;

      // We need to figure out the current end position since the fix
      // may have changed the text length.  Use a heuristic:
      // the replacement text length tells us how far past startCol the
      // current content extends.
      // For safety, just use Monaco's built-in undo which is more reliable.

      // Strategy: Use Monaco's native undo (Ctrl+Z equivalent)
      // This is the safest approach because pushUndoStop was called
      // after each fix.
      editor.trigger('self-healing-undo', 'undo', null);

      // Pop from our tracking stack
      dispatch(popUndo());
      dispatch(recordUndone());
      dispatch(
        addHealingEvent({
          type: 'fix_undone',
          fixId,
          filePath: topUndo.filePath,
        })
      );

      return true;
    } catch (err) {
      console.warn('[HealingUndo] Failed to undo fix:', err);
      return false;
    }
  }, [canUndo, topUndo, editorRef, dispatch]);

  /**
   * Undo all healing fixes in the current stack (bulk undo).
   * Processes the stack from top (most recent) to bottom.
   *
   * @returns {number} Number of fixes successfully undone
   */
  const undoAllFixes = useCallback(() => {
    const editor = editorRef?.current;
    if (!editor || !canUndo) return 0;

    const monaco =
      window.monaco || (typeof globalThis !== 'undefined' && globalThis.monaco);
    if (!monaco) return 0;

    let count = 0;
    const stackLen = undoStack.length;

    for (let i = 0; i < stackLen; i++) {
      try {
        editor.trigger('self-healing-undo', 'undo', null);
        dispatch(popUndo());
        dispatch(recordUndone());
        count++;
      } catch {
        break;
      }
    }

    if (count > 0) {
      dispatch(
        addHealingEvent({
          type: 'bulk_undo',
          count,
        })
      );
      dispatch(
        enqueueToast({
          type: 'healing-undo',
          message: `Reverted ${count} healing fix${count === 1 ? '' : 'es'}`,
        })
      );
    }

    return count;
  }, [editorRef, canUndo, undoStack, dispatch]);

  return {
    canUndo,
    topUndo,
    undoStack,
    undoLastFix,
    undoAllFixes,
  };
}

export default useHealingUndo;
