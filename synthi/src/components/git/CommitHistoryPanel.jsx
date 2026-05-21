'use client';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchCommitHistory, cherryPickCommit, revertCommit, fetchCommitDetail,
  fetchGitStatus, fetchUnpushedCommits, createTag,
} from '@/redux/gitSlice';
import { selectGitLoading } from '@/redux/isolatedSelectors';
import { openCommitFileDiffThunk } from '@/redux/workspaceSlice';
import { toast } from 'sonner';
import {
  Search, RefreshCw, Copy, ExternalLink, GitBranch, GitCommit, Tag,
  ChevronDown, ChevronRight, Filter, X, ChevronsUp, ChevronsDown,
  RotateCcw, Cherry, Eye, User, Calendar, FileText, Hash, Layers
} from 'lucide-react';
import {
  buildCommitGraph, commitWebUrl, parseConventionalCommit,
  ccColor, groupCommitsByDate, relativeTime, GRAPH_COLORS, hashBranchColor
} from './gitUtils';
import CommitGraphColumn from './CommitGraphColumn';
import InteractiveRebasePanel from './InteractiveRebasePanel';

/* ────────────────────────────────────────────────────────────
 * CommitHistoryPanel — SourceTree-style advanced history view
 *
 * Features:
 *  • Visual commit graph with lane-based rendering
 *  • Search / filter by author, message, hash
 *  • Commit detail view with diff + file list
 *  • Right-click context menus (cherry-pick, revert, copy hash)
 *  • Infinite scroll with paginated loading
 * ──────────────────────────────────────────────────────────── */

/* ─── Graph Column SVG ──────────────────────────────── */

function GraphColumn({ graphNode, rowHeight = 36, totalLanes }) {
  if (!graphNode) return <div style={{ width: 20 }} />;
  const cols = Math.max(totalLanes || 1, graphNode.laneCount || 1);
  const colW = 14;
  const width = cols * colW + 6;
  const cx = graphNode.col * colW + colW / 2 + 3;
  const cy = rowHeight / 2;
  const r = graphNode.isMerge ? 5 : 3.5;

  return (
    <svg width={width} height={rowHeight} className="flex-shrink-0" style={{ minWidth: width }}>
      {/* Active lane rails — straight vertical lines through this row */}
      {graphNode.activeLanes.map((lane, idx) => {
        if (lane === null) return null;
        const x = idx * colW + colW / 2 + 3;
        const laneColor = graphNode.activeLaneColors?.[idx] || GRAPH_COLORS[idx % GRAPH_COLORS.length];
        return (
          <line key={`lane-${idx}`} x1={x} y1={0} x2={x} y2={rowHeight}
            stroke={laneColor} strokeWidth={1.5} opacity={0.35} />
        );
      })}
      {/* Current commit's own vertical rail (above and below node) */}
      <line x1={cx} y1={0} x2={cx} y2={cy - r - 1}
        stroke={graphNode.color} strokeWidth={1.5} opacity={0.6} />
      <line x1={cx} y1={cy + r + 1} x2={cx} y2={rowHeight}
        stroke={graphNode.color} strokeWidth={1.5} opacity={0.6} />
      {/* Merge curves from parent columns into the commit node */}
      {graphNode.mergeFromCols.map((mc, i) => {
        const mx = mc * colW + colW / 2 + 3;
        const d = `M ${mx} 0 C ${mx} ${cy * 0.55}, ${cx} ${cy * 0.45}, ${cx} ${cy}`;
        const mergeColor = graphNode.activeLaneColors?.[mc] || GRAPH_COLORS[mc % GRAPH_COLORS.length];
        return (
          <path key={`merge-${i}`} d={d} fill="none"
            stroke={mergeColor} strokeWidth={1.5} opacity={0.55} />
        );
      })}
      {/* Closing lanes — branches merging into this commit's lane */}
      {(graphNode.closingLanes || []).map((cl, i) => {
        const clx = cl * colW + colW / 2 + 3;
        const d = `M ${clx} 0 C ${clx} ${cy * 0.55}, ${cx} ${cy * 0.45}, ${cx} ${cy}`;
        const closeColor = graphNode.activeLaneColors?.[cl] || GRAPH_COLORS[cl % GRAPH_COLORS.length];
        return (
          <path key={`close-${i}`} d={d} fill="none"
            stroke={closeColor} strokeWidth={1.5} opacity={0.45} />
        );
      })}
      {/* Commit node — merge nodes are larger & hollow, regular commits are solid */}
      {graphNode.isMerge ? (
        <>
          <circle cx={cx} cy={cy} r={r + 1}
            fill="#0a0a0b" stroke={graphNode.color} strokeWidth={2} />
          <circle cx={cx} cy={cy} r={2}
            fill={graphNode.color} />
        </>
      ) : (
        <circle cx={cx} cy={cy} r={r}
          fill={graphNode.color} />
      )}
    </svg>
  );
}

/* ─── Context menu ──────────────────────────────────── */

function ContextMenu({ x, y, commit, onClose, onAction }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const handleEsc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  const items = [
    { icon: Copy, label: 'Copy commit hash', action: 'copy-hash' },
    { icon: Copy, label: 'Copy commit message', action: 'copy-message' },
    { divider: true },
    { icon: Eye, label: 'View commit details', action: 'view-detail' },
    { divider: true },
    { icon: Cherry, label: 'Cherry-pick this commit', action: 'cherry-pick', danger: false },
    { icon: RotateCcw, label: 'Revert this commit', action: 'revert', danger: true },
    { divider: true },
    { icon: Tag, label: 'Tag this commit…', action: 'create-tag', danger: false },
    { icon: Layers, label: 'Interactive rebase from here…', action: 'rebase-from', danger: false },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] bg-[#1c1c1e] border border-[#3f3f46] rounded-lg shadow-xl py-1 min-w-[200px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} className="h-px bg-[#27272a] my-1" />
        ) : (
          <button
            key={i}
            onClick={() => { onAction(item.action, commit); onClose(); }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors
              ${item.danger
                ? 'text-red-400 hover:bg-red-500/10'
                : 'text-[#e4e4e7] hover:bg-[#27272a]'
              }`}
          >
            <item.icon className="w-3 h-3 flex-shrink-0" />
            {item.label}
          </button>
        )
      )}
    </div>
  );
}

/* ─── Commit Detail Pane ────────────────────────────── */

function CommitDetailPane({ detail, loading, onClose, onFileClick }) {
  if (loading) {
    return (
      <div className="border-t border-[#27272a] bg-[#111113] p-4 flex items-center gap-2">
        <RefreshCw className="w-3.5 h-3.5 animate-spin text-[#3b82f6]" />
        <span className="text-xs text-[#71717a]">Loading commit details…</span>
      </div>
    );
  }

  if (!detail) return null;

  const files = detail.files || [];
  const totalInsertions = files.reduce((s, f) => s + (f.insertions || 0), 0);
  const totalDeletions = files.reduce((s, f) => s + (f.deletions || 0), 0);
  const totalChanges = totalInsertions + totalDeletions;
  // Build a mini bar chart of insertions vs deletions
  const insPercent = totalChanges > 0 ? Math.round((totalInsertions / totalChanges) * 100) : 50;

  return (
    <div className="border-t border-[#27272a] bg-[#111113] max-h-[50%] overflow-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a] sticky top-0 bg-[#111113] z-10">
        <div className="flex items-center gap-2 min-w-0">
          <GitCommit className="w-3.5 h-3.5 text-[#3b82f6] flex-shrink-0" />
          <code className="text-[11px] font-mono text-[#71717a]">{detail.hash?.substring(0, 10)}</code>
          <span className="text-xs font-semibold text-[#e4e4e7] truncate">{detail.subject}</span>
        </div>
        <button onClick={onClose} className="hover:bg-[#27272a] p-0.5 rounded text-[#71717a] hover:text-[#e4e4e7]">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Meta */}
      <div className="px-3 py-2 space-y-1 border-b border-[#27272a]">
        <div className="flex items-center gap-2 text-[11px]">
          <User className="w-3 h-3 text-[#52525b]" />
          <span className="text-[#a1a1aa]">{detail.author_name}</span>
          <span className="text-[#52525b]">&lt;{detail.author_email}&gt;</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Calendar className="w-3 h-3 text-[#52525b]" />
          <span className="text-[#a1a1aa]">{detail.date ? new Date(detail.date).toLocaleString() : ''}</span>
          <span className="text-[#52525b]">{relativeTime(detail.date)}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Hash className="w-3 h-3 text-[#52525b]" />
          <code className="text-[#71717a] font-mono">{detail.hash}</code>
        </div>
        {detail.body && (
          <p className="text-[11px] text-[#a1a1aa] mt-1 whitespace-pre-wrap">{detail.body}</p>
        )}
      </div>

      {/* Files */}
      <div className="px-3 py-2">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <FileText className="w-3 h-3 text-[#52525b]" />
            <span className="text-[11px] text-[#71717a] font-medium">{files.length} file{files.length !== 1 ? 's' : ''} changed</span>
            {totalInsertions > 0 && <span className="text-emerald-400 text-[10px] font-mono">+{totalInsertions}</span>}
            {totalDeletions > 0 && <span className="text-red-400 text-[10px] font-mono">−{totalDeletions}</span>}
          </div>
        </div>
        {/* Insertions/deletions bar */}
        {totalChanges > 0 && (
          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 h-1.5 bg-[#27272a] rounded-full overflow-hidden flex">
              <div className="bg-emerald-500 h-full transition-all" style={{ width: `${insPercent}%` }} />
              <div className="bg-red-500 h-full transition-all" style={{ width: `${100 - insPercent}%` }} />
            </div>
            <span className="text-[9px] text-[#52525b] flex-shrink-0">{totalChanges} changes</span>
          </div>
        )}
        {files.length > 0 ? (
          <ul className="space-y-0.5 mb-2">
            {files.map((f, i) => {
              const fileName = typeof f === 'string' ? f : f.file;
              const ins = typeof f === 'object' ? (f.insertions || 0) : 0;
              const del = typeof f === 'object' ? (f.deletions || 0) : 0;
              return (
                <li key={i}
                  className="flex items-center gap-1.5 text-[11px] px-1 py-0.5 hover:bg-[#27272a] rounded cursor-pointer group"
                  onClick={() => onFileClick?.(fileName, detail.hash)}
                  title={`Click to open diff in editor for ${fileName}`}
                >
                  <span className={`w-3 text-center font-mono text-[10px] flex-shrink-0 ${
                    ins > 0 && del > 0 ? 'text-amber-400' :
                    ins > 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {ins > 0 && del > 0 ? 'M' : ins > 0 ? 'A' : 'D'}
                  </span>
                  <span className="text-[#e4e4e7] truncate flex-1 group-hover:text-[#3b82f6] transition-colors">{fileName}</span>
                  {ins > 0 && <span className="text-emerald-400 text-[10px]">+{ins}</span>}
                  {del > 0 && <span className="text-red-400 text-[10px]">-{del}</span>}
                  <ExternalLink className="w-2.5 h-2.5 text-[#52525b] opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[10px] text-[#52525b] italic">No changed files</p>
        )}
      </div>
    </div>
  );
}

/* ─── Filter bar ────────────────────────────────────── */

function FilterBar({
  searchQuery, onSearchChange,
  authorFilter, onAuthorChange,
  dateFrom, onDateFromChange,
  dateTo, onDateToChange,
  authors, onClose,
}) {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2 bg-[#111113] border-b border-[#27272a]">
      {/* Row 1: text search + author */}
      <div className="flex items-center gap-2">
        <Search className="w-3.5 h-3.5 text-[#52525b] flex-shrink-0" />
        <input
          type="text"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          placeholder="Search by message, hash, author, or file path…"
          className="flex-1 bg-transparent text-xs text-[#e4e4e7] placeholder-[#3f3f46] focus:outline-none"
          autoFocus
        />
        {authors.length > 0 && (
          <select
            value={authorFilter}
            onChange={e => onAuthorChange(e.target.value)}
            className="bg-[#18181b] border border-[#3f3f46] rounded px-1.5 py-0.5 text-[10px] text-[#a1a1aa] focus:outline-none focus:border-[#3b82f6]"
          >
            <option value="">All authors</option>
            {authors.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        )}
        <button onClick={onClose} className="hover:bg-[#27272a] p-0.5 rounded text-[#71717a] hover:text-[#e4e4e7]">
          <X className="w-3 h-3" />
        </button>
      </div>
      {/* Row 2: date range */}
      <div className="flex items-center gap-2 text-[10px]">
        <Calendar className="w-3 h-3 text-[#52525b] flex-shrink-0" />
        <span className="text-[#71717a]">From</span>
        <input
          type="date"
          value={dateFrom}
          onChange={e => onDateFromChange(e.target.value)}
          className="bg-[#18181b] border border-[#3f3f46] rounded px-1 py-0.5 text-[10px] text-[#a1a1aa] focus:outline-none focus:border-[#3b82f6]"
        />
        <span className="text-[#71717a]">To</span>
        <input
          type="date"
          value={dateTo}
          onChange={e => onDateToChange(e.target.value)}
          className="bg-[#18181b] border border-[#3f3f46] rounded px-1 py-0.5 text-[10px] text-[#a1a1aa] focus:outline-none focus:border-[#3b82f6]"
        />
        {(dateFrom || dateTo) && (
          <button
            onClick={() => { onDateFromChange(''); onDateToChange(''); }}
            className="text-[#71717a] hover:text-[#e4e4e7]"
            title="Clear date filter"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ─── Main Panel ────────────────────────────────────── */

export default function CommitHistoryPanel({ slug }) {
  const dispatch = useDispatch();
  const loading = useSelector(selectGitLoading);
  const { commitHistory, commitDetail, commitDetailLoading } = useSelector(s => s.git);
  const unpushedCommits = useSelector(s => s.git.unpushedCommits);
  const remotes = useSelector(s => s.git.remotes);
  const primaryRemoteUrl = remotes?.[0]?.refs?.push ?? null;
  const unpushedHashes = useMemo(() => new Set((unpushedCommits || []).map(c => c.hash)), [unpushedCommits]);

  const [searchQuery, setSearchQuery] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [selectedHash, setSelectedHash] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [rebaseCommits, setRebaseCommits] = useState(null); // commits for interactive rebase
  const [page, setPage] = useState(1);
  const scrollRef = useRef(null);

  // Load commit history
  useEffect(() => {
    if (slug) {
      dispatch(fetchCommitHistory({ slug, page: 1, limit: 200 }));
    }
  }, [dispatch, slug]);

  const allCommits = useMemo(() => commitHistory?.all ?? [], [commitHistory]);
  const refsMap = useMemo(() => commitHistory?.refs ?? {}, [commitHistory]);

  // Extract unique authors
  const authors = useMemo(() => {
    const set = new Set();
    for (const c of allCommits) {
      if (c.author_name) set.add(c.author_name);
    }
    return [...set].sort();
  }, [allCommits]);

  // Filter commits
  const filteredCommits = useMemo(() => {
    let result = allCommits;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(c =>
        c.message?.toLowerCase().includes(q) ||
        c.hash?.toLowerCase().includes(q) ||
        c.author_name?.toLowerCase().includes(q)
      );
    }
    if (authorFilter) {
      result = result.filter(c => c.author_name === authorFilter);
    }
    if (dateFrom) {
      const from = new Date(dateFrom);
      from.setHours(0, 0, 0, 0);
      result = result.filter(c => c.date && new Date(c.date) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      result = result.filter(c => c.date && new Date(c.date) <= to);
    }
    return result;
  }, [allCommits, searchQuery, authorFilter, dateFrom, dateTo]);

  // Build graph
  const graphNodes = useMemo(() => buildCommitGraph(filteredCommits, refsMap), [filteredCommits, refsMap]);
  const maxLanes = useMemo(() => {
    let max = 0;
    for (const gn of graphNodes) {
      if (gn.laneCount > max) max = gn.laneCount;
    }
    return max;
  }, [graphNodes]);

  // Group by date
  const dateGroups = useMemo(() => groupCommitsByDate(filteredCommits), [filteredCommits]);

  const handleRefresh = useCallback(() => {
    if (slug) dispatch(fetchCommitHistory({ slug, page: 1, limit: 200 }));
  }, [dispatch, slug]);

  const handleContextMenu = useCallback((e, commit) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, commit });
  }, []);

  const handleContextAction = useCallback(async (action, commit) => {
    switch (action) {
      // Clipboard copies: silent on success — the action is immediate
      // and contextual, so a toast confirmation is redundant noise.
      // Failure path (rejected promise) still surfaces an error toast.
      case 'copy-hash':
        navigator.clipboard.writeText(commit.hash).catch(() =>
          toast.error('Could not copy hash to clipboard')
        );
        break;
      case 'copy-message':
        navigator.clipboard.writeText(commit.message).catch(() =>
          toast.error('Could not copy message to clipboard')
        );
        break;
      case 'view-detail':
        setSelectedHash(commit.hash);
        dispatch(fetchCommitDetail({ slug, hash: commit.hash }));
        break;
      case 'cherry-pick':
        if (confirm(`Cherry-pick commit ${commit.hash.substring(0, 7)}?\n\n"${commit.message}"`)) {
          const result = await dispatch(cherryPickCommit({ slug, hash: commit.hash }));
          if (cherryPickCommit.fulfilled.match(result)) {
            toast.success(`Cherry-picked ${commit.hash.substring(0, 7)}`);
          } else {
            toast.error(result.error?.message || 'Cherry-pick failed');
          }
        }
        break;
      case 'revert':
        if (confirm(`Revert commit ${commit.hash.substring(0, 7)}?\n\n"${commit.message}"\n\nThis will create a new commit that undoes the changes.`)) {
          const result = await dispatch(revertCommit({ slug, hash: commit.hash }));
          if (revertCommit.fulfilled.match(result)) {
            toast.success(`Reverted ${commit.hash.substring(0, 7)}`);
            handleRefresh();
          } else {
            toast.error(result.error?.message || 'Revert failed');
          }
        }
        break;
      case 'rebase-from': {
        // Collect all commits from this one to the top (most recent)
        const idx = allCommits.findIndex(c => c.hash === commit.hash);
        if (idx < 0) break;
        // allCommits is newest-first; for rebase-todo we need oldest-first
        const commitsForRebase = allCommits.slice(0, idx + 1).reverse();
        if (commitsForRebase.length < 1) {
          toast.error('No commits to rebase');
          break;
        }
        setRebaseCommits(commitsForRebase);
        break;
      }
      case 'create-tag': {
        const tagName = prompt(`Create tag on ${commit.hash.substring(0, 7)}:\n\nTag name:`);
        if (!tagName?.trim()) break;
        const tagMessage = prompt('Tag message (leave empty for lightweight tag):');
        const result = await dispatch(createTag({ slug, name: tagName.trim(), ref: commit.hash, message: tagMessage || undefined }));
        if (createTag.fulfilled.match(result)) {
          toast.success(`Tag "${tagName.trim()}" created`);
        } else {
          toast.error(result.error?.message || 'Failed to create tag');
        }
        break;
      }
    }
  }, [dispatch, slug, handleRefresh, allCommits]);

  const handleCommitClick = useCallback((commit) => {
    if (selectedHash === commit.hash) {
      setSelectedHash(null);
    } else {
      setSelectedHash(commit.hash);
      dispatch(fetchCommitDetail({ slug, hash: commit.hash }));
    }
  }, [dispatch, slug, selectedHash]);

  // If rebase panel is open, render it instead of the commit list
  if (rebaseCommits) {
    return (
      <InteractiveRebasePanel
        commits={rebaseCommits}
        slug={slug}
        onClose={() => { setRebaseCommits(null); handleRefresh(); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0b] text-[#e4e4e7]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a] bg-[#111113]">
        <div className="flex items-center gap-2">
          <GitCommit className="w-4 h-4 text-[#3b82f6]" />
          <span className="text-xs font-semibold">Commit History</span>
          <span className="text-[10px] text-[#52525b]">
            {filteredCommits.length !== allCommits.length
              ? `${filteredCommits.length}/${allCommits.length}`
              : allCommits.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowFilter(!showFilter)}
            className={`p-1 rounded transition-colors ${showFilter ? 'bg-[#3b82f6]/20 text-[#3b82f6]' : 'hover:bg-[#27272a] text-[#71717a] hover:text-[#e4e4e7]'}`}
            title="Search & filter"
          >
            <Filter className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="p-1 rounded hover:bg-[#27272a] text-[#71717a] hover:text-[#e4e4e7] disabled:opacity-50 transition-colors"
            title="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Filter bar */}
      {showFilter && (
        <FilterBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          authorFilter={authorFilter}
          onAuthorChange={setAuthorFilter}
          dateFrom={dateFrom}
          onDateFromChange={setDateFrom}
          dateTo={dateTo}
          onDateToChange={setDateTo}
          authors={authors}
          onClose={() => { setShowFilter(false); setSearchQuery(''); setAuthorFilter(''); setDateFrom(''); setDateTo(''); }}
        />
      )}

      {/* Commit list — PERF: Virtualized with react-virtuoso.
           Flattens date-group headers + commit rows into a single list
           so only visible rows are rendered in the DOM. */}
      <div ref={scrollRef} className="flex-1 overflow-hidden">
        {dateGroups.length > 0 ? (
          (() => {
            // Flatten date groups + commits into a single array for virtualization
            const flatItems = [];
            for (const group of dateGroups) {
              flatItems.push({ type: 'header', label: group.label, key: `hdr-${group.label}` });
              for (const commit of group.commits) {
                flatItems.push({ type: 'commit', commit, key: commit.hash });
              }
            }
            return (
              <Virtuoso
                style={{ height: '100%' }}
                data={flatItems}
                overscan={150}
                itemContent={(index, item) => {
                  if (item.type === 'header') {
                    return (
                      <div className="sticky top-0 z-[5] px-3 py-1 bg-[#0d0d0f] border-b border-[#1a1a1e]">
                        <span className="text-[10px] text-[#52525b] font-semibold uppercase tracking-wider">{item.label}</span>
                      </div>
                    );
                  }
                  const commit = item.commit;
                  const gIdx = filteredCommits.indexOf(commit);
                  const gn = graphNodes[gIdx];
                  const webUrl = commitWebUrl(primaryRemoteUrl, commit.hash);
                  const cc = parseConventionalCommit(commit.message);
                  const isSelected = selectedHash === commit.hash;
                  const isoDate = commit.date ? new Date(commit.date).toISOString() : '';
                  const isHead = gIdx === 0;
                  const isUnpushed = unpushedHashes.has(commit.hash);

                  return (
                    <div
                      className={`flex items-center cursor-pointer transition-colors border-l-2
                        ${isSelected
                          ? 'bg-[#3b82f6]/10 border-l-[#3b82f6]'
                          : isUnpushed
                            ? 'hover:bg-[#27272a] border-l-amber-500/40 bg-amber-500/[0.03]'
                            : 'hover:bg-[#27272a] border-l-transparent'
                        }`}
                      onClick={() => handleCommitClick(commit)}
                      onContextMenu={e => handleContextMenu(e, commit)}
                      title={`${commit.hash}\n${isoDate}\n\nRight-click for actions`}
                    >
                      <CommitGraphColumn
                        graphNode={gn}
                        totalLanes={maxLanes}
                        rowHeight={36}
                        commitData={commit}
                        refsMap={refsMap}
                        allGraphNodes={graphNodes}
                        nodeIndex={gIdx}
                      />
                      <div className="flex-1 min-w-0 py-1.5 pr-2">
                        <div className="flex items-center gap-1.5">
                          <code className="font-mono text-[10px] text-[#52525b] flex-shrink-0">{commit.hash?.substring(0, 7)}</code>
                          {isHead && (
                            <span className="text-[8px] px-1 py-0 rounded font-bold flex-shrink-0 border border-[#3b82f6]/50 text-[#3b82f6] bg-[#3b82f6]/10">
                              HEAD
                            </span>
                          )}
                          {isUnpushed && !isHead && (
                            <span className="text-[8px] px-0.5 py-0 rounded flex-shrink-0 text-amber-400" title="Unpushed">
                              ↑
                            </span>
                          )}
                          {(refsMap[commit.hash?.substring(0, 7)] || []).map((ref, ri) => {
                            const laneColor = ref.type === 'tag'
                              ? '#f59e0b'
                              : ref.type === 'remote'
                                ? (gn?.color || hashBranchColor(ref.name))
                                : (gn?.color || hashBranchColor(ref.name));
                            return (
                              <span key={ri}
                                className="text-[9px] px-1 py-0 rounded font-medium flex-shrink-0 inline-flex items-center gap-0.5 border"
                                style={{
                                  borderColor: `${laneColor}50`,
                                  color: laneColor,
                                  backgroundColor: `${laneColor}18`,
                                }}
                              >
                                {ref.type === 'tag' ? '🏷' : <GitBranch className="w-2 h-2" />}
                                {ref.name}
                              </span>
                            );
                          })}
                          {cc && (
                            <span className={`text-[9px] px-1 py-0.5 rounded font-medium flex-shrink-0 bg-opacity-20`}
                              style={{ color: ccColor(cc.type), backgroundColor: ccColor(cc.type) + '20' }}>
                              {cc.type}{cc.scope ? `(${cc.scope})` : ''}
                            </span>
                          )}
                          <span className="text-xs text-[#e4e4e7] truncate">
                            {cc ? cc.description : commit.message}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px] text-[#52525b]">
                          <span className="truncate">{commit.author_name}</span>
                          <span>·</span>
                          <span className="flex-shrink-0">{relativeTime(commit.date)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 pr-2 opacity-0 hover:opacity-100 transition-opacity flex-shrink-0"
                        style={{ opacity: isSelected ? 1 : undefined }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(commit.hash).catch(() =>
                              toast.error('Could not copy hash to clipboard')
                            );
                          }}
                          className="p-0.5 rounded hover:bg-[#3f3f46] text-[#52525b] hover:text-[#e4e4e7]"
                          aria-label="Copy commit hash"
                          title="Copy hash"
                        >
                          <Copy className="w-2.5 h-2.5" />
                        </button>
                        {webUrl && (
                          <a
                            href={webUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="p-0.5 rounded hover:bg-[#3f3f46] text-[#52525b] hover:text-[#e4e4e7]"
                            title="View on remote"
                          >
                            <ExternalLink className="w-2.5 h-2.5" />
                          </a>
                        )}
                      </div>
                    </div>
                  );
                }}
              />
            );
          })()
        ) : (
          <div className="flex items-center justify-center h-32 text-[#52525b] text-xs italic">
            {searchQuery || authorFilter ? 'No matching commits' : 'No commit history'}
          </div>
        )}
      </div>

      {/* Commit detail pane */}
      {selectedHash && (
        <CommitDetailPane
          detail={commitDetail}
          loading={commitDetailLoading}
          onClose={() => setSelectedHash(null)}
          onFileClick={(filePath, commitHash) => {
            dispatch(openCommitFileDiffThunk({ filePath, commitHash }));
          }}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          commit={contextMenu.commit}
          onClose={() => setContextMenu(null)}
          onAction={handleContextAction}
        />
      )}
    </div>
  );
}

export { CommitDetailPane, FilterBar };
