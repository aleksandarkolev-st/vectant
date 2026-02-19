import { useCallback, useEffect, useRef } from 'react';
import { diffLines } from 'diff';

export const useDiffManager = ({
    latestCompletion,
    editorInstance,
    monacoInstance,
    activeLanguage,
    activeFile,
    notifyCompletionCleared,
    aiCompletionCacheRef,
    diffChunksRef = null,
    activeFileIdentity = null
}) => {
    const _internalAiDiffChunksRef = useRef(new Map());
    const aiDiffChunksRef = diffChunksRef || _internalAiDiffChunksRef;

    const removeDiffChunkVisuals = useCallback((chunkId) => {
        if (!editorInstance) return;
        const chunk = aiDiffChunksRef.current.get(chunkId);
        if (!chunk) return;
        try {
            if (chunk.decorationIds?.length) {
                editorInstance.deltaDecorations(chunk.decorationIds, []);
                chunk.decorationIds = [];
            }
        } catch (e) {}
        try {
            if (chunk.viewZoneId) {
                editorInstance.changeViewZones(accessor => accessor.removeZone(chunk.viewZoneId));
                chunk.viewZoneId = null;
            }
        } catch (e) {}
    }, [editorInstance, aiDiffChunksRef]);

    const clearAllChunks = useCallback(() => {
        aiDiffChunksRef.current.forEach((_, chunkId) => removeDiffChunkVisuals(chunkId));
        aiDiffChunksRef.current.clear();
        aiCompletionCacheRef.current._decorationIds = [];
        aiCompletionCacheRef.current._diffViewZoneIds = [];
    }, [removeDiffChunkVisuals, aiCompletionCacheRef, aiDiffChunksRef]);

    const handleRejectDiffChunk = useCallback((chunkId) => {
        removeDiffChunkVisuals(chunkId);
        aiDiffChunksRef.current.delete(chunkId);
        if (aiDiffChunksRef.current.size === 0) {
            notifyCompletionCleared();
        }
    }, [removeDiffChunkVisuals, notifyCompletionCleared, aiDiffChunksRef]);

    const handleAcceptDiffChunk = useCallback((chunkId) => {
        if (!editorInstance || !monacoInstance) return;
        const chunk = aiDiffChunksRef.current.get(chunkId);
        if (!chunk) return;
        const model = editorInstance.getModel();
        if (!model) return;

        const addedText = chunk.addLines.length
            ? chunk.addLines.join('\n') + (chunk.addTrailingNewline ? '\n' : '')
            : '';

        let range = null;
        if (chunk.removeLines.length) {
            const startLine = Math.max(1, chunk.removeStartLine);
            const endLine = Math.max(startLine, startLine + chunk.removeLines.length - 1);
            const endColumn = model.getLineLength(endLine) + 1;
            range = new monacoInstance.Range(startLine, 1, endLine, endColumn);
        } else {
            const insertLine = Math.min(model.getLineCount() + 1, Math.max(0, chunk.additionAfterLine) + 1);
            range = new monacoInstance.Range(insertLine, 1, insertLine, 1);
        }

        try {
            editorInstance.executeEdits('ai-chunk', [{ range, text: addedText, forceMoveMarkers: true }]);
            editorInstance.pushUndoStop();
        } catch (e) {
            console.error('Failed to apply diff chunk', e);
        }

        handleRejectDiffChunk(chunkId);
        if (aiDiffChunksRef.current.size === 0) {
            notifyCompletionCleared();
        }
    }, [editorInstance, monacoInstance, handleRejectDiffChunk, notifyCompletionCleared, aiDiffChunksRef]);

    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        const resolved = typeof latestCompletion === 'string'
            ? { completion: latestCompletion }
            : (latestCompletion || null);
        const suggested = resolved?.completion || null;
        const isPartial = Boolean(resolved?.partial);
        const sourceLang = resolved?.language || null;
        const sourcePath = resolved?.filePath || null;

        if (isPartial) {
            return;
        }

        if (sourceLang && sourceLang !== activeLanguage) return;
        if (sourcePath && (sourcePath !== (activeFile?.path || activeFile?.name))) return;

        clearAllChunks();

        if (!suggested) return;

        const model = editorInstance.getModel();
        if (!model) return;

        const normalizeEol = (v = '') => v.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const original = normalizeEol(model.getValue());
        const normalizedSuggested = normalizeEol(suggested);
        const parts = diffLines(original, normalizedSuggested);

        const chunks = [];
        let chunkCounter = 0;
        let activeChunk = null;
        let oldLine = 1;
        let newLine = 1;

        const finalizeChunk = () => {
            if (!activeChunk) return;
            const removeCount = activeChunk.removeLines.length;
            const additionAfterLine = removeCount
                ? activeChunk.removeStartLine + removeCount - 1
                : activeChunk.contextBeforeLine;
            activeChunk.additionAfterLine = Math.max(0, additionAfterLine);
            if (!removeCount) {
                activeChunk.removeStartLine = Math.max(1, activeChunk.contextBeforeLine + 1);
            }
            chunks.push(activeChunk);
            activeChunk = null;
        };

        parts.forEach((part) => {
            const rawValue = part.value || '';
            const lines = rawValue.split('\n');
            if (lines.length && lines[lines.length - 1] === '') lines.pop();

            if (part.added || part.removed) {
                if (!activeChunk) {
                    activeChunk = {
                        id: `chunk-${chunkCounter++}`,
                        removeStartLine: Math.max(1, oldLine),
                        contextBeforeLine: Math.max(0, oldLine - 1),
                        removeLines: [],
                        addLines: [],
                        addTrailingNewline: false,
                        additionAfterLine: Math.max(0, oldLine - 1),
                        decorationIds: [],
                        viewZoneId: null,
                    };
                }
                if (part.removed && lines.length) {
                    activeChunk.removeLines.push(...lines);
                    oldLine += lines.length;
                }
                if (part.added && lines.length) {
                    activeChunk.addLines.push(...lines);
                    activeChunk.addTrailingNewline = rawValue.endsWith('\n');
                    newLine += lines.length;
                }
            } else {
                finalizeChunk();
                oldLine += lines.length;
                newLine += lines.length;
            }
        });
        finalizeChunk();

        if (!document.getElementById('ai-inline-diff-style')) {
            const style = document.createElement('style');
            style.id = 'ai-inline-diff-style';
            style.innerHTML = `
                /* ── Removed lines in editor ─────────────────────── */
                .ai-remove-chunk {
                    background: rgba(255, 107, 107, 0.07) !important;
                }
                .ai-remove-gutter {
                    margin-left: 8px;
                    width: 3px !important;
                    height: 100% !important;
                    border-radius: 0 !important;
                    background: rgba(255, 107, 107, 0.50) !important;
                }

                /* ── Shared zone base ────────────────────────────── */
                .ai-diff-zone {
                    font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
                    font-size: 12px;
                    margin: 0;
                    overflow: visible;
                }

                /* ── Addition zone ───────────────────────────────── */
                .ai-diff-zone.add {
                    border-left: 3px solid rgba(58, 133, 116, 0.6);
                    background: rgba(58, 133, 116, 0.04);
                }
                .ai-diff-zone.add .ai-diff-bar {
                    background: rgba(58, 133, 116, 0.06);
                    border-bottom: 1px solid rgba(58, 133, 116, 0.10);
                }
                .ai-diff-zone.add .ai-diff-tag {
                    color: #4aba9a;
                }
                .ai-diff-zone.add pre {
                    color: #a2c4b8;
                }

                /* ── Removal zone ────────────────────────────────── */
                .ai-diff-zone.rem {
                    border-left: 3px solid rgba(255, 107, 107, 0.5);
                    background: rgba(255, 107, 107, 0.03);
                }
                .ai-diff-zone.rem .ai-diff-bar {
                    background: rgba(255, 107, 107, 0.05);
                    border-bottom: 1px solid rgba(255, 107, 107, 0.08);
                }
                .ai-diff-zone.rem .ai-diff-tag {
                    color: #ff8a8a;
                }

                /* ── Top bar (label + buttons) ───────────────────── */
                .ai-diff-bar {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 4px 10px;
                    user-select: none;
                }
                .ai-diff-tag {
                    font-size: 10px;
                    font-weight: 600;
                    letter-spacing: 0.5px;
                    text-transform: uppercase;
                }
                .ai-diff-actions {
                    display: flex;
                    gap: 4px;
                }

                /* ── Buttons ─────────────────────────────────────── */
                .ai-diff-btn {
                    font-family: inherit;
                    font-size: 11px;
                    padding: 2px 10px;
                    border-radius: 4px;
                    border: none;
                    cursor: pointer;
                    transition: background 80ms;
                    outline: none;
                    line-height: 1.4;
                }
                .ai-diff-btn.accept {
                    background: rgba(58, 133, 116, 0.18);
                    color: #4aba9a;
                }
                .ai-diff-btn.accept:hover {
                    background: rgba(58, 133, 116, 0.32);
                }
                .ai-diff-btn.reject {
                    background: transparent;
                    color: #5a6178;
                }
                .ai-diff-btn.reject:hover {
                    color: #ff8a8a;
                    background: rgba(255, 107, 107, 0.08);
                }

                /* ── Code block ──────────────────────────────────── */
                .ai-diff-zone pre {
                    margin: 0;
                    padding: 4px 12px 6px;
                    background: transparent;
                    border: none;
                    font-size: 12px;
                    line-height: 19px;
                    overflow-x: auto;
                    overflow-y: visible;
                }
                .ai-diff-zone pre::-webkit-scrollbar { width: 4px; height: 4px; }
                .ai-diff-zone pre::-webkit-scrollbar-track { background: transparent; }
                .ai-diff-zone pre::-webkit-scrollbar-thumb { background: #2a2b38; border-radius: 2px; }
            `;
            document.head.appendChild(style);
        }

        chunks.forEach((chunk) => {
            aiDiffChunksRef.current.set(chunk.id, chunk);

            if (chunk.removeLines.length) {
                const startLine = Math.max(1, chunk.removeStartLine);
                const endLine = Math.max(startLine, startLine + chunk.removeLines.length - 1);
                const endColumn = model.getLineLength(endLine) + 1;
                const ids = editorInstance.deltaDecorations([], [{
                    range: new monacoInstance.Range(startLine, 1, endLine, endColumn),
                    options: {
                        isWholeLine: true,
                        className: 'ai-remove-chunk',
                        linesDecorationsClassName: 'ai-remove-gutter',
                        minimap: { color: '#ff6b6b', position: monacoInstance.editor.MinimapPosition.Inline },
                        overviewRuler: { color: '#ff6b6b', position: monacoInstance.editor.OverviewRulerLane.Center },
                    }
                }]);
                chunk.decorationIds = ids;
            }

            // Minimap marker for added lines (placed after insertion point)
            if (chunk.addLines.length > 0) {
                const afterLine = Math.max(1, chunk.additionAfterLine);
                const mmIds = editorInstance.deltaDecorations([], [{
                    range: new monacoInstance.Range(afterLine, 1, afterLine, 1),
                    options: {
                        isWholeLine: true,
                        className: 'ai-add-minimap',
                        minimap: { color: '#3a8574', position: monacoInstance.editor.MinimapPosition.Inline },
                        overviewRuler: { color: '#3a8574', position: monacoInstance.editor.OverviewRulerLane.Center },
                    }
                }]);
                chunk.decorationIds = [...(chunk.decorationIds || []), ...mmIds];
            }

            chunk.addLines = chunk.addLines || [];
            const hasAdditions = chunk.addLines.length > 0;
            const hasOnlyRemovals = !hasAdditions && chunk.removeLines.length > 0;

            if (hasAdditions) {
                const zoneWrapper = document.createElement('div');
                zoneWrapper.style.pointerEvents = 'auto';
                zoneWrapper.style.userSelect = 'none';
                zoneWrapper.style.position = 'relative';
                zoneWrapper.style.zIndex = '5';

                const zone = document.createElement('div');
                zone.className = 'ai-diff-zone add';
                zone.style.pointerEvents = 'auto';

                // ── Bar: label + buttons ────────────────────
                const bar = document.createElement('div');
                bar.className = 'ai-diff-bar';

                const tag = document.createElement('span');
                tag.className = 'ai-diff-tag';
                tag.textContent = `AI suggestion · ${chunk.addLines.length} ${chunk.addLines.length === 1 ? 'line' : 'lines'}`;

                const actions = document.createElement('div');
                actions.className = 'ai-diff-actions';

                const acceptBtn = document.createElement('button');
                acceptBtn.className = 'ai-diff-btn accept';
                acceptBtn.textContent = 'Accept';
                acceptBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); handleAcceptDiffChunk(chunk.id); };

                const rejectBtn = document.createElement('button');
                rejectBtn.className = 'ai-diff-btn reject';
                rejectBtn.textContent = 'Reject';
                rejectBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); handleRejectDiffChunk(chunk.id); };

                actions.appendChild(acceptBtn);
                actions.appendChild(rejectBtn);
                bar.appendChild(tag);
                bar.appendChild(actions);
                zone.appendChild(bar);

                // ── Code ────────────────────────────────────
                if (chunk.addLines.length) {
                    const code = document.createElement('pre');
                    code.textContent = chunk.addLines.join('\n');
                    zone.appendChild(code);
                }

                zoneWrapper.appendChild(zone);

                // Height: bar (~26px) + code lines + padding (~12px)
                const codeLineH = 19;
                const codeBlockH = Math.max(chunk.addLines.length, 1) * codeLineH;
                const chromeH = 26 + 12;
                const estimatedAddHeight = codeBlockH + chromeH;
                let zoneId = null;
                editorInstance.changeViewZones(accessor => {
                    zoneId = accessor.addZone({
                        afterLineNumber: Math.max(0, chunk.additionAfterLine),
                        heightInPx: estimatedAddHeight,
                        domNode: zoneWrapper
                    });
                });
                chunk.viewZoneId = zoneId;
                // Double-rAF: first frame triggers layout, second reads correct scrollHeight
                if (zoneId) {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            const measured = zoneWrapper.scrollHeight;
                            if (!measured) return;
                            const desired = measured + 8; // small buffer
                            if (Math.abs(desired - estimatedAddHeight) > 4) {
                                try {
                                    editorInstance.changeViewZones(accessor => {
                                        accessor.removeZone(chunk.viewZoneId);
                                        const newId = accessor.addZone({
                                            afterLineNumber: Math.max(0, chunk.additionAfterLine),
                                            heightInPx: desired,
                                            domNode: zoneWrapper
                                        });
                                        chunk.viewZoneId = newId;
                                    });
                                } catch (_) {}
                            }
                        });
                    });
                }
            }

            if (hasOnlyRemovals) {
                const zoneWrapper = document.createElement('div');
                zoneWrapper.style.pointerEvents = 'auto';
                zoneWrapper.style.userSelect = 'none';
                zoneWrapper.style.position = 'relative';
                zoneWrapper.style.zIndex = '5';

                const zone = document.createElement('div');
                zone.className = 'ai-diff-zone rem';
                zone.style.pointerEvents = 'auto';

                const bar = document.createElement('div');
                bar.className = 'ai-diff-bar';

                const tag = document.createElement('span');
                tag.className = 'ai-diff-tag';
                tag.textContent = `Remove ${chunk.removeLines.length} ${chunk.removeLines.length === 1 ? 'line' : 'lines'}`;

                const actions = document.createElement('div');
                actions.className = 'ai-diff-actions';

                const acceptBtn = document.createElement('button');
                acceptBtn.className = 'ai-diff-btn accept';
                acceptBtn.textContent = 'Accept';
                acceptBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); handleAcceptDiffChunk(chunk.id); };

                const rejectBtn = document.createElement('button');
                rejectBtn.className = 'ai-diff-btn reject';
                rejectBtn.textContent = 'Keep';
                rejectBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); handleRejectDiffChunk(chunk.id); };

                actions.appendChild(acceptBtn);
                actions.appendChild(rejectBtn);
                bar.appendChild(tag);
                bar.appendChild(actions);
                zone.appendChild(bar);
                zoneWrapper.appendChild(zone);

                // Single bar — compact height
                const initialHeight = 30;
                let zoneId = null;
                editorInstance.changeViewZones(accessor => {
                    zoneId = accessor.addZone({
                        afterLineNumber: Math.max(0, chunk.removeStartLine + chunk.removeLines.length - 1),
                        heightInPx: initialHeight,
                        domNode: zoneWrapper
                    });
                });
                chunk.viewZoneId = zoneId;
                // Double-rAF for reliable measurement
                if (zoneId) {
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            const measured = zoneWrapper.scrollHeight;
                            if (!measured) return;
                            const desired = measured + 8;
                            if (Math.abs(desired - initialHeight) > 4) {
                                try {
                                    editorInstance.changeViewZones(accessor => {
                                        accessor.removeZone(chunk.viewZoneId);
                                        const newId = accessor.addZone({
                                            afterLineNumber: Math.max(0, chunk.removeStartLine + chunk.removeLines.length - 1),
                                            heightInPx: desired,
                                            domNode: zoneWrapper
                                        });
                                        chunk.viewZoneId = newId;
                                    });
                                } catch (_) {}
                            }
                        });
                    });
                }
            }
        });

        return () => {
            clearAllChunks();
        };
    }, [latestCompletion, editorInstance, monacoInstance, handleAcceptDiffChunk, handleRejectDiffChunk, removeDiffChunkVisuals, activeLanguage, activeFile, clearAllChunks, aiDiffChunksRef]);

    useEffect(() => {
        if (!activeFileIdentity) return;
        clearAllChunks();
        notifyCompletionCleared();
    }, [activeFileIdentity, clearAllChunks, notifyCompletionCleared]);

    const hasActiveDiff = useCallback(() => aiDiffChunksRef.current.size > 0, [aiDiffChunksRef]);

    return {
        aiDiffChunksRef,
        removeDiffChunkVisuals,
        handleRejectDiffChunk,
        handleAcceptDiffChunk,
        hasActiveDiff,
        clearAllChunks
    };
};
