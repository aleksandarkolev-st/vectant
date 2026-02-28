// src/hooks/useAIAutoAnalysis.js
// Auto-triggers AI analysis after the user stops typing for a configurable delay.
//
// This makes the AI agent feel proactive — it detects issues in the
// background without requiring the user to press a shortcut.
//
// Usage:
//   useAIAutoAnalysis({
//     editorRef,
//     analyzeCallback: aiHealing.analyze,
//     enabled: true,
//     debounceMs: 3000,  // 3 seconds after last keystroke
//   });

import { useCallback, useEffect, useRef } from 'react';

/**
 * @param {Object}  opts
 * @param {object}  opts.editorRef       – React ref to Monaco editor
 * @param {Function} opts.analyzeCallback – () => Promise — the analyze function to call
 * @param {boolean} [opts.enabled=true]  – master toggle
 * @param {number}  [opts.debounceMs=3000] – milliseconds to wait after last change
 * @param {number}  [opts.minContentLength=20] – skip analysis for tiny files
 * @param {boolean} [opts.skipWhileTyping=true] – reset timer on each keystroke
 */
export function useAIAutoAnalysis({
  editorRef,
  analyzeCallback,
  enabled = true,
  debounceMs = 3000,
  minContentLength = 20,
  skipWhileTyping = true,
} = {}) {
  const timerRef = useRef(null);
  const runningRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const scheduleAnalysis = useCallback(() => {
    if (!enabled || !analyzeCallback) return;
    if (runningRef.current) return;

    // Clear previous timer
    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(async () => {
      if (!mountedRef.current) return;
      if (runningRef.current) return;

      const editor = editorRef?.current;
      if (!editor) return;

      const model = editor.getModel();
      if (!model) return;

      const content = model.getValue();
      if (!content || content.length < minContentLength) return;

      try {
        runningRef.current = true;
        await analyzeCallback();
      } catch {
        // swallow — the analyze function handles its own errors
      } finally {
        runningRef.current = false;
      }
    }, debounceMs);
  }, [enabled, analyzeCallback, editorRef, debounceMs, minContentLength]);

  // Listen for editor content changes
  useEffect(() => {
    if (!enabled) return;

    const editor = editorRef?.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const disposable = model.onDidChangeContent(() => {
      if (skipWhileTyping) {
        scheduleAnalysis();
      }
    });

    return () => disposable?.dispose();
  }, [enabled, editorRef, scheduleAnalysis, skipWhileTyping]);

  // Public: cancel any pending auto-analysis
  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return { cancel, isAutoRunning: runningRef.current };
}
