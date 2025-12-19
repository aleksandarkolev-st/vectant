'use client';
import { useState, useMemo, useEffect, useRef } from 'react';
import { AlertTriangle, Check, X, ChevronUp, ChevronDown } from 'lucide-react';
import { gitClient } from '@/services/gitClient';

/**
 * Detects and parses merge conflict markers in code content
 */
function parseConflicts(content) {
    if (!content) return [];
    
    const conflicts = [];
    const lines = content.split('\n');
    let i = 0;
    
    while (i < lines.length) {
        // Look for conflict start marker
        if (lines[i].startsWith('<<<<<<<')) {
            const startLine = i;
            const oursStart = i + 1;
            let separator = -1;
            let theirsEnd = -1;
            let endLine = -1;
            
            // Find separator and end
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].startsWith('=======')) {
                    separator = j;
                } else if (lines[j].startsWith('>>>>>>>') && separator !== -1) {
                    endLine = j;
                    theirsEnd = j - 1;
                    break;
                }
            }
            
            if (separator !== -1 && endLine !== -1) {
                conflicts.push({
                    startLine,
                    endLine,
                    oursContent: lines.slice(oursStart, separator).join('\n'),
                    theirsContent: lines.slice(separator + 1, endLine).join('\n'),
                    oursLabel: lines[startLine].replace('<<<<<<<', '').trim() || 'Current',
                    theirsLabel: lines[endLine].replace('>>>>>>>', '').trim() || 'Incoming',
                });
                i = endLine + 1;
                continue;
            }
        }
        i++;
    }
    
    return conflicts;
}

/**
 * Resolves a specific conflict in the content
 */
function resolveConflict(content, conflictIndex, resolution) {
    const conflicts = parseConflicts(content);
    if (conflictIndex >= conflicts.length) return content;
    
    const conflict = conflicts[conflictIndex];
    const lines = content.split('\n');
    
    let replacement;
    switch (resolution) {
        case 'ours':
            replacement = conflict.oursContent;
            break;
        case 'theirs':
            replacement = conflict.theirsContent;
            break;
        case 'both':
            replacement = conflict.oursContent + '\n' + conflict.theirsContent;
            break;
        default:
            return content;
    }
    
    // Replace from startLine to endLine (inclusive)
    const before = lines.slice(0, conflict.startLine);
    const after = lines.slice(conflict.endLine + 1);
    
    return [...before, replacement, ...after].join('\n');
}

/**
 * Resolves all conflicts with the same resolution type
 */
function resolveAllConflicts(content, resolution) {
    let result = content;
    // Resolve from last to first to maintain line numbers
    const conflicts = parseConflicts(result);
    for (let i = conflicts.length - 1; i >= 0; i--) {
        result = resolveConflict(result, i, resolution);
    }
    return result;
}

export function ConflictBanner({ 
    content, 
    filePath, 
    slug, 
    onContentChange,
    editorInstance 
}) {
    const [currentConflictIndex, setCurrentConflictIndex] = useState(0);
    const [isResolving, setIsResolving] = useState(false);
    const decorationsRef = useRef([]);
    
    const conflicts = useMemo(() => parseConflicts(content), [content]);
    const hasConflicts = conflicts.length > 0;
    
    // Add Monaco decorations for conflict highlighting
    useEffect(() => {
        if (!editorInstance || !hasConflicts) {
            return;
        }
        
        const monaco = window.monaco;
        if (!monaco) return;
        
        // Create decorations for each conflict
        const newDecorations = [];
        
        conflicts.forEach((conflict, index) => {
            // Highlight the entire conflict block with a background
            newDecorations.push({
                range: new monaco.Range(conflict.startLine + 1, 1, conflict.endLine + 2, 1),
                options: {
                    isWholeLine: true,
                    className: 'conflict-block-background',
                    glyphMarginClassName: 'conflict-glyph-margin',
                }
            });
            
            // Highlight "ours" section (green-ish)
            const oursEndLine = conflict.startLine + conflict.oursContent.split('\n').length + 1;
            newDecorations.push({
                range: new monaco.Range(conflict.startLine + 2, 1, oursEndLine, 1),
                options: {
                    isWholeLine: true,
                    className: 'conflict-ours-background',
                    marginClassName: 'conflict-ours-margin',
                }
            });
            
            // Highlight "theirs" section (blue-ish)
            const theirsStartLine = oursEndLine + 1;
            newDecorations.push({
                range: new monaco.Range(theirsStartLine, 1, conflict.endLine + 1, 1),
                options: {
                    isWholeLine: true,
                    className: 'conflict-theirs-background',
                    marginClassName: 'conflict-theirs-margin',
                }
            });
            
            // Add marker at conflict start line
            newDecorations.push({
                range: new monaco.Range(conflict.startLine + 1, 1, conflict.startLine + 1, 1),
                options: {
                    isWholeLine: true,
                    className: 'conflict-marker-line',
                    glyphMarginHoverMessage: { value: `**Conflict ${index + 1}** - Click buttons in banner to resolve` }
                }
            });
        });
        
        // Apply decorations
        decorationsRef.current = editorInstance.deltaDecorations(decorationsRef.current, newDecorations);
        
        // Add CSS for decorations if not already added
        if (!document.getElementById('conflict-decoration-styles')) {
            const style = document.createElement('style');
            style.id = 'conflict-decoration-styles';
            style.textContent = `
                .conflict-block-background { background-color: rgba(255, 165, 0, 0.08) !important; }
                .conflict-ours-background { background-color: rgba(34, 139, 34, 0.15) !important; }
                .conflict-theirs-background { background-color: rgba(30, 144, 255, 0.15) !important; }
                .conflict-ours-margin { background-color: rgba(34, 139, 34, 0.4) !important; width: 4px !important; margin-left: 3px; }
                .conflict-theirs-margin { background-color: rgba(30, 144, 255, 0.4) !important; width: 4px !important; margin-left: 3px; }
                .conflict-marker-line { background-color: rgba(255, 140, 0, 0.25) !important; }
                .conflict-glyph-margin { background-color: rgba(255, 140, 0, 0.5) !important; }
            `;
            document.head.appendChild(style);
        }
        
        return () => {
            // Clear decorations on unmount
            if (editorInstance && decorationsRef.current.length > 0) {
                try {
                    editorInstance.deltaDecorations(decorationsRef.current, []);
                } catch (e) {
                    // Editor may be disposed
                }
            }
        };
    }, [editorInstance, conflicts, hasConflicts]);
    
    // Navigate to first conflict on mount
    useEffect(() => {
        if (editorInstance && hasConflicts && conflicts[0]) {
            const lineNumber = conflicts[0].startLine + 1;
            editorInstance.revealLineInCenter(lineNumber);
        }
    }, [editorInstance, hasConflicts]);
    
    if (!hasConflicts) return null;
    
    const currentConflict = conflicts[currentConflictIndex];
    
    const handleResolve = async (resolution) => {
        setIsResolving(true);
        try {
            const newContent = resolveConflict(content, currentConflictIndex, resolution);
            onContentChange(newContent);
            
            // Move to next conflict or reset if this was the last one
            const remainingConflicts = parseConflicts(newContent);
            if (remainingConflicts.length === 0) {
                setCurrentConflictIndex(0);
            } else if (currentConflictIndex >= remainingConflicts.length) {
                setCurrentConflictIndex(remainingConflicts.length - 1);
            }
        } finally {
            setIsResolving(false);
        }
    };
    
    const handleResolveAll = async (resolution) => {
        setIsResolving(true);
        try {
            const newContent = resolveAllConflicts(content, resolution);
            onContentChange(newContent);
            setCurrentConflictIndex(0);
        } finally {
            setIsResolving(false);
        }
    };
    
    const handleMarkResolved = async () => {
        setIsResolving(true);
        try {
            await gitClient.markResolved(slug, filePath);
        } catch (e) {
            console.error('Failed to mark as resolved:', e);
        } finally {
            setIsResolving(false);
        }
    };
    
    const navigateToConflict = (index) => {
        setCurrentConflictIndex(index);
        if (editorInstance && conflicts[index]) {
            // Navigate editor to the conflict location
            const lineNumber = conflicts[index].startLine + 1; // Monaco is 1-indexed
            editorInstance.revealLineInCenter(lineNumber);
            editorInstance.setPosition({ lineNumber, column: 1 });
        }
    };
    
    const goToPrevConflict = () => {
        const newIndex = Math.max(0, currentConflictIndex - 1);
        navigateToConflict(newIndex);
    };
    
    const goToNextConflict = () => {
        const newIndex = Math.min(conflicts.length - 1, currentConflictIndex + 1);
        navigateToConflict(newIndex);
    };
    
    return (
        <div className="bg-orange-900/30 border-b border-orange-700/50 px-3 py-2 flex items-center gap-3 text-sm">
            {/* Warning icon and conflict count */}
            <div className="flex items-center gap-2 text-orange-300">
                <AlertTriangle className="w-4 h-4" />
                <span className="font-medium">
                    {conflicts.length} merge conflict{conflicts.length > 1 ? 's' : ''}
                </span>
            </div>
            
            {/* Conflict navigator */}
            <div className="flex items-center gap-1 border-l border-orange-700/50 pl-3">
                <button
                    onClick={goToPrevConflict}
                    disabled={currentConflictIndex === 0 || isResolving}
                    className="p-1 hover:bg-orange-800/40 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Previous conflict"
                >
                    <ChevronUp className="w-4 h-4 text-orange-300" />
                </button>
                <span className="text-orange-200 min-w-[60px] text-center">
                    {currentConflictIndex + 1} of {conflicts.length}
                </span>
                <button
                    onClick={goToNextConflict}
                    disabled={currentConflictIndex >= conflicts.length - 1 || isResolving}
                    className="p-1 hover:bg-orange-800/40 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Next conflict"
                >
                    <ChevronDown className="w-4 h-4 text-orange-300" />
                </button>
            </div>
            
            {/* Current conflict actions */}
            <div className="flex items-center gap-2 border-l border-orange-700/50 pl-3">
                <span className="text-orange-200/70 text-xs">Current:</span>
                <button
                    onClick={() => handleResolve('ours')}
                    disabled={isResolving}
                    className="px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white disabled:opacity-50"
                    title={`Accept "${currentConflict?.oursLabel || 'Current'}"`}
                >
                    Accept Ours
                </button>
                <button
                    onClick={() => handleResolve('theirs')}
                    disabled={isResolving}
                    className="px-2 py-1 bg-green-600 hover:bg-green-500 rounded text-xs text-white disabled:opacity-50"
                    title={`Accept "${currentConflict?.theirsLabel || 'Incoming'}"`}
                >
                    Accept Theirs
                </button>
                <button
                    onClick={() => handleResolve('both')}
                    disabled={isResolving}
                    className="px-2 py-1 bg-purple-600 hover:bg-purple-500 rounded text-xs text-white disabled:opacity-50"
                    title="Accept both changes"
                >
                    Accept Both
                </button>
            </div>
            
            {/* Resolve all actions */}
            {conflicts.length > 1 && (
                <div className="flex items-center gap-2 border-l border-orange-700/50 pl-3">
                    <span className="text-orange-200/70 text-xs">All:</span>
                    <button
                        onClick={() => handleResolveAll('ours')}
                        disabled={isResolving}
                        className="px-2 py-1 bg-blue-800 hover:bg-blue-700 rounded text-xs text-white disabled:opacity-50"
                    >
                        All Ours
                    </button>
                    <button
                        onClick={() => handleResolveAll('theirs')}
                        disabled={isResolving}
                        className="px-2 py-1 bg-green-800 hover:bg-green-700 rounded text-xs text-white disabled:opacity-50"
                    >
                        All Theirs
                    </button>
                </div>
            )}
            
            {/* Mark as resolved (when no conflicts remain) */}
            {conflicts.length === 0 && (
                <div className="flex items-center gap-2 border-l border-orange-700/50 pl-3">
                    <button
                        onClick={handleMarkResolved}
                        disabled={isResolving}
                        className="px-2 py-1 bg-green-600 hover:bg-green-500 rounded text-xs text-white flex items-center gap-1 disabled:opacity-50"
                    >
                        <Check className="w-3 h-3" />
                        Mark as Resolved
                    </button>
                </div>
            )}
        </div>
    );
}

export default ConflictBanner;
