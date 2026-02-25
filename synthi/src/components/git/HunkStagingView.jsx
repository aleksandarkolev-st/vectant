'use client';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useDispatch } from 'react-redux';
import { stageLines } from '@/redux/gitSlice';
import { toast } from 'sonner';
import {
  Check, CheckSquare, Square, ChevronDown, ChevronRight,
  Plus, Minus, RefreshCw, X
} from 'lucide-react';
import gitClient from '@/services/gitClient';

/* ────────────────────────────────────────────────────────────
 *  HunkStagingView — Line/Hunk-level selective staging
 *
 *  Shows a parsed diff with per-line checkboxes.  Users can
 *  toggle individual lines or entire hunks, then click "Stage
 *  Selected" to produce a partial patch and apply it.
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

// ── Hunk component ───────────────────────────────────────────

function HunkBlock({ hunk, selectedLines, onToggleLine, onToggleHunk }) {
  const [collapsed, setCollapsed] = useState(false);

  const allChangeLinesSelected = useMemo(() => {
    const changeLines = hunk.lines.filter(l => l.type !== 'context');
    return changeLines.length > 0 && changeLines.every(l => selectedLines.has(l.idx));
  }, [hunk, selectedLines]);

  const someChangeLinesSelected = useMemo(() => {
    return hunk.lines.some(l => l.type !== 'context' && selectedLines.has(l.idx));
  }, [hunk, selectedLines]);

  let oldLineNum = hunk.oldStart;
  let newLineNum = hunk.newStart;

  return (
    <div className="border border-[#27272a] rounded overflow-hidden">
      {/* Hunk header */}
      <div className="flex items-center gap-1 px-2 py-1 bg-[#1a1a2e] border-b border-[#27272a]">
        <button onClick={() => setCollapsed(!collapsed)} className="text-[#71717a] hover:text-[#a1a1aa]">
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
        <button
          onClick={() => onToggleHunk(hunk)}
          className="flex items-center gap-1 text-[#71717a] hover:text-[#a1a1aa]"
          title={allChangeLinesSelected ? 'Deselect entire hunk' : 'Select entire hunk'}
        >
          {allChangeLinesSelected
            ? <CheckSquare className="w-3.5 h-3.5 text-[#3b82f6]" />
            : someChangeLinesSelected
              ? <CheckSquare className="w-3.5 h-3.5 text-[#3b82f6]/50" />
              : <Square className="w-3.5 h-3.5" />
          }
        </button>
        <span className="text-[10px] font-mono text-[#6366f1]">{hunk.header}</span>
        {hunk.context && (
          <span className="text-[10px] text-[#52525b] ml-1 truncate">{hunk.context}</span>
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
              ? (isSelected ? 'bg-emerald-500/15' : 'bg-emerald-500/5')
              : line.type === 'remove'
                ? (isSelected ? 'bg-red-500/15' : 'bg-red-500/5')
                : '';

            return (
              <div key={line.idx} className={`flex items-stretch hover:bg-white/5 ${bgColor}`}>
                {/* Checkbox area */}
                <div className="w-6 flex-shrink-0 flex items-center justify-center border-r border-[#27272a]/50">
                  {isChange ? (
                    <button
                      onClick={() => onToggleLine(line.idx)}
                      className="w-full h-full flex items-center justify-center"
                    >
                      {isSelected
                        ? <Check className="w-2.5 h-2.5 text-[#3b82f6]" />
                        : <span className="w-2.5 h-2.5" />
                      }
                    </button>
                  ) : null}
                </div>
                {/* Old line number */}
                <span className="w-8 text-right pr-1 text-[#3f3f46] select-none flex-shrink-0 border-r border-[#27272a]/30">
                  {oldLn}
                </span>
                {/* New line number */}
                <span className="w-8 text-right pr-1 text-[#3f3f46] select-none flex-shrink-0 border-r border-[#27272a]/30">
                  {newLn}
                </span>
                {/* +/- prefix */}
                <span className={`w-4 text-center flex-shrink-0 ${
                  line.type === 'add' ? 'text-emerald-400' : line.type === 'remove' ? 'text-red-400' : 'text-[#3f3f46]'
                }`}>
                  {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
                </span>
                {/* Content */}
                <span className={`flex-1 pr-2 whitespace-pre overflow-x-auto ${
                  line.type === 'add' ? 'text-emerald-300' : line.type === 'remove' ? 'text-red-300' : 'text-[#a1a1aa]'
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
  const [selectedLines, setSelectedLines] = useState(new Set());
  const [error, setError] = useState(null);

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

  const handleStageSelected = async () => {
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
        toast.success(`Staged ${selectedCount} line${selectedCount !== 1 ? 's' : ''} from ${filePath.split('/').pop()}`);
        if (onClose) onClose();
      } else {
        toast.error(result.error?.message || 'Failed to stage selected lines');
      }
    } catch (e) {
      toast.error(e.message || 'Failed to stage selected lines');
    } finally {
      setStaging(false);
    }
  };

  const fileName = filePath?.split('/').pop() || filePath;

  return (
    <div className="flex flex-col h-full bg-[#0a0a0b] text-[#e4e4e7]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a] bg-[#111113]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-[#e4e4e7] truncate">{fileName}</span>
          <span className="text-[10px] text-[#52525b] truncate" title={filePath}>{filePath}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[10px] text-[#71717a]">
            {selectedCount}/{totalChangeLines} lines
          </span>
          <button onClick={selectAll} className="text-[10px] text-[#3b82f6] hover:text-[#60a5fa] transition-colors">
            All
          </button>
          <button onClick={selectNone} className="text-[10px] text-[#71717a] hover:text-[#a1a1aa] transition-colors">
            None
          </button>
          {onClose && (
            <button onClick={onClose} className="hover:bg-[#27272a] p-0.5 rounded text-[#71717a] hover:text-[#e4e4e7]">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="w-4 h-4 animate-spin text-[#3b82f6]" />
            <span className="ml-2 text-xs text-[#71717a]">Loading diff…</span>
          </div>
        ) : error ? (
          <div className="p-4 text-center">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        ) : !diff || diff.hunks.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-xs text-[#52525b] italic">No diff available for this file</p>
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
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer / Stage button */}
      {diff && diff.hunks.length > 0 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-[#27272a] bg-[#111113]">
          <span className="text-[10px] text-[#52525b]">
            Tip: Click checkboxes to select lines, or use hunk toggles
          </span>
          <button
            onClick={handleStageSelected}
            disabled={staging || selectedCount === 0}
            className="flex items-center gap-1.5 bg-[#3b82f6] hover:bg-[#2563eb] disabled:opacity-50 disabled:cursor-not-allowed text-white px-3 py-1 rounded text-xs font-medium transition-colors"
          >
            {staging ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : (
              <Plus className="w-3 h-3" />
            )}
            Stage Selected ({selectedCount})
          </button>
        </div>
      )}
    </div>
  );
}

export { parseUnifiedDiff, buildPatchFromSelection };
