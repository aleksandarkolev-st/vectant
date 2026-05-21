'use client';

/**
 * FileRow — a single file in the Source Control panel.
 *
 * Pure presentational.  All git-state derivation lives here so the
 * parent (FileSections) can stay layout-focused.  The 5 status
 * letters (M/A/D/R/??/U) are derived from git's two-char porcelain
 * code; the visible badge is the more meaningful of the pair.
 *
 * Visual grammar comes entirely from scm-tokens.css:
 *   • Left-edge bar = section role  (staged gradient · changes
 *     hairline · conflict danger · active attention-purple)
 *   • Status dot    = working-tree state  (untracked = the one
 *     keep-color green; conflict pulses red; everything else muted)
 *   • Hover swap    = the status badge fades out; an icon-action row
 *     fades in (stage / unstage / diff / discard / resolve)
 */

import { memo, useCallback } from 'react';
import { Plus, Minus, Trash2, Edit3, CheckCircle2 } from 'lucide-react';

// ── Status derivation ──────────────────────────────────────────────
// Git porcelain v1 status is two chars: index + working_dir.
// For SCM display we collapse to the most user-relevant letter.
function deriveBadge(file) {
  // Conflict (any U/A combo) takes precedence — shows the U letter.
  if (file.index === 'U' || file.working_dir === 'U') return 'U';
  if (file.index === 'A' && file.working_dir === 'A') return 'AA';
  if (file.index === 'D' && file.working_dir === 'D') return 'DD';
  // Untracked
  if (file.index === '?' && file.working_dir === '?') return '??';
  // Staged side preferred (capital letter when index is set).
  if (file.index && file.index !== ' ') return file.index;
  if (file.working_dir && file.working_dir !== ' ') return file.working_dir;
  return '';
}

function deriveDotVariant({ section, file }) {
  if (section === 'conflict') return 'conflict';
  const badge = deriveBadge(file);
  if (badge === '??') return 'untracked';
  if (badge === 'D' || badge === 'DD') return 'deleted';
  return 'default';
}

function FileRowImpl({
  file,
  section,                // 'conflict' | 'staged' | 'changes'
  isActive = false,
  isRippling = false,     // briefly true after a stage/unstage transition
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onResolveOurs,
  onResolveTheirs,
  onMarkResolved,
}) {
  const badge = deriveBadge(file);
  const dotVariant = deriveDotVariant({ section, file });

  // Split path → name + parent dir for the two-line readout.
  const segments = (file.path || '').split('/');
  const name = segments[segments.length - 1];
  const parentDir = segments.length > 1 ? segments.slice(0, -1).join('/') : '';

  const handleClick = useCallback(() => {
    onOpenDiff?.(file);
  }, [file, onOpenDiff]);

  // Stop the row's click from firing when an inner action button is pressed.
  const stop = useCallback((e) => { e.stopPropagation(); }, []);

  const rowClass = [
    'scm-row',
    section === 'staged' ? 'scm-row--staged' : '',
    section === 'conflict' ? 'scm-row--conflict' : '',
    isActive ? 'is-active' : '',
    isRippling ? 'scm-row-ripple' : '',
  ].filter(Boolean).join(' ');

  const badgeClass = [
    'scm-row-badge',
    badge === '??' ? 'scm-row-badge--untracked' : '',
    section === 'conflict' ? 'scm-row-badge--conflict' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={rowClass}
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      title={file.path}
    >
      <span
        className={`scm-row-dot scm-row-dot--${dotVariant}`}
        aria-hidden="true"
      />

      <span className="scm-row-name">{name}</span>

      {parentDir && (
        <span className="scm-row-path" title={parentDir}>
          {parentDir}
        </span>
      )}

      {/* Status badge — replaced by action icons on hover (see CSS). */}
      <span
        className={badgeClass}
        aria-label={
          badge === '??' ? 'untracked'
            : badge === 'M' ? 'modified'
            : badge === 'A' ? 'added'
            : badge === 'D' ? 'deleted'
            : badge === 'R' ? 'renamed'
            : badge === 'U' ? 'conflict'
            : 'changed'
        }
      >
        {badge}
      </span>

      <span className="scm-row-actions" onClick={stop}>
        {section === 'conflict' ? (
          <>
            <button
              className="scm-row-action"
              onClick={(e) => { stop(e); onResolveOurs?.(file); }}
              title="Resolve using ours"
              aria-label="Resolve using ours"
              type="button"
            >
              <CheckCircle2 className="w-3 h-3" strokeWidth={2} />
            </button>
            <button
              className="scm-row-action"
              onClick={(e) => { stop(e); onResolveTheirs?.(file); }}
              title="Resolve using theirs"
              aria-label="Resolve using theirs"
              type="button"
            >
              <Edit3 className="w-3 h-3" strokeWidth={2} />
            </button>
            <button
              className="scm-row-action"
              onClick={(e) => { stop(e); onMarkResolved?.(file); }}
              title="Mark as resolved"
              aria-label="Mark as resolved"
              type="button"
            >
              <Plus className="w-3 h-3" strokeWidth={2} />
            </button>
          </>
        ) : section === 'staged' ? (
          <>
            <button
              className="scm-row-action"
              onClick={(e) => { stop(e); onOpenDiff?.(file); }}
              title="Open diff"
              aria-label="Open diff"
              type="button"
            >
              <Edit3 className="w-3 h-3" strokeWidth={2} />
            </button>
            <button
              className="scm-row-action"
              onClick={(e) => { stop(e); onUnstage?.(file); }}
              title="Unstage"
              aria-label="Unstage"
              type="button"
            >
              <Minus className="w-3 h-3" strokeWidth={2} />
            </button>
          </>
        ) : (
          <>
            <button
              className="scm-row-action"
              onClick={(e) => { stop(e); onOpenDiff?.(file); }}
              title="Open diff"
              aria-label="Open diff"
              type="button"
            >
              <Edit3 className="w-3 h-3" strokeWidth={2} />
            </button>
            <button
              className="scm-row-action"
              onClick={(e) => { stop(e); onStage?.(file); }}
              title="Stage"
              aria-label="Stage"
              type="button"
            >
              <Plus className="w-3 h-3" strokeWidth={2} />
            </button>
            <button
              className="scm-row-action scm-row-action--danger"
              onClick={(e) => { stop(e); onDiscard?.(file); }}
              title="Discard changes"
              aria-label="Discard changes"
              type="button"
            >
              <Trash2 className="w-3 h-3" strokeWidth={2} />
            </button>
          </>
        )}
      </span>
    </div>
  );
}

// Re-render only when the file path / status / active state changes —
// hover state and row-action visibility are CSS-only.
const FileRow = memo(FileRowImpl, (prev, next) => (
  prev.file?.path === next.file?.path
  && prev.file?.index === next.file?.index
  && prev.file?.working_dir === next.file?.working_dir
  && prev.section === next.section
  && prev.isActive === next.isActive
  && prev.isRippling === next.isRippling
  && prev.onOpenDiff === next.onOpenDiff
  && prev.onStage === next.onStage
  && prev.onUnstage === next.onUnstage
  && prev.onDiscard === next.onDiscard
  && prev.onResolveOurs === next.onResolveOurs
  && prev.onResolveTheirs === next.onResolveTheirs
  && prev.onMarkResolved === next.onMarkResolved
));

export default FileRow;
export { FileRow };
