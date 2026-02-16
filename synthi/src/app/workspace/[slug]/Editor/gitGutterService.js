/**
 * gitGutterService.js — Git diff gutter decorations for Monaco Editor
 *
 * Shows colored bars in the editor gutter indicating:
 *   - Green  bar: Added lines (new code not in HEAD)
 *   - Blue   bar: Modified lines (changed relative to HEAD)
 *   - Red  arrow: Deleted lines (code removed relative to HEAD)
 *
 * Approach:
 *   - Fetch HEAD content once per file via gitClient.getFileContent()
 *   - Attach a direct onDidChangeModelContent listener for instant updates
 *   - Diff is line-level using the `diff` library's diffArrays
 *   - Decorations are fully replaced on each update (no stickiness drift)
 */

import { diffArrays } from 'diff';
import { useEffect, useRef, useCallback } from 'react';
import { gitClient } from '@/services/gitClient';
import { ensurePeekStyles, createPeekWidget, dismissPeekWidget, revertHunk } from './gitGutterPeek';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 150; // Fast debounce — only enough to batch rapid keystrokes

// CSS class names
const CLASS_ADDED    = 'git-gutter-added';
const CLASS_MODIFIED = 'git-gutter-modified';
const CLASS_DELETED  = 'git-gutter-deleted';

// ─── Style injection ────────────────────────────────────────────────────────

const STYLE_ID = 'git-gutter-style';

function ensureGitGutterStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    // linesDecorationsClassName elements sit in the decoration lane between
    // glyph margin and code. We use a left-margin to push the bar away from
    // line numbers. The lane width is controlled by lineDecorationsWidth (24px).
    style.innerHTML = `
        .${CLASS_ADDED},
        .${CLASS_MODIFIED},
        .${CLASS_DELETED} {
            margin-left: 8px;
            width: 3px !important;
            height: 100% !important;
            border-radius: 0 !important;
        }
        .${CLASS_ADDED} {
            background: #a8e6cf !important;
        }
        .${CLASS_MODIFIED} {
            background: #88c0fc !important;
        }
        .${CLASS_DELETED} {
            background: #ff6b6b !important;
        }
    `;
    document.head.appendChild(style);
}

// ─── Line normalization ─────────────────────────────────────────────────────

function normalize(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ─── Diff computation ───────────────────────────────────────────────────────

/**
 * @typedef {{ type: 'added'|'modified'|'deleted', startLine: number, endLine: number }} GutterChange
 */

/**
 * Compare HEAD content against current content and produce gutter change ranges.
 *
 * @param {string} headContent - File content at HEAD
 * @param {string} currentContent - Current editor content
 * @returns {GutterChange[]}
 */
export function computeGutterChanges(headContent, currentContent) {
    const oldText = normalize(headContent);
    const newText = normalize(currentContent);
    if (oldText === newText) return [];

    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    const diffs = diffArrays(oldLines, newLines);

    const changes = [];
    let newLineNum = 1;
    let oldLineNum = 1;
    let hunkCounter = 0;

    for (let i = 0; i < diffs.length; i++) {
        const part = diffs[i];

        if (!part.added && !part.removed) {
            newLineNum += part.count;
            oldLineNum += part.count;
            continue;
        }

        const next = diffs[i + 1];

        if (part.removed && next && next.added) {
            const removedCount = part.count;
            const addedCount = next.count;
            const minCount = Math.min(removedCount, addedCount);
            const hid = ++hunkCounter;
            const blockOldStart = oldLineNum;
            const blockOldEnd = oldLineNum + removedCount - 1;

            if (minCount > 0) {
                changes.push({
                    type: 'modified',
                    startLine: newLineNum,
                    endLine: newLineNum + minCount - 1,
                    oldStartLine: blockOldStart,
                    oldEndLine: blockOldEnd,
                    hunkId: hid,
                });
            }

            if (addedCount > removedCount) {
                changes.push({
                    type: 'added',
                    startLine: newLineNum + minCount,
                    endLine: newLineNum + addedCount - 1,
                    oldStartLine: blockOldStart,
                    oldEndLine: blockOldEnd,
                    hunkId: hid,
                });
            }

            if (removedCount > addedCount) {
                const delLine = newLineNum + addedCount > 1 ? newLineNum + addedCount - 1 : newLineNum;
                changes.push({ type: 'deleted', startLine: delLine, endLine: delLine, oldStartLine: blockOldStart, oldEndLine: blockOldEnd, hunkId: hid });
            }

            newLineNum += addedCount;
            oldLineNum += removedCount;
            i++;
            continue;
        }

        if (part.added) {
            changes.push({ type: 'added', startLine: newLineNum, endLine: newLineNum + part.count - 1, oldStartLine: 0, oldEndLine: 0, hunkId: ++hunkCounter });
            newLineNum += part.count;
            continue;
        }

        if (part.removed) {
            const markerLine = Math.max(1, newLineNum - 1);
            changes.push({ type: 'deleted', startLine: markerLine, endLine: markerLine, oldStartLine: oldLineNum, oldEndLine: oldLineNum + part.count - 1, hunkId: ++hunkCounter });
            oldLineNum += part.count;
            continue;
        }
    }

    return changes;
}

// ─── Monaco decoration builder ──────────────────────────────────────────────

export function buildDecorations(changes, monacoModule) {
    return changes.map(({ type, startLine, endLine }) => {
        if (type === 'deleted') {
            return {
                range: new monacoModule.Range(startLine, 1, startLine, 1),
                options: {
                    isWholeLine: true,
                    linesDecorationsClassName: CLASS_DELETED,
                    // NeverGrows — we fully replace all decorations each time
                    stickiness: monacoModule.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                    overviewRuler: {
                        color: '#ff6b6b',
                        position: monacoModule.editor.OverviewRulerLane.Left,
                    },
                },
            };
        }

        const cls        = type === 'added' ? CLASS_ADDED : CLASS_MODIFIED;
        const rulerColor = type === 'added' ? '#3def3a' : '#1871d0';

        return {
            range: new monacoModule.Range(startLine, 1, endLine, 1),
            options: {
                isWholeLine: true,
                linesDecorationsClassName: cls,
                stickiness: monacoModule.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                overviewRuler: {
                    color: rulerColor,
                    position: monacoModule.editor.OverviewRulerLane.Left,
                },
            },
        };
    });
}

// ─── React hook ─────────────────────────────────────────────────────────────

export function useGitGutter({ editorInstance, monacoInstance, activeFile, slug }) {
    ensureGitGutterStyles();
    ensurePeekStyles();

    const decorationIdsRef  = useRef([]);
    const headContentRef    = useRef(null);
    const headFilePathRef   = useRef(null);
    const headLinesRef      = useRef([]);
    const debounceTimerRef  = useRef(null);
    const changesRef        = useRef([]);
    const peekRef           = useRef(null); // { hunkId, zoneId, domNode, highlightIds }

    // ── Dismiss active peek ─────────────────────────────────────────────
    const dismissPeek = useCallback(() => {
        if (!peekRef.current || !editorInstance) return;
        dismissPeekWidget(editorInstance, peekRef.current);
        if (peekRef.current.highlightIds?.length > 0) {
            try { editorInstance.deltaDecorations(peekRef.current.highlightIds, []); } catch (_) {}
        }
        peekRef.current = null;
    }, [editorInstance]);

    // ── Core: recompute + apply gutter decorations ──────────────────────
    const refresh = useCallback(() => {
        if (!editorInstance || !monacoInstance) return;
        const model = editorInstance.getModel();
        if (!model) return;

        const currentContent = model.getValue();
        const headText = headContentRef.current;

        let changes;
        if (headText === null || headText === undefined) {
            const lc = model.getLineCount();
            changes = lc > 0
                ? [{ type: 'added', startLine: 1, endLine: lc, oldStartLine: 0, oldEndLine: 0, hunkId: 0 }]
                : [];
        } else {
            changes = computeGutterChanges(headText, currentContent);
        }

        changesRef.current = changes;

        const decorations = buildDecorations(changes, monacoInstance);

        try {
            decorationIdsRef.current = editorInstance.deltaDecorations(
                decorationIdsRef.current,
                decorations,
            );
        } catch (_) {}
    }, [editorInstance, monacoInstance]);

    // ── Fetch HEAD content on file switch ────────────────────────────────
    useEffect(() => {
        headContentRef.current  = null;
        headFilePathRef.current = null;
        headLinesRef.current    = [];
        changesRef.current      = [];
        dismissPeek();

        if (editorInstance && decorationIdsRef.current.length > 0) {
            try { editorInstance.deltaDecorations(decorationIdsRef.current, []); } catch (_) {}
            decorationIdsRef.current = [];
        }

        if (!activeFile?.path || !slug) return;

        let cancelled = false;

        (async () => {
            try {
                const result = await gitClient.getFileContent(slug, activeFile.path, 'HEAD');
                if (cancelled) return;
                const raw = result?.content ?? result ?? '';
                headContentRef.current  = raw;
                headLinesRef.current    = normalize(raw).split('\n');
            } catch (_) {
                if (cancelled) return;
                headContentRef.current = null;
                headLinesRef.current   = [];
            }
            headFilePathRef.current = activeFile.path;
            if (!cancelled) refresh();
        })();

        return () => { cancelled = true; };
    }, [activeFile?.path, slug, editorInstance, refresh, dismissPeek]);

    // ── Listen to model content changes directly ─────────────────────────
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        const disposable = editorInstance.onDidChangeModelContent(() => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
            debounceTimerRef.current = setTimeout(refresh, DEBOUNCE_MS);
        });

        refresh();

        return () => {
            disposable.dispose();
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        };
    }, [editorInstance, monacoInstance, refresh]);

    // ── Gutter click → show / toggle peek ────────────────────────────────
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        const mouseDisposable = editorInstance.onMouseDown(e => {
            const target = e.target;

            // Ignore clicks inside our own peek widget
            if (peekRef.current?.domNode) {
                const rawEl = target.element || e.event?.target;
                if (rawEl && peekRef.current.domNode.contains(rawEl)) return;
            }

            // Gutter bar click
            if (target.type === monacoInstance.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
                const lineNumber = target.position?.lineNumber;
                if (!lineNumber) return;

                const changes = changesRef.current;
                const clicked = changes.find(
                    c => lineNumber >= c.startLine && lineNumber <= c.endLine,
                );

                if (!clicked) {
                    // Gutter click on a line without a change — dismiss peek
                    if (peekRef.current) dismissPeek();
                    return;
                }

                // Toggle: clicking the same hunk closes the peek
                if (peekRef.current?.hunkId === clicked.hunkId) {
                    dismissPeek();
                    return;
                }

                dismissPeek();

                // Collect all changes in this hunk (for revert)
                const hunkChanges = changes.filter(c => c.hunkId === clicked.hunkId);

                const peekState = createPeekWidget(
                    editorInstance,
                    clicked,
                    headLinesRef.current,
                    () => {
                        revertHunk(editorInstance, monacoInstance, hunkChanges, headLinesRef.current);
                        dismissPeek();
                    },
                    () => { dismissPeek(); },
                );

                // Highlight the changed lines
                const hStart = Math.min(...hunkChanges.map(c => c.startLine));
                const hEnd   = Math.max(...hunkChanges.map(c => c.endLine));
                let highlightIds = [];
                try {
                    highlightIds = editorInstance.deltaDecorations([], [{
                        range: new monacoInstance.Range(hStart, 1, hEnd, 1),
                        options: {
                            isWholeLine: true,
                            className: 'git-peek-highlight',
                            stickiness: monacoInstance.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                        },
                    }]);
                } catch (_) {}

                peekRef.current = {
                    hunkId: clicked.hunkId,
                    zoneId: peekState.zoneId,
                    domNode: peekState.domNode,
                    highlightIds,
                };
                return;
            }

            // Click elsewhere — dismiss peek
            if (peekRef.current) dismissPeek();
        });

        // Escape to dismiss
        const keyDisposable = editorInstance.onKeyDown(e => {
            if (e.keyCode === monacoInstance.KeyCode.Escape && peekRef.current) {
                e.preventDefault();
                e.stopPropagation();
                dismissPeek();
            }
        });

        return () => {
            mouseDisposable.dispose();
            keyDisposable.dispose();
        };
    }, [editorInstance, monacoInstance, dismissPeek]);

    // ── Cleanup ─────────────────────────────────────────────────────────
    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
            dismissPeek();
            if (editorInstance && decorationIdsRef.current.length > 0) {
                try { editorInstance.deltaDecorations(decorationIdsRef.current, []); } catch (_) {}
            }
            decorationIdsRef.current = [];
        };
    }, [editorInstance, dismissPeek]);
}
