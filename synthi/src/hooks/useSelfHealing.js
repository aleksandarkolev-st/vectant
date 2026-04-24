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

// monaco-editor accesses `window` at import time, which breaks SSR.
// Lazy-require it only on the client side.
let monacoEditor = null;
function getMonaco() {
  if (!monacoEditor && typeof window !== 'undefined') {
    monacoEditor = require('monaco-editor');
  }
  return monacoEditor;
}

import {
  showHealingDecorations,
  injectHealingStyles,
} from '@/components/healing/healingDecorations';

import {
  selectHealingEnabled,
  selectHealingConfig,
  selectHealingStatus,
  selectHealingReady,
  selectEffectiveThresholds,
  selectHealingRules,
  selectDebugLogging,
  selectDryRun,
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
  replacePendingFixesAndTrackDismissals,
  incrementActionCount,
  RuleAction,
} from '@/redux/healingSlice';

import { evaluateFix } from '@/lib/healing/ruleEngine';

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

/**
 * Per-file opt-out: a `@synthi-disable-heal` marker anywhere in the first
 * 10 lines of the file stops healing for that file entirely.  Matches
 * any common comment form (`//`, `#`, `--`, `/*`, `*`).  Case-insensitive.
 */
const HEAL_OPTOUT_RE = /@synthi-disable-heal\b/i;
function isHealingOptedOut(content) {
  if (!content) return false;
  // Only scan the first ~1KB / 10 lines.  Cheap enough to run on every pass.
  const head = content.slice(0, 1024);
  const firstLines = head.split('\n', 10).join('\n');
  return HEAL_OPTOUT_RE.test(firstLines);
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
  // AI LLM categories that don't have direct healing equivalents —
  // map to the closest safe healing category so they pass the
  // autoHealCategories filter.
  design_issue: 'missing_return',
  missing_return: 'missing_return',
  missing_check: 'missing_bracket',
  wrong_operator: 'missing_semicolon',
  off_by_one: 'missing_semicolon',
  security: 'missing_semicolon',
  performance: 'missing_semicolon',
  resource_leak: 'missing_semicolon',
  concurrency: 'missing_semicolon',
  error_handling: 'missing_semicolon',
  api_misuse: 'missing_semicolon',
  variable_misuse: 'missing_semicolon',
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
  if (m.includes('return'))                        return 'missing_return';
  if (m.includes('missing') || m.includes('expected'))  return 'missing_semicolon';
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
function diagnosticToHealingFixes(diag, logger) {
  if (!diag?.fixes?.length) return [];

  const healCategory =
    DIAG_CATEGORY_TO_HEAL[diag.category?.toLowerCase()] ||
    DIAG_CATEGORY_TO_HEAL[diag.code?.toLowerCase()] ||
    inferCategoryFromMessage(diag.message) ||              // ← message-based fallback
    inferCategoryFromMessage(diag.fixes?.[0]?.description) ||
    diag.category ||
    'missing_semicolon';  // safe default

  const diagSeverity = (diag.severity || 'error').toLowerCase();

  return diag.fixes
    .filter((fix) => {
      // SAFETY: Only accept fixes that have their OWN location.
      // The diagnostic range often spans the entire erroneous region
      // (many lines) while the fix replacement is a tiny string —
      // replacing that range would delete most of the file.
      if (!fix.location) {
        logger?.(`skipping fix without location: "${fix.description}"`);
        return false;
      }
      // SAFETY: Reject fixes that affect more than 3 lines (micro-fix only)
      const fLoc = fix.location;
      const affectedLines = Math.abs((fLoc.endLine ?? fLoc.line ?? 0) - (fLoc.line ?? 0)) + 1;
      if (affectedLines > 3) {
        logger?.(`skipping fix spanning ${affectedLines} lines: "${fix.description}"`);
        return false;
      }
      return true;
    })
    .map((fix) => {
      const fixLoc = fix.location;
      let rawText = fix.replacementText ?? fix.replacement_text ?? '';
      const isSingleLine = (fixLoc.endLine ?? fixLoc.line ?? 0) === (fixLoc.line ?? 0);
      if (isSingleLine && rawText.endsWith('\n')) {
        rawText = rawText.replace(/\n+$/, '');
      }
      return {
        startLine: fixLoc.line ?? 0,
        startCol: fixLoc.column ?? 0,
        endLine: fixLoc.endLine ?? fixLoc.line ?? 0,
        endCol: fixLoc.endColumn ?? fixLoc.column ?? 0,
        replacementText: rawText,
        category: healCategory,
        severity: diagSeverity,
        // isPreferred fixes are validated — boost confidence.
        confidence: fix.isPreferred
          ? Math.max(diag.confidence ?? 0.95, 0.95)
          : (diag.confidence ?? 0.85),
        isSafe: true,
        is_safe: true,
        description: fix.description || diag.message,
        id: diag.id || diag.__id || uid(),
        source: 'proactive',
        // Propagate the source diagnostic so the rule engine can match on
        // severity/code/source even if they weren't lifted into the fix.
        _diagnostic: diag,
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
  onFixesApplied,
  onAIEscalate,
} = {}) {
  const dispatch = useDispatch();

  // ── Redux state ─────────────────────────────────────────────────────
  const enabled = useSelector(selectHealingEnabled);
  const config = useSelector(selectHealingConfig);
  const status = useSelector(selectHealingStatus);
  const ready = useSelector(selectHealingReady);
  const thresholds = useSelector(selectEffectiveThresholds);
  const rules = useSelector(selectHealingRules);
  const debugFromRedux = useSelector(selectDebugLogging);
  const dryRun = useSelector(selectDryRun);

  // ── Debug logger — gated behind config.debugLogging or window.SYNTHI_HEAL_DEBUG.
  // All [SelfHealing] prefixed logs go through this.  When disabled it's a
  // no-op so the hot path doesn't pay the cost of stringifying messages.
  const debug = (
    debugFromRedux ||
    (typeof window !== 'undefined' && window.SYNTHI_HEAL_DEBUG === true)
  );
  const d = useCallback((msg, ...args) => {
    if (debug) console.log(`[SelfHealing] ${msg}`, ...args);
  }, [debug]);
  const dWarn = useCallback((msg, ...args) => {
    if (debug) console.warn(`[SelfHealing] ${msg}`, ...args);
  }, [debug]);

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

  // ── Track when the user last typed (timestamp) ─────────────────────
  // Prevents the healing system from applying fixes while the user is
  // actively editing — avoids cursor jumps and interference with typing.
  const lastUserEditRef = useRef(0);
  const USER_TYPING_COOLDOWN_MS = 2000; // don't auto-fix within 2s of typing

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
          lang: language || 'plaintext',
          filePath,
        });
        return result;
      } catch (err) {
        dWarn('analysis failed:', err?.message || err);
        return null;
      }
    },
    [gateway, filePath, language, dWarn]
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
        const endCol = (fix.end_col ?? fix.endCol ?? fix.end_column ?? fix.endColumn ?? fix.start_col ?? fix.startCol ?? 0) + 1;
        const replacementText = fix.replacement_text ?? fix.replacementText ?? '';

        // Safety: check the model still has enough lines
        if (startLine > model.getLineCount() + 1) return false;

        // Capture original text for undo tracking
        const range = new (getMonaco().Range)(startLine, startCol, endLine, endCol);
        const originalText = model.getValueInRange(range);

        // Flag that we're about to make a self-edit
        selfEditFlagRef.current = true;

        // Save cursor + scroll so the edit doesn't jump the user
        const savedPos = editor.getPosition();
        const savedScrollTop = editor.getScrollTop();
        const savedScrollLeft = editor.getScrollLeft();

        // Apply the edit (undo-friendly via executeEdits + pushUndoStop)
        editor.executeEdits('self-healing', [
          {
            range,
            text: replacementText,
            forceMoveMarkers: true,
          },
        ]);
        editor.pushUndoStop();

        // Restore cursor + scroll
        if (savedPos) editor.setPosition(savedPos);
        editor.setScrollTop(savedScrollTop);
        editor.setScrollLeft(savedScrollLeft);

        // Clear the self-edit flag after Redux propagation settles
        setTimeout(() => {
          selfEditFlagRef.current = false;
        }, 500);

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
        dWarn('applyFixToEditor failed:', err);
        selfEditFlagRef.current = false;
        return false;
      }
    },
    [editorRef, filePath, dispatch, dWarn]
  );

  // ── Core: run a full heal pass ──────────────────────────────────────
  const runHealPass = useCallback(async () => {
    if (inflightRef.current) return;
    if (!mountedRef.current) return;

    // Don't apply fixes while the user is actively typing
    const msSinceLastEdit = Date.now() - lastUserEditRef.current;
    if (msSinceLastEdit < USER_TYPING_COOLDOWN_MS) return;

    const editor = editorRef?.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const content = model.getValue();
    if (!content || content.length < 2) return;

    // Per-file opt-out: `// @synthi-disable-heal` near the top of the file
    if (isHealingOptedOut(content)) {
      d('skipped: file has @synthi-disable-heal marker');
      return;
    }

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

      // ── Auto-apply as a SINGLE batched executeEdits() ─────────────
      // CRITICAL: We MUST apply ALL fixes in one executeEdits() call.
      // Applying them one-by-one via applyFixToEditor() shifts line/col
      // positions after each edit, causing subsequent fixes to operate on
      // stale coordinates and potentially wipe content.
      dispatch(setHealingStatus('applying'));

      // Sort bottom-up: highest line first (preserves line numbers within
      // the single executeEdits call — Monaco processes edits bottom-up).
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

      // monaco-editor module imported at top of file

      // Build Monaco edit operations & validate each fix
      const edits = [];
      const accepted = [];

      for (const fix of sorted) {
        const startLine = (fix.start_line ?? fix.startLine ?? 0) + 1;
        const startCol  = (fix.start_col ?? fix.startCol ?? 0) + 1;
        const eL        = (fix.end_line ?? fix.endLine ?? fix.start_line ?? fix.startLine ?? 0) + 1;
        const eC        = (fix.end_col ?? fix.endCol ?? fix.end_column ?? fix.endColumn ?? fix.start_col ?? fix.startCol ?? 0) + 1;
        const text      = fix.replacement_text ?? fix.replacementText ?? '';

        if (startLine > model.getLineCount() + 1) continue;

        const range = new (getMonaco().Range)(startLine, startCol, eL, eC);
        const originalText = model.getValueInRange(range);

        // Guard: don't delete significantly more text than we're inserting
        if (originalText.length > 0 && text.length === 0 && originalText.length > 50) {
          dWarn(`Skipping destructive fix: ${fix.description} (would delete ${originalText.length} chars)`);
          continue;
        }
        if (originalText.length > 100 && text.length < originalText.length / 4) {
          dWarn(`Skipping suspicious fix: ${fix.description} (${originalText.length} → ${text.length} chars)`);
          continue;
        }
        // Guard: reject edits that span more than half the file
        const totalLines = model.getLineCount();
        const editSpan = eL - startLine + 1;
        if (totalLines > 3 && editSpan > totalLines * 0.5) {
          dWarn(`Skipping fix spanning ${editSpan}/${totalLines} lines: ${fix.description}`);
          continue;
        }

        edits.push({ range, text, forceMoveMarkers: true });
        accepted.push({ fix, originalText, range: { startLine, startCol, endLine: eL, endCol: eC } });
      }

      if (!edits.length) {
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        inflightRef.current = false;
        return;
      }

      // Dry-run: log what we would have applied, then bail.
      if (dryRun) {
        d(`[dry-run] would apply ${edits.length} edit(s):`,
          accepted.map(({ fix: f }) => f.description || f.category));
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        inflightRef.current = false;
        return;
      }

      // Flag self-edit BEFORE the batched edit
      selfEditFlagRef.current = true;

      // Save cursor position and scroll state so we can restore after edits
      const savedPosition = editor.getPosition();
      const savedScrollTop = editor.getScrollTop();
      const savedScrollLeft = editor.getScrollLeft();

      editor.executeEdits('self-healing', edits);
      editor.pushUndoStop();

      // Restore cursor and scroll so the user doesn't see a jump
      if (savedPosition) editor.setPosition(savedPosition);
      editor.setScrollTop(savedScrollTop);
      editor.setScrollLeft(savedScrollLeft);

      setTimeout(() => { selfEditFlagRef.current = false; }, 500);

      // Post-edit safety: undo if model is nearly empty after applying fixes.
      // This is a genuine catastrophe — always log, ignore debug flag.
      const afterContent = model.getValue();
      if (afterContent.length < 5 && edits.length > 0) {
        console.error('[SelfHealing] ABORT: model nearly empty after regex heal, triggering undo');
        editor.trigger('self-healing', 'undo', null);
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        inflightRef.current = false;
        return;
      }

      let appliedCount = accepted.length;

      for (const { fix, originalText, range } of accepted) {
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
        dispatch(pushUndo({
          fixId: fixRecord.id,
          filePath,
          originalText,
          range,
        }));
        dispatch(
          addHealingEvent({
            type: 'fix_applied',
            fixId: fixRecord.id,
            category: fix.category,
            filePath,
          })
        );
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

        // After the regex heal pass edits the file, existing diagnostics
        // are stale — their content hash no longer matches.  Notify the
        // parent so the Problems panel can drop them.
        if (typeof onFixesApplied === 'function') {
          onFixesApplied(null);   // null = invalidate ALL diagnostics for this file
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
    onFixesApplied,
    d,
    dWarn,
    dryRun,
  ]);

  // ── Debounced trigger ───────────────────────────────────────────────
  const scheduleHealing = useCallback(() => {
    if (!enabled || !active || !ready) return;

    // Don't re-trigger if we just self-edited
    if (selfEditFlagRef.current) return;

    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    const debounceMs = Math.max(config.debounceMs || 800, 2000);
    debounceTimer.current = setTimeout(() => {
      runHealPass();
    }, debounceMs);
  }, [enabled, active, ready, config.debounceMs, runHealPass]);

  // ── Monaco content change listener ──────────────────────────────────
  // We ALWAYS need to track the "user just typed" timestamp so that the
  // diagnostics-stable and save triggers can cooldown mid-typing.  But we
  // only schedule a keystroke-driven heal pass when the user has explicitly
  // opted in via config.triggers.onKeystroke.
  const onKeystrokeTrigger = !!config.triggers?.onKeystroke;
  useEffect(() => {
    const editor = editorRef?.current;
    if (!editor || !enabled || !active) return;

    const model = editor.getModel();
    if (!model) return;

    const disposable = model.onDidChangeContent(() => {
      // Skip if this change was made by the healing system itself
      if (selfEditFlagRef.current) return;
      // Always track user typing timestamp
      lastUserEditRef.current = Date.now();
      // Only run the regex keystroke pass when explicitly enabled
      if (onKeystrokeTrigger) scheduleHealing();
    });

    return () => disposable.dispose();
  }, [editorRef, enabled, active, onKeystrokeTrigger, scheduleHealing]);

  // ── Heal from proactive diagnostics ──────────────────────────────────
  // Called by the page after a proactive/unified analysis returns
  // diagnostics that carry validated quick-fixes (the ones shown in the
  // Problems panel with "1 quick fix available").  Instead of running a
  // separate heal/analyze round-trip, we normalise the proactive fixes
  // and push them through the same safe-apply pipeline.
  const healFromDiagnostics = useCallback(
    (diagnostics) => {
      if (!enabled || !active) {
        d(`healFromDiagnostics skipped: enabled=${enabled} active=${active}`);
        return;
      }
      if (inflightRef.current) { d('skipped: inflight'); return; }
      if (selfEditFlagRef.current) { d('skipped: selfEditFlag'); return; }

      // Don't apply fixes while user is actively typing
      const msSinceEdit = Date.now() - lastUserEditRef.current;
      if (msSinceEdit < USER_TYPING_COOLDOWN_MS) {
        d(`skipped: user typed ${msSinceEdit}ms ago`);
        return;
      }

      const editor = editorRef?.current;
      if (!editor) return;
      const model = editor.getModel();
      if (!model) return;

      // Per-file opt-out: `// @synthi-disable-heal` near the top of the file
      if (isHealingOptedOut(model.getValue())) {
        d('skipped: file has @synthi-disable-heal marker');
        return;
      }

      // Flatten all proactive diagnostics → healing-shaped fix objects
      const allFixes = (diagnostics || []).flatMap((diag) =>
        diagnosticToHealingFixes(diag, d)
      );
      if (!allFixes.length) return;

      // ── Route each fix through the user-rule engine ─────────────────
      // Produces three buckets:
      //   autoApply   → batched executeEdits (this function)
      //   suggest     → staged as pendingFixes (Monaco lightbulb picks up)
      //   aiEscalate  → returned to caller via onAIEscalate for /heal/ai/hybrid
      const maxFixes = config.maxFixesPerPass ?? 5;
      const autoApply = [];
      const suggest = [];
      const escalate = [];
      let ignoredCount = 0;

      const aiAllowed = !!config.triggers?.useAIForHard;

      for (const fix of allFixes) {
        const decision = evaluateFix({
          fix,
          diagnostic: fix._diagnostic,
          rules,
          thresholds,
          filePath,
          language,
          aiEnabled: aiAllowed,
        });

        if (decision.action === RuleAction.AUTO_APPLY) {
          if (autoApply.length < maxFixes) autoApply.push({ fix, decision });
        } else if (decision.action === RuleAction.SUGGEST) {
          suggest.push({ fix, decision });
        } else if (decision.action === RuleAction.AI_ESCALATE) {
          escalate.push({ fix, decision });
        } else {
          ignoredCount += 1;
        }
      }

      d(`routed ${allFixes.length} fixes: ${autoApply.length} apply · ${suggest.length} suggest · ${escalate.length} ai · ${ignoredCount} ignore`);

      // Record routing breakdown for the stats panel
      if (autoApply.length)  dispatch(incrementActionCount({ action: 'auto_apply',  count: autoApply.length }));
      if (suggest.length)    dispatch(incrementActionCount({ action: 'suggest',     count: suggest.length }));
      if (escalate.length)   dispatch(incrementActionCount({ action: 'ai_escalate', count: escalate.length }));
      if (ignoredCount)      dispatch(incrementActionCount({ action: 'ignore',      count: ignoredCount }));

      // Stage suggestions for the user to accept (Problems panel / lightbulb).
      // Use the dismissal-tracking variant: any pending fix from the previous
      // pass that doesn't carry over to this one gets credited as a dismissal,
      // feeding the smart-rule-suggestion heuristic.
      const newPending = suggest.length > 0
        ? suggest.map(({ fix: f }) => ({ ...f, id: f.id || uid(), filePath }))
        : [];
      dispatch(replacePendingFixesAndTrackDismissals(newPending));

      // Hand escalated fixes to the AI layer (wired by page.jsx)
      if (escalate.length > 0 && typeof onAIEscalate === 'function') {
        onAIEscalate(escalate.map(({ fix: f, decision }) => ({ fix: f, reason: decision.reason })));
      }

      if (!autoApply.length) return;

      // Dry-run: log what we would apply and bail.
      if (dryRun) {
        d(`[dry-run] would auto-apply:`,
          autoApply.map(({ fix: f }) => f.description || f.category));
        return;
      }

      // ── Auto-apply as a SINGLE batched edit ─────────────────────────
      // CRITICAL: All fixes MUST be applied in ONE executeEdits() call —
      // applying them one-by-one shifts line/col positions after each edit
      // and causes later fixes to operate on stale coordinates.
      inflightRef.current = true;
      dispatch(setHealingStatus('applying'));
      dispatch(setFileHealingState({ filePath, isHealing: true }));

      const snapHash = computeContentHash(model.getValue());
      const edits = [];
      const accepted = [];

      // Sort bottom-up so line coordinates remain valid within the batch
      const sorted = [...autoApply].sort((a, b) => {
        const aL = a.fix.startLine ?? 0;
        const bL = b.fix.startLine ?? 0;
        if (bL !== aL) return bL - aL;
        return (b.fix.startCol ?? 0) - (a.fix.startCol ?? 0);
      });

      for (const { fix } of sorted) {
        const startLine = (fix.startLine ?? 0) + 1;
        const startCol  = (fix.startCol ?? 0) + 1;
        const endLine   = (fix.endLine ?? fix.startLine ?? 0) + 1;
        const endCol    = (fix.endColumn ?? fix.endCol ?? fix.startCol ?? 0) + 1;
        const text      = fix.replacementText ?? '';

        if (startLine > model.getLineCount() + 1) {
          d(`skip: startLine ${startLine} > model lines ${model.getLineCount()}`);
          continue;
        }

        const range = new (getMonaco().Range)(startLine, startCol, endLine, endCol);
        const originalText = model.getValueInRange(range);

        // Safety guards — keep these hard-coded, independent of user rules.
        if (originalText.length > 0 && text.length === 0 && originalText.length > 50) {
          dWarn(`skip destructive: ${fix.description} (would delete ${originalText.length} chars)`);
          continue;
        }
        if (originalText.length > 100 && text.length < originalText.length / 4) {
          dWarn(`skip suspicious: ${fix.description} (${originalText.length} → ${text.length} chars)`);
          continue;
        }
        const totalFileLines = model.getLineCount();
        const editSpan = endLine - startLine + 1;
        if (totalFileLines > 3 && editSpan > totalFileLines * 0.5) {
          dWarn(`skip wide span: ${editSpan}/${totalFileLines} lines: ${fix.description}`);
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

      const savedPosition = editor.getPosition();
      const savedScrollTop = editor.getScrollTop();
      const savedScrollLeft = editor.getScrollLeft();

      editor.executeEdits('self-healing-proactive', edits);
      editor.pushUndoStop();

      if (savedPosition) editor.setPosition(savedPosition);
      editor.setScrollTop(savedScrollTop);
      editor.setScrollLeft(savedScrollLeft);

      // 500ms gives Redux / analysis effects time to observe the content
      // change before we allow another heal cycle.
      setTimeout(() => { selfEditFlagRef.current = false; }, 500);

      const appliedCount = accepted.length;

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

        if (typeof onFixesApplied === 'function') {
          const healedIds = new Set(accepted.map(({ fix: f }) => f.id).filter(Boolean));
          if (healedIds.size > 0) onFixesApplied(healedIds);
        }
      }

      fixCountRef.current += appliedCount;

      // Post-edit catastrophe check — always log, ignore debug flag.
      const afterContent = model.getValue();
      if (afterContent.length < 5) {
        console.error('[SelfHealing] ABORT: model nearly empty after proactive heal, triggering undo');
        editor.trigger('self-healing', 'undo', null);
        inflightRef.current = false;
        dispatch(setHealingStatus('idle'));
        dispatch(setFileHealingState({ filePath, isHealing: false }));
        return;
      }

      dispatch(setHealingStatus('cooldown'));
      dispatch(setFileHealingState({ filePath, isHealing: false, lastContentHash: snapHash }));

      // Longer cooldown (3s) prevents the re-trigger loop:
      // fix → content change → editor version bump → re-analysis → new
      // diagnostics → would fix again.
      const cooldownMs = Math.max(config.cooldownMs || 1000, 3000);
      cooldownTimer.current = setTimeout(() => {
        if (mountedRef.current) dispatch(setHealingStatus('idle'));
      }, cooldownMs);

      inflightRef.current = false;

      d(`auto-applied ${appliedCount}/${autoApply.length}`);
    },
    [enabled, active, editorRef, filePath, language, config, rules, thresholds,
     dispatch, onFixesApplied, onAIEscalate, d, dWarn, dryRun]
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
