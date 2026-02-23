'use client';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useDispatch } from 'react-redux';
import {
    Check, X, GitMerge, ChevronDown, ChevronUp
} from 'lucide-react';
import { markResolved } from '@/redux/gitSlice';
import { refreshWorkspaceThunk } from '@/redux/workspaceSlice';
import { gitClient } from '@/services/gitClient';

// ── Synthi dark theme colors (matching editor theme) ───────────────────────
const THEME = {
    bg:            '#0c0d12',
    headerBg:      '#0d0e14',
    borderDim:     '#1a1b24',

    textPrimary:   '#e8eaf0',
    textSecondary: '#7c80a0',
    textMuted:     '#4d5168',
    textAccent:    '#4aba9a',

    // Current (ours) — teal-green tint
    currentBg:        'rgba(58, 133, 116, 0.10)',
    currentHeaderBg:  'rgba(58, 133, 116, 0.18)',
    currentGutter:    'rgba(58, 133, 116, 0.50)',
    currentLabel:     '#4aba9a',

    // Incoming (theirs) — blue tint
    incomingBg:       'rgba(122, 184, 248, 0.10)',
    incomingHeaderBg: 'rgba(122, 184, 248, 0.18)',
    incomingGutter:   'rgba(122, 184, 248, 0.50)',
    incomingLabel:    '#7cb8f8',

    // Separator
    separatorBg:   'rgba(77, 81, 104, 0.20)',

    // Action buttons
    acceptBtn:      'rgba(74, 186, 154, 0.12)',
    acceptBtnHover: 'rgba(74, 186, 154, 0.22)',

    // Line numbers
    lineNumBg: '#0d0e14',
    lineNum:   '#454a5e',
};

// ── Conflict parser ─────────────────────────────────────────────────────────

function parseConflicts(content) {
    if (!content) return { conflicts: [], lines: [] };

    const lines = content.split('\n');
    const conflicts = [];
    let currentConflict = null;
    let conflictId = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.replace(/\r$/, '');  // Handle CRLF line endings

        if (trimmed.startsWith('<<<<<<<')) {
            currentConflict = {
                id: conflictId++,
                startLine: i,
                oursLabel: trimmed.replace('<<<<<<<', '').trim() || 'Current Change',
                oursLines: [],
                theirsLines: [],
                theirsLabel: '',
                separatorLine: -1,
                endLine: -1,
                inTheirs: false,
            };
        } else if (trimmed.startsWith('=======') && currentConflict && !currentConflict.inTheirs) {
            currentConflict.separatorLine = i;
            currentConflict.inTheirs = true;
        } else if (trimmed.startsWith('>>>>>>>') && currentConflict) {
            currentConflict.theirsLabel = trimmed.replace('>>>>>>>', '').trim() || 'Incoming Change';
            currentConflict.endLine = i;
            conflicts.push(currentConflict);
            currentConflict = null;
        } else if (currentConflict) {
            if (currentConflict.inTheirs) {
                currentConflict.theirsLines.push(trimmed);
            } else {
                currentConflict.oursLines.push(trimmed);
            }
        }
    }

    return { conflicts, lines };
}

function resolveConflict(content, conflict, resolution) {
    // Normalize CRLF to ensure consistent line splitting
    const lines = content.replace(/\r\n/g, '\n').split('\n');
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

    return [
        ...lines.slice(0, conflict.startLine),
        ...replacementLines,
        ...lines.slice(conflict.endLine + 1)
    ].join('\n');
}

// ── VS Code-style inline action links (CodeLens) ───────────────────────────

function ConflictActionBar({ onAcceptCurrent, onAcceptIncoming, onAcceptBoth }) {
    return (
        <div className="flex items-center gap-3 py-[2px] select-none" style={{ paddingLeft: 55 }}>
            <button
                onClick={onAcceptCurrent}
                className="text-[11px] font-medium hover:underline transition-colors"
                style={{ color: THEME.textAccent }}
            >
                Accept Current Change
            </button>
            <span style={{ color: THEME.textMuted }}>|</span>
            <button
                onClick={onAcceptIncoming}
                className="text-[11px] font-medium hover:underline transition-colors"
                style={{ color: THEME.textAccent }}
            >
                Accept Incoming Change
            </button>
            <span style={{ color: THEME.textMuted }}>|</span>
            <button
                onClick={onAcceptBoth}
                className="text-[11px] font-medium hover:underline transition-colors"
                style={{ color: THEME.textAccent }}
            >
                Accept Both Changes
            </button>
        </div>
    );
}

// ── Single code line renderer ───────────────────────────────────────────────

function CodeLine({ lineNumber, text, bgColor, gutterColor, isMarker, markerLabel }) {
    return (
        <div
            className="flex items-stretch font-mono text-[13px] leading-[20px] min-h-[20px]"
            style={{ backgroundColor: bgColor || 'transparent' }}
        >
            {/* Gutter color strip */}
            <div className="w-[3px] shrink-0" style={{ backgroundColor: gutterColor || 'transparent' }} />
            {/* Line number */}
            <div
                className="w-[48px] shrink-0 text-right pr-3 select-none"
                style={{ color: THEME.lineNum, backgroundColor: THEME.lineNumBg }}
            >
                {isMarker ? '' : lineNumber}
            </div>
            {/* Content */}
            <div className="flex-1 px-3 whitespace-pre overflow-x-auto">
                {isMarker ? (
                    <span style={{ color: THEME.textMuted, fontStyle: 'italic', fontSize: 11 }}>
                        {markerLabel || text}
                    </span>
                ) : (
                    <span style={{ color: THEME.textPrimary }}>{text || ' '}</span>
                )}
            </div>
        </div>
    );
}

// ── Main Merge Conflict Editor ──────────────────────────────────────────────

export default function MergeConflictEditor({ slug, filePath, onClose, onResolved }) {
    const dispatch = useDispatch();
    const [content, setContent] = useState('');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [currentConflictIdx, setCurrentConflictIdx] = useState(0);
    const conflictRefs = useRef([]);
    const scrollContainerRef = useRef(null);

    // Load file content
    useEffect(() => {
        async function loadContent() {
            try {
                setLoading(true);
                setError(null);
                const result = await gitClient.request(slug, 'file', { path: filePath });
                setContent((result.content || '').replace(/\r\n/g, '\n'));
            } catch (e) {
                setError(e.message || 'Failed to load file');
            } finally {
                setLoading(false);
            }
        }
        if (slug && filePath) loadContent();
    }, [slug, filePath]);

    const { conflicts } = useMemo(() => parseConflicts(content), [content]);
    const remainingConflicts = conflicts.length;

    const handleResolve = useCallback((conflictId, resolution) => {
        const conflict = conflicts.find(c => c.id === conflictId);
        if (!conflict) return;
        setContent(resolveConflict(content, conflict, resolution));
    }, [content, conflicts]);

    const handleResolveAll = useCallback((resolution) => {
        let result = content;
        const { conflicts: cur } = parseConflicts(result);
        for (let i = cur.length - 1; i >= 0; i--) {
            result = resolveConflict(result, cur[i], resolution);
        }
        setContent(result);
    }, [content]);

    const navigateConflict = useCallback((direction) => {
        const newIdx = direction === 'next'
            ? Math.min(currentConflictIdx + 1, conflicts.length - 1)
            : Math.max(currentConflictIdx - 1, 0);
        setCurrentConflictIdx(newIdx);
        conflictRefs.current[newIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [currentConflictIdx, conflicts.length]);

    const handleSaveAndMarkResolved = async () => {
        if (remainingConflicts > 0) return;
        try {
            setSaving(true);
            await gitClient.syncFile(slug, filePath, content);
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

    // ── Build rendering segments ────────────────────────────────────────

    const segments = useMemo(() => {
        if (!content) return [];
        const { conflicts: cur } = parseConflicts(content);
        const allLines = content.split('\n');
        const segs = [];
        let lastEnd = 0;

        cur.forEach((conflict) => {
            if (conflict.startLine > lastEnd) {
                segs.push({ type: 'normal', lines: allLines.slice(lastEnd, conflict.startLine), startLine: lastEnd });
            }
            segs.push({ type: 'conflict', conflict });
            lastEnd = conflict.endLine + 1;
        });

        if (lastEnd < allLines.length) {
            segs.push({ type: 'normal', lines: allLines.slice(lastEnd), startLine: lastEnd });
        }
        return segs;
    }, [content]);

    // ── Loading ─────────────────────────────────────────────────────────

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full" style={{ backgroundColor: THEME.bg }}>
                <div className="flex items-center gap-2" style={{ color: THEME.textSecondary }}>
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Loading...
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full" style={{ backgroundColor: THEME.bg }}>
            {/* ── Top toolbar ──────────────────────────────────────────── */}
            <div
                className="flex items-center justify-between px-4 shrink-0 select-none"
                style={{ height: 40, backgroundColor: THEME.headerBg, borderBottom: `1px solid ${THEME.borderDim}` }}
            >
                <div className="flex items-center gap-3">
                    <GitMerge className="w-4 h-4" style={{ color: THEME.textAccent }} />
                    <span className="text-sm font-medium" style={{ color: THEME.textPrimary }}>{filePath}</span>
                    <span
                        className="text-xs px-2 py-0.5 rounded-full"
                        style={{
                            backgroundColor: remainingConflicts > 0 ? 'rgba(245, 158, 66, 0.15)' : 'rgba(74, 186, 154, 0.15)',
                            color: remainingConflicts > 0 ? '#f59e42' : THEME.textAccent,
                        }}
                    >
                        {remainingConflicts > 0
                            ? `${remainingConflicts} conflict${remainingConflicts > 1 ? 's' : ''}`
                            : 'All resolved'}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {/* Conflict navigator */}
                    {remainingConflicts > 1 && (
                        <div className="flex items-center gap-1 mr-2">
                            <button
                                onClick={() => navigateConflict('prev')}
                                disabled={currentConflictIdx === 0}
                                className="p-1 rounded hover:bg-[#1e1f2e] disabled:opacity-30 transition-colors"
                                style={{ color: THEME.textSecondary }}
                            >
                                <ChevronUp className="w-4 h-4" />
                            </button>
                            <span className="text-xs tabular-nums min-w-[40px] text-center" style={{ color: THEME.textSecondary }}>
                                {currentConflictIdx + 1}/{remainingConflicts}
                            </span>
                            <button
                                onClick={() => navigateConflict('next')}
                                disabled={currentConflictIdx >= remainingConflicts - 1}
                                className="p-1 rounded hover:bg-[#1e1f2e] disabled:opacity-30 transition-colors"
                                style={{ color: THEME.textSecondary }}
                            >
                                <ChevronDown className="w-4 h-4" />
                            </button>
                        </div>
                    )}

                    {/* Resolve all buttons */}
                    {remainingConflicts > 1 && (
                        <div className="flex items-center gap-1 mr-2 border-l pl-2" style={{ borderColor: THEME.borderDim }}>
                            <button
                                onClick={() => handleResolveAll('ours')}
                                className="px-2 py-1 rounded text-[11px] font-medium transition-colors hover:brightness-125"
                                style={{ backgroundColor: THEME.acceptBtn, color: THEME.currentLabel }}
                            >
                                All Current
                            </button>
                            <button
                                onClick={() => handleResolveAll('theirs')}
                                className="px-2 py-1 rounded text-[11px] font-medium transition-colors hover:brightness-125"
                                style={{ backgroundColor: 'rgba(124, 184, 248, 0.12)', color: THEME.incomingLabel }}
                            >
                                All Incoming
                            </button>
                        </div>
                    )}

                    {/* Mark resolved */}
                    {remainingConflicts === 0 && (
                        <button
                            onClick={handleSaveAndMarkResolved}
                            disabled={saving}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50"
                            style={{ backgroundColor: 'rgba(74, 186, 154, 0.15)', color: THEME.textAccent }}
                        >
                            <Check className="w-3.5 h-3.5" />
                            {saving ? 'Saving...' : 'Mark Resolved'}
                        </button>
                    )}

                    <button onClick={onClose} className="p-1.5 rounded hover:bg-[#1e1f2e] transition-colors" style={{ color: THEME.textSecondary }}>
                        <X className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="px-4 py-2 text-sm" style={{ backgroundColor: 'rgba(255,87,87,0.10)', color: '#ff5757', borderBottom: '1px solid rgba(255,87,87,0.20)' }}>
                    {error}
                </div>
            )}

            {/* ── File content with inline conflicts ───────────────────── */}
            <div ref={scrollContainerRef} className="flex-1 overflow-auto">
                {segments.map((segment, segIdx) => {
                    if (segment.type === 'normal') {
                        return (
                            <div key={segIdx}>
                                {segment.lines.map((line, j) => (
                                    <CodeLine key={`${segIdx}-${j}`} lineNumber={segment.startLine + j + 1} text={line} />
                                ))}
                            </div>
                        );
                    }

                    const { conflict } = segment;
                    const conflictArrayIdx = conflicts.findIndex(c => c.id === conflict.id);

                    return (
                        <div key={segIdx} ref={(el) => { conflictRefs.current[conflictArrayIdx] = el; }}>
                            {/* VS Code-style inline action links */}
                            <ConflictActionBar
                                onAcceptCurrent={() => handleResolve(conflict.id, 'ours')}
                                onAcceptIncoming={() => handleResolve(conflict.id, 'theirs')}
                                onAcceptBoth={() => handleResolve(conflict.id, 'both')}
                            />

                            {/* <<<<<<< Current marker */}
                            <CodeLine
                                lineNumber={conflict.startLine + 1}
                                text={`<<<<<<< ${conflict.oursLabel}`}
                                bgColor={THEME.currentHeaderBg}
                                gutterColor={THEME.currentGutter}
                                isMarker
                                markerLabel={`Current Change — ${conflict.oursLabel}`}
                            />

                            {/* Current (ours) lines */}
                            {conflict.oursLines.map((line, i) => (
                                <CodeLine
                                    key={`ours-${i}`}
                                    lineNumber={conflict.startLine + 2 + i}
                                    text={line}
                                    bgColor={THEME.currentBg}
                                    gutterColor={THEME.currentGutter}
                                />
                            ))}

                            {/* ======= separator */}
                            <CodeLine
                                lineNumber=""
                                text="======="
                                bgColor={THEME.separatorBg}
                                isMarker
                                markerLabel="═══════════════════════════════════════════"
                            />

                            {/* Incoming (theirs) lines */}
                            {conflict.theirsLines.map((line, i) => (
                                <CodeLine
                                    key={`theirs-${i}`}
                                    lineNumber={(conflict.separatorLine || conflict.startLine + conflict.oursLines.length + 1) + 1 + i + 1}
                                    text={line}
                                    bgColor={THEME.incomingBg}
                                    gutterColor={THEME.incomingGutter}
                                />
                            ))}

                            {/* >>>>>>> Incoming marker */}
                            <CodeLine
                                lineNumber={conflict.endLine + 1}
                                text={`>>>>>>> ${conflict.theirsLabel}`}
                                bgColor={THEME.incomingHeaderBg}
                                gutterColor={THEME.incomingGutter}
                                isMarker
                                markerLabel={`Incoming Change — ${conflict.theirsLabel}`}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// Re-export for named import compatibility
export { MergeConflictEditor };
