'use client';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchPRDetail, updatePR, mergePR, closePR, reopenPR,
  submitReview, postComment, deleteComment, setLabels, setAssignees,
  fetchRepoLabels, fetchRepoCollaborators, setActivePR, clearActionError, fetchRepoBranches,
  fetchPRList,
} from '@/redux/prSlice';
import { checkoutBranch, mergeBranchForConflicts, fetchGitStatus, fetchRemote, checkMergeConflicts } from '@/redux/gitSlice';
import {
  ChevronLeft, GitMerge, GitPullRequest, Circle, CheckCircle2,
  XCircle, RefreshCw, MessageSquare, FileText, GitCommit, CheckSquare,
  AlertCircle, ExternalLink, ChevronDown, Edit3, Tag, User,
  ThumbsUp, ThumbsDown, Send, Trash2, MoreHorizontal, Lock, Unlock,
  Copy, ArrowRightLeft, ArrowRight, GitBranch, Clock, Plus, Minus,
} from 'lucide-react';
import { toast } from 'sonner';
import { MarkdownRenderer, MarkdownEditor, MarkdownToolbar, handleMarkdownKeyDown } from './MarkdownRenderer';
import { useConfirmDialog } from '@/components/ui/useConfirmDialog';

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns a CSS color value (var or hex), not a className.  Callsites
// spread it into `style={{ color: ... }}` so we stay on brand tokens.
function prStateColor(pr) {
  if (!pr) return 'var(--text-muted)';
  if (pr.merged) return 'var(--brand-stop-3)';
  if (pr.state === 'closed') return 'var(--accent-danger)';
  if (pr.draft) return 'var(--text-muted)';
  return 'var(--accent-success)';
}

function prStateBg(pr) {
  if (!pr) return '';
  if (pr.merged) return {
    background: 'color-mix(in srgb, var(--brand-stop-3) 15%, transparent)',
    color: 'var(--brand-stop-3)',
    border: '1px solid color-mix(in srgb, var(--brand-stop-3) 30%, transparent)',
  };
  if (pr.state === 'closed') return {
    background: 'color-mix(in srgb, var(--accent-danger) 12%, transparent)',
    color: 'var(--accent-danger)',
    border: '1px solid color-mix(in srgb, var(--accent-danger) 25%, transparent)',
  };
  if (pr.draft) return {
    background: 'color-mix(in srgb, var(--text-muted) 12%, transparent)',
    color: 'var(--text-muted)',
    border: '1px solid color-mix(in srgb, var(--text-muted) 25%, transparent)',
  };
  return {
    background: 'color-mix(in srgb, var(--accent-success) 12%, transparent)',
    color: 'var(--accent-success)',
    border: '1px solid color-mix(in srgb, var(--accent-success) 25%, transparent)',
  };
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
  if (status !== 'completed') return <Clock className="w-3.5 h-3.5" style={{ color: 'var(--accent-warning)' }} strokeWidth={2} />;
  if (conclusion === 'success') return <CheckCircle2 className="w-3.5 h-3.5" style={{ color: 'var(--accent-success)' }} strokeWidth={2} />;
  if (conclusion === 'failure' || conclusion === 'timed_out') return <XCircle className="w-3.5 h-3.5" style={{ color: 'var(--accent-danger)' }} strokeWidth={2} />;
  return <AlertCircle className="w-3.5 h-3.5" style={{ color: 'var(--accent-warning)' }} strokeWidth={2} />;
}

// Returns a CSS color value (not a className) so the callsite uses
// `style={{ color: fileDiffColor(s) }}` instead of a tailwind class.
function fileDiffColor(status) {
  const map = {
    added: 'var(--accent-success)',
    removed: 'var(--accent-danger)',
    modified: 'var(--accent-warning)',
    renamed: 'var(--accent-secondary)',
    copied: 'var(--accent-secondary)',
    changed: 'var(--accent-warning)',
  };
  return map[status] || 'var(--text-muted)';
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
      className={`th-focus-ring flex flex-shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-xs font-medium transition-all ${active ? 'th-btn-active' : 'th-btn-ghost'}`}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {label}
      {count !== undefined && count > 0 && (
        <span className="vt-state-pill h-4 px-1 text-[9px]">
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
    <div className="vt-workflow-card overflow-hidden">
      {/* Write / Preview tabs */}
      <div className="flex items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--surface-panel-subtle)] px-2 py-1">
        <button onClick={() => setMode('write')}
          className={`th-focus-ring rounded-[var(--radius-control)] px-2.5 py-1 text-[10px] font-medium transition ${mode === 'write' ? 'th-btn-active' : 'th-btn-ghost'}`}>Write</button>
        <button onClick={() => setMode('preview')}
          className={`th-focus-ring rounded-[var(--radius-control)] px-2.5 py-1 text-[10px] font-medium transition ${mode === 'preview' ? 'th-btn-active' : 'th-btn-ghost'}`}>Preview</button>
      </div>
      {mode === 'write' && <MarkdownToolbar textareaRef={textareaRef} />}
      {mode === 'write' ? (
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="th-input w-full resize-none border-0 px-3 py-2 text-xs outline-none"
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSubmit();
            handleMarkdownKeyDown(e, textareaRef);
          }}
        />
      ) : (
        <div className="min-h-[72px] bg-[var(--bg-app)] px-3 py-2">
          {text.trim() ? (
            <MarkdownRenderer text={text} />
          ) : (
            <p className="text-xs italic text-[var(--text-muted)]">Nothing to preview</p>
          )}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-[var(--border-subtle)] bg-[var(--surface-panel-subtle)] px-3 py-1.5">
        <span className="text-[10px] text-[var(--text-muted)]">Markdown supported. Ctrl+Enter to submit.</span>
        <button
          onClick={handleSubmit}
          disabled={!text.trim() || loading}
          className="th-focus-ring th-btn-primary flex items-center gap-1 px-2.5 py-1 text-xs font-medium disabled:opacity-50"
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
    { value: 'APPROVE', label: 'Approve', icon: ThumbsUp, color: 'var(--accent-success)' },
    { value: 'REQUEST_CHANGES', label: 'Request Changes', icon: ThumbsDown, color: 'var(--accent-warning)' },
    { value: 'COMMENT', label: 'Comment Only', icon: MessageSquare, color: 'var(--accent-secondary)' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-1 flex-wrap">
        {eventOptions.map(opt => (
          <button
            key={opt.value}
            onClick={() => setEvent(opt.value)}
            className={`th-focus-ring flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1 text-xs transition ${event === opt.value ? 'th-btn-active' : 'th-btn-ghost'}`}
            style={{ '--chip-color': opt.color }}
          >
            <opt.icon className="w-3 h-3" style={{ color: event === opt.value ? opt.color : undefined }} />
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
function MergePanel({ slug, owner, repo, pr, files, onFileClick, refreshKey }) {
  const dispatch = useDispatch();
  const { mergePRLoading } = useSelector(s => s.pr);
  const [method, setMethod] = useState('merge');
  const [commitTitle, setCommitTitle] = useState('');
  const [commitMsg, setCommitMsg] = useState('');
  const [showOptions, setShowOptions] = useState(false);

  // ── Fast in-memory conflict detection via git merge-tree ──
  // Instead of waiting for GitHub's lazy mergeable computation (~1 minute),
  // we run `git merge-tree` locally which completes in milliseconds.
  const [localConflictCheck, setLocalConflictCheck] = useState(null); // { hasConflicts, conflictedFiles }
  const [localConflictLoading, setLocalConflictLoading] = useState(true);

  useEffect(() => {
    if (!pr || pr.merged || pr.state === 'closed') return;
    if (!pr.base?.ref || !pr.head?.ref) return;

    let cancelled = false;
    setLocalConflictLoading(true);

    dispatch(checkMergeConflicts({
      slug,
      baseBranch: pr.base.ref,
      headBranch: pr.head.ref,
    })).then(result => {
      if (cancelled) return;
      if (checkMergeConflicts.fulfilled.match(result)) {
        setLocalConflictCheck(result.payload);
      } else {
        // If local check fails, fall back to GitHub's mergeable field
        setLocalConflictCheck(null);
      }
      setLocalConflictLoading(false);
    }).catch(() => {
      if (!cancelled) {
        setLocalConflictCheck(null);
        setLocalConflictLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [pr?.number, pr?.base?.ref, pr?.head?.ref, slug, dispatch, refreshKey]);

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
      // Delay detail refetch — GitHub API may not propagate merge instantly
      setTimeout(() => {
        dispatch(fetchPRDetail({ owner, repo, prNumber: pr.number, slug }));
      }, 2000);
    } else {
      toast.error(result.payload?.error || 'Merge failed. Check if all requirements are satisfied.');
    }
  };

  if (!pr || pr.merged) return null;
  if (pr.state === 'closed') return null;

  // Use local merge-tree check if available, fall back to GitHub's lazy
  // mergeable field.  Trust the local check ONLY if the fetch succeeded
  // (fetchFailed === false).  When the fetch failed the local result may
  // be based on stale refs, so we fall through to GitHub's API field.
  const localCheckSucceeded = localConflictCheck != null && !localConflictCheck.fetchFailed && !localConflictCheck.error;
  const localCheckFailed = !localConflictLoading && !localCheckSucceeded;

  let hasConflicts;
  if (localCheckSucceeded) {
    // Local check ran against fresh remote refs — trust it
    hasConflicts = localConflictCheck.hasConflicts;
  } else if (localCheckFailed) {
    // Local check either errored, wasn't attempted, or ran against stale
    // refs.  Fall back to GitHub's mergeable field.  Treat null/unknown as
    // possibly conflicting so we don't let a stale `true` through.
    hasConflicts = pr.mergeable !== true || pr.mergeable_state === 'dirty';
  } else {
    // Still loading
    hasConflicts = false; // guarded by isChecking below
  }

  const isChecking = localConflictLoading
    || (!localCheckSucceeded && (pr.mergeable == null || pr.mergeable_state === 'unknown'));
  const isBlocked = pr.mergeable_state === 'blocked';
  // Only allow merge when we have a definitive "no conflicts" answer
  const canMerge = !hasConflicts && !isChecking && !isBlocked;

  const methodLabels = {
    merge: 'Create a merge commit',
    squash: 'Squash and merge',
    rebase: 'Rebase and merge',
  };

  // Identify conflicted files — prefer local merge-tree results (instant),
  // fall back to GitHub API file objects.
  const conflictedFiles = localConflictCheck?.conflictedFiles?.length > 0
    ? localConflictCheck.conflictedFiles.map(f => ({ filename: f }))
    : (files || []).filter(f => f.status === 'conflicted' || f.conflicts);

  return (
    <div className="space-y-2">
      {/* ── Merge Conflicts Warning ────────── */}
      {hasConflicts && (
        <div className="vt-workflow-alert p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <AlertCircle className="w-4 h-4 text-[var(--accent-warning)]" strokeWidth={2} />
            <span className="text-xs font-semibold text-[var(--accent-warning)]">Merge Conflicts</span>
          </div>
          <p className="mb-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            This branch has conflicts that must be resolved before merging.
            {conflictedFiles.length > 0 ? ` ${conflictedFiles.length} conflicted file${conflictedFiles.length !== 1 ? 's' : ''}:` : ''}
          </p>
          {conflictedFiles.length > 0 && (
            <ul className="space-y-0.5 mb-2">
              {conflictedFiles.map((f, i) => (
                <li
                  key={i}
                  className="vt-command-item flex cursor-pointer items-center gap-1.5 px-2 py-1 text-[11px]"
                  onClick={() => onFileClick?.(f.filename)}
                >
                  <AlertCircle className="w-3 h-3 flex-shrink-0 text-[var(--accent-warning)]" strokeWidth={2} />
                  <span className="truncate text-[var(--text-primary)]">{f.filename}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={async () => {
                try {
                  toast.info('Setting up conflict resolution…');
                  // 1. Fetch latest remote refs so the local repo knows
                  //    about the PR head branch (prevents pathspec errors).
                  await dispatch(fetchRemote(slug));
                  // 2. Checkout the PR head branch
                  await dispatch(checkoutBranch({ slug, branch: pr.head?.ref }));
                  // 3. Merge the remote-tracking base branch to surface conflicts locally.
                  //    Always reference origin/<branch> to avoid pathspec errors.
                  const mergeResult = await dispatch(mergeBranchForConflicts({ slug, branch: `origin/${pr.base?.ref}` })).unwrap();
                  // 4. Refresh git status so the Source Control panel shows conflicts
                  dispatch(fetchGitStatus(slug));
                  // 5. Switch sidebar to Source Control
                  window.dispatchEvent(new CustomEvent('synthi:switch-sidebar', { detail: 'scm' }));
                  if (mergeResult?.hasConflicts) {
                    toast.info('Resolve the merge conflicts in the Source Control panel, then commit and push.');
                  } else {
                    toast.success('Merge completed without conflicts. Push when ready.');
                  }
                } catch (err) {
                  toast.error(err?.message || 'Failed to set up conflict resolution.');
                }
              }}
              className="th-focus-ring th-btn-active flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-[11px] font-medium"
            >
              <ArrowRightLeft className="w-3 h-3" />
              Resolve in Synthi
            </button>
            <a
              href={pr.html_url ? `${pr.html_url}/conflicts` : '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="th-focus-ring th-btn-ghost flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-2.5 py-1.5 text-[11px] font-medium"
            >
              <ExternalLink className="w-3 h-3" />
              Open in GitHub
            </a>
          </div>
        </div>
      )}

      {/* ── Checking mergeability spinner ──── */}
      {isChecking && (
        <div className="vt-workflow-alert vt-workflow-alert--muted flex items-center gap-2 p-3">
          <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--accent-warning)]" strokeWidth={2} />
          <span className="text-xs text-[var(--text-secondary)]">Checking merge status…</span>
        </div>
      )}

      {/* ── Blocked by branch protection ──── */}
      {isBlocked && !hasConflicts && (
        <div className="vt-workflow-alert vt-workflow-alert--danger p-3">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-[var(--accent-danger)]" strokeWidth={2} />
            <span className="text-xs font-semibold text-[var(--accent-danger)]">Merge blocked</span>
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
            Branch protection rules prevent merging. Required status checks or reviews may be missing.
          </p>
        </div>
      )}

      {/* ── Merge controls ────────────────── */}
      <div className={`vt-workflow-alert p-3 ${canMerge ? 'vt-workflow-alert--success' : 'vt-workflow-alert--muted'}`}>
        <div className="flex items-center gap-2 mb-2">
          <GitMerge
            className="w-4 h-4"
            style={{ color: canMerge ? 'var(--accent-success)' : 'var(--text-muted)' }}
            strokeWidth={2}
          />
          <span
            className="text-xs font-semibold"
            style={{ color: canMerge ? 'var(--accent-success)' : 'var(--text-muted)' }}
          >
            {isChecking ? 'Checking mergeability…' : hasConflicts ? 'Resolve conflicts to merge' : canMerge ? 'Ready to merge' : 'Cannot merge'}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleMerge}
            disabled={mergePRLoading || !canMerge}
            className={`th-focus-ring flex-1 rounded-[var(--radius-control)] py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${canMerge ? 'th-btn-primary' : 'th-btn-ghost border border-[var(--border-subtle)]'}`}
          >
            {mergePRLoading ? 'Merging…' : isChecking ? 'Checking…' : methodLabels[method]}
          </button>
          <button
            onClick={() => setShowOptions(v => !v)}
            className="vt-icon-button th-focus-ring h-8 min-w-8 text-[var(--accent-success)]"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        {showOptions && (
          <div className="vt-command-popover mt-2 overflow-hidden p-1">
            {['merge', 'squash', 'rebase'].map(m => (
              <button
                key={m}
                onClick={() => { setMethod(m); setShowOptions(false); }}
                className={`vt-command-item flex w-full items-center gap-2 px-3 py-2 text-left text-xs ${m === method ? 'th-btn-active' : ''}`}
              >
                {m === method && <CheckCircle2 className="w-3 h-3 flex-shrink-0 text-[var(--accent-success)]" strokeWidth={2} />}
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
              className="th-input w-full rounded-[var(--radius-control)] border px-2 py-1.5 text-xs outline-none"
            />
            <textarea
              value={commitMsg}
              onChange={e => setCommitMsg(e.target.value)}
              placeholder="Optional commit message…"
              rows={2}
              className="th-input w-full resize-none rounded-[var(--radius-control)] border px-2 py-1.5 text-xs outline-none"
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
  const [refreshKey, setRefreshKey] = useState(0);
  const { confirm, confirmDialog } = useConfirmDialog();

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
    // Also re-check merge conflicts so the MergePanel picks up any changes
    setRefreshKey(k => k + 1);
  };

  const handleTitleSave = async () => {
    if (!newTitle.trim() || newTitle.trim() === pr.title) {
      setEditingTitle(false);
      return;
    }
    const result = await dispatch(updatePR({ owner, repo, prNumber: pr.number, slug, updates: { title: newTitle.trim() } }));
    // Silent on success — the title in the header updates inline so the
    // user can see it took. We only toast on failure.
    if (!updatePR.fulfilled.match(result)) {
      toast.error(result.payload?.error || 'Could not update title');
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
    // Silent on success — the new comment appears in the list. Toast
    // only on failure since the optimistic UI doesn't roll back.
    if (!postComment.fulfilled.match(result)) {
      toast.error(result.payload?.error || 'Comment failed');
    }
  };

  const handleDeleteComment = async (commentId) => {
    const allowed = await confirm({
      title: 'Delete comment?',
      message: 'This removes the comment from the pull request conversation.',
      confirmLabel: 'Delete comment',
      tone: 'danger',
    });
    if (!allowed) return;
    const result = await dispatch(deleteComment({ owner, repo, commentId, slug }));
    // Silent on success — the comment disappears from the list. Toast
    // only on failure.
    if (!deleteComment.fulfilled.match(result)) {
      toast.error(result.payload?.error || 'Could not delete comment');
    }
  };

  if (!pr && !prDetailLoading) return null;

  const stateBadgeStyle = prStateBg(pr);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="vt-panel-header flex-shrink-0 flex-col items-stretch px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={onBack}
            className="vt-icon-button th-focus-ring h-7 min-w-7 flex-shrink-0"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {pr ? (
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className="vt-state-pill flex-shrink-0"
                style={stateBadgeStyle}
              >
                {prStateIcon(pr)}
                {prStateLabel(pr)}
              </span>
              <span className="font-mono text-[10px] flex-shrink-0 text-[var(--text-muted)]">#{pr.number}</span>
              <span className="truncate text-xs font-medium text-[var(--text-primary)]">{pr.title}</span>
            </div>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">Loading...</span>
          )}

          <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
            <button
              onClick={handleRefresh}
              disabled={prDetailLoading}
              className="vt-icon-button th-focus-ring h-7 min-w-7 disabled:opacity-30"
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${prDetailLoading ? 'animate-spin' : ''}`} />
            </button>
            {pr && (
              <a
                href={pr.html_url}
                target="_blank"
                rel="noopener noreferrer"
                className="vt-icon-button th-focus-ring h-7 min-w-7"
                title="Open on GitHub"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Tab bar */}
        {pr && (
          <div className="-mx-1 mt-2 flex flex-nowrap gap-1 overflow-x-auto whitespace-nowrap scrollbar-none">
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
          <div className="flex h-24 items-center justify-center text-xs text-[var(--text-muted)]">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading...
          </div>
        )}

        {prDetailError && (
          <div className="vt-workflow-alert vt-workflow-alert--danger mx-3 mt-3 p-3 text-xs text-[var(--accent-danger)]">
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
            <MergePanel slug={slug} owner={owner} repo={repo} pr={pr} files={prFiles} refreshKey={refreshKey} />
            <ReviewPanel slug={slug} owner={owner} repo={repo} prNumber={pr.number} />
          </div>
        )}
        {pr && tab === 'checks' && <ChecksTab checks={prChecks} />}
      </div>
      {confirmDialog}
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
    // Silent on success — the rendered description swaps in inline.
    if (!updatePR.fulfilled.match(result)) {
      toast.error(result.payload?.error || 'Could not update description');
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
              className="th-input flex-1 rounded-[var(--radius-control)] border px-2 py-1 text-sm outline-none"
            />
            <button onClick={onTitleSave} className="th-focus-ring th-btn-primary px-2 py-1 text-xs">Save</button>
            <button onClick={onTitleCancel} className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-2 py-1 text-xs">Cancel</button>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <h3 className="flex-1 text-sm font-semibold leading-snug text-[var(--text-primary)]">{pr.title}</h3>
            <button onClick={onEditTitle} className="vt-icon-button th-focus-ring h-7 min-w-7 flex-shrink-0" title="Edit title">
              <Edit3 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Meta */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--text-muted)]">
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
            <code className="font-mono">{pr.head?.ref}</code>
            <ArrowRight className="w-3 h-3 text-[var(--text-muted)]" />
            <code className="font-mono">{pr.base?.ref}</code>
          </span>
          <span>{pr.commits} commit{pr.commits !== 1 ? 's' : ''}</span>
          <span style={{ color: 'var(--accent-success)' }}>+{pr.additions}</span>
          <span style={{ color: 'var(--accent-danger)' }}>-{pr.deletions}</span>
        </div>
      </div>

      {/* Labels — editable */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="vt-panel-kicker">LABELS</p>
          <button
            onClick={() => setShowLabelPicker(v => !v)}
            className={`th-focus-ring rounded-[var(--radius-control)] px-1.5 py-0.5 text-[10px] transition ${showLabelPicker ? 'th-btn-active' : 'th-btn-ghost'}`}
          >
            {showLabelPicker ? 'Done' : '+ Edit'}
          </button>
        </div>
        {pr.labels?.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-1.5">
            {pr.labels.map(label => (
              <span
                key={label.id}
                className="vt-workflow-chip"
                style={{ '--chip-color': `#${label.color}` }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: `#${label.color}` }} />
                {label.name}
              </span>
            ))}
          </div>
        )}
        {!pr.labels?.length && !showLabelPicker && (
          <p className="text-[10px] italic text-[var(--text-muted)]">No labels</p>
        )}
        {showLabelPicker && (
          <div className="vt-command-popover mt-1 max-h-40 overflow-y-auto p-1">
            {repoLabels.map(label => {
              const isSelected = pr.labels?.find(l => l.name === label.name);
              return (
                <button
                  key={label.id}
                  onClick={() => handleToggleLabel(label)}
                  className={`vt-command-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${isSelected ? 'th-btn-active' : ''}`}
                >
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: `#${label.color}` }} />
                  {label.name}
                  {isSelected && <CheckCircle2 className="ml-auto h-3 w-3 text-[var(--attention-purple)]" />}
                </button>
              );
            })}
            {repoLabels.length === 0 && (
              <p className="px-2.5 py-2 text-[10px] italic text-[var(--text-muted)]">No labels in repository</p>
            )}
          </div>
        )}
      </div>

      {/* Description — editable */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="vt-panel-kicker">DESCRIPTION</p>
          {!editingBody && (
            <button
              onClick={() => { setNewBody(pr.body || ''); setEditingBody(true); }}
              className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] px-1.5 py-0.5 text-[10px] transition"
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
              <button onClick={handleBodySave} className="th-focus-ring th-btn-primary px-3 py-1.5 text-xs font-medium">Save</button>
              <button onClick={() => setEditingBody(false)} className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-3 py-1.5 text-xs">Cancel</button>
            </div>
          </div>
        ) : (
          <div className="vt-workflow-card p-3">
            {pr.body ? (
              <MarkdownText text={pr.body} />
            ) : (
              <p className="text-xs italic text-[var(--text-muted)]">No description provided</p>
            )}
          </div>
        )}
      </div>

      {/* Assignees — editable */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <p className="vt-panel-kicker">ASSIGNEES</p>
          <button
            onClick={() => setShowAssigneePicker(v => !v)}
            className={`th-focus-ring rounded-[var(--radius-control)] px-1.5 py-0.5 text-[10px] transition ${showAssigneePicker ? 'th-btn-active' : 'th-btn-ghost'}`}
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
          <p className="text-[10px] italic text-[var(--text-muted)]">No assignees</p>
        )}
        {showAssigneePicker && (
          <div className="vt-command-popover mt-1 max-h-40 overflow-y-auto p-1">
            {repoCollaborators.map(user => {
              const isSelected = pr.assignees?.find(a => a.login === user.login);
              return (
                <button
                  key={user.id}
                  onClick={() => handleToggleAssignee(user)}
                  className={`vt-command-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${isSelected ? 'th-btn-active' : ''}`}
                >
                  <img src={user.avatar_url} alt={user.login} className="w-4 h-4 rounded-full flex-shrink-0" />
                  {user.login}
                  {isSelected && <CheckCircle2 className="ml-auto h-3 w-3 text-[var(--attention-purple)]" />}
                </button>
              );
            })}
            {repoCollaborators.length === 0 && (
              <p className="px-2.5 py-2 text-[10px] italic text-[var(--text-muted)]">No collaborators found</p>
            )}
          </div>
        )}
      </div>

      {/* Reviews summary */}
      {reviews?.length > 0 && (
        <div>
          <p className="vt-panel-kicker mb-1.5">REVIEWS</p>
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
          className="th-focus-ring th-btn-ghost w-full rounded-[var(--radius-control)] border py-2 text-xs font-medium transition disabled:opacity-50"
          style={{
            borderColor: pr.state === 'closed'
              ? 'color-mix(in srgb, var(--accent-success) 32%, transparent)'
              : 'color-mix(in srgb, var(--accent-danger) 32%, transparent)',
            color: pr.state === 'closed' ? 'var(--accent-success)' : 'var(--accent-danger)',
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
    ? <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-success)' }} />
    : review.state === 'CHANGES_REQUESTED'
    ? <XCircle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-danger)' }} />
    : <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-secondary)' }} />;

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
    <div className="border-t border-[var(--border-subtle)] first:border-t-0">
      {/* Hunk header */}
      <div className="vt-code-line-hunk flex select-none items-center gap-2 px-3 py-1 font-mono text-[10px]">
        <span>{hunk.header}</span>
        {hunk.context && <span className="opacity-60 truncate">{hunk.context}</span>}
      </div>
      {/* Lines */}
      <div className="font-mono text-[11px] leading-[1.6]">
        {hunk.lines.map((line, i) => {
          const lineClass = line.type === 'add'
            ? 'vt-code-line-add' : line.type === 'del'
            ? 'vt-code-line-del' : 'text-[var(--text-secondary)]';
          const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          return (
            <div key={i} className={`flex hover:brightness-110 ${lineClass}`}>
              <span className="select-none text-right pr-1 min-w-[3em] opacity-30"
                style={{ color: 'var(--text-muted)' }}>
                {line.oldLine ?? ''}
              </span>
              <span className="select-none text-right pr-2 min-w-[3em] opacity-30 border-r mr-2"
                style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                {line.newLine ?? ''}
              </span>
              <span className="select-none w-4 text-center flex-shrink-0">{prefix}</span>
              <span className="flex-1 whitespace-pre-wrap break-all">{line.content}</span>
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
        <p className="vt-panel-kicker">
          {files.length} file{files.length !== 1 ? 's' : ''} changed
          {pr && <span className="ml-2" style={{ color: 'var(--accent-success)' }}>+{pr.additions}</span>}
          {pr && <span className="ml-1" style={{ color: 'var(--accent-danger)' }}>-{pr.deletions}</span>}
        </p>
        <div className="flex gap-0.5">
          <button onClick={() => setDiffViewMode('unified')} title="Unified diff"
            className={`th-focus-ring rounded-[var(--radius-control)] px-1.5 py-0.5 text-[10px] transition ${diffViewMode === 'unified' ? 'th-btn-active' : 'th-btn-ghost'}`}>Unified</button>
          <button onClick={() => setDiffViewMode('raw')} title="Raw patch"
            className={`th-focus-ring rounded-[var(--radius-control)] px-1.5 py-0.5 text-[10px] transition ${diffViewMode === 'raw' ? 'th-btn-active' : 'th-btn-ghost'}`}>Raw</button>
        </div>
      </div>
      {files.map(file => {
        const hunks = expandedFiles[file.filename] && file.patch ? parsePatchHunks(file.patch) : [];
        return (
          <div key={file.sha || file.filename}
            className="vt-workflow-card overflow-hidden">
            <button
              onClick={() => setExpandedFiles(prev => ({ ...prev, [file.filename]: !prev[file.filename] }))}
              className="vt-workflow-row flex w-full items-center gap-2 px-2.5 py-2 text-left text-[var(--text-primary)]">
              <span className="w-3.5 text-center font-mono text-[10px] font-bold" style={{ color: fileDiffColor(file.status) }}>
                {fileDiffLabel(file.status)}
              </span>
              <span className="text-xs font-mono flex-1 truncate">{file.filename}</span>
              {file.previous_filename && (
                <span className="text-[10px] opacity-50 truncate">(was {file.previous_filename})</span>
              )}
              <span className="text-[10px] flex-shrink-0" style={{ color: 'var(--accent-success)' }}>+{file.additions}</span>
              <span className="text-[10px] flex-shrink-0 ml-1" style={{ color: 'var(--accent-danger)' }}>-{file.deletions}</span>
              <ChevronDown
                className="w-3 h-3 flex-shrink-0 ml-1 transition-transform"
                style={{ transform: expandedFiles[file.filename] ? 'rotate(180deg)' : 'none', color: 'var(--text-muted)' }}
              />
            </button>
            {expandedFiles[file.filename] && file.patch && (
              diffViewMode === 'unified' && hunks.length > 0 ? (
                <div className="vt-code-surface" style={{ maxHeight: 400, overflowY: 'auto' }}>
                  {hunks.map((hunk, i) => <DiffHunkView key={i} hunk={hunk} />)}
                </div>
              ) : (
                <pre
                  className="vt-code-surface overflow-x-auto px-3 py-2 text-[10px] leading-relaxed"
                  style={{ maxHeight: '300px', overflowY: 'auto' }}>
                  {file.patch.split('\n').map((line, i) => (
                    <div key={i}
                      className={line.startsWith('+') ? 'vt-code-line-add' : line.startsWith('-') ? 'vt-code-line-del' : line.startsWith('@@') ? 'vt-code-line-hunk' : ''}>{line}</div>
                  ))}
                </pre>
              )
            )}
          </div>
        );
      })}
      {files.length === 0 && (
        <p className="vt-empty-state py-4 text-center text-xs">No files changed.</p>
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
          className="vt-workflow-card flex items-start gap-2 px-2.5 py-2"
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
        <p className="vt-empty-state py-4 text-center text-xs">No commits.</p>
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
        <p className="vt-empty-state py-4 text-center text-xs">No comments yet.</p>
      )}
      {/* New comment box */}
      <div className="border-t border-[var(--border-subtle)] pt-2">
        <CommentBox onSubmit={onComment} loading={commentLoading} />
      </div>
    </div>
  );
}

function CommentCard({ comment, onDelete }) {
  const [showDelete, setShowDelete] = useState(false);
  return (
    <div
      className="vt-workflow-card overflow-hidden"
      onMouseEnter={() => setShowDelete(true)}
      onMouseLeave={() => setShowDelete(false)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel-subtle)] px-2.5 py-1.5">
        <img src={comment.user?.avatar_url} alt={comment.user?.login} className="w-4 h-4 rounded-full" />
        <a href={comment.user?.html_url} target="_blank" rel="noopener noreferrer"
          className="text-xs font-medium hover:underline" style={{ color: 'var(--text-primary)' }}>
          {comment.user?.login}
        </a>
        <span className="text-[10px] ml-auto" style={{ color: 'var(--text-muted)' }}>{relativeTime(comment.created_at)}</span>
        {showDelete && (
          <button onClick={() => onDelete(comment.id)} className="vt-icon-button th-focus-ring h-6 min-w-6">
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {/* Body */}
      <div className="bg-[var(--bg-app)] px-2.5 py-2">
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
          className="vt-workflow-card flex items-center gap-2.5 px-2.5 py-2"
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
              className="vt-icon-button th-focus-ring h-7 min-w-7">
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      ))}
      {checks.length === 0 && (
        <p className="vt-empty-state py-4 text-center text-xs">No checks.</p>
      )}
    </div>
  );
}
