// src/hooks/useSelfHealing.js
// Core self-healing hook that orchestrates real-time micro-fix detection
// and application.  Coordinates between the AI backend (via the analyzer
// gateway), the Monaco editor instance, and the Redux healing slice.
//
// Design principles:
//  1. Only fix "small" things – import issues, syntax sugar, whitespace.
//  2. Never touch logic, strings in user code, or multi-line refactors.
//  3. Every auto-applied fix is undo-able via Ctrl+Z (pushUndoStop).
//  4. Debounce aggressively so we don't churn while the user types.
//  5. Skip analysis when content hasn't actually changed (hash dedup).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';

import {
  selectHealingEnabled,
  selectHealingConfig,
  selectHealingStatus,
  selectHealingReady,
} from '@/redux/healingSelectors';

import {
  setHealingStatus,
  setHealingError,
  clearHealingError,
  recordAppliedFix,
  recordSkippedFix,
  pushUndo,
  addHealingEvent,
  enqueueToast,
  setFileHealingState,
  setPendingFixes,
} from '@/redux/healingSlice';

// ── Helpers ───────────────────────────────────────────────────────────────

/** FNV-1a content hash – same algo used by page.jsx for dedup */
function computeContentHash(content) {
  if (!content) return '';
  let hash = 2166136261;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Generate a simple unique ID for fix tracking */
function uid() {
  return `hf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Hook ──────────────────────────────────────────────────────────────────

/**
 * @param {Object}  opts
 * @param {object}  opts.editorRef       – React ref whose `.current` is the Monaco editor instance
 * @param {object}  opts.gateway         – the object returned by useAnalyzerGateway()
 * @param {string}  opts.filePath        – workspace-relative path of the active file
 * @param {string}  opts.language        – language id of the active file (e.g. 'javascript')
 * @param {boolean} [opts.active=true]   – external gate (e.g. file must be focused)
 */
export function useSelfHealing({
  editorRef,
  gateway,
  filePath,
  language,
  active = true,
} = {}) {
  const dispatch = useDispatch();

  // ── Redux state ─────────────────────────────────────────────────────
  const enabled = useSelector(selectHealingEnabled);
  const config = useSelector(selectHealingConfig);
  const status = useSelector(selectHealingStatus);
  const ready = useSelector(selectHealingReady);

  // ── Local refs for debounce/cooldown ────────────────────────────────
  const debounceTimer = useRef(null);
  const cooldownTimer = useRef(null);
  const lastHashRef = useRef('');
  const inflightRef = useRef(false);
  const mountedRef = useRef(true);
  const fixCountRef = useRef(0);  // fixes applied in current pass

  // ── Track whether we just applied a fix (to avoid re-triggering) ────
  const selfEditFlagRef = useRef(false);

  // ── State: last analysis result (for UI, debugging) ─────────────────
  const [lastFixes, setLastFixes] = useState([]);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    };
  }, []);

  // Reset when file changes
  useEffect(() => {
    lastHashRef.current = '';
    fixCountRef.current = 0;
    setLastFixes([]);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
  }, [filePath]);

  // ── Core: request healing analysis from the backend ─────────────────
  const requestHealing = useCallback(
    async (content) => {
      if (!gateway?.healAnalyze) return null;
      if (!filePath || !content) return null;

      try {
        const result = await gateway.healAnalyze({
          code: content,
          filePath,
          language: language || 'plaintext',
        });
        return result;
      } catch (err) {
        console.warn('[SelfHealing] analysis failed:', err?.message || err);
        return null;
      }
    },
    [gateway, filePath, language]
  );

  // ── Core: apply a single fix to the Monaco editor ───────────────────
  const applyFixToEditor = useCallback(
    (fix) => {
      const editor = editorRef?.current;
      if (!editor) return false;

      const model = editor.getModel();
      if (!model) return false;

      try {
        // Convert 0-indexed backend locations to 1-indexed Monaco ranges
        const startLine = (fix.start_line ?? fix.startLine ?? 0) + 1;
        const startCol = (fix.start_col ?? fix.startCol ?? 0) + 1;
        const endLine = (fix.end_line ?? fix.endLine ?? fix.start_line ?? fix.startLine ?? 0) + 1;
        const endCol = (fix.end_col ?? fix.endCol ?? fix.start_col ?? fix.startCol ?? 0) + 1;
        const replacementText = fix.replacement_text ?? fix.replacementText ?? '';

        // Safety: check the model still has enough lines
        if (startLine > model.getLineCount() + 1) return false;

        // Capture original text for undo tracking
        const monaco = window.monaco || (typeof globalThis !== 'undefined' && globalThis.monaco);
        if (!monaco) return false;

        const range = new monaco.Range(startLine, startCol, endLine, endCol);
        const originalText = model.getValueInRange(range);

        // Flag that we're about to make a self-edit
        selfEditFlagRef.current = true;

        // Apply the edit (undo-friendly via executeEdits + pushUndoStop)
        editor.executeEdits('self-healing', [
          {
            range,
            text: replacementText,
            forceMoveMarkers: true,
          },
        ]);
        editor.pushUndoStop();

        // Clear the self-edit flag after a tick (the onChange fires sync)
        setTimeout(() => {
          selfEditFlagRef.current = false;
        }, 50);

        // Store undo info in Redux
        dispatch(
          pushUndo({
            fixId: fix.id || uid(),
            filePath,
            originalText,
            range: { startLine, startCol, endLine, endCol },
          })
        );

        return true;
      } catch (err) {
        console.warn('[SelfHealing] applyFixToEditor failed:', err);
        selfEditFlagRef.current = false;
        return false;
      }
    },
    [editorRef, filePath, dispatch]
  );

  // ── Core: run a full heal pass ──────────────────────────────────────
  const runHealPass = useCallback(async () => {
    if (inflightRef.current) return;
    if (!mountedRef.current) return;

    const editor = editorRef?.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const content = model.getValue();
    if (!content || content.length < 2) return;

    // Content-hash dedup – skip if nothing changed
    const hash = computeContentHash(content);
    if (hash === lastHashRef.current) return;
    lastHashRef.current = hash;

    inflightRef.current = true;
    dispatch(setHealingStatus('analyzing'));
    dispatch(setFileHealingState({ filePath, isHealing: true }));

    try {
      const result = await requestHealing(content);
      if (!mountedRef.current) return;

      const fixes = result?.fixes || result?.safe_fixes || [];
      if (!fixes.length) {
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        setLastFixes([]);
        dispatch(setPendingFixes([]));
        return;
      }

      // Filter by configured categories and confidence
      const autoCategories = new Set(config.autoHealCategories || []);
      const minConf = config.minConfidence ?? 0.9;
      const maxFixes = config.maxFixesPerPass ?? 5;

      const eligible = fixes
        .filter((f) => {
          const cat = f.category || '';
          const conf = f.confidence ?? 0;
          const safe = f.is_safe ?? f.isSafe ?? false;
          return safe && autoCategories.has(cat) && conf >= minConf;
        })
        .slice(0, maxFixes);

      setLastFixes(eligible);

      if (!eligible.length) {
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        return;
      }

      // If requireConfirmation, just stage as pending
      if (config.requireConfirmation) {
        dispatch(setPendingFixes(eligible.map((f) => ({ ...f, id: f.id || uid(), filePath }))));
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        return;
      }

      // ── Auto-apply (bottom-up to preserve line numbers) ────────────
      dispatch(setHealingStatus('applying'));

      // Sort bottom-up: highest line first
      const sorted = [...eligible].sort((a, b) => {
        const aLine = a.start_line ?? a.startLine ?? 0;
        const bLine = b.start_line ?? b.startLine ?? 0;
        if (bLine !== aLine) return bLine - aLine;
        const aCol = a.start_col ?? a.startCol ?? 0;
        const bCol = b.start_col ?? b.startCol ?? 0;
        return bCol - aCol;
      });

      // Re-read content right before applying (guard against stale model)
      const freshContent = model.getValue();
      const freshHash = computeContentHash(freshContent);

      // If content changed between analysis and apply, abort
      if (freshHash !== hash) {
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        return;
      }

      let appliedCount = 0;

      for (const fix of sorted) {
        const applied = applyFixToEditor(fix);
        if (applied) {
          appliedCount++;
          const fixRecord = {
            id: fix.id || uid(),
            filePath,
            category: fix.category,
            language: language || 'unknown',
            description: fix.description || fix.message || fix.category,
            confidence: fix.confidence,
            replacementText: fix.replacement_text ?? fix.replacementText,
          };

          dispatch(recordAppliedFix(fixRecord));
          dispatch(
            addHealingEvent({
              type: 'fix_applied',
              fixId: fixRecord.id,
              category: fix.category,
              filePath,
            })
          );
        } else {
          dispatch(recordSkippedFix({ id: fix.id, category: fix.category }));
        }
      }

      // Show notification if any fixes were applied
      if (appliedCount > 0 && config.showNotifications) {
        const categories = sorted
          .slice(0, appliedCount)
          .map((f) => f.category)
          .filter(Boolean);
        const uniqueCats = [...new Set(categories)];
        dispatch(
          enqueueToast({
            type: 'healing',
            message:
              appliedCount === 1
                ? `Auto-fixed: ${uniqueCats[0] || 'issue'}`
                : `Auto-fixed ${appliedCount} issues`,
            details: uniqueCats.join(', '),
            fixCount: appliedCount,
            undoable: true,
          })
        );
      }

      fixCountRef.current += appliedCount;

      // Enter cooldown
      dispatch(setHealingStatus('cooldown'));
      dispatch(setFileHealingState({ filePath, isHealing: false, lastContentHash: freshHash }));

      const cooldownMs = config.cooldownMs || 1000;
      cooldownTimer.current = setTimeout(() => {
        if (mountedRef.current) {
          dispatch(setHealingStatus('idle'));
        }
      }, cooldownMs);
    } catch (err) {
      if (mountedRef.current) {
        dispatch(setHealingError(err?.message || 'Healing analysis failed'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
      }
    } finally {
      inflightRef.current = false;
    }
  }, [
    editorRef,
    filePath,
    language,
    config,
    dispatch,
    requestHealing,
    applyFixToEditor,
  ]);

  // ── Debounced trigger ───────────────────────────────────────────────
  const scheduleHealing = useCallback(() => {
    if (!enabled || !active || !ready) return;

    // Don't re-trigger if we just self-edited
    if (selfEditFlagRef.current) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    const debounceMs = config.debounceMs || 800;
    debounceTimer.current = setTimeout(() => {
      runHealPass();
    }, debounceMs);
  }, [enabled, active, ready, config.debounceMs, runHealPass]);

  // ── Monaco content change listener ──────────────────────────────────
  useEffect(() => {
    const editor = editorRef?.current;
    if (!editor || !enabled || !active) return;

    const model = editor.getModel();
    if (!model) return;

    const disposable = model.onDidChangeContent(() => {
      // Skip if this change was made by the healing system itself
      if (selfEditFlagRef.current) return;
      scheduleHealing();
    });

    return () => disposable.dispose();
  }, [editorRef, enabled, active, scheduleHealing]);

  // ── Manual trigger ──────────────────────────────────────────────────
  const triggerHealNow = useCallback(() => {
    lastHashRef.current = ''; // force re-analysis
    runHealPass();
  }, [runHealPass]);

  // ── Dismiss error ───────────────────────────────────────────────────
  const dismissError = useCallback(() => {
    dispatch(clearHealingError());
  }, [dispatch]);

  // ── Return ──────────────────────────────────────────────────────────
  return {
    // State
    enabled,
    status,
    lastFixes,

    // Actions
    scheduleHealing,
    triggerHealNow,
    dismissError,

    // Ref for parent to check self-edit flag
    selfEditFlagRef,
  };
}

export default useSelfHealing;
