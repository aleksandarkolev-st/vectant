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
    const aiDiffChunksRef = diffChunksRef || useRef(new Map());

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
    }, [editorInstance]);

    const clearAllChunks = useCallback(() => {
        aiDiffChunksRef.current.forEach((_, chunkId) => removeDiffChunkVisuals(chunkId));
        aiDiffChunksRef.current.clear();
        aiCompletionCacheRef.current._decorationIds = [];
        aiCompletionCacheRef.current._diffViewZoneIds = [];
    }, [removeDiffChunkVisuals, aiCompletionCacheRef]);

    const handleRejectDiffChunk = useCallback((chunkId) => {
        removeDiffChunkVisuals(chunkId);
        aiDiffChunksRef.current.delete(chunkId);
        if (aiDiffChunksRef.current.size === 0) {
            notifyCompletionCleared();
        }
    }, [removeDiffChunkVisuals, notifyCompletionCleared]);

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
    }, [editorInstance, monacoInstance, handleRejectDiffChunk, notifyCompletionCleared]);

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
                .ai-remove-chunk { background: rgba(239,68,68,0.18) !important; border-left: 3px solid rgba(239,68,68,0.6); }
                .ai-remove-gutter { border-color: rgba(239,68,68,0.7) !important; }
                .ai-insert-zone, .ai-remove-zone { display: flex; flex-direction: column; gap: 6px; font-family: 'JetBrains Mono', monospace; font-size: 12px; padding: 4px 6px 14px 6px; margin: 0; border-radius: 6px; }
                .ai-insert-zone { background: rgba(16,185,129,0.08); color: rgba(190,250,230,0.82); border: 1px dashed rgba(16,185,129,0.35); }
                .ai-remove-zone { background: rgba(248,113,113,0.1); color: rgba(255,228,230,0.9); border: 1px dashed rgba(248,113,113,0.35); }
                .ai-insert-zone pre, .ai-remove-zone pre { margin: 0; padding: 2px 4px; background: transparent; border: none; border-radius: 6px; color: rgba(190,250,230,0.74); line-height: 1.35; }
                .ai-remove-zone pre { color: rgba(255,228,230,0.78); }
                .ai-insert-zone .controls, .ai-remove-zone .controls { display: flex; gap: 8px; margin-top: 2px; align-items: center; flex-wrap: wrap; justify-content: flex-start; }
                .ai-action-btn { font-size: 11px; padding: 5px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.18); cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.25); transition: background 120ms ease, border-color 120ms ease, color 120ms ease; }
                .ai-action-btn.accept-add { background: rgba(16,185,129,0.25); color: #befae6; border-color: rgba(16,185,129,0.45); }
                .ai-action-btn.reject-add { background: rgba(16,185,129,0.05); color: #fca5a5; border-color: rgba(248,113,113,0.4); }
                .ai-action-btn.accept-rem { background: rgba(248,113,113,0.22); color: #ffe4e6; border-color: rgba(248,113,113,0.5); }
                .ai-action-btn.reject-rem { background: rgba(248,113,113,0.05); color: #fca5a5; border-color: rgba(248,113,113,0.35); }
                .ai-action-btn.accept-add:hover { background: rgba(16,185,129,0.4); }
                .ai-action-btn.reject-add:hover { background: rgba(248,113,113,0.16); }
                .ai-action-btn.accept-rem:hover { background: rgba(248,113,113,0.32); }
                .ai-action-btn.reject-rem:hover { background: rgba(248,113,113,0.16); }
            `;
            document.head.appendChild(style);
        }

        const lineHeight = editorInstance.getOption
            ? editorInstance.getOption(monacoInstance.editor.EditorOption.lineHeight) || 20
            : 20;

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
                        linesDecorationsClassName: 'ai-remove-gutter'
                    }
                }]);
                chunk.decorationIds = ids;
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
                zoneWrapper.style.marginBottom = '16px';

                const domNode = document.createElement('div');
                domNode.className = 'ai-insert-zone';
                domNode.style.pointerEvents = 'auto';
                domNode.style.userSelect = 'text';
                domNode.style.position = 'relative';
                domNode.style.overflow = 'visible';
                domNode.style.padding = '8px 8px 10px 8px';

                const title = document.createElement('div');
                title.style.fontSize = '13px';
                title.style.textTransform = 'uppercase';
                title.style.letterSpacing = '0.08em';
                title.style.marginBottom = '8px';
                title.textContent = `AI suggestion · ${chunk.addLines.length} ${chunk.addLines.length === 1 ? 'line' : 'lines'}`;
                domNode.appendChild(title);

                if (chunk.addLines.length) {
                    const code = document.createElement('pre');
                    code.style.fontSize = '14px';
                    code.textContent = chunk.addLines.join('\n');
                    domNode.appendChild(code);
                }

                const controls = document.createElement('div');
                controls.className = 'controls';
                controls.style.marginBottom = '2px';
                controls.style.marginTop = '10px';

                const acceptBtn = document.createElement('button');
                acceptBtn.className = 'ai-action-btn accept-add';
                acceptBtn.textContent = 'Accept';
                acceptBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleAcceptDiffChunk(chunk.id);
                };

                const rejectBtn = document.createElement('button');
                rejectBtn.className = 'ai-action-btn reject-add';
                rejectBtn.textContent = 'Reject';
                rejectBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRejectDiffChunk(chunk.id);
                };

                controls.appendChild(acceptBtn);
                controls.appendChild(rejectBtn);
                domNode.appendChild(controls);

                zoneWrapper.appendChild(domNode);

                const estimatedAddHeight = Math.max(chunk.addLines.length, 1) * (lineHeight + 2) + 90;
                const initialHeight = Math.min(estimatedAddHeight, 420);
                let zoneId = null;
                editorInstance.changeViewZones(accessor => {
                    zoneId = accessor.addZone({
                        afterLineNumber: Math.max(0, chunk.additionAfterLine),
                        heightInPx: initialHeight,
                        domNode: zoneWrapper
                    });
                });
                chunk.viewZoneId = zoneId;
                // Adjust height after render to match actual content height (prevents overlap)
                if (zoneId) {
                    requestAnimationFrame(() => {
                        const desired = Math.min(Math.max(zoneWrapper.scrollHeight + 4, initialHeight), 540);
                        if (desired !== initialHeight) {
                            editorInstance.changeViewZones(accessor => {
                                accessor.removeZone(zoneId);
                                const newId = accessor.addZone({
                                    afterLineNumber: Math.max(0, chunk.additionAfterLine),
                                    heightInPx: desired,
                                    domNode: zoneWrapper
                                });
                                chunk.viewZoneId = newId;
                            });
                        }
                    });
                }
            }

            if (hasOnlyRemovals) {
                const zoneWrapper = document.createElement('div');
                zoneWrapper.style.pointerEvents = 'auto';
                zoneWrapper.style.userSelect = 'none';
                zoneWrapper.style.position = 'relative';
                zoneWrapper.style.zIndex = '5';
                zoneWrapper.style.marginBottom = '16px';

                const domNode = document.createElement('div');
                domNode.className = 'ai-remove-zone';
                domNode.style.pointerEvents = 'auto';
                domNode.style.userSelect = 'text';
                domNode.style.position = 'relative';
                domNode.style.overflow = 'visible';
                domNode.style.padding = '12px 10px 10px 10px';

                const controls = document.createElement('div');
                controls.className = 'controls';
                controls.style.marginBottom = '6px';
                controls.style.marginTop = '4px';
                controls.style.display = 'flex';
                controls.style.gap = '8px';
                controls.style.justifyContent = 'flex-start';

                const acceptBtn = document.createElement('button');
                acceptBtn.className = 'ai-action-btn accept-rem';
                acceptBtn.textContent = 'Accept removal';
                acceptBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleAcceptDiffChunk(chunk.id);
                };

                const rejectBtn = document.createElement('button');
                rejectBtn.className = 'ai-action-btn reject-rem';
                rejectBtn.textContent = 'Keep code';
                rejectBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleRejectDiffChunk(chunk.id);
                };

                controls.appendChild(acceptBtn);
                controls.appendChild(rejectBtn);
                domNode.appendChild(controls);

                zoneWrapper.appendChild(domNode);

                const baseRemHeight = Math.max(chunk.removeLines.length, 1) * (lineHeight + 2) + 90;
                const initialHeight = Math.min(baseRemHeight, 80);
                let zoneId = null;
                editorInstance.changeViewZones(accessor => {
                    zoneId = accessor.addZone({
                        afterLineNumber: Math.max(0, chunk.removeStartLine + chunk.removeLines.length - 1),
                        heightInPx: initialHeight,
                        domNode: zoneWrapper
                    });
                });
                chunk.viewZoneId = zoneId;
                if (zoneId) {
                    requestAnimationFrame(() => {
                        const desired = Math.min(Math.max(zoneWrapper.scrollHeight + 4, initialHeight), 540);
                        if (desired !== initialHeight) {
                            editorInstance.changeViewZones(accessor => {
                                accessor.removeZone(zoneId);
                                const newId = accessor.addZone({
                                    afterLineNumber: Math.max(0, chunk.removeStartLine + chunk.removeLines.length - 1),
                                    heightInPx: desired,
                                    domNode: zoneWrapper
                                });
                                chunk.viewZoneId = newId;
                            });
                        }
                    });
                }
            }
        });

        return () => {
            clearAllChunks();
        };
    }, [latestCompletion, editorInstance, monacoInstance, handleAcceptDiffChunk, handleRejectDiffChunk, removeDiffChunkVisuals, activeLanguage, activeFile, clearAllChunks]);

    useEffect(() => {
        if (!activeFileIdentity) return;
        clearAllChunks();
        notifyCompletionCleared();
    }, [activeFileIdentity, clearAllChunks, notifyCompletionCleared]);

    const hasActiveDiff = useCallback(() => aiDiffChunksRef.current.size > 0, []);

    return {
        aiDiffChunksRef,
        removeDiffChunkVisuals,
        handleRejectDiffChunk,
        handleAcceptDiffChunk,
        hasActiveDiff,
        clearAllChunks
    };
};
