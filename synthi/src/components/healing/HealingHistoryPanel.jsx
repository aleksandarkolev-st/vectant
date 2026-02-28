// src/components/healing/HealingHistoryPanel.jsx
// Panel showing the history of self-healing events in the current session.
// Can be integrated into the problems panel or as a standalone dockable panel.
'use client';

import { useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectHealingEvents,
  selectAppliedFixes,
  selectHealingEnabled,
} from '@/redux/healingSelectors';
import { clearHealingEvents } from '@/redux/healingSlice';
import { Trash2, Check, Undo2, XCircle, Activity } from 'lucide-react';

// Category labels
const CAT_LABEL = {
  missing_colon: 'Missing colon',
  missing_semicolon: 'Missing semicolon',
  missing_bracket: 'Missing bracket',
  unused_import: 'Unused import',
  missing_import: 'Missing import',
  duplicate_import: 'Duplicate import',
  trailing_whitespace: 'Trailing whitespace',
  missing_newline_eof: 'Missing newline at EOF',
  none_comparison: 'None comparison',
  unclosed_string: 'Unclosed string',
  missing_include: 'Missing #include',
  trailing_comma: 'Trailing comma',
};

function formatCat(cat) {
  return CAT_LABEL[cat] || cat?.replace(/_/g, ' ') || 'unknown';
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

const EVENT_ICONS = {
  fix_applied: { Icon: Check, color: 'var(--accent-success)' },
  fix_undone: { Icon: Undo2, color: 'var(--accent-warning)' },
  fix_rejected: { Icon: XCircle, color: 'var(--text-muted)' },
  fix_confirmed: { Icon: Check, color: 'var(--accent-primary)' },
  bulk_undo: { Icon: Undo2, color: 'var(--accent-warning)' },
};

export function HealingHistoryPanel() {
  const dispatch = useDispatch();
  const events = useSelector(selectHealingEvents);
  const enabled = useSelector(selectHealingEnabled);

  const recentEvents = useMemo(
    () => (events || []).slice(0, 50),
    [events]
  );

  if (!enabled && recentEvents.length === 0) return null;

  return (
    <div
      className="flex flex-col min-h-0"
      style={{ color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-1.5 flex-shrink-0"
        style={{ background: 'var(--bg-elevated)' }}
      >
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
          <span
            className="text-xs font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            Healing History
          </span>
          <span
            className="text-[10px] font-mono"
            style={{ color: 'var(--text-dim)' }}
          >
            ({recentEvents.length})
          </span>
        </div>
        {recentEvents.length > 0 && (
          <button
            onClick={() => dispatch(clearHealingEvents())}
            className="p-0.5 rounded hover:opacity-80"
            style={{ color: 'var(--text-muted)' }}
            title="Clear history"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Event list */}
      <div className="overflow-y-auto flex-1 min-h-0">
        {recentEvents.length === 0 ? (
          <div
            className="px-3 py-4 text-xs text-center"
            style={{ color: 'var(--text-dim)' }}
          >
            No healing events yet
          </div>
        ) : (
          recentEvents.map((event, i) => {
            const { Icon, color } = EVENT_ICONS[event.type] || {
              Icon: Activity,
              color: 'var(--text-muted)',
            };
            return (
              <div
                key={`${event.type}-${event.timestamp}-${i}`}
                className="flex items-center gap-2 px-3 py-1 text-xs hover:opacity-90 transition-opacity"
                style={{
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <Icon
                  className="w-3 h-3 flex-shrink-0"
                  style={{ color }}
                />
                <div className="flex-1 min-w-0">
                  <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                    {event.type === 'fix_applied' && `Applied: ${formatCat(event.category)}`}
                    {event.type === 'fix_undone' && 'Fix undone'}
                    {event.type === 'fix_rejected' && 'Fix rejected'}
                    {event.type === 'fix_confirmed' && `Confirmed: ${formatCat(event.category)}`}
                    {event.type === 'bulk_undo' && `Reverted ${event.count} fixes`}
                  </span>
                </div>
                <span
                  className="text-[10px] flex-shrink-0"
                  style={{ color: 'var(--text-dim)' }}
                >
                  {timeAgo(event.timestamp)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default HealingHistoryPanel;
