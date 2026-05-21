'use client';

/**
 * SourceControlPanel — the top-level container that replaces the
 * body of the legacy GitStatus.jsx.
 *
 * Responsibilities:
 *   • Owns the local UI state (commit message, body, amend, sub-view
 *     selection, ripplingPaths Set for cross-section animations,
 *     isSyncing flag, error dismissal, clone-form visibility).
 *   • Reads from `state.git` and `state.pr` via redux selectors.
 *   • Dispatches every git thunk the user can trigger from the
 *     panel — stage, unstage, commit, push, pull, fetch, discard,
 *     stash, init, clone, conflict-resolve, etc.
 *   • Honors the same data-refresh lifecycle as the legacy panel
 *     (window-focus listener; SSE-driven status invalidation
 *     remains owned by the page-level subscriber).
 *   • Preserves the global keyboard shortcuts via the
 *     `data-git-panel` attribute on the root.
 *   • Composes the visual children from this directory.
 *
 * This file deliberately mirrors the dispatch semantics of the
 * legacy GitStatus.jsx so behavior is byte-for-byte preserved.
 * Only the rendering layer is new.
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import {
  fetchGitStatus, fetchRemote, commitChanges, pushChanges, pullChanges,
  stageFile, unstageFile, discardChange, initRepo, cloneRepo,
  fetchRemotes, fetchCommitHistory, fetchUnpushedCommits,
  fetchIncomingCommits, fetchStashList, stashPush, stashPop, stashApply,
  stashDrop, clearError, stageAll, unstageAll, discardAll,
  resolveConflictOurs, resolveConflictTheirs, markResolved, abortMerge,
  openConflictResolver,
} from '@/redux/gitSlice';
import { fetchGithubInfo, fetchPRList } from '@/redux/prSlice';
import {
  refreshWorkspaceThunk, openDiffThunk, fetchFilesThunk, selectFileThunk,
} from '@/redux/workspaceSlice';
import { selectGitLoading } from '@/redux/isolatedSelectors';
import { getStoredToken } from '@/services/prClient';
import { extractTokenFromUrl, stripTokenFromUrl } from '../gitUtils';
import { GitHubTokenModal } from '../GitHubTokenModal';
import CommitHistoryPanel from '../CommitHistoryPanel';
import {
  openTab, activateTabAction, setFocusedTabGroup,
  selectNodes, selectTabs,
} from '@/components/docking-wm/state/layout-slice';
import { IDE_PANEL } from '@/components/docking-wm/panels/panel-types';
import { getFileLanguage } from '@/utils/fileUtils';

import './scm-tokens.css';
import { BranchBridge } from './BranchBridge';
import { FocalCard } from './FocalCard';
import { FileSections } from './FileSections';
import { SubViewPills } from './SubViewPills';
import { StashList } from './StashList';
import { OverflowMenu } from './OverflowMenu';
import { CommitComposer } from './CommitComposer';
import { useFocalCardState } from './useFocalCardState';
import { MoreHorizontal } from 'lucide-react';

// How long to keep a file row marked with the heal-line-sweep ripple
// after it crosses sections (stage <-> unstage).  Matches the CSS
// animation duration (2400ms) plus a tiny buffer.
const RIPPLE_MS = 2600;

// Length of the push-success sweep on the bridge hairline.
const PUSH_SUCCESS_MS = 720;

export function SourceControlPanel({ slug }) {
  const dispatch = useDispatch();
  const { update: refreshSession } = useSession();

  // ── Redux reads ────────────────────────────────────────────────
  const loading = useSelector(selectGitLoading);
  const {
    status, error, actionError, actionErrorCode,
    stashList, commitHistory,
  } = useSelector((s) => s.git);
  const unpushedCommits = useSelector((s) => s.git.unpushedCommits);

  // ── Local UI state ─────────────────────────────────────────────
  const [message, setMessage] = useState('');
  const [commitBody, setCommitBody] = useState('');
  const [showCommitBody, setShowCommitBody] = useState(false);
  const [amendMode, setAmendMode] = useState(false);
  const [activeSubView, setActiveSubView] = useState('files');
  const [isSyncing, setIsSyncing] = useState(false);
  const [pushSuccess, setPushSuccess] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [showCloneForm, setShowCloneForm] = useState(false);
  const [cloneUrl, setCloneUrl] = useState('');
  const [ripplingPaths, setRipplingPaths] = useState(() => new Set());
  // Track which file is currently open in the editor pane so the row
  // can render its active-selection state.
  const activeFilePath = useSelector((s) => s.workspace.activeFile?.path) || null;

  // ── Embedded-PAT persistence (preserved from legacy panel) ─────
  // When the user pastes a URL containing a PAT, save it as their
  // per-user token instead of letting it stay in the remote URL.
  const persistEmbeddedToken = useCallback(async (token) => {
    if (!token) return;
    try {
      const res = await fetch('/api/user/github-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        try { await refreshSession(); } catch (_) { /* non-fatal */ }
      }
    } catch (_) { /* network failure is non-fatal */ }
  }, [refreshSession]);

  // ── Data refresh lifecycle (mirrors legacy panel) ──────────────
  const refreshGitData = useCallback(async () => {
    if (!slug) return;
    try { await dispatch(fetchRemote(slug)); } catch (_) { /* offline OK */ }
    dispatch(fetchGitStatus(slug));
    dispatch(fetchRemotes(slug));
    dispatch(fetchCommitHistory({ slug }));
    dispatch(fetchUnpushedCommits({ slug, max: 50 }));
    dispatch(fetchIncomingCommits({ slug, max: 50 }));
    dispatch(fetchStashList(slug));

    const storedToken = getStoredToken(slug);
    const infoResult = await dispatch(fetchGithubInfo(slug));
    if (fetchGithubInfo.fulfilled.match(infoResult)) {
      const info = infoResult.payload;
      if (info?.owner && info.repo && storedToken) {
        dispatch(fetchPRList({ owner: info.owner, repo: info.repo, slug }));
      }
    }
  }, [slug, dispatch]);

  useEffect(() => {
    if (!slug) return;
    refreshGitData();
    const handleFocus = () => refreshGitData();
    window.addEventListener('focus', handleFocus);
    return () => { window.removeEventListener('focus', handleFocus); };
  }, [slug, refreshGitData]);

  // ── Dock helpers (open PR panel / commit-history panel) ────────
  const dockNodes = useSelector(selectNodes);
  const dockTabs = useSelector(selectTabs);
  const openPRPanel = useCallback(() => {
    const panelType = IDE_PANEL.PULL_REQUESTS;
    for (const [nodeId, node] of Object.entries(dockNodes)) {
      if (node.type !== 'tabgroup') continue;
      for (const tId of node.tabs || []) {
        const t = dockTabs[tId];
        if (t && t.panelType === panelType) {
          dispatch(setFocusedTabGroup(nodeId));
          dispatch(activateTabAction({ tabId: tId }));
          return;
        }
      }
    }
    const SIDEBAR_PANELS = new Set(['explorer', 'search', 'git', 'extensions', 'extension-view', 'chat', 'pullrequests', 'settings']);
    const groups = Object.entries(dockNodes).filter(([, n]) => n.type === 'tabgroup');
    let targetGroupId = null;
    for (const [groupId, group] of groups) {
      for (const tId of group.tabs || []) {
        const t = dockTabs[tId];
        if (t && SIDEBAR_PANELS.has(t.panelType)) { targetGroupId = groupId; break; }
      }
      if (targetGroupId) break;
    }
    if (!targetGroupId && groups.length > 0) targetGroupId = groups[0][0];
    if (targetGroupId) {
      dispatch(openTab({ panelType, title: 'Pull Requests', targetTabGroupId: targetGroupId }));
      dispatch(setFocusedTabGroup(targetGroupId));
    }
  }, [dispatch, dockNodes, dockTabs]);

  const openCommitHistoryDock = useCallback(() => {
    const panelType = IDE_PANEL.COMMIT_HISTORY;
    for (const [nodeId, node] of Object.entries(dockNodes)) {
      if (node.type !== 'tabgroup') continue;
      for (const tId of node.tabs || []) {
        const t = dockTabs[tId];
        if (t && t.panelType === panelType) {
          dispatch(setFocusedTabGroup(nodeId));
          dispatch(activateTabAction({ tabId: tId }));
          return;
        }
      }
    }
    const BOTTOM_PANELS = new Set(['terminal', 'problems', 'output']);
    const groups = Object.entries(dockNodes).filter(([, n]) => n.type === 'tabgroup');
    let targetGroupId = null;
    for (const [groupId, group] of groups) {
      for (const tId of group.tabs || []) {
        const t = dockTabs[tId];
        if (t && BOTTOM_PANELS.has(t.panelType)) { targetGroupId = groupId; break; }
      }
      if (targetGroupId) break;
    }
    if (!targetGroupId && groups.length > 0) targetGroupId = groups[0][0];
    if (targetGroupId) {
      dispatch(openTab({ panelType, title: 'Commit History', targetTabGroupId: targetGroupId }));
      dispatch(setFocusedTabGroup(targetGroupId));
    }
  }, [dispatch, dockNodes, dockTabs]);

  // ── Action handlers (dispatch + toast — verbatim from legacy) ──
  const markRippling = useCallback((path) => {
    setRipplingPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    window.setTimeout(() => {
      setRipplingPaths((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }, RIPPLE_MS);
  }, []);

  const handleFetch = useCallback(async () => {
    if (!slug) return;
    setIsSyncing(true);
    try {
      const result = await dispatch(fetchRemote(slug));
      dispatch(fetchRemotes(slug));
      dispatch(fetchCommitHistory({ slug }));
      dispatch(fetchUnpushedCommits({ slug, max: 50 }));
      dispatch(fetchIncomingCommits({ slug, max: 50 }));
      if (fetchRemote.fulfilled.match(result)) toast.success('Fetched latest from remote');
    } finally {
      setIsSyncing(false);
    }
  }, [dispatch, slug]);

  const handlePull = useCallback(async () => {
    if (!slug) return;
    setIsSyncing(true);
    try {
      const result = await dispatch(pullChanges(slug));
      if (pullChanges.fulfilled.match(result)) {
        dispatch(refreshWorkspaceThunk());
        toast.success('Pulled latest changes');
      } else if (pullChanges.rejected.match(result)) {
        if (result.payload?.code === 'MERGE_CONFLICT') {
          const count = result.payload.conflicted?.length || 0;
          toast.error(`Merge conflict — ${count} file${count !== 1 ? 's' : ''} need resolution`, { duration: 6000 });
        } else if (result.payload?.code === 'UNCOMMITTED_CHANGES') {
          toast.error('Uncommitted changes would be overwritten. Commit or stash first.', { duration: 5000 });
        } else {
          toast.error(result.payload?.message || result.error?.message || 'Pull failed');
        }
      }
    } finally {
      setIsSyncing(false);
    }
  }, [dispatch, slug]);

  const handlePush = useCallback(async (force = false) => {
    if (!slug) return;
    if (force && !window.confirm('Force push will overwrite remote history. This uses --force-with-lease for safety. Continue?')) return;
    const result = await dispatch(pushChanges(force ? { slug, force: true } : slug));
    if (pushChanges.fulfilled.match(result)) {
      toast.success(force ? 'Force pushed to remote' : 'Pushed to remote');
      setPushSuccess(true);
      window.setTimeout(() => setPushSuccess(false), PUSH_SUCCESS_MS);
    } else if (pushChanges.rejected.match(result)) {
      const errMsg = result.payload?.message || result.error?.message || 'Push failed';
      if (!force && /non-fast-forward|rejected|fetch first|cannot lock ref/i.test(errMsg)) {
        toast.error('Push rejected — remote has changes. Try Force Push (uses --force-with-lease).', { duration: 6000 });
      } else {
        toast.error(errMsg);
      }
    }
  }, [dispatch, slug]);

  const handleSync = useCallback(async () => {
    // "Sync" = pull then push.  Used by the diverged focal-card path.
    await handlePull();
    await handlePush(false);
  }, [handlePull, handlePush]);

  const handleCommit = useCallback(async () => {
    if (!slug || !message) return;
    const fullMessage = commitBody ? `${message}\n\n${commitBody}` : message;
    const prevMessage = message;
    const prevBody = commitBody;
    setMessage('');
    setCommitBody('');
    setShowCommitBody(false);
    setAmendMode(false);
    const result = await dispatch(commitChanges({ slug, message: fullMessage, amend: amendMode }));
    if (commitChanges.fulfilled.match(result)) {
      toast.success(amendMode ? 'Amended commit' : `Committed: ${prevMessage}`);
    } else {
      setMessage(prevMessage);
      setCommitBody(prevBody);
      if (prevBody) setShowCommitBody(true);
      toast.error(result?.error?.message || 'Commit failed');
    }
  }, [slug, message, commitBody, amendMode, dispatch]);

  const handleCommitAndPush = useCallback(async () => {
    if (!slug || !message) return;
    const fullMessage = commitBody ? `${message}\n\n${commitBody}` : message;
    const prevMessage = message;
    const prevBody = commitBody;
    setMessage('');
    setCommitBody('');
    setShowCommitBody(false);
    setAmendMode(false);
    const commitResult = await dispatch(commitChanges({ slug, message: fullMessage, amend: amendMode }));
    if (commitChanges.fulfilled.match(commitResult)) {
      toast.success(amendMode ? 'Amended commit' : `Committed: ${prevMessage}`);
      const pushResult = await dispatch(pushChanges(slug));
      if (pushChanges.fulfilled.match(pushResult)) {
        toast.success('Pushed to remote');
        setPushSuccess(true);
        window.setTimeout(() => setPushSuccess(false), PUSH_SUCCESS_MS);
      } else {
        toast.error(pushResult?.error?.message || 'Push failed after commit');
      }
    } else {
      setMessage(prevMessage);
      setCommitBody(prevBody);
      if (prevBody) setShowCommitBody(true);
      toast.error(commitResult?.error?.message || 'Commit failed');
    }
  }, [slug, message, commitBody, amendMode, dispatch]);

  const handleStage = useCallback(async (file) => {
    markRippling(file.path);
    const result = await dispatch(stageFile({ slug, filePath: file.path }));
    if (stageFile.rejected.match(result)) toast.error(result.error?.message || 'Failed to stage file');
  }, [dispatch, slug, markRippling]);

  const handleUnstage = useCallback(async (file) => {
    markRippling(file.path);
    const result = await dispatch(unstageFile({ slug, filePath: file.path }));
    if (unstageFile.rejected.match(result)) toast.error(result.error?.message || 'Failed to unstage file');
  }, [dispatch, slug, markRippling]);

  const handleStageAll = useCallback(async () => {
    const result = await dispatch(stageAll(slug));
    if (stageAll.rejected.match(result)) toast.error(result.error?.message || 'Failed to stage all');
  }, [dispatch, slug]);

  const handleUnstageAll = useCallback(async () => {
    const result = await dispatch(unstageAll(slug));
    if (unstageAll.rejected.match(result)) toast.error(result.error?.message || 'Failed to unstage all');
  }, [dispatch, slug]);

  const handleDiscard = useCallback(async (file) => {
    if (!window.confirm(`Discard changes in ${file.path}?`)) return;
    const result = await dispatch(discardChange({ slug, filePath: file.path }));
    if (discardChange.fulfilled.match(result)) {
      toast.success(`Discarded changes in ${file.path.split('/').pop()}`);
    } else {
      toast.error(`Failed to discard ${file.path.split('/').pop()}`);
    }
  }, [dispatch, slug]);

  const handleDiscardAll = useCallback(async () => {
    if (!window.confirm('Discard ALL changes? This cannot be undone!')) return;
    const result = await dispatch(discardAll(slug));
    if (discardAll.fulfilled.match(result)) toast.success('All changes discarded');
    else toast.error('Failed to discard all changes');
  }, [dispatch, slug]);

  const handleOpenDiff = useCallback((file) => {
    dispatch(openDiffThunk({
      name: file.path.split('/').pop(),
      path: file.path,
      originalPath: file.from || file.path,
      language: getFileLanguage(file.path),
    }));
  }, [dispatch]);

  const handleResolveOurs = useCallback(async (file) => {
    await dispatch(resolveConflictOurs({ slug, filePath: file.path }));
    dispatch(refreshWorkspaceThunk());
  }, [dispatch, slug]);
  const handleResolveTheirs = useCallback(async (file) => {
    await dispatch(resolveConflictTheirs({ slug, filePath: file.path }));
    dispatch(refreshWorkspaceThunk());
  }, [dispatch, slug]);
  const handleMarkResolved = useCallback(async (file) => {
    await dispatch(markResolved({ slug, filePath: file.path }));
  }, [dispatch, slug]);

  const handleResolveConflicts = useCallback(() => {
    const first = (status?.conflictedFiles || [])[0];
    if (!first) return;
    dispatch(selectFileThunk({
      name: first.split('/').pop(),
      path: first,
      language: getFileLanguage(first),
    }));
    dispatch(openConflictResolver(first));
  }, [dispatch, status]);

  const handleAbortMerge = useCallback(async () => {
    if (!window.confirm('Are you sure you want to abort the merge? All merge progress will be lost.')) return;
    await dispatch(abortMerge(slug));
    dispatch(refreshWorkspaceThunk());
  }, [dispatch, slug]);

  const handleInitRepo = useCallback(async () => {
    if (!slug) return;
    try {
      await dispatch(initRepo({ slug, remoteUrl: null }));
      dispatch(fetchFilesThunk(slug));
      dispatch(fetchGitStatus(slug));
    } catch (e) {
      toast.error(e?.message || 'Init failed');
    }
  }, [dispatch, slug]);

  const handleCloneRepo = useCallback(async () => {
    if (!slug || !cloneUrl) return;
    const trimmedUrl = cloneUrl.trim();
    if (!trimmedUrl) return;
    setIsSyncing(true);
    try {
      const embeddedToken = extractTokenFromUrl(trimmedUrl);
      const cleanUrl = embeddedToken ? stripTokenFromUrl(trimmedUrl) : trimmedUrl;
      if (embeddedToken) persistEmbeddedToken(embeddedToken);
      const result = await dispatch(cloneRepo({ slug, repoUrl: cleanUrl, token: embeddedToken || undefined }));
      if (cloneRepo.rejected.match(result)) {
        toast.error(result?.error?.message || 'Clone failed');
        return;
      }
      dispatch(fetchFilesThunk(slug));
      dispatch(fetchGitStatus(slug));
      setCloneUrl('');
      setShowCloneForm(false);
    } catch (e) {
      toast.error(e?.message || 'Clone failed');
    } finally {
      setIsSyncing(false);
    }
  }, [dispatch, slug, cloneUrl, persistEmbeddedToken]);

  const handleStashChanges = useCallback(async () => {
    const result = await dispatch(stashPush({ slug, message: '' }));
    if (stashPush.fulfilled.match(result)) toast.success('Changes stashed');
    dispatch(fetchGitStatus(slug));
  }, [dispatch, slug]);

  const handleStashApply = useCallback(async (index) => {
    const result = await dispatch(stashApply({ slug, index }));
    if (stashApply.fulfilled.match(result)) toast.success('Stash applied');
    else toast.error(result?.error?.message || 'Failed to apply stash');
    dispatch(refreshWorkspaceThunk());
  }, [dispatch, slug]);
  const handleStashPop = useCallback(async (index) => {
    const result = await dispatch(stashPop({ slug, index }));
    if (stashPop.fulfilled.match(result)) toast.success('Stash applied and removed');
    dispatch(refreshWorkspaceThunk());
  }, [dispatch, slug]);
  const handleStashDrop = useCallback(async (index) => {
    if (!window.confirm('Drop this stash?')) return;
    const result = await dispatch(stashDrop({ slug, index }));
    if (stashDrop.fulfilled.match(result)) toast.success('Stash dropped');
  }, [dispatch, slug]);
  const handleStashPushWithMessage = useCallback(async (msg) => {
    const result = await dispatch(stashPush({ slug, message: msg }));
    if (stashPush.fulfilled.match(result)) toast.success('Changes stashed');
    dispatch(fetchGitStatus(slug));
  }, [dispatch, slug]);

  // ── Derived state ──────────────────────────────────────────────
  const focal = useFocalCardState({ isSyncing });
  const hasRepo = status !== null;
  const hasMergeInProgress = !!(status?.conflictedFiles?.length);
  const fileCount = useMemo(() => status?.files?.length || 0, [status]);
  const stagedCount = useMemo(() => (
    (status?.files || []).filter((f) => f.index !== ' ' && f.index !== '?').length
  ), [status]);
  const canAmend = (unpushedCommits?.length || 0) > 0 && !hasMergeInProgress;
  const canCommit = !!message && (stagedCount > 0 || amendMode) && !loading;
  const branch = status?.current || null;

  // The error to display (prefer actionError since it persists).
  // Suppress generic banner for UNCOMMITTED_CHANGES — it has its own
  // dedicated UI inside BranchSelector's CheckoutConflictDialog.
  const displayError = actionErrorCode === 'UNCOMMITTED_CHANGES' ? null : (actionError || error);

  const handleDismissError = useCallback(() => {
    dispatch(clearError());
  }, [dispatch]);

  // ── Panel-level keyboard shortcuts (Ctrl+Shift+P = push) ───────
  // The composer's own onKeyDown already handles Ctrl+Enter and
  // Ctrl+Shift+Enter; this listener catches Push from anywhere
  // inside the panel so muscle-memory keeps working.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (!e.target.closest?.('[data-git-panel]')) return;
      if (e.key === 'p' && (e.ctrlKey || e.metaKey) && e.shiftKey
          && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        handlePush(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handlePush]);

  // The overflow trigger reuses the small action-button glyph
  // pattern so it visually rhymes with the bridge's fetch button.
  const overflowTrigger = (
    <button
      type="button"
      className="scm-row-action th-focus-ring"
      style={{ width: 22, height: 22 }}
      title="More git actions"
      aria-label="More git actions"
    >
      <MoreHorizontal className="w-3 h-3" strokeWidth={2} />
    </button>
  );

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="scm-panel" data-git-panel>
      <div className="scm-bridge-shell" style={{ position: 'relative' }}>
        <BranchBridge
          slug={slug}
          branch={branch}
          ahead={focal.ahead}
          behind={focal.behind}
          isSyncing={isSyncing}
          pushSuccess={pushSuccess}
          onFetch={handleFetch}
          onOpenOverflow={() => { /* OverflowMenu owns its trigger */ }}
        />
        {/* The OverflowMenu's trigger is the actual right-most icon
            in the bridge; we render it absolutely positioned over
            the bridge's placeholder button so the menu anchors
            correctly. */}
        <div style={{ position: 'absolute', top: 7, right: 8 }}>
          <OverflowMenu
            trigger={overflowTrigger}
            hasRepo={hasRepo}
            hasMergeInProgress={hasMergeInProgress}
            ahead={focal.ahead}
            behind={focal.behind}
            isSyncing={isSyncing}
            onFetch={handleFetch}
            onPull={handlePull}
            onPush={() => handlePush(false)}
            onForcePush={() => handlePush(true)}
            onInitRepo={handleInitRepo}
            onCloneRepo={() => setShowCloneForm((v) => !v)}
            onManageRemotes={() => {
              // Defer the full remote-management sheet to Phase 6 sibling restyles.
              // For now this opens the legacy token modal as a stand-in surface
              // that at least carries credential-management semantics.
              setShowTokenModal(true);
            }}
            onStashChanges={handleStashChanges}
            onDiscardAll={handleDiscardAll}
            onAbortMerge={handleAbortMerge}
            onOpenCommitHistory={openCommitHistoryDock}
            onOpenPullRequests={openPRPanel}
            onOpenTokenModal={() => setShowTokenModal(true)}
          />
        </div>
      </div>

      <FocalCard
        focal={focal}
        onPush={() => handlePush(false)}
        onPull={handlePull}
        onSync={handleSync}
        onResolveConflicts={handleResolveConflicts}
        onInitRepo={handleInitRepo}
        onCloneRepo={() => setShowCloneForm(true)}
      />

      {/* Inline clone form — appears when the user picks "Clone…"
          from the overflow menu or from the no-repo focal card.
          The full remote-management UI is deferred to Phase 6. */}
      {showCloneForm && (
        <div
          className="mx-3 mb-2 p-2.5 rounded-lg"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <input
            type="text"
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            className="w-full px-2 py-1 rounded text-xs th-input th-focus-ring"
            style={{ marginBottom: 6 }}
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              className="scm-focal-action scm-focal-action--primary"
              onClick={handleCloneRepo}
              disabled={!cloneUrl.trim() || isSyncing}
            >
              Clone
            </button>
            <button
              type="button"
              className="scm-focal-action"
              onClick={() => { setShowCloneForm(false); setCloneUrl(''); }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Sub-view content — Files (default) / History / Stashes.
          PR list stays in its own activity-bar tab. */}
      {activeSubView === 'files' && (
        <FileSections
          files={status?.files || []}
          conflictedFiles={status?.conflictedFiles || []}
          activeFilePath={activeFilePath}
          ripplingPaths={ripplingPaths}
          onOpenDiff={handleOpenDiff}
          onStage={handleStage}
          onUnstage={handleUnstage}
          onStageAll={handleStageAll}
          onUnstageAll={handleUnstageAll}
          onDiscard={handleDiscard}
          onDiscardAll={handleDiscardAll}
          onResolveOurs={handleResolveOurs}
          onResolveTheirs={handleResolveTheirs}
          onMarkResolved={handleMarkResolved}
        />
      )}
      {activeSubView === 'history' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* The legacy CommitHistoryPanel renders inline here.  It
              gets a coordinated restyle in Phase 6. */}
          <CommitHistoryPanel slug={slug} />
        </div>
      )}
      {activeSubView === 'stashes' && (
        <StashList
          stashes={stashList || []}
          onPush={handleStashPushWithMessage}
          onApply={handleStashApply}
          onPop={handleStashPop}
          onDrop={handleStashDrop}
        />
      )}

      <SubViewPills
        value={activeSubView}
        onChange={setActiveSubView}
        counts={{
          files: fileCount,
          history: commitHistory?.all?.length || 0,
          stashes: (stashList || []).length,
        }}
      />

      <CommitComposer
        message={message}
        onMessageChange={setMessage}
        commitBody={commitBody}
        onCommitBodyChange={setCommitBody}
        showCommitBody={showCommitBody}
        onToggleCommitBody={() => setShowCommitBody((v) => !v)}
        amendMode={amendMode}
        onToggleAmend={() => setAmendMode((v) => !v)}
        canAmend={canAmend}
        canCommit={canCommit}
        ahead={focal.ahead}
        isSubmitting={loading}
        onSubmit={handleCommit}
        onSubmitAndPush={handleCommitAndPush}
        onAIGenerate={() => {
          // Backend route lands in a follow-up.  Until then this
          // is a no-op so the visual surface is complete.
          toast.info('AI commit drafting — coming soon');
        }}
        isAIStreaming={false}
        aiAvailable
        fileCount={fileCount}
        error={displayError}
        errorCode={actionErrorCode}
        onDismissError={handleDismissError}
      />

      {showTokenModal && (
        <GitHubTokenModal onClose={() => setShowTokenModal(false)} />
      )}
    </div>
  );
}

export default SourceControlPanel;
