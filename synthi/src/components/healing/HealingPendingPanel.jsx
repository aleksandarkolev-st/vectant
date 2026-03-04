// src/components/healing/HealingPendingPanel.jsx
// Confirmation panel shown when requireConfirmation is enabled.
// Displays pending fixes and lets the user approve/reject each one.
'use client';

import { useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectPendingFixes,
  selectHealingEnabled,
} from '@/redux/healingSelectors';
import {
  removePendingFix,
  clearPendingFixes,
  recordSkippedFix,
  recordAppliedFix,
  pushUndo,
  addHealingEvent,
  enqueueToast,
} from '@/redux/healingSlice';
import { Check, X, CheckCheck, Trash2 } from 'lucide-react';

// Category → human label (subset)
const CAT_LABEL = {
  missing_colon: 'Missing colon',
  missing_semicolon: 'Missing semicolon',
  missing_bracket: 'Missing bracket',
  unused_import: 'Unused import',
  missing_import: 'Missing import',
  duplicate_import: 'Duplicate import',
  trailing_whitespace: 'Trailing whitespace',
  missing_newline_eof: 'Missing newline at EOF',
  none_comparison: 'None comparison',
  unclosed_string: 'Unclosed string',
  missing_include: 'Missing #include',
};

function formatCat(cat) {
  return CAT_LABEL[cat] || cat?.replace(/_/g, ' ') || 'Issue';
}

/**
 * @param {Object} props
 * @param {React.RefObject} props.editorRef – ref to Monaco editor
 */
export function HealingPendingPanel({ editorRef }) {
  const dispatch = useDispatch();
  const enabled = useSelector(selectHealingEnabled);
  const pendingFixes = useSelector(selectPendingFixes);

  const fixList = useMemo(
    () => (pendingFixes || []).slice(0, 20),
    [pendingFixes]
  );

  // Apply a single fix
  const handleApply = useCallback(
    (fix) => {
      const editor = editorRef?.current;
      if (!editor) return;

      const model = editor.getModel();
      if (!model) return;

      const monaco = window.monaco || globalThis?.monaco;
      if (!monaco) return;

      try {
        const startLine = (fix.start_line ?? fix.startLine ?? 0) + 1;
        const startCol = (fix.start_col ?? fix.startCol ?? 0) + 1;
        const endLine = (fix.end_line ?? fix.endLine ?? fix.start_line ?? fix.startLine ?? 0) + 1;
        const endCol = (fix.end_col ?? fix.endCol ?? fix.end_column ?? fix.endColumn ?? fix.start_col ?? fix.startCol ?? 0) + 1;
        const replacementText = fix.replacement_text ?? fix.replacementText ?? '';

        const range = new monaco.Range(startLine, startCol, endLine, endCol);
        const originalText = model.getValueInRange(range);

        editor.executeEdits('self-healing-confirm', [
          { range, text: replacementText, forceMoveMarkers: true },
        ]);
        editor.pushUndoStop();

        dispatch(pushUndo({
          fixId: fix.id,
          filePath: fix.filePath,
          originalText,
          range: { startLine, startCol, endLine, endCol },
        }));
        dispatch(recordAppliedFix({
          ...fix,
          language: fix.language || 'unknown',
        }));
        dispatch(addHealingEvent({ type: 'fix_confirmed', fixId: fix.id, filePath: fix.filePath }));
      } catch (err) {
        console.warn('[HealingPending] apply failed:', err);
      }
    },
    [editorRef, dispatch]
  );

  // Skip a single fix
  const handleSkip = useCallback(
    (fix) => {
      dispatch(recordSkippedFix({ id: fix.id, category: fix.category }));
      dispatch(addHealingEvent({ type: 'fix_rejected', fixId: fix.id }));
    },
    [dispatch]
  );

  // Apply all pending fixes
  const handleApplyAll = useCallback(() => {
    for (const fix of fixList) {
      handleApply(fix);
    }
    dispatch(
      enqueueToast({
        type: 'healing',
        message: `Applied ${fixList.length} fix${fixList.length === 1 ? '' : 'es'}`,
        undoable: true,
      })
    );
  }, [fixList, handleApply, dispatch]);

  // Dismiss all
  const handleDismissAll = useCallback(() => {
    for (const fix of fixList) {
      dispatch(recordSkippedFix({ id: fix.id, category: fix.category }));
    }
    dispatch(clearPendingFixes());
  }, [fixList, dispatch]);

  if (!enabled || fixList.length === 0) return null;

  return (
    <div
      className="flex flex-col border-t max-h-48 overflow-y-auto"
      style={{
        borderColor: 'var(--border-subtle)',
        background: 'var(--bg-panel)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 text-xs font-semibold"
        style={{ color: 'var(--text-muted)', background: 'var(--bg-elevated)' }}
      >
        <span>🩹 Pending Fixes ({fixList.length})</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleApplyAll}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80"
            style={{ color: 'var(--accent-success)' }}
            title="Apply all"
          >
            <CheckCheck className="w-3 h-3" /> All
          </button>
          <button
            onClick={handleDismissAll}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-muted)' }}
            title="Dismiss all"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Fix list */}
      {fixList.map((fix) => (
        <div
          key={fix.id}
          className="flex items-center justify-between px-3 py-1 text-xs hover:opacity-90 transition-opacity"
          style={{ borderBottom: '1px solid var(--border-subtle)' }}
        >
          <div className="flex-1 min-w-0">
            <div className="truncate" style={{ color: 'var(--text-primary)' }}>
              {formatCat(fix.category)}
            </div>
            {fix.description && (
              <div
                className="truncate text-[10px]"
                style={{ color: 'var(--text-dim)' }}
              >
                {fix.description}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 ml-2 flex-shrink-0">
            <span
              className="text-[10px] font-mono"
              style={{ color: 'var(--text-dim)' }}
            >
              {((fix.confidence ?? 0) * 100).toFixed(0)}%
            </span>
            <button
              onClick={() => handleApply(fix)}
              className="p-0.5 rounded hover:opacity-80"
              style={{ color: 'var(--accent-success)' }}
              title="Apply this fix"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => handleSkip(fix)}
              className="p-0.5 rounded hover:opacity-80"
              style={{ color: 'var(--text-muted)' }}
              title="Skip this fix"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export default HealingPendingPanel;
