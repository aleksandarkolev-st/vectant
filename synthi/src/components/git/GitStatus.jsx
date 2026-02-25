import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchGitStatus, fetchRemote, commitChanges, pushChanges, pullChanges,
  stageFile, unstageFile, discardChange, initRepo, cloneRepo,
  addRemote, removeRemote, setRemoteUrl, fetchRemotes, fetchCommitHistory,
  fetchUnpushedCommits, fetchIncomingCommits, fetchStashList,
  stashPush, stashPop, stashDrop, clearError, stageAll, unstageAll,
  discardAll, resolveConflictOurs, resolveConflictTheirs,
  markResolved, abortMerge, openConflictResolver
} from '@/redux/gitSlice';
import { refreshWorkspaceThunk, openDiffThunk, fetchFilesThunk, selectFileThunk } from '@/redux/workspaceSlice';
import {
  RefreshCw, Check, CheckCircle2, UploadCloud, Plus, Minus, DownloadCloud,
  Undo2, Globe, Trash2, Copy, Archive, ArchiveRestore,
  AlertTriangle, GitMerge, X, Edit3, Search, ChevronDown, ChevronRight,
  ExternalLink, ShieldAlert, ArrowUpCircle, ArrowDownCircle, GitPullRequest, Key, Maximize2
} from 'lucide-react';
import { fetchGithubInfo, fetchPRList, setActivePR, setHasToken } from '@/redux/prSlice';
import { getStoredToken } from '@/services/prClient';
import { GitHubTokenModal } from './GitHubTokenModal';
import { toast } from 'sonner';
import { getFileLanguage } from '@/utils/fileUtils';
import {
  maskRemoteUrl, urlContainsToken, detectProvider, humanRemoteUrl,
  commitWebUrl, parseConventionalCommit, ccColor, groupCommitsByDate,
  buildCommitGraph, relativeTime
} from './gitUtils';
import {
  openTab, activateTabAction, setFocusedTabGroup,
  selectNodes, selectTabs,
} from '@/components/docking-wm/state/layout-slice';
import { IDE_PANEL } from '@/components/docking-wm/panels/ide-panels';
import dynamic from 'next/dynamic';

const HunkStagingView = dynamic(() => import('./HunkStagingView'), { ssr: false });

/* ─────────────── tiny sub-components ─────────────── */

/** GitHub / GitLab / Bitbucket / Azure logo SVGs (16×16) */
function ProviderIcon({ provider, className = 'w-3.5 h-3.5' }) {
  if (provider === 'github') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
        0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15
        -.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87
        .51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12
        0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82
        2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65
        3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013
        0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  }
  if (provider === 'gitlab') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="currentColor">
        <path d="M15.97 9.058l-.895-2.756L13.3.842a.37.37 0 00-.702 0L10.82 6.302H5.18L3.402.842a.37.37 0 00-.702 0L.925 6.302.03 9.058a.734.734 0 00.267.82L8 15.227l7.703-5.35a.734.734 0 00.267-.819" />
      </svg>
    );
  }
  if (provider === 'bitbucket') {
    return (
      <svg className={className} viewBox="0 0 16 16" fill="currentColor">
        <path d="M.778 1.211a.768.768 0 00-.768.892l2.17 13.177a1.043 1.043 0 001.032.862h9.825a.768.768 0 00.768-.646L16 2.103a.768.768 0 00-.768-.892H.778zM9.68 10.592H6.35L5.474 6.166h5.112L9.68 10.592z" />
      </svg>
    );
  }
  return <Globe className={className} strokeWidth={1.5} />;
}

/** Collapsible section header */
function SectionHeader({ title, count, children, defaultOpen = true, actions }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1 w-full px-1 py-0.5">
        <button
          onClick={() => setOpen(v => !v)}
          className="flex items-center gap-1 text-xs font-semibold text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors select-none"
        >
          {open
            ? <ChevronDown className="w-3 h-3 flex-shrink-0" strokeWidth={2} />
            : <ChevronRight className="w-3 h-3 flex-shrink-0" strokeWidth={2} />}
          <span className="uppercase tracking-wider">{title}</span>
        </button>
        {count > 0 && (
          <span className="text-[10px] bg-[#27272a] text-[#a1a1aa] px-1.5 rounded-full font-normal">{count}</span>
        )}
        {actions && <div className="ml-auto flex items-center gap-0.5">{actions}</div>}
      </div>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

/** CC-styled commit message with semantic highlighting */
function CommitMessage({ message }) {
  const cc = parseConventionalCommit(message);
  if (!cc) return <span className="truncate text-[#d4d4d8]">{message}</span>;
  return (
    <span className="truncate">
      <span className={`inline-block px-1 py-0 rounded text-[10px] font-semibold mr-1 leading-tight ${ccColor(cc.type)}`}>
        {cc.type}
      </span>
      {cc.scope && <span className="text-[#71717a] text-[10px] mr-1">({cc.scope})</span>}
      {cc.breaking && <span className="text-red-400 text-[10px] mr-1">!</span>}
      <span className="text-[#e4e4e7]">{cc.subject}</span>
    </span>
  );
}

/** Commit graph column — backbone lines + Bezier merge curves + nodes */
function CommitGraphColumn({ graphNode, rowHeight = 32, totalLanes }) {
  if (!graphNode) return null;
  const cols = Math.max(totalLanes || 1, (graphNode.laneCount || 1));
  const colW = 14;
  const width = cols * colW + 6;
  const cx = graphNode.col * colW + colW / 2 + 3;
  const cy = rowHeight / 2;
  const r = graphNode.isMerge ? 5 : 3.5;

  return (
    <svg width={width} height={rowHeight} className="flex-shrink-0" style={{ minWidth: width }}>
      {/* Backbone / active lane lines */}
      {graphNode.activeLanes.map((lane, idx) => {
        if (lane === null) return null;
        const x = idx * colW + colW / 2 + 3;
        const color = `var(--graph-${idx % 8})`;
        return (
          <line key={idx} x1={x} y1={0} x2={x} y2={rowHeight}
            stroke={color} strokeWidth={1.5} opacity={0.35} />
        );
      })}
      {/* Merge curves — smooth Bezier from parent lane to this node */}
      {graphNode.mergeFromCols.map((mc, i) => {
        const mx = mc * colW + colW / 2 + 3;
        // Smooth cubic Bezier: start at top of merge lane, curve into node
        const d = `M ${mx} 0 C ${mx} ${cy * 0.6}, ${cx} ${cy * 0.4}, ${cx} ${cy}`;
        return (
          <path key={`m-${i}`} d={d} fill="none"
            stroke={graphNode.color} strokeWidth={1.5} opacity={0.5} />
        );
      })}
      {/* Node circle */}
      <circle cx={cx} cy={cy} r={r}
        fill={graphNode.isMerge ? '#18181b' : graphNode.color}
        stroke={graphNode.color}
        strokeWidth={graphNode.isMerge ? 2 : 0} />
    </svg>
  );
}

/* ───── Security alert banner ─────────────────────── */

function TokenSecurityAlert({ remotes, onDismiss }) {
  const hasToken = useMemo(() => (remotes || []).some(r =>
    urlContainsToken(r?.refs?.push) || urlContainsToken(r?.refs?.fetch)
  ), [remotes]);

  if (!hasToken) return null;

  return (
    <div className="mb-3 p-2 bg-amber-900/30 border border-amber-600/50 rounded text-xs space-y-1">
      <div className="flex items-start gap-1.5">
        <ShieldAlert className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-amber-300 font-semibold">Access token detected in remote URL</p>
          <p className="text-amber-200/70 mt-0.5 leading-relaxed">
            A Personal Access Token was found in your remote configuration. Consider revoking it
            and using a credential manager or SSH keys instead for better security.
          </p>
        </div>
      </div>
      <button
        onClick={onDismiss}
        className="text-[10px] text-amber-400 hover:text-amber-300 underline mt-1"
      >
        Dismiss
      </button>
    </div>
  );
}

export function GitStatus({ slug }) {
  const dispatch = useDispatch();
  const {
    status, loading, error, actionError, actionErrorCode,
    remotes, stashList, commitHistory, unpushedCommits, incomingCommits,
  } = useSelector(s => s.git);
  const { githubInfo, prList, prListLoading, hasToken: prHasToken } = useSelector(s => s.pr);
  const [showTokenModalFromSCM, setShowTokenModalFromSCM] = useState(false);

  const [message, setMessage] = useState('');
  const [commitBody, setCommitBody] = useState('');
  const [showCommitBody, setShowCommitBody] = useState(false);
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [newRemoteName, setNewRemoteName] = useState('origin');
  const [newRemoteUrl, setNewRemoteUrl] = useState('');
  const [editingRemote, setEditingRemote] = useState(null);   // remote name being edited
  const [editRemoteUrl, setEditRemoteUrl] = useState('');      // edited URL value
  const [showAllCommits, setShowAllCommits] = useState(false);
  const [hunkStagingFile, setHunkStagingFile] = useState(null); // file path for hunk staging
  const [amendMode, setAmendMode] = useState(false);
  const [stashMessage, setStashMessage] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [showClone, setShowClone] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [securityDismissed, setSecurityDismissed] = useState(false);
  const searchInputRef = useRef(null);

  // ── docking WM helpers for opening PR panel ────
  const dockNodes = useSelector(selectNodes);
  const dockTabs = useSelector(selectTabs);

  /** Open (or focus) the Pull Requests panel in the docking layout */
  const openPRPanel = useCallback(() => {
    // Check if a PR tab already exists
    const panelType = IDE_PANEL.PULL_REQUESTS;
    let existing = null;
    for (const [nodeId, node] of Object.entries(dockNodes)) {
      if (node.type !== 'tabgroup') continue;
      for (const tId of node.tabs || []) {
        const t = dockTabs[tId];
        if (t && t.panelType === panelType) {
          existing = { tabId: tId, groupId: nodeId };
          break;
        }
      }
      if (existing) break;
    }

    if (existing) {
      dispatch(setFocusedTabGroup(existing.groupId));
      dispatch(activateTabAction({ tabId: existing.tabId }));
      return;
    }

    // Find a sidebar group to open the tab in
    const SIDEBAR_PANELS = new Set(['explorer', 'search', 'git', 'extensions', 'extension-view', 'chat', 'pullrequests', 'settings']);
    const groups = Object.entries(dockNodes).filter(([, n]) => n.type === 'tabgroup');
    let targetGroupId = null;
    for (const [groupId, group] of groups) {
      for (const tId of group.tabs || []) {
        const t = dockTabs[tId];
        if (t && SIDEBAR_PANELS.has(t.panelType)) {
          targetGroupId = groupId;
          break;
        }
      }
      if (targetGroupId) break;
    }
    if (!targetGroupId && groups.length > 0) targetGroupId = groups[0][0];

    if (targetGroupId) {
      dispatch(openTab({
        panelType,
        title: 'Pull Requests',
        targetTabGroupId: targetGroupId,
      }));
      dispatch(setFocusedTabGroup(targetGroupId));
    }
  }, [dispatch, dockNodes, dockTabs]);

  /** Open (or focus) the Commit History panel in the bottom area */
  const openCommitHistoryPanel = useCallback(() => {
    const panelType = IDE_PANEL.COMMIT_HISTORY;
    // Check if already open
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
    // Find a bottom-area group (terminal, problems, output)
    const BOTTOM_PANELS = new Set(['terminal', 'problems', 'output']);
    const groups = Object.entries(dockNodes).filter(([, n]) => n.type === 'tabgroup');
    let targetGroupId = null;
    for (const [groupId, group] of groups) {
      for (const tId of group.tabs || []) {
        const t = dockTabs[tId];
        if (t && BOTTOM_PANELS.has(t.panelType)) {
          targetGroupId = groupId;
          break;
        }
      }
      if (targetGroupId) break;
    }
    if (!targetGroupId && groups.length > 0) targetGroupId = groups[0][0];

    if (targetGroupId) {
      dispatch(openTab({
        panelType,
        title: 'Commit History',
        targetTabGroupId: targetGroupId,
      }));
      dispatch(setFocusedTabGroup(targetGroupId));
    }
  }, [dispatch, dockNodes, dockTabs]);

  // ── data refresh ───────────────────────────────
  const refreshGitData = useCallback(async () => {
    if (!slug) return;
    dispatch(fetchGitStatus(slug));
    dispatch(fetchRemotes(slug));
    dispatch(fetchCommitHistory({ slug }));
    dispatch(fetchUnpushedCommits({ slug, max: 50 }));
    dispatch(fetchIncomingCommits({ slug, max: 50 }));
    dispatch(fetchStashList(slug));
    
    // Check stored token
    const storedToken = getStoredToken(slug);
    if (storedToken) dispatch(setHasToken(true));
    
    // Also fetch PR info if available
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
    const interval = setInterval(() => {
      if (document.hasFocus()) dispatch(fetchGitStatus(slug));
    }, 30000);
    return () => { clearInterval(interval); window.removeEventListener('focus', handleFocus); };
  }, [slug, dispatch, refreshGitData]);

  // ── handlers ───────────────────────────────────
  const handleSync = async () => {
    if (!slug) return;
    const result = await dispatch(fetchRemote(slug));
    dispatch(fetchRemotes(slug));
    dispatch(fetchCommitHistory({ slug }));
    dispatch(fetchUnpushedCommits({ slug, max: 50 }));
    dispatch(fetchIncomingCommits({ slug, max: 50 }));
    if (fetchRemote.fulfilled.match(result)) toast.success('Fetched latest from remote');
  };

  const handleRefreshPRs = async () => {
    const token = getStoredToken(slug);
    if (!token) return;
    
    let info = githubInfo;
    if (!info?.owner || !info?.repo) {
      const infoResult = await dispatch(fetchGithubInfo(slug));
      if (fetchGithubInfo.fulfilled.match(infoResult)) {
        info = infoResult.payload;
      }
    }
    if (info?.owner && info?.repo) {
      dispatch(fetchPRList({ owner: info.owner, repo: info.repo, slug }));
    }
  };

  const handleAddRemote = async () => {
    if (!slug || !newRemoteName || !newRemoteUrl) return;
    const valid = newRemoteUrl.startsWith('http://') || newRemoteUrl.startsWith('https://') || newRemoteUrl.includes('@');
    if (!valid) { toast.error('Please enter a valid remote URL (https://... or git@...)'); return; }
    const result = await dispatch(addRemote({ slug, name: newRemoteName, url: newRemoteUrl }));
    if (addRemote.fulfilled.match(result)) {
      toast.success(`Remote '${newRemoteName}' added`);
      setShowAddRemote(false);
      setNewRemoteUrl('');
    }
  };

  const handleRemoveRemoteClick = async (name) => {
    if (slug && name && confirm(`Remove remote '${name}'?`)) {
      const result = await dispatch(removeRemote({ slug, name }));
      if (removeRemote.fulfilled.match(result)) toast.success(`Remote '${name}' removed`);
    }
  };

  const handleEditRemoteStart = (remote) => {
    setEditingRemote(remote.name);
    setEditRemoteUrl(remote.refs?.push || '');
  };

  const handleEditRemoteSave = async () => {
    if (!slug || !editingRemote || !editRemoteUrl) return;
    const valid = editRemoteUrl.startsWith('http://') || editRemoteUrl.startsWith('https://') || editRemoteUrl.includes('@');
    if (!valid) { toast.error('Please enter a valid remote URL (https://... or git@...)'); return; }
    const result = await dispatch(setRemoteUrl({ slug, name: editingRemote, url: editRemoteUrl }));
    if (setRemoteUrl.fulfilled.match(result)) {
      toast.success(`Remote '${editingRemote}' URL updated`);
      setEditingRemote(null);
      setEditRemoteUrl('');
    }
  };

  const handleEditRemoteCancel = () => {
    setEditingRemote(null);
    setEditRemoteUrl('');
  };

  const handlePull = async () => {
    if (!slug) return;
    const result = await dispatch(pullChanges(slug));
    if (pullChanges.fulfilled.match(result)) {
      dispatch(refreshWorkspaceThunk());
      toast.success('Pulled latest changes');
    } else if (pullChanges.rejected.match(result)) {
      if (result.payload?.code === 'MERGE_CONFLICT') {
        const count = result.payload.conflicted?.length || 0;
        toast.error(
          `Merge conflict — ${count} file${count !== 1 ? 's' : ''} need resolution`,
          { duration: 6000 }
        );
      } else if (result.payload?.code === 'UNCOMMITTED_CHANGES') {
        toast.error('Uncommitted changes would be overwritten. Commit or stash first.', { duration: 5000 });
      } else {
        toast.error(result.payload?.message || result.error?.message || 'Pull failed');
      }
    }
  };

  const handlePush = async () => {
    if (!slug) return;
    const result = await dispatch(pushChanges(slug));
    if (pushChanges.fulfilled.match(result)) {
      toast.success('Pushed to remote');
    } else if (pushChanges.rejected.match(result)) {
      toast.error(result.payload?.message || result.error?.message || 'Push failed');
    }
  };

  const handleCommit = async () => {
    if (!slug || !message) return;
    const fullMessage = commitBody ? `${message}\n\n${commitBody}` : message;
    // Optimistic: clear the commit input immediately for snappy feel
    const prevMessage = message;
    const prevBody = commitBody;
    setMessage('');
    setCommitBody('');
    setShowCommitBody(false);
    setAmendMode(false);
    const resultAction = await dispatch(commitChanges({ slug, message: fullMessage, amend: amendMode }));
    if (commitChanges.fulfilled.match(resultAction)) {
      toast.success(amendMode ? `Amended commit` : `Committed: ${prevMessage}`);
    } else {
      // Restore the message on failure so the user doesn't lose their input
      setMessage(prevMessage);
      setCommitBody(prevBody);
      if (prevBody) setShowCommitBody(true);
      const errMsg = resultAction?.error?.message || 'Commit failed';
      toast.error(errMsg);
    }
  };

  const handleCommitAndPush = async () => {
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
      } else {
        toast.error(pushResult?.error?.message || 'Push failed after commit');
      }
    } else {
      setMessage(prevMessage);
      setCommitBody(prevBody);
      if (prevBody) setShowCommitBody(true);
      toast.error(commitResult?.error?.message || 'Commit failed');
    }
  };

  const handleStashPush = async () => {
    if (!slug) return;
    const result = await dispatch(stashPush({ slug, message: stashMessage }));
    if (stashPush.fulfilled.match(result)) toast.success('Changes stashed');
    setStashMessage('');
    dispatch(fetchGitStatus(slug));
  };
  const handleStashPop = async (index = 0) => {
    if (!slug) return;
    const result = await dispatch(stashPop({ slug, index }));
    if (stashPop.fulfilled.match(result)) toast.success('Stash applied and removed');
    dispatch(refreshWorkspaceThunk());
  };
  const handleStashDrop = async (index = 0) => {
    if (!slug || !confirm('Drop this stash?')) return;
    const result = await dispatch(stashDrop({ slug, index }));
    if (stashDrop.fulfilled.match(result)) toast.success('Stash dropped');
  };

  const handleStage = async (e, filePath) => {
    e.stopPropagation();
    const result = await dispatch(stageFile({ slug, filePath }));
    if (stageFile.rejected.match(result)) toast.error(result.error?.message || 'Failed to stage file');
  };
  const handleStageAll = async () => {
    if (!slug) return;
    const result = await dispatch(stageAll(slug));
    if (stageAll.rejected.match(result)) toast.error(result.error?.message || 'Failed to stage all');
  };
  const handleUnstage = async (e, filePath) => {
    e.stopPropagation();
    const result = await dispatch(unstageFile({ slug, filePath }));
    if (unstageFile.rejected.match(result)) toast.error(result.error?.message || 'Failed to unstage file');
  };
  const handleUnstageAll = async () => {
    if (!slug) return;
    const result = await dispatch(unstageAll(slug));
    if (unstageAll.rejected.match(result)) toast.error(result.error?.message || 'Failed to unstage all');
  };

  const handleDiscard = async (e, filePath) => {
    e.stopPropagation();
    if (!confirm(`Discard changes in ${filePath}?`)) return;
    const result = await dispatch(discardChange({ slug, filePath }));
    if (discardChange.fulfilled.match(result)) {
      // Don't call refreshWorkspaceThunk() — the server broadcasts
      // 'file-reverted' + 'file-tree-changed' + 'git-status-changed'
      // events that the client handles automatically.  Calling refresh
      // here races with those broadcasts and can double the file content.
      toast.success(`Discarded changes in ${filePath.split('/').pop()}`);
    } else {
      toast.error(`Failed to discard ${filePath.split('/').pop()}`);
    }
  };
  const handleDiscardAll = async () => {
    if (!confirm('Discard ALL changes? This cannot be undone!')) return;
    const result = await dispatch(discardAll(slug));
    if (discardAll.fulfilled.match(result)) {
      toast.success('All changes discarded');
    } else {
      toast.error('Failed to discard all changes');
    }
  };


  const handleFileClick = (fileStatus) => {
    const file = {
      name: fileStatus.path.split('/').pop(),
      path: fileStatus.path,
      originalPath: fileStatus.from || fileStatus.path,
      language: getFileLanguage(fileStatus.path)
    };
    dispatch(openDiffThunk(file));
  };

  const handleConflictFileClick = (filePath) => {
    const file = {
      name: filePath.split('/').pop(),
      path: filePath,
      language: getFileLanguage(filePath)
    };
    dispatch(selectFileThunk(file));
  };

  const handleInit = async () => {
    if (!slug) return;
    try {
      await dispatch(initRepo({ slug, remoteUrl: null }));
      dispatch(fetchFilesThunk(slug));
      dispatch(fetchGitStatus(slug));
    } catch (e) {
      console.error('Init repo failed', e);
    }
  };

  const handleCloneRepo = async () => {
    if (!slug || !cloneUrl) return;
    try {
      await dispatch(cloneRepo({ slug, repoUrl: cloneUrl, token: null }));
      dispatch(fetchFilesThunk(slug));
      dispatch(fetchGitStatus(slug));
      setCloneUrl('');
      setShowClone(false);
    } catch (e) {
      console.error('Clone repo failed', e);
    }
  };

  // ── derived state ──────────────────────────────
  const staged = status?.files ? status.files.filter(f => f.index !== ' ' && f.index !== '?') : [];
  const changes = status?.files ? status.files.filter(f => f.working_dir !== ' ' || f.index === '?') : [];
  const conflictedFiles = status?.conflictedFiles || [];
  const hasConflicts = status?.hasConflicts || conflictedFiles.length > 0;
  const hasChanges = staged.length > 0 || changes.length > 0;

  // ── conflict resolution handlers ───────────────
  const handleResolveOurs = async (e, filePath) => {
    e.stopPropagation();
    if (slug) {
      await dispatch(resolveConflictOurs({ slug, filePath }));
      dispatch(refreshWorkspaceThunk());
    }
  };

  const handleResolveTheirs = async (e, filePath) => {
    e.stopPropagation();
    if (slug) {
      await dispatch(resolveConflictTheirs({ slug, filePath }));
      dispatch(refreshWorkspaceThunk());
    }
  };

  const handleMarkResolved = async (e, filePath) => {
    e.stopPropagation();
    if (slug) {
      await dispatch(markResolved({ slug, filePath }));
    }
  };

  const handleAbortMerge = async () => {
    if (slug && confirm('Are you sure you want to abort the merge? All merge progress will be lost.')) {
      await dispatch(abortMerge(slug));
      dispatch(refreshWorkspaceThunk());
    }
  };

  // ── computed values ────────────────────────────
  const allCommits = useMemo(() => commitHistory?.all ?? [], [commitHistory]);
  const filteredCommits = useMemo(() => {
    if (!searchQuery) return allCommits;
    const q = searchQuery.toLowerCase();
    return allCommits.filter(c =>
      c.message?.toLowerCase().includes(q) ||
      c.author_name?.toLowerCase().includes(q) ||
      c.hash?.toLowerCase().startsWith(q)
    );
  }, [allCommits, searchQuery]);

  const displayCommits = showAllCommits ? filteredCommits : filteredCommits.slice(0, 20);
  const dateGroups = useMemo(() => groupCommitsByDate(displayCommits), [displayCommits]);
  const graphNodes = useMemo(() => buildCommitGraph(displayCommits), [displayCommits]);
  const maxLanes = useMemo(() => Math.max(1, ...graphNodes.map(g => g.laneCount)), [graphNodes]);

  // Primary remote URL (for commit links)
  const primaryRemoteUrl = remotes?.[0]?.refs?.push ?? null;

  // Sync tooltip
  const syncTooltip = useMemo(() => {
    const parts = [];
    if (unpushedCommits?.length) parts.push(`Push ${unpushedCommits.length} commit${unpushedCommits.length > 1 ? 's' : ''}`);
    if (incomingCommits?.length) parts.push(`Pull ${incomingCommits.length} commit${incomingCommits.length > 1 ? 's' : ''}`);
    return parts.length > 0 ? parts.join(', ') : 'Fetch updates from remote';
  }, [unpushedCommits, incomingCommits]);

  // The error to display (prefer actionError since it persists)
  // Suppress generic banner for UNCOMMITTED_CHANGES — it has its own dedicated UI
  const displayError = actionErrorCode === 'UNCOMMITTED_CHANGES' ? null : (actionError || error);

  // ── CSS custom properties for graph colours ────
  const graphStyle = {
    '--graph-0': '#3b82f6', '--graph-1': '#10b981', '--graph-2': '#f59e0b', '--graph-3': '#ec4899',
    '--graph-4': '#8b5cf6', '--graph-5': '#06b6d4', '--graph-6': '#f43f5e', '--graph-7': '#84cc16',
  };

  // ── No git ─────────────────────────────────────
  if (status === null) {
    return (
      <div className="p-2 h-full flex flex-col justify-center items-center">
        <div className="mb-1.5 text-xs text-[#a1a1aa]">Git not initialized for this workspace.</div>
        <div className="flex gap-1.5">
          <button onClick={handleInit} className="border border-[#3f3f46] bg-transparent hover:bg-[#27272a] text-[#e4e4e7] px-2 py-0.5 rounded text-xs transition-colors">
            Initialize Git
          </button>
          <button onClick={() => setShowClone(v => !v)} className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 text-[#3b82f6] px-2 py-0.5 rounded text-xs transition-colors">
            Clone from Git
          </button>
        </div>
        {showClone && (
          <div className="mt-1.5 w-full">
            <input
              className="w-full bg-[#18181b] border border-[#3f3f46] rounded px-2 py-0.5 text-xs text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6]"
              placeholder="https://github.com/owner/repo.git"
              value={cloneUrl}
              onChange={(e) => setCloneUrl(e.target.value)}
            />
            <div className="flex gap-1.5 mt-1.5">
              <button onClick={handleCloneRepo} className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 text-[#3b82f6] px-2 py-0.5 rounded text-xs transition-colors">
                Clone
              </button>
              <button onClick={() => setShowClone(false)} className="border border-[#3f3f46] bg-transparent hover:bg-[#27272a] text-[#a1a1aa] px-2 py-0.5 rounded text-xs transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ──────────────── RENDER ────────────────────────


  return (
    <>
    <div className="flex flex-col h-full w-full overflow-hidden" style={graphStyle}>
      {/* ── Header ────────────────────────────────── */}
      <div className="px-2 py-1.5 font-semibold text-xs uppercase tracking-wider text-[#a1a1aa] border-b border-[#27272a] flex justify-between items-center">
        <span>Source Control</span>
        <div className="flex gap-0.5">
          <button onClick={handlePull} disabled={loading} title="Pull from Remote"
            className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors disabled:opacity-50">
            <DownloadCloud className="w-3 h-3" strokeWidth={1.5} />
          </button>
          <button onClick={handlePush} disabled={loading} title="Push to Remote"
            className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors disabled:opacity-50">
            <UploadCloud className="w-3 h-3" strokeWidth={1.5} />
          </button>
          <button onClick={handleSync} disabled={loading} title={syncTooltip}
            className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* ── Branch & Sync indicators ──────────────── */}
      <div className="px-2 py-1.5 flex items-center gap-2 text-xs border-b border-[#27272a]">
        <div className="text-[#e4e4e7] text-sm font-medium truncate">{status?.current || 'unknown'}</div>
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
          {unpushedCommits?.length > 0 && (
            <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-600/20 text-amber-300 rounded text-[10px] font-semibold" title={`${unpushedCommits.length} unpushed`}>
              <ArrowUpCircle className="w-2.5 h-2.5" /> {unpushedCommits.length}
            </div>
          )}
          {incomingCommits?.length > 0 && (
            <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-600/20 text-blue-300 rounded text-[10px] font-semibold" title={`${incomingCommits.length} incoming`}>
              <ArrowDownCircle className="w-2.5 h-2.5" /> {incomingCommits.length}
            </div>
          )}
          {(!unpushedCommits?.length && !incomingCommits?.length) && (
            <div className="flex items-center gap-0.5 px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded text-[10px]" title="Up to date">
              <CheckCircle2 className="w-2.5 h-2.5" />
            </div>
          )}
        </div>
      </div>

      {/* ── Scrollable body ───────────────────────── */}
      <div className="flex-1 overflow-y-auto px-2 pt-2 pb-1">

        {/* Error banner (persists until next action or dismiss) */}
        {displayError && (
          <div className="mb-3 p-2 bg-red-900/20 border border-red-500/30 rounded text-xs text-red-400 break-words">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-red-400" />
              <div className="flex-1 min-w-0">
                <p className="font-medium">{displayError}</p>
                {(displayError.includes('No configured push destination') ||
                  displayError.includes('No remote configured') ||
                  displayError.toLowerCase().includes('authentication failed') ||
                  displayError.toLowerCase().includes('repository not found') ||
                  displayError.toLowerCase().includes('remote repository not found')
                ) && (
                  <button onClick={() => setShowAddRemote(true)}
                    className="mt-1.5 border border-red-500/40 bg-transparent hover:bg-red-500/10 text-red-400 px-2 py-0.5 rounded text-xs w-full transition-colors">
                    Configure Remote
                  </button>
                )}
                {displayError.toLowerCase().includes('authentication failed') && (
                  <p className="mt-1.5 text-red-300/60 leading-relaxed">
                    The server could not authenticate with the remote. Add a remote URL with an
                    access token or configure SSH/credentials for the collab server.
                  </p>
                )}
              </div>
              <button onClick={() => dispatch(clearError())} className="flex-shrink-0 hover:text-red-300 p-0.5 rounded" title="Dismiss">
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* Security alert for tokens in remotes */}
        {!securityDismissed && <TokenSecurityAlert remotes={remotes} onDismiss={() => setSecurityDismissed(true)} />}

        {/* ── Uncommitted Changes Warning (not a merge conflict) ── */}
        {actionErrorCode === 'UNCOMMITTED_CHANGES' && (
          <div className="mb-3 p-2 bg-amber-900/20 border border-amber-600/40 rounded text-xs text-amber-300 break-words">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-400" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold">Cannot pull: uncommitted changes</p>
                <p className="text-amber-200/70 mt-0.5 leading-relaxed">
                  Your local changes would be overwritten by merge. Commit or stash them first.
                </p>
              </div>
              <button onClick={() => dispatch(clearError())} className="flex-shrink-0 hover:text-amber-200 p-0.5 rounded" title="Dismiss">
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* ── Merge Conflicts ─────────────────────── */}
        {hasConflicts && (
          <>
            <div className="mb-3 p-2 rounded border" style={{ backgroundColor: 'rgba(245, 158, 66, 0.08)', borderColor: 'rgba(245, 158, 66, 0.20)' }}>
              <div className="flex items-center gap-2 mb-1.5">
                <AlertTriangle className="w-3.5 h-3.5" style={{ color: '#f59e42' }} />
                <span className="text-xs font-semibold" style={{ color: '#f59e42' }}>Merge Conflicts</span>
                <span className="text-[10px] ml-auto" style={{ color: 'rgba(245, 158, 66, 0.6)' }}>{conflictedFiles.length} file{conflictedFiles.length > 1 ? 's' : ''}</span>
              </div>
              <button onClick={handleAbortMerge}
                className="px-2 py-0.5 rounded text-xs flex items-center gap-1 transition-colors border"
                style={{ backgroundColor: 'rgba(255, 87, 87, 0.10)', borderColor: 'rgba(255, 87, 87, 0.25)', color: '#ff5757' }}>
                <X className="w-2.5 h-2.5" /> Abort Merge
              </button>
            </div>
            <SectionHeader title="Conflicted Files" count={conflictedFiles.length}>
              <ul className="space-y-0.5">
                {conflictedFiles.map(filePath => (
                  <li key={`conflict-${filePath}`}
                    className="flex items-center justify-between px-2 py-1 rounded group cursor-pointer border transition-colors"
                    style={{ backgroundColor: 'rgba(245, 158, 66, 0.05)', borderColor: 'rgba(245, 158, 66, 0.15)' }}
                    onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(245, 158, 66, 0.10)'}
                    onMouseLeave={e => e.currentTarget.style.backgroundColor = 'rgba(245, 158, 66, 0.05)'}
                    onClick={() => handleConflictFileClick(filePath)}>
                    <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
                      <AlertTriangle className="w-3 h-3 flex-shrink-0" style={{ color: '#f59e42' }} />
                      <span className="truncate text-xs" style={{ color: '#e8eaf0' }} title={filePath}>{filePath}</span>
                    </div>
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button onClick={(e) => handleResolveOurs(e, filePath)}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                        style={{ backgroundColor: 'rgba(58, 133, 116, 0.15)', color: '#4aba9a' }} title="Accept ours">Current</button>
                      <button onClick={(e) => handleResolveTheirs(e, filePath)}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                        style={{ backgroundColor: 'rgba(122, 184, 248, 0.15)', color: '#7cb8f8' }} title="Accept theirs">Incoming</button>
                      <button onClick={(e) => handleMarkResolved(e, filePath)}
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors"
                        style={{ backgroundColor: 'rgba(74, 186, 154, 0.10)', color: '#4aba9a' }} title="Mark resolved">Resolved</button>
                    </div>
                  </li>
                ))}
              </ul>
            </SectionHeader>
          </>
        )}

        {/* ── Remotes ─────────────────────────────── */}
        <SectionHeader title="Remotes" count={remotes?.length ?? 0}>
          {showAddRemote && (
            <div className="mb-2 p-2 bg-[#18181b] border border-[#3f3f46] rounded">
              <input className="w-full bg-[#09090b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] mb-1.5 focus:outline-none focus:border-[#3b82f6]"
                placeholder="Remote Name (e.g. origin)" value={newRemoteName} onChange={e => setNewRemoteName(e.target.value)} />
              <input className="w-full bg-[#09090b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] mb-1.5 focus:outline-none focus:border-[#3b82f6]"
                placeholder="Remote URL" value={newRemoteUrl} onChange={e => setNewRemoteUrl(e.target.value)} />
              <div className="flex gap-1.5">
                <button onClick={handleAddRemote} disabled={loading}
                  className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 disabled:opacity-50 text-[#3b82f6] px-2 py-0.5 rounded text-xs flex-1 transition-colors">
                  {loading ? <RefreshCw className="w-3 h-3 animate-spin mx-auto" /> : 'Add'}
                </button>
                <button onClick={() => setShowAddRemote(false)}
                  className="border border-[#3f3f46] bg-transparent hover:bg-[#27272a] text-[#a1a1aa] px-2 py-0.5 rounded text-xs flex-1 transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {remotes?.length > 0 ? (
            <ul className="space-y-0.5">
              {remotes.map(remote => {
                const provider = detectProvider(remote.refs?.push);
                const hasTokenInUrl = urlContainsToken(remote.refs?.push);
                const displayUrl = hasTokenInUrl ? maskRemoteUrl(remote.refs?.push) : humanRemoteUrl(remote.refs?.push);
                const cleanWebUrl = remote.refs?.push?.replace(/\.git$/, '').replace(/https?:\/\/[^@/]+@/, 'https://');
                const isEditing = editingRemote === remote.name;

                return (
                  <li key={remote.name} className="px-1.5 py-1 hover:bg-[#27272a] rounded group transition-colors">
                    {isEditing ? (
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <ProviderIcon provider={provider} className="w-3.5 h-3.5 text-[#a1a1aa] flex-shrink-0" />
                          <span className="text-xs font-medium text-[#e4e4e7]">{remote.name}</span>
                        </div>
                        <input
                          className="w-full bg-[#09090b] border border-[#3b82f6] rounded px-2 py-1 text-xs text-[#e4e4e7] focus:outline-none focus:ring-1 focus:ring-[#3b82f6]"
                          value={editRemoteUrl}
                          onChange={e => setEditRemoteUrl(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleEditRemoteSave(); if (e.key === 'Escape') handleEditRemoteCancel(); }}
                          autoFocus
                          placeholder="https://github.com/user/repo.git"
                        />
                        <div className="flex gap-1.5">
                          <button onClick={handleEditRemoteSave} disabled={loading}
                            className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 disabled:opacity-50 text-[#3b82f6] px-2 py-0.5 rounded text-xs flex-1 transition-colors">
                            {loading ? <RefreshCw className="w-3 h-3 animate-spin mx-auto" /> : 'Save'}
                          </button>
                          <button onClick={handleEditRemoteCancel}
                            className="border border-[#3f3f46] bg-transparent hover:bg-[#27272a] text-[#a1a1aa] px-2 py-0.5 rounded text-xs flex-1 transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <ProviderIcon provider={provider} className="w-3.5 h-3.5 text-[#a1a1aa] flex-shrink-0" />
                        <span className="text-xs font-medium text-[#e4e4e7]">{remote.name}</span>
                        <span className="text-[10px] text-[#52525b] truncate flex-1 text-right" title={remote.refs?.push}>
                          {displayUrl}
                        </span>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          {cleanWebUrl?.startsWith('https') && (
                            <a href={cleanWebUrl} target="_blank" rel="noreferrer"
                              className="hover:bg-[#3f3f46] p-0.5 rounded text-[#a1a1aa] hover:text-[#e4e4e7]" title="Open in browser">
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          )}
                          <button onClick={() => handleEditRemoteStart(remote)}
                            className="hover:bg-[#3b82f6]/10 p-0.5 rounded text-[#a1a1aa] hover:text-[#3b82f6]" title="Edit remote URL">
                            <Edit3 className="w-3 h-3" strokeWidth={1.5} />
                          </button>
                          <button onClick={() => handleRemoveRemoteClick(remote.name)}
                            className="hover:bg-red-500/10 p-0.5 rounded text-[#a1a1aa] hover:text-red-400" title="Remove remote">
                            <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="text-[10px] text-[#52525b] px-1 italic">No remotes configured</div>
          )}
          {!showAddRemote && (
            <button onClick={() => setShowAddRemote(true)}
              className="mt-1 flex items-center gap-1 text-[10px] text-[#52525b] hover:text-[#a1a1aa] px-1 transition-colors">
              <Plus className="w-2.5 h-2.5" /> Add remote
            </button>
          )}
        </SectionHeader>

        {/* ── Unpushed commits ────────────────────── */}
        <SectionHeader title="Unpushed" count={unpushedCommits?.length ?? 0} defaultOpen={!!unpushedCommits?.length}>
          {unpushedCommits?.length > 0 ? (
            <>
              <ul className="space-y-0.5">
                {unpushedCommits.map(c => (
                  <li key={c.hash} className="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-[#27272a] group">
                    <code className="font-mono text-[10px] text-[#a1a1aa] flex-shrink-0">{c.hash?.substring(0, 7)}</code>
                    <div className="truncate text-xs min-w-0 flex-1"><CommitMessage message={c.message} /></div>
                    <span className="text-[10px] text-[#52525b] flex-shrink-0 hidden sm:inline">{relativeTime(c.date)}</span>
                    <button onClick={() => navigator.clipboard.writeText(c.hash)} title="Copy hash"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#3f3f46] text-[#a1a1aa] hover:text-[#e4e4e7] transition-opacity flex-shrink-0">
                      <Copy className="w-2.5 h-2.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <button onClick={handlePush}
                className="mt-1.5 w-full border border-[#3b82f6]/40 bg-transparent hover:bg-[#3b82f6]/10 text-[#3b82f6] py-0.5 rounded text-xs transition-colors">
                Push {unpushedCommits.length} commit{unpushedCommits.length > 1 ? 's' : ''}
              </button>
            </>
          ) : (
            <div className="text-[10px] text-[#52525b] px-1 italic">Nothing to push</div>
          )}
        </SectionHeader>

        {/* ── Incoming commits ────────────────────── */}
        <SectionHeader title="Incoming" count={incomingCommits?.length ?? 0} defaultOpen={!!incomingCommits?.length}>
          {incomingCommits?.length > 0 ? (
            <>
              <ul className="space-y-0.5">
                {incomingCommits.map(c => (
                  <li key={c.hash} className="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-[#27272a] border-l-2 border-emerald-600 group">
                    <code className="font-mono text-[10px] text-emerald-400 flex-shrink-0">{c.hash?.substring(0, 7)}</code>
                    <div className="truncate text-xs min-w-0 flex-1"><CommitMessage message={c.message} /></div>
                    <span className="text-[10px] text-[#52525b] flex-shrink-0 hidden sm:inline">{relativeTime(c.date)}</span>
                    <button onClick={() => navigator.clipboard.writeText(c.hash)} title="Copy hash"
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[#3f3f46] text-[#a1a1aa] hover:text-[#e4e4e7] transition-opacity flex-shrink-0">
                      <Copy className="w-2.5 h-2.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <button onClick={handlePull}
                className="mt-1.5 w-full border border-emerald-600/40 bg-transparent hover:bg-emerald-600/10 text-emerald-400 py-0.5 rounded text-xs transition-colors">
                Pull {incomingCommits.length} commit{incomingCommits.length > 1 ? 's' : ''}
              </button>
            </>
          ) : (
            <div className="text-[10px] text-[#52525b] px-1 italic">No incoming commits (fetch to check)</div>
          )}
        </SectionHeader>

        {/* ── Stash ───────────────────────────────── */}
        <SectionHeader title="Stash" count={stashList?.length ?? 0} defaultOpen={false}>
          {hasChanges && (
            <div className="flex gap-1.5 mb-1.5">
              <input type="text" value={stashMessage} onChange={e => setStashMessage(e.target.value)}
                placeholder="Stash message (optional)..."
                className="flex-1 bg-[#18181b] border border-[#3f3f46] rounded px-2 py-0.5 text-xs text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6]" />
              <button onClick={handleStashPush} disabled={!hasChanges}
                className="border border-purple-500/40 bg-transparent hover:bg-purple-500/10 disabled:opacity-50 text-purple-400 px-2 py-0.5 rounded text-xs transition-colors">
                Stash
              </button>
            </div>
          )}
          {stashList?.length > 0 ? (
            <ul className="space-y-0.5">
              {stashList.map((s, idx) => (
                <li key={s.hash || idx} className="flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-[#27272a] group">
                  <code className="font-mono text-[10px] text-[#a1a1aa] flex-shrink-0">stash@{`{${idx}}`}</code>
                  <span className="truncate text-xs text-[#e4e4e7] flex-1">{s.message || 'WIP'}</span>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button onClick={() => handleStashPop(idx)} className="hover:bg-[#27272a] p-0.5 rounded text-[#a1a1aa] hover:text-[#e4e4e7]" title="Pop stash">
                      <ArchiveRestore className="w-3 h-3" strokeWidth={1.5} />
                    </button>
                    <button onClick={() => handleStashDrop(idx)} className="hover:bg-red-500/10 p-0.5 rounded text-[#a1a1aa] hover:text-red-400" title="Drop stash">
                      <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[10px] text-[#52525b] px-1 italic">No stashed changes</div>
          )}
        </SectionHeader>

        {/* ── Pull Requests ──────────────────────── */}
        <SectionHeader 
          title="Pull Requests" 
          count={prList.filter(p => p.state === 'open').length} 
          defaultOpen={true}
          actions={
            <div className="flex items-center gap-0.5">
              {prHasToken && githubInfo?.provider === 'github' && (
                <button 
                  onClick={() => {
                    openPRPanel();
                    // Small delay to let view switch, then trigger create
                    setTimeout(() => window.dispatchEvent(new CustomEvent('synthi:pr-action', { detail: 'create' })), 100);
                  }}
                  className="p-0.5 rounded hover:bg-[#27272a] text-[#71717a] hover:text-emerald-400" 
                  title="Create Pull Request"
                >
                  <Plus className="w-3 h-3" />
                </button>
              )}
              <button 
                onClick={() => openPRPanel()}
                className="p-0.5 rounded hover:bg-[#27272a] text-[#71717a] hover:text-[#a1a1aa]" 
                title="Open Pull Requests panel"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
              <button 
                onClick={() => {
                  if (githubInfo?.htmlUrl) {
                    window.open(githubInfo.htmlUrl + '/pulls', '_blank');
                  } else {
                    openPRPanel();
                  }
                }}
                className="p-0.5 rounded hover:bg-[#27272a] text-[#71717a] hover:text-[#a1a1aa]" 
                title="Manage PRs on GitHub"
              >
                <ExternalLink className="w-3 h-3" />
              </button>
              <button onClick={handleRefreshPRs} className="p-0.5 rounded hover:bg-[#27272a] text-[#71717a] hover:text-[#a1a1aa]" title="Refresh PRs">
                <RefreshCw className={`w-3 h-3 ${prListLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          }
        >
          {/* No token state */}
          {!prHasToken && githubInfo?.provider === 'github' && (
            <div className="px-1.5 py-1.5">
              <p className="text-[10px] text-[#71717a] mb-1.5">Connect GitHub to manage pull requests</p>
              <button 
                onClick={() => setShowTokenModalFromSCM(true)}
                className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-[#3f3f46] hover:bg-[#27272a] text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors"
              >
                <Key className="w-2.5 h-2.5" />
                Add GitHub Token
              </button>
            </div>
          )}

          {/* No GitHub remote */}
          {githubInfo && githubInfo.provider !== 'github' && (
            <div className="text-[10px] text-[#52525b] px-1 italic">
              {githubInfo.provider ? `${githubInfo.provider} remote detected — PRs supported for GitHub only` : 'No GitHub remote configured'}
            </div>
          )}

          {/* Has token + GitHub remote — show PRs */}
          {prHasToken && githubInfo?.provider === 'github' && (
            <>
              {prListLoading && prList.length === 0 ? (
                <div className="flex items-center gap-1.5 px-1.5 py-1 text-[10px] text-[#71717a]">
                  <RefreshCw className="w-2.5 h-2.5 animate-spin" /> Loading PRs…
                </div>
              ) : prList.filter(p => p.state === 'open').length > 0 ? (
                <ul className="space-y-0.5">
                  {prList.filter(p => p.state === 'open').slice(0, 5).map(pr => (
                    <li key={pr.id} className="group flex items-center gap-1.5 px-1.5 py-1 rounded hover:bg-[#27272a] cursor-pointer"
                      onClick={() => {
                        dispatch(setActivePR(pr));
                        openPRPanel();
                      }}>
                      <GitPullRequest className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                      <span className="truncate text-xs text-[#e4e4e7] flex-1">
                        <span className="text-[#71717a] mr-1">#{pr.number}</span>
                        {pr.title}
                      </span>
                      <span className="text-[9px] text-[#52525b] flex-shrink-0">{relativeTime(pr.updated_at)}</span>
                    </li>
                  ))}
                  {prList.filter(p => p.state === 'open').length > 5 && (
                    <li className="px-1.5 py-0.5">
                      <button 
                        onClick={() => openPRPanel()}
                        className="text-[10px] text-[#71717a] hover:text-[#a1a1aa] underline"
                      >
                        View all {prList.filter(p => p.state === 'open').length} pull requests →
                      </button>
                    </li>
                  )}
                </ul>
              ) : (
                <div className="px-1.5 py-1.5">
                  <div className="text-[10px] text-[#52525b] italic mb-1.5">No open pull requests</div>
                  <button 
                    onClick={() => {
                      openPRPanel();
                      setTimeout(() => window.dispatchEvent(new CustomEvent('synthi:pr-action', { detail: 'create' })), 100);
                    }}
                    className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-emerald-600/40 hover:bg-emerald-600/10 text-emerald-400 transition-colors"
                  >
                    <Plus className="w-2.5 h-2.5" />
                    Create Pull Request
                  </button>
                </div>
              )}
            </>
          )}

          {/* No info yet / loading */}
          {!githubInfo && !prListLoading && (
            <div className="text-[10px] text-[#52525b] px-1 italic">Detecting remote…</div>
          )}
        </SectionHeader>

        {/* ── Commit History ──────────────────────── */}
        <div className="mb-3">
          <div className="flex items-center gap-1 px-1 mb-1">
            <button onClick={() => { setShowSearch(v => { if (!v) setTimeout(() => searchInputRef.current?.focus(), 0); return !v; }); }}
              className={`p-0.5 rounded transition-colors flex-shrink-0 ${showSearch ? 'bg-[#27272a] text-[#e4e4e7]' : 'text-[#71717a] hover:text-[#a1a1aa]'}`}>
              <Search className="w-3 h-3" />
            </button>
            {showSearch ? (
              <input ref={searchInputRef} type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                placeholder="Filter by message, author, or SHA…"
                className="flex-1 min-w-0 bg-[#18181b] border border-[#3f3f46] rounded px-2 py-0.5 text-xs text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6] transition-all"
                onKeyDown={e => { if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); } }}
                autoFocus />
            ) : (
              <span className="text-xs font-semibold text-[#a1a1aa] uppercase tracking-wider">Commit History</span>
            )}
            <span className="text-[10px] text-[#52525b] ml-auto flex-shrink-0">
              {filteredCommits.length !== allCommits.length
                ? `${filteredCommits.length}/${allCommits.length}`
                : allCommits.length}
            </span>
            <button onClick={openCommitHistoryPanel}
              className="p-0.5 rounded text-[#71717a] hover:text-[#e4e4e7] hover:bg-[#27272a] transition-colors flex-shrink-0"
              title="Open full Commit History panel">
              <Maximize2 className="w-3 h-3" />
            </button>
          </div>

          {dateGroups.length > 0 ? (
            <div>
              {dateGroups.map(group => (
                <div key={group.label} className="mb-2">
                  <div className="text-[10px] text-[#52525b] font-medium uppercase tracking-wider px-1 mb-0.5">{group.label}</div>
                  <ul className="space-y-0">
                    {group.commits.map(c => {
                      const gIdx = displayCommits.indexOf(c);
                      const gn = graphNodes[gIdx];
                      const webUrl = commitWebUrl(primaryRemoteUrl, c.hash);
                      const cc = parseConventionalCommit(c.message);
                      const isoDate = c.date ? new Date(c.date).toISOString() : '';
                      return (
                        <li key={c.hash} className="flex items-center hover:bg-[#27272a] rounded-md group transition-colors"
                          title={`${c.hash}\n${isoDate}`}>
                          <CommitGraphColumn graphNode={gn} totalLanes={maxLanes} />
                          <div className="flex-1 min-w-0 py-1 pr-1">
                            <div className="flex items-center gap-1">
                              <code className="font-mono text-[10px] text-[#71717a] flex-shrink-0">{c.hash?.substring(0, 7)}</code>
                              <div className="text-xs min-w-0 truncate"><CommitMessage message={c.message} /></div>
                            </div>
                            <div className={`text-[10px] truncate ${cc ? 'text-[#52525b]' : 'text-[#52525b]/70'}`}
                              title={isoDate}>{c.author_name} · {relativeTime(c.date)}</div>
                          </div>
                          {/* Hover actions */}
                          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 pr-1">
                            <button onClick={() => { navigator.clipboard.writeText(c.hash); toast.success('Commit hash copied'); }}
                              title={`Copy full hash: ${c.hash}`}
                              className="p-0.5 rounded hover:bg-[#3f3f46] text-[#71717a] hover:text-[#e4e4e7]">
                              <Copy className="w-2.5 h-2.5" />
                            </button>
                            {webUrl && (
                              <a href={webUrl} target="_blank" rel="noreferrer" title="View commit on remote"
                                className="p-0.5 rounded hover:bg-[#3f3f46] text-[#71717a] hover:text-[#e4e4e7]">
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-[#52525b] px-1 italic">
              {searchQuery ? 'No matching commits' : 'No commits yet'}
            </div>
          )}

          {filteredCommits.length > 20 && (
            <div className="mt-1 flex justify-center">
              <button onClick={() => setShowAllCommits(v => !v)}
                className="text-[10px] text-[#71717a] hover:text-[#a1a1aa] underline">
                {showAllCommits ? 'Collapse' : `Show all ${filteredCommits.length}`}
              </button>
            </div>
          )}
        </div>

        {/* ── Staged + Changes ────────────────────── */}
        {!hasChanges ? (
          <p className="text-xs text-[#52525b] italic text-center mt-4">No changes detected.</p>
        ) : (
          <div className="space-y-3">
            {staged.length > 0 && (
              <SectionHeader title="Staged Changes" count={staged.length}>
                <div className="flex justify-end mb-0.5">
                  <button onClick={handleUnstageAll} className="text-[10px] text-[#71717a] hover:text-[#e4e4e7] hover:bg-[#27272a] px-1.5 py-0.5 rounded transition-colors">
                    Unstage All
                  </button>
                </div>
                <ul className="space-y-0.5">
                  {staged.map(file => (
                    <li key={`staged-${file.path}`}
                      className="flex items-center justify-between hover:bg-[#27272a] px-1.5 py-1 rounded group cursor-pointer transition-colors"
                      onClick={() => handleFileClick(file)}>
                      <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
                        <span className="w-3 text-center font-mono text-[10px] text-emerald-400 flex-shrink-0">{file.index}</span>
                        <span className="truncate text-xs text-[#e4e4e7]" title={file.path}>{file.path}</span>
                      </div>
                      <button onClick={(e) => handleUnstage(e, file.path)}
                        className="opacity-0 group-hover:opacity-100 hover:bg-[#3f3f46] p-0.5 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-all flex-shrink-0" title="Unstage">
                        <Minus className="w-3 h-3" strokeWidth={1.5} />
                      </button>
                    </li>
                  ))}
                </ul>
              </SectionHeader>
            )}

            {changes.length > 0 && (
              <SectionHeader title="Changes" count={changes.length}>
                <div className="flex justify-end gap-1 mb-0.5">
                  <button onClick={handleDiscardAll} className="text-[10px] text-[#71717a] hover:text-red-400 hover:bg-[#27272a] px-1.5 py-0.5 rounded transition-colors">
                    Discard All
                  </button>
                  <button onClick={handleStageAll} className="text-[10px] text-[#71717a] hover:text-[#e4e4e7] hover:bg-[#27272a] px-1.5 py-0.5 rounded transition-colors">
                    Stage All
                  </button>
                </div>
                <ul className="space-y-0.5">
                  {changes.map(file => {
                    const isUntracked = file.working_dir === '?';
                    const showHunkStaging = hunkStagingFile === file.path;
                    return (
                      <li key={`changes-${file.path}`} className="space-y-0">
                        <div
                          className="flex items-center justify-between hover:bg-[#27272a] px-1.5 py-1 rounded group cursor-pointer transition-colors"
                          onClick={() => handleFileClick(file)}>
                          <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
                            <span className="w-3 text-center font-mono text-[10px] text-amber-400 flex-shrink-0">
                              {isUntracked ? 'U' : 'M'}
                            </span>
                            <span className="truncate text-xs text-[#e4e4e7]" title={file.path}>{file.path}</span>
                          </div>
                          <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                            <button onClick={(e) => handleDiscard(e, file.path)}
                              className="hover:bg-[#3f3f46] p-0.5 rounded text-[#a1a1aa] hover:text-[#e4e4e7]" title="Discard Changes">
                              <Undo2 className="w-3 h-3" strokeWidth={1.5} />
                            </button>
                            {!isUntracked && (
                              <button onClick={(e) => {
                                e.stopPropagation();
                                // Open diff view in the main editor for selective staging
                                const diffFile = {
                                  name: file.path.split('/').pop(),
                                  path: file.path,
                                  originalPath: file.from || file.path,
                                  language: getFileLanguage(file.path),
                                  selectiveStaging: true, // flag for HunkStagingView integration
                                };
                                dispatch(openDiffThunk(diffFile));
                              }}
                                className="hover:bg-[#3b82f6]/10 p-0.5 rounded transition-colors text-[#a1a1aa] hover:text-[#3b82f6]"
                                title="Stage Selected Lines (opens diff in editor)">
                                <Edit3 className="w-3 h-3" strokeWidth={1.5} />
                              </button>
                            )}
                            <button onClick={(e) => handleStage(e, file.path)}
                              className="hover:bg-[#3f3f46] p-0.5 rounded text-[#a1a1aa] hover:text-[#e4e4e7]" title="Stage">
                              <Plus className="w-3 h-3" strokeWidth={1.5} />
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </SectionHeader>
            )}
          </div>
        )}
      </div>

      {/* ── Commit input (pinned bottom) ──────────── */}
      {hasChanges && (
        <div className="p-2 border-t border-[#27272a]">
          <div className="space-y-1.5">
            <div className="flex gap-1.5">
              <input type="text" value={message} onChange={e => setMessage(e.target.value)}
                placeholder={amendMode ? "New commit message (amend)…" : "Commit message…"}
                className="flex-1 bg-[#18181b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6] font-mono"
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleCommit()} />
              <button onClick={() => setShowCommitBody(!showCommitBody)}
                className={`p-1 rounded text-xs transition-colors ${showCommitBody ? 'bg-[#27272a] text-[#e4e4e7]' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#27272a]'}`}
                title="Add description">
                <Edit3 className="w-3 h-3" />
              </button>
              <button onClick={handleCommit} disabled={!message || (!amendMode && staged.length === 0)}
                className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 disabled:opacity-50 disabled:cursor-not-allowed text-[#3b82f6] p-1 rounded transition-colors"
                title={amendMode ? "Amend Last Commit" : "Commit Staged"}>
                <Check className="w-4 h-4" strokeWidth={1.5} />
              </button>
              <button onClick={handleCommitAndPush} disabled={!message || (!amendMode && staged.length === 0)}
                className="border border-emerald-500 bg-transparent hover:bg-emerald-500/10 disabled:opacity-50 disabled:cursor-not-allowed text-emerald-500 p-1 rounded transition-colors"
                title="Commit & Push">
                <UploadCloud className="w-4 h-4" strokeWidth={1.5} />
              </button>
            </div>
            {showCommitBody && (
              <textarea value={commitBody} onChange={e => setCommitBody(e.target.value)}
                placeholder="Extended description (optional)…"
                className="w-full bg-[#18181b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6] resize-none font-mono"
                rows={3} />
            )}
            {/* Amend toggle */}
            <div className="flex items-center gap-1.5">
              <label className="flex items-center gap-1 cursor-pointer text-[10px] text-[#71717a] hover:text-[#a1a1aa]">
                <input type="checkbox" checked={amendMode} onChange={e => {
                  const enabled = e.target.checked;
                  setAmendMode(enabled);
                  // Pre-fill with last commit message when enabling amend
                  if (enabled && unpushedCommits?.length > 0 && !message) {
                    const lastMsg = unpushedCommits[0]?.message || '';
                    const [subject, ...bodyParts] = lastMsg.split('\n\n');
                    setMessage(subject || '');
                    if (bodyParts.length) {
                      setCommitBody(bodyParts.join('\n\n'));
                      setShowCommitBody(true);
                    }
                  }
                }}
                  className="w-3 h-3 rounded accent-[#3b82f6]" />
                <span>Amend last commit</span>
              </label>
            </div>
          </div>
        </div>
      )}
    </div>

    {/* Token modal from SCM panel */}
    {showTokenModalFromSCM && (
      <GitHubTokenModal
        slug={slug}
        onClose={() => setShowTokenModalFromSCM(false)}
        onSuccess={() => {
          setShowTokenModalFromSCM(false);
          handleRefreshPRs();
        }}
      />
    )}
    </>
  );
}
