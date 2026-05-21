'use client';

/**
 * useFocalCardState — derive the one focal state for the SCM panel
 * from `state.git` plus a local `isSyncing` flag.
 *
 * The focal card always shows exactly ONE state — the highest-
 * precedence one currently true.  The precedence ladder (highest to
 * lowest):
 *
 *   1. no-repo      → status === null
 *   2. conflicts    → hasConflicts
 *   3. syncing      → caller's isSyncing flag (fetch/pull/clone in
 *                     flight) — passed in because the parent owns
 *                     those dispatches.
 *   4. diverged     → ahead > 0 AND behind > 0
 *   5. behind       → behind > 0 (and ahead === 0)
 *   6. ahead        → ahead > 0 (and behind === 0)
 *   7. has-changes  → staged/unstaged/untracked files present
 *   8. clean        → everything else
 *
 * Returns `{ state, ahead, behind, conflictCount, fileCount }`.
 * The component decides what to render based on `state`; cards 7 and
 * 8 are rendered as "hidden" by the FocalCard component.
 */

import { useMemo } from 'react';
import { useSelector } from 'react-redux';

export function useFocalCardState({ isSyncing = false } = {}) {
  const status = useSelector((s) => s.git?.status);
  const unpushed = useSelector((s) => s.git?.unpushedCommits) || [];
  const incoming = useSelector((s) => s.git?.incomingCommits) || [];

  return useMemo(() => {
    // No repository at all — biggest signal to show.
    if (status === null) {
      return { state: 'no-repo', ahead: 0, behind: 0, conflictCount: 0, fileCount: 0 };
    }

    const conflictedFiles = status?.conflictedFiles || [];
    const hasConflicts = status?.hasConflicts || conflictedFiles.length > 0;
    const conflictCount = conflictedFiles.length;

    if (hasConflicts) {
      return {
        state: 'conflicts',
        ahead: unpushed.length,
        behind: incoming.length,
        conflictCount,
        fileCount: status?.files?.length || 0,
      };
    }

    if (isSyncing) {
      return {
        state: 'syncing',
        ahead: unpushed.length,
        behind: incoming.length,
        conflictCount,
        fileCount: status?.files?.length || 0,
      };
    }

    const ahead = unpushed.length;
    const behind = incoming.length;

    if (ahead > 0 && behind > 0) {
      return { state: 'diverged', ahead, behind, conflictCount, fileCount: status?.files?.length || 0 };
    }
    if (behind > 0) {
      return { state: 'behind', ahead: 0, behind, conflictCount, fileCount: status?.files?.length || 0 };
    }
    if (ahead > 0) {
      return { state: 'ahead', ahead, behind: 0, conflictCount, fileCount: status?.files?.length || 0 };
    }

    const fileCount = status?.files?.length || 0;
    if (fileCount > 0) {
      return { state: 'has-changes', ahead: 0, behind: 0, conflictCount, fileCount };
    }

    return { state: 'clean', ahead: 0, behind: 0, conflictCount: 0, fileCount: 0 };
  }, [status, unpushed, incoming, isSyncing]);
}

export default useFocalCardState;
