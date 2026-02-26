// src/redux/healingSelectors.js
// Memoised selectors for the self-healing Redux state.
// These keep component re-renders cheap by only recalculating when the
// relevant slice of state actually changes.

import { createSelector } from '@reduxjs/toolkit';

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
