'use client';

/**
 * SubViewPills — 3-tab pill switcher that selects which secondary
 * surface renders in the main scroll region of the SCM panel.
 *
 *   Files     — staged + unstaged + conflicts (default)
 *   History   — commit history list
 *   Stashes   — stash list
 *
 * Pull Requests stay in their own sidebar view (the activity bar
 * "pullrequests" entry); they are not folded into this switcher so
 * existing muscle memory keeps working.
 *
 * Visual grammar comes from scm-tokens.css (.scm-subview-pill +
 * the [data-state="active"] attention-purple treatment).
 */

import { memo, useCallback } from 'react';

const DEFAULT_TABS = [
  { id: 'files',   label: 'Files' },
  { id: 'history', label: 'History' },
  { id: 'stashes', label: 'Stashes' },
];

function SubViewPillsImpl({
  value = 'files',
  onChange,
  tabs = DEFAULT_TABS,
  counts = {},     // { files: 5, history: 42, stashes: 1 } — rendered after label when > 0
}) {
  const handleClick = useCallback((id) => {
    if (id !== value) onChange?.(id);
  }, [value, onChange]);

  return (
    <div className="scm-subviews" role="tablist" aria-label="Source control sub-views">
      {tabs.map(({ id, label }) => {
        const count = counts[id];
        const showCount = typeof count === 'number' && count > 0;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={value === id}
            tabIndex={value === id ? 0 : -1}
            data-state={value === id ? 'active' : 'inactive'}
            className="scm-subview-pill"
            onClick={() => handleClick(id)}
          >
            {label}
            {showCount && (
              <span
                className="ml-1.5"
                style={{
                  fontVariantNumeric: 'tabular-nums',
                  opacity: 0.7,
                  fontSize: '10px',
                }}
              >
                {count > 99 ? '99+' : count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

const SubViewPills = memo(SubViewPillsImpl);

export default SubViewPills;
export { SubViewPills };
