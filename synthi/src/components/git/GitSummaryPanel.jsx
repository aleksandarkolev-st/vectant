'use client';

/**
 * GitSummaryPanel — compact source-control summary docked at the
 * bottom of the Explorer sidebar.  Two states:
 *
 *   • Collapsed:  one-line strip with branch + change count +
 *                 ahead/behind/conflict chips.
 *   • Expanded:   adds a small file list using the same row
 *                 grammar as the full SCM panel (left-bar variant
 *                 per section, status badge, truncating name).
 *
 * Visual language follows the Vectant redesign — no hardcoded
 * tailwind colors.  The accent line above the strip uses the
 * vt-ambient-bottom utility (1px brand-gradient hairline that
 * drifts subliminally) instead of the previous generic indigo /
 * violet gradient.
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useSelector } from 'react-redux';
import { GitBranch, ArrowUp, ArrowDown, AlertCircle } from 'lucide-react';
import './scm/scm-tokens.css';

export function GitSummaryPanel({ onOpenScm }) {
    const [expanded, setExpanded] = useState(false);
    const [panelHeight, setPanelHeight] = useState(200);
    const dragging = useRef(false);
    const startY = useRef(0);
    const startH = useRef(0);
    const containerRef = useRef(null);

    const { status, currentBranch, unpushedCommits, incomingCommits } = useSelector((s) => s.git);

    const staged = status?.files?.filter((f) => f.index !== ' ' && f.index !== '?') ?? [];
    const changes = status?.files?.filter((f) => f.working_dir !== ' ' || f.index === '?') ?? [];
    const conflicted = status?.conflictedFiles ?? [];
    const totalChanges = staged.length + changes.length;
    const ahead = unpushedCommits?.length ?? status?.ahead ?? 0;
    const behind = incomingCommits?.length ?? status?.behind ?? 0;

    const branchLabel = status?.current || currentBranch || 'main';

    // ── Drag-to-resize ─────────────────────────────────────────
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

    // ── Per-row section classification (mirrors the SCM panel) ──
    // 'conflict' / 'staged' / 'changes' map to the .scm-row--*
    // modifiers and give us the gradient / hairline / danger
    // left-edge treatment for free.
    function classifySection(file, isConflict) {
        if (isConflict) return 'conflict';
        if (file.index !== ' ' && file.index !== '?') return 'staged';
        return 'changes';
    }

    function statusBadge(file) {
        if (file.index === '?' && file.working_dir === '?') return '??';
        if (file.index && file.index !== ' ') return file.index;
        return file.working_dir;
    }

    return (
        <div ref={containerRef} className="flex flex-col select-none" style={expanded ? { height: panelHeight, flexShrink: 0 } : { flexShrink: 0 }}>
            {/* Ambient gradient hairline above the strip — replaces
                the old generic indigo/violet line. */}
            <div
                aria-hidden="true"
                className="vt-ambient-bottom"
                style={{ height: 0, position: 'relative', flexShrink: 0 }}
            />

            {/* Resize handle — only when expanded */}
            {expanded && (
                <div
                    onMouseDown={onMouseDown}
                    className="h-[5px] cursor-row-resize transition-colors flex-shrink-0"
                    style={{
                        background: 'transparent',
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'color-mix(in srgb, var(--attention-purple) 18%, transparent)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                    }}
                />
            )}

            {/* Header strip */}
            <button
                onClick={() => setExpanded((v) => !v)}
                onDoubleClick={() => onOpenScm?.()}
                className="flex items-center gap-2 px-3 py-1.5 text-[11px] transition-colors w-full text-left flex-shrink-0 th-focus-ring"
                style={{ color: 'var(--text-primary)' }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'color-mix(in srgb, var(--text-primary) 3%, transparent)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                }}
                title="Click to expand · double-click to open full Source Control"
            >
                <GitBranch
                    size={13}
                    style={{ color: totalChanges > 0 ? 'var(--attention-purple)' : 'var(--text-muted)' }}
                    strokeWidth={2}
                />
                <span className="font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                    {branchLabel}
                </span>

                {/* Sync indicators — calm slate-violet, never tailwind colors. */}
                <div className="flex items-center gap-1 ml-auto" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {conflicted.length > 0 && (
                        <span
                            className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 font-semibold"
                            style={{
                                color: 'var(--accent-danger)',
                                background: 'color-mix(in srgb, var(--accent-danger) 12%, transparent)',
                            }}
                            title={`${conflicted.length} conflict${conflicted.length === 1 ? '' : 's'}`}
                        >
                            <AlertCircle size={9} strokeWidth={2.5} />
                            {conflicted.length}
                        </span>
                    )}
                    {ahead > 0 && (
                        <span
                            className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5"
                            style={{
                                color: 'var(--accent-secondary)',
                                background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                            }}
                            title={`${ahead} commit${ahead === 1 ? '' : 's'} to push`}
                        >
                            <ArrowUp size={9} strokeWidth={2.5} />
                            {ahead}
                        </span>
                    )}
                    {behind > 0 && (
                        <span
                            className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5"
                            style={{
                                color: 'var(--accent-secondary)',
                                background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                            }}
                            title={`${behind} commit${behind === 1 ? '' : 's'} to pull`}
                        >
                            <ArrowDown size={9} strokeWidth={2.5} />
                            {behind}
                        </span>
                    )}
                    {totalChanges > 0 && (
                        <span
                            className="text-[10px] rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 font-semibold"
                            style={{
                                color: 'var(--attention-purple)',
                                background: 'color-mix(in srgb, var(--attention-purple) 14%, transparent)',
                            }}
                            title={`${totalChanges} pending change${totalChanges === 1 ? '' : 's'}`}
                        >
                            {totalChanges}
                        </span>
                    )}
                    {totalChanges === 0 && conflicted.length === 0 && status !== null && (
                        <span
                            className="text-[10px]"
                            style={{ color: 'var(--text-muted)' }}
                            aria-label="In sync"
                        >
                            ✓
                        </span>
                    )}
                </div>
            </button>

            {/* Expanded file list */}
            {expanded && status !== null && (
                <div className="overflow-y-auto flex-1 min-h-0 text-[11px] px-1.5 pb-1">
                    {/* Conflicts */}
                    {conflicted.length > 0 && conflicted.map((f) => {
                        const real = (status?.files || []).find((x) => x.path === f) || { path: f, index: 'U', working_dir: 'U' };
                        return (
                            <div
                                key={`c-${f}`}
                                className="scm-row scm-row--conflict"
                                onClick={() => onOpenScm?.()}
                                style={{ height: 22, marginLeft: 0, marginRight: 0, padding: '0 8px 0 14px' }}
                                role="button"
                                tabIndex={0}
                            >
                                <span className="scm-row-dot scm-row-dot--conflict" aria-hidden="true" />
                                <span className="scm-row-name" title={f}>{f.split('/').pop()}</span>
                                <span className="scm-row-badge scm-row-badge--conflict">U</span>
                            </div>
                        );
                    })}

                    {/* Staged */}
                    {staged.map((f) => (
                        <div
                            key={`s-${f.path}`}
                            className="scm-row scm-row--staged"
                            onClick={() => onOpenScm?.()}
                            style={{ height: 22, marginLeft: 0, marginRight: 0, padding: '0 8px 0 14px' }}
                            role="button"
                            tabIndex={0}
                        >
                            <span className="scm-row-dot" aria-hidden="true" />
                            <span className="scm-row-name" title={f.path}>{f.path.split('/').pop()}</span>
                            <span className="scm-row-badge">{statusBadge(f)}</span>
                        </div>
                    ))}

                    {/* Changes */}
                    {changes.map((f) => {
                        const section = classifySection(f, false);
                        const badge = statusBadge(f);
                        const isUntracked = badge === '??';
                        return (
                            <div
                                key={`u-${f.path}`}
                                className={`scm-row scm-row--${section}`}
                                onClick={() => onOpenScm?.()}
                                style={{ height: 22, marginLeft: 0, marginRight: 0, padding: '0 8px 0 14px' }}
                                role="button"
                                tabIndex={0}
                            >
                                <span
                                    className={`scm-row-dot ${isUntracked ? 'scm-row-dot--untracked' : ''}`}
                                    aria-hidden="true"
                                />
                                <span className="scm-row-name" title={f.path}>{f.path.split('/').pop()}</span>
                                <span className={`scm-row-badge ${isUntracked ? 'scm-row-badge--untracked' : ''}`}>
                                    {badge}
                                </span>
                            </div>
                        );
                    })}

                    {/* Clean state */}
                    {totalChanges === 0 && conflicted.length === 0 && (
                        <div
                            className="px-2 py-2 text-center"
                            style={{ color: 'var(--text-muted)' }}
                        >
                            Nothing to commit
                        </div>
                    )}

                    {/* Open full view */}
                    <button
                        type="button"
                        onClick={() => onOpenScm?.()}
                        className="w-full mt-1 py-1 rounded-md text-[10px] font-medium th-action th-focus-ring"
                        style={{ color: 'var(--attention-purple)' }}
                    >
                        Open full view →
                    </button>
                </div>
            )}

            {/* Git not initialized */}
            {expanded && status === null && (
                <div
                    className="px-3 py-2 text-[11px] text-center"
                    style={{ color: 'var(--text-muted)' }}
                >
                    No git repository
                </div>
            )}
        </div>
    );
}

export default GitSummaryPanel;
