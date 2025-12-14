'use client';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useDispatch } from 'react-redux';
import { Check, X, GitMerge, ChevronDown, ChevronUp } from 'lucide-react';
import { markResolved } from '@/redux/gitSlice';
import { refreshWorkspaceThunk } from '@/redux/workspaceSlice';
import { gitClient } from '@/services/gitClient';

/**
 * Parse conflict markers from file content
 * Returns array of conflict blocks with ours/theirs content and line positions
 */
function parseConflicts(content) {
    if (!content) return { conflicts: [], cleanContent: content };
    
    const lines = content.split('\n');
    const conflicts = [];
    let currentConflict = null;
    let conflictId = 0;
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.startsWith('<<<<<<< ')) {
            currentConflict = {
                id: conflictId++,
                startLine: i,
                oursLabel: line.substring(8).trim() || 'Current Change',
                oursLines: [],
                theirsLines: [],
                theirsLabel: '',
                endLine: -1,
                inTheirs: false,
            };
        } else if (line === '=======' && currentConflict) {
            currentConflict.inTheirs = true;
        } else if (line.startsWith('>>>>>>> ') && currentConflict) {
            currentConflict.theirsLabel = line.substring(8).trim() || 'Incoming Change';
            currentConflict.endLine = i;
            conflicts.push(currentConflict);
            currentConflict = null;
        } else if (currentConflict) {
            if (currentConflict.inTheirs) {
                currentConflict.theirsLines.push(line);
            } else {
                currentConflict.oursLines.push(line);
            }
        }
    }
    
    return { conflicts, lines };
}

/**
 * Resolve a single conflict by replacing marker block with chosen content
 */
function resolveConflict(content, conflict, resolution) {
    const lines = content.split('\n');
    let replacementLines = [];
    
    switch (resolution) {
        case 'ours':
            replacementLines = conflict.oursLines;
            break;
        case 'theirs':
            replacementLines = conflict.theirsLines;
            break;
        case 'both':
            replacementLines = [...conflict.oursLines, ...conflict.theirsLines];
            break;
        default:
            return content;
    }
    
    // Replace lines from startLine to endLine with replacementLines
    const newLines = [
        ...lines.slice(0, conflict.startLine),
        ...replacementLines,
        ...lines.slice(conflict.endLine + 1)
    ];
    
    return newLines.join('\n');
}

/**
 * Single conflict block component with resolution buttons
 */
function ConflictBlock({ conflict, onResolve, expanded, onToggleExpand }) {
    return (
        <div className="border border-orange-700/50 rounded-lg overflow-hidden my-2 bg-[#1a1a2e]">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 bg-orange-900/30 border-b border-orange-700/50">
                <div className="flex items-center gap-2">
                    <GitMerge className="w-4 h-4 text-orange-400" />
                    <span className="text-sm font-medium text-orange-300">Merge Conflict</span>
                    <span className="text-xs text-gray-500">Line {conflict.startLine + 1}</span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => onResolve('ours')}
                        className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center gap-1"
                        title="Accept Current Change (Ours)"
                    >
                        Accept Current
                    </button>
                    <button
                        onClick={() => onResolve('theirs')}
                        className="px-2 py-1 text-xs bg-green-600 hover:bg-green-500 text-white rounded flex items-center gap-1"
                        title="Accept Incoming Change (Theirs)"
                    >
                        Accept Incoming
                    </button>
                    <button
                        onClick={() => onResolve('both')}
                        className="px-2 py-1 text-xs bg-purple-600 hover:bg-purple-500 text-white rounded flex items-center gap-1"
                        title="Accept Both Changes"
                    >
                        Accept Both
                    </button>
                    <button
                        onClick={onToggleExpand}
                        className="p-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                    >
                        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                </div>
            </div>
            
            {expanded && (
                <div className="grid grid-cols-2 divide-x divide-gray-700">
                    {/* Ours (Current) */}
                    <div className="bg-blue-900/10">
                        <div className="px-3 py-1 bg-blue-900/30 text-xs text-blue-300 border-b border-blue-800/50">
                            Current Change: <span className="font-mono">{conflict.oursLabel}</span>
                        </div>
                        <pre className="p-3 text-sm font-mono text-gray-300 overflow-x-auto max-h-48 overflow-y-auto">
                            {conflict.oursLines.length > 0 
                                ? conflict.oursLines.map((line, i) => (
                                    <div key={i} className="flex">
                                        <span className="w-8 text-gray-600 select-none text-right pr-2">{i + 1}</span>
                                        <span className="text-blue-200">{line || ' '}</span>
                                    </div>
                                ))
                                : <span className="text-gray-500 italic">(empty)</span>
                            }
                        </pre>
                    </div>
                    
                    {/* Theirs (Incoming) */}
                    <div className="bg-green-900/10">
                        <div className="px-3 py-1 bg-green-900/30 text-xs text-green-300 border-b border-green-800/50">
                            Incoming Change: <span className="font-mono">{conflict.theirsLabel}</span>
                        </div>
                        <pre className="p-3 text-sm font-mono text-gray-300 overflow-x-auto max-h-48 overflow-y-auto">
                            {conflict.theirsLines.length > 0
                                ? conflict.theirsLines.map((line, i) => (
                                    <div key={i} className="flex">
                                        <span className="w-8 text-gray-600 select-none text-right pr-2">{i + 1}</span>
                                        <span className="text-green-200">{line || ' '}</span>
                                    </div>
                                ))
                                : <span className="text-gray-500 italic">(empty)</span>
                            }
                        </pre>
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * Main Merge Conflict Editor component
 * Shows file content with inline conflict resolution like GitHub
 */
export function MergeConflictEditor({ slug, filePath, onClose, onResolved }) {
    const dispatch = useDispatch();
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [expandedConflicts, setExpandedConflicts] = useState({});
    
    // Load file content
    useEffect(() => {
        async function loadContent() {
            try {
                setLoading(true);
                setError(null);
                // Read the current working copy (with conflict markers)
                const result = await gitClient.request(slug, 'file', { path: filePath });
                setContent(result.content || '');
                // Expand all conflicts by default
                const { conflicts } = parseConflicts(result.content || '');
                const expanded = {};
                conflicts.forEach(c => { expanded[c.id] = true; });
                setExpandedConflicts(expanded);
            } catch (e) {
                setError(e.message || 'Failed to load file');
            } finally {
                setLoading(false);
            }
        }
        if (slug && filePath) {
            loadContent();
        }
    }, [slug, filePath]);
    
    const { conflicts, lines } = useMemo(() => parseConflicts(content), [content]);
    
    const handleResolveConflict = useCallback((conflictId, resolution) => {
        const conflict = conflicts.find(c => c.id === conflictId);
        if (!conflict) return;
        
        const newContent = resolveConflict(content, conflict, resolution);
        setContent(newContent);
    }, [content, conflicts]);
    
    const toggleConflictExpand = useCallback((conflictId) => {
        setExpandedConflicts(prev => ({
            ...prev,
            [conflictId]: !prev[conflictId]
        }));
    }, []);
    
    const remainingConflicts = useMemo(() => parseConflicts(content).conflicts.length, [content]);
    
    const handleSaveAndMarkResolved = async () => {
        if (remainingConflicts > 0) {
            alert(`Please resolve all ${remainingConflicts} remaining conflict(s) first.`);
            return;
        }
        
        try {
            setSaving(true);
            // Save the resolved content
            await gitClient.syncFile(slug, filePath, content);
            // Mark as resolved (stages the file)
            await dispatch(markResolved({ slug, filePath }));
            dispatch(refreshWorkspaceThunk());
            onResolved?.();
            onClose?.();
        } catch (e) {
            setError(e.message || 'Failed to save');
        } finally {
            setSaving(false);
        }
    };
    
    // Render content with embedded conflict blocks
    const renderContentWithConflicts = () => {
        if (!content) return null;
        
        const { conflicts: currentConflicts } = parseConflicts(content);
        if (currentConflicts.length === 0) {
            // No conflicts - show plain content
            return (
                <pre className="p-4 text-sm font-mono text-gray-300 overflow-auto flex-1 bg-[#0d1117]">
                    {content.split('\n').map((line, i) => (
                        <div key={i} className="flex hover:bg-gray-800/30">
                            <span className="w-12 text-gray-600 select-none text-right pr-3 border-r border-gray-800">{i + 1}</span>
                            <span className="pl-3">{line || ' '}</span>
                        </div>
                    ))}
                </pre>
            );
        }
        
        // Build segments: normal lines and conflict blocks
        const segments = [];
        let lastEnd = 0;
        
        currentConflicts.forEach((conflict, idx) => {
            // Lines before this conflict
            if (conflict.startLine > lastEnd) {
                const normalLines = content.split('\n').slice(lastEnd, conflict.startLine);
                segments.push({
                    type: 'normal',
                    lines: normalLines,
                    startLine: lastEnd
                });
            }
            
            // The conflict block
            segments.push({
                type: 'conflict',
                conflict,
                idx
            });
            
            lastEnd = conflict.endLine + 1;
        });
        
        // Lines after last conflict
        const allLines = content.split('\n');
        if (lastEnd < allLines.length) {
            segments.push({
                type: 'normal',
                lines: allLines.slice(lastEnd),
                startLine: lastEnd
            });
        }
        
        return (
            <div className="flex-1 overflow-auto bg-[#0d1117]">
                {segments.map((segment, i) => {
                    if (segment.type === 'normal') {
                        return (
                            <pre key={i} className="text-sm font-mono text-gray-300">
                                {segment.lines.map((line, j) => (
                                    <div key={j} className="flex hover:bg-gray-800/30 px-4">
                                        <span className="w-12 text-gray-600 select-none text-right pr-3 border-r border-gray-800">
                                            {segment.startLine + j + 1}
                                        </span>
                                        <span className="pl-3">{line || ' '}</span>
                                    </div>
                                ))}
                            </pre>
                        );
                    } else {
                        return (
                            <div key={i} className="px-4">
                                <ConflictBlock
                                    conflict={segment.conflict}
                                    onResolve={(resolution) => handleResolveConflict(segment.conflict.id, resolution)}
                                    expanded={expandedConflicts[segment.conflict.id] ?? true}
                                    onToggleExpand={() => toggleConflictExpand(segment.conflict.id)}
                                />
                            </div>
                        );
                    }
                })}
            </div>
        );
    };
    
    if (loading) {
        return (
            <div className="flex items-center justify-center h-full bg-[#0d1117]">
                <div className="text-gray-400">Loading...</div>
            </div>
        );
    }
    
    return (
        <div className="flex flex-col h-full bg-[#0d1117]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-[#161b22] border-b border-gray-800">
                <div className="flex items-center gap-3">
                    <GitMerge className="w-5 h-5 text-orange-400" />
                    <div>
                        <div className="text-sm font-medium text-gray-200">{filePath}</div>
                        <div className="text-xs text-gray-500">
                            {remainingConflicts > 0 
                                ? `${remainingConflicts} conflict${remainingConflicts > 1 ? 's' : ''} remaining`
                                : 'All conflicts resolved'
                            }
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    {remainingConflicts === 0 && (
                        <button
                            onClick={handleSaveAndMarkResolved}
                            disabled={saving}
                            className="px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm rounded flex items-center gap-2"
                        >
                            <Check className="w-4 h-4" />
                            {saving ? 'Saving...' : 'Mark as Resolved'}
                        </button>
                    )}
                    <button
                        onClick={onClose}
                        className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
            </div>
            
            {error && (
                <div className="px-4 py-2 bg-red-900/50 text-red-200 text-sm border-b border-red-800">
                    {error}
                </div>
            )}
            
            {/* Content with embedded conflicts */}
            {renderContentWithConflicts()}
        </div>
    );
}

export default MergeConflictEditor;
