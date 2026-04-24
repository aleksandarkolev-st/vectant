// src/hooks/usePendingFixCodeActions.js
// Hook that exposes self-healing "suggest"-bucket fixes as Monaco
// lightbulb quick-fixes for the active file.
//
// When the rule engine routes a fix to `suggest`, it lands in
// state.healing.pendingFixes.  This hook watches that state and
// re-registers a Monaco CodeActionProvider whenever the list for the
// active file changes.  Accepting a lightbulb action applies the text
// edit AND dispatches removePendingFix so the bulb disappears.

import { useEffect, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { makeSelectPendingFixesForFile } from '@/redux/healingSelectors';
import {
  removePendingFix,
  recordAppliedFix,
  recordSuggestionAccepted,
} from '@/redux/healingSlice';
import {
  registerPendingFixCodeActions,
  disposePendingFixCodeActions,
} from '@/components/healing/pendingFixCodeActions';

/**
 * @param {Object} opts
 * @param {Object} opts.editorRef – ref to Monaco editor
 * @param {string} opts.filePath  – active file path
 * @param {string} [opts.language] – for stats/recordAppliedFix
 * @param {boolean} [opts.active=true] – disable when there's no editor yet
 */
export function usePendingFixCodeActions({
  editorRef,
  filePath,
  language,
  active = true,
} = {}) {
  const dispatch = useDispatch();

  // Memoise the selector factory per filePath so react-redux doesn't
  // re-subscribe on every render.
  const selectForFile = useMemo(
    () => makeSelectPendingFixesForFile(filePath),
    [filePath]
  );
  const fixes = useSelector(selectForFile);

  useEffect(() => {
    const editor = editorRef?.current;
    if (!editor || !active) return;

    const { dispose } = registerPendingFixCodeActions(editor, fixes, {
      onAccept: (fixId) => {
        const applied = fixes.find((f) => f.id === fixId);
        if (applied) {
          dispatch(recordAppliedFix({
            id: applied.id,
            filePath,
            category: applied.category,
            language: language || 'unknown',
            description: applied.description || applied.category,
            confidence: applied.confidence,
            replacementText: applied.replacementText,
            source: 'suggest_accepted',
          }));
          // Feed the smart-rule-suggestion heuristic: after N accepts of
          // the same category, propose auto-applying it by default.
          if (applied.category) {
            dispatch(recordSuggestionAccepted(applied.category));
          }
        }
        dispatch(removePendingFix(fixId));
      },
    });

    return () => {
      dispose?.();
      disposePendingFixCodeActions();
    };
  }, [editorRef, active, fixes, filePath, language, dispatch]);
}

export default usePendingFixCodeActions;
