// src/components/healing/AIDiffPreview.jsx
// Side-by-side or inline diff preview for an AI-detected fix.
//
// Uses Monaco's built-in diff editor to show exactly what changes
// the AI suggests, so the user can review before applying.

import React, { useEffect, useRef, useCallback } from 'react';

/**
 * @param {Object} props
 * @param {string} props.originalCode  – full file content (or snippet around the fix)
 * @param {string} props.modifiedCode  – content after applying the fix
 * @param {string} [props.language]    – Monaco language id
 * @param {string} [props.title]       – header text
 * @param {boolean} [props.inline]     – use inline diff layout (default: side-by-side)
 * @param {number}  [props.height=260] – container height in px
 * @param {Function} [props.onApply]   – called when user clicks Apply
 * @param {Function} [props.onDismiss] – called when user clicks Dismiss
 */
export function AIDiffPreview({
  originalCode,
  modifiedCode,
  language = 'plaintext',
  title,
  inline = false,
  height = 260,
  onApply,
  onDismiss,
}) {
  const containerRef = useRef(null);
  const editorRef = useRef(null);

  useEffect(() => {
    const monaco = window.monaco || globalThis?.monaco;
    if (!monaco || !containerRef.current) return;

    const originalModel = monaco.editor.createModel(originalCode || '', language);
    const modifiedModel = monaco.editor.createModel(modifiedCode || '', language);

    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      readOnly: true,
      renderSideBySide: !inline,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      renderIndicators: true,
      originalEditable: false,
      padding: { top: 4, bottom: 4 },
    });

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    editorRef.current = { diffEditor, originalModel, modifiedModel };

    return () => {
      diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
  }, [originalCode, modifiedCode, language, inline]);

  return (
    <div className="ai-diff-preview vt-panel-frame overflow-hidden">
      {/* Header */}
      <div className="vt-panel-header justify-between text-xs">
        <span className="vt-panel-title">
          {title || 'AI Fix Preview'}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-2.5 py-1 text-[11px]"
            >
              Dismiss
            </button>
          )}
          {onApply && (
            <button
              onClick={onApply}
              className="th-focus-ring th-btn-primary px-2.5 py-1 text-[11px]"
            >
              Apply Fix
            </button>
          )}
        </span>
      </div>

      {/* Diff editor container */}
      <div ref={containerRef} style={{ height }} />
    </div>
  );
}
