import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchGitStatus, fetchRemote, commitChanges, pushChanges, pullChanges, stageFile, unstageFile, discardChange, initRepo, cloneRepo, addRemote, removeRemote, fetchRemotes, fetchCommitHistory, fetchUnpushedCommits, fetchIncomingCommits, fetchStashList, stashPush, stashPop, stashDrop, clearError, stageAll, unstageAll, discardAll, resolveConflictOurs, resolveConflictTheirs, markResolved, abortMerge } from '@/redux/gitSlice';
import { refreshWorkspaceThunk, openDiffThunk, fetchFilesThunk, selectFileThunk } from '@/redux/workspaceSlice';
import { RefreshCw, Check, UploadCloud, Plus, Minus, DownloadCloud, Undo2, Globe, Trash2, Copy, Archive, ArchiveRestore, AlertTriangle, GitMerge, X, Edit3, ArrowUp, ArrowDown, GitBranch, Circle } from 'lucide-react';
import { getFileLanguage } from '@/utils/fileUtils';

/* ── Synthi card wrapper ── */
const Section = ({ children, className = '' }) => (
    <div className={`mx-2 mb-2 rounded-lg bg-white/[0.02] border border-white/[0.04] ${className}`}>
        {children}
    </div>
);

const SectionHead = ({ dot, label, count, actions }) => (
    <div className="flex items-center gap-2 px-3 py-2">
        {dot && <Circle size={7} className={dot} style={{ fill: 'currentColor' }} />}
        <span className="text-[11px] font-medium text-[#d4d4d8]">{label}</span>
        {count != null && count > 0 && (
            <span className="text-[10px] text-[#71717a] bg-white/[0.04] rounded-full px-1.5 py-0.5 min-w-[18px] text-center font-medium">{count}</span>
        )}
        {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
);

const GhostBtn = ({ onClick, disabled, title, children, className = '' }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={`px-2 py-0.5 rounded-full text-[10px] font-medium transition-all disabled:opacity-40 ${className}`}
    >
        {children}
    </button>
);

const IconBtn = ({ onClick, disabled, title, children, className = '' }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={`p-1.5 rounded-lg transition-all disabled:opacity-40 ${className}`}
    >
        {children}
    </button>
);

export function GitStatus({ slug }) {
    const dispatch = useDispatch();
    const { status, loading, error, remotes, stashList } = useSelector(state => state.git);
    const { commitHistory, unpushedCommits, incomingCommits } = useSelector(state => state.git);
    const [message, setMessage] = useState('');
    const [commitBody, setCommitBody] = useState(''); // Multi-line commit body
    const [showCommitBody, setShowCommitBody] = useState(false);
    const [showAddRemote, setShowAddRemote] = useState(false);
    const [newRemoteName, setNewRemoteName] = useState('origin');
    const [newRemoteUrl, setNewRemoteUrl] = useState('');
    const [showAllCommits, setShowAllCommits] = useState(false);
    const [showStash, setShowStash] = useState(false);
    const [stashMessage, setStashMessage] = useState('');
    
    // Use visibility-based refresh instead of constant polling
    const refreshGitData = useCallback(() => {
        if (slug) {
            dispatch(fetchGitStatus(slug));
            dispatch(fetchRemotes(slug));
            dispatch(fetchCommitHistory({ slug }));
            dispatch(fetchUnpushedCommits({ slug, max: 50 }));
            dispatch(fetchIncomingCommits({ slug, max: 50 }));
            dispatch(fetchStashList(slug));
        }
    }, [slug, dispatch]);

    useEffect(() => {
        if (slug) {
            // Initial fetch
            refreshGitData();
            
            // Refresh on window focus instead of constant polling
            const handleFocus = () => {
                refreshGitData();
            };
            
            window.addEventListener('focus', handleFocus);
            
            // Light poll every 30 seconds instead of 5 (only status)
            const interval = setInterval(() => {
                if (document.hasFocus()) {
                    dispatch(fetchGitStatus(slug));
                }
            }, 30000); 
            
            return () => {
                clearInterval(interval);
                window.removeEventListener('focus', handleFocus);
            };
        }
    }, [slug, dispatch, refreshGitData]);

    const handleSync = () => {
        if (slug) {
            // Only refresh local git state — do NOT call fetchRemote (git fetch)
            // which contacts the remote and triggers GitHub authentication dialogs
            dispatch(fetchGitStatus(slug));
            dispatch(fetchRemotes(slug));
            dispatch(fetchCommitHistory({ slug }));
            dispatch(fetchUnpushedCommits({ slug, max: 50 }));
            dispatch(fetchIncomingCommits({ slug, max: 50 }));
            dispatch(fetchStashList(slug));
        }
    };

    const handleAddRemote = async () => {
        if (slug && newRemoteName && newRemoteUrl) {
            // Basic validation for URL like 'https://' or git@ as SSH
            const valid = newRemoteUrl.startsWith('http://') || newRemoteUrl.startsWith('https://') || newRemoteUrl.includes('@');
            if (!valid) {
                alert('Please enter a valid remote URL (https://... or git@...)');
                return;
            }
            await dispatch(addRemote({ slug, name: newRemoteName, url: newRemoteUrl }));
            setShowAddRemote(false);
            setNewRemoteUrl('');
        }
    };

    const handleRemoveRemote = async (name) => {
        if (slug && name) {
            if (confirm(`Are you sure you want to remove remote '${name}'?`)) {
                await dispatch(removeRemote({ slug, name }));
            }
        }
    };

    const handlePull = async () => {
        if (slug) {
            const result = await dispatch(pullChanges(slug));
            if (pullChanges.fulfilled.match(result)) {
                dispatch(refreshWorkspaceThunk());
            }
        }
    };

    const handlePush = () => {
        if (slug) {
            dispatch(pushChanges(slug));
        }
    };

    const handleFetchHistory = () => {
        if (slug) dispatch(fetchCommitHistory({ slug }));
    };

    const handleFetchUnpushed = () => {
        if (slug) dispatch(fetchUnpushedCommits({ slug, max: 50 }));
    };

    const handleRemoveRemoteClick = async (name) => {
        if (slug && name) {
            await dispatch(removeRemote({ slug, name }));
        }
    };

    const handleCommit = async () => {
        if (slug && message) {
            // Combine title and body for multi-line commit message
            const fullMessage = commitBody ? `${message}\n\n${commitBody}` : message;
            const resultAction = await dispatch(commitChanges({ slug, message: fullMessage }));
            if (commitChanges.fulfilled.match(resultAction)) {
                setMessage('');
                setCommitBody('');
                setShowCommitBody(false);
                // Refresh status + unpushed so the new commit appears in Outgoing
                dispatch(fetchGitStatus(slug));
                dispatch(fetchUnpushedCommits({ slug, max: 50 }));
                dispatch(fetchCommitHistory({ slug }));
            }
        }
    };

    // Stash handlers
    const handleStashPush = async () => {
        if (slug) {
            await dispatch(stashPush({ slug, message: stashMessage }));
            setStashMessage('');
            dispatch(fetchGitStatus(slug));
        }
    };

    const handleStashPop = async (index = 0) => {
        if (slug) {
            await dispatch(stashPop({ slug, index }));
            dispatch(refreshWorkspaceThunk());
        }
    };

    const handleStashDrop = async (index = 0) => {
        if (slug && confirm('Are you sure you want to drop this stash?')) {
            await dispatch(stashDrop({ slug, index }));
        }
    };

    const handleStage = (e, filePath) => {
        e.stopPropagation();
        dispatch(stageFile({ slug, filePath }));
    };

    const handleStageAll = () => {
        if (slug) {
            dispatch(stageAll(slug));
        }
    };

    const handleUnstage = (e, filePath) => {
        e.stopPropagation();
        dispatch(unstageFile({ slug, filePath }));
    };

    const handleUnstageAll = () => {
        if (slug) {
            dispatch(unstageAll(slug));
        }
    };

    const handleDiscard = async (e, filePath) => {
        e.stopPropagation();
        if (confirm(`Are you sure you want to discard changes in ${filePath}?`)) {
            const result = await dispatch(discardChange({ slug, filePath }));
            if (discardChange.fulfilled.match(result)) {
                dispatch(refreshWorkspaceThunk());
            }
        }
    };

    const handleDiscardAll = async () => {
        if (confirm('Are you sure you want to discard ALL changes? This cannot be undone!')) {
            const result = await dispatch(discardAll(slug));
            if (discardAll.fulfilled.match(result)) {
                dispatch(refreshWorkspaceThunk());
            }
        }
    };

    const handleFileClick = (fileStatus) => {
        const file = {
            name: fileStatus.path.split('/').pop(),
            path: fileStatus.path,
            originalPath: fileStatus.from || fileStatus.path, // Handle renames
            language: getFileLanguage(fileStatus.path)
        };
        dispatch(openDiffThunk(file));
    };

    // Open conflict files in regular editor (not diff view) so the conflict banner works
    const handleConflictFileClick = (filePath) => {
        const file = {
            name: filePath.split('/').pop(),
            path: filePath,
            language: getFileLanguage(filePath)
        };
        dispatch(selectFileThunk(file));
    };

    const [cloneUrl, setCloneUrl] = useState('');
    const [showClone, setShowClone] = useState(false);

    const handleInit = async () => {
        if (slug) {
            try {
                await dispatch(initRepo({ slug, remoteUrl: null }));
                dispatch(fetchFilesThunk(slug));
                dispatch(fetchGitStatus(slug));
            } catch (e) {
                console.error('Init repo failed', e);
            }
        }
    };

    const handleCloneRepo = async () => {
        if (slug && cloneUrl) {
            try {
                await dispatch(cloneRepo({ slug, repoUrl: cloneUrl, token: null }));
                dispatch(fetchFilesThunk(slug));
                dispatch(fetchGitStatus(slug));
                setCloneUrl('');
                setShowClone(false);
            } catch (e) {
                console.error('Clone repo failed', e);
            }
        }
    };

    if (status === null) {
        return (
            <div className="flex flex-col h-full w-full items-center justify-center px-4">
                <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center mb-3">
                    <GitBranch className="w-5 h-5 text-violet-400" />
                </div>
                <div className="text-sm text-[#d4d4d8] font-medium mb-1">No repository</div>
                <div className="text-[11px] text-[#52525b] mb-4 text-center">Initialize a new repo or clone an existing one</div>
                <div className="flex gap-2 w-full max-w-[220px]">
                    <button
                        onClick={handleInit}
                        className="flex-1 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.04] border border-white/[0.06] text-[#d4d4d8] hover:bg-white/[0.07] transition-colors"
                    >
                        Init
                    </button>
                    <button
                        onClick={() => setShowClone(v => !v)}
                        className="flex-1 py-1.5 rounded-lg text-[11px] font-medium bg-violet-500/15 border border-violet-500/20 text-violet-300 hover:bg-violet-500/25 transition-colors"
                    >
                        Clone
                    </button>
                </div>
                {showClone && (
                    <div className="mt-3 w-full max-w-[260px]">
                        <input
                            className="w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-1.5 text-[11px] text-[#d4d4d8] focus:outline-none focus:border-violet-500/50 placeholder:text-[#3f3f46] transition-colors"
                            placeholder="https://github.com/owner/repo.git"
                            value={cloneUrl}
                            onChange={(e) => setCloneUrl(e.target.value)}
                        />
                        <div className="flex gap-2 mt-2">
                            <button
                                onClick={handleCloneRepo}
                                className="flex-1 py-1.5 rounded-lg text-[11px] font-medium bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 transition-colors"
                            >
                                Clone
                            </button>
                            <button
                                onClick={() => setShowClone(false)}
                                className="flex-1 py-1.5 rounded-lg text-[11px] font-medium bg-white/[0.04] text-[#71717a] hover:bg-white/[0.07] transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
        );
    }

    const staged = status.files ? status.files.filter(f => f.index !== ' ' && f.index !== '?') : [];
    const changes = status.files ? status.files.filter(f => f.working_dir !== ' ' || f.index === '?') : [];
    
    // Check for merge conflicts
    const conflictedFiles = status.conflictedFiles || [];
    const hasConflicts = status.hasConflicts || conflictedFiles.length > 0;

    // Note: A file can be both staged and modified (appear in both lists)

    const hasChanges = staged.length > 0 || changes.length > 0;

    // Conflict resolution handlers
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

    return (
        <div className="flex flex-col h-full w-full overflow-hidden">
            {/* ── Header strip with gradient accent ── */}
            <div className="flex-shrink-0">
                <div className="h-[2px]" style={{ background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa, transparent)' }} />
                <div className="flex items-center gap-2 px-3 py-2">
                    <GitBranch size={14} className="text-violet-400 flex-shrink-0" />
                    <span className="text-sm font-semibold text-[#e4e4e7] truncate">{status && status.current ? status.current : 'unknown'}</span>

                    {/* Sync badges */}
                    <div className="flex items-center gap-1 ml-1">
                        {status && status.ahead > 0 && (
                            <span className="flex items-center gap-0.5 text-[10px] text-emerald-400 bg-emerald-500/10 rounded-full px-1.5 py-0.5 font-medium">
                                <ArrowUp size={9} /> {status.ahead}
                            </span>
                        )}
                        {status && status.behind > 0 && (
                            <span className="flex items-center gap-0.5 text-[10px] text-amber-400 bg-amber-500/10 rounded-full px-1.5 py-0.5 font-medium">
                                <ArrowDown size={9} /> {status.behind}
                            </span>
                        )}
                        {status && !status.ahead && !status.behind && (
                            <span className="text-[10px] text-emerald-500/60 bg-emerald-500/10 rounded-full px-1.5 py-0.5 font-medium">synced</span>
                        )}
                    </div>

                    {/* Action row */}
                    <div className="ml-auto flex items-center gap-0.5">
                        <IconBtn onClick={handlePull} disabled={loading} title="Pull" className="text-[#71717a] hover:text-emerald-400 hover:bg-emerald-500/10">
                            <DownloadCloud className="w-3.5 h-3.5" strokeWidth={1.5} />
                        </IconBtn>
                        <IconBtn onClick={handlePush} disabled={loading} title="Push" className="text-[#71717a] hover:text-violet-400 hover:bg-violet-500/10">
                            <UploadCloud className="w-3.5 h-3.5" strokeWidth={1.5} />
                        </IconBtn>
                        <IconBtn onClick={handleSync} disabled={loading} title="Refresh" className="text-[#71717a] hover:text-[#d4d4d8] hover:bg-white/[0.06]">
                            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
                        </IconBtn>
                    </div>
                </div>
            </div>

            {/* ── Scrollable content ── */}
            <div className="flex-1 overflow-y-auto py-1">
                {/* Error display */}
                {error && (
                    <div className="mx-2 mb-2 p-3 rounded-lg bg-rose-500/[0.06] border border-rose-500/20">
                        <div className="text-[11px] text-rose-400 break-words">{error}</div>
                        {(error.includes('No configured push destination') || error.includes('No remote configured') || error.toLowerCase().includes('authentication failed') || error.toLowerCase().includes('repository not found') || error.toLowerCase().includes('remote repository not found')) && (
                            <button
                                onClick={() => setShowAddRemote(true)}
                                className="mt-2 w-full py-1.5 rounded-lg text-[10px] font-medium bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-colors"
                            >
                                Configure Remote
                            </button>
                        )}
                        {error.toLowerCase().includes('authentication failed') && (
                            <div className="mt-2 text-[10px] text-[#71717a] leading-relaxed">
                                Use a remote URL with an access token (https://&lt;token&gt;@github.com/owner/repo.git) or configure SSH.
                            </div>
                        )}
                    </div>
                )}

                {/* ── Merge Conflicts ── */}
                {hasConflicts && (
                    <Section>
                        <div className="px-3 py-2 flex items-center gap-2 border-b border-white/[0.04]">
                            <div className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
                            <span className="text-[11px] font-semibold text-rose-400">Merge Conflicts</span>
                            <span className="text-[10px] text-rose-400/50">{conflictedFiles.length} file{conflictedFiles.length > 1 ? 's' : ''}</span>
                            <button
                                onClick={handleAbortMerge}
                                className="ml-auto flex items-center gap-1 text-[10px] text-rose-400 hover:text-rose-300 bg-rose-500/10 hover:bg-rose-500/20 px-2 py-0.5 rounded-full transition-colors"
                            >
                                <X className="w-3 h-3" /> Abort
                            </button>
                        </div>
                        <ul>
                            {conflictedFiles.map(filePath => (
                                <li
                                    key={`conflict-${filePath}`}
                                    className="flex items-center justify-between px-3 py-1.5 hover:bg-white/[0.02] cursor-pointer group transition-colors border-l-2 border-l-rose-500 ml-2"
                                    onClick={() => handleConflictFileClick(filePath)}
                                >
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        <AlertTriangle className="w-3 h-3 text-rose-400 flex-shrink-0" />
                                        <span className="truncate text-[11px] text-rose-300/80" title={filePath}>{filePath}</span>
                                    </div>
                                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                        <GhostBtn onClick={(e) => handleResolveOurs(e, filePath)} title="Accept ours" className="bg-violet-500/15 text-violet-300 hover:bg-violet-500/25">Ours</GhostBtn>
                                        <GhostBtn onClick={(e) => handleResolveTheirs(e, filePath)} title="Accept theirs" className="bg-teal-500/15 text-teal-300 hover:bg-teal-500/25">Theirs</GhostBtn>
                                        <GhostBtn onClick={(e) => handleMarkResolved(e, filePath)} title="Mark resolved" className="bg-white/[0.04] text-[#a1a1aa] hover:bg-white/[0.08]">Done</GhostBtn>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </Section>
                )}

                {/* ── Staged Changes ── */}
                {staged.length > 0 && (
                    <Section>
                        <SectionHead
                            dot="text-teal-400"
                            label="Staged"
                            count={staged.length}
                            actions={
                                <GhostBtn onClick={handleUnstageAll} title="Unstage All" className="text-[#71717a] hover:text-[#d4d4d8] hover:bg-white/[0.06]">
                                    Unstage all
                                </GhostBtn>
                            }
                        />
                        <ul className="pb-1">
                            {staged.map(file => (
                                <li
                                    key={`staged-${file.path}`}
                                    className="flex items-center justify-between px-3 py-1 hover:bg-white/[0.02] cursor-pointer group transition-colors border-l-2 border-l-teal-500/60 ml-2"
                                    onClick={() => handleFileClick(file)}
                                >
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        <span className="text-[10px] font-mono font-bold text-teal-400/80 w-3 text-center">{file.index}</span>
                                        <span className="truncate text-[11px] text-[#d4d4d8]" title={file.path}>{file.path}</span>
                                    </div>
                                    <button
                                        onClick={(e) => handleUnstage(e, file.path)}
                                        className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-[#71717a] hover:text-amber-400 hover:bg-amber-500/10 transition-all"
                                        title="Unstage"
                                    >
                                        <Minus className="w-3 h-3" strokeWidth={1.5} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </Section>
                )}

                {/* ── Unstaged Changes ── */}
                {changes.length > 0 && (
                    <Section>
                        <SectionHead
                            dot="text-amber-400"
                            label="Changes"
                            count={changes.length}
                            actions={
                                <div className="flex gap-1">
                                    <GhostBtn onClick={handleDiscardAll} title="Discard All" className="text-[#71717a] hover:text-rose-400 hover:bg-rose-500/10">
                                        Discard
                                    </GhostBtn>
                                    <GhostBtn onClick={handleStageAll} title="Stage All" className="text-[#71717a] hover:text-teal-400 hover:bg-teal-500/10">
                                        Stage all
                                    </GhostBtn>
                                </div>
                            }
                        />
                        <ul className="pb-1">
                            {changes.map(file => (
                                <li
                                    key={`changes-${file.path}`}
                                    className="flex items-center justify-between px-3 py-1 hover:bg-white/[0.02] cursor-pointer group transition-colors border-l-2 border-l-amber-500/60 ml-2"
                                    onClick={() => handleFileClick(file)}
                                >
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        <span className={`text-[10px] font-mono font-bold w-3 text-center ${file.working_dir === '?' ? 'text-emerald-400/80' : 'text-amber-400/80'}`}>
                                            {file.working_dir === '?' ? 'U' : 'M'}
                                        </span>
                                        <span className="truncate text-[11px] text-[#d4d4d8]" title={file.path}>{file.path}</span>
                                    </div>
                                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                                        <button
                                            onClick={(e) => handleDiscard(e, file.path)}
                                            className="p-1 rounded-md text-[#71717a] hover:text-rose-400 hover:bg-rose-500/10 transition-all"
                                            title="Discard"
                                        >
                                            <Undo2 className="w-3 h-3" strokeWidth={1.5} />
                                        </button>
                                        <button
                                            onClick={(e) => handleStage(e, file.path)}
                                            className="p-1 rounded-md text-[#71717a] hover:text-teal-400 hover:bg-teal-500/10 transition-all"
                                            title="Stage"
                                        >
                                            <Plus className="w-3 h-3" strokeWidth={1.5} />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </Section>
                )}

                {/* No changes */}
                {!hasChanges && !hasConflicts && (
                    <div className="mx-2 mb-2 py-4 text-center text-[11px] text-[#52525b]">
                        Working tree clean
                    </div>
                )}

                {/* ── Remotes ── */}
                <Section>
                    <SectionHead
                        dot="text-blue-400"
                        label="Remotes"
                        count={remotes?.length}
                        actions={
                            <IconBtn onClick={() => setShowAddRemote(!showAddRemote)} title="Add Remote" className="text-[#71717a] hover:text-blue-400 hover:bg-blue-500/10">
                                <Plus className="w-3 h-3" strokeWidth={1.5} />
                            </IconBtn>
                        }
                    />
                    {showAddRemote && (
                        <div className="mx-3 mb-2 p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.04]">
                            <input
                                className="w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-[11px] text-[#d4d4d8] mb-2 focus:outline-none focus:border-violet-500/50 placeholder:text-[#3f3f46] transition-colors"
                                placeholder="Remote Name (e.g. origin)"
                                value={newRemoteName}
                                onChange={(e) => setNewRemoteName(e.target.value)}
                            />
                            <input
                                className="w-full bg-white/[0.03] border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-[11px] text-[#d4d4d8] mb-2 focus:outline-none focus:border-violet-500/50 placeholder:text-[#3f3f46] transition-colors"
                                placeholder="Remote URL"
                                value={newRemoteUrl}
                                onChange={(e) => setNewRemoteUrl(e.target.value)}
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={handleAddRemote}
                                    disabled={loading}
                                    className="flex-1 py-1.5 rounded-lg text-[10px] font-medium bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 disabled:opacity-40 transition-colors flex items-center justify-center gap-1"
                                >
                                    {loading ? <RefreshCw className="w-3 h-3 animate-spin" strokeWidth={1.5} /> : 'Add'}
                                </button>
                                <button
                                    onClick={() => setShowAddRemote(false)}
                                    className="flex-1 py-1.5 rounded-lg text-[10px] font-medium bg-white/[0.04] text-[#71717a] hover:bg-white/[0.07] transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                    {remotes && remotes.length > 0 ? (
                        <ul className="pb-1">
                            {remotes.map(remote => (
                                <li key={remote.name} className="flex items-center gap-2 px-3 py-1 text-[#a1a1aa] hover:bg-white/[0.02] group transition-colors">
                                    <Globe className="w-3 h-3 text-blue-400/60 flex-shrink-0" strokeWidth={1.5} />
                                    <span className="text-[11px] font-medium text-[#d4d4d8]">{remote.name}</span>
                                    <span className="text-[10px] text-[#3f3f46] truncate flex-1 text-right font-mono" title={remote.refs.push}>{remote.refs.push}</span>
                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                        {remote.refs && remote.refs.push && remote.refs.push.startsWith('https') && (
                                            <a
                                                href={remote.refs.push.replace(/\.git$/, '')}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="text-[10px] text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded-full hover:bg-blue-500/10 transition-all"
                                            >
                                                Open
                                            </a>
                                        )}
                                        <button
                                            onClick={() => handleRemoveRemoteClick(remote.name)}
                                            className="p-1 rounded-md text-[#52525b] hover:text-rose-400 hover:bg-rose-500/10 transition-all"
                                            title="Remove Remote"
                                        >
                                            <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-[11px] text-[#3f3f46] px-3 pb-2">No remotes</div>
                    )}
                </Section>

                {/* ── Unpushed Commits ── */}
                <Section>
                    <SectionHead
                        dot="text-violet-400"
                        label="Outgoing"
                        count={unpushedCommits?.length}
                        actions={unpushedCommits && unpushedCommits.length > 0 && (
                            <GhostBtn onClick={handlePush} className="text-violet-400 bg-violet-500/10 hover:bg-violet-500/20">
                                Push
                            </GhostBtn>
                        )}
                    />
                    {unpushedCommits && unpushedCommits.length > 0 ? (
                        <ul className="pb-1">
                            {unpushedCommits.map(c => (
                                <li key={c.hash} className="flex items-center gap-2 px-3 py-1 hover:bg-white/[0.02] transition-colors group">
                                    <span className="font-mono text-[10px] text-violet-400/60">{c.hash.substring(0,7)}</span>
                                    <span className="truncate text-[11px] text-[#d4d4d8] flex-1">{c.message}</span>
                                    <span className="text-[10px] text-[#3f3f46] hidden group-hover:block">{c.author_name}</span>
                                    <button onClick={() => navigator.clipboard.writeText(c.hash)} title="Copy hash" className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-[#52525b] hover:text-[#d4d4d8] hover:bg-white/[0.06] transition-all">
                                        <Copy className="w-3 h-3" strokeWidth={1.5} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-[11px] text-[#3f3f46] px-3 pb-2">All pushed</div>
                    )}
                </Section>

                {/* ── Incoming Commits ── */}
                <Section>
                    <SectionHead
                        dot="text-emerald-400"
                        label="Incoming"
                        count={incomingCommits?.length}
                        actions={incomingCommits && incomingCommits.length > 0 && (
                            <GhostBtn onClick={handlePull} className="text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20">
                                Pull
                            </GhostBtn>
                        )}
                    />
                    {incomingCommits && incomingCommits.length > 0 ? (
                        <ul className="pb-1">
                            {incomingCommits.map(c => (
                                <li key={c.hash} className="flex items-center gap-2 px-3 py-1 hover:bg-white/[0.02] transition-colors border-l-2 border-l-emerald-500/40 ml-2 group">
                                    <span className="font-mono text-[10px] text-emerald-400/60">{c.hash.substring(0,7)}</span>
                                    <span className="truncate text-[11px] text-[#d4d4d8] flex-1">{c.message}</span>
                                    <span className="text-[10px] text-[#3f3f46] hidden group-hover:block">{c.author_name}</span>
                                    <button onClick={() => navigator.clipboard.writeText(c.hash)} title="Copy hash" className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-[#52525b] hover:text-[#d4d4d8] hover:bg-white/[0.06] transition-all">
                                        <Copy className="w-3 h-3" strokeWidth={1.5} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-[11px] text-[#3f3f46] px-3 pb-2">Up to date</div>
                    )}
                </Section>

                {/* ── Stash ── */}
                <Section>
                    <SectionHead
                        dot="text-purple-400"
                        label="Stash"
                        count={stashList?.length}
                        actions={
                            <IconBtn onClick={() => setShowStash(!showStash)} title={showStash ? 'Hide stash' : 'Show stash'} className={`text-[#71717a] hover:text-purple-400 hover:bg-purple-500/10 ${showStash ? 'bg-purple-500/10 text-purple-400' : ''}`}>
                                <Archive className="w-3 h-3" strokeWidth={1.5} />
                            </IconBtn>
                        }
                    />
                    {showStash && (
                        <div className="px-3 pb-2 space-y-2">
                            {hasChanges && (
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={stashMessage}
                                        onChange={(e) => setStashMessage(e.target.value)}
                                        placeholder="Stash message..."
                                        className="flex-1 bg-white/[0.03] border border-white/[0.06] rounded-lg px-2.5 py-1.5 text-[11px] text-[#d4d4d8] focus:outline-none focus:border-purple-500/50 placeholder:text-[#3f3f46] transition-colors"
                                    />
                                    <button
                                        onClick={handleStashPush}
                                        disabled={!hasChanges}
                                        className="px-3 py-1 rounded-lg text-[10px] font-medium bg-purple-500/15 text-purple-300 hover:bg-purple-500/25 disabled:opacity-40 transition-colors"
                                    >
                                        Stash
                                    </button>
                                </div>
                            )}
                            {stashList && stashList.length > 0 ? (
                                <ul className="space-y-0.5">
                                    {stashList.map((s, idx) => (
                                        <li key={s.hash || idx} className="flex items-center gap-2 py-1 hover:bg-white/[0.02] rounded-md px-1 group transition-colors">
                                            <span className="font-mono text-[10px] text-purple-400/50">@{idx}</span>
                                            <span className="truncate text-[11px] text-[#d4d4d8] flex-1">{s.message || 'WIP'}</span>
                                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                                                <button
                                                    onClick={() => handleStashPop(idx)}
                                                    className="p-1 rounded-md text-[#71717a] hover:text-purple-300 hover:bg-purple-500/10 transition-all"
                                                    title="Pop"
                                                >
                                                    <ArchiveRestore className="w-3 h-3" strokeWidth={1.5} />
                                                </button>
                                                <button
                                                    onClick={() => handleStashDrop(idx)}
                                                    className="p-1 rounded-md text-[#71717a] hover:text-rose-400 hover:bg-rose-500/10 transition-all"
                                                    title="Drop"
                                                >
                                                    <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                                                </button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <div className="text-[11px] text-[#3f3f46]">No stashes</div>
                            )}
                        </div>
                    )}
                </Section>

                {/* ── Commit History ── */}
                <Section>
                    <SectionHead
                        dot="text-zinc-400"
                        label="History"
                        count={commitHistory?.all?.length}
                        actions={
                            <IconBtn onClick={() => dispatch(fetchCommitHistory({ slug }))} title="Refresh" className="text-[#71717a] hover:text-[#d4d4d8] hover:bg-white/[0.06]">
                                <RefreshCw className="w-3 h-3" strokeWidth={1.5} />
                            </IconBtn>
                        }
                    />
                    {commitHistory && commitHistory.all && commitHistory.all.length > 0 ? (
                        <ul className="pb-1">
                            {(showAllCommits ? commitHistory.all : commitHistory.all.slice(0, 20)).map(c => (
                                <li key={c.hash} className="flex items-start gap-2 px-3 py-1.5 hover:bg-white/[0.02] transition-colors group">
                                    <span className="font-mono text-[10px] text-[#52525b] mt-px">{c.hash.substring(0,7)}</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[11px] text-[#d4d4d8] truncate">{c.message}</div>
                                        <div className="text-[10px] text-[#3f3f46]">{c.author_name} · {c.date}</div>
                                    </div>
                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                        <button onClick={() => navigator.clipboard.writeText(c.hash)} title="Copy hash" className="p-1 rounded-md text-[#52525b] hover:text-[#d4d4d8] hover:bg-white/[0.06] transition-all">
                                            <Copy className="w-3 h-3" strokeWidth={1.5} />
                                        </button>
                                        {remotes && remotes.length > 0 && remotes[0].refs && remotes[0].refs.push && (
                                            <a className="text-[10px] text-blue-400/60 hover:text-blue-400 px-1" target="_blank" rel="noreferrer" href={`${remotes[0].refs.push.replace(/\.git$/, '')}/commit/${c.hash}`}>View</a>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-[11px] text-[#3f3f46] px-3 pb-2">No history</div>
                    )}
                    {commitHistory && commitHistory.all && commitHistory.all.length > 20 && (
                        <div className="pb-2 flex justify-center">
                            <button onClick={() => setShowAllCommits(v => !v)} className="text-[10px] text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 px-3 py-0.5 rounded-full transition-colors font-medium">
                                {showAllCommits ? 'Collapse' : `Show all ${commitHistory.all.length}`}
                            </button>
                        </div>
                    )}
                </Section>
            </div>

            {/* ── Commit input — pinned bottom ── */}
            {hasChanges && (
                <div className="flex-shrink-0 p-2 border-t border-white/[0.04] min-w-0">
                    <div className="flex gap-1 items-center min-w-0">
                        <input
                            type="text"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="Commit message…"
                            className="flex-1 min-w-0 bg-white/[0.03] border border-white/[0.06] rounded-lg px-2 py-1.5 text-[11px] text-[#d4d4d8] focus:outline-none focus:border-violet-500/50 placeholder:text-[#3f3f46] transition-colors"
                            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleCommit()}
                        />
                        <button
                            type="button"
                            onClick={() => setShowCommitBody(!showCommitBody)}
                            className={`flex-shrink-0 p-1.5 rounded-lg text-xs transition-all ${showCommitBody ? 'bg-violet-500/15 text-violet-300' : 'text-[#52525b] hover:text-[#d4d4d8] hover:bg-white/[0.06]'}`}
                            title="Add description"
                        >
                            <Edit3 className="w-3.5 h-3.5" strokeWidth={1.5} />
                        </button>
                        <button
                            type="button"
                            onClick={handleCommit}
                            disabled={!message || staged.length === 0}
                            className="flex-shrink-0 p-1.5 rounded-lg bg-violet-500/20 hover:bg-violet-500/30 text-violet-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            title="Commit"
                        >
                            <Check className="w-3.5 h-3.5" strokeWidth={2} />
                        </button>
                    </div>
                    {showCommitBody && (
                        <textarea
                            value={commitBody}
                            onChange={(e) => setCommitBody(e.target.value)}
                            placeholder="Extended description…"
                            className="w-full mt-1.5 bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-1.5 text-[11px] text-[#d4d4d8] focus:outline-none focus:border-violet-500/50 placeholder:text-[#3f3f46] resize-none transition-colors"
                            rows={3}
                        />
                    )}
                </div>
            )}
        </div>
    );
}
