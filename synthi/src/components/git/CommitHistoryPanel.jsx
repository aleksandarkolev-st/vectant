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
  groupCommitsByDate, relativeTime, GRAPH_COLORS, hashBranchColor
} from './gitUtils';
import CommitGraphColumn from './CommitGraphColumn';
import InteractiveRebasePanel from './InteractiveRebasePanel';
import './scm/scm-tokens.css';

/* ────────────────────────────────────────────────────────────
 * CommitHistoryPanel — SourceTree-style advanced history view,
 * restyled for the Vectant design language.  Calm slate-violet
 * baseline, attention-purple for selected commit + HEAD, danger
 * red for revert, brand-bar treatment reserved for unpushed.
 *
 * Behavior preserved: graph, search/filter, context menu, commit
 * detail, infinite scroll via Virtuoso.
 * ──────────────────────────────────────────────────────────── */

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
      className="fixed z-[9999] rounded-lg shadow-xl py-1 min-w-[200px]"
      style={{
        left: x, top: y,
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {items.map((item, i) =>
        item.divider ? (
          <div key={i} className="h-px my-1" style={{ background: 'var(--border-subtle)' }} />
        ) : (
          <button
            key={i}
            onClick={() => { onAction(item.action, commit); onClose(); }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs th-action th-focus-ring"
            style={{ color: item.danger ? 'var(--accent-danger)' : 'var(--text-primary)' }}
          >
            <item.icon className="w-3 h-3 flex-shrink-0" strokeWidth={2} />
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
      <div
        className="p-4 flex items-center gap-2"
        style={{
          borderTop: '1px solid var(--border-subtle)',
          background: 'var(--bg-panel)',
        }}
      >
        <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading commit details…</span>
      </div>
    );
  }

  if (!detail) return null;

  const files = detail.files || [];
  const totalInsertions = files.reduce((s, f) => s + (f.insertions || 0), 0);
  const totalDeletions = files.reduce((s, f) => s + (f.deletions || 0), 0);
  const totalChanges = totalInsertions + totalDeletions;
  const insPercent = totalChanges > 0 ? Math.round((totalInsertions / totalChanges) * 100) : 50;

  return (
    <div
      className="max-h-[50%] overflow-auto"
      style={{
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-panel)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 sticky top-0 z-10"
        style={{
          borderBottom: '1px solid var(--border-subtle)',
          background: 'var(--bg-panel)',
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <GitCommit className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
          <code className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>{detail.hash?.substring(0, 10)}</code>
          <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{detail.subject}</span>
        </div>
        <button
          onClick={onClose}
          className="th-btn-ghost p-0.5 rounded th-focus-ring"
          aria-label="Close commit detail"
          title="Close"
        >
          <X className="w-3.5 h-3.5" strokeWidth={2} />
        </button>
      </div>

      {/* Meta */}
      <div className="px-3 py-2 space-y-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center gap-2 text-[11px]">
          <User className="w-3 h-3" style={{ color: 'var(--text-dim)' }} strokeWidth={2} />
          <span style={{ color: 'var(--text-secondary)' }}>{detail.author_name}</span>
          <span style={{ color: 'var(--text-dim)' }}>&lt;{detail.author_email}&gt;</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Calendar className="w-3 h-3" style={{ color: 'var(--text-dim)' }} strokeWidth={2} />
          <span style={{ color: 'var(--text-secondary)' }}>{detail.date ? new Date(detail.date).toLocaleString() : ''}</span>
          <span style={{ color: 'var(--text-dim)' }}>{relativeTime(detail.date)}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Hash className="w-3 h-3" style={{ color: 'var(--text-dim)' }} strokeWidth={2} />
          <code className="font-mono" style={{ color: 'var(--text-muted)' }}>{detail.hash}</code>
        </div>
        {detail.body && (
          <p className="text-[11px] mt-1 whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>{detail.body}</p>
        )}
      </div>

      {/* Files */}
      <div className="px-3 py-2">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1.5">
            <FileText className="w-3 h-3" style={{ color: 'var(--text-dim)' }} strokeWidth={2} />
            <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>
              {files.length} file{files.length !== 1 ? 's' : ''} changed
            </span>
            {totalInsertions > 0 && (
              <span className="text-[10px] font-mono" style={{ color: 'var(--accent-success)' }}>
                +{totalInsertions}
              </span>
            )}
            {totalDeletions > 0 && (
              <span className="text-[10px] font-mono" style={{ color: 'var(--accent-danger)' }}>
                −{totalDeletions}
              </span>
            )}
          </div>
        </div>
        {/* Insertions/deletions bar — restrained, only inside the
            commit detail pane.  Uses accent-success / accent-danger
            tokens instead of the previous tailwind colors. */}
        {totalChanges > 0 && (
          <div className="flex items-center gap-2 mb-2">
            <div
              className="flex-1 h-1.5 rounded-full overflow-hidden flex"
              style={{ background: 'var(--border-subtle)' }}
            >
              <div
                className="h-full transition-all"
                style={{ background: 'var(--accent-success)', width: `${insPercent}%` }}
              />
              <div
                className="h-full transition-all"
                style={{ background: 'var(--accent-danger)', width: `${100 - insPercent}%` }}
              />
            </div>
            <span className="text-[9px] flex-shrink-0" style={{ color: 'var(--text-dim)' }}>{totalChanges} changes</span>
          </div>
        )}
        {files.length > 0 ? (
          <ul className="space-y-0.5 mb-2">
            {files.map((f, i) => {
              const fileName = typeof f === 'string' ? f : f.file;
              const ins = typeof f === 'object' ? (f.insertions || 0) : 0;
              const del = typeof f === 'object' ? (f.deletions || 0) : 0;
              const statusLetter = ins > 0 && del > 0 ? 'M' : ins > 0 ? 'A' : 'D';
              const statusColor =
                ins > 0 && del > 0 ? 'var(--text-secondary)'
                  : ins > 0 ? 'var(--accent-success)'
                    : 'var(--accent-danger)';
              return (
                <li
                  key={i}
                  className="flex items-center gap-1.5 text-[11px] px-1 py-0.5 rounded cursor-pointer group transition-colors"
                  onClick={() => onFileClick?.(fileName, detail.hash)}
                  title={`Click to open diff in editor for ${fileName}`}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-elevated)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <span className="w-3 text-center font-mono text-[10px] flex-shrink-0" style={{ color: statusColor }}>
                    {statusLetter}
                  </span>
                  <span className="truncate flex-1 transition-colors" style={{ color: 'var(--text-primary)' }}>{fileName}</span>
                  {ins > 0 && <span className="text-[10px]" style={{ color: 'var(--accent-success)' }}>+{ins}</span>}
                  {del > 0 && <span className="text-[10px]" style={{ color: 'var(--accent-danger)' }}>-{del}</span>}
                  <ExternalLink className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity" style={{ color: 'var(--text-dim)' }} strokeWidth={2} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[10px] italic" style={{ color: 'var(--text-dim)' }}>No changed files</p>
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
    <div
      className="flex flex-col gap-1.5 px-3 py-2"
      style={{
        background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <div className="flex items-center gap-2">
        <Search className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-dim)' }} strokeWidth={2} />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search by message, hash, author, or file path…"
          className="flex-1 bg-transparent text-xs focus:outline-none th-focus-ring"
          style={{ color: 'var(--text-primary)' }}
          autoFocus
        />
        {authors.length > 0 && (
          <select
            value={authorFilter}
            onChange={(e) => onAuthorChange(e.target.value)}
            className="rounded px-1.5 py-0.5 text-[10px] focus:outline-none th-focus-ring"
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            <option value="">All authors</option>
            {authors.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        )}
        <button
          onClick={onClose}
          className="p-0.5 rounded th-btn-ghost th-focus-ring"
          aria-label="Close filter"
          title="Close filter"
        >
          <X className="w-3 h-3" strokeWidth={2} />
        </button>
      </div>
      <div className="flex items-center gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
        <Calendar className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-dim)' }} strokeWidth={2} />
        <span>From</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => onDateFromChange(e.target.value)}
          className="rounded px-1 py-0.5 text-[10px] focus:outline-none th-focus-ring"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        />
        <span>To</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => onDateToChange(e.target.value)}
          className="rounded px-1 py-0.5 text-[10px] focus:outline-none th-focus-ring"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            color: 'var(--text-secondary)',
          }}
        />
        {(dateFrom || dateTo) && (
          <button
            onClick={() => { onDateFromChange(''); onDateToChange(''); }}
            className="th-btn-ghost th-focus-ring"
            title="Clear date filter"
            aria-label="Clear date filter"
          >
            <X className="w-2.5 h-2.5" strokeWidth={2} />
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
  const { commitHistory, commitDetail, commitDetailLoading } = useSelector((s) => s.git);
  const unpushedCommits = useSelector((s) => s.git.unpushedCommits);
  const remotes = useSelector((s) => s.git.remotes);
  const primaryRemoteUrl = remotes?.[0]?.refs?.push ?? null;
  const unpushedHashes = useMemo(
    () => new Set((unpushedCommits || []).map((c) => c.hash)),
    [unpushedCommits],
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [selectedHash, setSelectedHash] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [rebaseCommits, setRebaseCommits] = useState(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    if (slug) {
      dispatch(fetchCommitHistory({ slug, page: 1, limit: 200 }));
    }
  }, [dispatch, slug]);

  const allCommits = useMemo(() => commitHistory?.all ?? [], [commitHistory]);
  const refsMap = useMemo(() => commitHistory?.refs ?? {}, [commitHistory]);

  const authors = useMemo(() => {
    const set = new Set();
    for (const c of allCommits) {
      if (c.author_name) set.add(c.author_name);
    }
    return [...set].sort();
  }, [allCommits]);

  const filteredCommits = useMemo(() => {
    let result = allCommits;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((c) =>
        c.message?.toLowerCase().includes(q)
        || c.hash?.toLowerCase().includes(q)
        || c.author_name?.toLowerCase().includes(q),
      );
    }
    if (authorFilter) result = result.filter((c) => c.author_name === authorFilter);
    if (dateFrom) {
      const from = new Date(dateFrom);
      from.setHours(0, 0, 0, 0);
      result = result.filter((c) => c.date && new Date(c.date) >= from);
    }
    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      result = result.filter((c) => c.date && new Date(c.date) <= to);
    }
    return result;
  }, [allCommits, searchQuery, authorFilter, dateFrom, dateTo]);

  const graphNodes = useMemo(
    () => buildCommitGraph(filteredCommits, refsMap),
    [filteredCommits, refsMap],
  );
  const maxLanes = useMemo(() => {
    let max = 0;
    for (const gn of graphNodes) {
      if (gn.laneCount > max) max = gn.laneCount;
    }
    return max;
  }, [graphNodes]);

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
      case 'copy-hash':
        navigator.clipboard.writeText(commit.hash).catch(() =>
          toast.error('Could not copy hash to clipboard'),
        );
        break;
      case 'copy-message':
        navigator.clipboard.writeText(commit.message).catch(() =>
          toast.error('Could not copy message to clipboard'),
        );
        break;
      case 'view-detail':
        setSelectedHash(commit.hash);
        dispatch(fetchCommitDetail({ slug, hash: commit.hash }));
        break;
      case 'cherry-pick':
        if (window.confirm(`Cherry-pick commit ${commit.hash.substring(0, 7)}?\n\n"${commit.message}"`)) {
          const result = await dispatch(cherryPickCommit({ slug, hash: commit.hash }));
          if (cherryPickCommit.fulfilled.match(result)) {
            toast.success(`Cherry-picked ${commit.hash.substring(0, 7)}`);
          } else {
            toast.error(result.error?.message || 'Cherry-pick failed');
          }
        }
        break;
      case 'revert':
        if (window.confirm(`Revert commit ${commit.hash.substring(0, 7)}?\n\n"${commit.message}"\n\nThis will create a new commit that undoes the changes.`)) {
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
        const idx = allCommits.findIndex((c) => c.hash === commit.hash);
        if (idx < 0) break;
        const commitsForRebase = allCommits.slice(0, idx + 1).reverse();
        if (commitsForRebase.length < 1) { toast.error('No commits to rebase'); break; }
        setRebaseCommits(commitsForRebase);
        break;
      }
      case 'create-tag': {
        const tagName = window.prompt(`Create tag on ${commit.hash.substring(0, 7)}:\n\nTag name:`);
        if (!tagName?.trim()) break;
        const tagMessage = window.prompt('Tag message (leave empty for lightweight tag):');
        const result = await dispatch(createTag({ slug, name: tagName.trim(), ref: commit.hash, message: tagMessage || undefined }));
        if (createTag.fulfilled.match(result)) {
          toast.success(`Tag "${tagName.trim()}" created`);
        } else {
          toast.error(result.error?.message || 'Failed to create tag');
        }
        break;
      }
      default:
        break;
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
    <div className="flex flex-col h-full" style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}>
      {/* Toolbar */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div className="flex items-center gap-2">
          <GitCommit className="w-4 h-4" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
          <span className="text-xs font-semibold">Commit History</span>
          <span className="text-[10px]" style={{ color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
            {filteredCommits.length !== allCommits.length
              ? `${filteredCommits.length}/${allCommits.length}`
              : allCommits.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowFilter(!showFilter)}
            className={`scm-row-action th-focus-ring ${showFilter ? '' : ''}`}
            style={{
              width: 24, height: 24,
              color: showFilter ? 'var(--attention-purple)' : 'var(--text-muted)',
              background: showFilter ? 'color-mix(in srgb, var(--attention-purple) 14%, transparent)' : 'transparent',
            }}
            title="Search & filter"
            aria-label="Toggle filter"
          >
            <Filter className="w-3.5 h-3.5" strokeWidth={2} />
          </button>
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="scm-row-action th-focus-ring"
            style={{ width: 24, height: 24, color: 'var(--text-muted)' }}
            title="Refresh"
            aria-label="Refresh commit history"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={2} />
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
          onClose={() => {
            setShowFilter(false);
            setSearchQuery('');
            setAuthorFilter('');
            setDateFrom('');
            setDateTo('');
          }}
        />
      )}

      {/* Commit list — virtualized via Virtuoso */}
      <div ref={scrollRef} className="flex-1 overflow-hidden">
        {dateGroups.length > 0 ? (
          (() => {
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
                      <div
                        className="sticky top-0 z-[5] px-3 py-1"
                        style={{
                          background: 'var(--bg-app)',
                          borderBottom: '1px solid var(--border-subtle)',
                        }}
                      >
                        <span
                          className="text-[10px] font-semibold uppercase tracking-wider"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {item.label}
                        </span>
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

                  // Left bar: brand gradient for unpushed (these are
                  // *your* outgoing work), attention-purple for
                  // selected, transparent otherwise.
                  const leftBarStyle = isSelected
                    ? { boxShadow: 'inset 2px 0 0 0 var(--attention-purple)' }
                    : isUnpushed
                      ? {
                          boxShadow:
                            'inset 2px 0 0 0 var(--brand-stop-3), '
                            + 'inset 6px 0 12px -6px color-mix(in srgb, var(--brand-stop-3) 30%, transparent)',
                        }
                      : { boxShadow: 'none' };

                  const rowBg = isSelected
                    ? 'color-mix(in srgb, var(--attention-purple) 12%, transparent)'
                    : isUnpushed
                      ? 'color-mix(in srgb, var(--brand-stop-3) 5%, transparent)'
                      : 'transparent';

                  return (
                    <div
                      className="flex items-center cursor-pointer transition-colors"
                      style={{ ...leftBarStyle, background: rowBg }}
                      onClick={() => handleCommitClick(commit)}
                      onContextMenu={(e) => handleContextMenu(e, commit)}
                      title={`${commit.hash}\n${isoDate}\n\nRight-click for actions`}
                      onMouseEnter={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.background = isUnpushed
                            ? 'color-mix(in srgb, var(--brand-stop-3) 8%, transparent)'
                            : 'color-mix(in srgb, var(--text-primary) 4%, transparent)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = rowBg;
                      }}
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
                          <code
                            className="font-mono text-[10px] flex-shrink-0"
                            style={{ color: 'var(--text-dim)' }}
                          >
                            {commit.hash?.substring(0, 7)}
                          </code>
                          {isHead && (
                            <span
                              className="text-[8px] px-1 py-0 rounded font-bold flex-shrink-0"
                              style={{
                                border: '1px solid color-mix(in srgb, var(--attention-purple) 45%, transparent)',
                                color: 'var(--attention-purple)',
                                background: 'color-mix(in srgb, var(--attention-purple) 12%, transparent)',
                              }}
                            >
                              HEAD
                            </span>
                          )}
                          {isUnpushed && !isHead && (
                            <span
                              className="text-[8px] px-0.5 py-0 rounded flex-shrink-0"
                              style={{ color: 'var(--brand-stop-3)' }}
                              title="Unpushed"
                            >
                              ↑
                            </span>
                          )}
                          {(refsMap[commit.hash?.substring(0, 7)] || []).map((ref, ri) => {
                            // Refs (branches and tags) keep their lane color so the
                            // graph and the badge stay visually associated.  Tags
                            // get a calm slate-violet treatment instead of the
                            // previous amber to stay on-palette.
                            const laneColor = ref.type === 'tag'
                              ? 'var(--accent-secondary)'
                              : (gn?.color || hashBranchColor(ref.name));
                            return (
                              <span
                                key={ri}
                                className="text-[9px] px-1 py-0 rounded font-medium flex-shrink-0 inline-flex items-center gap-0.5"
                                style={{
                                  border: `1px solid ${laneColor}50`,
                                  color: laneColor,
                                  background: `${laneColor}18`,
                                }}
                              >
                                {ref.type === 'tag'
                                  ? <Tag className="w-2 h-2" strokeWidth={2} />
                                  : <GitBranch className="w-2 h-2" strokeWidth={2} />}
                                {ref.name}
                              </span>
                            );
                          })}
                          {cc && (
                            <span
                              className="text-[9px] px-1 py-0.5 rounded font-medium flex-shrink-0 uppercase tracking-wider"
                              style={{
                                color: 'var(--text-secondary)',
                                background: 'var(--bg-elevated)',
                                border: '1px solid var(--border-subtle)',
                              }}
                            >
                              {cc.type}{cc.scope ? `(${cc.scope})` : ''}
                            </span>
                          )}
                          <span className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>
                            {cc ? cc.description : commit.message}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
                          <span className="truncate">{commit.author_name}</span>
                          <span>·</span>
                          <span className="flex-shrink-0">{relativeTime(commit.date)}</span>
                        </div>
                      </div>
                      <div
                        className="flex items-center gap-0.5 pr-2 transition-opacity flex-shrink-0"
                        style={{ opacity: isSelected ? 1 : undefined }}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(commit.hash).catch(() =>
                              toast.error('Could not copy hash to clipboard'),
                            );
                          }}
                          className="scm-row-action"
                          style={{ width: 18, height: 18 }}
                          aria-label="Copy commit hash"
                          title="Copy hash"
                        >
                          <Copy className="w-2.5 h-2.5" strokeWidth={2} />
                        </button>
                        {webUrl && (
                          <a
                            href={webUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="scm-row-action"
                            style={{ width: 18, height: 18 }}
                            title="View on remote"
                            aria-label="View commit on remote"
                          >
                            <ExternalLink className="w-2.5 h-2.5" strokeWidth={2} />
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
          <div
            className="flex items-center justify-center h-32 text-xs italic"
            style={{ color: 'var(--text-dim)' }}
          >
            {searchQuery || authorFilter ? 'No matching commits' : 'No commit history'}
          </div>
        )}
      </div>

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
