import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchGitStatus, fetchRemote, commitChanges, pushChanges, pullChanges, stageFile, unstageFile, discardChange, initRepo, cloneRepo, addRemote, removeRemote, fetchRemotes, fetchCommitHistory, fetchUnpushedCommits, fetchIncomingCommits, fetchStashList, stashPush, stashPop, stashDrop, clearError, stageAll, unstageAll, discardAll, resolveConflictOurs, resolveConflictTheirs, markResolved, abortMerge } from '@/redux/gitSlice';
import { refreshWorkspaceThunk, openDiffThunk, fetchFilesThunk, selectFileThunk } from '@/redux/workspaceSlice';
import { RefreshCw, Check, UploadCloud, Plus, Minus, DownloadCloud, Undo2, Globe, Trash2, Copy, Archive, ArchiveRestore, AlertTriangle, GitMerge, X, Edit3 } from 'lucide-react';
import { getFileLanguage } from '@/utils/fileUtils';

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
            dispatch(fetchRemote(slug));
            dispatch(fetchRemotes(slug));
            dispatch(fetchCommitHistory({ slug }));
            dispatch(fetchUnpushedCommits({ slug, max: 50 }));
            dispatch(fetchIncomingCommits({ slug, max: 50 }));
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
            <div className="p-2 h-full flex flex-col justify-center items-center">
                <div className="mb-1.5 text-xs text-[#a1a1aa]">Git not initialized for this workspace.</div>
                <div className="flex gap-1.5">
                    <button
                        onClick={handleInit}
                        className="border border-[#3f3f46] bg-transparent hover:bg-[#27272a] text-[#e4e4e7] px-2 py-0.5 rounded text-xs transition-colors"
                    >
                        Initialize Git
                    </button>
                    <button
                        onClick={() => setShowClone(v => !v)}
                        className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 text-[#3b82f6] px-2 py-0.5 rounded text-xs transition-colors"
                    >
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
                            <button
                                onClick={handleCloneRepo}
                                className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 text-[#3b82f6] px-2 py-0.5 rounded text-xs transition-colors"
                            >
                                Clone
                            </button>
                            <button
                                onClick={() => setShowClone(false)}
                                className="border border-[#3f3f46] bg-transparent hover:bg-[#27272a] text-[#a1a1aa] px-2 py-0.5 rounded text-xs transition-colors"
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
            <div className="p-2 font-semibold text-xs uppercase tracking-wider text-[#a1a1aa] border-b border-[#27272a] flex justify-between items-center">
                <span>Source Control</span>
                <div className="flex gap-1">
                    <button onClick={handlePull} disabled={loading} className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors disabled:opacity-50" title="Pull from Remote">
                        <DownloadCloud className="w-3 h-3" strokeWidth={1.5} />
                    </button>
                    <button onClick={handlePush} disabled={loading} className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors disabled:opacity-50" title="Push to Remote">
                        <UploadCloud className="w-3 h-3" strokeWidth={1.5} />
                    </button>
                    <button onClick={handleSync} disabled={loading} className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-colors disabled:opacity-50" title="Fetch Remote">
                        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
                    </button>
                </div>
            </div>
            {/* previous position removed */}
            {/* Branch & status badges */}
            <div className="p-2 flex items-center gap-2 text-xs text-[#a1a1aa] border-b border-[#27272a]">
                <div className="text-[#e4e4e7] text-sm font-medium">{status && status.current ? status.current : 'unknown'}</div>
                {status && (status.ahead || status.behind) && (
                    <div className="flex items-center gap-1 text-xs text-[#a1a1aa]">
                        {status.ahead > 0 && <div className="px-2 py-0.5 bg-yellow-600/20 text-yellow-300 rounded">↑ {status.ahead}</div>}
                        {status.behind > 0 && <div className="px-2 py-0.5 bg-[#3b82f6]/20 text-[#60a5fa] rounded">↓ {status.behind}</div>}
                    </div>
                )}
                {status && (!status.ahead && !status.behind) && (
                    <div className="px-2 py-0.5 bg-[#86efac]/10 text-[#86efac] rounded text-xs">Up to date</div>
                )}
            </div>
            <div className="flex-1 overflow-y-auto p-2">
                {error && (
                    <div className="mb-2 p-2 bg-[#f87171]/10 border border-[#f87171]/30 rounded text-xs text-[#f87171] break-words">
                        {error}
                            {(
                                error.includes('No configured push destination') || error.includes('No remote configured') || error.toLowerCase().includes('authentication failed') || error.toLowerCase().includes('repository not found') || error.toLowerCase().includes('remote repository not found')
                            ) && (
                            <div className="mt-2">
                                <button 
                                    onClick={() => setShowAddRemote(true)}
                                    className="border border-[#f87171] bg-transparent hover:bg-[#f87171]/10 text-[#f87171] px-2 py-1 rounded text-xs w-full transition-colors"
                                >
                                    Configure Remote
                                </button>
                            </div>
                        )}
                            {error.toLowerCase().includes('authentication failed') && (
                                <div className="mt-2 text-xs text-[#a1a1aa]">
                                    Authentication failed — the server attempted to push but couldn't authenticate with the remote. You can either add a remote URL with an access token (https://&lt;token&gt;@github.com/owner/repo.git) or configure SSH/credentials for the collab server.
                                </div>
                            )}
                    </div>
                )}

                {/* Merge Conflict Warning Banner */}
                {hasConflicts && (
                    <div className="mb-4 p-3 bg-orange-900/50 border border-orange-700 rounded">
                        <div className="flex items-center gap-2 mb-2">
                            <AlertTriangle className="w-4 h-4 text-orange-400" />
                            <span className="text-sm font-semibold text-orange-300">Merge Conflicts Detected</span>
                        </div>
                        <p className="text-xs text-orange-200 mb-2">
                            {conflictedFiles.length} file{conflictedFiles.length > 1 ? 's' : ''} have conflicts that must be resolved before you can commit.
                        </p>
                        <button
                            onClick={handleAbortMerge}
                            className="bg-orange-700 hover:bg-orange-600 text-white px-3 py-1 rounded text-xs flex items-center gap-1"
                        >
                            <X className="w-3 h-3" />
                            Abort Merge
                        </button>
                    </div>
                )}

                {/* Conflicted Files Section */}
                {hasConflicts && conflictedFiles.length > 0 && (
                    <div className="mb-4">
                        <div className="flex items-center gap-2 mb-2 px-1">
                            <GitMerge className="w-3 h-3 text-orange-400" />
                            <div className="text-xs font-semibold text-orange-400">MERGE CONFLICTS</div>
                        </div>
                        <ul className="text-sm space-y-1">
                            {conflictedFiles.map(filePath => (
                                <li 
                                    key={`conflict-${filePath}`} 
                                    className="flex items-center justify-between bg-orange-900/20 hover:bg-orange-900/30 p-2 rounded group border border-orange-800/50"
                                    onClick={() => handleConflictFileClick(filePath)}
                                >
                                    <div className="flex items-center gap-2 overflow-hidden">
                                        <AlertTriangle className="w-3 h-3 text-orange-400 flex-shrink-0" />
                                        <span className="truncate text-orange-200" title={filePath}>{filePath}</span>
                                    </div>
                                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                        <button 
                                            onClick={(e) => handleResolveOurs(e, filePath)}
                                            className="bg-blue-700 hover:bg-blue-600 px-2 py-0.5 rounded text-xs text-white"
                                            title="Accept current branch (ours)"
                                        >
                                            Ours
                                        </button>
                                        <button 
                                            onClick={(e) => handleResolveTheirs(e, filePath)}
                                            className="bg-green-700 hover:bg-green-600 px-2 py-0.5 rounded text-xs text-white"
                                            title="Accept incoming changes (theirs)"
                                        >
                                            Theirs
                                        </button>
                                        <button 
                                            onClick={(e) => handleMarkResolved(e, filePath)}
                                            className="bg-gray-600 hover:bg-gray-500 px-2 py-0.5 rounded text-xs text-white"
                                            title="Mark as resolved (after manual edit)"
                                        >
                                            Resolved
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Remotes Section */}
                <div className="mb-4">
                    <div className="flex justify-between items-center mb-1 px-1">
                        <div className="text-xs font-semibold text-[#a1a1aa]">REMOTES</div>
                        <button 
                            onClick={() => setShowAddRemote(!showAddRemote)}
                            className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7]"
                            title="Add Remote"
                        >
                            <Plus className="w-3 h-3" strokeWidth={1.5} />
                        </button>
                    </div>
                    
                    {showAddRemote && (
                        <div className="mb-2 p-2 bg-[#18181b] border border-[#3f3f46] rounded">
                            <input
                                className="w-full bg-[#09090b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] mb-2 focus:outline-none focus:border-[#3b82f6]"
                                placeholder="Remote Name (e.g. origin)"
                                value={newRemoteName}
                                onChange={(e) => setNewRemoteName(e.target.value)}
                            />
                            <input
                                className="w-full bg-[#09090b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] mb-2 focus:outline-none focus:border-[#3b82f6]"
                                placeholder="Remote URL"
                                value={newRemoteUrl}
                                onChange={(e) => setNewRemoteUrl(e.target.value)}
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={handleAddRemote}
                                    disabled={loading}
                                    className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 disabled:opacity-50 text-[#3b82f6] px-2 py-1 rounded text-xs flex-1 flex justify-center items-center gap-1 transition-colors"
                                >
                                    {loading ? <RefreshCw className="w-3 h-3 animate-spin" strokeWidth={1.5} /> : 'Add'}
                                </button>
                                <button
                                    onClick={() => setShowAddRemote(false)}
                                    className="border border-[#3f3f46] bg-transparent hover:bg-[#27272a] text-[#a1a1aa] px-2 py-1 rounded text-xs flex-1 transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}

                    {remotes && remotes.length > 0 ? (
                        <ul className="text-sm space-y-1">
                            {remotes.map(remote => (
                                <li key={remote.name} className="flex items-center gap-2 px-1 py-0.5 text-[#a1a1aa] hover:text-[#e4e4e7] group">
                                    <Globe className="w-3 h-3" strokeWidth={1.5} />
                                    <span className="text-xs">{remote.name}</span>
                                    <span className="text-xs text-[#52525b] truncate flex-1 text-right" title={remote.refs.push}>{remote.refs.push}</span>
                                    <div className="flex items-center gap-1">
                                        {remote.refs && remote.refs.push && remote.refs.push.startsWith('https') && (
                                            <a
                                                href={remote.refs.push.replace(/\.git$/, '')}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="opacity-0 group-hover:opacity-100 hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-all text-xs"
                                            >
                                                Open
                                            </a>
                                        )}
                                        <button 
                                        onClick={() => handleRemoveRemoteClick(remote.name)}
                                        className="opacity-0 group-hover:opacity-100 hover:bg-[#f87171]/10 p-1 rounded text-[#a1a1aa] hover:text-[#f87171] transition-all"
                                        title="Remove Remote"
                                    >
                                        <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                                    </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-xs text-[#52525b] px-1 italic">No remotes configured</div>
                    )}
                </div>

                {/* Unpushed commits section */}
                <div className="mb-4">
                    <div className="flex justify-between items-center mb-1 px-1">
                        <div className="text-xs font-semibold text-[#a1a1aa]">UNPUSHED COMMITS</div>
                            {unpushedCommits && unpushedCommits.length > 0 && (
                                <div className="flex items-center gap-2">
                                <div className="text-xs text-[#52525b]">{unpushedCommits.length} commit{unpushedCommits.length > 1 ? 's' : ''}</div>
                                <button onClick={handlePush} className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 text-[#3b82f6] px-2 py-0.5 rounded text-xs transition-colors">Push</button>
                                </div>
                        )}
                    </div>
                    {unpushedCommits && unpushedCommits.length > 0 ? (
                                <ul className="text-sm space-y-1">
                            {unpushedCommits.map(c => (
                                <li key={c.hash} className="p-1 rounded hover:bg-[#27272a] flex items-center gap-2">
                                    <div className="font-mono text-xs text-[#a1a1aa]">{c.hash.substring(0,7)}</div>
                                    <div className="truncate text-[#e4e4e7] text-xs">{c.message}</div>
                                    <div className="text-xs text-[#52525b] ml-auto">{c.author_name} • {c.date}</div>
                                    <button onClick={() => navigator.clipboard.writeText(c.hash)} title="Copy hash" className="ml-2 opacity-80 hover:text-[#e4e4e7] text-[#a1a1aa] p-1 rounded">
                                        <Copy className="w-3 h-3" strokeWidth={1.5} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-xs text-[#52525b] px-1 italic">No unpushed commits</div>
                    )}
                </div>

                {/* Incoming commits section (after fetch, before pull) */}
                <div className="mb-4">
                    <div className="flex justify-between items-center mb-1 px-1">
                        <div className="text-xs font-semibold text-gray-400">INCOMING COMMITS</div>
                            {incomingCommits && incomingCommits.length > 0 && (
                                <div className="flex items-center gap-2">
                                <div className="text-xs text-gray-500">{incomingCommits.length} commit{incomingCommits.length > 1 ? 's' : ''}</div>
                                <button onClick={handlePull} className="bg-green-600 hover:bg-green-700 text-white px-2 py-0.5 rounded text-xs">Pull</button>
                                </div>
                        )}
                    </div>
                    {incomingCommits && incomingCommits.length > 0 ? (
                                <ul className="text-sm space-y-1">
                            {incomingCommits.map(c => (
                                <li key={c.hash} className="p-1 rounded hover:bg-gray-800 flex items-center gap-2 border-l-2 border-green-600 pl-2">
                                    <div className="font-mono text-xs text-green-400">{c.hash.substring(0,7)}</div>
                                    <div className="truncate text-gray-200 text-xs">{c.message}</div>
                                    <div className="text-xs text-gray-500 ml-auto">{c.author_name} • {c.date}</div>
                                    <button onClick={() => navigator.clipboard.writeText(c.hash)} title="Copy hash" className="ml-2 opacity-80 hover:text-white text-gray-400 p-1 rounded">
                                        <Copy className="w-3 h-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-xs text-gray-600 px-1 italic">No incoming commits (fetch to check)</div>
                    )}
                </div>

                {/* Stash Section */}
                <div className="mb-4">
                    <div className="flex justify-between items-center mb-1 px-1">
                        <div className="text-xs font-semibold text-[#a1a1aa]">STASH</div>
                        <button 
                            onClick={() => setShowStash(!showStash)}
                            className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7]"
                            title={showStash ? "Hide stash" : "Show stash"}
                        >
                            <Archive className="w-3 h-3" strokeWidth={1.5} />
                        </button>
                    </div>
                    {showStash && (
                        <div className="space-y-2">
                            {hasChanges && (
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={stashMessage}
                                        onChange={(e) => setStashMessage(e.target.value)}
                                        placeholder="Stash message (optional)..."
                                        className="flex-1 bg-[#18181b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6]"
                                    />
                                    <button 
                                        onClick={handleStashPush}
                                        disabled={!hasChanges}
                                        className="border border-[#c084fc] bg-transparent hover:bg-[#c084fc]/10 disabled:opacity-50 text-[#c084fc] px-2 py-1 rounded text-xs transition-colors"
                                        title="Stash changes"
                                    >
                                        Stash
                                    </button>
                                </div>
                            )}
                            {stashList && stashList.length > 0 ? (
                                <ul className="text-sm space-y-1">
                                    {stashList.map((s, idx) => (
                                        <li key={s.hash || idx} className="p-1 rounded hover:bg-[#27272a] flex items-center gap-2 group">
                                            <div className="font-mono text-xs text-[#a1a1aa]">stash@{`{${idx}}`}</div>
                                            <div className="truncate text-[#e4e4e7] text-xs flex-1">{s.message || 'WIP'}</div>
                                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                                <button 
                                                    onClick={() => handleStashPop(idx)}
                                                    className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7]"
                                                    title="Pop stash"
                                                >
                                                    <ArchiveRestore className="w-3 h-3" strokeWidth={1.5} />
                                                </button>
                                                <button 
                                                    onClick={() => handleStashDrop(idx)}
                                                    className="hover:bg-[#f87171]/10 p-1 rounded text-[#a1a1aa] hover:text-[#f87171]"
                                                    title="Drop stash"
                                                >
                                                    <Trash2 className="w-3 h-3" strokeWidth={1.5} />
                                                </button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <div className="text-xs text-[#52525b] px-1 italic">No stashed changes</div>
                            )}
                        </div>
                    )}
                </div>

                {/* Commit history */}
                <div className="mb-4">
                    <div className="flex justify-between items-center mb-1 px-1">
                        <div className="text-xs font-semibold text-[#a1a1aa]">COMMIT HISTORY</div>
                        <div className="flex gap-2">
                            <button onClick={() => dispatch(fetchCommitHistory({ slug }))} className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] text-xs">Refresh</button>
                        </div>
                    </div>
                    {commitHistory && commitHistory.all && commitHistory.all.length > 0 ? (
                                <ul className="text-sm space-y-1">
                            {(showAllCommits ? commitHistory.all : commitHistory.all.slice(0, 20)).map(c => (
                                <li key={c.hash} className="p-1 rounded hover:bg-[#27272a] flex items-start gap-2">
                                    <div className="font-mono text-xs text-[#a1a1aa]">{c.hash.substring(0,7)}</div>
                                    <div className="flex-1">
                                        <div className="text-xs text-[#e4e4e7] truncate">{c.message}</div>
                                        <div className="text-xs text-[#52525b]">{c.author_name} • {c.date}</div>
                                    </div>
                                    <div className="flex flex-col items-end gap-1">
                                        <button onClick={() => navigator.clipboard.writeText(c.hash)} title="Copy hash" className="ml-2 opacity-80 hover:text-[#e4e4e7] text-[#a1a1aa] p-1 rounded">
                                            <Copy className="w-3 h-3" strokeWidth={1.5} />
                                        </button>
                                        {remotes && remotes.length > 0 && remotes[0].refs && remotes[0].refs.push && (
                                            <a className="text-xs text-[#52525b] hover:text-[#3b82f6]" target="_blank" rel="noreferrer" href={`${remotes[0].refs.push.replace(/\.git$/, '')}/commit/${c.hash}`}>View</a>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-xs text-[#52525b] px-1 italic">No commits yet</div>
                    )}
                    {commitHistory && commitHistory.all && commitHistory.all.length > 20 && (
                        <div className="mt-2 flex justify-center">
                            <button onClick={() => setShowAllCommits(v => !v)} className="text-xs text-[#a1a1aa] hover:text-[#e4e4e7] underline">{showAllCommits ? 'Collapse' : `View all (${commitHistory.all.length})`}</button>
                        </div>
                    )}
                </div>

                {!hasChanges ? (
                    <p className="text-sm text-[#52525b] italic text-center mt-4">No changes detected.</p>
                ) : (
                    <div className="space-y-4">
                        {/* Staged Changes */}
                        {staged.length > 0 && (
                            <div>
                                <div className="flex items-center justify-between mb-1 px-1">
                                    <div className="text-xs font-semibold text-[#a1a1aa]">STAGED CHANGES</div>
                                    <button 
                                        onClick={handleUnstageAll}
                                        className="text-xs text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#27272a] px-2 py-0.5 rounded transition-all"
                                        title="Unstage All"
                                    >
                                        Unstage All
                                    </button>
                                </div>
                                <ul className="text-sm space-y-1">
                                    {staged.map(file => (
                                        <li 
                                            key={`staged-${file.path}`} 
                                            className="flex items-center justify-between hover:bg-[#27272a] p-1 rounded group cursor-pointer"
                                            onClick={() => handleFileClick(file)}
                                        >
                                            <div className="flex items-center gap-2 overflow-hidden">
                                                <span className="w-4 text-center font-mono text-xs text-[#86efac]">
                                                    {file.index}
                                                </span>
                                                <span className="truncate text-[#e4e4e7]" title={file.path}>{file.path}</span>
                                            </div>
                                            <button 
                                                onClick={(e) => handleUnstage(e, file.path)}
                                                className="opacity-0 group-hover:opacity-100 hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7] transition-all"
                                                title="Unstage Changes"
                                            >
                                                <Minus className="w-3 h-3" strokeWidth={1.5} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Changes */}
                        {changes.length > 0 && (
                            <div>
                                <div className="flex items-center justify-between mb-1 px-1">
                                    <div className="text-xs font-semibold text-[#a1a1aa]">CHANGES</div>
                                    <div className="flex gap-1">
                                        <button 
                                            onClick={handleDiscardAll}
                                            className="text-xs text-[#a1a1aa] hover:text-[#f87171] hover:bg-[#27272a] px-2 py-0.5 rounded transition-all"
                                            title="Discard All Changes"
                                        >
                                            Discard All
                                        </button>
                                        <button 
                                            onClick={handleStageAll}
                                            className="text-xs text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#27272a] px-2 py-0.5 rounded transition-all"
                                            title="Stage All Changes"
                                        >
                                            Stage All
                                        </button>
                                    </div>
                                </div>
                                <ul className="text-sm space-y-1">
                                    {changes.map(file => (
                                        <li 
                                            key={`changes-${file.path}`} 
                                            className="flex items-center justify-between hover:bg-[#27272a] p-1 rounded group cursor-pointer"
                                            onClick={() => handleFileClick(file)}
                                        >
                                            <div className="flex items-center gap-2 overflow-hidden">
                                                <span className="w-4 text-center font-mono text-xs text-yellow-500">
                                                    {file.working_dir === '?' ? 'U' : 'M'}
                                                </span>
                                                <span className="truncate text-[#e4e4e7]" title={file.path}>{file.path}</span>
                                            </div>
                                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                                <button 
                                                    onClick={(e) => handleDiscard(e, file.path)}
                                                    className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7]"
                                                    title="Discard Changes"
                                                >
                                                    <Undo2 className="w-3 h-3" strokeWidth={1.5} />
                                                </button>
                                                <button 
                                                    onClick={(e) => handleStage(e, file.path)}
                                                    className="hover:bg-[#27272a] p-1 rounded text-[#a1a1aa] hover:text-[#e4e4e7]"
                                                    title="Stage Changes"
                                                >
                                                    <Plus className="w-3 h-3" strokeWidth={1.5} />
                                                </button>
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                )}
            </div>
            {hasChanges && (
                <div className="p-2 border-t border-[#27272a]">
                    <div className="space-y-2">
                        <div className="flex gap-2">
                            <input 
                                type="text" 
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                placeholder="Commit message title..."
                                className="flex-1 bg-[#18181b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6]"
                                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleCommit()}
                            />
                            <button 
                                onClick={() => setShowCommitBody(!showCommitBody)}
                                className={`p-1 rounded text-xs ${showCommitBody ? 'bg-[#27272a] text-[#e4e4e7]' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#27272a]'}`}
                                title="Add description"
                            >
                                ⋮
                            </button>
                            <button 
                                onClick={handleCommit}
                                disabled={!message || staged.length === 0}
                                className="border border-[#3b82f6] bg-transparent hover:bg-[#3b82f6]/10 disabled:opacity-50 disabled:cursor-not-allowed text-[#3b82f6] p-1 rounded transition-colors"
                                title="Commit Staged"
                            >
                                <Check className="w-4 h-4" strokeWidth={1.5} />
                            </button>
                        </div>
                        {showCommitBody && (
                            <textarea
                                value={commitBody}
                                onChange={(e) => setCommitBody(e.target.value)}
                                placeholder="Extended description (optional)..."
                                className="w-full bg-[#18181b] border border-[#3f3f46] rounded px-2 py-1 text-xs text-[#e4e4e7] focus:outline-none focus:border-[#3b82f6] resize-none"
                                rows={3}
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
