/**
 * isolatedSelectors.js — Narrow, memoized Redux selectors for render isolation
 *
 * These selectors return ONLY the primitive values or stable references
 * needed by specific UI regions. This prevents the React render cascade
 * where a wide selector (e.g. `state.git`) returns a new reference on every
 * dispatch, causing all connected components to re-render.
 *
 * Rules:
 *   1. Each selector returns the MINIMUM data needed by its consumer
 *   2. Object-returning selectors use createSelector for referential stability
 *   3. Primitive-returning selectors are plain functions (already stable)
 *
 * Usage:
 *   const branch = useAppSelector(selectCurrentBranch);
 *   // Only re-renders when the branch NAME string changes, not when
 *   // git.status, git.commits, or any other git property updates.
 */

import { createSelector } from '@reduxjs/toolkit';

// ── Git State Selectors (narrow) ─────────────────────────────────────────────

/** Current branch name (string) — changes only on checkout */
export const selectCurrentBranch = (state) => state.git?.status?.currentBranch || '';

/** Is a git operation in-flight? (boolean) — derived from per-operation flags */
export const selectGitLoading = (state) => {
  const g = state.git;
  if (!g) return false;
  return g.statusLoading || g.historyLoading || g.unpushedLoading || g.incomingLoading || g.actionLoading || false;
};

/** Per-operation loading selectors for fine-grained subscriptions */
export const selectGitStatusLoading = (state) => state.git?.statusLoading || false;
export const selectGitActionLoading = (state) => state.git?.actionLoading || false;

/** Ahead/behind count (stable object via createSelector) */
export const selectAheadBehind = createSelector(
  (state) => state.git?.status?.ahead,
  (state) => state.git?.status?.behind,
  (ahead, behind) => ({ ahead: ahead || 0, behind: behind || 0 })
);

/** Changed files count (number) — for badge display */
export const selectChangedFilesCount = (state) => {
  const s = state.git?.status;
  return (s?.changedFiles?.length || 0) + (s?.stagedFiles?.length || 0);
};

/** Staged file count only */
export const selectStagedCount = (state) => state.git?.status?.stagedFiles?.length || 0;

/** Conflicted file count */
export const selectConflictedCount = (state) => state.git?.status?.conflictedFiles?.length || 0;

// ── Workspace State Selectors (narrow) ───────────────────────────────────────

/** Active file path (string) — avoids returning the whole file object */
export const selectActiveFilePath = (state) => state.workspace?.activeFile?.path || null;

/** Active file name */
export const selectActiveFileName = (state) => state.workspace?.activeFile?.name || null;

/** Number of open files */
export const selectOpenFileCount = (state) => state.workspace?.openFiles?.length || 0;

/** Workspace slug */
export const selectWorkspaceSlug = (state) => state.workspace?.slug || null;

// ── UI State Selectors (narrow) ──────────────────────────────────────────────

/** Cursor position for status bar */
export const selectCursorPosition = createSelector(
  (state) => state.workspace?.cursor?.lineNumber,
  (state) => state.workspace?.cursor?.column,
  (line, col) => ({ line: line || 1, column: col || 1 })
);

/** Is analysis running? */
export const selectIsAnalyzing = (state) => state.workspace?.isAnalyzing || false;

// ── Diagnostic Selectors ─────────────────────────────────────────────────────

/** Diagnostic summary for status bar (stable via createSelector) */
export const selectDiagnosticCounts = createSelector(
  (state) => state.workspace?.diagnosticSummary,
  (summary) => ({
    errors: summary?.errors || 0,
    warnings: summary?.warnings || 0,
    info: summary?.info || 0,
  })
);
