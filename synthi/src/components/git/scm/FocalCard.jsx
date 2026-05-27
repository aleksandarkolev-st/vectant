'use client';

/**
 * FocalCard — the morphing "what matters now" card just under the
 * Branch Bridge.  Renders exactly one of eight states (see
 * useFocalCardState.js for the precedence ladder).  Two of those
 * states (`has-changes`, `clean`) render nothing — the file
 * sections speak louder than the card in those moments.
 *
 * The card itself is structurally identical across states; only the
 * rim class, copy, and the action pill change.  Card mount/unmount
 * uses heal-row-enter (defined in globals.css); the syncing variant
 * adds vt-brand-pulse via the .scm-focal--syncing class.
 */

import { memo, useMemo } from 'react';
import { AlertTriangle, ArrowUp, ArrowDown, GitMerge, Loader2, GitBranch } from 'lucide-react';

function FocalCardImpl({
  focal,                  // { state, ahead, behind, conflictCount, fileCount } from useFocalCardState
  onPush,
  onPull,
  onSync,                 // diverged path
  onResolveConflicts,
  onInitRepo,
  onCloneRepo,
}) {
  // Hooks must run unconditionally — derive the view first, then
  // bail out for the "hidden" states.
  const view = useMemo(() => (focal ? buildView(focal) : null), [focal]);

  if (!focal || focal.state === 'has-changes' || focal.state === 'clean' || !view) {
    return null;
  }

  const cardClass = ['scm-focal', view.rimClass].filter(Boolean).join(' ');

  return (
    <div className={cardClass} role="status" aria-live="polite">
      <div className="scm-focal-title">
        {view.Icon && <view.Icon className="w-3.5 h-3.5" strokeWidth={2} />}
        <span>{view.title}</span>
      </div>
      {view.meta && (
        <div className="scm-focal-meta">{view.meta}</div>
      )}
      {view.actions && view.actions.length > 0 && (
        <div className="scm-focal-actions">
          {view.actions.map((action, idx) => (
            <button
              key={action.key || idx}
              type="button"
              className={[
                'scm-focal-action',
                action.tone === 'primary' ? 'scm-focal-action--primary' : '',
                action.tone === 'danger' ? 'scm-focal-action--danger' : '',
              ].filter(Boolean).join(' ')}
              onClick={() => {
                const handler = pickActionHandler(action.key, {
                  onPush, onPull, onSync, onResolveConflicts, onInitRepo, onCloneRepo,
                });
                handler?.();
              }}
            >
              {action.Icon && <action.Icon className="w-3 h-3" strokeWidth={2} />}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function pickActionHandler(key, handlers) {
  switch (key) {
    case 'push':     return handlers.onPush;
    case 'pull':     return handlers.onPull;
    case 'sync':     return handlers.onSync;
    case 'resolve':  return handlers.onResolveConflicts;
    case 'init':     return handlers.onInitRepo;
    case 'clone':    return handlers.onCloneRepo;
    default:         return null;
  }
}

/** Compose the per-state view (rim class + copy + icons + actions). */
function buildView(focal) {
  switch (focal.state) {
    case 'no-repo':
      return {
        rimClass: 'scm-focal--empty',
        Icon: GitBranch,
        title: 'No git repository',
        meta: 'Initialize a new repo or clone an existing one to get started.',
        actions: [
          { key: 'init',  tone: 'primary', label: 'Initialize' },
          { key: 'clone', tone: 'ghost',   label: 'Clone…' },
        ],
      };

    case 'conflicts': {
      const n = focal.conflictCount;
      return {
        rimClass: 'scm-focal--conflict',
        Icon: AlertTriangle,
        title: `${n} ${n === 1 ? 'file needs' : 'files need'} resolution`,
        meta: 'Open each conflicted file and resolve, or use the merge editor.',
        actions: [
          { key: 'resolve', tone: 'danger', label: 'Resolve →' },
        ],
      };
    }

    case 'syncing':
      return {
        rimClass: 'scm-focal--syncing',
        Icon: Loader2,
        title: 'Syncing with remote…',
        meta: 'Fetching latest from origin.',
        actions: [],
      };

    case 'diverged':
      return {
        rimClass: 'scm-focal--diverged',
        Icon: GitMerge,
        title: `Diverged — ${focal.ahead} up, ${focal.behind} down`,
        meta: 'Pull first to integrate incoming commits, then push.',
        actions: [
          { key: 'sync', tone: 'primary', label: 'Sync' },
        ],
      };

    case 'behind':
      return {
        rimClass: 'scm-focal--behind',
        Icon: ArrowDown,
        title: `${focal.behind} incoming ${focal.behind === 1 ? 'commit' : 'commits'}`,
        meta: 'Pull to bring your branch up to date.',
        actions: [
          { key: 'pull', tone: 'primary', label: 'Pull' },
        ],
      };

    case 'ahead':
      return {
        rimClass: 'scm-focal--ahead',
        Icon: ArrowUp,
        title: `${focal.ahead} ${focal.ahead === 1 ? 'commit' : 'commits'} ready to push`,
        meta: null,
        actions: [
          { key: 'push', tone: 'primary', label: 'Push  →' },
        ],
      };

    default:
      return { rimClass: '', title: '', actions: [] };
  }
}

const FocalCard = memo(FocalCardImpl);

export default FocalCard;
export { FocalCard };
