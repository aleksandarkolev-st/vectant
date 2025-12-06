import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchGitStatus, fetchRemote, commitChanges, pushChanges, pullChanges, stageFile, unstageFile, discardChange } from '@/redux/gitSlice';
import { refreshWorkspaceThunk } from '@/redux/workspaceSlice';
import { RefreshCw, Check, UploadCloud, Plus, Minus, DownloadCloud, Undo2 } from 'lucide-react';

export function GitStatus({ slug }) {
    const dispatch = useDispatch();
    const { status, loading, error } = useSelector(state => state.git);
    const [message, setMessage] = useState('');

    useEffect(() => {
        if (slug) {
            // Initial fetch
            dispatch(fetchGitStatus(slug));
            
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

    const handleStage = (filePath) => {
        dispatch(stageFile({ slug, filePath }));
    };

    const handleUnstage = (filePath) => {
        dispatch(unstageFile({ slug, filePath }));
    };

    const handleDiscard = async (filePath) => {
        if (confirm(`Are you sure you want to discard changes in ${filePath}?`)) {
            const result = await dispatch(discardChange({ slug, filePath }));
            if (discardChange.fulfilled.match(result)) {
                dispatch(refreshWorkspaceThunk());
            }
        }
    };

    if (!status) return null;

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
                    <div className="mb-2 p-2 bg-red-900/50 border border-red-800 rounded text-xs text-red-200">
                        {error}
                    </div>
                )}
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
                                        <li key={`staged-${file.path}`} className="flex items-center justify-between hover:bg-gray-800 p-1 rounded group">
                                            <div className="flex items-center gap-2 overflow-hidden">
                                                <span className="w-4 text-center font-mono text-xs text-green-500">
                                                    {file.index}
                                                </span>
                                                <span className="truncate text-gray-300" title={file.path}>{file.path}</span>
                                            </div>
                                            <button 
                                                onClick={() => handleUnstage(file.path)}
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
                                        <li key={`changes-${file.path}`} className="flex items-center justify-between hover:bg-gray-800 p-1 rounded group">
                                            <div className="flex items-center gap-2 overflow-hidden">
                                                <span className="w-4 text-center font-mono text-xs text-yellow-500">
                                                    {file.working_dir === '?' ? 'U' : 'M'}
                                                </span>
                                                <span className="truncate text-gray-300" title={file.path}>{file.path}</span>
                                            </div>
                                            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-all">
                                                <button 
                                                    onClick={() => handleDiscard(file.path)}
                                                    className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white"
                                                    title="Discard Changes"
                                                >
                                                    <Undo2 className="w-3 h-3" />
                                                </button>
                                                <button 
                                                    onClick={() => handleStage(file.path)}
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
