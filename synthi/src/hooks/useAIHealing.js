// src/hooks/useAIHealing.js
// React hook for AI-powered healing (LLM-based error detection).
//
// Unlike useSelfHealing (regex-based, real-time), this hook provides
// on-demand AI analysis that catches deeper bugs: logic errors,
// null safety, missing awaits, off-by-one, type mismatches, etc.
//
// The hook manages:
//  - Triggering AI analysis (manual or on-save)
//  - Tracking analysis state (loading, results, errors)
//  - Applying/dismissing individual AI-detected fixes
//  - Hybrid mode (regex + AI merged results)
//  - AI agent statistics

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';

import {
  showHealingDecorations,
} from '@/components/healing/healingDecorations';

import {
  selectHealingEnabled,
} from '@/redux/healingSelectors';

import {
  addHealingEvent,
  enqueueToast,
  pushUndo,
} from '@/redux/healingSlice';


/** Simple unique ID generator */
function uid() {
  return `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}


/**
 * @param {Object}  opts
 * @param {object}  opts.editorRef   – React ref to Monaco editor instance
 * @param {object}  opts.gateway     – object from useAnalyzerGateway()
 * @param {string}  opts.filePath    – workspace-relative path
 * @param {string}  opts.language    – language id
 * @param {string}  [opts.workspaceRoot] – workspace root path
 * @param {boolean} [opts.analyzeOnSave=false] – auto-trigger on Ctrl+S
 * @param {string}  [opts.mode='ai'] – 'ai' | 'hybrid'
 */
export function useAIHealing({
  editorRef,
  gateway,
  filePath,
  language,
  workspaceRoot,
  analyzeOnSave = false,
  mode = 'ai',
} = {}) {
  const dispatch = useDispatch();
  const enabled = useSelector(selectHealingEnabled);

  // ── State ───────────────────────────────────────────────────────────
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [fixes, setFixes] = useState([]);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState(null);

  const mountedRef = useRef(true);
  const lastDecoRef = useRef(null);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (lastDecoRef.current) lastDecoRef.current.dispose();
    };
  }, []);

  // Reset when file changes
  useEffect(() => {
    setFixes([]);
    setError(null);
    if (lastDecoRef.current) {
      lastDecoRef.current.dispose();
      lastDecoRef.current = null;
    }
  }, [filePath]);

  // ── Request AI analysis ─────────────────────────────────────────────
  const analyze = useCallback(async (options = {}) => {
    if (!enabled) return null;
    if (!gateway) return null;

    const editor = editorRef?.current;
    if (!editor) return null;

    const model = editor.getModel();
    if (!model) return null;

    const content = model.getValue();
    if (!content?.trim()) return null;

    setIsAnalyzing(true);
    setError(null);

    try {
      const analyzeFn = mode === 'hybrid' ? gateway.aiHybrid : gateway.aiAnalyze;

      if (!analyzeFn) {
        throw new Error(`AI analysis method not available (mode: ${mode})`);
      }

      const result = await analyzeFn({
        code: content,
        lang: language || 'plaintext',
        filePath,
        workspaceRoot,
        autoApply: false,
        validateFixes: options.validateFixes ?? true,
        minConfidence: options.minConfidence,
        focusStartLine: options.focusStartLine,
        focusEndLine: options.focusEndLine,
      });

      if (!mountedRef.current) return null;

      const detectedFixes = result?.fixes || [];
      setFixes(detectedFixes);
      setLastAnalyzedAt(Date.now());

      // Show decorations in the editor
      if (detectedFixes.length > 0) {
        if (lastDecoRef.current) lastDecoRef.current.dispose();

        // Map AI fixes to decoration format
        const decoFixes = detectedFixes.map((fix) => ({
          ...fix,
          startLine: fix.line ?? fix.start_line ?? fix.startLine ?? 0,
          endLine: fix.end_line ?? fix.endLine ?? fix.line ?? 0,
          severity: fix.severity || 'moderate',
          description: fix.description || 'AI-detected issue',
        }));

        lastDecoRef.current = showHealingDecorations(editor, decoFixes);

        dispatch(enqueueToast({
          message: `AI found ${detectedFixes.length} issue${detectedFixes.length === 1 ? '' : 's'}`,
          type: 'info',
        }));
      } else {
        dispatch(enqueueToast({
          message: 'AI analysis: no issues found ✓',
          type: 'success',
        }));
      }

      dispatch(addHealingEvent({
        type: 'ai_analysis_complete',
        filePath,
        details: {
          fixCount: detectedFixes.length,
          mode,
          source: result?.source || 'ai_agent',
        },
      }));

      return result;
    } catch (err) {
      if (!mountedRef.current) return null;

      const message = err?.message || 'AI analysis failed';
      setError(message);

      dispatch(enqueueToast({
        message: `AI analysis error: ${message}`,
        type: 'error',
      }));

      return null;
    } finally {
      if (mountedRef.current) {
        setIsAnalyzing(false);
      }
    }
  }, [enabled, gateway, editorRef, filePath, language, workspaceRoot, mode, dispatch]);

  // ── Apply a single fix ──────────────────────────────────────────────
  const applyFix = useCallback((fix) => {
    const editor = editorRef?.current;
    if (!editor) return false;

    const model = editor.getModel();
    if (!model) return false;

    const monaco = window.monaco || globalThis?.monaco;
    if (!monaco) return false;

    try {
      const startLine = (fix.line ?? fix.start_line ?? 0) + 1;
      const startCol = (fix.column ?? fix.start_col ?? 0) + 1;
      const endLine = (fix.end_line ?? fix.endLine ?? fix.line ?? 0) + 1;
      const endCol = (fix.end_column ?? fix.end_col ?? fix.column ?? 0) + 1;
      const replacement = fix.replacement_text ?? fix.replacementText ?? '';

      if (startLine > model.getLineCount() + 1) return false;

      const range = new monaco.Range(startLine, startCol, endLine, endCol);
      const originalText = model.getValueInRange(range);

      editor.executeEdits('ai-healing', [{
        range,
        text: replacement,
        forceMoveMarkers: true,
      }]);
      editor.pushUndoStop();

      dispatch(pushUndo({
        fixId: fix.fix_id || fix.id || uid(),
        filePath,
        originalText,
        range: { startLine, startCol, endLine, endCol },
      }));

      // Remove the applied fix from the list
      setFixes((prev) => prev.filter((f) => f !== fix));

      dispatch(addHealingEvent({
        type: 'ai_fix_applied',
        filePath,
        details: {
          description: fix.description,
          confidence: fix.confidence,
        },
      }));

      return true;
    } catch (err) {
      console.warn('[AIHealing] applyFix failed:', err);
      return false;
    }
  }, [editorRef, filePath, dispatch]);

  // ── Apply all safe fixes ────────────────────────────────────────────
  const applyAllSafe = useCallback(() => {
    const safeFixes = fixes.filter((f) => f.is_safe || f.isSafe);
    let applied = 0;

    // Apply in reverse order to preserve line numbers
    const sorted = [...safeFixes].sort((a, b) => {
      const lineA = a.line ?? a.start_line ?? 0;
      const lineB = b.line ?? b.start_line ?? 0;
      return lineB - lineA;
    });

    for (const fix of sorted) {
      if (applyFix(fix)) applied++;
    }

    if (applied > 0) {
      dispatch(enqueueToast({
        message: `Applied ${applied} safe AI fix${applied === 1 ? '' : 'es'}`,
        type: 'success',
      }));
    }

    return applied;
  }, [fixes, applyFix, dispatch]);

  // ── Dismiss a fix ───────────────────────────────────────────────────
  const dismissFix = useCallback((fix) => {
    setFixes((prev) => prev.filter((f) => f !== fix));
  }, []);

  // ── Dismiss all ─────────────────────────────────────────────────────
  const dismissAll = useCallback(() => {
    setFixes([]);
    if (lastDecoRef.current) {
      lastDecoRef.current.dispose();
      lastDecoRef.current = null;
    }
  }, []);

  // ── Fetch stats ─────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    if (!gateway?.aiStats) return null;
    try {
      const result = await gateway.aiStats();
      if (mountedRef.current) setStats(result);
      return result;
    } catch {
      return null;
    }
  }, [gateway]);

  // ── Auto-analyze on save ────────────────────────────────────────────
  useEffect(() => {
    if (!analyzeOnSave || !enabled) return;

    const editor = editorRef?.current;
    if (!editor) return;

    // Listen for Ctrl+S / Cmd+S
    const disposable = editor.onKeyDown((e) => {
      const isSave = (e.ctrlKey || e.metaKey) && e.keyCode === 49; // KeyS
      if (isSave && !isAnalyzing) {
        // Delay slightly so the save completes first
        setTimeout(() => analyze(), 100);
      }
    });

    return () => disposable?.dispose();
  }, [analyzeOnSave, enabled, editorRef, isAnalyzing, analyze]);

  return {
    // State
    isAnalyzing,
    fixes,
    error,
    stats,
    lastAnalyzedAt,
    fixCount: fixes.length,
    safeFixCount: fixes.filter((f) => f.is_safe || f.isSafe).length,

    // Actions
    analyze,
    applyFix,
    applyAllSafe,
    dismissFix,
    dismissAll,
    fetchStats,
  };
}
