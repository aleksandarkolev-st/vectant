'use client';

/**
 * OverflowMenu — the dropdown opened by the Branch Bridge's
 * gear/more-button.  Houses the rarer git ops that don't deserve
 * permanent real-estate on the column:
 *
 *   Sync         · Fetch · Pull · Push · Force push…
 *   Repo         · Initialize · Clone…
 *   Remotes      · Manage remotes…
 *   Stash        · Stash changes
 *   Dangerous    · Discard all changes… · Abort merge (when in merge)
 *   Navigation   · Open commit history · Open Pull Requests
 *   Settings     · GitHub token…
 *
 * All items dispatch their handler via the props passed in by
 * SourceControlPanel.  This component itself owns no state beyond
 * the dropdown open/close (handled by Radix).
 */

import { memo } from 'react';
import {
  RefreshCw, ArrowUp, ArrowDown, AlertTriangle, GitMerge,
  Plus, DownloadCloud, Globe, Trash2, Archive, GitPullRequest,
  Key, History, Loader2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function OverflowMenuImpl({
  trigger,                        // the BranchBridge's gear button is passed in
  hasRepo = true,
  hasMergeInProgress = false,
  ahead = 0,
  behind = 0,
  isSyncing = false,
  onFetch,
  onPull,
  onPush,
  onForcePush,
  onInitRepo,
  onCloneRepo,
  onManageRemotes,
  onStashChanges,
  onDiscardAll,
  onAbortMerge,
  onOpenCommitHistory,
  onOpenPullRequests,
  onOpenTokenModal,
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-[200px]"
        style={{
          background: 'var(--bg-panel)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-primary)',
        }}
      >
        {hasRepo && (
          <>
            <DropdownMenuLabel
              className="text-[10px] uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              Sync
            </DropdownMenuLabel>
            <DropdownMenuItem disabled={isSyncing} onClick={onFetch}>
              {isSyncing
                ? <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" strokeWidth={2} />
                : <RefreshCw className="w-3.5 h-3.5 mr-2" strokeWidth={2} />}
              Fetch from remote
            </DropdownMenuItem>
            <DropdownMenuItem disabled={behind === 0} onClick={onPull}>
              <ArrowDown className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
              Pull{behind > 0 ? ` (${behind})` : ''}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={ahead === 0} onClick={onPush}>
              <ArrowUp className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
              Push{ahead > 0 ? ` (${ahead})` : ''}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onForcePush}>
              <AlertTriangle className="w-3.5 h-3.5 mr-2" strokeWidth={2}
                             style={{ color: 'var(--accent-warning)' }} />
              Force push…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuLabel
          className="text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          Repository
        </DropdownMenuLabel>
        {!hasRepo && (
          <DropdownMenuItem onClick={onInitRepo}>
            <Plus className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
            Initialize
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={onCloneRepo}>
          <DownloadCloud className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
          Clone…
        </DropdownMenuItem>
        {hasRepo && (
          <DropdownMenuItem onClick={onManageRemotes}>
            <Globe className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
            Manage remotes…
          </DropdownMenuItem>
        )}

        {hasRepo && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel
              className="text-[10px] uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              Working tree
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={onStashChanges}>
              <Archive className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
              Stash changes
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDiscardAll} style={{ color: 'var(--accent-danger)' }}>
              <Trash2 className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
              Discard all changes…
            </DropdownMenuItem>

            {hasMergeInProgress && (
              <DropdownMenuItem onClick={onAbortMerge} style={{ color: 'var(--accent-danger)' }}>
                <GitMerge className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
                Abort merge
              </DropdownMenuItem>
            )}
          </>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel
          className="text-[10px] uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          Open
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={onOpenCommitHistory}>
          <History className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
          Commit history
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onOpenPullRequests}>
          <GitPullRequest className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
          Pull requests
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onOpenTokenModal}>
          <Key className="w-3.5 h-3.5 mr-2" strokeWidth={2} />
          GitHub token…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const OverflowMenu = memo(OverflowMenuImpl);

export default OverflowMenu;
export { OverflowMenu };
