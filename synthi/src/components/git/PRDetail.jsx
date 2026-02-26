'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchPRDetail, updatePR, mergePR, closePR, reopenPR,
  submitReview, postComment, deleteComment, setLabels, setAssignees,
  fetchRepoLabels, fetchRepoCollaborators, setActivePR, clearActionError, fetchRepoBranches,
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
import { MarkdownRenderer, MarkdownEditor, MarkdownToolbar, handleMarkdownKeyDown } from './MarkdownRenderer';

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

// ── Markdown rendering — uses full MarkdownRenderer from ./MarkdownRenderer ──
// The MarkdownText alias ensures backward-compat with internal usages.
function MarkdownText({ text }) {
  return <MarkdownRenderer text={text} />;
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
  const [mode, setMode] = useState('write');
  const textareaRef = React.useRef(null);

  const handleSubmit = async () => {
    if (!text.trim()) return;
    await onSubmit(text.trim());
    setText('');
    setMode('write');
  };

  return (
    <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'var(--border-medium)' }}>
      {/* Write / Preview tabs */}
      <div className="flex items-center border-b"
        style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}>
        <button onClick={() => setMode('write')}
          className="px-2.5 py-1 text-[10px] font-medium border-b-2 -mb-px transition"
          style={{
            borderBottomColor: mode === 'write' ? 'var(--accent-primary)' : 'transparent',
            color: mode === 'write' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}>Write</button>
        <button onClick={() => setMode('preview')}
          className="px-2.5 py-1 text-[10px] font-medium border-b-2 -mb-px transition"
          style={{
            borderBottomColor: mode === 'preview' ? 'var(--accent-primary)' : 'transparent',
            color: mode === 'preview' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}>Preview</button>
      </div>
      {mode === 'write' && <MarkdownToolbar textareaRef={textareaRef} />}
      {mode === 'write' ? (
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="w-full px-3 py-2 text-xs resize-none outline-none"
          style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSubmit();
            handleMarkdownKeyDown(e, textareaRef);
          }}
        />
      ) : (
        <div className="px-3 py-2 min-h-[72px]"
          style={{ background: 'var(--bg-app)' }}>
          {text.trim() ? (
            <MarkdownRenderer text={text} />
          ) : (
            <p className="text-xs italic" style={{ color: 'var(--text-muted)' }}>Nothing to preview</p>
          )}
        </div>
      )}
      <div
        className="flex items-center justify-between px-3 py-1.5 border-t"
        style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
      >
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Markdown supported · Ctrl+Enter to submit</span>
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
  const { reviewLoading } = useSelector(s => s.pr);
  const [event, setEvent] = useState('COMMENT');
  const [body, setBody] = useState('');

  const handleSubmit = async () => {
    if (!body.trim() && event === 'COMMENT') return;
    const result = await dispatch(submitReview({ owner, repo, prNumber, slug, event, body }));
    if (submitReview.fulfilled.match(result)) {
      toast.success(`Review submitted: ${event.replace('_', ' ').toLowerCase()}`);
      setBody('');
      setEvent('COMMENT');
      // Refresh the PR detail to get updated reviews
      dispatch(fetchPRDetail({ owner, repo, prNumber, slug }));
    } else {
      toast.error(result.payload?.error || 'Review submission failed');
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
        onSubmit={async (text) => {
          setBody(text);
          if (!text.trim() && event === 'COMMENT') return;
          const result = await dispatch(submitReview({ owner, repo, prNumber, slug, event, body: text }));
          if (submitReview.fulfilled.match(result)) {
            toast.success(`Review submitted: ${event.replace('_', ' ').toLowerCase()}`);
            setBody('');
            setEvent('COMMENT');
            dispatch(fetchPRDetail({ owner, repo, prNumber, slug }));
          } else {
            toast.error(result.payload?.error || 'Review submission failed');
          }
        }}
        placeholder={`Submit ${event.toLowerCase().replace('_', ' ')} review…`}
        submitLabel={reviewLoading ? 'Submitting…' : 'Submit Review'}
        loading={reviewLoading}
      />
    </div>
  );
}

// ── MergePanel ────────────────────────────────────────────────────────────────
function MergePanel({ slug, owner, repo, pr, files, onFileClick }) {
  const dispatch = useDispatch();
  const { mergePRLoading } = useSelector(s => s.pr);
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
      // Refresh detail to show updated state
      dispatch(fetchPRDetail({ owner, repo, prNumber: pr.number, slug }));
    } else {
      toast.error(result.payload?.error || 'Merge failed. Check if all requirements are satisfied.');
    }
  };

  if (!pr || pr.merged) return null;
  if (pr.state === 'closed') return null;

  const hasConflicts = pr.mergeable === false && pr.mergeable_state === 'dirty';
  const isChecking = pr.mergeable == null || pr.mergeable_state === 'unknown';
  const isBlocked = pr.mergeable_state === 'blocked';

  const methodLabels = {
    merge: 'Create a merge commit',
    squash: 'Squash and merge',
    rebase: 'Rebase and merge',
  };

  // Identify conflicted files — GitHub marks them with status 'conflicted' or
  // we detect them from the `conflicts` attribute on file objects.
  const conflictedFiles = (files || []).filter(f =>
    f.status === 'conflicted' || f.conflicts
  );

  return (
    <div className="space-y-2">
      {/* ── Merge Conflicts Warning ────────── */}
      {hasConflicts && (
        <div
          className="rounded-lg p-3 border"
          style={{ background: 'rgba(245,158,66,0.06)', borderColor: 'rgba(245,158,66,0.25)' }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <AlertCircle className="w-4 h-4 text-amber-400" />
            <span className="text-xs font-semibold text-amber-400">Merge Conflicts</span>
          </div>
          <p className="text-[11px] leading-relaxed mb-2" style={{ color: 'var(--text-secondary)' }}>
            This branch has conflicts that must be resolved before merging.
            {conflictedFiles.length > 0 ? ` ${conflictedFiles.length} conflicted file${conflictedFiles.length !== 1 ? 's' : ''}:` : ''}
          </p>
          {conflictedFiles.length > 0 && (
            <ul className="space-y-0.5 mb-2">
              {conflictedFiles.map((f, i) => (
                <li
                  key={i}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] cursor-pointer hover:bg-amber-500/10 transition-colors"
                  onClick={() => onFileClick?.(f.filename)}
                >
                  <AlertCircle className="w-3 h-3 text-amber-400 flex-shrink-0" />
                  <span className="truncate" style={{ color: 'var(--text-primary)' }}>{f.filename}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => {
                // Checkout the PR branch locally to resolve conflicts
                toast.info(`Checkout the '${pr.head?.ref}' branch locally, resolve conflicts, and push.`);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors hover:opacity-90"
              style={{ background: 'rgba(59,130,246,0.10)', borderColor: 'rgba(59,130,246,0.30)', color: '#60a5fa' }}
            >
              <ArrowRightLeft className="w-3 h-3" />
              Resolve in Synthi
            </button>
            <a
              href={pr.html_url ? `${pr.html_url}/conflicts` : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border transition-colors hover:opacity-90"
              style={{ borderColor: 'var(--border-medium)', color: 'var(--text-secondary)' }}
            >
              <ExternalLink className="w-3 h-3" />
              Open in GitHub
            </a>
          </div>
        </div>
      )}

      {/* ── Checking mergeability spinner ──── */}
      {isChecking && (
        <div className="rounded-lg p-3 border flex items-center gap-2" style={{ background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}>
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-yellow-400" />
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Checking merge status…</span>
        </div>
      )}

      {/* ── Blocked by branch protection ──── */}
      {isBlocked && !hasConflicts && (
        <div className="rounded-lg p-3 border" style={{ background: 'rgba(239,68,68,0.06)', borderColor: 'rgba(239,68,68,0.25)' }}>
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-red-400" />
            <span className="text-xs font-semibold text-red-400">Merge blocked</span>
          </div>
          <p className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>
            Branch protection rules prevent merging. Required status checks or reviews may be missing.
          </p>
        </div>
      )}

      {/* ── Merge controls ────────────────── */}
      <div
        className="rounded-lg p-3 border"
        style={{
          background: hasConflicts ? 'rgba(161,161,170,0.04)' : 'rgba(52,211,153,0.04)',
          borderColor: hasConflicts ? 'rgba(161,161,170,0.2)' : 'rgba(52,211,153,0.2)',
        }}
      >
        <div className="flex items-center gap-2 mb-2">
          <GitMerge className={`w-4 h-4 ${hasConflicts ? 'text-[#71717a]' : 'text-emerald-400'}`} />
          <span className={`text-xs font-semibold ${hasConflicts ? 'text-[#71717a]' : 'text-emerald-400'}`}>
            {hasConflicts ? 'Resolve conflicts to merge' : 'Ready to merge'}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleMerge}
            disabled={mergePRLoading || hasConflicts}
            className="flex-1 py-2 rounded-lg text-xs font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: hasConflicts ? '#3f3f46' : '#238636', color: '#fff' }}
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
        {!hasConflicts && (method === 'merge' || method === 'squash') && (
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
    </div>
  );
}

// ── PRDetail main component ───────────────────────────────────────────────────

export function PRDetail({ slug, onBack }) {
  const dispatch = useDispatch();
  const {
    githubInfo, activePR: pr, prDetailLoading, prDetailError,
    prFiles, prCommits, prReviews, prIssueComments, prChecks,
    commentLoading,
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

  // Auto-refresh PR detail every 90 seconds
  useEffect(() => {
    if (!pr?.number || !owner || !repo) return;
    const interval = setInterval(() => {
      dispatch(fetchPRDetail({ owner, repo, prNumber: pr.number, slug }));
    }, 90_000);
    return () => clearInterval(interval);
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
      // Refresh PR list
      dispatch(fetchPRList({ owner, repo, state: 'open', slug }));
    } else {
      toast.error(result.payload?.error || 'Action failed');
    }
    setClosingPR(false);
  };

  const handleComment = async (body) => {
    const result = await dispatch(postComment({ owner, repo, prNumber: pr.number, slug, body }));
    if (postComment.fulfilled.match(result)) {
      toast.success('Comment posted');
    } else {
      toast.error(result.payload?.error || 'Comment failed');
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
            <MergePanel slug={slug} owner={owner} repo={repo} pr={pr} files={prFiles} />
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
  const dispatch = useDispatch();
  const { repoLabels, repoCollaborators } = useSelector(s => s.pr);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [editingBody, setEditingBody] = useState(false);
  const [newBody, setNewBody] = useState('');
  const [showAssigneePicker, setShowAssigneePicker] = useState(false);

  useEffect(() => {
    if (owner && repo && repoLabels.length === 0) {
      dispatch(fetchRepoLabels({ owner, repo, slug }));
    }
  }, [owner, repo, slug, dispatch, repoLabels.length]);

  useEffect(() => {
    if (owner && repo && repoCollaborators.length === 0) {
      dispatch(fetchRepoCollaborators({ owner, repo, slug }));
    }
  }, [owner, repo, slug, dispatch, repoCollaborators.length]);

  const handleBodySave = async () => {
    if (newBody === (pr.body || '')) {
      setEditingBody(false);
      return;
    }
    const result = await dispatch(updatePR({ owner, repo, prNumber: pr.number, slug, updates: { body: newBody } }));
    if (updatePR.fulfilled.match(result)) {
      toast.success('Description updated');
    }
    setEditingBody(false);
  };

  const handleToggleAssignee = async (user) => {
    const currentAssignees = pr.assignees || [];
    const isAssigned = currentAssignees.find(a => a.login === user.login);
    const newAssignees = isAssigned
      ? currentAssignees.filter(a => a.login !== user.login)
      : [...currentAssignees, user];
    dispatch(setAssignees({ owner, repo, prNumber: pr.number, slug, assignees: newAssignees }));
  };

  const handleToggleLabel = async (label) => {
    const currentLabels = pr.labels || [];
    const hasLabel = currentLabels.find(l => l.name === label.name);
    const newLabels = hasLabel
      ? currentLabels.filter(l => l.name !== label.name)
      : [...currentLabels, label];
    dispatch(setLabels({ owner, repo, prNumber: pr.number, slug, labels: newLabels }));
  };

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

      {/* Labels — editable */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>LABELS</p>
          <button
            onClick={() => setShowLabelPicker(v => !v)}
            className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 transition"
            style={{ color: 'var(--accent-primary)' }}
          >
            {showLabelPicker ? 'Done' : '+ Edit'}
          </button>
        </div>
        {pr.labels?.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
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
        {!pr.labels?.length && !showLabelPicker && (
          <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>No labels</p>
        )}
        {showLabelPicker && (
          <div
            className="rounded-lg border overflow-y-auto max-h-40 mt-1"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)' }}
          >
            {repoLabels.map(label => {
              const isSelected = pr.labels?.find(l => l.name === label.name);
              return (
                <button
                  key={label.id}
                  onClick={() => handleToggleLabel(label)}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs hover:opacity-80 transition text-left"
                  style={{ 
                    color: 'var(--text-primary)', 
                    background: isSelected ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : 'transparent' 
                  }}
                >
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: `#${label.color}` }} />
                  {label.name}
                  {isSelected && <CheckCircle2 className="w-3 h-3 ml-auto" style={{ color: 'var(--accent-primary)' }} />}
                </button>
              );
            })}
            {repoLabels.length === 0 && (
              <p className="text-[10px] py-2 px-2.5 italic" style={{ color: 'var(--text-muted)' }}>No labels in repository</p>
            )}
          </div>
        )}
      </div>

      {/* Description — editable */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>DESCRIPTION</p>
          {!editingBody && (
            <button
              onClick={() => { setNewBody(pr.body || ''); setEditingBody(true); }}
              className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 transition"
              style={{ color: 'var(--accent-primary)' }}
            >
              + Edit
            </button>
          )}
        </div>
        {editingBody ? (
          <div className="space-y-2">
            <MarkdownEditor
              value={newBody}
              onChange={setNewBody}
              placeholder="Describe this pull request…"
              rows={8}
            />
            <div className="flex gap-2">
              <button onClick={handleBodySave} className="px-3 py-1.5 rounded-lg text-xs font-medium" style={{ background: 'var(--accent-primary)', color: '#fff' }}>Save</button>
              <button onClick={() => setEditingBody(false)} className="px-3 py-1.5 rounded-lg text-xs border" style={{ borderColor: 'var(--border-medium)', color: 'var(--text-muted)' }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div
            className="rounded-lg p-3 border"
            style={{ background: 'var(--bg-app)', borderColor: 'var(--border-subtle)' }}
          >
            {pr.body ? (
              <MarkdownText text={pr.body} />
            ) : (
              <p className="text-xs italic" style={{ color: 'var(--text-muted)' }}>No description provided</p>
            )}
          </div>
        )}
      </div>

      {/* Assignees — editable */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>ASSIGNEES</p>
          <button
            onClick={() => setShowAssigneePicker(v => !v)}
            className="text-[10px] px-1.5 py-0.5 rounded hover:opacity-80 transition"
            style={{ color: 'var(--accent-primary)' }}
          >
            {showAssigneePicker ? 'Done' : '+ Edit'}
          </button>
        </div>
        {pr.assignees?.length > 0 && (
          <div className="flex gap-2 flex-wrap mb-1.5">
            {pr.assignees.map(u => (
              <a key={u.id} href={u.html_url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs hover:underline" style={{ color: 'var(--text-secondary)' }}>
                <img src={u.avatar_url} alt={u.login} className="w-4 h-4 rounded-full" />
                {u.login}
              </a>
            ))}
          </div>
        )}
        {!pr.assignees?.length && !showAssigneePicker && (
          <p className="text-[10px] italic" style={{ color: 'var(--text-muted)' }}>No assignees</p>
        )}
        {showAssigneePicker && (
          <div
            className="rounded-lg border overflow-y-auto max-h-40 mt-1"
            style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)' }}
          >
            {repoCollaborators.map(user => {
              const isSelected = pr.assignees?.find(a => a.login === user.login);
              return (
                <button
                  key={user.id}
                  onClick={() => handleToggleAssignee(user)}
                  className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs hover:opacity-80 transition text-left"
                  style={{
                    color: 'var(--text-primary)',
                    background: isSelected ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : 'transparent'
                  }}
                >
                  <img src={user.avatar_url} alt={user.login} className="w-4 h-4 rounded-full flex-shrink-0" />
                  {user.login}
                  {isSelected && <CheckCircle2 className="w-3 h-3 ml-auto" style={{ color: 'var(--accent-primary)' }} />}
                </button>
              );
            })}
            {repoCollaborators.length === 0 && (
              <p className="text-[10px] py-2 px-2.5 italic" style={{ color: 'var(--text-muted)' }}>No collaborators found</p>
            )}
          </div>
        )}
      </div>

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

/** Parse a unified diff patch into structured hunks for rendering */
function parsePatchHunks(patch) {
  if (!patch) return [];
  const lines = patch.split('\n');
  const hunks = [];
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)/);
    if (hunkHeader) {
      if (currentHunk) hunks.push(currentHunk);
      oldLine = parseInt(hunkHeader[1], 10);
      newLine = parseInt(hunkHeader[2], 10);
      currentHunk = { header: line, context: hunkHeader[3]?.trim() || '', lines: [] };
      continue;
    }
    if (!currentHunk) continue;
    if (line.startsWith('+')) {
      currentHunk.lines.push({ type: 'add', content: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({ type: 'del', content: line.slice(1), oldLine: oldLine++ });
    } else {
      currentHunk.lines.push({ type: 'ctx', content: line.startsWith(' ') ? line.slice(1) : line, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}

function DiffHunkView({ hunk }) {
  return (
    <div className="border-t first:border-t-0" style={{ borderColor: 'var(--border-subtle)' }}>
      {/* Hunk header */}
      <div className="px-3 py-1 text-[10px] font-mono select-none flex items-center gap-2"
        style={{ background: 'rgba(99,102,241,0.06)', color: '#818cf8' }}>
        <span>{hunk.header}</span>
        {hunk.context && <span className="opacity-60 truncate">{hunk.context}</span>}
      </div>
      {/* Lines */}
      <div className="font-mono text-[11px] leading-[1.6]">
        {hunk.lines.map((line, i) => {
          const bgColor = line.type === 'add'
            ? 'rgba(52,211,153,0.06)' : line.type === 'del'
            ? 'rgba(248,113,113,0.06)' : 'transparent';
          const textColor = line.type === 'add'
            ? '#34d399' : line.type === 'del'
            ? '#f87171' : 'var(--text-secondary, #a1a1aa)';
          const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          return (
            <div key={i} className="flex hover:brightness-110" style={{ background: bgColor }}>
              <span className="select-none text-right pr-1 min-w-[3em] opacity-30"
                style={{ color: 'var(--text-muted)' }}>
                {line.oldLine ?? ''}
              </span>
              <span className="select-none text-right pr-2 min-w-[3em] opacity-30 border-r mr-2"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                {line.newLine ?? ''}
              </span>
              <span className="select-none w-4 text-center flex-shrink-0" style={{ color: textColor }}>{prefix}</span>
              <span className="flex-1 whitespace-pre-wrap break-all" style={{ color: textColor }}>{line.content}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FilesTab({ files, pr }) {
  const [expandedFiles, setExpandedFiles] = useState({});
  const [diffViewMode, setDiffViewMode] = useState('unified'); // 'unified' | 'raw'

  return (
    <div className="p-3 space-y-1.5">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-semibold" style={{ color: 'var(--text-muted)' }}>
          {files.length} file{files.length !== 1 ? 's' : ''} changed
          {pr && <span className="ml-2 text-emerald-400">+{pr.additions}</span>}
          {pr && <span className="ml-1 text-red-400">-{pr.deletions}</span>}
        </p>
        <div className="flex gap-0.5">
          <button onClick={() => setDiffViewMode('unified')} title="Unified diff"
            className="px-1.5 py-0.5 rounded text-[10px] transition"
            style={{
              background: diffViewMode === 'unified' ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'transparent',
              color: diffViewMode === 'unified' ? 'var(--accent-primary)' : 'var(--text-muted)'
            }}>Unified</button>
          <button onClick={() => setDiffViewMode('raw')} title="Raw patch"
            className="px-1.5 py-0.5 rounded text-[10px] transition"
            style={{
              background: diffViewMode === 'raw' ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'transparent',
              color: diffViewMode === 'raw' ? 'var(--accent-primary)' : 'var(--text-muted)'
            }}>Raw</button>
        </div>
      </div>
      {files.map(file => {
        const hunks = expandedFiles[file.filename] && file.patch ? parsePatchHunks(file.patch) : [];
        return (
          <div key={file.sha || file.filename}
            className="rounded-lg border overflow-hidden"
            style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              onClick={() => setExpandedFiles(prev => ({ ...prev, [file.filename]: !prev[file.filename] }))}
              className="flex items-center gap-2 w-full px-2.5 py-2 text-left hover:opacity-80 transition"
              style={{ background: 'var(--bg-panel)', color: 'var(--text-primary)' }}>
              <span className={`text-[10px] font-bold font-mono w-3.5 text-center ${fileDiffColor(file.status)}`}>
                {fileDiffLabel(file.status)}
              </span>
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
              diffViewMode === 'unified' && hunks.length > 0 ? (
                <div style={{ background: 'var(--bg-app)', maxHeight: 400, overflowY: 'auto' }}>
                  {hunks.map((hunk, i) => <DiffHunkView key={i} hunk={hunk} />)}
                </div>
              ) : (
                <pre
                  className="text-[10px] font-mono px-3 py-2 overflow-x-auto leading-relaxed"
                  style={{ background: 'var(--bg-app)', color: 'var(--text-secondary)', maxHeight: '300px', overflowY: 'auto' }}>
                  {file.patch.split('\n').map((line, i) => (
                    <div key={i}
                      style={{
                        color: line.startsWith('+') ? '#34d399' : line.startsWith('-') ? '#f87171' : line.startsWith('@@') ? '#818cf8' : undefined,
                        background: line.startsWith('+') ? 'rgba(52,211,153,0.06)' : line.startsWith('-') ? 'rgba(248,113,113,0.06)' : 'transparent',
                      }}>{line}</div>
                  ))}
                </pre>
              )
            )}
          </div>
        );
      })}
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
