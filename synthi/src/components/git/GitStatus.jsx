import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchGitStatus, fetchRemote, commitChanges, pushChanges } from '@/redux/gitSlice';
import { RefreshCw, Check, UploadCloud } from 'lucide-react';

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

    const handlePush = () => {
        if (slug) {
            dispatch(pushChanges(slug));
        }
    };

    const handleCommit = async () => {
        if (slug && message) {
            const resultAction = await dispatch(commitChanges({ slug, message }));
            if (commitChanges.fulfilled.match(resultAction)) {
                dispatch(pushChanges(slug));
                setMessage('');
            }
        }
    };

    if (!status) return null;

    const hasChanges = status.files && status.files.length > 0;

    return (
        <div className="flex flex-col h-full">
            <div className="p-2 font-semibold text-xs uppercase tracking-wider text-gray-500 border-b border-gray-800 flex justify-between items-center">
                <span>Source Control</span>
                <div className="flex gap-1">
                    <button onClick={handleSync} className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white transition-colors" title="Fetch Remote">
                        <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button onClick={handlePush} className="hover:bg-gray-700 p-1 rounded text-gray-400 hover:text-white transition-colors" title="Push to Remote">
                        <UploadCloud className="w-3 h-3" />
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
                    <ul className="text-sm space-y-1">
                        {status.files.map(file => (
                            <li key={file.path} className="flex items-center gap-2 hover:bg-gray-800 p-1 rounded cursor-pointer">
                                <span className={`w-4 text-center font-mono text-xs ${file.index === '?' ? 'text-green-500' : 'text-yellow-500'}`}>
                                    {file.index === '?' ? 'U' : 'M'}
                                </span>
                                <span className="truncate text-gray-300" title={file.path}>{file.path}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            {hasChanges && (
                <div className="p-2 border-t border-gray-800">
                    <div className="flex gap-2">
                        <input 
                            type="text" 
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="Commit & Push message..."
                            className="flex-1 bg-[#1e1e1e] border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-blue-500"
                            onKeyDown={(e) => e.key === 'Enter' && handleCommit()}
                        />
                        <button 
                            onClick={handleCommit}
                            disabled={!message}
                            className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white p-1 rounded"
                            title="Commit"
                        >
                            <Check className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
