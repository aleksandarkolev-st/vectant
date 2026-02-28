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
    <div className="ai-diff-preview" style={{ border: '1px solid var(--border, #333)', borderRadius: 6, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 10px',
        background: 'var(--bg-secondary, #1e1e1e)',
        borderBottom: '1px solid var(--border, #333)',
        fontSize: 12,
      }}>
        <span style={{ fontWeight: 600, opacity: 0.8 }}>
          {title || 'AI Fix Preview'}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          {onDismiss && (
            <button
              onClick={onDismiss}
              style={{
                background: 'transparent',
                border: '1px solid #666',
                color: '#ccc',
                padding: '2px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Dismiss
            </button>
          )}
          {onApply && (
            <button
              onClick={onApply}
              style={{
                background: '#238636',
                border: 'none',
                color: '#fff',
                padding: '2px 10px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 11,
              }}
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
