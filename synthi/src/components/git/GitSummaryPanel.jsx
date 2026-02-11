'use client';
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { GitBranch, ArrowUp, ArrowDown, AlertCircle, Circle } from 'lucide-react';

/**
 * Compact collapsible git summary at the bottom of the Explorer sidebar.
 *
 * Design: Synthi-style — gradient accent bar, pill badges, card feel.
 * When collapsed: a minimal status strip with branch + change count.
 * When expanded: file list with colored left borders, resizable via drag.
 */
export function GitSummaryPanel({ onOpenScm }) {
    const [expanded, setExpanded] = useState(false);
    const [panelHeight, setPanelHeight] = useState(200);
    const dragging = useRef(false);
    const startY = useRef(0);
    const startH = useRef(0);
    const containerRef = useRef(null);

    const { status, currentBranch, unpushedCommits, incomingCommits } = useSelector(s => s.git);

    const staged = status?.files?.filter(f => f.index !== ' ' && f.index !== '?') ?? [];
    const changes = status?.files?.filter(f => f.working_dir !== ' ' || f.index === '?') ?? [];
    const conflicted = status?.conflictedFiles ?? [];
    const totalChanges = staged.length + changes.length;
    const ahead = unpushedCommits?.length ?? status?.ahead ?? 0;
    const behind = incomingCommits?.length ?? status?.behind ?? 0;

    const branchLabel = status?.current || currentBranch || 'main';

    // --- Drag-to-resize ---
    const onMouseDown = useCallback((e) => {
        e.preventDefault();
        dragging.current = true;
        startY.current = e.clientY;
        startH.current = panelHeight;
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
    }, [panelHeight]);

    useEffect(() => {
        const onMouseMove = (e) => {
            if (!dragging.current) return;
            const delta = startY.current - e.clientY;
            const parentH = containerRef.current?.parentElement?.clientHeight || 600;
            const maxH = parentH - 60;
            const newH = Math.max(80, Math.min(maxH, startH.current + delta));
            setPanelHeight(newH);
        };
        const onMouseUp = () => {
            if (dragging.current) {
                dragging.current = false;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        return () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, []);

    const fileColor = (f) => {
        if (f.index === '?') return { border: 'border-l-emerald-500', text: 'text-emerald-400/80', label: 'new' };
        if (f.index && f.index !== ' ') return { border: 'border-l-teal-500', text: 'text-teal-400/80', label: 'staged' };
        return { border: 'border-l-amber-500', text: 'text-amber-400/80', label: 'modified' };
    };

    return (
        <div ref={containerRef} className="flex flex-col select-none" style={expanded ? { height: panelHeight, flexShrink: 0 } : { flexShrink: 0 }}>
            {/* Gradient accent line */}
            <div className="h-[2px] flex-shrink-0" style={{ background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #a78bfa, transparent)' }} />

            {/* Resize handle — only when expanded */}
            {expanded && (
                <div
                    onMouseDown={onMouseDown}
                    className="h-[5px] cursor-row-resize bg-transparent hover:bg-violet-500/20 transition-colors flex-shrink-0"
                />
            )}

            {/* Header strip */}
            <button
                onClick={() => setExpanded(v => !v)}
                onDoubleClick={() => onOpenScm?.()}
                className="flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-white/[0.03] transition-colors w-full text-left flex-shrink-0"
                title="Double-click to open full Source Control"
            >
                <GitBranch size={13} className="text-violet-400 flex-shrink-0" />
                <span className="text-[#d4d4d8] font-medium truncate">{branchLabel}</span>

                {/* Sync indicators */}
                <div className="flex items-center gap-1 ml-auto">
                    {conflicted.length > 0 && (
                        <span className="flex items-center gap-0.5 text-[10px] text-rose-400 bg-rose-500/10 rounded-full px-1.5 py-0.5">
                            <AlertCircle size={9} /> {conflicted.length}
                        </span>
                    )}
                    {ahead > 0 && (
                        <span className="flex items-center gap-0.5 text-[10px] text-emerald-400 bg-emerald-500/10 rounded-full px-1.5 py-0.5">
                            <ArrowUp size={9} /> {ahead}
                        </span>
                    )}
                    {behind > 0 && (
                        <span className="flex items-center gap-0.5 text-[10px] text-amber-400 bg-amber-500/10 rounded-full px-1.5 py-0.5">
                            <ArrowDown size={9} /> {behind}
                        </span>
                    )}
                    {totalChanges > 0 && (
                        <span className="text-[10px] text-violet-300 bg-violet-500/15 rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 font-semibold">
                            {totalChanges}
                        </span>
                    )}
                    {totalChanges === 0 && conflicted.length === 0 && status !== null && (
                        <span className="text-[10px] text-emerald-500/60">✓</span>
                    )}
                </div>
            </button>

            {/* Expanded file list */}
            {expanded && status !== null && (
                <div className="overflow-y-auto flex-1 min-h-0 text-[11px] px-1.5 pb-1">
                    {/* Conflicts */}
                    {conflicted.length > 0 && conflicted.map(f => (
                        <div
                            key={f}
                            className="flex items-center gap-2 pl-2 pr-2 py-[3px] my-[1px] rounded-md border-l-2 border-l-rose-500 bg-rose-500/[0.06] hover:bg-rose-500/[0.12] cursor-pointer transition-colors"
                            onClick={() => onOpenScm?.()}
                        >
                            <Circle size={6} className="text-rose-400 fill-rose-400 flex-shrink-0" />
                            <span className="truncate text-rose-300/80">{f.split('/').pop()}</span>
                            <span className="ml-auto text-[9px] text-rose-400/50 font-medium">conflict</span>
                        </div>
                    ))}

                    {/* Staged */}
                    {staged.map(f => (
                        <div
                            key={`s-${f.path}`}
                            className="flex items-center gap-2 pl-2 pr-2 py-[3px] my-[1px] rounded-md border-l-2 border-l-teal-500 hover:bg-white/[0.03] cursor-pointer transition-colors"
                            onClick={() => onOpenScm?.()}
                        >
                            <Circle size={6} className="text-teal-400 fill-teal-400 flex-shrink-0" />
                            <span className="truncate text-[#a1a1aa]">{f.path.split('/').pop()}</span>
                            <span className="ml-auto text-[9px] text-teal-400/40 font-medium">staged</span>
                        </div>
                    ))}

                    {/* Changes */}
                    {changes.map(f => {
                        const c = fileColor(f);
                        return (
                            <div
                                key={`c-${f.path}`}
                                className={`flex items-center gap-2 pl-2 pr-2 py-[3px] my-[1px] rounded-md border-l-2 ${c.border} hover:bg-white/[0.03] cursor-pointer transition-colors`}
                                onClick={() => onOpenScm?.()}
                            >
                                <Circle size={6} className={`${c.text} flex-shrink-0`} style={{ fill: 'currentColor' }} />
                                <span className="truncate text-[#a1a1aa]">{f.path.split('/').pop()}</span>
                                <span className={`ml-auto text-[9px] font-medium opacity-40 ${c.text}`}>{c.label}</span>
                            </div>
                        );
                    })}

                    {/* Clean state */}
                    {totalChanges === 0 && conflicted.length === 0 && (
                        <div className="px-2 py-2 text-[#52525b] text-center">Nothing to commit</div>
                    )}

                    {/* Open full view */}
                    <button
                        onClick={() => onOpenScm?.()}
                        className="w-full mt-1 py-1 rounded-md text-[10px] text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 transition-colors font-medium"
                    >
                        Open full view →
                    </button>
                </div>
            )}

            {/* Git not initialized */}
            {expanded && status === null && (
                <div className="px-3 py-2 text-[11px] text-[#52525b] text-center">
                    No git repository
                </div>
            )}
        </div>
    );
}

export default GitSummaryPanel;
