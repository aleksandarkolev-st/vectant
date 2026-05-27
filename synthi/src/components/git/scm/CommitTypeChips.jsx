'use client';

/**
 * CommitTypeChips — a controlled row of conventional-commit type
 * pills (feat / fix / docs / refactor / chore).  Selecting a chip
 * prepends the corresponding `type: ` to the commit message,
 * replacing any existing prefix.
 *
 * Replaces the emoji button row in the legacy GitStatus.jsx commit
 * composer.  Same five core types, but in chip form so the composer
 * area can stay compact.
 *
 * Selection is exclusive — clicking the active chip clears the
 * prefix.  The selected chip uses the attention-purple data-state
 * pattern already defined in scm-tokens.css.
 */

import { memo, useCallback } from 'react';

const TYPES = [
  { type: 'feat',     label: 'feat' },
  { type: 'fix',      label: 'fix' },
  { type: 'docs',     label: 'docs' },
  { type: 'refactor', label: 'refactor' },
  { type: 'chore',    label: 'chore' },
];

// Match an existing CC prefix at the start of the message so we can
// replace it cleanly on chip click.  Captures the prefix + scope + !
// + ': '  so we can lop it off in one go.
const CC_PREFIX_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\([^)]*\))?(!)?:\s*/;

function detectActiveType(message) {
  if (!message) return null;
  const m = message.match(CC_PREFIX_RE);
  return m ? m[1] : null;
}

function CommitTypeChipsImpl({ message, onChange }) {
  const active = detectActiveType(message);

  const handleClick = useCallback((nextType) => {
    if (active === nextType) {
      // Clicking the active chip clears the prefix.
      const stripped = (message || '').replace(CC_PREFIX_RE, '');
      onChange?.(stripped);
      return;
    }
    const body = (message || '').replace(CC_PREFIX_RE, '');
    onChange?.(`${nextType}: ${body}`);
  }, [active, message, onChange]);

  return (
    <div className="flex items-center gap-1.5 flex-nowrap" role="group" aria-label="Commit type">
      {TYPES.map(({ type, label }) => (
        <button
          key={type}
          type="button"
          className="scm-type-chip shrink-0"
          data-state={active === type ? 'active' : 'inactive'}
          aria-pressed={active === type}
          onClick={() => handleClick(type)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const CommitTypeChips = memo(CommitTypeChipsImpl);

export default CommitTypeChips;
export { CommitTypeChips };
