import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchGitStatus, fetchRemote, commitChanges, pushChanges, pullChanges, stageFile, unstageFile, discardChange, initRepo, cloneRepo, addRemote, removeRemote, fetchRemotes } from '@/redux/gitSlice';
import { refreshWorkspaceThunk, openDiffThunk, fetchFilesThunk } from '@/redux/workspaceSlice';
import { RefreshCw, Check, UploadCloud, Plus, Minus, DownloadCloud, Undo2, Globe, Trash2 } from 'lucide-react';
import { getFileLanguage } from '@/utils/fileUtils';

export function GitStatus({ slug }) {
    const dispatch = useDispatch();
    const { status, loading, error, remotes } = useSelector(state => state.git);
    const [message, setMessage] = useState('');
    const [showAddRemote, setShowAddRemote] = useState(false);
    const [newRemoteName, setNewRemoteName] = useState('origin');
    const [newRemoteUrl, setNewRemoteUrl] = useState('');

    useEffect(() => {
        if (slug) {
            // Initial fetch
            dispatch(fetchGitStatus(slug));
            dispatch(fetchRemotes(slug));
            
            // Poll every 5 seconds
            const interval = setInterval(() => {
                dispatch(fetchGitStatus(slug));
            }, 5000); 
            return () => clearInterval(interval);
        }
    }, [slug, dispatch]);

    const handleSync = () => {
        if (slug) {
            dispatch(fetchRemote(slug));
            dispatch(fetchRemotes(slug));
        }
    };

    const handleAddRemote = async () => {
        if (slug && newRemoteName && newRemoteUrl) {
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

    const handleCommit = async () => {
        if (slug && message) {
            const resultAction = await dispatch(commitChanges({ slug, message }));
            if (commitChanges.fulfilled.match(resultAction)) {
                // dispatch(pushChanges(slug)); // Don't auto-push
                setMessage('');
            }
        }
    };

    const handleStage = (e, filePath) => {
        e.stopPropagation();
        dispatch(stageFile({ slug, filePath }));
    };

    const handleUnstage = (e, filePath) => {
        e.stopPropagation();
        dispatch(unstageFile({ slug, filePath }));
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

    const handleFileClick = (fileStatus) => {
        const file = {
            name: fileStatus.path.split('/').pop(),
            path: fileStatus.path,
            originalPath: fileStatus.from || fileStatus.path, // Handle renames
            language: getFileLanguage(fileStatus.path)
        };
        dispatch(openDiffThunk(file));
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
                <div className="mb-2 text-sm text-gray-300">Git not initialized for this workspace.</div>
                <div className="flex gap-2">
                    <button
                        onClick={handleInit}
                        className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded text-sm"
                    >
                        Initialize Git
                    </button>
                    <button
                        onClick={() => setShowClone(v => !v)}
                        className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm"
                    >
                        Clone from Git
                    </button>
                </div>
                {showClone && (
                    <div className="mt-2 w-full">
                        <input
                            className="w-full bg-[#1e1e1e] border border-gray-700 rounded px-2 py-1 text-xs text-gray-300"
                            placeholder="https://github.com/owner/repo.git"
                            value={cloneUrl}
                            onChange={(e) => setCloneUrl(e.target.value)}
                        />
                        <div className="flex gap-2 mt-2">
                            <button
                                onClick={handleCloneRepo}
                                className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm"
                            >
                                Clone
                            </button>
                            <button
                                onClick={() => setShowClone(false)}
                                className="bg-gray-700 hover:bg-gray-800 text-white px-3 py-1 rounded text-sm"
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

    // Note: A file can be both staged and modified (appear in both lists)

    const hasChanges = staged.length > 0 || changes.length > 0;

    return (
        <div className="flex flex-col h-full">
            <div className="p-2 font-semibold text-xs uppercase tracking-wider text-gray-500 border-b border-gray-800 flex justify-between items-center">
                <span>Source Control</span>
                <div className="flex gap-1">
                    <button onClick={handlePull} className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white transition-colors" title="Pull from Remote">
                        <DownloadCloud className="w-3 h-3" />
                    </button>
                    <button onClick={handlePush} className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white transition-colors" title="Push to Remote">
                        <UploadCloud className="w-3 h-3" />
                    </button>
                    <button onClick={handleSync} className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white transition-colors" title="Fetch Remote">
                        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
                {error && (
                    <div className="mb-2 p-2 bg-red-900/50 border border-red-800 rounded text-xs text-red-200 break-words">
                        {error}
                        {(error.includes('No configured push destination') || error.includes('No remote configured')) && (
                            <div className="mt-2">
                                <button 
                                    onClick={() => setShowAddRemote(true)}
                                    className="bg-red-700 hover:bg-red-600 text-white px-2 py-1 rounded text-xs w-full"
                                >
                                    Configure Remote
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Remotes Section */}
                <div className="mb-4">
                    <div className="flex justify-between items-center mb-1 px-1">
                        <div className="text-xs font-semibold text-gray-400">REMOTES</div>
                        <button 
                            onClick={() => setShowAddRemote(!showAddRemote)}
                            className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white"
                            title="Add Remote"
                        >
                            <Plus className="w-3 h-3" />
                        </button>
                    </div>
                    
                    {showAddRemote && (
                        <div className="mb-2 p-2 bg-[#1e1e1e] border border-gray-700 rounded">
                            <input
                                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-300 mb-2"
                                placeholder="Remote Name (e.g. origin)"
                                value={newRemoteName}
                                onChange={(e) => setNewRemoteName(e.target.value)}
                            />
                            <input
                                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-xs text-gray-300 mb-2"
                                placeholder="Remote URL"
                                value={newRemoteUrl}
                                onChange={(e) => setNewRemoteUrl(e.target.value)}
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={handleAddRemote}
                                    disabled={loading}
                                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-2 py-1 rounded text-xs flex-1 flex justify-center items-center gap-1"
                                >
                                    {loading ? <RefreshCw className="w-3 h-3 animate-spin" /> : 'Add'}
                                </button>
                                <button
                                    onClick={() => setShowAddRemote(false)}
                                    className="bg-gray-700 hover:bg-gray-600 text-white px-2 py-1 rounded text-xs flex-1"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}

                    {remotes && remotes.length > 0 ? (
                        <ul className="text-sm space-y-1">
                            {remotes.map(remote => (
                                <li key={remote.name} className="flex items-center gap-2 px-1 py-0.5 text-gray-400 hover:text-gray-300 group">
                                    <Globe className="w-3 h-3" />
                                    <span className="text-xs">{remote.name}</span>
                                    <span className="text-xs text-gray-600 truncate flex-1 text-right" title={remote.refs.push}>{remote.refs.push}</span>
                                    <button 
                                        onClick={() => handleRemoveRemote(remote.name)}
                                        className="opacity-0 group-hover:opacity-100 hover:bg-red-900/50 p-1 rounded text-gray-500 hover:text-red-400 transition-all"
                                        title="Remove Remote"
                                    >
                                        <Trash2 className="w-3 h-3" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-xs text-gray-600 px-1 italic">No remotes configured</div>
                    )}
                </div>

                {!hasChanges ? (
                    <p className="text-sm text-gray-500 italic text-center mt-4">No changes detected.</p>
                ) : (
                    <div className="space-y-4">
                        {/* Staged Changes */}
                        {staged.length > 0 && (
                            <div>
                                <div className="text-xs font-semibold text-gray-400 mb-1 px-1">STAGED CHANGES</div>
                                <ul className="text-sm space-y-1">
                                    {staged.map(file => (
                                        <li 
                                            key={`staged-${file.path}`} 
                                            className="flex items-center justify-between hover:bg-gray-800 p-1 rounded group cursor-pointer"
                                            onClick={() => handleFileClick(file)}
                                        >
                                            <div className="flex items-center gap-2 overflow-hidden">
                                                <span className="w-4 text-center font-mono text-xs text-green-500">
                                                    {file.index}
                                                </span>
                                                <span className="truncate text-gray-300" title={file.path}>{file.path}</span>
                                            </div>
                                            <button 
                                                onClick={(e) => handleUnstage(e, file.path)}
                                                className="opacity-0 group-hover:opacity-100 hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white transition-all"
                                                title="Unstage Changes"
                                            >
                                                <Minus className="w-3 h-3" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Changes */}
                        {changes.length > 0 && (
                            <div>
                                <div className="text-xs font-semibold text-gray-400 mb-1 px-1">CHANGES</div>
                                <ul className="text-sm space-y-1">
                                    {changes.map(file => (
                                        <li 
                                            key={`changes-${file.path}`} 
                                            className="flex items-center justify-between hover:bg-gray-800 p-1 rounded group cursor-pointer"
                                            onClick={() => handleFileClick(file)}
                                        >
                                            <div className="flex items-center gap-2 overflow-hidden">
                                                <span className="w-4 text-center font-mono text-xs text-yellow-500">
                                                    {file.working_dir === '?' ? 'U' : 'M'}
                                                </span>
                                                <span className="truncate text-gray-300" title={file.path}>{file.path}</span>
                                            </div>
                                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                                <button 
                                                    onClick={(e) => handleDiscard(e, file.path)}
                                                    className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white"
                                                    title="Discard Changes"
                                                >
                                                    <Undo2 className="w-3 h-3" />
                                                </button>
                                                <button 
                                                    onClick={(e) => handleStage(e, file.path)}
                                                    className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white"
                                                    title="Stage Changes"
                                                >
                                                    <Plus className="w-3 h-3" />
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
                <div className="p-2 border-t border-gray-800">
                    <div className="flex gap-2">
                        <input 
                            type="text" 
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="Commit message..."
                            className="flex-1 bg-[#1e1e1e] border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                            onKeyDown={(e) => e.key === 'Enter' && handleCommit()}
                        />
                        <button 
                            onClick={handleCommit}
                            disabled={!message || staged.length === 0}
                            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white p-1 rounded"
                            title="Commit Staged"
                        >
                            <Check className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
