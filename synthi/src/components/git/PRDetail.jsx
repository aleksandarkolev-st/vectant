'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchPRDetail, updatePR, mergePR, closePR, reopenPR,
  submitReview, postComment, deleteComment, setLabels,
  fetchRepoLabels, setActivePR, clearActionError, fetchRepoBranches,
  fetchPRList,
} from '@/redux/prSlice';
import {
  ChevronLeft, GitMerge, GitPullRequest, Circle, CheckCircle2,
  XCircle, RefreshCw, MessageSquare, FileText, GitCommit, CheckSquare,
  AlertCircle, ExternalLink, ChevronDown, Edit3, Tag, User,
  ThumbsUp, ThumbsDown, Send, Trash2, MoreHorizontal, Lock, Unlock,
  Copy, ArrowRightLeft, GitBranch, Clock, Plus, Minus,
} from 'lucide-react';
import { toast } from 'sonner';

// ── Helpers ───────────────────────────────────────────────────────────────────

function prStateColor(pr) {
  if (!pr) return 'text-gray-400';
  if (pr.merged) return 'text-purple-400';
  if (pr.state === 'closed') return 'text-red-400';
  if (pr.draft) return 'text-gray-400';
  return 'text-emerald-400';
}

function prStateBg(pr) {
  if (!pr) return '';
  if (pr.merged) return { background: 'rgba(139,92,246,0.15)', color: '#a78bfa', border: '1px solid rgba(139,92,246,0.3)' };
  if (pr.state === 'closed') return { background: 'rgba(239,68,68,0.12)', color: '#f87171', border: '1px solid rgba(239,68,68,0.25)' };
  if (pr.draft) return { background: 'rgba(161,161,170,0.12)', color: '#a1a1aa', border: '1px solid rgba(161,161,170,0.25)' };
  return { background: 'rgba(52,211,153,0.12)', color: '#34d399', border: '1px solid rgba(52,211,153,0.25)' };
}

function prStateIcon(pr) {
  if (!pr) return <Circle className="w-3.5 h-3.5" />;
  if (pr.merged) return <GitMerge className="w-3.5 h-3.5" />;
  if (pr.state === 'closed') return <XCircle className="w-3.5 h-3.5" />;
  if (pr.draft) return <FileText className="w-3.5 h-3.5" />;
  return <GitPullRequest className="w-3.5 h-3.5" />;
}

function prStateLabel(pr) {
  if (!pr) return 'Unknown';
  if (pr.merged) return 'Merged';
  if (pr.state === 'closed') return 'Closed';
  if (pr.draft) return 'Draft';
  return 'Open';
}

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function checkIcon(status, conclusion) {
  if (status !== 'completed') return <Clock className="w-3.5 h-3.5 text-yellow-400" />;
  if (conclusion === 'success') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
  if (conclusion === 'failure' || conclusion === 'timed_out') return <XCircle className="w-3.5 h-3.5 text-red-400" />;
  return <AlertCircle className="w-3.5 h-3.5 text-yellow-400" />;
}

function fileDiffColor(status) {
  const map = {
    added: 'text-emerald-400',
    removed: 'text-red-400',
    modified: 'text-amber-400',
    renamed: 'text-sky-400',
    copied: 'text-sky-400',
    changed: 'text-amber-400',
  };
  return map[status] || 'text-gray-400';
}

function fileDiffLabel(status) {
  const map = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' };
  return map[status] || '?';
}

// ── Simple markdown -> text renderer (no dep) ─────────────────────────────────
function MarkdownText({ text }) {
  if (!text) return <span className="text-xs opacity-50 italic" style={{ color: 'var(--text-muted)' }}>No description.</span>;
  // Very basic: bold, code, links, headings, bullets
  const lines = text.split('\n');
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        if (line.startsWith('### ')) return <h3 key={i} className="text-xs font-bold mt-2" style={{ color: 'var(--text-primary)' }}>{line.slice(4)}</h3>;
        if (line.startsWith('## ')) return <h2 key={i} className="text-sm font-bold mt-2" style={{ color: 'var(--text-primary)' }}>{line.slice(3)}</h2>;
        if (line.startsWith('# ')) return <h1 key={i} className="text-sm font-bold mt-2" style={{ color: 'var(--text-primary)' }}>{line.slice(2)}</h1>;
        if (line.startsWith('- ') || line.startsWith('* ')) return (
          <div key={i} className="flex gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span className="opacity-50">•</span>
            <InlineMarkdown text={line.slice(2)} />
          </div>
        );
        if (line.trim() === '') return <div key={i} className="h-2" />;
        return <p key={i} className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}><InlineMarkdown text={line} /></p>;
      })}
    </div>
  );
}

function InlineMarkdown({ text }) {
  // Replace **bold**, `code`, and [link](url)
  const parts = [];
  let remaining = text;
  let key = 0;
  while (remaining.length > 0) {
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    const codeMatch = remaining.match(/^`(.+?)`/);
    const linkMatch = remaining.match(/^\[(.+?)\]\((.+?)\)/);
    if (boldMatch) {
      parts.push(<strong key={key++} className="font-semibold" style={{ color: 'var(--text-primary)' }}>{boldMatch[1]}</strong>);
      remaining = remaining.slice(boldMatch[0].length);
    } else if (codeMatch) {
      parts.push(<code key={key++} className="font-mono text-[10px] px-1 py-0.5 rounded" style={{ background: 'var(--bg-app)', color: 'var(--accent-primary)' }}>{codeMatch[1]}</code>);
      remaining = remaining.slice(codeMatch[0].length);
    } else if (linkMatch) {
      parts.push(<a key={key++} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>{linkMatch[1]}</a>);
      remaining = remaining.slice(linkMatch[0].length);
    } else {
      const nextSpecial = remaining.search(/\*\*|`|\[/);
      const chunk = nextSpecial > 0 ? remaining.slice(0, nextSpecial) : remaining;
      parts.push(<span key={key++}>{chunk}</span>);
      remaining = nextSpecial > 0 ? remaining.slice(nextSpecial) : '';
    }
  }
  return <>{parts}</>;
}

// ── Tab button ────────────────────────────────────────────────────────────────
function TabButton({ active, onClick, icon: Icon, label, count }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium transition-all border-b-2 -mb-px"
      style={{
        borderBottomColor: active ? 'var(--accent-primary)' : 'transparent',
        color: active ? 'var(--accent-primary)' : 'var(--text-muted)',
      }}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {label}
      {count !== undefined && count > 0 && (
        <span className="text-[9px] px-1 rounded-full" style={{ background: active ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'var(--bg-panel)' }}>
          {count}
        </span>
      )}
    </button>
  );
}

// ── CommentBox ────────────────────────────────────────────────────────────────
function CommentBox({ onSubmit, placeholder = 'Leave a comment…', submitLabel = 'Comment', loading }) {
  const [text, setText] = useState('');

  const handleSubmit = async () => {
    if (!text.trim()) return;
    await onSubmit(text.trim());
    setText('');
  };

  return (
    <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'var(--border-medium)' }}>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full px-3 py-2 text-xs resize-none outline-none"
        style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSubmit();
        }}
      />
      <div
        className="flex items-center justify-between px-3 py-1.5 border-t"
        style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
      >
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Ctrl+Enter to submit</span>
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || loading}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition disabled:opacity-50"
          style={{ background: 'var(--accent-primary)', color: '#fff' }}
        >
          <Send className="w-3 h-3" />
          {loading ? 'Posting…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── ReviewPanel ───────────────────────────────────────────────────────────────
function ReviewPanel({ slug, owner, repo, prNumber }) {
  const dispatch = useDispatch();
  const { reviewLoading, actionError } = useSelector(s => s.pr);
  const [event, setEvent] = useState('COMMENT');
  const [body, setBody] = useState('');

  const handleSubmit = async () => {
    if (!body.trim() && event === 'COMMENT') return;
    const result = await dispatch(submitReview({ owner, repo, prNumber, slug, event, body }));
    if (submitReview.fulfilled.match(result)) {
      toast.success(`Review submitted: ${event}`);
      setBody('');
      setEvent('COMMENT');
    } else {
      toast.error(actionError || 'Review failed');
    }
  };

  const eventOptions = [
    { value: 'APPROVE', label: 'Approve', icon: ThumbsUp, color: 'text-emerald-400' },
    { value: 'REQUEST_CHANGES', label: 'Request Changes', icon: ThumbsDown, color: 'text-amber-400' },
    { value: 'COMMENT', label: 'Comment Only', icon: MessageSquare, color: 'text-sky-400' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-1 flex-wrap">
        {eventOptions.map(opt => (
          <button
            key={opt.value}
            onClick={() => setEvent(opt.value)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition ${event === opt.value ? 'border-current' : ''}`}
            style={{
              borderColor: event === opt.value ? 'currentColor' : 'var(--border-subtle)',
              color: event === opt.value ? undefined : 'var(--text-muted)',
            }}
          >
            <opt.icon className={`w-3 h-3 ${event === opt.value ? opt.color : ''}`} />
            {opt.label}
          </button>
        ))}
      </div>
      <CommentBox
        onSubmit={handleSubmit}
        placeholder={`Submit ${event.toLowerCase().replace('_', ' ')} review…`}
        submitLabel={reviewLoading ? 'Submitting…' : 'Submit Review'}
        loading={reviewLoading}
      />
    </div>
  );
}

// ── MergePanel ────────────────────────────────────────────────────────────────
function MergePanel({ slug, owner, repo, pr }) {
  const dispatch = useDispatch();
  const { mergePRLoading, actionError } = useSelector(s => s.pr);
  const [method, setMethod] = useState('merge');
  const [commitTitle, setCommitTitle] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  const [showOptions, setShowOptions] = useState(false);

  const handleMerge = async () => {
    const result = await dispatch(mergePR({
      owner, repo, prNumber: pr.number, slug,
      mergeMethod: method,
      commitTitle: commitTitle || undefined,
      commitMessage: commitMsg || undefined,
    }));
    if (mergePR.fulfilled.match(result)) {
      toast.success('Pull request merged!');
      dispatch(fetchPRList({ owner, repo, state: 'open', slug }));
    } else {
      toast.error(actionError || 'Merge failed. Check if all requirements are satisfied.');
    }
  };

  if (!pr || pr.merged) return null;
  if (pr.state === 'closed') return null;

  const methodLabels = {
    merge: 'Create a merge commit',
    squash: 'Squash and merge',
    rebase: 'Rebase and merge',
  };

  return (
    <div
      className="rounded-lg p-3 border"
      style={{ background: 'rgba(52,211,153,0.04)', borderColor: 'rgba(52,211,153,0.2)' }}
    >
      <div className="flex items-center gap-2 mb-2">
        <GitMerge className="w-4 h-4 text-emerald-400" />
        <span className="text-xs font-semibold text-emerald-400">Ready to merge</span>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleMerge}
          disabled={mergePRLoading}
          className="flex-1 py-2 rounded-lg text-xs font-semibold transition disabled:opacity-50"
          style={{ background: '#238636', color: '#fff' }}
        >
          {mergePRLoading ? 'Merging…' : methodLabels[method]}
        </button>
        <button
          onClick={() => setShowOptions(v => !v)}
          className="px-2 py-2 rounded-lg text-xs border transition"
          style={{ borderColor: 'rgba(52,211,153,0.3)', color: 'text-emerald-400' }}
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      </div>

      {showOptions && (
        <div
          className="mt-2 rounded-lg border overflow-hidden"
          style={{ borderColor: 'var(--border-medium)', background: 'var(--bg-elevated)' }}
        >
          {['merge', 'squash', 'rebase'].map(m => (
            <button
              key={m}
              onClick={() => { setMethod(m); setShowOptions(false); }}
              className="flex items-center gap-2 w-full px-3 py-2 text-xs text-left hover:opacity-80 transition border-b last:border-b-0"
              style={{
                borderColor: 'var(--border-subtle)',
                background: m === method ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' : 'transparent',
                color: 'var(--text-primary)',
              }}
            >
              {m === method && <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />}
              {m !== method && <div className="w-3 h-3 flex-shrink-0" />}
              {methodLabels[m]}
            </button>
          ))}
        </div>
      )}

      {/* Custom commit title/message for merge/squash */}
      {(method === 'merge' || method === 'squash') && (
        <div className="mt-2 space-y-1.5">
          <input
            type="text"
            value={commitTitle}
            onChange={e => setCommitTitle(e.target.value)}
            placeholder={`Merge pull request #${pr.number} from ${pr.head?.label}`}
            className="w-full px-2 py-1.5 text-xs rounded-lg border outline-none"
            style={{ background: 'var(--bg-app)', borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}
          />
          <textarea
            value={commitMsg}
            onChange={e => setCommitMsg(e.target.value)}
            placeholder="Optional commit message…"
            rows={2}
            className="w-full px-2 py-1.5 text-xs rounded-lg border outline-none resize-none"
            style={{ background: 'var(--bg-app)', borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}
          />
        </div>
      )}
    </div>
  );
}

// ── PRDetail main component ───────────────────────────────────────────────────

export function PRDetail({ slug, onBack }) {
  const dispatch = useDispatch();
  const {
    githubInfo, activePR: pr, prDetailLoading, prDetailError,
    prFiles, prCommits, prReviews, prIssueComments, prChecks,
    commentLoading, actionError,
  } = useSelector(s => s.pr);

  const [tab, setTab] = useState('overview');
  const [editingTitle, setEditingTitle] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [closingPR, setClosingPR] = useState(false);

  const { owner, repo } = githubInfo || {};

  useEffect(() => {
    if (pr?.number && owner && repo) {
      dispatch(fetchPRDetail({ owner, repo, prNumber: pr.number, slug }));
    }
  }, [pr?.number, owner, repo, slug, dispatch]);

  const handleRefresh = () => {
    if (pr?.number) dispatch(fetchPRDetail({ owner, repo, prNumber: pr.number, slug }));
  };

  const handleTitleSave = async () => {
    if (!newTitle.trim() || newTitle.trim() === pr.title) {
      setEditingTitle(false);
      return;
    }
    const result = await dispatch(updatePR({ owner, repo, prNumber: pr.number, slug, updates: { title: newTitle.trim() } }));
    if (updatePR.fulfilled.match(result)) {
      toast.success('Title updated');
    }
    setEditingTitle(false);
  };

  const handleClose = async () => {
    setClosingPR(true);
    const action = pr.state === 'closed' ? reopenPR : closePR;
    const result = await dispatch(action({ owner, repo, prNumber: pr.number, slug }));
    if (action.fulfilled.match(result)) {
      toast.success(pr.state === 'closed' ? 'PR reopened' : 'PR closed');
    } else {
      toast.error(actionError || 'Action failed');
    }
    setClosingPR(false);
  };

  const handleComment = async (body) => {
    const result = await dispatch(postComment({ owner, repo, prNumber: pr.number, slug, body }));
    if (postComment.fulfilled.match(result)) {
      toast.success('Comment posted');
    } else {
      toast.error(actionError || 'Comment failed');
    }
  };

  const handleDeleteComment = async (commentId) => {
    if (!confirm('Delete this comment?')) return;
    await dispatch(deleteComment({ owner, repo, commentId, slug }));
    toast.success('Comment deleted');
  };

  if (!pr && !prDetailLoading) return null;

  const stateBadgeStyle = prStateBg(pr);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div
        className="flex-shrink-0 border-b px-3 py-2"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)' }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="p-1 rounded-md hover:opacity-70 transition flex-shrink-0"
            style={{ color: 'var(--text-muted)' }}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {pr ? (
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold flex-shrink-0"
                style={stateBadgeStyle}
              >
                {prStateIcon(pr)}
                {prStateLabel(pr)}
              </span>
              <span className="text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>#{pr.number}</span>
              <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>{pr.title}</span>
            </div>
          ) : (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading…</span>
          )}

          <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
            <button
              onClick={handleRefresh}
              disabled={prDetailLoading}
              className="p-1 rounded-md hover:opacity-70 transition disabled:opacity-30"
              style={{ color: 'var(--text-muted)' }}
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${prDetailLoading ? 'animate-spin' : ''}`} />
            </button>
            {pr && (
              <a
                href={pr.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 rounded-md hover:opacity-70 transition"
                style={{ color: 'var(--text-muted)' }}
                title="Open on GitHub"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Tab bar */}
        {pr && (
          <div className="flex gap-0 mt-2 border-b -mx-3 px-3" style={{ borderColor: 'var(--border-subtle)' }}>
            <TabButton active={tab === 'overview'} onClick={() => setTab('overview')} icon={FileText} label="Overview" />
            <TabButton active={tab === 'files'} onClick={() => setTab('files')} icon={FileText} label="Files" count={prFiles.length} />
            <TabButton active={tab === 'commits'} onClick={() => setTab('commits')} icon={GitCommit} label="Commits" count={prCommits.length} />
            <TabButton active={tab === 'comments'} onClick={() => setTab('comments')} icon={MessageSquare} label="Comments" count={prIssueComments.length} />
            <TabButton active={tab === 'review'} onClick={() => setTab('review')} icon={CheckSquare} label="Review" />
            {prChecks.length > 0 && (
              <TabButton active={tab === 'checks'} onClick={() => setTab('checks')} icon={CheckSquare} label="Checks" count={prChecks.length} />
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {prDetailLoading && !pr && (
          <div className="flex items-center justify-center h-24 text-xs" style={{ color: 'var(--text-muted)' }}>
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        )}

        {prDetailError && (
          <div className="mx-3 mt-3 p-3 rounded-lg text-xs text-red-400" style={{ background: 'rgba(239,68,68,0.08)' }}>
            <AlertCircle className="w-3.5 h-3.5 inline mr-1" />{prDetailError}
          </div>
        )}

        {pr && tab === 'overview' && (
          <OverviewTab
            pr={pr}
            slug={slug}
            owner={owner}
            repo={repo}
            onEditTitle={() => { setNewTitle(pr.title); setEditingTitle(true); }}
            editingTitle={editingTitle}
            newTitle={newTitle}
            setNewTitle={setNewTitle}
            onTitleSave={handleTitleSave}
            onTitleCancel={() => setEditingTitle(false)}
            onClose={handleClose}
            closingPR={closingPR}
            reviews={prReviews}
          />
        )}

        {pr && tab === 'files' && <FilesTab files={prFiles} pr={pr} />}
        {pr && tab === 'commits' && <CommitsTab commits={prCommits} />}
        {pr && tab === 'comments' && (
          <CommentsTab
            comments={prIssueComments}
            onDelete={handleDeleteComment}
            onComment={handleComment}
            commentLoading={commentLoading}
          />
        )}
        {pr && tab === 'review' && (
          <div className="p-3 space-y-4">
            <MergePanel slug={slug} owner={owner} repo={repo} pr={pr} />
            <ReviewPanel slug={slug} owner={owner} repo={repo} prNumber={pr.number} />
          </div>
        )}
        {pr && tab === 'checks' && <ChecksTab checks={prChecks} />}
      </div>
    </div>
  );
}

// ── Overview Tab ──────────────────────────────────────────────────────────────
function OverviewTab({ pr, slug, owner, repo, onEditTitle, editingTitle, newTitle, setNewTitle, onTitleSave, onTitleCancel, onClose, closingPR, reviews }) {
  return (
    <div className="p-3 space-y-4">
      {/* Title row */}
      <div>
        {editingTitle ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') onTitleSave(); if (e.key === 'Escape') onTitleCancel(); }}
              className="flex-1 px-2 py-1 rounded-lg text-sm border outline-none"
              style={{ background: 'var(--bg-app)', borderColor: 'var(--accent-primary)', color: 'var(--text-primary)' }}
            />
            <button onClick={onTitleSave} className="px-2 py-1 rounded-lg text-xs" style={{ background: 'var(--accent-primary)', color: '#fff' }}>Save</button>
            <button onClick={onTitleCancel} className="px-2 py-1 rounded-lg text-xs border" style={{ borderColor: 'var(--border-medium)', color: 'var(--text-muted)' }}>Cancel</button>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <h3 className="text-sm font-semibold flex-1 leading-snug" style={{ color: 'var(--text-primary)' }}>{pr.title}</h3>
            <button onClick={onEditTitle} className="p-1 rounded hover:opacity-70 transition flex-shrink-0" style={{ color: 'var(--text-muted)' }} title="Edit title">
              <Edit3 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Meta */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
          <span className="flex items-center gap-1">
            <img src={pr.user?.avatar_url} alt={pr.user?.login} className="w-3.5 h-3.5 rounded-full" />
            <a href={pr.user?.html_url} target="_blank" rel="noopener noreferrer" className="hover:underline">{pr.user?.login}</a>
          </span>
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {relativeTime(pr.created_at)}
          </span>
          <span className="flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            <code className="font-mono">{pr.head?.label}</code>
            <ArrowRightLeft className="w-3 h-3" />
            <code className="font-mono">{pr.base?.label}</code>
          </span>
          <span>{pr.commits} commit{pr.commits !== 1 ? 's' : ''}</span>
          <span className="text-emerald-400">+{pr.additions}</span>
          <span className="text-red-400">-{pr.deletions}</span>
        </div>
      </div>

      {/* Labels */}
      {pr.labels?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {pr.labels.map(label => (
            <span
              key={label.id}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium"
              style={{ background: `#${label.color}22`, color: `#${label.color}`, border: `1px solid #${label.color}44` }}
            >
              <span className="w-2 h-2 rounded-full" style={{ background: `#${label.color}` }} />
              {label.name}
            </span>
          ))}
        </div>
      )}

      {/* Description */}
      <div
        className="rounded-lg p-3 border"
        style={{ background: 'var(--bg-app)', borderColor: 'var(--border-subtle)' }}
      >
        <MarkdownText text={pr.body} />
      </div>

      {/* Assignees */}
      {pr.assignees?.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>ASSIGNEES</p>
          <div className="flex gap-2 flex-wrap">
            {pr.assignees.map(u => (
              <a key={u.id} href={u.html_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs hover:underline" style={{ color: 'var(--text-secondary)' }}>
                <img src={u.avatar_url} alt={u.login} className="w-4 h-4 rounded-full" />
                {u.login}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Reviews summary */}
      {reviews?.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>REVIEWS</p>
          <div className="space-y-1.5">
            {reviews.map(review => (
              <ReviewRow key={review.id} review={review} />
            ))}
          </div>
        </div>
      )}

      {/* Close / Reopen */}
      {!pr.merged && (
        <button
          onClick={onClose}
          disabled={closingPR}
          className="w-full py-2 rounded-lg text-xs font-medium border transition hover:opacity-80 disabled:opacity-50"
          style={{
            borderColor: pr.state === 'closed' ? 'rgba(52,211,153,0.3)' : 'rgba(239,68,68,0.3)',
            color: pr.state === 'closed' ? '#34d399' : '#f87171',
          }}
        >
          {closingPR ? 'Working…' : pr.state === 'closed' ? 'Reopen Pull Request' : 'Close Pull Request'}
        </button>
      )}
    </div>
  );
}

function ReviewRow({ review }) {
  const icon = review.state === 'APPROVED'
    ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
    : review.state === 'CHANGES_REQUESTED'
    ? <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
    : <MessageSquare className="w-3.5 h-3.5 text-sky-400 flex-shrink-0" />;

  return (
    <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
      {icon}
      <img src={review.user?.avatar_url} alt={review.user?.login} className="w-3.5 h-3.5 rounded-full" />
      <span>{review.user?.login}</span>
      <span className="opacity-50 ml-auto">{relativeTime(review.submitted_at)}</span>
    </div>
  );
}

// ── Files Tab ─────────────────────────────────────────────────────────────────
function FilesTab({ files, pr }) {
  const [expandedFiles, setExpandedFiles] = useState({});

  return (
    <div className="p-3 space-y-1.5">
      <p className="text-[10px] font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
        {files.length} file{files.length !== 1 ? 's' : ''} changed
        {pr && <span className="ml-2 text-emerald-400">+{pr.additions}</span>}
        {pr && <span className="ml-1 text-red-400">-{pr.deletions}</span>}
      </p>
      {files.map(file => (
        <div key={file.sha || file.filename}
          className="rounded-lg border overflow-hidden"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <button
            onClick={() => setExpandedFiles(prev => ({ ...prev, [file.filename]: !prev[file.filename] }))}
            className="flex items-center gap-2 w-full px-2.5 py-2 text-left hover:opacity-80 transition"
            style={{ background: 'var(--bg-panel)', color: 'var(--text-primary)' }}
          >
            <span
              className={`text-[10px] font-bold font-mono w-3.5 text-center ${fileDiffColor(file.status)}`}
            >{fileDiffLabel(file.status)}</span>
            <span className="text-xs font-mono flex-1 truncate">{file.filename}</span>
            {file.previous_filename && (
              <span className="text-[10px] opacity-50 truncate">(was {file.previous_filename})</span>
            )}
            <span className="text-[10px] text-emerald-400 flex-shrink-0">+{file.additions}</span>
            <span className="text-[10px] text-red-400 flex-shrink-0 ml-1">-{file.deletions}</span>
            <ChevronDown
              className="w-3 h-3 flex-shrink-0 ml-1 transition-transform"
              style={{ transform: expandedFiles[file.filename] ? 'rotate(180deg)' : 'none', color: 'var(--text-muted)' }}
            />
          </button>
          {expandedFiles[file.filename] && file.patch && (
            <pre
              className="text-[10px] font-mono px-3 py-2 overflow-x-auto leading-relaxed"
              style={{ background: 'var(--bg-app)', color: 'var(--text-secondary)', maxHeight: '300px', overflowY: 'auto' }}
            >
              {file.patch.split('\n').map((line, i) => (
                <div
                  key={i}
                  style={{
                    color: line.startsWith('+') ? '#34d399' : line.startsWith('-') ? '#f87171' : line.startsWith('@@') ? '#818cf8' : undefined,
                    background: line.startsWith('+') ? 'rgba(52,211,153,0.06)' : line.startsWith('-') ? 'rgba(248,113,113,0.06)' : 'transparent',
                  }}
                >
                  {line}
                </div>
              ))}
            </pre>
          )}
        </div>
      ))}
      {files.length === 0 && (
        <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>No files changed.</p>
      )}
    </div>
  );
}

// ── Commits Tab ───────────────────────────────────────────────────────────────
function CommitsTab({ commits }) {
  return (
    <div className="p-3 space-y-1.5">
      {commits.map(c => (
        <div key={c.sha}
          className="flex items-start gap-2 px-2.5 py-2 rounded-lg border"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)' }}
        >
          <GitCommit className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <div className="min-w-0 flex-1">
            <p className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>{c.commit?.message?.split('\n')[0]}</p>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[10px] font-mono" style={{ color: 'var(--text-muted)' }}>{c.sha?.slice(0, 7)}</span>
              {c.author && <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{c.commit?.author?.name}</span>}
              <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{relativeTime(c.commit?.author?.date)}</span>
            </div>
          </div>
        </div>
      ))}
      {commits.length === 0 && (
        <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>No commits.</p>
      )}
    </div>
  );
}

// ── Comments Tab ──────────────────────────────────────────────────────────────
function CommentsTab({ comments, onDelete, onComment, commentLoading }) {
  return (
    <div className="p-3 space-y-3">
      {/* Comment list */}
      {comments.map(c => (
        <CommentCard key={c.id} comment={c} onDelete={onDelete} />
      ))}
      {comments.length === 0 && (
        <p className="text-xs py-2 text-center" style={{ color: 'var(--text-muted)' }}>No comments yet.</p>
      )}
      {/* New comment box */}
      <div className="pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
        <CommentBox onSubmit={onComment} loading={commentLoading} />
      </div>
    </div>
  );
}

function CommentCard({ comment, onDelete }) {
  const [showDelete, setShowDelete] = useState(false);
  return (
    <div
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: 'var(--border-subtle)' }}
      onMouseEnter={() => setShowDelete(true)}
      onMouseLeave={() => setShowDelete(false)}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 border-b"
        style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
      >
        <img src={comment.user?.avatar_url} alt={comment.user?.login} className="w-4 h-4 rounded-full" />
        <a href={comment.user?.html_url} target="_blank" rel="noopener noreferrer"
          className="text-xs font-medium hover:underline" style={{ color: 'var(--text-primary)' }}>
          {comment.user?.login}
        </a>
        <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{relativeTime(comment.created_at)}</span>
        {showDelete && (
          <button onClick={() => onDelete(comment.id)} className="p-0.5 rounded hover:opacity-70 transition" style={{ color: 'var(--text-muted)' }}>
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {/* Body */}
      <div className="px-2.5 py-2" style={{ background: 'var(--bg-app)' }}>
        <MarkdownText text={comment.body} />
      </div>
    </div>
  );
}

// ── Checks Tab ────────────────────────────────────────────────────────────────
function ChecksTab({ checks }) {
  return (
    <div className="p-3 space-y-1.5">
      {checks.map(check => (
        <div key={check.id}
          className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)' }}
        >
          {checkIcon(check.status, check.conclusion)}
          <div className="min-w-0 flex-1">
            <p className="text-xs" style={{ color: 'var(--text-primary)' }}>{check.name}</p>
            {check.app?.name && (
              <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{check.app.name}</p>
            )}
          </div>
          <span className="text-[10px] capitalize" style={{ color: 'var(--text-muted)' }}>
            {check.conclusion || check.status}
          </span>
          {check.html_url && (
            <a href={check.html_url} target="_blank" rel="noopener noreferrer"
              className="p-1 hover:opacity-70 transition" style={{ color: 'var(--text-muted)' }}>
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      ))}
      {checks.length === 0 && (
        <p className="text-xs py-4 text-center" style={{ color: 'var(--text-muted)' }}>No checks.</p>
      )}
    </div>
  );
}
