// src/components/healing/HealingHistoryPanel.jsx
// Time-travel view of recently applied healing fixes.
//
// Each row summarises one fix; clicking expands an inline diff of the
// before/after text pulled straight from the undo stack.  "Revert to here"
// walks Monaco's native undo down to that point, so the text state stays
// consistent even when fixes overlap.
//
// Revert is dispatched via a window CustomEvent so this panel stays
// decoupled from the Monaco editor (which only page.jsx owns).

'use client';

import { useState, useCallback } from 'react';
import { useSelector } from 'react-redux';
import {
  selectAppliedFixes,
  selectUndoStack,
} from '@/redux/healingSelectors';
import { History, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';

const HEAL_REVERT_EVENT = 'synthi:heal-revert-to-fix';

function fmtTime(ts) {
  if (!ts) return '';
  const delta = Date.now() - ts;
  if (delta < 60_000)       return 'just now';
  if (delta < 3_600_000)    return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000)   return `${Math.round(delta / 3_600_000)}h ago`;
  return new Date(ts).toLocaleString();
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split('/');
  return parts[parts.length - 1];
}

function humanCategory(cat) {
  return (cat || 'issue').replace(/_/g, ' ');
}

// ── Inline diff for a single fix ────────────────────────────────────────
// Pure text rendering: no syntax highlighting (individual fixes are tiny
// enough that raw text is readable).  Removed lines in muted red, added
// in muted green, mirroring VS Code / GitHub conventions.
function FixDiff({ originalText, replacementText }) {
  const oldLines = (originalText ?? '').split('\n');
  const newLines = (replacementText ?? '').split('\n');

  return (
    <div
      className="mt-1.5 p-2 rounded-md font-mono text-[11px] leading-relaxed overflow-x-auto"
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {oldLines.map((line, i) => (
        <div
          key={`o-${i}`}
          style={{
            color: 'color-mix(in srgb, var(--accent-danger) 85%, white 15%)',
            background: 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
          }}
        >
          <span className="select-none opacity-70">- </span>
          {line || ' '}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div
          key={`n-${i}`}
          style={{
            color: 'color-mix(in srgb, var(--accent-success) 85%, white 15%)',
            background: 'color-mix(in srgb, var(--accent-success) 8%, transparent)',
          }}
        >
          <span className="select-none opacity-70">+ </span>
          {line || ' '}
        </div>
      ))}
    </div>
  );
}

// ── Single row ──────────────────────────────────────────────────────────
function HistoryRow({ fix, undoEntry, isUndoable, onRevert }) {
  const [expanded, setExpanded] = useState(false);
  const Chev = expanded ? ChevronDown : ChevronRight;

  const handleRevert = useCallback((e) => {
    e.stopPropagation();
    onRevert?.(fix.id);
  }, [fix.id, onRevert]);

  return (
    <div
      className="rounded-md"
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 px-2 py-1.5 text-left"
      >
        <Chev
          className="w-3 h-3 mt-0.5 flex-shrink-0"
          style={{ color: 'var(--text-muted)' }}
        />
        <div className="flex-1 min-w-0">
          <div
            className="text-xs truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {humanCategory(fix.category)}
            {fix.description && fix.description !== fix.category && (
              <span style={{ color: 'var(--text-muted)' }}>
                {' — '}{fix.description}
              </span>
            )}
          </div>
          <div
            className="flex items-center gap-2 mt-0.5 text-[10px]"
            style={{ color: 'var(--text-dim)' }}
          >
            <span>{fmtTime(fix.appliedAt)}</span>
            {fix.filePath && (
              <>
                <span>·</span>
                <span className="truncate" title={fix.filePath}>
                  {shortPath(fix.filePath)}
                </span>
              </>
            )}
            {fix.source && (
              <>
                <span>·</span>
                <span>{fix.source.replace(/_/g, ' ')}</span>
              </>
            )}
          </div>
        </div>
        {isUndoable && (
          <span
            onClick={handleRevert}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') handleRevert(e);
            }}
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 flex-shrink-0 cursor-pointer"
            style={{
              background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)',
            }}
            title="Revert to the state just before this fix was applied"
          >
            <RotateCcw className="w-2.5 h-2.5" />
            Revert to here
          </span>
        )}
      </button>

      {expanded && undoEntry && (
        <div className="px-2 pb-2">
          <FixDiff
            originalText={undoEntry.originalText}
            replacementText={fix.replacementText}
          />
        </div>
      )}
      {expanded && !undoEntry && (
        <div
          className="px-2 pb-2 text-[10px] italic"
          style={{ color: 'var(--text-dim)' }}
        >
          No diff available (undo entry purged).
        </div>
      )}
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────────
export function HealingHistoryPanel() {
  const applied = useSelector(selectAppliedFixes);
  const undoStack = useSelector(selectUndoStack);
  const [open, setOpen] = useState(false);

  // Build a fast map: applied fix id → undo entry, so the diff view can
  // render without an O(n) find on every render.
  const undoById = {};
  for (const u of undoStack) {
    if (u?.fixId) undoById[u.fixId] = u;
  }
  const undoableIds = new Set(undoStack.map((u) => u.fixId).filter(Boolean));

  const handleRevert = useCallback((fixId) => {
    if (typeof window === 'undefined' || !fixId) return;
    window.dispatchEvent(new CustomEvent(HEAL_REVERT_EVENT, { detail: { fixId } }));
  }, []);

  if (!applied || applied.length === 0) return null;

  const recent = applied.slice(0, 20);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        <History className="w-3 h-3" />
        <span>{open ? '▾' : '▸'}</span>
        <span>Recent fixes ({applied.length})</span>
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-1.5">
          {recent.map((fix) => (
            <HistoryRow
              key={fix.id || `${fix.appliedAt}-${fix.category}`}
              fix={fix}
              undoEntry={undoById[fix.id]}
              isUndoable={undoableIds.has(fix.id)}
              onRevert={handleRevert}
            />
          ))}
          {applied.length > recent.length && (
            <div
              className="text-[10px] text-center py-1"
              style={{ color: 'var(--text-dim)' }}
            >
              + {applied.length - recent.length} older fixes
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const HEAL_REVERT_EVENT_NAME = HEAL_REVERT_EVENT;
export default HealingHistoryPanel;
