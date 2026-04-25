// src/redux/healingSelectors.js
// Memoised selectors for the self-healing Redux state.
// These keep component re-renders cheap by only recalculating when the
// relevant slice of state actually changes.

import { createSelector } from '@reduxjs/toolkit';
import { BoldnessThresholds } from './healingSlice';

// ── Root selector ─────────────────────────────────────────────────────────
export const selectHealingState = (state) => state.healing;

// ── Simple selectors ──────────────────────────────────────────────────────
export const selectHealingEnabled = (state) => state.healing?.enabled ?? false;
export const selectHealingStatus = (state) => state.healing?.status ?? 'idle';
export const selectHealingError = (state) => state.healing?.lastError ?? null;
export const selectHealingConfig = (state) => state.healing?.config ?? {};
export const selectPendingFixes = (state) => state.healing?.pendingFixes ?? [];
export const selectAppliedFixes = (state) => state.healing?.appliedFixes ?? [];
export const selectUndoStack = (state) => state.healing?.undoStack ?? [];
export const selectHealingEvents = (state) => state.healing?.events ?? [];
export const selectToastQueue = (state) => state.healing?.toastQueue ?? [];
export const selectHealingStats = (state) => state.healing?.stats ?? {};

// ── Derived selectors ─────────────────────────────────────────────────────

/** Whether the healing system is actively doing work */
export const selectIsHealingActive = createSelector(
  [selectHealingStatus],
  (status) => status === 'analyzing' || status === 'applying'
);

/** Number of pending fixes */
export const selectPendingFixCount = createSelector(
  [selectPendingFixes],
  (fixes) => fixes.length
);

/** Number of applied fixes this session */
export const selectAppliedFixCount = createSelector(
  [selectHealingStats],
  (stats) => stats.totalFixesApplied || 0
);

/** Whether there are fixes that can be undone */
export const selectCanUndo = createSelector(
  [selectUndoStack],
  (stack) => stack.length > 0
);

/** The top undo entry (most recent applied fix) */
export const selectTopUndo = createSelector(
  [selectUndoStack],
  (stack) => (stack.length > 0 ? stack[0] : null)
);

/** The next toast to show */
export const selectNextToast = createSelector(
  [selectToastQueue],
  (queue) => (queue.length > 0 ? queue[0] : null)
);

/** Auto-heal category set (for quick lookup) */
export const selectAutoHealCategorySet = createSelector(
  [selectHealingConfig],
  (config) => new Set(config.autoHealCategories || [])
);

/** Per-file healing state selector factory */
export const makeSelectFileHealingState = (filePath) =>
  createSelector(
    [selectHealingState],
    (healing) => healing?.fileStates?.[filePath] || null
  );

/** Pending fixes for a specific file */
export const makeSelectPendingFixesForFile = (filePath) =>
  createSelector(
    [selectPendingFixes],
    (fixes) =>
      fixes.filter(
        (f) => (f.filePath || f.file_path) === filePath
      )
  );

/** Applied fixes for a specific file */
export const makeSelectAppliedFixesForFile = (filePath) =>
  createSelector(
    [selectAppliedFixes],
    (fixes) =>
      fixes.filter(
        (f) => (f.filePath || f.file_path) === filePath
      )
  );

/** Stats breakdown by category (sorted descending) */
export const selectFixesByCategorySorted = createSelector(
  [selectHealingStats],
  (stats) => {
    const cats = stats.fixesByCategory || {};
    return Object.entries(cats)
      .sort(([, a], [, b]) => b - a)
      .map(([category, count]) => ({ category, count }));
  }
);

/** Stats breakdown by language (sorted descending) */
export const selectFixesByLanguageSorted = createSelector(
  [selectHealingStats],
  (stats) => {
    const langs = stats.fixesByLanguage || {};
    return Object.entries(langs)
      .sort(([, a], [, b]) => b - a)
      .map(([language, count]) => ({ language, count }));
  }
);

/** Summary string for status bar: "3 fixes applied" */
export const selectHealingSummary = createSelector(
  [selectHealingEnabled, selectHealingStatus, selectHealingStats],
  (enabled, status, stats) => {
    if (!enabled) return 'Self-Heal: Off';
    const applied = stats.totalFixesApplied || 0;
    if (status === 'analyzing') return 'Self-Heal: Analyzing…';
    if (status === 'applying') return 'Self-Heal: Applying…';
    if (status === 'cooldown') return 'Self-Heal: Cooldown';
    if (status === 'error') return 'Self-Heal: Error';
    if (applied === 0) return 'Self-Heal: Active';
    return `Self-Heal: ${applied} fix${applied === 1 ? '' : 'es'}`;
  }
);

/** Whether the healing system is ready (enabled + idle/cooldown) */
export const selectHealingReady = createSelector(
  [selectHealingEnabled, selectHealingStatus],
  (enabled, status) => enabled && (status === 'idle' || status === 'cooldown')
);

// ── Boldness / rules / triggers ──────────────────────────────────────────
export const selectBoldness = (state) => state.healing?.config?.boldness ?? 'balanced';
export const selectTriggers = (state) => state.healing?.config?.triggers ?? {};
export const selectHealingRules = (state) => state.healing?.config?.rules ?? [];
export const selectDebugLogging = (state) => state.healing?.config?.debugLogging ?? false;
export const selectDryRun = (state) => state.healing?.config?.dryRun ?? false;
export const selectCustomThresholds = (state) => state.healing?.config?.customThresholds ?? null;
export const selectSuggestionCandidates = (state) =>
  state.healing?.suggestionCandidates ?? { accepts: {}, dismissals: {} };
export const selectSuggestionsSnoozed = (state) =>
  state.healing?.suggestionsSnoozed ?? {};
export const selectLiveDiagnostics = (state) => state.healing?.liveDiagnostics ?? [];
const EMPTY_HEALED = Object.freeze({});
export const selectRecentlyHealedIds = (state) => state.healing?.recentlyHealedIds ?? EMPTY_HEALED;

/** Normalised forward-slash path for file-keyed lookups. */
function normaliseFilePath(p) {
  if (!p) return '';
  return String(p).replace(/^[./\\]+/, '').replace(/\\/g, '/').toLowerCase();
}

/**
 * Group live diagnostics by normalised file path.  Powers the file-tree
 * health dots — looking up a path in this map is O(1).
 *
 * Returns shape: { [filePath]: { errors, warnings, infos, hints, total } }
 */
export const selectDiagnosticsByFile = createSelector(
  [selectLiveDiagnostics],
  (diagnostics) => {
    const out = {};
    for (const d of diagnostics) {
      const raw = d?.filePath || d?.file || d?.primaryFile;
      if (!raw) continue;
      const key = normaliseFilePath(raw);
      if (!out[key]) out[key] = { errors: 0, warnings: 0, infos: 0, hints: 0, total: 0 };
      const sev = (d.severity || 'error').toLowerCase();
      out[key].total += 1;
      if (sev === 'error')        out[key].errors += 1;
      else if (sev === 'warning') out[key].warnings += 1;
      else if (sev === 'info')    out[key].infos += 1;
      else                        out[key].hints += 1;
    }
    return out;
  }
);

/**
 * Group pending (suggest-bucket) fixes by normalised file path — the
 * file-tree dot turns yellow when this count is > 0.
 */
export const selectPendingFixesByFile = createSelector(
  [selectPendingFixes],
  (fixes) => {
    const out = {};
    for (const f of fixes) {
      const raw = f?.filePath || f?.file_path;
      if (!raw) continue;
      const key = normaliseFilePath(raw);
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  }
);

/** Factory: health summary for a single file (for FileItem rendering). */
export const makeSelectFileHealth = (filePath) =>
  createSelector(
    [selectDiagnosticsByFile, selectPendingFixesByFile],
    (diagMap, pendingMap) => {
      const key = normaliseFilePath(filePath);
      const diag = diagMap[key] || null;
      const pending = pendingMap[key] || 0;
      return { diag, pending };
    }
  );

/**
 * Effective confidence thresholds — custom thresholds override the boldness
 * preset. Consumers use this to route individual fixes.
 */
export const selectEffectiveThresholds = createSelector(
  [selectBoldness, selectCustomThresholds],
  (boldness, custom) => {
    const preset = BoldnessThresholds[boldness] || BoldnessThresholds.balanced;
    if (!custom || typeof custom !== 'object') return preset;
    return {
      autoApply:   typeof custom.autoApply   === 'number' ? custom.autoApply   : preset.autoApply,
      suggest:     typeof custom.suggest     === 'number' ? custom.suggest     : preset.suggest,
      aiEscalate:  typeof custom.aiEscalate  === 'number' ? custom.aiEscalate  : preset.aiEscalate,
    };
  }
);

// ── AI Agent selectors ────────────────────────────────────────────────────
export const selectAIState = (state) => state.healing?.ai ?? {};
export const selectAIMode = (state) => state.healing?.ai?.mode ?? 'ai';
export const selectAIEnabled = (state) => state.healing?.ai?.enabled ?? true;
export const selectAIAnalyzing = (state) => state.healing?.ai?.isAnalyzing ?? false;
export const selectAIFixes = (state) => state.healing?.ai?.pendingFixes ?? [];
export const selectAIStats = (state) => state.healing?.ai?.stats ?? null;
export const selectAIError = (state) => state.healing?.ai?.error ?? null;

export const selectAIFixCount = createSelector(
  [selectAIFixes],
  (fixes) => fixes.length
);

export const selectAISafeFixCount = createSelector(
  [selectAIFixes],
  (fixes) => fixes.filter((f) => f.is_safe || f.isSafe).length
);

export const selectAISummary = createSelector(
  [selectAIEnabled, selectAIAnalyzing, selectAIFixes],
  (enabled, analyzing, fixes) => {
    if (!enabled) return 'AI Agent: Off';
    if (analyzing) return 'AI Agent: Analyzing…';
    if (fixes.length === 0) return 'AI Agent: Ready';
    return `AI Agent: ${fixes.length} issue${fixes.length === 1 ? '' : 's'}`;
  }
);
