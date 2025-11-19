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
import { diffLines } from 'diff';
import prettier from "prettier/standalone";
import babel from "prettier/plugins/babel";
import estree from "prettier/plugins/estree";

const trimCompletionContext = (code, cursorPosition = null) => {
    if (!code) return '';
    if (code.length <= AI_COMPLETION_MAX_INPUT_CHARS) return code;

    if (!cursorPosition) {
        return code.slice(-AI_COMPLETION_MAX_INPUT_CHARS);
    }

    const lines = code.split(/\r?\n/);
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const lineIndex = clamp((cursorPosition.lineNumber || 1) - 1, 0, lines.length - 1);
    const columnIndex = clamp((cursorPosition.column || 1) - 1, 0, lines[lineIndex]?.length ?? 0);

    let offset = 0;
    for (let i = 0; i < lineIndex; i++) {
        offset += (lines[i]?.length ?? 0) + 1; // account for newline
    }
    offset += columnIndex;

    const halfWindow = Math.floor(AI_COMPLETION_MAX_INPUT_CHARS / 2);
    let start = Math.max(0, offset - halfWindow);
    let end = Math.min(code.length, start + AI_COMPLETION_MAX_INPUT_CHARS);

    if ((end - start) < AI_COMPLETION_MAX_INPUT_CHARS) {
        start = Math.max(0, end - AI_COMPLETION_MAX_INPUT_CHARS);
    }

    const beforeBreak = code.lastIndexOf('\n', start - 1);
    if (beforeBreak !== -1) start = beforeBreak + 1;
    const afterBreak = code.indexOf('\n', end);
    if (afterBreak !== -1 && afterBreak > end) end = afterBreak;

    return code.slice(start, end);
};

const CONTEXT_SIDE_CHARS = 1600;
const MAX_EDGE_LINES = 60;
const MAX_SELECTION_CHARS = 1200;

const takeLastChars = (value = '', max = CONTEXT_SIDE_CHARS) => {
    if (typeof value !== 'string') return '';
    if (value.length <= max) return value;
    return value.slice(value.length - max);
};

const takeFirstChars = (value = '', max = CONTEXT_SIDE_CHARS) => {
    if (typeof value !== 'string') return '';
    if (value.length <= max) return value;
    return value.slice(0, max);
};

const buildEdgePreview = (lines = [], count = MAX_EDGE_LINES) => {
    if (!Array.isArray(lines) || !lines.length) {
        return { head: '', tail: '' };
    }
    const safeCount = Math.max(1, count);
    const head = lines.slice(0, safeCount).join('\n');
    const tail = lines.slice(-safeCount).join('\n');
    return { head, tail };
};

const clampSelection = (text = '') => {
    if (typeof text !== 'string' || !text.trim()) return '';
    if (text.length <= MAX_SELECTION_CHARS) return text;
    return text.slice(-MAX_SELECTION_CHARS);
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

        fetch(API_COMPLETION_ROUTE, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
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
    }, [activeFile, activeLanguage, breadcrumb, cancelActiveCompletion, code, editorInstance]);

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
        // Keep hover provider only for diagnostics; do not surface AI hunks via hover
        hoverProviderRef.current = monacoInstance.languages.registerHoverProvider(activeLanguage, {
            provideHover: (model, position) => {
                // Only return diagnostics (errors/warnings) in hover. AI hunks are shown
                // as persistent widgets in the editor and should not appear in hovers.
                const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
                const hits = markers.filter(m => 
                    position.lineNumber >= m.startLineNumber && position.lineNumber <= m.endLineNumber &&
                    position.column >= m.startColumn && position.column <= m.endColumn
                );
                if (!hits.length) return null;

                const contents = [];
                hits.forEach(m => contents.push({ value: `**${m.severity === 8 ? 'Error' : 'Warning'}**: ${m.message}` }));

                const range = new monacoInstance.Range(hits[0].startLineNumber, hits[0].startColumn, hits[0].endLineNumber, hits[0].endColumn);
                return { range, contents };
            }
        });
        return () => hoverProviderRef.current?.dispose();
    }, [monacoInstance, editorInstance, activeLanguage]);

    // --- Event Handlers ---

    useEffect(() => {
        if (!editorInstance) return;
        const disposables = [];
        try {
            disposables.push(editorInstance.onDidType(() => {
                cancelActiveCompletion({ resetSuggestion: true, reason: 'typing' });
            }));
            disposables.push(editorInstance.onDidChangeCursorSelection(() => {
                cancelActiveCompletion({ resetSuggestion: true, reason: 'cursor-move' });
            }));
        } catch (e) {
            // ignore if monaco is missing APIs
        }

        return () => {
            disposables.forEach((disposable) => disposable?.dispose?.());
        };
    }, [editorInstance, cancelActiveCompletion]);

    const handleCodeChange = (newCode) => {
        cancelActiveCompletion({ resetSuggestion: true, reason: 'edit' });
        dispatch(updateContent(newCode));
        
        // Debounce AI Auto-Complete (The "Cursor" experience)
        if (aiDebounceTimerRef.current) clearTimeout(aiDebounceTimerRef.current);
        aiDebounceTimerRef.current = setTimeout(() => {
            // Auto-trigger AI after a brief pause using the latest buffer
            requestAiCompletion(true, newCode);
        }, 400);
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


    // When a completion arrives that contains a full-file suggestion, compute
    // a line-based diff and show inline decorations in the editor so changes
    // are visible directly inside the file.
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        const removeDiffViewZones = () => {
            try {
                const prevZones = aiCompletionCacheRef.current._diffViewZoneIds || [];
                if (prevZones.length) {
                    editorInstance.changeViewZones(accessor => {
                        prevZones.forEach(id => accessor.removeZone(id));
                    });
                }
            } catch (e) {
                // ignore
            } finally {
                aiCompletionCacheRef.current._diffViewZoneIds = [];
            }
        };

        // Remove previous decorations if any
        const prevIds = aiCompletionCacheRef.current._decorationIds || [];

        try {
            const suggested = latestCompletion ? (typeof latestCompletion === 'string' ? latestCompletion : latestCompletion.completion) : null;
            if (!suggested) {
                if (prevIds.length) {
                    editorInstance.deltaDecorations(prevIds, []);
                    aiCompletionCacheRef.current._decorationIds = [];
                }
                removeDiffViewZones();
                return;
            }

            const model = editorInstance.getModel();
            if (!model) return;

            const original = model.getValue();
            const parts = diffLines(original, suggested);

            const newDecs = [];
            const additionBlocks = [];
            let oldLine = 1;
            let newLine = 1;
            const modelLineCount = model.getLineCount();

            parts.forEach((part) => {
                const lines = part.value.split('\n');
                if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

                if (part.added) {
                    // Highlight the host line (if any) and capture a view zone to show inserted lines.
                    const insertAtLine = Math.min(Math.max(1, oldLine), modelLineCount);
                    newDecs.push({
                        range: new monacoInstance.Range(insertAtLine, 1, insertAtLine, 1),
                        options: {
                            isWholeLine: true,
                            className: 'ai-added-line'
                        }
                    });
                    additionBlocks.push({
                        afterLineNumber: Math.max(0, Math.min(modelLineCount, oldLine - 1)),
                        lines
                    });
                    newLine += lines.length;
                } else if (part.removed) {
                    for (let i = 0; i < lines.length; i++) {
                        const ln = oldLine + i;
                        newDecs.push({
                            range: new monacoInstance.Range(ln, 1, ln, 1),
                            options: {
                                isWholeLine: true,
                                className: 'ai-removed-line'
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
                `;
                document.head.appendChild(style);
            }

            const newIds = editorInstance.deltaDecorations(prevIds || [], newDecs);
            aiCompletionCacheRef.current._decorationIds = newIds;

            // Update inline view zones for inserted blocks
            removeDiffViewZones();
            if (additionBlocks.length) {
                const lineHeight = editorInstance.getOption
                    ? editorInstance.getOption(monacoInstance.editor.EditorOption.lineHeight) || 20
                    : 20;
                const zoneIds = [];
                editorInstance.changeViewZones(accessor => {
                    additionBlocks.forEach((block) => {
                        if (!block.lines.length) return;
                        const domNode = document.createElement('div');
                        domNode.className = 'ai-diff-zone';
                        domNode.style.background = 'rgba(16,185,129,0.08)';
                        domNode.style.border = '1px solid rgba(16,185,129,0.25)';
                        domNode.style.borderRadius = '4px';
                        domNode.style.padding = '6px 8px';
                        domNode.style.margin = '4px 0';
                        domNode.style.fontFamily = "'JetBrains Mono', monospace";
                        domNode.style.fontSize = '12px';
                        domNode.style.color = '#bbf7d0';
                        domNode.style.whiteSpace = 'pre-wrap';

                        const header = document.createElement('div');
                        header.textContent = `+ ${block.lines.length} ${block.lines.length === 1 ? 'line' : 'lines'}`;
                        header.style.fontSize = '11px';
                        header.style.fontWeight = '600';
                        header.style.color = '#34d399';
                        header.style.marginBottom = '4px';
                        domNode.appendChild(header);

                        block.lines.forEach((line) => {
                            const lineEl = document.createElement('div');
                            lineEl.textContent = line || ' ';
                            lineEl.style.borderLeft = '3px solid rgba(16,185,129,0.6)';
                            lineEl.style.paddingLeft = '6px';
                            lineEl.style.marginBottom = '2px';
                            domNode.appendChild(lineEl);
                        });

                        const zoneId = accessor.addZone({
                            afterLineNumber: block.afterLineNumber,
                            heightInPx: (block.lines.length * lineHeight) + 12,
                            domNode
                        });
                        zoneIds.push(zoneId);
                    });
                });
                aiCompletionCacheRef.current._diffViewZoneIds = zoneIds;
            }
        } catch (e) {
            // ignore
        }

        return () => {
            removeDiffViewZones();
        };
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