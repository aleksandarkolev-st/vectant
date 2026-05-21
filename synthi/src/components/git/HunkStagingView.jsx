'use client';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { stageLines, discardLines } from '@/redux/gitSlice';
import { toast } from 'sonner';
import {
  Check, CheckSquare, Square, ChevronDown, ChevronRight,
  Plus, Minus, RefreshCw, X, Scissors, Undo2
} from 'lucide-react';
import { gitClient } from '@/services/gitClient';

/* ────────────────────────────────────────────────────────────
 *  HunkStagingView — Line/Hunk-level selective staging
 *
 *  Shows a parsed diff with per-line checkboxes.  Users can
 *  toggle individual lines or entire hunks, then click "Stage
 *  Selected" to produce a partial patch and apply it.
 *
 *  JetBrains-parity features:
 *  - Split Hunk: break large hunks at context-line boundaries
 *  - Revert Selected: discard changes in selected lines
 *  - Right-click context menu for stage/revert operations
 *  - Improved gutter checkboxes with hover indicators
 * ──────────────────────────────────────────────────────────── */

// ── Parse unified diff into a structured format ──────────────

function parseUnifiedDiff(raw) {
  if (!raw) return { header: '', hunks: [] };

  const lines = raw.split('\n');
  let header = '';
  const hunks = [];
  let currentHunk = null;
  let lineIdx = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      header = line;
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      header += '\n' + line;
    } else if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)/);
      if (match) {
        currentHunk = {
          id: hunks.length,
          header: line,
          oldStart: parseInt(match[1]),
          oldCount: match[2] !== '' ? parseInt(match[2]) : 1,
          newStart: parseInt(match[3]),
          newCount: match[4] !== '' ? parseInt(match[4]) : 1,
          context: match[5]?.trim() || '',
          lines: [],
        };
        hunks.push(currentHunk);
      }
    } else if (currentHunk) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
        currentHunk.lines.push({
          idx: lineIdx++,
          type: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context',
          content: line.substring(1),
          raw: line,
        });
      }
    }
  }

  return { header, hunks };
}

// ── Split a hunk at context-line boundaries ──────────────────
// Produces multiple smaller hunks whenever there are consecutive
// context lines separating change blocks (like JetBrains "Split Hunk").

function splitHunk(hunk) {
  const groups = [];
  let currentGroup = [];
  let consecutiveContext = 0;
  const SPLIT_THRESHOLD = 2;

  for (const line of hunk.lines) {
    if (line.type === 'context') {
      consecutiveContext++;
      if (consecutiveContext >= SPLIT_THRESHOLD && currentGroup.some(l => l.type !== 'context')) {
        groups.push([...currentGroup]);
        currentGroup = [line];
        consecutiveContext = 1;
      } else {
        currentGroup.push(line);
      }
    } else {
      consecutiveContext = 0;
      currentGroup.push(line);
    }
  }
  if (currentGroup.some(l => l.type !== 'context')) {
    groups.push(currentGroup);
  } else if (groups.length > 0) {
    groups[groups.length - 1].push(...currentGroup);
  }

  if (groups.length <= 1) return null;

  const result = [];
  let groupStartOld = hunk.oldStart;
  let groupStartNew = hunk.newStart;

  for (const group of groups) {
    let oCount = 0;
    let nCount = 0;
    for (const l of group) {
      if (l.type === 'context') { oCount++; nCount++; }
      else if (l.type === 'remove') { oCount++; }
      else if (l.type === 'add') { nCount++; }
    }

    result.push({
      id: 0,
      header: `@@ -${groupStartOld},${oCount} +${groupStartNew},${nCount} @@${hunk.context ? ' ' + hunk.context : ''}`,
      oldStart: groupStartOld,
      oldCount: oCount,
      newStart: groupStartNew,
      newCount: nCount,
      context: hunk.context,
      lines: group,
    });

    groupStartOld += oCount;
    groupStartNew += nCount;
  }

  return result;
}

// ── Build a valid unified-diff patch from selected lines ─────

function buildPatchFromSelection(header, hunks, selectedLines) {
  const patchParts = [];

  // We need the --- and +++ lines from the header
  const headerLines = header.split('\n');
  const diffLine = headerLines.find(l => l.startsWith('diff --git')) || '';
  const minusLine = headerLines.find(l => l.startsWith('---')) || '';
  const plusLine = headerLines.find(l => l.startsWith('+++')) || '';

  if (!minusLine || !plusLine) return null;

  let hasSelectedContent = false;

  for (const hunk of hunks) {
    const hunkSelectedLines = [];
    let hasSelection = false;

    for (const line of hunk.lines) {
      if (line.type === 'context') {
        // Context lines always go through
        hunkSelectedLines.push(line);
      } else if (selectedLines.has(line.idx)) {
        hunkSelectedLines.push(line);
        hasSelection = true;
      } else if (line.type === 'remove') {
        // Unselected remove → becomes context (keep old line)
        hunkSelectedLines.push({ ...line, type: 'context', raw: ' ' + line.content });
      }
      // Unselected add lines → just skip them
    }

    if (!hasSelection) continue;
    hasSelectedContent = true;

    // Recompute hunk header counts
    let oldCount = 0;
    let newCount = 0;
    for (const l of hunkSelectedLines) {
      if (l.type === 'context') { oldCount++; newCount++; }
      else if (l.type === 'remove') { oldCount++; }
      else if (l.type === 'add') { newCount++; }
    }

    const hunkHeader = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.context ? ' ' + hunk.context : ''}`;
    const hunkBody = hunkSelectedLines.map(l => {
      if (l.type === 'context') return ' ' + l.content;
      if (l.type === 'add') return '+' + l.content;
      if (l.type === 'remove') return '-' + l.content;
      return l.raw;
    }).join('\n');

    patchParts.push(hunkHeader + '\n' + hunkBody);
  }

  if (!hasSelectedContent) return null;

  return [diffLine, minusLine, plusLine, ...patchParts].join('\n') + '\n';
}

// ── Context Menu ─────────────────────────────────────────────

function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-[999] rounded shadow-xl py-1 min-w-[180px] border"
      style={{ left: x, top: y, background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)' }}
    >
      {items.map((item, i) => (
        item.separator ? (
          <div key={i} className="border-t border-[var(--border-medium)] my-1" />
        ) : (
          <button
            key={i}
            onClick={() => { item.action(); onClose(); }}
            disabled={item.disabled}
            className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--attention-purple)_15%,transparent)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {item.icon && <item.icon className="w-3 h-3 text-[var(--text-muted)]" />}
            {item.label}
            {item.shortcut && (
              <span className="ml-auto text-[10px] text-[var(--text-dim)]">{item.shortcut}</span>
            )}
          </button>
        )
      ))}
    </div>
  );
}

// ── Hunk component ───────────────────────────────────────────

function HunkBlock({ hunk, selectedLines, onToggleLine, onToggleHunk, onSplitHunk, canSplit, onContextMenu }) {
  const [collapsed, setCollapsed] = useState(false);

  const allChangeLinesSelected = useMemo(() => {
    const changeLines = hunk.lines.filter(l => l.type !== 'context');
    return changeLines.length > 0 && changeLines.every(l => selectedLines.has(l.idx));
  }, [hunk, selectedLines]);

  const someChangeLinesSelected = useMemo(() => {
    return hunk.lines.some(l => l.type !== 'context' && selectedLines.has(l.idx));
  }, [hunk, selectedLines]);

  const changeCount = useMemo(() => {
    return hunk.lines.filter(l => l.type !== 'context').length;
  }, [hunk]);

  let oldLineNum = hunk.oldStart;
  let newLineNum = hunk.newStart;

  return (
    <div className="border border-[var(--border-subtle)] rounded overflow-hidden">
      {/* Hunk header */}
      <div className="flex items-center gap-1 px-2 py-1 bg-[var(--bg-elevated)] border-b border-[var(--border-subtle)]">
        <button onClick={() => setCollapsed(!collapsed)} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        <button
          onClick={() => onToggleHunk(hunk)}
          className="flex items-center gap-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
          title={allChangeLinesSelected ? 'Deselect entire hunk' : 'Select entire hunk'}
        >
          {allChangeLinesSelected
            ? <CheckSquare className="w-3.5 h-3.5 text-[var(--attention-purple)]" />
            : someChangeLinesSelected
              ? <CheckSquare className="w-3.5 h-3.5 text-[color-mix(in_srgb,var(--attention-purple)_50%,transparent)]" />
              : <Square className="w-3.5 h-3.5" />
          }
        </button>
        <span className="text-[10px] font-mono text-[var(--accent-secondary)] truncate flex-1">{hunk.header}</span>
        <span className="text-[9px] text-[var(--text-dim)] flex-shrink-0 mr-1">
          {changeCount} change{changeCount !== 1 ? 's' : ''}
        </span>
        {canSplit && (
          <button
            onClick={() => onSplitHunk(hunk)}
            className="flex items-center gap-0.5 text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] px-1 py-0.5 rounded transition-colors"
            title="Split this hunk into smaller pieces"
          >
            <Scissors className="w-3 h-3" />
            <span>Split</span>
          </button>
        )}
      </div>

      {/* Hunk lines */}
      {!collapsed && (
        <div className="font-mono text-[11px] leading-[18px]">
          {hunk.lines.map(line => {
            const isChange = line.type !== 'context';
            const isSelected = selectedLines.has(line.idx);

            // Calculate line numbers
            let oldLn = '';
            let newLn = '';
            if (line.type === 'context') {
              oldLn = oldLineNum++;
              newLn = newLineNum++;
            } else if (line.type === 'remove') {
              oldLn = oldLineNum++;
            } else {
              newLn = newLineNum++;
            }

            const bgColor = line.type === 'add'
              ? (isSelected ? 'bg-[color-mix(in_srgb,var(--accent-success)_15%,transparent)]' : 'bg-[color-mix(in_srgb,var(--accent-success)_5%,transparent)]')
              : line.type === 'remove'
                ? (isSelected ? 'bg-[color-mix(in_srgb,var(--accent-danger)_15%,transparent)]' : 'bg-[color-mix(in_srgb,var(--accent-danger)_5%,transparent)]')
                : '';

            return (
              <div
                key={line.idx}
                className={`flex items-stretch hover:bg-white/5 ${bgColor} group/line`}
                onContextMenu={(e) => {
                  if (isChange) {
                    e.preventDefault();
                    onContextMenu(e, line);
                  }
                }}
              >
                {/* Checkbox gutter */}
                <div className={`w-6 flex-shrink-0 flex items-center justify-center border-r border-[color-mix(in_srgb,var(--border-subtle)_50%,transparent)] ${
                  isChange ? 'cursor-pointer hover:bg-[color-mix(in_srgb,var(--attention-purple)_10%,transparent)]' : ''
                }`}>
                  {isChange ? (
                    <button
                      onClick={() => onToggleLine(line.idx)}
                      className="w-full h-full flex items-center justify-center"
                    >
                      {isSelected ? (
                        <div className="w-3 h-3 rounded-sm bg-[var(--attention-purple)] flex items-center justify-center">
                          <Check className="w-2 h-2 text-white" />
                        </div>
                      ) : (
                        <div className="w-3 h-3 rounded-sm border border-[var(--border-medium)] group-hover/line:border-[color-mix(in_srgb,var(--attention-purple)_50%,transparent)] transition-colors" />
                      )}
                    </button>
                  ) : null}
                </div>
                {/* Old line number */}
                <span className="w-8 text-right pr-1 text-[var(--text-dim)] select-none flex-shrink-0 border-r border-[color-mix(in_srgb,var(--border-subtle)_30%,transparent)]">
                  {oldLn}
                </span>
                {/* New line number */}
                <span className="w-8 text-right pr-1 text-[var(--text-dim)] select-none flex-shrink-0 border-r border-[color-mix(in_srgb,var(--border-subtle)_30%,transparent)]">
                  {newLn}
                </span>
                {/* +/- prefix */}
                <span className={`w-4 text-center flex-shrink-0 ${
                  line.type === 'add' ? 'text-[var(--accent-success)]' : line.type === 'remove' ? 'text-[var(--accent-danger)]' : 'text-[var(--text-dim)]'
                }`}>
                  {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                </span>
                {/* Content */}
                <span className={`flex-1 pr-2 whitespace-pre overflow-x-auto ${
                  line.type === 'add' ? 'text-[var(--accent-success)]' : line.type === 'remove' ? 'text-[var(--accent-danger)]' : 'text-[var(--text-secondary)]'
                }`}>
                  {line.content}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────

export default function HunkStagingView({ slug, filePath, onClose }) {
  const dispatch = useDispatch();
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);
  const [staging, setStaging] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [selectedLines, setSelectedLines] = useState(new Set());
  const [error, setError] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  // Fetch diff on mount
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const raw = await gitClient.getDiff(slug, filePath, false);
        if (!cancelled) {
          const parsed = parseUnifiedDiff(typeof raw === 'string' ? raw : raw?.raw || '');
          setDiff(parsed);

          // Pre-select all change lines
          const allChangeIdxs = new Set();
          for (const hunk of parsed.hunks) {
            for (const line of hunk.lines) {
              if (line.type !== 'context') allChangeIdxs.add(line.idx);
            }
          }
          setSelectedLines(allChangeIdxs);
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Failed to load diff');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [slug, filePath]);

  const toggleLine = useCallback((idx) => {
    setSelectedLines(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const toggleHunk = useCallback((hunk) => {
    setSelectedLines(prev => {
      const next = new Set(prev);
      const changeLines = hunk.lines.filter(l => l.type !== 'context');
      const allSelected = changeLines.every(l => next.has(l.idx));
      for (const l of changeLines) {
        if (allSelected) next.delete(l.idx);
        else next.add(l.idx);
      }
      return next;
    });
  }, []);

  // Split a hunk into sub-hunks
  const handleSplitHunk = useCallback((hunk) => {
    if (!diff) return;
    const subHunks = splitHunk(hunk);
    if (!subHunks) {
      toast.info('This hunk cannot be split further');
      return;
    }
    const newHunks = [];
    let idCounter = 0;
    for (const h of diff.hunks) {
      if (h.id === hunk.id) {
        for (const sh of subHunks) {
          newHunks.push({ ...sh, id: idCounter++ });
        }
      } else {
        newHunks.push({ ...h, id: idCounter++ });
      }
    }
    setDiff({ ...diff, hunks: newHunks });
    toast.success(`Split into ${subHunks.length} hunks`);
  }, [diff]);

  const canSplitHunk = useCallback((hunk) => {
    let hasSeenChange = false;
    let contextAfterChange = 0;
    for (const line of hunk.lines) {
      if (line.type !== 'context') {
        if (contextAfterChange >= 2 && hasSeenChange) return true;
        hasSeenChange = true;
        contextAfterChange = 0;
      } else {
        if (hasSeenChange) contextAfterChange++;
      }
    }
    return false;
  }, []);

  const selectAll = useCallback(() => {
    if (!diff) return;
    const all = new Set();
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== 'context') all.add(line.idx);
      }
    }
    setSelectedLines(all);
  }, [diff]);

  const selectNone = useCallback(() => {
    setSelectedLines(new Set());
  }, []);

  const selectedCount = useMemo(() => {
    return selectedLines.size;
  }, [selectedLines]);

  const totalChangeLines = useMemo(() => {
    if (!diff) return 0;
    let count = 0;
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type !== 'context') count++;
      }
    }
    return count;
  }, [diff]);

  const handleStageSelected = useCallback(async () => {
    if (!diff || selectedLines.size === 0) return;
    const patch = buildPatchFromSelection(diff.header, diff.hunks, selectedLines);
    if (!patch) {
      toast.error('No lines selected to stage');
      return;
    }
    setStaging(true);
    try {
      const result = await dispatch(stageLines({ slug, filePath, patch }));
      if (stageLines.fulfilled.match(result)) {
        toast.success(`Staged ${selectedLines.size} line${selectedLines.size !== 1 ? 's' : ''} from ${filePath.split('/').pop()}`);
        if (onClose) onClose();
      } else {
        toast.error(result.error?.message || 'Failed to stage selected lines');
      }
    } catch (e) {
      toast.error(e.message || 'Failed to stage selected lines');
    } finally {
      setStaging(false);
    }
  }, [diff, selectedLines, dispatch, slug, filePath, onClose]);

  const handleRevertSelected = useCallback(async () => {
    if (!diff || selectedLines.size === 0) return;
    const patch = buildPatchFromSelection(diff.header, diff.hunks, selectedLines);
    if (!patch) {
      toast.error('No lines selected to revert');
      return;
    }
    setReverting(true);
    try {
      const result = await dispatch(discardLines({ slug, filePath, patch }));
      if (discardLines.fulfilled.match(result)) {
        toast.success(`Reverted ${selectedLines.size} line${selectedLines.size !== 1 ? 's' : ''} in ${filePath.split('/').pop()}`);
        if (onClose) onClose();
      } else {
        toast.error(result.error?.message || 'Failed to revert selected lines');
      }
    } catch (e) {
      toast.error(e.message || 'Failed to revert selected lines');
    } finally {
      setReverting(false);
    }
  }, [diff, selectedLines, dispatch, slug, filePath, onClose]);

  // Context menu handler for right-click on lines
  const handleLineContextMenu = useCallback((e, line) => {
    const isSelected = selectedLines.has(line.idx);
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: isSelected ? 'Deselect Line' : 'Select Line',
          icon: isSelected ? Square : CheckSquare,
          action: () => toggleLine(line.idx),
        },
        { separator: true },
        {
          label: 'Stage Selected Lines',
          icon: Plus,
          shortcut: 'Ctrl+Enter',
          disabled: selectedLines.size === 0,
          action: handleStageSelected,
        },
        {
          label: 'Revert Selected Lines',
          icon: Undo2,
          disabled: selectedLines.size === 0,
          action: handleRevertSelected,
        },
        { separator: true },
        {
          label: 'Select All Lines',
          icon: CheckSquare,
          action: selectAll,
        },
        {
          label: 'Deselect All',
          icon: Square,
          action: selectNone,
        },
      ],
    });
  }, [selectedLines, toggleLine, handleStageSelected, handleRevertSelected, selectAll, selectNone]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        handleStageSelected();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleStageSelected]);

  const fileName = filePath?.split('/').pop() || filePath;
  const isBusy = staging || reverting;

  return (
    <div className="flex flex-col h-full bg-[var(--bg-app)] text-[var(--text-primary)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)] bg-[var(--bg-panel)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{fileName}</span>
          <span className="text-[10px] text-[var(--text-dim)] truncate" title={filePath}>{filePath}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] text-[var(--text-muted)]">
            {selectedCount}/{totalChangeLines} lines
          </span>
          <button onClick={selectAll} className="text-[10px] text-[var(--attention-purple)] hover:opacity-80 transition-colors">
            All
          </button>
          <button onClick={selectNone} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors">
            None
          </button>
          {onClose && (
            <button onClick={onClose} className="hover:bg-[var(--bg-elevated)] p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)]">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-4 h-4 animate-spin text-[var(--attention-purple)]" />
            <span className="ml-2 text-xs text-[var(--text-muted)]">Loading diff…</span>
          </div>
        ) : error ? (
          <div className="p-4 text-center">
            <p className="text-xs text-[var(--accent-danger)]">{error}</p>
          </div>
        ) : !diff || diff.hunks.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-xs text-[var(--text-dim)] italic">No diff available for this file</p>
          </div>
        ) : (
          <div className="p-2 space-y-2">
            {diff.hunks.map(hunk => (
              <HunkBlock
                key={hunk.id}
                hunk={hunk}
                selectedLines={selectedLines}
                onToggleLine={toggleLine}
                onToggleHunk={toggleHunk}
                onSplitHunk={handleSplitHunk}
                canSplit={canSplitHunk(hunk)}
                onContextMenu={handleLineContextMenu}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer / Action buttons */}
      {diff && diff.hunks.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-[var(--border-subtle)] bg-[var(--bg-panel)]">
          <span className="text-[10px] text-[var(--text-dim)]">
            Right-click lines for more options · Ctrl+Enter to stage
          </span>
          <div className="flex items-center gap-2">
            {/* Revert Selected button */}
            <button
              onClick={handleRevertSelected}
              disabled={isBusy || selectedCount === 0}
              className="flex items-center gap-1.5 bg-[var(--bg-elevated)] hover:opacity-90 border border-[var(--border-medium)] disabled:opacity-50 disabled:cursor-not-allowed text-[var(--text-primary)] px-3 py-1 rounded text-xs font-medium transition-colors"
            >
              {reverting ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : (
                <Undo2 className="w-3 h-3" />
              )}
              Revert ({selectedCount})
            </button>
            {/* Stage Selected button */}
            <button
              onClick={handleStageSelected}
              disabled={isBusy || selectedCount === 0}
              className="flex items-center gap-1.5 bg-[var(--attention-purple)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1 rounded text-xs font-medium transition-colors"
            >
              {staging ? (
                <RefreshCw className="w-3 h-3 animate-spin" />
              ) : (
                <Plus className="w-3 h-3" />
              )}
              Stage ({selectedCount})
            </button>
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

export { parseUnifiedDiff, buildPatchFromSelection };
