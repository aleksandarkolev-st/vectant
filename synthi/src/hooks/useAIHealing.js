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
  createAIInlineWidgets,
  disposeAIInlineWidgets,
  setAIDiagnostics,
  clearAIDiagnostics,
  registerAICodeActions,
  disposeAICodeActions,
  registerAIHoverProvider,
  disposeAIHoverProvider,
  notifyAIFixes,
} from '@/components/healing';

import {
  selectHealingEnabled,
} from '@/redux/healingSelectors';

import {
  addHealingEvent,
  enqueueToast,
  pushUndo,
} from '@/redux/healingSlice';

import { aiFixHistory } from '@/services/aiFixHistory';
import { aiSuppressedRules, computeFingerprint } from '@/services/aiSuppressedRules';


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
  const [suppressedCount, setSuppressedCount] = useState(0);
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState(null);

  const mountedRef = useRef(true);
  const lastDecoRef = useRef(null);
  const inlineWidgetRef = useRef(null);
  const codeActionsRef = useRef(null);
  const hoverProviderRef = useRef(null);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (lastDecoRef.current) lastDecoRef.current.dispose();
      disposeAIInlineWidgets(editorRef?.current);
      disposeAICodeActions();
      disposeAIHoverProvider(hoverProviderRef.current);
      hoverProviderRef.current = null;
      const model = editorRef?.current?.getModel?.();
      if (model) clearAIDiagnostics(model);
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
    disposeAIInlineWidgets(editorRef?.current);
    disposeAICodeActions();
    disposeAIHoverProvider(hoverProviderRef.current);
    hoverProviderRef.current = null;
    const model = editorRef?.current?.getModel?.();
    if (model) clearAIDiagnostics(model);
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

      const rawFixes = result?.fixes || [];
      const { visible: detectedFixes, suppressedCount: suppressed } = aiSuppressedRules.filterFixes(rawFixes);
      setFixes(detectedFixes);
      setSuppressedCount(suppressed);
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

        // ── Inline widgets (clickable hints at each line) ─────────
        disposeAIInlineWidgets(editor);
        createAIInlineWidgets(editor, detectedFixes, {
          onApply: (fix) => applyFix(fix),
          onDismiss: (fix) => dismissFixInternal(fix),
        });

        // ── Monaco diagnostics (squiggly underlines) ──────────────
        if (model) {
          setAIDiagnostics(model, detectedFixes);
        }

        // ── Code actions (lightbulb / Ctrl+. quick-fix) ───────────
        disposeAICodeActions();
        codeActionsRef.current = registerAICodeActions(
          editor,
          detectedFixes,
          { onApply: (fix) => applyFix(fix) },
        );

        // ── Hover provider (rich tooltip on hover) ────────────────
        if (hoverProviderRef.current) {
          hoverProviderRef.current.updateFixes(detectedFixes);
        } else {
          const monaco = (await import('monaco-editor')).default ?? await import('monaco-editor');
          hoverProviderRef.current = registerAIHoverProvider(monaco, detectedFixes);
        }

        dispatch(enqueueToast({
          message: `AI found ${detectedFixes.length} issue${detectedFixes.length === 1 ? '' : 's'}`,
          type: 'info',
        }));

        // Notify for high/critical severity
        notifyAIFixes(detectedFixes, {
          flash: editor?.getDomNode?.() ?? null,
        });
      } else {
        // Clear any stale markers
        if (model) clearAIDiagnostics(model);
        disposeAIInlineWidgets(editor);
        disposeAICodeActions();
        if (hoverProviderRef.current) {
          hoverProviderRef.current.updateFixes([]);
        }

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

  // ── Streaming analysis (progressive fix delivery) ───────────────────
  const streamAnalyze = useCallback(async (options = {}) => {
    if (!enabled || !gateway?.aiStream) return null;

    const editor = editorRef?.current;
    if (!editor) return null;

    const model = editor.getModel();
    if (!model) return null;

    const content = model.getValue();
    if (!content?.trim()) return null;

    setIsAnalyzing(true);
    setError(null);
    setFixes([]);

    // Accumulate fixes as they arrive
    const accumulated = [];

    try {
      await gateway.aiStream(
        {
          code: content,
          lang: language || 'plaintext',
          filePath,
          workspaceRoot,
          validateFixes: options.validateFixes ?? true,
          minConfidence: options.minConfidence,
        },
        {
          onProgress: (data) => {
            // Optional: could show a progress bar
          },
          onPartialFix: (data) => {
            if (!mountedRef.current) return;
            const fix = data?.fix || data;
            if (!fix) return;
            accumulated.push(fix);
            // Show raw count during stream — filter only on complete
            setFixes([...accumulated]);
          },
          onComplete: (data) => {
            if (!mountedRef.current) return;
            const rawFinal = data?.fixes || accumulated;
            const { visible: finalFixes, suppressedCount: suppressed } = aiSuppressedRules.filterFixes(rawFinal);
            setFixes(finalFixes);
            setSuppressedCount(suppressed);
            setLastAnalyzedAt(Date.now());

            dispatch(enqueueToast({
              message: finalFixes.length
                ? `AI found ${finalFixes.length} issue${finalFixes.length === 1 ? '' : 's'} (streamed)`
                : 'AI analysis: no issues found ✓',
              type: finalFixes.length ? 'info' : 'success',
            }));
          },
          onError: (data) => {
            if (!mountedRef.current) return;
            setError(data?.message || 'Stream error');
          },
        },
      );
    } catch (err) {
      if (mountedRef.current) {
        setError(err?.message || 'Stream analysis failed');
      }
    } finally {
      if (mountedRef.current) {
        setIsAnalyzing(false);

        // Render whatever we accumulated
        if (accumulated.length > 0) {
          const editor = editorRef?.current;
          if (editor) {
            disposeAIInlineWidgets(editor);
            disposeAICodeActions();
            createAIInlineWidgets(editor, accumulated, {
              onApply: (fix) => applyFix(fix),
              onDismiss: (fix) => dismissFixInternal(fix),
            });
            codeActionsRef.current = registerAICodeActions(editor, accumulated, {
              onApply: (fix) => applyFix(fix),
            });
            const m = editor.getModel();
            if (m) setAIDiagnostics(m, accumulated);

            // Update hover provider with streamed fixes
            if (hoverProviderRef.current) {
              hoverProviderRef.current.updateFixes(accumulated);
            } else {
              try {
                const monaco = (await import('monaco-editor')).default ?? await import('monaco-editor');
                hoverProviderRef.current = registerAIHoverProvider(monaco, accumulated);
              } catch (_) { /* non-critical */ }
            }
          }
        }
      }
    }
  }, [enabled, gateway, editorRef, filePath, language, workspaceRoot, dispatch]);

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

      // Report acceptance feedback to the agent
      _reportFeedback(fix, 'accepted');

      // Record in audit history
      aiFixHistory.record({ fix, action: 'applied', filePath });

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

  // ── Dismiss a fix (internal, no widget cleanup — used by widget callbacks) ──
  const dismissFixInternal = useCallback((fix) => {
    setFixes((prev) => prev.filter((f) => f !== fix));
    _reportFeedback(fix, 'rejected');
    aiFixHistory.record({ fix, action: 'dismissed', filePath });
  }, []);

  // ── Dismiss a fix (public — also refreshes widgets) ─────────────────
  const dismissFix = useCallback((fix) => {
    dismissFixInternal(fix);
  }, [dismissFixInternal]);

  // ── Dismiss all ─────────────────────────────────────────────────────
  const dismissAll = useCallback(() => {
    setFixes([]);
    if (lastDecoRef.current) {
      lastDecoRef.current.dispose();
      lastDecoRef.current = null;
    }
    const editor = editorRef?.current;
    if (editor) {
      disposeAIInlineWidgets(editor);
      disposeAICodeActions();
      const model = editor.getModel();
      if (model) clearAIDiagnostics(model);
    }
  }, [editorRef]);

  // ── Suppress a fix/rule (policy, NOT feedback) ─────────────────────
  const suppressRule = useCallback((ruleId, fix, { mode = 'fingerprint' } = {}) => {
    if (!ruleId) return;
    aiSuppressedRules.suppress(ruleId, fix, { mode });

    // Remove matching fixes from current list
    setFixes((prev) => {
      const { visible, suppressedCount: delta } = aiSuppressedRules.filterFixes(prev);
      setSuppressedCount((c) => c + delta);
      return visible;
    });

    // Send policy:suppressed to backend (NOT feedback:rejected)
    if (gateway?.aiPolicySuppress) {
      gateway.aiPolicySuppress({
        ruleId,
        fingerprint: fix ? computeFingerprint(fix) : null,
        mode,
        reason: 'user_suppressed',
      }).catch(() => {});
    }

    // Toast with Undo affordance
    const label = mode === 'rule' ? `rule "${ruleId}"` : 'this pattern';
    dispatch(enqueueToast({
      message: `Suppressed ${label}`,
      type: 'info',
      undoAction: {
        label: 'Undo',
        ruleId,
        // The fix reference is needed for fingerprint-mode undo
        fixSnapshot: fix ? {
          rule_id: fix.rule_id || fix.ruleId,
          category: fix.category,
          original_text: fix.original_text || fix.originalText,
        } : null,
      },
    }));
  }, [dispatch, gateway]);

  // ── Unsuppress a rule/fingerprint ──────────────────────────────────
  const unsuppressRule = useCallback((ruleId, fix = null) => {
    aiSuppressedRules.unsuppress(ruleId, fix);
    setSuppressedCount(0); // will be recalculated on next analysis

    if (gateway?.aiPolicyUnsuppress) {
      gateway.aiPolicyUnsuppress({ ruleId }).catch(() => {});
    }

    dispatch(enqueueToast({
      message: `Unsuppressed rule "${ruleId}"`,
      type: 'info',
    }));
  }, [dispatch, gateway]);

  // ── Get suppressed rules list ───────────────────────────────────────
  const getSuppressedRules = useCallback(() => {
    return aiSuppressedRules.all();
  }, []);

  // ── Clear all suppressions ────────────────────────────────────────
  const clearAllSuppressed = useCallback(() => {
    aiSuppressedRules.clear();
    setSuppressedCount(0);

    if (gateway?.aiPolicyClear) {
      gateway.aiPolicyClear().catch(() => {});
    }

    dispatch(enqueueToast({
      message: 'All suppressed rules cleared',
      type: 'info',
    }));
  }, [dispatch, gateway]);

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

  // ── Feedback reporting (internal helper) ────────────────────────────
  // Fire-and-forget — never blocks the UI.
  const _reportFeedback = useCallback((fix, feedbackType) => {
    if (!gateway?.aiFeedback) return;
    const ruleId = fix?.rule_id || fix?.ruleId;
    if (!ruleId) return;

    gateway.aiFeedback({
      ruleId,
      feedbackType,
      filePath,
      originalText: fix?.original_text || fix?.originalText || null,
      replacementText: fix?.replacement_text || fix?.replacementText || null,
      description: fix?.description || null,
    }).catch((err) => {
      // Feedback is non-critical — log and move on
      console.warn('[AIHealing] feedback send failed:', err);
    });
  }, [gateway, filePath]);

  /**
   * Public feedback method — lets UI components report arbitrary
   * feedback types (e.g. "modified" when user edits the suggestion).
   */
  const sendFeedback = useCallback((fix, feedbackType) => {
    _reportFeedback(fix, feedbackType);
  }, [_reportFeedback]);

  // ── Fetch memory summary ────────────────────────────────────────────
  const fetchMemory = useCallback(async () => {
    if (!gateway?.aiMemory) return null;
    try {
      return await gateway.aiMemory();
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
    suppressedCount,
    error,
    stats,
    lastAnalyzedAt,
    fixCount: fixes.length,
    safeFixCount: fixes.filter((f) => f.is_safe || f.isSafe).length,

    // Actions
    analyze,
    streamAnalyze,
    applyFix,
    applyAllSafe,
    dismissFix,
    dismissAll,
    fetchStats,
    sendFeedback,
    fetchMemory,
    getFixHistory: () => aiFixHistory.entries(),
    getFixHistoryStats: () => aiFixHistory.stats(),

    // Rule suppression
    suppressRule,
    unsuppressRule,
    getSuppressedRules,
    clearAllSuppressed,
  };
}
