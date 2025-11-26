import { useCallback, useRef, useState } from 'react';
import { AI_COMPLETION_STOP_SEQUENCE, API_COMPLETION_ROUTE } from '@/lib/completion';
import SynthiException from '@/components/SynthiException.js';
import { buildFilesPayload } from '@/utils/multiFileContext';
import {
    trimCompletionContext,
    takeLastChars,
    takeFirstChars,
    buildEdgePreview,
    clampSelection,
    CONTEXT_SIDE_CHARS,
    MAX_EDGE_LINES
} from './utils.js';

export const useAiCompletion = ({
    activeFile,
    activeLanguage,
    breadcrumb,
    code,
    editorInstance,
    monacoInstance,
    fileCacheEntries,
    hasActiveDiff
}) => {
    const [aiCompletionState, setAiCompletionState] = useState('idle');

    const aiCompletionCacheRef = useRef({ context: '', language: '', suggestion: '' });
    const aiCompletionCursorRef = useRef(null);
    const aiCompletionAbortControllerRef = useRef(null);
    const aiLastRequestRef = useRef({ context: '', time: 0 });
    const aiDebounceTimerRef = useRef(null);
    const inlineAcceptCommandIdRef = useRef(null);

    const cancelActiveCompletion = useCallback(({ resetSuggestion = false, reason = 'user-cancelled' } = {}) => {
        let changed = false;

        if (aiCompletionAbortControllerRef.current) {
            try {
                aiCompletionAbortControllerRef.current.abort(reason);
            } catch (e) {
                // ignore abort errors
            }
            aiCompletionAbortControllerRef.current = null;
            changed = true;
        }

        if (resetSuggestion) {
            if (aiCompletionCacheRef.current?.suggestion || aiCompletionCursorRef.current) {
                aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
                aiCompletionCursorRef.current = null;
                changed = true;
            }
            setAiCompletionState(prev => (prev === 'idle' ? prev : 'idle'));
        } else if (changed) {
            setAiCompletionState(prev => (prev === 'loading' ? 'idle' : prev));
        }

        return changed;
    }, []);

    const applyAiCompletionText = useCallback((text) => {
        if (!text || !editorInstance || !monacoInstance) return;
        const start = aiCompletionCursorRef.current || editorInstance.getPosition();
        if (!start) return;

        const model = editorInstance.getModel();
        let rangeToReplace = null;

        // If provider computed a replacement range, prefer that. Otherwise
        // attempt to replace the current word at the cursor to allow edits
        // instead of append-only behavior.
        const cached = aiCompletionCacheRef.current || {};
        if (cached.suggestionRange && cached.suggestionRange.start) {
            const s = cached.suggestionRange.start;
            const e = cached.suggestionRange.end || cached.suggestionRange.start;
            rangeToReplace = new monacoInstance.Range(s.lineNumber, s.column, e.lineNumber, e.column);
        } else if (model) {
            try {
                const word = model.getWordAtPosition(start) || null;
                const endCol = word ? word.endColumn : (model.getLineContent(start.lineNumber).length + 1);
                rangeToReplace = new monacoInstance.Range(start.lineNumber, start.column, start.lineNumber, endCol);
            } catch (e) {
                rangeToReplace = new monacoInstance.Range(start.lineNumber, start.column, start.lineNumber, start.column);
            }
        }

        if (!rangeToReplace) return;

        // Trim common prefix between suggestion and existing text in the target range
        try {
            if (model && rangeToReplace) {
                const startPos = { lineNumber: rangeToReplace.startLineNumber, column: rangeToReplace.startColumn };
                const startOffset = model.getOffsetAt(startPos);
                const existing = model.getValue().slice(startOffset, startOffset + text.length);
                let common = 0;
                while (common < text.length && common < existing.length && text.charAt(common) === existing.charAt(common)) {
                    common++;
                }
                if (common > 0) {
                    // Advance start by `common` characters
                    const newStartOffset = startOffset + common;
                    const newStartPos = model.getPositionAt(newStartOffset);
                    rangeToReplace = new monacoInstance.Range(newStartPos.lineNumber, newStartPos.column, rangeToReplace.endLineNumber, rangeToReplace.endColumn);
                    text = text.slice(common);
                }
            }

            if (!text) {
                // Nothing to insert after trimming — consider applied
                aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
                setAiCompletionState('applied');
                return;
            }

            editorInstance.executeEdits('ai', [{ range: rangeToReplace, text, forceMoveMarkers: true }]);
            editorInstance.pushUndoStop();
        } catch (e) {
            // Fallback: insert at start if replace fails
            const fallbackRange = new monacoInstance.Range(start.lineNumber, start.column, start.lineNumber, start.column);
            try { editorInstance.executeEdits('ai', [{ range: fallbackRange, text, forceMoveMarkers: true }]); } catch (e2) {}
        }
        
        // Reset state
        aiCompletionCursorRef.current = null;
        aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
        setAiCompletionState('applied');
    }, [editorInstance, monacoInstance]);

    const requestAiCompletion = useCallback((isAutoTrigger = false, manualContext = null, _meta = {}) => {
        if (!activeFile || !editorInstance) return;
        if (hasActiveDiff()) return;

        const cursorPosition = editorInstance.getPosition();
        const rawContext = typeof manualContext === 'string'
            ? manualContext
            : (editorInstance?.getValue?.() ?? code ?? '');
        const context = trimCompletionContext(rawContext, cursorPosition);
        if (!context.trim()) return;
        // Don't trigger auto-AI if we are in the middle of a line (usually annoying)
        // Only trigger if at end of line or end of file for cleaner UX
        if (isAutoTrigger && cursorPosition) {
             const model = editorInstance.getModel();
             const lineContent = model.getLineContent(cursorPosition.lineNumber);
             if (cursorPosition.column < lineContent.length + 1) {
                 // return; // Uncomment if you want strictly end-of-line completion only
             }
        }

        // If auto-triggering, only run after a whitespace/punctuation boundary to reduce calls
        if (isAutoTrigger) {
            const lastChar = rawContext.slice(-1);
            if (!/[\s\(\{\[\.;,:]/.test(lastChar)) {
                // If the last character isn't a boundary, skip auto-trigger to avoid excess calls
                return;
            }
        }

        // Avoid duplicate requests: if cache already has a suggestion for this exact context/language, skip
        const cached = aiCompletionCacheRef.current;
        if (cached?.suggestion && cached.context === context && cached.language === activeLanguage) return;

        // Rate-limit identical requests: if we requested same context recently, skip
        const now = Date.now();
        if (aiLastRequestRef.current.context === context && (now - aiLastRequestRef.current.time) < 1200) {
            return;
        }
        aiLastRequestRef.current = { context, time: now };

        cancelActiveCompletion({ resetSuggestion: true, reason: 'superseded' });
        aiCompletionCursorRef.current = cursorPosition ? { ...cursorPosition } : null;

        const controller = new AbortController();
        aiCompletionAbortControllerRef.current = controller;
        setAiCompletionState('loading');

        const model = editorInstance.getModel();
        const fullDocument = typeof manualContext === 'string' ? manualContext : (model?.getValue?.() ?? rawContext);
        let cursorOffset = fullDocument.length;
        if (model && cursorPosition) {
            try {
                cursorOffset = model.getOffsetAt(cursorPosition);
            } catch (e) {
                cursorOffset = fullDocument.length;
            }
        }
        const beforeCursor = takeLastChars(fullDocument.slice(0, cursorOffset));
        const afterCursor = takeFirstChars(fullDocument.slice(cursorOffset));
        const selectionRange = editorInstance.getSelection ? editorInstance.getSelection() : null;
        let selectedText = '';
        try {
            if (selectionRange && !selectionRange.isEmpty() && model) {
                selectedText = clampSelection(model.getValueInRange(selectionRange));
            }
        } catch (e) {
            selectedText = '';
        }
        let fileHeader = '';
        let fileTail = '';
        try {
            if (model?.getLinesContent) {
                const lines = model.getLinesContent();
                const edges = buildEdgePreview(lines, MAX_EDGE_LINES);
                fileHeader = takeFirstChars(edges.head, CONTEXT_SIDE_CHARS);
                fileTail = takeLastChars(edges.tail, CONTEXT_SIDE_CHARS);
            }
        } catch (e) {
            // ignore preview errors
        }

        const payload = {
            code: context,
            language: activeLanguage,
            cursor: cursorPosition ? { line: cursorPosition.lineNumber, column: cursorPosition.column } : null,
            contextBlocks: {
                beforeCursor,
                afterCursor,
                selection: selectedText || null,
                filePath: activeFile?.path || activeFile?.name || null,
                breadcrumbs: breadcrumb || null,
                languageHint: activeLanguage,
                fileHeader: fileHeader || null,
                fileTail: fileTail || null,
            },
        };

        if (activeFile?.name || activeFile?.path) {
            const metadata = [
                activeFile?.name ? `Active file: ${activeFile.name}` : null,
                activeFile?.path ? `Path: ${activeFile.path}` : null,
            ].filter(Boolean).join('\n');
            if (metadata) payload.prompt = metadata;
        }

        const filesPayload = buildFilesPayload({
            activeFile,
            fullDocument,
            beforeCursor,
            afterCursor,
            fileHeader,
            fileTail,
            cacheEntries: fileCacheEntries,
        });
        if (filesPayload.length) {
            payload.files = filesPayload;
            const multiFileNote = 'Multi-file context attached. Reference related files by their provided paths.';
            payload.prompt = payload.prompt ? `${payload.prompt}\n${multiFileNote}` : multiFileNote;
        }

        fetch(API_COMPLETION_ROUTE, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        })
        .then(async (res) => {
            if (!res.ok) throw new SynthiException('AI completion request failed', `The AI service responded with status ${res.status}. Please try again later.`);
            return res.json();
        })
        .then((data) => {
            if (controller.signal.aborted) return;
            const raw = data?.completion || '';
            const sanitized = raw.split(AI_COMPLETION_STOP_SEQUENCE)[0].replace(/\r/g, '').trimEnd();

            if (sanitized) {
                // Prefer server-provided suggestion range when available
                let suggestionRange = data?.suggestionRange || null;
                try {
                    if (!suggestionRange) {
                        const cursor = aiCompletionCursorRef.current;
                        const model = editorInstance.getModel();
                        if (cursor && model) {
                            const word = model.getWordAtPosition(cursor) || null;
                            const endCol = word ? word.endColumn : (model.getLineContent(cursor.lineNumber).length + 1);
                            suggestionRange = { start: { lineNumber: cursor.lineNumber, column: cursor.column }, end: { lineNumber: cursor.lineNumber, column: endCol } };
                        }
                    }
                } catch (e) { /* ignore */ }

                aiCompletionCacheRef.current = { context, language: activeLanguage, suggestion: sanitized, suggestionRange };
                setAiCompletionState('ready');
                // Force trigger the inline suggestion. `trigger` may return a Promise
                // in some Monaco builds — attach a noop .catch to avoid unhandled
                // promise rejections (e.g. 'Canceled').
                try {
                    const action = editorInstance.getAction?.('editor.action.inlineSuggest.trigger');
                    if (action?.run) {
                        Promise.resolve(action.run()).catch(() => {});
                    } else {
                        const p = editorInstance.trigger('ai-inline', 'editor.action.inlineSuggest.trigger', {});
                        if (p && typeof p.then === 'function') Promise.resolve(p).catch(() => {});
                    }
                } catch(e){}
            } else {
                setAiCompletionState('idle');
            }
        })
        .catch((e) => {
            if (!controller.signal.aborted) {
                setAiCompletionState('idle');
            }
        });
    }, [activeFile, activeLanguage, breadcrumb, cancelActiveCompletion, code, editorInstance, fileCacheEntries, hasActiveDiff]);

    return {
        aiCompletionState,
        setAiCompletionState,
        applyAiCompletionText,
        requestAiCompletion,
        cancelActiveCompletion,
        aiCompletionCacheRef,
        aiCompletionCursorRef,
        aiCompletionAbortControllerRef,
        aiLastRequestRef,
        aiDebounceTimerRef,
        inlineAcceptCommandIdRef
    };
};
