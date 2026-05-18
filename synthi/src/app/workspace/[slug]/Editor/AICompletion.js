import { useCallback, useEffect, useRef, useState } from 'react';
import {
    API_COMPLETION_ROUTE,
    extractCompletion,
    sanitizeCompletion,
    isCompletionEcho,
    truncateToFirstUnit,
    countSuggestionLines,
    lastCompletePrefix,
} from '@/lib/completion';
import { pushRecentEdit } from '@/utils/completionContext';
import { buildAutocompleteContextPacket } from '@/utils/aiContextBroker';
import { recordAiCompletionEvent } from '@/lib/aiCompletionTelemetry';
import { recordAiReplaySample } from '@/lib/aiReplayHarness';

export const useAiCompletion = ({
    activeFile,
    activeLanguage,
    breadcrumb,
    code,
    editorInstance,
    monacoInstance,
    getFileCacheEntries,
    workspaceSlug = null,
    hasActiveDiff,
}) => {
    const [aiCompletionState, setAiCompletionState] = useState('idle');

    // Cooldown between auto-triggered requests. Streaming hides most of the
    // perceived latency, so we can be more aggressive than the old 700ms
    // gate without flooding the model.
    const MIN_AUTO_INTERVAL_MS = 350;
    const aiCompletionCacheRef = useRef({ context: '', language: '', suggestion: '' });
    const aiCompletionCursorRef = useRef(null);
    // Small LRU of recent (context, language) → suggestion entries. The
    // active cache is single-slot, but cursor wander (move away, type
    // somewhere else, come back) used to throw away a perfectly usable
    // suggestion and force a re-request. With a small LRU the round-trip
    // is skipped when the user revisits a context we already answered.
    const aiCompletionLruRef = useRef([]);
    const AI_COMPLETION_LRU_MAX = 8;
    const lruLookup = (context, language) => {
        const lru = aiCompletionLruRef.current;
        for (let i = 0; i < lru.length; i++) {
            const e = lru[i];
            if (e.context === context && e.language === language) {
                if (i > 0) {
                    lru.splice(i, 1);
                    lru.unshift(e);
                }
                return e;
            }
        }
        return null;
    };
    const lruInsert = (entry) => {
        if (!entry?.suggestion || !entry?.context) return;
        const lru = aiCompletionLruRef.current;
        for (let i = 0; i < lru.length; i++) {
            if (lru[i].context === entry.context && lru[i].language === entry.language) {
                lru.splice(i, 1);
                break;
            }
        }
        lru.unshift(entry);
        if (lru.length > AI_COMPLETION_LRU_MAX) lru.length = AI_COMPLETION_LRU_MAX;
    };

    // Notify subscribers (notably providers.js's tokenized ghost overlay)
    // whenever the cache mutates. The cache lives in a ref so React's
    // render tree never sees these changes; the consumer used to poll at
    // 80ms to catch new suggestions, which burned a CPU wakeup 12.5×/s
    // even with no edits. A custom DOM event is one-shot, lazy, and
    // exactly as cheap as a function call when nobody is listening.
    const notifyCompletionCacheChange = () => {
        try {
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('synthi:ai-completion:cache-change'));
            }
        } catch (_) { /* SSR / event constructor unavailable */ }
    };
    const aiCompletionAbortControllerRef = useRef(null);
    const aiCompletionRequestSeqRef = useRef(0);
    const aiCompletionActiveRequestIdRef = useRef(null);
    const aiLastRequestRef = useRef({ context: '', time: 0 });
    const aiLastAutoRef = useRef(0);
    const aiDebounceTimerRef = useRef(null);

    // Ring buffer of recent edits across files. Each completion request reads
    // this so the model knows what the user just touched — the strongest
    // signal for "what context is currently relevant?"  Throttled so we
    // don't churn on every keystroke.
    const recentEditsRef = useRef([]);
    const lastRecentEditPushRef = useRef(0);

    useEffect(() => {
        if (!editorInstance) return undefined;
        const RECENT_EDIT_THROTTLE_MS = 600;
        const disposable = editorInstance.onDidChangeModelContent?.((event) => {
            const now = Date.now();
            if (now - lastRecentEditPushRef.current < RECENT_EDIT_THROTTLE_MS) return;
            lastRecentEditPushRef.current = now;

            try {
                const model = editorInstance.getModel?.();
                if (!model) return;
                const path = activeFile?.path || activeFile?.name || null;
                if (!path) return;

                // Cursor-style diff capture: encode the recent edit as the
                // inserted text plus a few unchanged lines on either side,
                // rendered with a `+` marker. This signals INTENT (what the
                // user just produced) rather than just position, which is
                // what static window snapshots gave us.
                const changes = Array.isArray(event?.changes) ? event.changes : [];
                if (!changes.length) return;

                // Aggregate inserted text across all changes in the event;
                // sort by range so multi-cursor edits read top-to-bottom.
                const sorted = [...changes].sort((a, b) => {
                    const al = a?.range?.startLineNumber ?? 0;
                    const bl = b?.range?.startLineNumber ?? 0;
                    if (al !== bl) return al - bl;
                    return (a?.range?.startColumn ?? 0) - (b?.range?.startColumn ?? 0);
                });
                const insertedText = sorted.map((c) => c?.text || '').join('').replace(/\s+$/u, '');
                if (!insertedText.trim()) return;

                const firstRange = sorted[0]?.range;
                const lastRange = sorted[sorted.length - 1]?.range || firstRange;
                if (!firstRange || !lastRange) return;

                // Post-change line span. Monaco's range is in pre-change coords,
                // but for display purposes the start line is stable. We grow the
                // end-line by the newline count in the inserted text so we can
                // render trailing context that lives just below the new code.
                const startLine = Math.max(1, firstRange.startLineNumber || 1);
                const insertedNewlines = (insertedText.match(/\n/g) || []).length;
                const endLine = Math.max(
                    startLine,
                    (lastRange.endLineNumber || startLine) + insertedNewlines,
                );

                const totalLines = model.getLineCount?.() ?? endLine;
                const ctxStart = Math.max(1, startLine - 3);
                const ctxEnd = Math.min(totalLines, endLine + 3);

                const readLines = (from, to) => {
                    if (from > to) return '';
                    try {
                        return model.getValueInRange({
                            startLineNumber: from,
                            startColumn: 1,
                            endLineNumber: to,
                            endColumn: model.getLineMaxColumn?.(to) ?? 1,
                        }) || '';
                    } catch (_) {
                        return '';
                    }
                };

                const before = readLines(ctxStart, Math.max(ctxStart, startLine - 1));
                const after = readLines(Math.min(totalLines, endLine + 1), ctxEnd);

                // Render diff-style. Each line of the inserted text gets a `+`
                // marker; surrounding context is two leading spaces. The total
                // string is capped by pushRecentEdit, so we don't need to be
                // precise about its size here.
                const markInserted = (text) =>
                    text.split('\n').map((l) => `+ ${l}`).join('\n');
                const markContext = (text) => {
                    if (!text) return '';
                    return text.split('\n').map((l) => `  ${l}`).join('\n');
                };

                const headerLine = `@@ ${path} L${startLine}-${endLine} @@`;
                const snippet = [
                    headerLine,
                    markContext(before),
                    markInserted(insertedText),
                    markContext(after),
                ].filter(Boolean).join('\n');

                recentEditsRef.current = pushRecentEdit(recentEditsRef.current, { path, snippet });
            } catch (_) { /* recent-edit tracking is best-effort */ }
        });
        return () => { try { disposable?.dispose?.(); } catch (_) { /* ignore */ } };
    }, [editorInstance, activeFile]);

    const cancelActiveCompletion = useCallback(({ resetSuggestion = true, reason = 'user-cancelled' } = {}) => {
        let changed = false;
        const cancelledRequestId = aiCompletionActiveRequestIdRef.current;
        aiCompletionActiveRequestIdRef.current = null;

        if (aiCompletionAbortControllerRef.current) {
            try {
                aiCompletionAbortControllerRef.current.abort(reason);
            } catch (e) {
                // ignore abort errors
            }
            aiCompletionAbortControllerRef.current = null;
            changed = true;
            recordAiCompletionEvent('cancelled', { reason, request_id: cancelledRequestId });
        }

        if (resetSuggestion) {
            if (aiCompletionCacheRef.current?.suggestion || aiCompletionCursorRef.current) {
                aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
                aiCompletionCursorRef.current = null;
                changed = true;
                notifyCompletionCacheChange();
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

        // Accept-time stability gate. The render pipeline pushes partial
        // chunks to the ghost overlay for snappy time-to-glass, which means
        // the user can Tab on a suggestion that is syntactically open
        // (e.g., `int add() {\n    if (a) {`). For multi-line suggestions
        // we require a stable cache (truncator boundary fired OR stream
        // ended). If the cache isn't stable yet, we accept the longest
        // prefix that ends on a complete statement (`;` / `}`). If even
        // that doesn't exist, block the accept silently — the user's next
        // Tab will succeed once more chunks arrive.
        //
        // Single-line suggestions skip this entirely: the user can see the
        // entire suggestion before pressing Tab, so commit semantics match
        // their intent.
        if (text.includes('\n') && cached.stable === false) {
            const safe = lastCompletePrefix(text);
            if (!safe) {
                recordAiCompletionEvent('cancelled', {
                    reason: 'accept_blocked_unstable',
                    request_id: cached.requestId || null,
                });
                recordAiReplaySample({
                    feature: 'autocomplete',
                    phase: 'accept_blocked',
                    requestId: cached.requestId || null,
                    payload: {
                        reason: 'unstable_multiline',
                        suggestion: text,
                    },
                });
                return;
            }
            recordAiCompletionEvent('cancelled', {
                reason: 'accept_truncated_to_stable_prefix',
                request_id: cached.requestId || null,
                accepted_lines: countSuggestionLines(safe),
                suggested_lines: countSuggestionLines(text),
            });
            text = safe;
        }

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
                notifyCompletionCacheChange();
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

        // Capture lines BEFORE we wipe the cache, so the telemetry event
        // reflects what the user actually accepted. Multi-line acceptance
        // rate is the headline metric for tuning sibling-scaffold behavior.
        const acceptedLines = countSuggestionLines(text);

        // Reset state
        aiCompletionCursorRef.current = null;
        aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
        notifyCompletionCacheChange();
        setAiCompletionState('applied');
        recordAiCompletionEvent('accepted', { lines: acceptedLines, request_id: cached.requestId || null });
        recordAiReplaySample({
            feature: 'autocomplete',
            phase: 'accepted',
            requestId: cached.requestId || null,
            payload: {
                language: cached.language || activeLanguage,
                lines: acceptedLines,
                text,
                range: rangeToReplace
                    ? {
                        startLineNumber: rangeToReplace.startLineNumber,
                        startColumn: rangeToReplace.startColumn,
                        endLineNumber: rangeToReplace.endLineNumber,
                        endColumn: rangeToReplace.endColumn,
                    }
                    : null,
            },
        });
    }, [editorInstance, monacoInstance, hasActiveDiff, activeLanguage]); // Added dependency

    const requestAiCompletion = useCallback((isAutoTrigger = false, manualContext = null, meta = {}) => {
        if (!activeFile || !editorInstance) return;
        
        // Check 1: Prevent starting a new request if diff is active
        if (hasActiveDiff()) return;

        const cursorPosition = editorInstance.getPosition();
        const rawContext = typeof manualContext === 'string'
            ? manualContext
            : (editorInstance?.getValue?.() ?? code ?? '');
        const contextPacket = buildAutocompleteContextPacket({
            activeFile,
            activeLanguage,
            breadcrumb,
            rawContext,
            fallbackCode: code,
            editorInstance,
            cursorPosition,
            workspaceSlug,
            getFileCacheEntries,
            recentEdits: recentEditsRef.current,
        });
        const { context, beforeCursor, afterCursor, references } = contextPacket;
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

        // LRU hit: the user's current context matches a suggestion we
        // already produced. Promote it to the active cache and trigger
        // the inline-suggest UI without round-tripping the model.
        const lruHit = lruLookup(context, activeLanguage);
        if (lruHit) {
            cancelActiveCompletion({ resetSuggestion: false, reason: 'cache-hit' });
            recordAiCompletionEvent('cache_hit', {
                language: activeLanguage,
                request_id: lruHit.requestId || null,
            });
            aiCompletionCursorRef.current = cursorPosition ? { ...cursorPosition } : null;
            aiCompletionCacheRef.current = lruHit;
            notifyCompletionCacheChange();
            setAiCompletionState('ready');
            try {
                const action = editorInstance.getAction?.('editor.action.inlineSuggest.trigger');
                if (action?.run) {
                    Promise.resolve(action.run()).catch(() => {});
                } else {
                    const p = editorInstance.trigger('ai-inline', 'editor.action.inlineSuggest.trigger', {});
                    if (p && typeof p.then === 'function') Promise.resolve(p).catch(() => {});
                }
            } catch (e) { /* ignored */ }
            return;
        }

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

        const requestId = ++aiCompletionRequestSeqRef.current;
        aiCompletionActiveRequestIdRef.current = requestId;
        const controller = new AbortController();
        aiCompletionAbortControllerRef.current = controller;
        const isCurrentRequest = () =>
            aiCompletionActiveRequestIdRef.current === requestId && !controller.signal.aborted;
        setAiCompletionState('loading');
        const fireStartedAt = Date.now();
        recordAiCompletionEvent('fire', {
            language: activeLanguage,
            request_id: requestId,
            source: isAutoTrigger ? 'auto' : 'manual',
        });

        const payload = {
            requestId,
            ...contextPacket.payload,
        };
        if (references.length) payload.references = references;

        if (activeFile?.name || activeFile?.path) {
            const metadata = [
                activeFile?.name ? `Active file: ${activeFile.name}` : null,
                activeFile?.path ? `Path: ${activeFile.path}` : null,
            ].filter(Boolean).join('\n');
            if (metadata) payload.prompt = metadata;
        }

        recordAiReplaySample({
            feature: 'autocomplete',
            phase: 'request',
            requestId,
            payload: {
                language: activeLanguage,
                source: isAutoTrigger ? 'auto' : 'manual',
                activePath: activeFile?.path || activeFile?.name || null,
                cursor: payload.cursor,
                contextBlocks: payload.contextBlocks,
                code: context,
                references: payload.references || [],
            },
        });
        // Stream the completion: render partial ghost text as Gemini emits it,
        // Cursor / Copilot style. The /api/completion route returns a chunked
        // text/plain stream of raw model text; we keep a buffer of accumulated
        // chunks and re-derive the visible suggestion (envelope-stripped,
        // sanitized, echo-checked) on every chunk before pushing into the
        // inline-completion cache.
        const pushSuggestion = (visible, { stable = false } = {}) => {
            if (!isCurrentRequest()) return;
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

            // Stability is monotonic — once true, never flips back to false
            // for the same suggestion text. Stream-end re-pushes upgrade
            // mid-stream entries to stable:true.
            const prev = aiCompletionCacheRef.current;
            const stickyStable = stable
                || (prev?.context === context && prev?.suggestion === visible && prev?.stable === true);
            const newEntry = {
                context,
                language: activeLanguage,
                requestId,
                suggestion: visible,
                suggestionRange,
                stable: stickyStable,
            };
            const isFirstVisible = !prev?.suggestion || prev.context !== context;
            aiCompletionCacheRef.current = newEntry;
            lruInsert(newEntry);
            notifyCompletionCacheChange();
            setAiCompletionState('ready');
            if (isFirstVisible) {
                recordAiCompletionEvent('visible', {
                    language: activeLanguage,
                    request_id: requestId,
                    latency_ms: Date.now() - fireStartedAt,
                    lines: countSuggestionLines(visible),
                });
                recordAiReplaySample({
                    feature: 'autocomplete',
                    phase: 'visible',
                    requestId,
                    payload: {
                        language: activeLanguage,
                        latency_ms: Date.now() - fireStartedAt,
                        lines: countSuggestionLines(visible),
                        stable: stickyStable,
                        suggestion: visible,
                    },
                });
            }

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
                if (isCurrentRequest()) setAiCompletionState('idle');
                return;
            }

            if (!res.ok) {
                if (isCurrentRequest()) setAiCompletionState('idle');
                return;
            }

            // FIM post-process: every cumulative buffer goes through
            // extract → sanitize → truncateToFirstUnit before becoming the
            // user-visible suggestion. truncateToFirstUnit is the hard cap
            // that enforces "AT MOST ONE new unit per response" — the prompt
            // asks for it, but Flash-Lite routinely overshoots once it has
            // a sibling pattern. Applied per-chunk so streaming partials
            // are also bounded.
            //
            // `stable` returns true when the truncator actually cut the
            // sanitized text, meaning a structural boundary (closing brace
            // at baseline, sibling start at baseline, or 14-line cap) was
            // reached. The accept-time guard in applyAiCompletionText reads
            // this flag to decide whether a multi-line Tab is safe to apply
            // wholesale or needs to fall back to the longest complete
            // prefix.
            const renderVisible = (rawBuf) => {
                const sanitized = sanitizeCompletion(
                    extractCompletion(rawBuf),
                    { prefix: beforeCursor },
                );
                const text = truncateToFirstUnit(sanitized, { prefix: beforeCursor });
                return { text, stable: text.length < sanitized.length };
            };

            const reader = res.body?.getReader?.();
            if (!reader) {
                // No streaming support — fall back to reading the whole body.
                try {
                    const body = await res.text();
                    if (!isCurrentRequest()) return;
                    if (hasActiveDiff()) {
                        if (isCurrentRequest()) setAiCompletionState('idle');
                        return;
                    }
                    const { text: visible } = renderVisible(body);
                    if (visible && !isCompletionEcho(visible, beforeCursor, afterCursor)) {
                        // Non-streaming response is the entire body — always
                        // stable, no further chunks coming.
                        pushSuggestion(visible, { stable: true });
                    } else {
                        setAiCompletionState('idle');
                        recordAiCompletionEvent('rejected', {
                            reason: !body.trim() ? 'empty_response' : 'echo_or_unsanitized',
                            request_id: requestId,
                            latency_ms: Date.now() - fireStartedAt,
                        });
                        recordAiReplaySample({
                            feature: 'autocomplete',
                            phase: 'rejected',
                            requestId,
                            payload: {
                                reason: !body.trim() ? 'empty_response' : 'echo_or_unsanitized',
                                latency_ms: Date.now() - fireStartedAt,
                                raw: body,
                            },
                        });
                    }
                } catch (_) {
                    if (isCurrentRequest()) setAiCompletionState('idle');
                }
                return;
            }

            const decoder = new TextDecoder();
            let raw = '';
            let lastVisible = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (!isCurrentRequest()) {
                        try { reader.cancel(); } catch (_) { /* ignore */ }
                        return;
                    }
                    if (done) break;
                    raw += decoder.decode(value, { stream: true });

                    if (hasActiveDiff()) {
                        try { reader.cancel(); } catch (_) { /* ignore */ }
                        if (isCurrentRequest()) setAiCompletionState('idle');
                        return;
                    }

                    const { text: visible, stable } = renderVisible(raw);
                    if (visible && visible !== lastVisible && !isCompletionEcho(visible, beforeCursor, afterCursor)) {
                        lastVisible = visible;
                        pushSuggestion(visible, { stable });
                    }
                }

                // Flush any remaining bytes in the decoder. Stream just ended
                // so anything still in flight is now stable — re-push to
                // upgrade the cache flag even if the visible text didn't
                // change in this final pass.
                if (!isCurrentRequest()) return;
                raw += decoder.decode();
                const { text: visible } = renderVisible(raw);
                if (visible && !isCompletionEcho(visible, beforeCursor, afterCursor)) {
                    pushSuggestion(visible, { stable: true });
                } else if (!visible && !lastVisible) {
                    setAiCompletionState('idle');
                    recordAiCompletionEvent('rejected', {
                        reason: !raw.trim() ? 'empty_response' : 'echo_or_unsanitized',
                        request_id: requestId,
                        latency_ms: Date.now() - fireStartedAt,
                    });
                    recordAiReplaySample({
                        feature: 'autocomplete',
                        phase: 'rejected',
                        requestId,
                        payload: {
                            reason: !raw.trim() ? 'empty_response' : 'echo_or_unsanitized',
                            latency_ms: Date.now() - fireStartedAt,
                            raw,
                        },
                    });
                }
            } catch (e) {
                if (isCurrentRequest()) setAiCompletionState('idle');
            }
        })()
            .catch(() => {
                if (isCurrentRequest()) setAiCompletionState('idle');
            })
            .finally(() => {
                if (aiCompletionAbortControllerRef.current === controller) {
                    aiCompletionAbortControllerRef.current = null;
                }
                if (aiCompletionActiveRequestIdRef.current === requestId) {
                    aiCompletionActiveRequestIdRef.current = null;
                }
            });
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
        aiDebounceTimerRef
    };
};
