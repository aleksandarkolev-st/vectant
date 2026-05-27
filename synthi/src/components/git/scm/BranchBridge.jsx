'use client';

/**
 * BranchBridge — the top header of the SCM column.
 *
 * Layout (left → right):
 *   • V glyph      — gradient-clipped Vectant mark.  Tapping it
 *                    opens the existing BranchSelector dropdown.
 *                    The V is one of the five intentional brand
 *                    moments in the SCM panel.
 *   • Branch name  — primary-text, click-through to picker.
 *   • Ahead/behind chips — muted at zero, calm slate-violet when
 *                    nonzero.  Never brand gradient.
 *   • Fetch button — refresh icon, triggers vt-brand-pulse on the
 *                    focal card while in-flight (the parent owns
 *                    the dispatch and the isSyncing flag).
 *   • Overflow     — gear icon that opens the OverflowMenu sheet.
 *
 * Bottom-edge ambient hairline is provided by the .scm-bridge::after
 * rule in scm-tokens.css.  When `pushSuccess` is true, the parent
 * adds `is-push-success` for ~700ms to sweep the gradient across
 * the hairline.
 */

import { memo, useCallback } from 'react';
import { ArrowUp, ArrowDown, RefreshCw, MoreHorizontal, Loader2 } from 'lucide-react';
import { BranchSelector } from '../BranchSelector';

function BranchBridgeImpl({
  slug,
  branch,
  ahead = 0,
  behind = 0,
  isSyncing = false,
  pushSuccess = false,
  onFetch,
  onOpenOverflow,
}) {
  const bridgeClass = [
    'scm-bridge',
    pushSuccess ? 'is-push-success' : '',
  ].filter(Boolean).join(' ');

  const handleFetch = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    onFetch?.();
  }, [onFetch]);

  return (
    <div className={bridgeClass} data-branch={branch || ''}>
      {/* The V glyph — gradient-clipped via .vt-brand-text. */}
      <span
        className="scm-bridge-v vt-brand-text"
        aria-hidden="true"
        title="Vectant Source Control"
      >
        V
      </span>

      {/* Branch picker — the existing BranchSelector handles the
          dropdown + checkout-conflict dialog.  Compact mode by
          design — no extra chrome, just the name. */}
      <div className="flex-1 min-w-0 flex items-center">
        <BranchSelector slug={slug} />
      </div>

      {/* Ahead chip */}
      <span
        className={[
          'scm-bridge-chip',
          ahead > 0 ? 'is-active' : '',
        ].filter(Boolean).join(' ')}
        title={ahead > 0 ? `${ahead} commit${ahead === 1 ? '' : 's'} to push` : 'No outgoing commits'}
        aria-label={`${ahead} commits ahead`}
      >
        <ArrowUp className="w-3 h-3" strokeWidth={2} />
        {ahead}
      </span>

      {/* Behind chip */}
      <span
        className={[
          'scm-bridge-chip',
          behind > 0 ? 'is-active' : '',
        ].filter(Boolean).join(' ')}
        title={behind > 0 ? `${behind} commit${behind === 1 ? '' : 's'} to pull` : 'No incoming commits'}
        aria-label={`${behind} commits behind`}
      >
        <ArrowDown className="w-3 h-3" strokeWidth={2} />
        {behind}
      </span>

      {/* Fetch button — refresh icon swaps to a spinner while syncing. */}
      <button
        type="button"
        className="scm-row-action th-focus-ring"
        style={{ width: 22, height: 22 }}
        onClick={handleFetch}
        disabled={isSyncing}
        title="Fetch from remote"
        aria-label="Fetch from remote"
      >
        {isSyncing
          ? <Loader2 className="w-3 h-3 animate-spin" strokeWidth={2} />
          : <RefreshCw className="w-3 h-3" strokeWidth={2} />}
      </button>

      {/* Overflow trigger — opens the OverflowMenu sheet with
          remotes / clone / init / token controls. */}
      <button
        type="button"
        className="scm-row-action th-focus-ring"
        style={{ width: 22, height: 22 }}
        onClick={onOpenOverflow}
        title="More git actions"
        aria-label="More git actions"
      >
        <MoreHorizontal className="w-3 h-3" strokeWidth={2} />
      </button>
    </div>
  );
}

const BranchBridge = memo(BranchBridgeImpl);

export default BranchBridge;
export { BranchBridge };
