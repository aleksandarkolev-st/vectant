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
  showHealingDecorations,
  injectHealingStyles,
} from '@/components/healing/healingDecorations';

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

// ── Proactive diagnostic → healing fix normalizer ─────────────────────────
// Maps proactive diagnostic category strings to HealingCategory values
// so the existing autoHealCategories filter works seamlessly.
const DIAG_CATEGORY_TO_HEAL = {
  // Direct healing categories
  syntax: 'missing_semicolon',
  missing_semicolon: 'missing_semicolon',
  missing_colon: 'missing_colon',
  missing_bracket: 'missing_bracket',
  missing_paren: 'missing_bracket',
  preprocessor: 'missing_bracket',       // e.g. #endif/ → #endif
  import: 'missing_import',
  unused_import: 'unused_import',
  missing_import: 'missing_import',
  duplicate_import: 'duplicate_import',
  include: 'missing_import',             // C/C++ #include
  whitespace: 'trailing_whitespace',
  trailing_whitespace: 'trailing_whitespace',
  formatting: 'trailing_whitespace',
  string: 'unclosed_string',
  unclosed_string: 'unclosed_string',
  mismatched_quotes: 'mismatched_quotes',
  trailing_comma: 'trailing_comma',
  // AI diagnostic categories (DiagnosticCategory enum values)
  logic_error: 'missing_semicolon',      // AI often classifies missing syntax as logic_error
  type_error: 'missing_semicolon',
  null_reference: 'none_comparison',
  undefined_variable: 'missing_import',
  unused_code: 'unused_import',
  style: 'trailing_whitespace',
  best_practice: 'trailing_whitespace',
};

// Infer a more specific healing category from the diagnostic message text.
// This catches cases where the AI LLM labels a "missing semicolon" diagnostic
// with a broad category like "logic_error".
function inferCategoryFromMessage(msg) {
  if (!msg) return null;
  const m = msg.toLowerCase();
  if (m.includes('semicolon'))                    return 'missing_semicolon';
  if (m.includes('missing colon'))                return 'missing_colon';
  if (m.includes('bracket') || m.includes('brace') || m.includes('paren'))
                                                  return 'missing_bracket';
  if (m.includes('import') && m.includes('unused'))  return 'unused_import';
  if (m.includes('import') || m.includes('include')) return 'missing_import';
  if (m.includes('whitespace') || m.includes('trailing space'))
                                                  return 'trailing_whitespace';
  if (m.includes('comma'))                        return 'trailing_comma';
  if (m.includes('quote') || m.includes('string'))   return 'unclosed_string';
  return null;
}

/**
 * Convert a proactive Diagnostic (with nested .fixes[]) into one or
 * more objects shaped like HealingFix so that applyFixToEditor() can
 * consume them without changes.
 *
 * @param {Object} diag  – a proactive diagnostic from analyzeUnified/analyzeProactive
 * @returns {Object[]}   – array of normalised fix objects
 */
function diagnosticToHealingFixes(diag) {
  if (!diag?.fixes?.length) return [];

  const loc = diag.location || {};
  const healCategory =
    DIAG_CATEGORY_TO_HEAL[diag.category?.toLowerCase()] ||
    DIAG_CATEGORY_TO_HEAL[diag.code?.toLowerCase()] ||
    inferCategoryFromMessage(diag.message) ||              // ← message-based fallback
    inferCategoryFromMessage(diag.fixes?.[0]?.description) ||
    diag.category ||
    'missing_semicolon';  // safe default that's in autoHealCategories

  return diag.fixes
    .filter((fix) => {
      // SAFETY: Only accept fixes that have their OWN location.
      // Falling back to the diagnostic's location is dangerous because the
      // diagnostic range often spans the entire erroneous region (many lines)
      // while the fix replacement is a tiny string — replacing that range
      // would delete most of the file.
      if (!fix.location) return false;
      // SAFETY: Reject fixes that affect more than 3 lines (micro-fix only)
      const fLoc = fix.location;
      const affectedLines = Math.abs((fLoc.endLine ?? fLoc.line ?? 0) - (fLoc.line ?? 0)) + 1;
      if (affectedLines > 3) return false;
      return true;
    })
    .map((fix) => {
      const fixLoc = fix.location; // guaranteed non-null by filter above
      return {
        // Fields expected by applyFixToEditor (0-indexed)
        startLine: fixLoc.line ?? 0,
        startCol: fixLoc.column ?? 0,
        endLine: fixLoc.endLine ?? fixLoc.line ?? 0,
        endCol: fixLoc.endColumn ?? fixLoc.column ?? 0,
        replacementText: fix.replacementText ?? fix.replacement_text ?? '',
        // Metadata for the filter/toast pipeline
        category: healCategory,
        // isPreferred fixes from the AI are high-confidence validated fixes;
        // boost confidence to pass the 0.9 auto-heal threshold even if the
        // LLM returned a conservative number.
        confidence: fix.isPreferred
          ? Math.max(diag.confidence ?? 0.95, 0.95)
          : (diag.confidence ?? 0.85),
        isSafe: true,
        is_safe: true,
        description: fix.description || diag.message,
        id: diag.id || diag.__id || uid(),
        source: 'proactive',
      };
    });
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
  const lastDecoDisposable = useRef(null);

  // ── Track whether we just applied a fix (to avoid re-triggering) ────
  const selfEditFlagRef = useRef(false);

  // ── State: last analysis result (for UI, debugging) ─────────────────
  const [lastFixes, setLastFixes] = useState([]);

  // ── Cleanup ─────────────────────────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    injectHealingStyles();
    return () => {
      mountedRef.current = false;
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      if (lastDecoDisposable.current) lastDecoDisposable.current.dispose();
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

      // Show healing line decorations on applied fixes
      if (appliedCount > 0) {
        const healedRanges = sorted.slice(0, appliedCount).map((f) => ({
          startLine: (f.start_line ?? f.startLine ?? 0) + 1,
          endLine: (f.end_line ?? f.endLine ?? f.start_line ?? f.startLine ?? 0) + 1,
        }));
        if (lastDecoDisposable.current) lastDecoDisposable.current.dispose();
        const editor = editorRef?.current;
        if (editor) {
          lastDecoDisposable.current = showHealingDecorations(editor, healedRanges);
        }
      }

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

  // ── Heal from proactive diagnostics ──────────────────────────────────
  // Called by the page after a proactive/unified analysis returns
  // diagnostics that carry validated quick-fixes (the ones shown in the
  // Problems panel with "1 quick fix available").  Instead of running a
  // separate heal/analyze round-trip, we normalise the proactive fixes
  // and push them through the same safe-apply pipeline.
  const healFromDiagnostics = useCallback(
    (diagnostics) => {
      if (!enabled || !active) return;
      if (inflightRef.current) return;
      if (selfEditFlagRef.current) return;

      const editor = editorRef?.current;
      if (!editor) return;
      const model = editor.getModel();
      if (!model) return;

      // Flatten all proactive diagnostics → healing-shaped fix objects
      const allFixes = (diagnostics || [])
        .flatMap(diagnosticToHealingFixes);

      if (!allFixes.length) return;

      // Apply the same safety filters the regular heal pass uses
      const autoCategories = new Set(config.autoHealCategories || []);
      const minConf = config.minConfidence ?? 0.9;
      const maxFixes = config.maxFixesPerPass ?? 5;

      const eligible = allFixes
        .filter((f) => {
          const safe = f.is_safe ?? f.isSafe ?? false;
          const conf = f.confidence ?? 0;
          const cat = f.category || '';
          const passes = safe && conf >= minConf && autoCategories.has(cat);
          if (!passes) {
            console.log(`[SelfHealing] Filtered out fix: cat="${cat}" conf=${conf} safe=${safe} inAutoHeal=${autoCategories.has(cat)} desc="${f.description}"`);
          }
          return passes;
        })
        .slice(0, maxFixes);

      if (!eligible.length) return;

      // If requireConfirmation, stage as pending only
      if (config.requireConfirmation) {
        dispatch(setPendingFixes(eligible.map((f) => ({ ...f, id: f.id || uid(), filePath }))));
        return;
      }

      // ── Auto-apply as a SINGLE batched edit ─────────────────────────
      // CRITICAL: We must apply ALL fixes in ONE executeEdits() call.
      // Applying them one-by-one shifts line/column positions after each
      // edit, causing subsequent fixes to operate on stale coordinates
      // and potentially wipe large content ranges.
      inflightRef.current = true;
      dispatch(setHealingStatus('applying'));
      dispatch(setFileHealingState({ filePath, isHealing: true }));

      const snapHash = computeContentHash(model.getValue());

      const monacoRef = window.monaco || (typeof globalThis !== 'undefined' && globalThis.monaco);
      if (!monacoRef) {
        inflightRef.current = false;
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        return;
      }

      // Build Monaco edit operations & verify each fix against current content
      const edits = [];
      const accepted = [];

      for (const fix of eligible) {
        const startLine = (fix.startLine ?? 0) + 1;
        const startCol  = (fix.startCol ?? 0) + 1;
        const endLine   = (fix.endLine ?? fix.startLine ?? 0) + 1;
        const endCol    = (fix.endColumn ?? fix.endCol ?? fix.startCol ?? 0) + 1;
        const text      = fix.replacementText ?? '';

        // Guard: range must be within the model
        if (startLine > model.getLineCount() + 1) continue;

        const range = new monacoRef.Range(startLine, startCol, endLine, endCol);
        const originalText = model.getValueInRange(range);

        // Guard: don't delete significantly more text than we're inserting
        // (e.g. replacing 500 chars with 1 char is almost certainly a bad range)
        if (originalText.length > 0 && text.length === 0 && originalText.length > 50) {
          console.warn('[SelfHealing] Skipping destructive fix:', fix.description, `(would delete ${originalText.length} chars)`);
          continue;
        }
        if (originalText.length > 100 && text.length < originalText.length / 4) {
          console.warn('[SelfHealing] Skipping suspicious fix:', fix.description, `(${originalText.length} chars → ${text.length} chars)`);
          continue;
        }

        edits.push({ range, text, forceMoveMarkers: true });
        accepted.push({ fix, originalText, range: { startLine, startCol, endLine, endCol } });
      }

      if (!edits.length) {
        inflightRef.current = false;
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        return;
      }

      // Flag self-edit BEFORE the batched edit
      selfEditFlagRef.current = true;

      editor.executeEdits('self-healing-proactive', edits);
      editor.pushUndoStop();

      // Clear self-edit flag after Monaco's sync onChange has fired
      setTimeout(() => { selfEditFlagRef.current = false; }, 100);

      let appliedCount = accepted.length;

      for (const { fix, originalText, range } of accepted) {
        dispatch(recordAppliedFix({
          id: fix.id || uid(),
          filePath,
          category: fix.category,
          language: language || 'unknown',
          description: fix.description || fix.category,
          confidence: fix.confidence,
          replacementText: fix.replacementText,
          source: 'proactive',
        }));
        dispatch(pushUndo({
          fixId: fix.id || uid(),
          filePath,
          originalText,
          range,
        }));
        dispatch(addHealingEvent({
          type: 'proactive_fix_applied',
          fixId: fix.id,
          category: fix.category,
          filePath,
        }));
      }

      if (appliedCount > 0 && config.showNotifications) {
        const cats = [...new Set(accepted.map(({ fix: f }) => f.description || f.category).filter(Boolean))];
        dispatch(enqueueToast({
          type: 'healing',
          message: appliedCount === 1
            ? `Auto-fixed: ${cats[0] || 'issue'}`
            : `Auto-fixed ${appliedCount} issues`,
          details: cats.join(', '),
          fixCount: appliedCount,
          undoable: true,
        }));
      }

      if (appliedCount > 0) {
        const healedRanges = accepted.map(({ fix: f }) => ({
          startLine: (f.startLine ?? 0) + 1,
          endLine: (f.endLine ?? f.startLine ?? 0) + 1,
        }));
        if (lastDecoDisposable.current) lastDecoDisposable.current.dispose();
        if (editorRef?.current) {
          lastDecoDisposable.current = showHealingDecorations(editorRef.current, healedRanges);
        }
      }

      fixCountRef.current += appliedCount;

      // Verify the model still has content — abort future healing if
      // something went catastrophically wrong.
      const afterContent = model.getValue();
      if (afterContent.length < 5) {
        console.error('[SelfHealing] ABORT: Model content is nearly empty after applying fixes. Triggering undo.');
        editor.trigger('self-healing', 'undo', null);
        inflightRef.current = false;
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        return;
      }

      dispatch(setHealingStatus('cooldown'));
      dispatch(setFileHealingState({ filePath, isHealing: false, lastContentHash: snapHash }));

      // Use a LONGER cooldown (3s) to prevent the re-trigger loop:
      // fix → content change → editorVersion bump → re-analysis → new diags → fix again
      const cooldownMs = Math.max(config.cooldownMs || 1000, 3000);
      cooldownTimer.current = setTimeout(() => {
        if (mountedRef.current) dispatch(setHealingStatus('idle'));
      }, cooldownMs);

      inflightRef.current = false;

      console.log(`[SelfHealing] Auto-applied ${appliedCount}/${eligible.length} proactive quick-fixes`);
    },
    [enabled, active, editorRef, filePath, language, config, dispatch]
  );

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
    healFromDiagnostics,
    dismissError,

    // Ref for parent to check self-edit flag
    selfEditFlagRef,
  };
}

export default useSelfHealing;
