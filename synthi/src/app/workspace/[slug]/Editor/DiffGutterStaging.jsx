'use client';
/**
 * DiffGutterStaging — Interactive gutter actions for the Monaco DiffEditor.
 *
 * When the diff shows a working-copy comparison (not a historical commit diff),
 * this component overlays the modified editor with hover-activated buttons that
 * allow staging or reverting individual hunks or lines directly from the diff view.
 *
 * Architecture:
 *   1. We hook into Monaco's DiffEditor to read the computed line changes.
 *   2. For each contiguous block of changes (hunk), we render a floating
 *      "Stage Hunk" / "Revert Hunk" button aligned to the first line of
 *      the hunk in the gutter margin.
 *   3. Individual lines show a "+" gutter icon on hover to stage just that line.
 *   4. Staging is performed by building a unified-diff patch and dispatching
 *      the `stageLines` thunk (same backend path as HunkStagingView).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { stageLines } from '@/redux/gitSlice';
import { gitClient } from '@/services/gitClient';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';

/**
 * Parse a unified diff string into hunks for patch construction.
 */
function parseDiffToHunks(raw) {
    if (!raw) return { header: '', hunks: [] };
    const lines = raw.split('\n');
    let header = '';
    const hunks = [];
    let currentHunk = null;

    for (const line of lines) {
        if (line.startsWith('diff --git')) {
            header = line;
        } else if (line.startsWith('---') || line.startsWith('+++')) {
            header += '\n' + line;
        } else if (line.startsWith('@@')) {
            const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)/);
            if (match) {
                currentHunk = {
                    header: line,
                    oldStart: parseInt(match[1]),
                    oldCount: match[2] !== '' ? parseInt(match[2]) : 1,
                    newStart: parseInt(match[3]),
                    newCount: match[4] !== '' ? parseInt(match[4]) : 1,
                    context: match[5]?.trim() || '',
                    lines: [],
                };
                hunks.push(currentHunk);
            }
        } else if (currentHunk) {
            if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                currentHunk.lines.push({
                    type: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context',
                    content: line.substring(1),
                    raw: line,
                });
            }
        }
    }
    return { header, hunks };
}

/**
 * Build a valid patch that stages only lines within a specific line range
 * in the modified (new) file.
 */
function buildPatchForRange(header, hunks, startLine, endLine) {
    const headerLines = header.split('\n');
    const diffLine = headerLines.find(l => l.startsWith('diff --git')) || '';
    const minusLine = headerLines.find(l => l.startsWith('---')) || '';
    const plusLine = headerLines.find(l => l.startsWith('+++')) || '';
    if (!minusLine || !plusLine) return null;

    const parts = [];
    let hasContent = false;

    for (const hunk of hunks) {
        let newLineNum = hunk.newStart;
        const selected = [];
        let hasSelection = false;

        for (const line of hunk.lines) {
            const lineNum = line.type === 'remove' ? -1 : newLineNum;
            if (line.type !== 'remove') newLineNum++;

            if (line.type === 'context') {
                selected.push(line);
            } else if (lineNum >= startLine && lineNum <= endLine) {
                selected.push(line);
                hasSelection = true;
            } else if (line.type === 'remove') {
                // Unselected remove → context
                selected.push({ ...line, type: 'context', raw: ' ' + line.content });
            }
            // Unselected add → skip
        }

        if (!hasSelection) continue;
        hasContent = true;

        let oldCount = 0, newCount = 0;
        for (const l of selected) {
            if (l.type === 'context') { oldCount++; newCount++; }
            else if (l.type === 'remove') { oldCount++; }
            else if (l.type === 'add') { newCount++; }
        }

        const hunkHeader = `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.context ? ' ' + hunk.context : ''}`;
        const body = selected.map(l => {
            if (l.type === 'context') return ' ' + l.content;
            if (l.type === 'add') return '+' + l.content;
            if (l.type === 'remove') return '-' + l.content;
            return l.raw;
        }).join('\n');
        parts.push(hunkHeader + '\n' + body);
    }

    if (!hasContent) return null;
    return [diffLine, minusLine, plusLine, ...parts].join('\n') + '\n';
}


/** Compute visual hunk ranges from Monaco's line changes */
function getHunkRanges(lineChanges) {
    if (!lineChanges) return [];
    const hunks = [];

    for (const change of lineChanges) {
        const modStart = change.modifiedStartLineNumber;
        const modEnd = change.modifiedEndLineNumber || modStart;
        if (modStart === 0 && modEnd === 0) continue; // pure deletion
        hunks.push({
            startLine: modStart,
            endLine: modEnd,
            isInsertion: change.originalStartLineNumber === 0,
            isDeletion: change.modifiedStartLineNumber === 0,
        });
    }

    return hunks;
}

export default function DiffGutterStaging({ diffEditorRef, isCommitDiff, filePath }) {
    const dispatch = useAppDispatch();
    const slug = useAppSelector(state => state.workspace.slug);
    const [hunks, setHunks] = useState([]);
    const [hoveredHunk, setHoveredHunk] = useState(null);
    const [staging, setStaging] = useState(false);
    const containerRef = useRef(null);
    const [scrollTop, setScrollTop] = useState(0);

    // Don't render gutter for commit diffs (read-only)
    const enabled = !isCommitDiff && !!filePath && !!slug;

    // Refresh hunks when the diff editor computes changes
    useEffect(() => {
        if (!enabled) { setHunks([]); return; }
        const editor = diffEditorRef?.current;
        if (!editor) return;

        const updateHunks = () => {
            try {
                const changes = editor.getLineChanges();
                setHunks(getHunkRanges(changes));
            } catch (_) {}
        };

        updateHunks();
        const disposable = editor.onDidUpdateDiff?.(() => updateHunks());

        // Track scroll position of the modified editor for overlay positioning
        const modifiedEditor = editor.getModifiedEditor?.();
        let scrollDisposable;
        if (modifiedEditor) {
            scrollDisposable = modifiedEditor.onDidScrollChange?.((e) => {
                setScrollTop(e.scrollTop);
            });
        }

        return () => {
            disposable?.dispose?.();
            scrollDisposable?.dispose?.();
        };
    }, [enabled, diffEditorRef]);

    // Get the line height from the modified editor
    const getLineHeight = useCallback(() => {
        try {
            const editor = diffEditorRef?.current;
            const modifiedEditor = editor?.getModifiedEditor?.();
            if (modifiedEditor) {
                return modifiedEditor.getOption?.(/* lineHeight */ 66) || 19;
            }
        } catch (_) {}
        return 19;
    }, [diffEditorRef]);

    // Get the top coordinate of a line in the modified editor (viewport-relative)
    const getLineTop = useCallback((lineNumber) => {
        try {
            const editor = diffEditorRef?.current;
            const modifiedEditor = editor?.getModifiedEditor?.();
            if (modifiedEditor) {
                const top = modifiedEditor.getTopForLineNumber(lineNumber);
                return top - scrollTop;
            }
        } catch (_) {}
        return (lineNumber - 1) * getLineHeight();
    }, [diffEditorRef, scrollTop, getLineHeight]);

    // Stage a range of lines
    const handleStageRange = useCallback(async (startLine, endLine) => {
        if (staging || !slug || !filePath) return;
        setStaging(true);
        try {
            // Fetch the raw diff for this file
            const rawDiff = await gitClient.getDiff(slug, filePath, false);
            const diffText = typeof rawDiff === 'string' ? rawDiff : rawDiff?.raw || '';
            const parsed = parseDiffToHunks(diffText);
            const patch = buildPatchForRange(parsed.header, parsed.hunks, startLine, endLine);

            if (!patch) {
                toast.error('Could not build patch for selected range');
                return;
            }

            const result = await dispatch(stageLines({ slug, filePath, patch }));
            if (stageLines.fulfilled.match(result)) {
                const lineCount = endLine - startLine + 1;
                toast.success(`Staged ${lineCount} line${lineCount > 1 ? 's' : ''}`);
            } else {
                toast.error(result.error?.message || 'Failed to stage lines');
            }
        } catch (e) {
            toast.error(e.message || 'Staging failed');
        } finally {
            setStaging(false);
        }
    }, [staging, slug, filePath, dispatch]);

    if (!enabled || hunks.length === 0) return null;

    const lineHeight = getLineHeight();

    return (
        <div
            ref={containerRef}
            className="absolute left-0 top-0 bottom-0 pointer-events-none"
            style={{ width: '100%', zIndex: 5 }}
        >
            {hunks.map((hunk, i) => {
                const top = getLineTop(hunk.startLine);
                const height = (hunk.endLine - hunk.startLine + 1) * lineHeight;
                const isHovered = hoveredHunk === i;

                // Skip hunks that are outside the viewport
                if (top + height < -50 || top > window.innerHeight + 50) return null;

                return (
                    <div
                        key={`${hunk.startLine}-${hunk.endLine}`}
                        className="absolute pointer-events-auto"
                        style={{
                            top: top + 0, // offset for diff editor header
                            left: 0,
                            height,
                            display: 'flex',
                            alignItems: 'flex-start',
                            paddingTop: 2,
                        }}
                        onMouseEnter={() => setHoveredHunk(i)}
                        onMouseLeave={() => setHoveredHunk(null)}
                    >
                        {/* Gutter stripe — colored bar indicating the change region */}
                        <div
                            className="w-1 rounded-full flex-shrink-0 ml-0.5 transition-opacity"
                            style={{
                                height: height - 4,
                                marginTop: 2,
                                background: hunk.isDeletion ? '#ef4444' : '#10b981',
                                opacity: isHovered ? 1 : 0.4,
                            }}
                        />

                        {/* Hunk action buttons — visible on hover */}
                        {isHovered && (
                            <div
                                className="flex items-center gap-0.5 ml-1 flex-shrink-0"
                                style={{ marginTop: -1 }}
                            >
                                <button
                                    onClick={() => handleStageRange(hunk.startLine, hunk.endLine)}
                                    disabled={staging}
                                    className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors bg-emerald-600/90 hover:bg-emerald-500 text-white disabled:opacity-50 shadow-sm"
                                    title={`Stage hunk (lines ${hunk.startLine}–${hunk.endLine})`}
                                >
                                    <Plus className="w-2.5 h-2.5" />
                                    Stage Hunk
                                </button>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
