'use client';

/**
 * FileSections — the middle, scrollable region of the SCM column.
 *
 * Renders three sections in this fixed order:
 *
 *   1. CONFLICTS   — files needing resolution (red left bar, priority)
 *   2. STAGED      — files ready to commit  (gradient left bar)
 *   3. CHANGES     — modified + untracked   (calm slate-violet hairline)
 *
 * Each section is hidden when empty.  When all three are empty, the
 * "clean state" placeholder is rendered.
 *
 * The Changes section is virtualized via Virtuoso when it gets long;
 * Staged and Conflicts are usually short enough to render inline.
 *
 * Cross-section transitions (file moving from Changes → Staged after
 * stage, etc.) get a `scm-row-ripple` modifier for ~2400ms via the
 * `ripplingPaths` Set passed by the parent.
 */

import { memo, useCallback, useMemo, forwardRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Plus, Minus, Trash2 } from 'lucide-react';
import { FileRow } from './FileRow';

const VIRTUALIZE_THRESHOLD = 80;   // rows beyond this count get virtualized

// Virtuoso accepts a forwardRef-able List component override so our
// row animations don't clip against the default flex boundary.
const ForwardedList = forwardRef(function ScmVirtuosoList(props, ref) {
  return <div {...props} ref={ref} />;
});

function SectionHeader({ title, count, actions }) {
  return (
    <div className="scm-section-header">
      <span>{title}</span>
      {count > 0 && (
        <span className="scm-section-header-count">{count}</span>
      )}
      {actions && (
        <span className="scm-section-header-actions">{actions}</span>
      )}
    </div>
  );
}

function CleanState() {
  return (
    <div
      className="flex flex-col items-center justify-center text-center px-4 py-10 select-none"
      style={{ color: 'var(--text-muted)' }}
    >
      <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>
        All caught up
      </div>
      <div className="text-[10px] mt-1" style={{ color: 'var(--text-dim)' }}>
        Nothing to commit.
      </div>
    </div>
  );
}

function FileSectionsImpl({
  files = [],             // full status.files array
  conflictedFiles = [],   // string[] of conflict paths
  activeFilePath = null,
  ripplingPaths = null,   // optional Set<string>
  // Action callbacks
  onOpenDiff,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onDiscard,
  onDiscardAll,
  onResolveOurs,
  onResolveTheirs,
  onMarkResolved,
}) {
  // Partition files into staged / changes; conflicts is its own list.
  const { staged, changes } = useMemo(() => {
    const s = [];
    const c = [];
    for (const f of files) {
      // Conflicts (U on either side, or AA/DD) are handled separately
      // via the conflictedFiles list — skip them here.
      if (f.index === 'U' || f.working_dir === 'U'
          || (f.index === 'A' && f.working_dir === 'A')
          || (f.index === 'D' && f.working_dir === 'D')) {
        continue;
      }
      if (f.index !== ' ' && f.index !== '?') s.push(f);
      if (f.working_dir !== ' ' || f.index === '?') c.push(f);
    }
    return { staged: s, changes: c };
  }, [files]);

  const isRippling = useCallback((path) => (
    ripplingPaths instanceof Set && ripplingPaths.has(path)
  ), [ripplingPaths]);

  const renderRow = useCallback((file, section) => (
    <FileRow
      key={`${section}-${file.path}`}
      file={file}
      section={section}
      isActive={activeFilePath === file.path}
      isRippling={isRippling(file.path)}
      onOpenDiff={onOpenDiff}
      onStage={onStage}
      onUnstage={onUnstage}
      onDiscard={onDiscard}
      onResolveOurs={onResolveOurs}
      onResolveTheirs={onResolveTheirs}
      onMarkResolved={onMarkResolved}
    />
  ), [activeFilePath, isRippling, onOpenDiff, onStage, onUnstage, onDiscard, onResolveOurs, onResolveTheirs, onMarkResolved]);

  // Map the conflict path list back to file-like objects so the
  // existing FileRow can render them.  Pull the original file
  // metadata where available so the badge resolves correctly.
  const conflictRows = useMemo(() => (
    conflictedFiles.map((path) => {
      const real = files.find((f) => f.path === path);
      return real || { path, index: 'U', working_dir: 'U' };
    })
  ), [conflictedFiles, files]);

  const hasAny = conflictRows.length > 0 || staged.length > 0 || changes.length > 0;

  if (!hasAny) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <CleanState />
      </div>
    );
  }

  // Virtualize the changes section when it gets long; conflicts and
  // staged stay rendered inline.
  const virtualizeChanges = changes.length > VIRTUALIZE_THRESHOLD;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto" data-scm-file-sections>
      {conflictRows.length > 0 && (
        <div className="scm-section">
          <SectionHeader title="Conflicts" count={conflictRows.length} />
          {conflictRows.map((f) => renderRow(f, 'conflict'))}
        </div>
      )}

      {staged.length > 0 && (
        <div className="scm-section">
          <SectionHeader
            title="Staged"
            count={staged.length}
            actions={(
              <button
                type="button"
                className="scm-row-action"
                style={{ width: 18, height: 18 }}
                title="Unstage all"
                aria-label="Unstage all"
                onClick={onUnstageAll}
              >
                <Minus className="w-3 h-3" strokeWidth={2} />
              </button>
            )}
          />
          {staged.map((f) => renderRow(f, 'staged'))}
        </div>
      )}

      {changes.length > 0 && (
        <div className="scm-section">
          <SectionHeader
            title="Changes"
            count={changes.length}
            actions={(
              <>
                <button
                  type="button"
                  className="scm-row-action"
                  style={{ width: 18, height: 18 }}
                  title="Stage all"
                  aria-label="Stage all"
                  onClick={onStageAll}
                >
                  <Plus className="w-3 h-3" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="scm-row-action scm-row-action--danger"
                  style={{ width: 18, height: 18 }}
                  title="Discard all"
                  aria-label="Discard all"
                  onClick={onDiscardAll}
                >
                  <Trash2 className="w-3 h-3" strokeWidth={2} />
                </button>
              </>
            )}
          />
          {virtualizeChanges ? (
            <Virtuoso
              style={{ height: 'min(60vh, 480px)' }}
              data={changes}
              itemContent={(_index, file) => renderRow(file, 'changes')}
              components={{ List: ForwardedList }}
            />
          ) : (
            changes.map((f) => renderRow(f, 'changes'))
          )}
        </div>
      )}
    </div>
  );
}

const FileSections = memo(FileSectionsImpl);

export default FileSections;
export { FileSections };
