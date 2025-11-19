// src/app/Editor.jsx
'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { getMonacoLanguage } from '@/utils/languageMapper';
import dynamic from 'next/dynamic';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
    selectActiveFile,
    selectCurrentContent,
    selectIsUnsaved,
    selectBreadcrumb,
    saveFileContentThunk,
    updateContent
} from '@/redux/workspaceSlice';
import { selectAutoSaveEnabled } from '@/redux/uiSlice';
import { Folder, FileText, Circle, Save, Sparkles } from 'lucide-react'; // Added Sparkles
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from '@/components/ui/resizable';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
    AI_COMPLETION_STOP_SEQUENCE,
    AI_COMPLETION_MAX_INPUT_CHARS,
    API_COMPLETION_ROUTE,
} from '@/lib/completion';
import { diffLines, applyPatch } from 'diff';
import prettier from "prettier/standalone";
import babel from "prettier/plugins/babel";
import estree from "prettier/plugins/estree";

const trimCompletionContext = (code) => {
    if (!code) return '';
    if (code.length <= AI_COMPLETION_MAX_INPUT_CHARS) return code;
    return code.slice(-AI_COMPLETION_MAX_INPUT_CHARS);
};

const TerminalManagerDyn = dynamic(() => import('../TerminalManager.jsx'), {
    ssr: false
});

// --- Configuration for a "Sleek" VS Code / Cursor feel ---
const EDITOR_OPTIONS = {
    minimap: { 
        enabled: true, 
        scale: 0.75, 
        renderCharacters: false // Cleaner look
    },
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, 'Courier New', monospace",
    fontLigatures: true, // Essential for "sleek" feel
    fontSize: 14,
    lineHeight: 24,
    letterSpacing: 0.5,
    wordWrap: 'off',
    scrollBeyondLastLine: false,
    automaticLayout: true,
    cursorBlinking: "smooth", // Smooth fading cursor
    cursorSmoothCaretAnimation: "on", // Cursor glides
    smoothScrolling: true,
    contextmenu: false, // We use our own custom context menu
    padding: { top: 16, bottom: 16 },
    bracketPairColorization: { enabled: true }, // VS Code style brackets
    guides: {
        indentation: true,
        bracketPairs: true,
    },
    scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        verticalHasArrows: false,
        horizontalHasArrows: false,
    },
    renderLineHighlight: "all", // Highlight line number and gutter
    lineNumbersMinChars: 4,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
    hover: {
        enabled: true,
        delay: 300,
    }
    ,glyphMargin: true,
};

const EditorPanel = ({
    onRun,
    onToggleTerminal,
    onEditorMount,
    analysisResult,
    latestCompletion,
    aiBusy = false,
}) => {
    const dispatch = useAppDispatch();

    // Global state access
    const activeFile = useAppSelector(selectActiveFile);
    const code = useAppSelector(selectCurrentContent);
    const isUnsaved = useAppSelector(selectIsUnsaved);
    const breadcrumb = useAppSelector(selectBreadcrumb);
    const showTerminal = useAppSelector(state => state.ui.showTerminal);
    const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);

    // Local state
    const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
    const [editorInstance, setEditorInstance] = useState(null);
    const [monacoInstance, setMonacoInstance] = useState(null);
    const [aiCompletionState, setAiCompletionState] = useState('idle');
    
    // Refs
    const hoverProviderRef = useRef(null);
    const floatingWidgetRef = useRef(null);
    const hoverWidgetTimeoutRef = useRef(null);
    const completionProviderRef = useRef(null);
    const inlineCompletionProviderRef = useRef(null);
    const aiCompletionCursorRef = useRef(null);
    const aiCompletionCacheRef = useRef({ context: '', language: '', suggestion: '' });
    const aiCompletionAbortControllerRef = useRef(null);
    const aiLastRequestRef = useRef({ context: '', time: 0 });
    const aiDebounceTimerRef = useRef(null);
    const eventDisposablesRef = useRef([]);
    const prevActiveFileRef = useRef(null);
    const inlineAcceptCommandIdRef = useRef(null);
    
    const activeLanguage = activeFile ? getMonacoLanguage(activeFile.name) : 'plaintext';
    const activeFileIdentity = activeFile ? `${activeFile.path ?? ''}-${activeFile.name ?? ''}` : 'no-file';

    // --- AI Logic ---

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

    const requestAiCompletion = useCallback((isAutoTrigger = false, manualContext = null) => {
        if (!activeFile || !editorInstance) return;

        const rawContext = typeof manualContext === 'string' ? manualContext : (code || '');
        const context = trimCompletionContext(rawContext);
        if (!context.trim()) return;

        const cursorPosition = editorInstance.getPosition();
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
        if (aiLastRequestRef.current.context === context && (now - aiLastRequestRef.current.time) < 2000) {
            return;
        }
        aiLastRequestRef.current = { context, time: now };

        aiCompletionCursorRef.current = cursorPosition ? { ...cursorPosition } : null;
        aiCompletionAbortControllerRef.current?.abort();
        
        const controller = new AbortController();
        aiCompletionAbortControllerRef.current = controller;
        setAiCompletionState('loading');

        fetch(API_COMPLETION_ROUTE, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: context, language: activeLanguage }),
        })
        .then(async (res) => {
            if (!res.ok) throw new Error('Failed');
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
                    const p = editorInstance.trigger('ai-inline', 'editor.action.inlineSuggest.trigger', {});
                    if (p && typeof p.then === 'function') p.catch(() => {});
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
    }, [activeFile, activeLanguage, code, editorInstance]);

    // --- Monaco Providers ---

    // 1. Inline Completion Provider (The "Ghost Text")
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        inlineCompletionProviderRef.current?.dispose();

        const provider = monacoInstance.languages.registerInlineCompletionsProvider(activeLanguage, {
            provideInlineCompletions: (model, position) => {
                const cached = aiCompletionCacheRef.current;
                const cursor = aiCompletionCursorRef.current;

                // Only show if we have a suggestion and the cursor hasn't moved far (or is the same)
                if (!cached?.suggestion || !cursor) return { items: [] };
                
                // Simple validation: line must match
                if (position.lineNumber !== cursor.lineNumber) return { items: [] };

                let visibleText = cached.suggestion;
                
                // Smart overlap check for Monaco's ghost text
                try {
                    const offset = model.getOffsetAt(cursor);
                    // We might need to adjust if the user typed a few characters since the request started
                    // For now, we stick to exact position matching for stability
                } catch(e) {}

                return {
                    items: [{
                        insertText: visibleText,
                        range: new monacoInstance.Range(
                            position.lineNumber, position.column,
                            position.lineNumber, position.column
                        ),
                        command: inlineAcceptCommandIdRef.current ? { id: inlineAcceptCommandIdRef.current } : undefined
                    }]
                };
            },
            freeInlineCompletions: () => {},
            // Some Monaco builds call `disposeInlineCompletions` when disposing providers.
            // Add an alias to be defensive across versions to avoid runtime errors.
            disposeInlineCompletions: () => {}
        });
        inlineCompletionProviderRef.current = provider;

        return () => inlineCompletionProviderRef.current?.dispose();
    }, [editorInstance, monacoInstance, activeLanguage, aiCompletionState]);

    // 2. Register Command for Accept
    useEffect(() => {
        if (!editorInstance) return;
        const commandId = editorInstance.addCommand(0, () => {
            const cached = aiCompletionCacheRef.current;
            if (cached?.suggestion) {
                applyAiCompletionText(cached.suggestion);
            }
        });
        inlineAcceptCommandIdRef.current = commandId;
    }, [editorInstance, applyAiCompletionText]);

    // 3. Hover Provider (Diagnostics)
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        hoverProviderRef.current?.dispose();
        hoverProviderRef.current = monacoInstance.languages.registerHoverProvider(activeLanguage, {
            provideHover: (model, position) => {
                // First check analysis markers as before
                const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
                const hits = markers.filter(m => 
                    position.lineNumber >= m.startLineNumber && position.lineNumber <= m.endLineNumber &&
                    position.column >= m.startColumn && position.column <= m.endColumn
                );
                const contents = [];

                if (hits.length) {
                    hits.forEach(m => contents.push({ value: `**${m.severity === 8 ? 'Error' : 'Warning'}**: ${m.message}` }));
                }

                // If AI hunks are mapped to this line, show the full hunk as a diff in the hover
                try {
                    const hunkMap = aiCompletionCacheRef.current._hunksByLine || {};
                    const lineHunks = hunkMap[position.lineNumber] || [];
                    if (lineHunks.length) {
                        lineHunks.forEach((h) => {
                            // Render the hunk as a code block in the hover (markdown diff)
                            const safeText = h.text || '';
                            contents.push({ value: `\n\n\`\`\`diff\n${safeText.replace(/```/g, '```') }\n\`\`\`` });
                        });
                    }
                } catch (e) {
                    // ignore
                }

                if (!contents.length) return null;

                // Prefer marker range if available, otherwise return a single-line range
                const range = hits.length ? new monacoInstance.Range(hits[0].startLineNumber, hits[0].startColumn, hits[0].endLineNumber, hits[0].endColumn) : new monacoInstance.Range(position.lineNumber, 1, position.lineNumber, 1);
                return { range, contents };
            }
        });
        return () => hoverProviderRef.current?.dispose();
    }, [monacoInstance, editorInstance, activeLanguage]);

    // --- Event Handlers ---

    const handleCodeChange = (newCode) => {
        dispatch(updateContent(newCode));
        
        // Reset specific AI state
        setAiCompletionState('idle');
        aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
        
        // Debounce AI Auto-Complete (The "Cursor" experience)
        if (aiDebounceTimerRef.current) clearTimeout(aiDebounceTimerRef.current);
        aiDebounceTimerRef.current = setTimeout(() => {
            // Auto-trigger AI after 600ms of inactivity using the latest buffer
            requestAiCompletion(true, newCode);
        }, 600);
    };

    const handleSave = useCallback(() => {
        if (activeFile && isUnsaved) dispatch(saveFileContentThunk());
    }, [activeFile, isUnsaved, dispatch]);

    // Auto-save
    useEffect(() => {
        if (!autoSaveEnabled || !isUnsaved || !activeFile) return;
        const t = setTimeout(() => dispatch(saveFileContentThunk()), 500);
        return () => clearTimeout(t);
    }, [code, autoSaveEnabled, isUnsaved, activeFile, dispatch]);

    // Key bindings (Ctrl+S, Alt+F)
    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                handleSave();
            }
            // Format: Alt+F
            if (e.altKey && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                editorInstance?.getAction('editor.action.formatDocument')?.run();
            }
            // Apply hunk at cursor: Alt+Enter
            if (e.altKey && (e.key === 'Enter' || e.key === 'Return')) {
                try {
                    e.preventDefault();
                    const pos = editorInstance?.getPosition();
                    if (!pos) return;
                    const line = pos.lineNumber;
                    const map = aiCompletionCacheRef.current._hunksByLine || {};
                    const hunks = map[line] || [];
                    if (!hunks.length) return;
                    const hunk = hunks[0];
                    const confirmApply = window.confirm('Apply this hunk to the editor? (Alt+Enter)');
                    if (!confirmApply) return;
                    const model = editorInstance.getModel();
                    const original = model.getValue();
                    const patched = applyPatch(original, hunk.patchForHunk);
                    if (patched === false) {
                        setAiCompletionState('idle');
                        return;
                    }
                    editorInstance.setValue(patched);
                    aiCompletionCacheRef.current._hunkDecorationIds = [];
                    aiCompletionCacheRef.current._hunksByLine = {};
                } catch (err) {
                    // ignore
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [handleSave, editorInstance]);

    // Handle updates from analysis (Markers)
    useEffect(() => {
        if (!editorInstance || !monacoInstance || !analysisResult) return;
        const issues = analysisResult?.static_analysis || analysisResult?.issues || [];
        const markers = issues.map(issue => ({
            startLineNumber: issue.line === 0 ? 1 : issue.line + 1,
            startColumn: Math.max(1, (issue.column || 0) + 1),
            endLineNumber: issue.end_line ? issue.end_line + 1 : (issue.line === 0 ? 1 : issue.line + 1),
            endColumn: issue.end_column ? issue.end_column + 1 : 100,
            message: issue.message,
            severity: issue.severity === 'error' ? monacoInstance.MarkerSeverity.Error : monacoInstance.MarkerSeverity.Warning
        }));
        monacoInstance.editor.setModelMarkers(editorInstance.getModel(), 'analysis', markers);
    }, [editorInstance, monacoInstance, analysisResult]);

    // Handle external completion triggering (e.g. from Chat UI)
    useEffect(() => {
        if (latestCompletion) {
            // If parent passed a completion, inject it into cache and trigger
            const text = typeof latestCompletion === 'string' ? latestCompletion : latestCompletion.completion;
            if (text) {
                const sanitized = text.split(AI_COMPLETION_STOP_SEQUENCE)[0];
                aiCompletionCacheRef.current = {
                    context: code,
                    language: activeLanguage,
                    suggestion: sanitized
                };
                setAiCompletionState('ready');
                try {
                    const p = editorInstance?.trigger('ai-external', 'editor.action.inlineSuggest.trigger', {});
                    if (p && typeof p.then === 'function') p.catch(() => {});
                } catch(e){}
            }
        }
    }, [latestCompletion, editorInstance, code, activeLanguage]);

    // When parent provides hunks (from AIChatWindow), render glyph margin widgets
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        const hunks = latestCompletion && typeof latestCompletion === 'object' ? latestCompletion.hunks || [] : [];
        // Clear previous hunk mapping decorations
        const prevIds = aiCompletionCacheRef.current._hunkDecorationIds || [];
        try {
            // Remove previous decorations
            if (prevIds.length) editorInstance.deltaDecorations(prevIds, []);

            if (!hunks || hunks.length === 0) {
                aiCompletionCacheRef.current._hunkDecorationIds = [];
                aiCompletionCacheRef.current._hunksByLine = {};
                return;
            }

            const model = editorInstance.getModel();
            if (!model) return;

            const newDecs = [];
            const hunkMap = {};

            hunks.forEach((hunk) => {
                // Parse the hunk header to discover affected old/new line ranges
                // Header format: @@ -oldStart,oldCount +newStart,newCount @@
                const m = hunk.text.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
                let oldStart = null, oldCount = 1, newStart = null, newCount = 1;
                if (m) {
                    oldStart = parseInt(m[1], 10);
                    if (m[2]) oldCount = parseInt(m[2], 10);
                    newStart = parseInt(m[3], 10);
                    if (m[4]) newCount = parseInt(m[4], 10);
                }

                // Choose a primary decoration line (prefer the newStart if available)
                const primaryLine = newStart ? Math.max(1, newStart) : (oldStart ? Math.max(1, oldStart) : model.getLineCount());

                // Create a decoration with a glyph margin marker at the primary line
                newDecs.push({
                    range: new monacoInstance.Range(primaryLine, 1, primaryLine, 1),
                    options: {
                        isWholeLine: true,
                        className: 'ai-hunk-line',
                        glyphMarginClassName: 'ai-hunk-glyph',
                        hoverMessage: { value: `Hunk: click (Alt+Click) to apply` }
                    }
                });

                // Map every affected old and new line number to this hunk so the widget
                // can appear when hovering any changed line.
                if (oldStart) {
                    for (let i = 0; i < oldCount; i++) {
                        const ln = Math.max(1, oldStart + i);
                        if (!hunkMap[ln]) hunkMap[ln] = [];
                        hunkMap[ln].push(hunk);
                    }
                }
                if (newStart) {
                    for (let i = 0; i < newCount; i++) {
                        const ln = Math.max(1, newStart + i);
                        if (!hunkMap[ln]) hunkMap[ln] = [];
                        hunkMap[ln].push(hunk);
                    }
                }
            });

            const ids = editorInstance.deltaDecorations([], newDecs);
            aiCompletionCacheRef.current._hunkDecorationIds = ids;
            aiCompletionCacheRef.current._hunksByLine = hunkMap;
        } catch (e) {
            // ignore errors
        }
    }, [latestCompletion, editorInstance, monacoInstance]);

    // Handle Alt+click on editor to apply a hunk mapped to the clicked line
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        const handler = editorInstance.onMouseDown((e) => {
            try {
                if (!e.event.altKey) return; // require Alt+click to avoid accidental applies
                const pos = e.target.position;
                if (!pos) return;
                const line = pos.lineNumber;
                const map = aiCompletionCacheRef.current._hunksByLine || {};
                const hunks = map[line] || [];
                if (!hunks.length) return;
                // If multiple hunks, pick first; prompt user
                const hunk = hunks[0];
                const confirmApply = window.confirm('Apply this hunk to the editor? (Alt+Click)');
                if (confirmApply) {
                    // apply via the same logic used by chat (we'll call a small helper inline)
                    const model = editorInstance.getModel();
                    const original = model.getValue();
                    const patched = applyPatch(original, hunk.patchForHunk);
                    if (patched === false) {
                        setAiCompletionState('idle');
                        return;
                    }
                    editorInstance.setValue(patched);
                    aiCompletionCacheRef.current._hunkDecorationIds = [];
                    aiCompletionCacheRef.current._hunksByLine = {};
                }
            } catch (err) {
                // ignore
            }
        });

        return () => handler?.dispose?.();
    }, [editorInstance, monacoInstance]);

    // Floating inline hunk preview widget (non-modal) shown when hovering a hunk glyph/line
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        const showWidget = (line, hunk) => {
            try {
                const domNode = editorInstance.getDomNode();
                if (!domNode) return;

                // Remove existing widget
                if (floatingWidgetRef.current) {
                    floatingWidgetRef.current.remove();
                    floatingWidgetRef.current = null;
                }

                const pos = editorInstance.getScrolledVisiblePosition ? editorInstance.getScrolledVisiblePosition({ lineNumber: line, column: 1 }) : null;
                const top = pos ? pos.top : (editorInstance.getTopForLineNumber ? editorInstance.getTopForLineNumber(line) : 0);

                const widget = document.createElement('div');
                widget.className = 'ai-hunk-widget';
                widget.style.position = 'absolute';
                widget.style.zIndex = 1000;
                widget.style.maxWidth = '420px';
                widget.style.left = '48px';
                widget.style.top = `${top + 4}px`;
                widget.style.background = '#0b0b0b';
                widget.style.border = '1px solid rgba(69,69,69,0.6)';
                widget.style.padding = '8px';
                widget.style.borderRadius = '6px';
                widget.style.boxShadow = '0 6px 18px rgba(0,0,0,0.6)';
                widget.style.color = '#e6e6e6';
                widget.style.fontSize = '12px';
                widget.style.fontFamily = "'JetBrains Mono', monospace";

                // Content: show a small diff preview plus actions
                const pre = document.createElement('div');
                pre.style.whiteSpace = 'pre-wrap';
                pre.style.maxHeight = '160px';
                pre.style.overflow = 'auto';
                pre.style.margin = '0 0 8px 0';
                pre.style.display = 'flex';
                pre.style.flexDirection = 'column';
                pre.style.gap = '6px';

                // Render before (removed) in red and after (added) in green
                const lines = (hunk.text || '').split('\n');
                const beforeBlock = document.createElement('div');
                const afterBlock = document.createElement('div');
                beforeBlock.style.whiteSpace = 'pre-wrap';
                afterBlock.style.whiteSpace = 'pre-wrap';
                beforeBlock.style.color = '#ffdcdc';
                afterBlock.style.color = '#d6ffd6';
                beforeBlock.style.background = 'rgba(239,68,68,0.04)';
                afterBlock.style.background = 'rgba(16,185,129,0.04)';
                beforeBlock.style.padding = '6px';
                afterBlock.style.padding = '6px';
                beforeBlock.style.borderRadius = '4px';
                afterBlock.style.borderRadius = '4px';

                let hasBefore = false;
                let hasAfter = false;
                lines.forEach((ln) => {
                    if (ln.startsWith('-')) {
                        const el = document.createElement('div');
                        el.textContent = ln.replace(/^-/,'');
                        el.style.color = '#c53030';
                        el.style.fontFamily = "'JetBrains Mono', monospace";
                        beforeBlock.appendChild(el);
                        hasBefore = true;
                    } else if (ln.startsWith('+')) {
                        const el = document.createElement('div');
                        el.textContent = ln.replace(/^\+/,'');
                        el.style.color = '#15803d';
                        el.style.fontFamily = "'JetBrains Mono', monospace";
                        afterBlock.appendChild(el);
                        hasAfter = true;
                    }
                });

                if (hasBefore) pre.appendChild(beforeBlock);
                if (hasAfter) pre.appendChild(afterBlock);

                const actions = document.createElement('div');
                actions.style.display = 'flex';
                actions.style.gap = '8px';

                const applyBtn = document.createElement('button');
                applyBtn.textContent = 'Apply Hunk';
                applyBtn.className = 'ai-hunk-widget-apply';
                applyBtn.onclick = () => {
                    try {
                        const model = editorInstance.getModel();
                        const original = model.getValue();
                        const patched = applyPatch(original, hunk.patchForHunk);
                        if (patched === false) {
                            setAiCompletionState('idle');
                            alert('Failed to apply hunk: context mismatch.');
                            return;
                        }
                        editorInstance.setValue(patched);
                        // remove widget
                        if (floatingWidgetRef.current) {
                            floatingWidgetRef.current.remove();
                            floatingWidgetRef.current = null;
                        }
                        aiCompletionCacheRef.current._hunkDecorationIds = [];
                        aiCompletionCacheRef.current._hunksByLine = {};
                    } catch (err) {
                        // ignore
                    }
                };

                const copyBtn = document.createElement('button');
                copyBtn.textContent = 'Copy Hunk';
                copyBtn.className = 'ai-hunk-widget-copy';
                copyBtn.onclick = async () => {
                    try {
                        await navigator.clipboard.writeText(hunk.text || '');
                    } catch (err) {}
                };

                actions.appendChild(applyBtn);
                actions.appendChild(copyBtn);

                widget.appendChild(pre);
                widget.appendChild(actions);

                domNode.appendChild(widget);
                floatingWidgetRef.current = widget;
            } catch (e) {
                // ignore
            }
        };

        const hideWidget = () => {
            if (floatingWidgetRef.current) {
                floatingWidgetRef.current.remove();
                floatingWidgetRef.current = null;
            }
        };

        // Use Monaco editor mouse events (gives position info) instead of raw DOM mousemove
        const mouseMoveDisposable = editorInstance.onMouseMove((e) => {
            try {
                const pos = e.target.position;
                if (!pos) {
                    if (hoverWidgetTimeoutRef.current) clearTimeout(hoverWidgetTimeoutRef.current);
                    hoverWidgetTimeoutRef.current = setTimeout(hideWidget, 300);
                    return;
                }
                const line = pos.lineNumber;
                const map = aiCompletionCacheRef.current._hunksByLine || {};
                const hunks = map[line] || [];
                if (hunks.length) {
                    if (hoverWidgetTimeoutRef.current) clearTimeout(hoverWidgetTimeoutRef.current);
                    showWidget(line, hunks[0]);
                } else {
                    if (hoverWidgetTimeoutRef.current) clearTimeout(hoverWidgetTimeoutRef.current);
                    hoverWidgetTimeoutRef.current = setTimeout(hideWidget, 300);
                }
            } catch (err) {
                // ignore
            }
        });

        const mouseLeaveDisposable = editorInstance.onMouseLeave(() => {
            if (hoverWidgetTimeoutRef.current) clearTimeout(hoverWidgetTimeoutRef.current);
            hoverWidgetTimeoutRef.current = setTimeout(() => {
                if (floatingWidgetRef.current) {
                    floatingWidgetRef.current.remove();
                    floatingWidgetRef.current = null;
                }
            }, 150);
        });

        return () => {
            try { mouseMoveDisposable?.dispose(); } catch(e){}
            try { mouseLeaveDisposable?.dispose(); } catch(e){}
            hideWidget();
            if (hoverWidgetTimeoutRef.current) clearTimeout(hoverWidgetTimeoutRef.current);
        };
    }, [editorInstance, monacoInstance]);


    // When a completion arrives that contains a full-file suggestion, compute
    // a line-based diff and show inline decorations in the editor so changes
    // are visible directly inside the file.
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        // Remove previous decorations if any
        const prevIds = aiCompletionCacheRef.current._decorationIds || [];

        try {
            const suggested = latestCompletion ? (typeof latestCompletion === 'string' ? latestCompletion : latestCompletion.completion) : null;
            if (!suggested) {
                if (prevIds.length) {
                    editorInstance.deltaDecorations(prevIds, []);
                    aiCompletionCacheRef.current._decorationIds = [];
                }
                return;
            }

            const model = editorInstance.getModel();
            if (!model) return;

            const original = model.getValue();
            const parts = diffLines(original, suggested);

            const newDecs = [];
            let oldLine = 1;
            let newLine = 1;

            parts.forEach((part) => {
                const lines = part.value.split('\n');
                if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

                if (part.added) {
                    // For added lines, highlight the nearest existing line (or
                    // last line) and attach hover content showing the added text.
                    const modelLineCount = model.getLineCount();
                    // Place decoration on `oldLine` if valid, otherwise on last line.
                    const insertAt = Math.min(Math.max(1, oldLine), modelLineCount);
                    const addedText = lines.join('\n');
                    newDecs.push({
                        range: new monacoInstance.Range(insertAt, 1, insertAt, 1),
                        options: {
                            isWholeLine: true,
                            className: 'ai-added-line',
                            hoverMessage: { value: `+ ${addedText}` },
                        }
                    });
                    newLine += lines.length;
                } else if (part.removed) {
                    // For removed lines, highlight the actual removed lines and
                    // include hover text showing what was removed.
                    for (let i = 0; i < lines.length; i++) {
                        const ln = oldLine + i;
                        const removedText = lines[i];
                        newDecs.push({
                            range: new monacoInstance.Range(ln, 1, ln, 1),
                            options: {
                                isWholeLine: true,
                                className: 'ai-removed-line',
                                hoverMessage: { value: `- ${removedText}` },
                            }
                        });
                    }
                    oldLine += lines.length;
                } else {
                    oldLine += lines.length;
                    newLine += lines.length;
                }
            });

            // Inject CSS for decoration classes if not present
            if (!document.getElementById('ai-diff-styles')) {
                const style = document.createElement('style');
                style.id = 'ai-diff-styles';
                style.innerHTML = `
                    .ai-added-line { background: rgba(16,185,129,0.06) !important; }
                    .ai-removed-line { background: rgba(239,68,68,0.05) !important; text-decoration: line-through; }
                    .ai-hunk-glyph { background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="%2384cc16"/></svg>') center center no-repeat; }
                    .ai-hunk-line { outline: 1px dashed rgba(132,204,22,0.15) !important; }
                `;
                document.head.appendChild(style);
            }

            const newIds = editorInstance.deltaDecorations(prevIds || [], newDecs);
            aiCompletionCacheRef.current._decorationIds = newIds;
        } catch (e) {
            // ignore
        }
    }, [latestCompletion, editorInstance, monacoInstance]);


    // --- Render ---

    return (
        <ResizablePanel defaultSize={76} minSize={20}>
            <ResizablePanelGroup direction="vertical" className="h-full">
                <ResizablePanel defaultSize={70} minSize={20}>
                    <div className="h-full flex flex-col bg-[#1e1e1e]">
                        {/* Minimal Sleek Header */}
                        <div className="h-9 px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] flex justify-between items-center select-none">
                            
                            {/* Breadcrumbs */}
                            <div className="flex items-center gap-2 overflow-hidden">
                                {breadcrumb?.length > 0 ? (
                                    breadcrumb.map((name, idx) => {
                                        const isLast = idx === breadcrumb.length - 1;
                                        return (
                                            <div key={idx} className="flex items-center text-[13px]">
                                                <span className={`${isLast ? 'text-gray-200 font-medium' : 'text-gray-500'}`}>
                                                    {name}
                                                </span>
                                                {!isLast && <span className="text-gray-600 mx-1">/</span>}
                                            </div>
                                        )
                                    })
                                ) : (
                                    <span className="text-gray-500 text-xs italic">No file selected</span>
                                )}
                                {isUnsaved && <Circle className="w-2 h-2 ml-2 text-blue-400 fill-blue-400" />}
                            </div>

                            {/* Status & Controls */}
                            <div className="flex items-center gap-4">
                                {/* Line/Col Info */}
                                <div className="hidden md:flex gap-3 text-[11px] text-gray-500 font-mono">
                                    <span>Ln {position.lineNumber}, Col {position.column}</span>
                                </div>

                                {/* AI Status Indicator (Subtle) */}
                                <div className={`transition-opacity duration-300 ${(aiCompletionState === 'loading' || aiBusy) ? 'opacity-100' : 'opacity-0'}`}>
                                    <Sparkles className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
                                </div>
                                
                                {/* Manual Save (Optional since we have auto-save) */}
                                <button onClick={handleSave} className="opacity-60 hover:opacity-100 transition-opacity">
                                    <Save className="w-4 h-4 text-gray-400" />
                                </button>
                            </div>
                        </div>

                        {/* Editor Container */}
                        <div className="flex-1 overflow-hidden relative group">
                            <ContextMenu>
                                <ContextMenuTrigger asChild>
                                    <div className="h-full w-full">
                                        <Editor
                                            key={activeFileIdentity}
                                            height="100%"
                                            defaultValue={code}
                                            language={activeLanguage}
                                            theme="vs-dark"
                                            options={EDITOR_OPTIONS}
                                            onChange={handleCodeChange}
                                            onMount={(editor, monaco) => {
                                                setEditorInstance(editor);
                                                setMonacoInstance(monaco);
                                                if (onEditorMount) onEditorMount(editor);
                                                editor.onDidChangeCursorPosition(e => setPosition(e.position));
                                                
                                                // Ensure layout refreshes on mount
                                                setTimeout(() => editor.layout(), 100);
                                            }}
                                        />
                                    </div>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-56 bg-[#252526] border-[#454545] text-gray-200">
                                    <ContextMenuItem onClick={onRun}>Run File</ContextMenuItem>
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('editor.action.formatDocument')?.run()}>
                                        Format Document
                                    </ContextMenuItem>
                                    <ContextMenuSeparator className="bg-[#454545]" />
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('actions.find')?.run()}>
                                        Find
                                    </ContextMenuItem>
                                    <ContextMenuItem onClick={() => requestAiCompletion()}>
                                        Trigger AI Suggestion
                                    </ContextMenuItem>
                                </ContextMenuContent>
                            </ContextMenu>
                        </div>
                    </div>
                </ResizablePanel>
                
                {showTerminal && (
                    <>
                        <ResizableHandle withHandle className="bg-[#1e1e1e] border-t border-[#2b2b2b]" />
                        <ResizablePanel defaultSize={30} minSize={15}>
                            <TerminalManagerDyn visible={true} onCloseAll={onToggleTerminal} />
                        </ResizablePanel>
                    </>
                )}
            </ResizablePanelGroup>
        </ResizablePanel>
    );
};

export default EditorPanel;