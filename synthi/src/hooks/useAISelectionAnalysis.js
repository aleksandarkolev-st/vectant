// src/hooks/useAISelectionAnalysis.js
// Hook that lets users select code in Monaco, right-click or use
// a keyboard shortcut, and run AI analysis only on the selection.
//
// This is faster and cheaper than analyzing the entire file because:
// 1. The LLM prompt is smaller (fewer tokens).
// 2. The LLM can focus on the specific code the user is concerned about.
// 3. It avoids noise from unrelated parts of the file.
'use client';

import { useCallback, useRef } from 'react';


/**
 * @param {Object}  opts
 * @param {Object}  opts.aiHealing  – return value of useAIHealing()
 * @param {Object}  opts.editorRef  – React ref to Monaco editor instance
 */
export function useAISelectionAnalysis({ aiHealing, editorRef } = {}) {
  const lastSelectionRef = useRef(null);

  /**
   * Analyze only the currently selected text in the editor.
   * Falls back to full-file analysis if no selection.
   */
  const analyzeSelection = useCallback(() => {
    const editor = editorRef?.current;
    if (!editor || !aiHealing?.analyze) return null;

    const selection = editor.getSelection();
    if (!selection || selection.isEmpty()) {
      // No selection — fall back to full file
      return aiHealing.analyze();
    }

    const startLine = selection.startLineNumber;
    const endLine = selection.endLineNumber;

    lastSelectionRef.current = { startLine, endLine };

    // Analyze with focus range (0-indexed in backend, 1-indexed in Monaco)
    return aiHealing.analyze({
      focusStartLine: startLine - 1,
      focusEndLine: endLine - 1,
    });
  }, [aiHealing, editorRef]);

  /**
   * Register a Monaco context menu action for selection analysis.
   * Call this once after the editor mounts.
   *
   * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
   * @returns {import('monaco-editor').IDisposable}
   */
  const registerContextMenu = useCallback((editor) => {
    if (!editor) return null;

    const monaco = window.monaco || globalThis?.monaco;
    if (!monaco) return null;

    return editor.addAction({
      id: 'ai-healing.analyze-selection',
      label: 'AI: Analyze Selection',
      keybindings: [
        // Ctrl+Shift+I (same as full-file, but auto-detects selection)
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyI,
      ],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1.5,
      precondition: 'editorHasSelection',
      run: () => analyzeSelection(),
    });
  }, [analyzeSelection]);

  return {
    analyzeSelection,
    registerContextMenu,
    lastSelection: lastSelectionRef.current,
  };
}
