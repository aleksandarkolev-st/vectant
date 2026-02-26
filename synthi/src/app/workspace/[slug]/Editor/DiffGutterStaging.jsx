'use client';
/**
 * DiffGutterStaging — JetBrains/IntelliJ-style interactive staging for Monaco DiffEditor.
 *
 * Architecture:
 *   1. Suppresses the read-only tooltip on the modified editor.
 *   2. Uses `deltaDecorations` with checkbox-style glyphs on hunk start lines.
 *      Gutter clicks **toggle** the staging state of the entire enclosing hunk:
 *      ☐ (unchecked / unstaged) ↔ ☑ (checked / staged).
 *   3. Registers a custom context-menu action ("Stage Selected Lines") via
 *      `modifiedEditor.addAction()` so users can highlight specific lines,
 *      right-click, and stage only that selection — matching IntelliJ parity.
 *   4. Tracks per-hunk checked/unchecked state in React `useRef` so the
 *      checkbox visually reflects whether each hunk has been staged.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { stageLines, unstageLines } from '@/redux/gitSlice';
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
        /* ── Unchecked checkbox glyph for added hunks (☐) ── */
        .diff-gutter-stage-add {
            background: rgba(16, 185, 129, 0.18) !important;
            cursor: pointer !important;
            border-radius: 3px;
        }
        .diff-gutter-stage-add::after {
            content: '☐';
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            color: #34d399;
            font-size: 15px;
            line-height: 1;
            pointer-events: none;
        }
        .diff-gutter-stage-add:hover {
            background: rgba(16, 185, 129, 0.40) !important;
        }
        .diff-gutter-stage-add:hover::after {
            content: '☑';
            color: #10b981;
        }

        /* ── Checked checkbox glyph for added hunks (☑) ── */
        .diff-gutter-stage-add-checked {
            background: rgba(16, 185, 129, 0.30) !important;
            cursor: pointer !important;
            border-radius: 3px;
        }
        .diff-gutter-stage-add-checked::after {
            content: '☑';
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            color: #10b981;
            font-size: 15px;
            line-height: 1;
            pointer-events: none;
        }
        .diff-gutter-stage-add-checked:hover {
            background: rgba(16, 185, 129, 0.45) !important;
        }
        .diff-gutter-stage-add-checked:hover::after {
            content: '☐';
            color: #34d399;
        }

        /* ── Unchecked checkbox glyph for deleted hunks (☐) ── */
        .diff-gutter-stage-del {
            background: rgba(239, 68, 68, 0.18) !important;
            cursor: pointer !important;
            border-radius: 3px;
        }
        .diff-gutter-stage-del::after {
            content: '☐';
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            color: #f87171;
            font-size: 15px;
            line-height: 1;
            pointer-events: none;
        }
        .diff-gutter-stage-del:hover {
            background: rgba(239, 68, 68, 0.40) !important;
        }
        .diff-gutter-stage-del:hover::after {
            content: '☑';
            color: #ef4444;
        }

        /* ── Checked checkbox glyph for deleted hunks (☑) ── */
        .diff-gutter-stage-del-checked {
            background: rgba(239, 68, 68, 0.30) !important;
            cursor: pointer !important;
            border-radius: 3px;
        }
        .diff-gutter-stage-del-checked::after {
            content: '☑';
            display: flex;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            color: #ef4444;
            font-size: 15px;
            line-height: 1;
            pointer-events: none;
        }
        .diff-gutter-stage-del-checked:hover {
            background: rgba(239, 68, 68, 0.45) !important;
        }
        .diff-gutter-stage-del-checked:hover::after {
            content: '☐';
            color: #f87171;
        }

        /* ── Margin highlight for unstaged hunks ── */
        .diff-gutter-margin-highlight {
            background: rgba(52, 211, 153, 0.06) !important;
        }

        /* ── Margin highlight for staged hunks ── */
        .diff-gutter-margin-highlight-staged {
            background: rgba(16, 185, 129, 0.14) !important;
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
    const handleStageRangeRef = useRef(null);
    const handleUnstageRangeRef = useRef(null);
    // Track which hunks are checked (staged) — keyed by "startLine:endLine"
    const stagedHunksRef = useRef(new Set());
    // Reference to applyDecorations so it can be called after toggle
    const applyDecorationsRef = useRef(null);

    const enabled = !isCommitDiff && !!filePath && !!slug;

    /** Generate a stable key for a hunk based on its line range */
    const hunkKey = (startLine, endLine) => `${startLine}:${endLine}`;

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
                // Mark this hunk as staged
                stagedHunksRef.current.add(hunkKey(startLine, endLine));
                toast.success(`Staged ${lineCount} line${lineCount > 1 ? 's' : ''}`);
                // Re-apply decorations to reflect new checked state
                applyDecorationsRef.current?.();
            } else {
                toast.error(result.error?.message || 'Failed to stage lines');
            }
        } catch (e) {
            toast.error(e.message || 'Staging failed');
        } finally {
            stagingRef.current = false;
        }
    }, [slug, filePath, dispatch]);

    // Unstage (reverse-apply) a range of lines from the index
    const handleUnstageRange = useCallback(async (startLine, endLine) => {
        if (stagingRef.current || !slug || !filePath) return;
        stagingRef.current = true;
        try {
            const rawDiff = await gitClient.getDiff(slug, filePath, false);
            const diffText = typeof rawDiff === 'string' ? rawDiff : rawDiff?.raw || '';
            const parsed = parseDiffToHunks(diffText);
            const patch = buildPatchForRange(parsed.header, parsed.hunks, startLine, endLine);

            if (!patch) {
                toast.error('Could not build unstage patch for selected range');
                return;
            }

            // Use unstageLines to reverse-apply the patch from the index
            const result = await dispatch(unstageLines({ slug, filePath, patch }));
            if (unstageLines.fulfilled.match(result)) {
                const lineCount = endLine - startLine + 1;
                // Mark this hunk as unstaged
                stagedHunksRef.current.delete(hunkKey(startLine, endLine));
                toast.success(`Unstaged ${lineCount} line${lineCount > 1 ? 's' : ''}`);
                // Re-apply decorations to reflect new unchecked state
                applyDecorationsRef.current?.();
            } else {
                toast.error(result.error?.message || 'Failed to unstage lines');
            }
        } catch (e) {
            toast.error(e.message || 'Unstaging failed');
        } finally {
            stagingRef.current = false;
        }
    }, [slug, filePath, dispatch]);

    // Keep refs to the latest handlers so the context-menu action
    // (which is registered once) always calls the current closure.
    useEffect(() => {
        handleStageRangeRef.current = handleStageRange;
    }, [handleStageRange]);

    useEffect(() => {
        handleUnstageRangeRef.current = handleUnstageRange;
    }, [handleUnstageRange]);

    // Reset staged-hunks state when the file changes
    useEffect(() => {
        stagedHunksRef.current = new Set();
    }, [filePath]);

    // Wire up Monaco decorations + gutter click handler
    useEffect(() => {
        if (!enabled) return;
        ensureStyles();

        const editor = diffEditorRef?.current;
        if (!editor) return;
        const modifiedEditor = editor.getModifiedEditor?.();
        if (!modifiedEditor) return;

        // ── Suppress the read-only tooltip on the modified side ──
        modifiedEditor.updateOptions({
            glyphMargin: true,
            readOnlyMessage: { value: '' },
        });

        const disposables = [];

        // ── Context-menu action: "Stage Selected Lines" (IntelliJ parity) ──
        const actionDisposable = modifiedEditor.addAction({
            id: 'stage-selected-lines',
            label: 'Stage Selected Lines',
            contextMenuGroupId: 'navigation',
            contextMenuOrder: 0,
            precondition: undefined,
            run: () => {
                const selections = modifiedEditor.getSelections();
                if (!selections || selections.length === 0) return;

                // Compute the union of all selected line ranges
                let minLine = Infinity;
                let maxLine = -Infinity;
                for (const sel of selections) {
                    const start = sel.startLineNumber;
                    // If the cursor is at column 1 of the end line with no
                    // text selected on that line, exclude it.
                    let end = sel.endLineNumber;
                    if (sel.endColumn === 1 && end > start) end--;
                    if (start < minLine) minLine = start;
                    if (end > maxLine) maxLine = end;
                }
                if (minLine > maxLine) return;

                handleStageRangeRef.current?.(minLine, maxLine);
            },
        });
        disposables.push(actionDisposable);

        // Apply decorations for current hunks — reflects checked/unchecked state
        const applyDecorations = () => {
            try {
                const lineChanges = editor.getLineChanges();
                const newHunks = getHunkRanges(lineChanges);
                hunksRef.current = newHunks;

                const decorations = [];
                for (const hunk of newHunks) {
                    const key = `${hunk.startLine}:${hunk.endLine}`;
                    const isStaged = stagedHunksRef.current.has(key);

                    // Glyph margin decoration — checkbox reflects staging state
                    let glyphClass;
                    if (hunk.isDeletion) {
                        glyphClass = isStaged ? 'diff-gutter-stage-del-checked' : 'diff-gutter-stage-del';
                    } else {
                        glyphClass = isStaged ? 'diff-gutter-stage-add-checked' : 'diff-gutter-stage-add';
                    }

                    const hoverAction = isStaged ? 'Unstage' : 'Stage';
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
                                value: `**${hoverAction} hunk** (lines ${hunk.startLine}–${hunk.endLine})\n\nClick to ${hoverAction.toLowerCase()} this change`,
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
                            marginClassName: isStaged
                                ? 'diff-gutter-margin-highlight-staged'
                                : 'diff-gutter-margin-highlight',
                            stickiness: 1,
                        },
                    });
                }

                // deltaDecorations replaces old decorations atomically
                decorationsRef.current = modifiedEditor.deltaDecorations(
                    decorationsRef.current,
                    decorations
                );
            } catch (_) { /* editor may be disposed */ }
        };

        applyDecorationsRef.current = applyDecorations;

        applyDecorations();

        // Re-apply when diff updates
        const diffDisposable = editor.onDidUpdateDiff?.(() => applyDecorations());
        if (diffDisposable) disposables.push(diffDisposable);

        // ── Gutter clicks → toggle staging state of the enclosing hunk ──
        const mouseDisposable = modifiedEditor.onMouseDown((e) => {
            // Monaco MouseTargetType: GUTTER_GLYPH_MARGIN = 2
            const GUTTER_GLYPH_MARGIN = 2;
            if (e.target?.type !== GUTTER_GLYPH_MARGIN) return;

            const lineNumber = e.target?.position?.lineNumber;
            if (!lineNumber) return;

            // Prevent the default read-only editor message
            e.event?.preventDefault?.();
            e.event?.stopPropagation?.();

            // Find the enclosing hunk — gutter click always toggles the full hunk
            const hunk = hunksRef.current.find(
                h => lineNumber >= h.startLine && lineNumber <= h.endLine
            );
            if (hunk) {
                const key = hunkKey(hunk.startLine, hunk.endLine);
                const isCurrentlyStaged = stagedHunksRef.current.has(key);
                if (isCurrentlyStaged) {
                    // Toggle OFF → unstage the hunk
                    handleUnstageRange(hunk.startLine, hunk.endLine);
                } else {
                    // Toggle ON → stage the hunk
                    handleStageRange(hunk.startLine, hunk.endLine);
                }
            }
            // If no enclosing hunk was found, do nothing (no single-line fallback)
        });
        disposables.push(mouseDisposable);

        return () => {
            // Clean up decorations
            try {
                decorationsRef.current = modifiedEditor.deltaDecorations(
                    decorationsRef.current,
                    []
                );
            } catch (_) { /* editor may be disposed */ }
            applyDecorationsRef.current = null;
            // Dispose all listeners and the context-menu action
            for (const d of disposables) d?.dispose?.();
        };
    }, [enabled, diffEditorRef, handleStageRange, handleUnstageRange]);

    // This component manages Monaco state imperatively — no DOM to render
    return null;
}
