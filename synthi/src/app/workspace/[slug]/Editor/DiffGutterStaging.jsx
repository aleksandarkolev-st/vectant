'use client';
/**
 * DiffGutterStaging — Interactive gutter actions for the Monaco DiffEditor.
 *
 * Architecture:
 *   1. Uses Monaco's `deltaDecorations` API to add custom CSS classes
 *      (`glyphMarginClassName`) to every changed hunk in the modified editor.
 *   2. Attaches an `editor.onMouseDown` listener on the modified editor
 *      that intercepts glyph-margin clicks (`GUTTER_GLYPH_MARGIN`),
 *      preventing the default read-only editor warning.
 *   3. On gutter click, determines the line number, finds the enclosing hunk,
 *      and triggers selective staging via the backend.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { stageLines } from '@/redux/gitSlice';
import { gitClient } from '@/services/gitClient';
import { toast } from 'sonner';

/* ── CSS injected once into the document head ─────────────────── */
const STYLE_ID = 'diff-gutter-staging-styles';
function ensureStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .diff-gutter-stage-add {
            background: rgba(16, 185, 129, 0.35) !important;
            cursor: pointer !important;
        }
        .diff-gutter-stage-add::after {
            content: '+';
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            color: #10b981;
            font-weight: 700;
            font-size: 14px;
            pointer-events: none;
        }
        .diff-gutter-stage-add:hover {
            background: rgba(16, 185, 129, 0.55) !important;
        }
        .diff-gutter-stage-del {
            background: rgba(239, 68, 68, 0.30) !important;
            cursor: pointer !important;
        }
        .diff-gutter-stage-del::after {
            content: '−';
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            color: #ef4444;
            font-weight: 700;
            font-size: 14px;
            pointer-events: none;
        }
        .diff-gutter-stage-del:hover {
            background: rgba(239, 68, 68, 0.50) !important;
        }
        .diff-gutter-margin-highlight {
            background: rgba(52, 211, 153, 0.06) !important;
        }
    `;
    document.head.appendChild(style);
}

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
                selected.push({ ...line, type: 'context', raw: ' ' + line.content });
            }
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
    const decorationsRef = useRef([]);
    const hunksRef = useRef([]);
    const stagingRef = useRef(false);

    const enabled = !isCommitDiff && !!filePath && !!slug;

    // Stage a range of lines
    const handleStageRange = useCallback(async (startLine, endLine) => {
        if (stagingRef.current || !slug || !filePath) return;
        stagingRef.current = true;
        try {
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
            stagingRef.current = false;
        }
    }, [slug, filePath, dispatch]);

    // Wire up Monaco decorations + gutter click handler
    useEffect(() => {
        if (!enabled) return;
        ensureStyles();

        const editor = diffEditorRef?.current;
        if (!editor) return;
        const modifiedEditor = editor.getModifiedEditor?.();
        if (!modifiedEditor) return;

        // Enable the glyph margin on the modified editor so our decorations are visible
        modifiedEditor.updateOptions({ glyphMargin: true });

        const disposables = [];

        // Apply decorations for current hunks
        const applyDecorations = () => {
            try {
                const lineChanges = editor.getLineChanges();
                const newHunks = getHunkRanges(lineChanges);
                hunksRef.current = newHunks;

                const decorations = [];
                for (const hunk of newHunks) {
                    // Glyph margin decoration — clickable "+" or "−" marker
                    const glyphClass = hunk.isDeletion ? 'diff-gutter-stage-del' : 'diff-gutter-stage-add';
                    decorations.push({
                        range: {
                            startLineNumber: hunk.startLine,
                            startColumn: 1,
                            endLineNumber: hunk.startLine,
                            endColumn: 1,
                        },
                        options: {
                            glyphMarginClassName: glyphClass,
                            glyphMarginHoverMessage: {
                                value: `**Stage hunk** (lines ${hunk.startLine}–${hunk.endLine})\n\nClick to stage this change`,
                            },
                            stickiness: 1, // NeverGrowsWhenTypingAtEdges
                        },
                    });

                    // Highlight the margin for the full hunk range
                    decorations.push({
                        range: {
                            startLineNumber: hunk.startLine,
                            startColumn: 1,
                            endLineNumber: hunk.endLine,
                            endColumn: 1,
                        },
                        options: {
                            marginClassName: 'diff-gutter-margin-highlight',
                            stickiness: 1,
                        },
                    });
                }

                // deltaDecorations replaces old decorations atomically
                decorationsRef.current = modifiedEditor.deltaDecorations(
                    decorationsRef.current,
                    decorations
                );
            } catch (_) {}
        };

        applyDecorations();

        // Re-apply when diff updates
        const diffDisposable = editor.onDidUpdateDiff?.(() => applyDecorations());
        if (diffDisposable) disposables.push(diffDisposable);

        // Handle gutter clicks on the modified editor
        const mouseDisposable = modifiedEditor.onMouseDown((e) => {
            // Check if the click target is the glyph margin
            // Monaco MouseTargetType:  GUTTER_GLYPH_MARGIN = 2
            const GUTTER_GLYPH_MARGIN = 2;
            if (e.target?.type !== GUTTER_GLYPH_MARGIN) return;

            const lineNumber = e.target?.position?.lineNumber;
            if (!lineNumber) return;

            // Prevent the default "read-only editor" message
            e.event?.preventDefault?.();
            e.event?.stopPropagation?.();

            // Find which hunk this line belongs to
            const hunk = hunksRef.current.find(
                h => lineNumber >= h.startLine && lineNumber <= h.endLine
            );

            if (hunk) {
                handleStageRange(hunk.startLine, hunk.endLine);
            } else {
                // Clicked on a gutter line outside a hunk — stage the single line
                handleStageRange(lineNumber, lineNumber);
            }
        });
        disposables.push(mouseDisposable);

        return () => {
            // Clean up decorations
            try {
                decorationsRef.current = modifiedEditor.deltaDecorations(
                    decorationsRef.current,
                    []
                );
            } catch (_) {}
            // Dispose all listeners
            for (const d of disposables) d?.dispose?.();
        };
    }, [enabled, diffEditorRef, handleStageRange]);

    // This component manages Monaco state imperatively — no DOM to render
    return null;
}
