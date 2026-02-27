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
    // Normalize CRLF → LF so line slicing is consistent across platforms
    const lines = content.replace(/\r\n/g, '\n').split('\n');
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
    // Normalize CRLF to ensure consistent line splitting
    const normalized = content.replace(/\r\n/g, '\n');
    const conflicts = parseConflicts(normalized);
    if (conflictIndex >= conflicts.length) return content;
    
    const conflict = conflicts[conflictIndex];
    const lines = normalized.split('\n');
    
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
            // Highlight the entire conflict block with a subtle background
            newDecorations.push({
                range: new monaco.Range(conflict.startLine + 1, 1, conflict.endLine + 2, 1),
                options: {
                    isWholeLine: true,
                    className: 'conflict-block-background',
                    glyphMarginClassName: 'conflict-glyph-margin',
                }
            });
            
            // <<<<<<< marker line (bold green/teal)
            newDecorations.push({
                range: new monaco.Range(conflict.startLine + 1, 1, conflict.startLine + 1, 1),
                options: {
                    isWholeLine: true,
                    className: 'conflict-marker-start-line',
                    glyphMarginHoverMessage: { value: `**Conflict ${index + 1}** — Current Change (HEAD)` },
                    marginClassName: 'conflict-ours-margin',
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

            // ======= separator line
            const separatorLine = oursEndLine;
            newDecorations.push({
                range: new monaco.Range(separatorLine, 1, separatorLine, 1),
                options: {
                    isWholeLine: true,
                    className: 'conflict-marker-sep-line',
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

            // >>>>>>> marker line (bold blue)
            newDecorations.push({
                range: new monaco.Range(conflict.endLine + 1, 1, conflict.endLine + 1, 1),
                options: {
                    isWholeLine: true,
                    className: 'conflict-marker-end-line',
                    marginClassName: 'conflict-theirs-margin',
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
                .conflict-block-background { background-color: rgba(245, 158, 66, 0.08) !important; }
                .conflict-ours-background { background-color: rgba(58, 133, 116, 0.18) !important; }
                .conflict-theirs-background { background-color: rgba(122, 184, 248, 0.18) !important; }
                .conflict-ours-margin { background-color: rgba(74, 186, 154, 0.60) !important; width: 3px !important; margin-left: 2px; }
                .conflict-theirs-margin { background-color: rgba(124, 184, 248, 0.60) !important; width: 3px !important; margin-left: 2px; }
                .conflict-marker-line { background-color: rgba(245, 158, 66, 0.15) !important; }
                .conflict-glyph-margin { background-color: rgba(245, 158, 66, 0.40) !important; }
                .conflict-marker-start-line { background-color: rgba(58, 133, 116, 0.28) !important; }
                .conflict-marker-sep-line { background-color: rgba(77, 81, 104, 0.25) !important; }
                .conflict-marker-end-line { background-color: rgba(122, 184, 248, 0.28) !important; }
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
        <div className="border-b px-3 py-2 flex items-center gap-3 text-sm select-none"
            style={{ backgroundColor: 'rgba(245, 158, 66, 0.08)', borderColor: 'rgba(245, 158, 66, 0.20)' }}>
            {/* Warning icon and conflict count */}
            <div className="flex items-center gap-2" style={{ color: '#f59e42' }}>
                <AlertTriangle className="w-4 h-4" />
                <span className="font-medium">
                    {conflicts.length} merge conflict{conflicts.length > 1 ? 's' : ''}
                </span>
            </div>
            
            {/* Conflict navigator */}
            <div className="flex items-center gap-1 border-l pl-3" style={{ borderColor: 'rgba(245, 158, 66, 0.20)' }}>
                <button
                    onClick={goToPrevConflict}
                    disabled={currentConflictIndex === 0 || isResolving}
                    className="p-1 rounded disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#1e1f2e] transition-colors"
                    title="Previous conflict"
                    style={{ color: '#7c80a0' }}
                >
                    <ChevronUp className="w-4 h-4" />
                </button>
                <span className="min-w-[50px] text-center text-xs tabular-nums" style={{ color: '#7c80a0' }}>
                    {currentConflictIndex + 1} of {conflicts.length}
                </span>
                <button
                    onClick={goToNextConflict}
                    disabled={currentConflictIndex >= conflicts.length - 1 || isResolving}
                    className="p-1 rounded disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[#1e1f2e] transition-colors"
                    title="Next conflict"
                    style={{ color: '#7c80a0' }}
                >
                    <ChevronDown className="w-4 h-4" />
                </button>
            </div>
            
            {/* Current conflict actions */}
            <div className="flex items-center gap-2 border-l pl-3" style={{ borderColor: 'rgba(245, 158, 66, 0.20)' }}>
                <button
                    onClick={() => handleResolve('ours')}
                    disabled={isResolving}
                    className="px-2 py-1 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                    style={{ backgroundColor: 'rgba(58, 133, 116, 0.15)', color: '#4aba9a' }}
                    title={`Accept "${currentConflict?.oursLabel || 'Current'}"`}
                >
                    Accept Current
                </button>
                <button
                    onClick={() => handleResolve('theirs')}
                    disabled={isResolving}
                    className="px-2 py-1 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                    style={{ backgroundColor: 'rgba(122, 184, 248, 0.15)', color: '#7cb8f8' }}
                    title={`Accept "${currentConflict?.theirsLabel || 'Incoming'}"`}
                >
                    Accept Incoming
                </button>
                <button
                    onClick={() => handleResolve('both')}
                    disabled={isResolving}
                    className="px-2 py-1 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                    style={{ backgroundColor: 'rgba(196, 181, 253, 0.15)', color: '#c4b5fd' }}
                    title="Accept both changes"
                >
                    Accept Both
                </button>
            </div>
            
            {/* Resolve all actions */}
            {conflicts.length > 1 && (
                <div className="flex items-center gap-2 border-l pl-3" style={{ borderColor: 'rgba(245, 158, 66, 0.20)' }}>
                    <span className="text-xs" style={{ color: '#4d5168' }}>All:</span>
                    <button
                        onClick={() => handleResolveAll('ours')}
                        disabled={isResolving}
                        className="px-2 py-1 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                        style={{ backgroundColor: 'rgba(58, 133, 116, 0.10)', color: '#4aba9a' }}
                    >
                        All Current
                    </button>
                    <button
                        onClick={() => handleResolveAll('theirs')}
                        disabled={isResolving}
                        className="px-2 py-1 rounded text-xs font-medium disabled:opacity-50 transition-colors"
                        style={{ backgroundColor: 'rgba(122, 184, 248, 0.10)', color: '#7cb8f8' }}
                    >
                        All Incoming
                    </button>
                </div>
            )}
            
            {/* Mark as resolved (when no conflicts remain) */}
            {conflicts.length === 0 && (
                <div className="flex items-center gap-2 border-l pl-3" style={{ borderColor: 'rgba(245, 158, 66, 0.20)' }}>
                    <button
                        onClick={handleMarkResolved}
                        disabled={isResolving}
                        className="px-2 py-1 rounded text-xs font-medium flex items-center gap-1 disabled:opacity-50 transition-colors"
                        style={{ backgroundColor: 'rgba(74, 186, 154, 0.15)', color: '#4aba9a' }}
                    >
                        <Check className="w-3 h-3" />
                        Mark Resolved
                    </button>
                </div>
            )}
        </div>
    );
}

export default ConflictBanner;
