import { useCallback, useRef, useState } from 'react';
import {
    API_COMPLETION_ROUTE,
    extractCompletion,
    sanitizeCompletion,
    isCompletionEcho,
} from '@/lib/completion';
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
    hasActiveDiff,
}) => {
    const [aiCompletionState, setAiCompletionState] = useState('idle');

    // Cooldown between auto-triggered requests. Streaming hides most of the
    // perceived latency, so we can be more aggressive than the old 700ms
    // gate without flooding the model.
    const MIN_AUTO_INTERVAL_MS = 350;
    const aiCompletionCacheRef = useRef({ context: '', language: '', suggestion: '' });
    const aiCompletionCursorRef = useRef(null);
    const aiCompletionAbortControllerRef = useRef(null);
    const aiLastRequestRef = useRef({ context: '', time: 0 });
    const aiLastAutoRef = useRef(0);
    const aiDebounceTimerRef = useRef(null);
    const inlineAcceptCommandIdRef = useRef(null);

    const cancelActiveCompletion = useCallback(({ resetSuggestion = true, reason = 'user-cancelled' } = {}) => {
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
        // 1. Safety check: prevent applying if diff is active
        if (hasActiveDiff()) return;

        if (!text || !editorInstance || !monacoInstance) return;
        const start = aiCompletionCursorRef.current || editorInstance.getPosition();
        if (!start) return;

        const model = editorInstance.getModel();
        let rangeToReplace = null;

        // FIM contract: the model is told to fill ONLY the gap at the cursor,
        // so the default behavior is pure insertion at the cursor — never overwrite
        // the rest of the user's line. A computed range is honored when supplied.
        const cached = aiCompletionCacheRef.current || {};
        if (cached.suggestionRange && cached.suggestionRange.start) {
            const s = cached.suggestionRange.start;
            const e = cached.suggestionRange.end || cached.suggestionRange.start;
            rangeToReplace = new monacoInstance.Range(s.lineNumber, s.column, e.lineNumber, e.column);
        } else {
            rangeToReplace = new monacoInstance.Range(start.lineNumber, start.column, start.lineNumber, start.column);
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
    }, [editorInstance, monacoInstance, hasActiveDiff]); // Added dependency

    const requestAiCompletion = useCallback((isAutoTrigger = false, manualContext = null, meta = {}) => {
        if (!activeFile || !editorInstance) return;
        
        // Check 1: Prevent starting a new request if diff is active
        if (hasActiveDiff()) return;

        const cursorPosition = editorInstance.getPosition();
        const rawContext = typeof manualContext === 'string'
            ? manualContext
            : (editorInstance?.getValue?.() ?? code ?? '');
        const context = trimCompletionContext(rawContext, cursorPosition);
        if (!context.trim()) return;
        
        if (isAutoTrigger && cursorPosition) {
             const model = editorInstance.getModel();
             const lineContent = model.getLineContent(cursorPosition.lineNumber);
             if (cursorPosition.column < lineContent.length + 1) {
                 // return; // Uncomment if you want strictly end-of-line completion only
             }
        }

        // No "last char" gate. Cursor / Copilot style: any keystroke can
        // trigger a completion (gated by MIN_AUTO_INTERVAL_MS + the dedup
        // cache below). The previous gate skipped triggers mid-identifier,
        // which made completions feel arbitrary — e.g. `SDL_Cre|` produced
        // nothing because the last char wasn't punctuation.

        const cached = aiCompletionCacheRef.current;
        if (cached?.suggestion && cached.context === context && cached.language === activeLanguage) return;

        const now = Date.now();
        if (isAutoTrigger) {
            if (now - aiLastAutoRef.current < MIN_AUTO_INTERVAL_MS) {
                return;
            }
            aiLastAutoRef.current = now;
        }

        // P1: Removed 1600ms duplicate-context gate.
        // The MIN_AUTO_INTERVAL_MS cooldown + cache check above are sufficient
        // to prevent duplicate requests without adding extra latency.
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

        // Inline completions intentionally ship ONLY the active file's local
        // context (prefix/suffix). Including sibling files' contents — especially
        // their dirty unsaved buffers — confuses the FIM model: it tends to
        // echo from references or hallucinate cross-file symbols. The local
        // neighborhood already contains every symbol the user has used here.

        // Stream the completion: render partial ghost text as Gemini emits it,
        // Cursor / Copilot style. The /api/completion route returns a chunked
        // text/plain stream of raw model text; we keep a buffer of accumulated
        // chunks and re-derive the visible suggestion (envelope-stripped,
        // sanitized, echo-checked) on every chunk before pushing into the
        // inline-completion cache.
        const pushSuggestion = (visible) => {
            let suggestionRange = null;
            try {
                const cursor = aiCompletionCursorRef.current;
                const model = editorInstance.getModel();
                if (cursor && model) {
                    const word = model.getWordAtPosition(cursor) || null;
                    const endCol = word ? word.endColumn : (model.getLineContent(cursor.lineNumber).length + 1);
                    suggestionRange = {
                        start: { lineNumber: cursor.lineNumber, column: cursor.column },
                        end:   { lineNumber: cursor.lineNumber, column: endCol },
                    };
                }
            } catch (e) { /* ignore */ }

            aiCompletionCacheRef.current = {
                context,
                language: activeLanguage,
                suggestion: visible,
                suggestionRange,
            };
            setAiCompletionState('ready');

            try {
                const action = editorInstance.getAction?.('editor.action.inlineSuggest.trigger');
                if (action?.run) {
                    Promise.resolve(action.run()).catch(() => {});
                } else {
                    const p = editorInstance.trigger('ai-inline', 'editor.action.inlineSuggest.trigger', {});
                    if (p && typeof p.then === 'function') Promise.resolve(p).catch(() => {});
                }
            } catch (e) { /* monaco trigger threw — non-fatal */ }
        };

        (async () => {
            let res;
            try {
                res = await fetch(API_COMPLETION_ROUTE, {
                    method: 'POST',
                    signal: controller.signal,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                });
            } catch (e) {
                if (!controller.signal.aborted) setAiCompletionState('idle');
                return;
            }

            if (!res.ok) {
                if (!controller.signal.aborted) setAiCompletionState('idle');
                return;
            }

            const reader = res.body?.getReader?.();
            if (!reader) {
                // No streaming support — fall back to reading the whole body.
                try {
                    const text = await res.text();
                    if (controller.signal.aborted || hasActiveDiff()) {
                        setAiCompletionState('idle');
                        return;
                    }
                    const visible = sanitizeCompletion(extractCompletion(text), { prefix: beforeCursor });
                    if (visible && !isCompletionEcho(visible, beforeCursor, afterCursor)) {
                        pushSuggestion(visible);
                    } else {
                        setAiCompletionState('idle');
                    }
                } catch (_) {
                    if (!controller.signal.aborted) setAiCompletionState('idle');
                }
                return;
            }

            const decoder = new TextDecoder();
            let raw = '';
            let lastVisible = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (controller.signal.aborted) {
                        try { reader.cancel(); } catch (_) { /* ignore */ }
                        return;
                    }
                    if (done) break;
                    raw += decoder.decode(value, { stream: true });

                    if (hasActiveDiff()) {
                        try { reader.cancel(); } catch (_) { /* ignore */ }
                        setAiCompletionState('idle');
                        return;
                    }

                    const visible = sanitizeCompletion(extractCompletion(raw), { prefix: beforeCursor });
                    if (visible && visible !== lastVisible && !isCompletionEcho(visible, beforeCursor, afterCursor)) {
                        lastVisible = visible;
                        pushSuggestion(visible);
                    }
                }

                // Flush any remaining bytes in the decoder.
                raw += decoder.decode();
                const visible = sanitizeCompletion(extractCompletion(raw), { prefix: beforeCursor });
                if (visible && visible !== lastVisible && !isCompletionEcho(visible, beforeCursor, afterCursor)) {
                    pushSuggestion(visible);
                } else if (!visible && !lastVisible) {
                    setAiCompletionState('idle');
                }
            } catch (e) {
                if (!controller.signal.aborted) setAiCompletionState('idle');
            }
        })();
    }, [activeFile, activeLanguage, breadcrumb, cancelActiveCompletion, code, editorInstance, hasActiveDiff]);

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
        aiLastAutoRef,
        aiDebounceTimerRef,
        inlineAcceptCommandIdRef
    };
};
