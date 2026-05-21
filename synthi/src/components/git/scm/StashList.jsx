'use client';

/**
 * StashList — sub-view content for the "Stashes" pill in the SCM
 * panel.  Compact list of saved stashes with three actions per row:
 *
 *   • Apply   — applies the stash and keeps it in the list.
 *   • Pop     — applies and removes the stash.
 *   • Drop    — removes without applying  (confirms first).
 *
 * Pushing a new stash from the current working tree lives at the
 * top of this view as a small inline composer; this keeps stash
 * actions self-contained inside the Stashes sub-view rather than
 * leaking into the main composer.
 */

import { memo, useCallback, useState } from 'react';
import { Archive, ArchiveRestore, Plus, Trash2 } from 'lucide-react';

function StashListImpl({
  stashes = [],          // [{ index, hash, branch, message, date }, ...]
  onPush,                // (message) => Promise
  onApply,               // (index)   => Promise
  onPop,                 // (index)   => Promise
  onDrop,                // (index)   => Promise
}) {
  const [draft, setDraft] = useState('');

  const handlePush = useCallback(async () => {
    await onPush?.(draft.trim() || undefined);
    setDraft('');
  }, [onPush, draft]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handlePush();
    }
  }, [handlePush]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-scm-stash-list>
      {/* Inline stash-push composer — small, never the main commit
          composer's twin.  The plus icon doubles as the submit
          trigger so the toolbar stays tight. */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <Archive className="w-3.5 h-3.5" strokeWidth={2} style={{ color: 'var(--text-muted)' }} />
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Stash current changes (optional message)…"
          className="flex-1 bg-transparent border-none outline-none text-xs th-focus-ring"
          style={{ color: 'var(--text-primary)' }}
        />
        <button
          type="button"
          className="scm-row-action th-focus-ring"
          style={{ width: 22, height: 22 }}
          onClick={handlePush}
          title="Stash changes"
          aria-label="Stash changes"
        >
          <Plus className="w-3 h-3" strokeWidth={2} />
        </button>
      </div>

      {stashes.length === 0 ? (
        <div
          className="flex flex-col items-center text-center px-4 py-10 select-none"
          style={{ color: 'var(--text-muted)' }}
        >
          <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
            No stashes
          </div>
          <div className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
            Saved working-tree snapshots show up here.
          </div>
        </div>
      ) : (
        <div className="py-2">
          {stashes.map((stash) => {
            const idx = stash.index ?? 0;
            const branch = stash.branch || '';
            const message = stash.message || `stash@{${idx}}`;
            return (
              <div key={`stash-${idx}`} className="scm-row" style={{ paddingLeft: 14, marginBottom: 2 }}>
                <span className="scm-row-dot" aria-hidden="true" />
                <span className="scm-row-name" title={message}>{message}</span>
                {branch && (
                  <span className="scm-row-path" title={branch}>
                    on {branch}
                  </span>
                )}
                <span className="scm-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="scm-row-action"
                    title="Apply (keep stash)"
                    aria-label="Apply stash"
                    onClick={() => onApply?.(idx)}
                  >
                    <ArchiveRestore className="w-3 h-3" strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="scm-row-action"
                    title="Pop (apply and remove)"
                    aria-label="Pop stash"
                    onClick={() => onPop?.(idx)}
                  >
                    <Plus className="w-3 h-3" strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    className="scm-row-action scm-row-action--danger"
                    title="Drop stash"
                    aria-label="Drop stash"
                    onClick={() => onDrop?.(idx)}
                  >
                    <Trash2 className="w-3 h-3" strokeWidth={2} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const StashList = memo(StashListImpl);

export default StashList;
export { StashList };
