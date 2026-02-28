// src/components/healing/AIActivityTimeline.jsx
// Compact timeline showing recent AI fix actions (applied / dismissed).
//
// Designed to sit in a sidebar or panel footer so the user has
// visibility into what the AI has been doing.

import React, { useMemo } from 'react';

const ACTION_META = {
  applied:      { icon: '✅', label: 'Applied',      color: '#238636' },
  auto_applied: { icon: '⚡', label: 'Auto-applied', color: '#1f6feb' },
  dismissed:    { icon: '❌', label: 'Dismissed',     color: '#da3633' },
  modified:     { icon: '✏️', label: 'Modified',      color: '#e3b341' },
};

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * @param {Object}  props
 * @param {Array}   props.entries  – from aiFixHistory.entries() or hook.getFixHistory()
 * @param {number}  [props.maxItems=15] – how many to show
 * @param {string}  [props.filterFile]  – only show entries for this file
 */
export function AIActivityTimeline({ entries = [], maxItems = 15, filterFile }) {
  const visible = useMemo(() => {
    let list = entries;
    if (filterFile) {
      list = list.filter((e) => e.filePath === filterFile);
    }
    return list.slice(0, maxItems);
  }, [entries, maxItems, filterFile]);

  if (visible.length === 0) {
    return (
      <div style={{ padding: 12, fontSize: 12, opacity: 0.5, textAlign: 'center' }}>
        No AI fix activity yet.
      </div>
    );
  }

  return (
    <div className="ai-activity-timeline" style={{ fontSize: 12 }}>
      {visible.map((entry) => {
        const meta = ACTION_META[entry.action] || ACTION_META.applied;
        return (
          <div
            key={entry.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '4px 8px',
              borderLeft: `2px solid ${meta.color}`,
              marginBottom: 2,
            }}
          >
            <span style={{ flexShrink: 0, fontSize: 13 }}>{meta.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {entry.description || entry.ruleId || 'AI fix'}
              </div>
              <div style={{ opacity: 0.6, fontSize: 11 }}>
                {entry.filePath ? entry.filePath.split('/').pop() : ''}{' '}
                {entry.line != null ? `L${entry.line + 1}` : ''}{' '}
                · {relativeTime(entry.timestamp)}
              </div>
            </div>
            <span
              style={{
                flexShrink: 0,
                fontSize: 10,
                fontWeight: 600,
                color: meta.color,
                textTransform: 'uppercase',
              }}
            >
              {meta.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
