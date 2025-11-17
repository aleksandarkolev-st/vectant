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
import { Folder, FileText, Circle, Save } from 'lucide-react';
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

const EditorPanel = ({
    onRun,
    onToggleTerminal,
    onEditorMount,
    analysisResult,
    latestCompletion
}) => {
    // Debug: log incoming latestCompletion prop for runtime tracing
    try {
        console.debug('[Editor] mount/render - latestCompletion prop', { latestCompletionPreview: typeof latestCompletion === 'string' ? latestCompletion.slice(0, 120) : (latestCompletion?.completion?.slice(0, 120) || null) });
    } catch (e) { }
    const dispatch = useAppDispatch();

    // Global state access (Granular selectors for performance)
    const activeFile = useAppSelector(selectActiveFile);
    const code = useAppSelector(selectCurrentContent);
    const isUnsaved = useAppSelector(selectIsUnsaved);
    const breadcrumb = useAppSelector(selectBreadcrumb);
    const showTerminal = useAppSelector(state => state.ui.showTerminal);
    const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);

    // Local state retention
    const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
    const [editorInstance, setEditorInstance] = useState(null);
    const [monacoInstance, setMonacoInstance] = useState(null);
    const [aiCompletionState, setAiCompletionState] = useState('idle');
    const [aiCompletionSummary, setAiCompletionSummary] = useState(null);
    const hoverProviderRef = useRef(null);
    const completionProviderRef = useRef(null);
    const aiCompletionCursorRef = useRef(null);
    const aiCompletionCacheRef = useRef({
        context: '',
        language: '',
        suggestion: '',
    });
    const aiCompletionAbortControllerRef = useRef(null);
    const [suggestionsMap, setSuggestionsMap] = useState({});
    const suggestionsMapRef = useRef({});
    const setSuggestionEntry = (key, value) => {
        const next = Object.assign({}, suggestionsMapRef.current, { [key]: value });
        suggestionsMapRef.current = next;
        setSuggestionsMap(next);
    };
    const clearSuggestions = () => {
        suggestionsMapRef.current = {};
        setSuggestionsMap({});
    };
    const ghostDecorationIdsRef = useRef([]);
    const ghostStyleElementRef = useRef(null);
    const ghostClassRef = useRef(null);
    const eventDisposablesRef = useRef([]);
    const prevActiveFileRef = useRef(null);
    const _loadedScripts = useRef({});
    const activeLanguage = activeFile ? getMonacoLanguage(activeFile.name) : 'plaintext';
    const activeFileIdentity = activeFile ? `${activeFile.path ?? ''}-${activeFile.name ?? ''}` : 'no-file';

    const applyAiCompletionText = useCallback(
        (text) => {
            if (!text || !editorInstance || !monacoInstance) return;

            const start =
                aiCompletionCursorRef.current ||
                editorInstance.getPosition() ||
                undefined;
            if (!start) return;

            // Compute visible insertion to avoid duplicating text that already exists after the cursor
            const model = editorInstance.getModel();
            let insertText = text;
            try {
                if (model) {
                    const offset = model.getOffsetAt(start);
                    const existing = model.getValue().slice(offset, offset + text.length);
                    let common = 0;
                    while (
                        common < text.length &&
                        common < existing.length &&
                        text.charAt(common) === existing.charAt(common)
                    ) {
                        common++;
                    }
                    insertText = text.slice(common);
                }
            } catch (e) {
                insertText = text;
            }

            if (insertText) {
                const range = new monacoInstance.Range(
                    start.lineNumber,
                    start.column,
                    start.lineNumber,
                    start.column
                );

                editorInstance.executeEdits('ai', [
                    {
                        range,
                        text: insertText,
                        forceMoveMarkers: true,
                    },
                ]);
                editorInstance.pushUndoStop();
            }
            aiCompletionCursorRef.current = null;

            // Clear the completion provider cache so the suggestion doesn't persist
            aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };

            // Clear any ghost decorations/styles now that suggestion is applied
            try {
                if (ghostDecorationIdsRef.current?.length) {
                    editorInstance.deltaDecorations(ghostDecorationIdsRef.current, []);
                }
            } catch (e) {
                // ignore
            }
            ghostDecorationIdsRef.current = [];
            try {
                if (ghostStyleElementRef.current && ghostStyleElementRef.current.parentNode) {
                    ghostStyleElementRef.current.parentNode.removeChild(ghostStyleElementRef.current);
                }
            } catch (e) {
                // ignore
            }
            ghostStyleElementRef.current = null;
            ghostClassRef.current = null;

            const lines = text.split(/\r?\n/);
            const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
            setAiCompletionSummary({
                preview,
                startLine: start.lineNumber,
                startColumn: start.column,
                lineCount: lines.length,
                status: 'applied',
            });

            // Remove any saved suggestion for this cursor
            try {
                // Clear all previously fetched suggestions so nothing stale remains
                clearSuggestions();
                // also clear any provider cache
                aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
            } catch (e) {
                // ignore
            }
        },
        [editorInstance, monacoInstance]
    );

    // Update markers when analysis results change
    useEffect(() => {
        if (!editorInstance || !monacoInstance || !analysisResult) return;

        const markers = [];

        // Extract issues from analysis result - supports both 'static_analysis' and 'issues' arrays
        const issues = analysisResult?.static_analysis || analysisResult?.issues || [];

        issues.forEach((issue) => {
            const {
                line = 1,
                column = 0,
                end_line,
                end_column,
                message = '',
                severity = 'info', // 'error', 'warning', 'info'
            } = issue;

            // Map severity to Monaco severity
            const monacoSeverity = {
                error: monacoInstance.MarkerSeverity.Error,
                warning: monacoInstance.MarkerSeverity.Warning,
                info: monacoInstance.MarkerSeverity.Information,
            }[severity.toLowerCase()] || monacoInstance.MarkerSeverity.Information;

            // Line numbers in Monaco are 1-indexed, convert from 0-indexed if needed
            const startLine = line === 0 ? 1 : line + 1;
            const finishLine = end_line !== undefined ? (end_line === 0 ? 1 : end_line + 1) : startLine;
            const finishColumn = end_column !== undefined ? Math.max(1, end_column + 1) : Math.max(2, column + 2);

            markers.push({
                startLineNumber: startLine,
                startColumn: Math.max(1, column + 1),
                endLineNumber: finishLine,
                endColumn: finishColumn,
                message,
                severity: monacoSeverity,
                source: 'Static Analysis',
            });
        });

        monacoInstance.editor.setModelMarkers(editorInstance.getModel(), 'analysis', markers);
    }, [editorInstance, monacoInstance, analysisResult]);

    // Register a hover provider so hovering over underlined diagnostics shows a popup
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        // Dispose previous provider if any
        try {
            hoverProviderRef.current?.dispose?.();
        } catch (e) {
            // ignore
        }

        hoverProviderRef.current = monacoInstance.languages.registerHoverProvider(
            activeLanguage,
            {
                provideHover: (model, position) => {
                    const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
                    const hits = markers.filter((m) => {
                        return (
                            position.lineNumber >= m.startLineNumber &&
                            position.lineNumber <= m.endLineNumber &&
                            position.column >= m.startColumn &&
                            position.column <= m.endColumn
                        );
                    });

                    if (!hits.length) return null;

                    // Build markdown contents for all hits at this position
                    const contents = hits.map((m) => {
                        const severity =
                            m.severity === monacoInstance.MarkerSeverity.Error
                                ? 'Error'
                                : m.severity === monacoInstance.MarkerSeverity.Warning
                                    ? 'Warning'
                                    : 'Info';
                        const code = m.code ? ` (${m.code})` : '';
                        const md = `**${severity}**${code}\n\n${m.message}`;
                        return { value: md };
                    });

                    const first = hits[0];
                    const range = new monacoInstance.Range(
                        first.startLineNumber,
                        first.startColumn,
                        first.endLineNumber,
                        first.endColumn
                    );

                    return {
                        range,
                        contents
                    };
                },
            }
        );

        return () => {
            try {
                hoverProviderRef.current?.dispose?.();
            } catch (e) {
                // ignore
            }
            hoverProviderRef.current = null;
        };
    }, [monacoInstance, editorInstance, activeLanguage, analysisResult]);

    // Register a completion provider to surface AI completions in the Monaco suggest widget
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        try {
            completionProviderRef.current?.dispose?.();
        } catch (e) {
            // ignore
        }

        completionProviderRef.current = monacoInstance.languages.registerCompletionItemProvider(
            activeLanguage,
            {
                provideCompletionItems: (model, position) => {
                    const cached = aiCompletionCacheRef.current;
                    if (!cached || !cached.suggestion) return { suggestions: [] };

                    const range = new monacoInstance.Range(
                        position.lineNumber,
                        position.column,
                        position.lineNumber,
                        position.column
                    );

                    return {
                        suggestions: [
                            {
                                label: 'AI suggestion',
                                kind: monacoInstance.languages.CompletionItemKind.Snippet,
                                insertText: cached.suggestion,
                                insertTextRules:
                                    monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                                range,
                            },
                        ],
                    };
                },
            }
        );

        return () => {
            try {
                completionProviderRef.current?.dispose?.();
            } catch (e) {
                // ignore
            }
            completionProviderRef.current = null;
        };
    }, [monacoInstance, editorInstance, activeLanguage]);

    const requestAiCompletion = useCallback(() => {
        if (!activeFile || !editorInstance) return;
        if (aiCompletionState === 'loading') return;

        const context = trimCompletionContext(code || '');
        if (!context.trim()) {
            return;
        }

        const cursorPosition = editorInstance.getPosition();
        aiCompletionCursorRef.current = cursorPosition
            ? {
                lineNumber: cursorPosition.lineNumber,
                column: cursorPosition.column,
            }
            : null;

        aiCompletionAbortControllerRef.current?.abort?.();
        const controller = new AbortController();
        aiCompletionAbortControllerRef.current = controller;
        setAiCompletionState('loading');
        setAiCompletionSummary(null);

        fetch(API_COMPLETION_ROUTE, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'content-type': 'application/json',
            },
            body: JSON.stringify({
                code: context,
                language: activeLanguage,
            }),
        })
            .then(async (response) => {
                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    throw new Error(text || 'Completion request failed');
                }
                return response.json();
            })
            .then((data) => {
                if (controller.signal.aborted) return;

                const completionText = data?.completion || '';
                const sanitized = completionText
                    .split(AI_COMPLETION_STOP_SEQUENCE)[0]
                    .replace(/\r/g, '')
                    .trimEnd();

                aiCompletionCacheRef.current = {
                    context,
                    language: activeLanguage,
                    suggestion: sanitized,
                };

                // Save suggestion into suggestions map keyed by the cursor used for this request
                try {
                    const pos = aiCompletionCursorRef.current;
                    if (pos) {
                        const key = `${pos.lineNumber}:${pos.column}`;
                        setSuggestionEntry(key, sanitized);
                    }
                } catch (e) {
                    // ignore
                }

                if (sanitized) {
                    const startLine = aiCompletionCursorRef.current?.lineNumber ?? 1;
                    const startColumn = aiCompletionCursorRef.current?.column ?? 1;
                    const lines = sanitized.split(/\r?\n/);
                    const preview =
                        sanitized.length > 256 ? `${sanitized.slice(0, 256)}…` : sanitized;

                    setAiCompletionSummary({
                        preview,
                        startLine,
                        startColumn,
                        lineCount: lines.length,
                        status: 'preview',
                    });
                    setAiCompletionState('ready');
                } else {
                    setAiCompletionState('idle');
                    setAiCompletionSummary(null);
                }
            })
            .catch((error) => {
                if (controller.signal.aborted) return;
                console.error('AI completion request failed', error);
                setAiCompletionState('idle');
                setAiCompletionSummary(null);
            })
            .finally(() => {
                if (aiCompletionAbortControllerRef.current === controller) {
                    aiCompletionAbortControllerRef.current = null;
                }
            });
    }, [activeFile, activeLanguage, code, editorInstance, aiCompletionState]);

    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        const disposable = editorInstance.onKeyDown((event) => {
            if (event.keyCode !== monacoInstance.KeyCode.Tab) return;
            if (aiCompletionState !== 'ready') return;

            const cached = aiCompletionCacheRef.current;
            const currentContext = trimCompletionContext(code || '');
            if (
                !cached.suggestion ||
                cached.context !== currentContext ||
                cached.language !== activeLanguage
            ) {
                return;
            }

            event.preventDefault();
            applyAiCompletionText(cached.suggestion);
            aiCompletionCacheRef.current = {
                context: '',
                language: '',
                suggestion: '',
            };
            setAiCompletionState('applied');
        });

        return () => disposable.dispose();
    }, [
        editorInstance,
        monacoInstance,
        code,
        activeLanguage,
        aiCompletionState,
        applyAiCompletionText,
    ]);

    // Helper: dynamically load a script once (UMD builds from CDN)
    const loadScript = (url) => {
        if (_loadedScripts.current[url]) return _loadedScripts.current[url];
        const p = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = url;
            s.async = true;
            s.onload = () => resolve(true);
            s.onerror = (e) => reject(e);
            document.head.appendChild(s);
        });
        _loadedScripts.current[url] = p;
        return p;
    };

    // Map Monaco language to Prettier parser name
    const languageToPrettierParser = (lang) => {
        switch ((lang || '').toLowerCase()) {
            case 'javascript':
            case 'javascriptreact':
            case 'jsx':
                return 'babel';
            case 'typescript':
            case 'typescriptreact':
            case 'tsx':
                return 'typescript';
            case 'json':
                return 'json';
            case 'css':
            case 'scss':
            case 'less':
                return 'css';
            case 'html':
                return 'html';
            case 'markdown':
                return 'markdown';
            default:
                return null;
        }
    };

    // Load Prettier UMD and necessary parsers from unpkg. Returns global `prettier` and plugin references.
    const loadPrettierWithParsers = async (parser) => {
        prettier.format(code, {
            parser: "babel",
            plugins: [babel, estree]
        });

        // Prefer bundler (dynamic import) when available in the client bundle.
        try {
            // dynamic import paths used here assume `prettier` and parsers are installed as dependencies
            const prettierModule = await import('prettier/standalone');
            const plugins = [];

            if (parser === 'babel' || parser === 'typescript') {
                const mod = await import('prettier/parser-babel');
                console.log(mod, mod.default);
                plugins.push(mod.default);
            }

            if (parser === 'css') {
                const mod = await import('prettier/parser-postcss');
                plugins.push(mod.default);
            }

            if (parser === 'html') {
                const mod = await import('prettier/parser-html');
                plugins.push(mod.default);
            }

            if (parser === 'markdown') {
                const mod = await import('prettier/parser-markdown');
                plugins.push(mod.default);
            }

            if (parser === 'json') {
                const mod = await import('prettier/parser-babel');
                plugins.push(mod.default);
            }

            const prettier = prettierModule && (prettierModule.default || prettierModule);
            return { prettier, plugins: plugins.map(m => (m && (m.default || m))) };
        } catch (err) {
            // If bundler imports fail (not installed), fallback to CDN UMD
            try {
                await loadScript('https://unpkg.com/prettier@2.8.8/standalone.js');

                const pluginUrls = [];
                if (['babel', 'typescript'].includes(parser)) {
                    pluginUrls.push('https://unpkg.com/prettier@2.8.8/parser-babel.js');
                }
                if (parser === 'css') {
                    pluginUrls.push('https://unpkg.com/prettier@2.8.8/parser-postcss.js');
                }
                if (parser === 'html') {
                    pluginUrls.push('https://unpkg.com/prettier@2.8.8/parser-html.js');
                }
                if (parser === 'markdown') {
                    pluginUrls.push('https://unpkg.com/prettier@2.8.8/parser-markdown.js');
                }
                if (parser === 'json') {
                    pluginUrls.push('https://unpkg.com/prettier@2.8.8/parser-babel.js');
                }

                // Load parser plugins
                await Promise.all(pluginUrls.map(u => loadScript(u).catch(e => { console.warn('Failed to load parser script', u, e); return null; })));

                const p = window.prettier || null;
                const plugins = [];

                // Common UMD shapes: window.prettierPlugins as object (keys) or array
                const available = window.prettierPlugins;
                if (Array.isArray(available) && available.length) {
                    plugins.push(...available);
                } else if (available && typeof available === 'object') {
                    // prefer the exact parser key
                    if (available[parser]) {
                        plugins.push(available[parser]);
                    } else {
                        // collect any common plugin keys that were loaded
                        ['babel', 'postcss', 'html', 'markdown', 'typescript', 'json'].forEach((k) => {
                            if (available[k]) plugins.push(available[k]);
                        });
                    }
                } else {
                    // Some UMD builds attach plugins to named globals (fallback checks)
                    const fallbacks = {
                        babel: window.prettierPlugins && window.prettierPlugins.babel,
                        postcss: window.prettierPlugins && window.prettierPlugins.postcss,
                        html: window.prettierPlugins && window.prettierPlugins.html,
                        markdown: window.prettierPlugins && window.prettierPlugins.markdown,
                        typescript: window.prettierPlugins && window.prettierPlugins.typescript,
                    };
                    if (fallbacks[parser]) plugins.push(fallbacks[parser]);
                }

                if (!p) {
                    console.error('Prettier UMD loaded but `window.prettier` not found');
                    return { prettier: null, plugins: [] };
                }

                if (!plugins.length) {
                    // as a last resort, attempt to use any registered plugins array
                    if (window.prettierPlugins && Array.isArray(window.prettierPlugins)) {
                        return { prettier: p, plugins: window.prettierPlugins };
                    }
                    console.warn('No Prettier parsers were found after loading UMD plugins; formatting for this language may not be available', parser);
                    return { prettier: p, plugins: [] };
                }

                return { prettier: p, plugins };
            } catch (err2) {
                console.error('Failed to load Prettier (both dynamic import and CDN fallback)', err, err2);
                return { prettier: null, plugins: [] };
            }
        }
    };

    // Format via Prettier fallback
    const formatWithPrettier = async (text, monacoLang) => {
        const parser = languageToPrettierParser(monacoLang);
        if (!parser) return null;

        try {
            const formatted = await prettier.format(text, {
                parser: parser,
                plugins: [babel, estree]
            });

            return formatted;
        } catch (e) {
            console.error("prettier failed", e);
            return null;
        }
    };


    // Run format: try Monaco's builtin action, if no change then fallback to Prettier
    const runFormatDocument = async (editor) => {
        if (!editor || !monacoInstance) return;
        try {
            const model = editor.getModel();
            if (!model) return;
            const before = model.getValue();

            // Try Monaco action first, but don't wait forever — use a short timeout
            try {
                const action = editor.getAction && editor.getAction('editor.action.formatDocument');
                if (action && typeof action.run === 'function') {
                    try {
                        const runPromise = action.run();
                        const result = await Promise.race([
                            // Some Monaco actions return a promise, some don't — handle both
                            runPromise instanceof Promise ? runPromise : Promise.resolve(runPromise),
                            new Promise((resolve) => setTimeout(() => resolve('__monaco_format_timeout__'), 1500)),
                        ]);
                        console.debug('[Editor] Monaco format action result', { result });
                    } catch (e) {
                        console.error('[Editor] Monaco format action threw', e);
                    }
                } else {
                    console.debug('[Editor] Monaco format action not available', { action });
                }
            } catch (e) {
                console.error('[Editor] Error invoking Monaco format action', e);
            }

            // small delay to allow provider edits to apply
            await new Promise((r) => setTimeout(r, 120));

            const after = model.getValue();
            if (after !== before) return; // Monaco formatting applied

            // Fallback: use Prettier
            const lang = activeLanguage || (activeFile ? getMonacoLanguage(activeFile.name) : 'plaintext');
            const formatted = await formatWithPrettier(before, lang);
            if (formatted && formatted !== before) {
                const fullRange = model.getFullModelRange();
                editor.executeEdits('format', [{ range: fullRange, text: formatted, forceMoveMarkers: true }]);
                editor.pushUndoStop();
            }
        } catch (e) {
            console.error('runFormatDocument failed', e);
        }
    };

    // Integrate completions coming from parent (latestCompletion) into the editor's suggestion/cache
    useEffect(() => {
        if (!latestCompletion || !editorInstance || !monacoInstance) return;

        // Debug: show that the Editor effect for latestCompletion is running
        try {
            console.debug('[Editor] latestCompletion effect start', { latestCompletionType: typeof latestCompletion, editorReady: !!editorInstance, monacoReady: !!monacoInstance, codeLength: (code || '').length });
        } catch (e) { }

        try {
            const raw = typeof latestCompletion === 'string' ? latestCompletion : (latestCompletion.completion || '');
            const sanitized = raw
                .split(AI_COMPLETION_STOP_SEQUENCE)[0]
                .replace(/\r/g, '')
                .trimEnd();

            if (!sanitized) return;

            const cursorPosition = editorInstance.getPosition();
            aiCompletionCursorRef.current = cursorPosition
                ? { lineNumber: cursorPosition.lineNumber, column: cursorPosition.column }
                : null;

            aiCompletionCacheRef.current = {
                context: trimCompletionContext(code || ''),
                language: activeLanguage,
                suggestion: sanitized,
            };

            // Save suggestion into suggestions map keyed by the cursor position
            try {
                const pos = aiCompletionCursorRef.current || editorInstance.getPosition();
                if (pos) {
                    const key = `${pos.lineNumber}:${pos.column}`;
                    setSuggestionEntry(key, sanitized);
                }
            } catch (e) {
                // ignore
            }

            const lines = sanitized.split(/\r?\n/);
            const preview = sanitized.length > 256 ? `${sanitized.slice(0, 256)}…` : sanitized;

            setAiCompletionSummary({
                preview,
                startLine: aiCompletionCursorRef.current?.lineNumber ?? 1,
                startColumn: aiCompletionCursorRef.current?.column ?? 1,
                lineCount: lines.length,
                status: 'preview',
            });
            setAiCompletionState('ready');

            // Do not trigger the Monaco suggest widget automatically — show ghost text only
        } catch (e) {
            console.error('Failed to apply latestCompletion to editor', e);
        }
    }, [latestCompletion, editorInstance, monacoInstance, code, activeLanguage]);

    // Dispose any editor event listeners when editorInstance changes/unmounts
    useEffect(() => {
        return () => {
            try {
                eventDisposablesRef.current.forEach(d => d?.dispose && d.dispose());
            } catch (e) {
                // ignore
            }
            eventDisposablesRef.current = [];
        };
    }, [editorInstance]);

    // Show inline ghost text (grey) using a decoration + injected CSS
    useEffect(() => {
        // Debug: log entry for ghost effect
        try {
            console.debug('[AI Ghost] effect enter', {
                ready: aiCompletionState === 'ready',
                suggestionLen: aiCompletionCacheRef.current?.suggestion?.length ?? 0,
                cursor: aiCompletionCursorRef.current,
                editorPos: editorInstance?.getPosition?.(),
            });
        } catch (e) {
            // ignore
        }
        // Clean up previous ghost
        const clearGhost = () => {
            try {
                if (ghostDecorationIdsRef.current?.length && editorInstance) {
                    editorInstance.deltaDecorations(ghostDecorationIdsRef.current, []);
                }
            } catch (e) {
                // ignore
            }
            ghostDecorationIdsRef.current = [];

            try {
                if (ghostStyleElementRef.current && ghostStyleElementRef.current.parentNode) {
                    ghostStyleElementRef.current.parentNode.removeChild(ghostStyleElementRef.current);
                }
            } catch (e) {
                // ignore
            }
            ghostStyleElementRef.current = null;
            ghostClassRef.current = null;
        };

        if (!editorInstance || !monacoInstance) {
            clearGhost();
            return;
        }

        // Show ghost if we have a ready suggestion. Attach at the saved cursor position if available,
        // otherwise use the current editor cursor. This makes rendering more robust if positions aren't exact.
        if (aiCompletionState !== 'ready' || !aiCompletionCacheRef.current?.suggestion) {
            try {
                console.debug('[AI Ghost] not ready or no suggestion', { aiCompletionState, suggestion: !!aiCompletionCacheRef.current?.suggestion });
            } catch (e) { }
            clearGhost();
            return;
        }

        const suggestion = aiCompletionCacheRef.current.suggestion;
        if (!suggestion) {
            clearGhost();
            return;
        }

        // Compute visible portion of suggestion that is not already present after the cursor
        let visible = suggestion;
        try {
            const model = editorInstance.getModel();
            const pos = aiCompletionCursorRef.current || editorInstance.getPosition();
            if (model && pos) {
                const offset = model.getOffsetAt(pos);
                const existing = model.getValue().slice(offset, offset + suggestion.length);
                let common = 0;
                while (common < suggestion.length && common < existing.length && suggestion.charAt(common) === existing.charAt(common)) {
                    common++;
                }
                visible = suggestion.slice(common);
            }
        } catch (e) {
            visible = suggestion;
        }

        if (!visible) {
            clearGhost();
            return;
        }

        try {
            console.debug('[AI Ghost] have suggestion, computing visible portion', { suggestionPreview: (suggestion || '').slice(0, 80) });
            // create unique class name
            const cls = `ai-ghost-${Date.now()}`;
            ghostClassRef.current = cls;

            // create a CSS rule to style the inline ghost content
            const style = document.createElement('style');
            style.type = 'text/css';
            style.innerHTML = `.${cls} { color: #9ca3af !important; opacity: 0.85; pointer-events: none; }`;
            document.head.appendChild(style);
            ghostStyleElementRef.current = style;

            const pos = aiCompletionCursorRef.current || editorInstance.getPosition();
            if (!pos) return;

            // Monaco decoration 'after' with contentText renders inline phantom text that occupies layout space
            const range = new monacoInstance.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
            const decoration = {
                range,
                options: {
                    after: {
                        contentText: visible.replace(/\r?\n/g, ' '),
                        inlineClassName: cls,
                    },
                    stickiness: monacoInstance.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                },
            };

            const ids = editorInstance.deltaDecorations([], [decoration]);
            ghostDecorationIdsRef.current = ids;
            try { console.debug('[AI Ghost] decoration applied', { ids, visibleLen: visible.length }); } catch (e) { }
        } catch (e) {
            console.error('Failed to render ghost suggestion', e);
            // Ensure cleanup on error
            try {
                if (ghostStyleElementRef.current && ghostStyleElementRef.current.parentNode) {
                    ghostStyleElementRef.current.parentNode.removeChild(ghostStyleElementRef.current);
                }
            } catch (err) {
                // ignore
            }
            ghostStyleElementRef.current = null;
            ghostDecorationIdsRef.current = [];
            ghostClassRef.current = null;
        }

        // Cleanup when suggestion changes or on unmount
        return () => {
            clearGhost();
        };
    }, [aiCompletionState, editorInstance, monacoInstance, code]);

    // Handler to update content in Redux
    const handleCodeChange = (newCode) => {
        // Clear any cached suggestions when the code changes
        try {
            clearSuggestions();
        } catch (e) {
            // ignore
        }
        // Clear local AI completion cache and UI
        aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
        setAiCompletionState('idle');
        setAiCompletionSummary(null);
        try {
            if (ghostDecorationIdsRef.current?.length && editorInstance) {
                editorInstance.deltaDecorations(ghostDecorationIdsRef.current, []);
            }
        } catch (e) {
            // ignore
        }
        ghostDecorationIdsRef.current = [];

        dispatch(updateContent(newCode));
    };

    // Handler to save content via Thunk
    const handleSave = () => {
        if (activeFile && isUnsaved) {
            dispatch(saveFileContentThunk());
        }
    };

    // Auto-save functionality with debouncing
    useEffect(() => {
        if (!autoSaveEnabled || !isUnsaved || !activeFile) return;

        const autoSaveTimer = setTimeout(() => {
            dispatch(saveFileContentThunk());
        }, 500);

        return () => clearTimeout(autoSaveTimer);
    }, [code, autoSaveEnabled, isUnsaved, activeFile, dispatch]);

    // Sync editor value only when switching active files to avoid flashing while typing
    useEffect(() => {
        if (!editorInstance) return;
        try {
            if (prevActiveFileRef.current !== activeFileIdentity) {
                // switching files - set the editor value to the current code
                editorInstance.setValue(code || '');
                prevActiveFileRef.current = activeFileIdentity;
            }
        } catch (e) {
            // ignore
        }
    }, [editorInstance, activeFileIdentity, code]);

    // Add keyboard shortcuts: Ctrl/Cmd+S to save, Alt+F to format document
    useEffect(() => {
        const handleKeyDown = async (e) => {
            try { console.log('[Editor] document keydown', { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, target: e.target?.tagName }); } catch (err) { }
            // Save (Ctrl/Cmd+S)
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                e.stopPropagation();
                handleSave();
                return;
            }

            // Format document (Alt+F)
            if (e.altKey && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                e.stopPropagation();
                try {
                    console.log('[Editor] Alt+F detected - attempting format', { editorPresent: !!editorInstance, monacoPresent: !!monacoInstance });
                    // Try the orchestrated formatter first
                    await runFormatDocument(editorInstance);
                } catch (err) {
                    console.error('[Editor] runFormatDocument threw', err);
                }

                // As a fallback, invoke Monaco's format action directly
                try {
                    if (editorInstance?.getAction) {
                        console.log('[Editor] invoking Monaco editor.action.formatDocument directly as fallback');
                        try {
                            const act = editorInstance.getAction('editor.action.formatDocument');
                            if (act && typeof act.run === 'function') {
                                const rp = act.run();
                                const res = await Promise.race([
                                    rp instanceof Promise ? rp : Promise.resolve(rp),
                                    new Promise((resolve) => setTimeout(() => resolve('__monaco_format_timeout__'), 1500)),
                                ]);
                                console.debug('[Editor] direct Monaco format action result', { res });
                            } else {
                                console.debug('[Editor] direct Monaco action not present', { act });
                            }
                        } catch (e) {
                            console.error('[Editor] direct Monaco format action failed', e);
                        }
                    }
                } catch (err) {
                    console.error('[Editor] direct Monaco format action failed', err);
                }

                return;
            }
        };

        // Use capturing listeners on both document and window to catch keys
        // even if Monaco or other handlers intercept them.
        // Register capturing listeners (passive:false so we can preventDefault)
        try { document.addEventListener('keydown', handleKeyDown, { capture: true, passive: false }); console.log('[Editor] attached document capturing keydown'); } catch (e) { console.error('failed to attach document keydown', e); }
        try { window.addEventListener('keydown', handleKeyDown, { capture: true, passive: false }); console.log('[Editor] attached window capturing keydown'); } catch (e) { console.error('failed to attach window keydown', e); }
        return () => {
            try { document.removeEventListener('keydown', handleKeyDown, { capture: true }); } catch (e) { }
            try { window.removeEventListener('keydown', handleKeyDown, { capture: true }); } catch (e) { }
        };
    }, [editorInstance, monacoInstance, handleSave]);

    // Expose editor + monaco to window for interactive debugging and manual invocation
    useEffect(() => {
        try {
            if (editorInstance) window.__synthiEditor = editorInstance;
            if (monacoInstance) window.__synthiMonaco = monacoInstance;
            // also expose a helper to run the formatter manually from console
            window.__synthiRunFormat = async () => {
                try {
                    console.debug('[Editor] manual runFormatDocument invoked from window helper');
                    await runFormatDocument(window.__synthiEditor);
                    return { ok: true };
                } catch (e) {
                    console.error('[Editor] window.__synthiRunFormat error', e);
                    return { ok: false, error: e };
                }
            };
        } catch (e) { }

        return () => {
            try {
                if (window.__synthiEditor === editorInstance) delete window.__synthiEditor;
                if (window.__synthiMonaco === monacoInstance) delete window.__synthiMonaco;
                if (window.__synthiRunFormat) delete window.__synthiRunFormat;
            } catch (e) { }
        };
    }, [editorInstance, monacoInstance]);

    const aiStatusLabel =
        aiCompletionState === 'loading'
            ? 'AI loading…'
            : aiCompletionState === 'ready'
                ? 'AI ready (press Tab)'
                : aiCompletionState === 'applied'
                    ? 'AI change applied'
                    : 'AI idle';
    const aiStatusDotClass =
        aiCompletionState === 'loading'
            ? 'bg-amber-400 animate-pulse'
            : aiCompletionState === 'ready'
                ? 'bg-blue-400'
                : aiCompletionState === 'applied'
                    ? 'bg-emerald-400'
                    : 'bg-gray-500';

    return (
        <ResizablePanel defaultSize={76} minSize={20}>
            <ResizablePanelGroup direction="vertical" className="h-full">
                <ResizablePanel defaultSize={70} minSize={20}>
                    <div className="h-full flex flex-col bg-[#1e1e1e]">
                        {/* Tab/Breadcrumb area */}
                        <div className="px-3 py-2 text-sm border-b border-[#545454] bg-[#252526] flex justify-between items-center gap-1 overflow-x-auto whitespace-nowrap">
                            <div className='flex flex-row items-center gap-2'>
                                {breadcrumb && breadcrumb.length > 0 ? (
                                    breadcrumb.map((name, idx) => {
                                        const isLast = idx === breadcrumb.length - 1;
                                        const isFile = isLast && activeFile && name === activeFile.name;
                                        return (
                                            <span key={`${name}-${idx}`} className="flex items-center">
                                                {isFile ? (
                                                    <FileText className="w-3.5 h-3.5 mr-1 text-gray-400" />
                                                ) : (
                                                    <Folder className="w-3.5 h-3.5 mr-1 text-gray-400" />
                                                )}
                                                <span className={`text-xs ${isLast ? 'text-gray-100' : 'text-gray-400'}`}>
                                                    {name}
                                                </span>
                                                {idx < breadcrumb.length - 1 && <span className="px-1 text-gray-500">›</span>}
                                            </span>
                                        );
                                    })
                                ) : (
                                    <span className="text-xs text-gray-400">No file selected</span>
                                )}
                                {/* Unsaved indicator */}
                                {isUnsaved && (
                                    <Circle className="w-3 h-3 text-orange-400 fill-orange-400" />
                                )}
                                {/* Save button */}
                                {activeFile && (
                                    <button
                                        onClick={handleSave}
                                        className="p-1 hover:bg-[#2f2f2f] rounded transition-colors"
                                        title="Save file (Ctrl+S)"
                                    >
                                        <Save className="w-3.5 h-3.5 text-gray-400 hover:text-gray-200" />
                                    </button>
                                )}
                            </div>
                            <div className='flex flex-row gap-3 items-center'>
                                <p className='text-xs text-gray-400'>Ln: {position.lineNumber}</p>
                                <p className='text-xs text-gray-400'>Col: {position.column}</p>
                                <div className='flex items-center gap-1'>
                                    <span className={`w-2 h-2 rounded-full ${aiStatusDotClass}`}></span>
                                    <span className='text-xs text-gray-400'>{aiStatusLabel}</span>
                                </div>
                                <button
                                    type='button'
                                    onClick={requestAiCompletion}
                                    disabled={aiCompletionState === 'loading'}
                                    className='text-[11px] px-2 py-0.5 rounded border border-[#3a3a3a] text-gray-300 hover:border-gray-500 transition-colors disabled:opacity-50 disabled:cursor-default'
                                >
                                    {aiCompletionState === 'ready' ? 'Press Tab to insert' : 'Ask AI'}
                                </button>
                            </div>
                            {aiCompletionSummary && (
                                <div className="px-3 py-1 text-[11px] text-gray-300 border-t border-[#3a3a3a]">
                                    <div className="flex flex-wrap gap-2 items-center text-xs">
                                        <span className="text-gray-400">
                                            AI{' '}
                                            {aiCompletionSummary.status === 'preview'
                                                ? 'suggested'
                                                : 'inserted'}{' '}
                                            {aiCompletionSummary.lineCount} line
                                            {aiCompletionSummary.lineCount === 1 ? '' : 's'} at Ln{' '}
                                            {aiCompletionSummary.startLine}, Col{' '}
                                            {aiCompletionSummary.startColumn}
                                        </span>
                                        {aiCompletionSummary.status === 'preview' && (
                                            <span className="text-[10px] text-gray-500">
                                                Press Tab to insert
                                            </span>
                                        )}
                                    </div>
                                    <p className="truncate max-w-[360px] text-emerald-300">
                                        {aiCompletionSummary.preview}
                                    </p>
                                </div>
                            )}
                        </div>
                        {/* Editor area */}
                        <div className="flex-1 overflow-hidden">
                            <ContextMenu>
                                <ContextMenuTrigger asChild>
                                    <div className="h-full">
                                        <Editor
                                            key={activeFile ? activeFile.path : 'no-file'} // Use path for a better key
                                            height="100%"
                                            defaultValue={code}
                                            language={activeFile ? getMonacoLanguage(activeFile.name) : 'plaintext'}
                                            onChange={handleCodeChange}
                                            theme="vs-dark"
                                            options={{
                                                minimap: { enabled: true },
                                                fontSize: 14,
                                                wordWrap: 'off',
                                                scrollBeyondLastLine: true,
                                                automaticLayout: true,
                                                lineNumbers: true,
                                                scrollbar: {
                                                    verticalHasArrows: true,
                                                    horizontalHasArrows: true,
                                                },
                                                hover: {
                                                    enabled: true,
                                                    delay: 300,
                                                    above: false
                                                }
                                            }}
                                            onMount={(editor, monaco) => {
                                                setEditorInstance(editor);
                                                setMonacoInstance(monaco);
                                                try { console.debug('[Editor] onMount - editor and monaco set', { editorReady: !!editor, monacoReady: !!monaco }); } catch (e) { }
                                                if (onEditorMount) {
                                                    onEditorMount(editor);
                                                }
                                                editor.onDidChangeCursorPosition(e => {
                                                    const pos = e.position;
                                                    setPosition({ lineNumber: pos.lineNumber, column: pos.column });

                                                    // Clear any existing ghost decorations/styles for previous cursor
                                                    try {
                                                        if (ghostDecorationIdsRef.current?.length && editorInstance) {
                                                            editorInstance.deltaDecorations(ghostDecorationIdsRef.current, []);
                                                        }
                                                    } catch (err) {
                                                        // ignore
                                                    }
                                                    ghostDecorationIdsRef.current = [];
                                                    try {
                                                        if (ghostStyleElementRef.current && ghostStyleElementRef.current.parentNode) {
                                                            ghostStyleElementRef.current.parentNode.removeChild(ghostStyleElementRef.current);
                                                        }
                                                    } catch (err) {
                                                        // ignore
                                                    }
                                                    ghostStyleElementRef.current = null;
                                                    ghostClassRef.current = null;

                                                    // On cursor move: if we have a saved suggestion for this cursor, display it; otherwise fetch a new one
                                                    const key = `${pos.lineNumber}:${pos.column}`;
                                                    const saved = suggestionsMapRef.current?.[key];
                                                    if (saved) {
                                                        // populate cache and show ghost for this cursor
                                                        aiCompletionCursorRef.current = { lineNumber: pos.lineNumber, column: pos.column };
                                                        aiCompletionCacheRef.current = {
                                                            context: trimCompletionContext(code || ''),
                                                            language: activeLanguage,
                                                            suggestion: saved,
                                                        };
                                                        const lines = saved.split(/\r?\n/);
                                                        const preview = saved.length > 256 ? `${saved.slice(0, 256)}…` : saved;
                                                        setAiCompletionSummary({
                                                            preview,
                                                            startLine: pos.lineNumber,
                                                            startColumn: pos.column,
                                                            lineCount: lines.length,
                                                            status: 'preview',
                                                        });
                                                        setAiCompletionState('ready');
                                                    } else {
                                                        // Clear local cache and UI then fetch suggestion for new cursor
                                                        aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
                                                        setAiCompletionState('idle');
                                                        setAiCompletionSummary(null);
                                                        requestAiCompletion();
                                                    }
                                                });
                                                // Register editor action so keybinding works while editor is focused
                                                try {
                                                    const actionDisposable = editor.addAction({
                                                        id: 'synthi.formatDocument',
                                                        label: 'Format Document',
                                                        keybindings: [
                                                            monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
                                                        ],
                                                        run: (ed) => {
                                                            try {
                                                                console.debug('Running format action from editor keybinding');
                                                                runFormatDocument(ed);
                                                            } catch (err) {
                                                                console.error('format action failed', err);
                                                            }
                                                            return null;
                                                        },
                                                    });
                                                    eventDisposablesRef.current.push(actionDisposable);
                                                    try {
                                                        const commandDisposable = editor.addCommand(
                                                            monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
                                                            () => {
                                                                try {
                                                                    console.debug('Running format command from editor.addCommand');
                                                                    runFormatDocument(editor);
                                                                } catch (err) {
                                                                    console.error('format command failed', err);
                                                                }
                                                            }
                                                        );
                                                        eventDisposablesRef.current.push(commandDisposable);
                                                    } catch (e) {
                                                        // ignore if addCommand not supported
                                                    }
                                                } catch (e) {
                                                    // ignore if Monaco API not available
                                                }
                                                // remember the active file identity so we can sync value when file changes
                                                try {
                                                    prevActiveFileRef.current = activeFileIdentity;
                                                } catch (e) { }
                                                // Clear suggestions on any content change (typing or programmatic edits)
                                                const contentDisposable = editor.onDidChangeModelContent(() => {
                                                    try {
                                                        clearSuggestions();
                                                    } catch (err) {
                                                        // ignore
                                                    }
                                                    aiCompletionCacheRef.current = { context: '', language: '', suggestion: '' };
                                                    setAiCompletionState('idle');
                                                    setAiCompletionSummary(null);
                                                    try {
                                                        if (ghostDecorationIdsRef.current?.length) {
                                                            editor.deltaDecorations(ghostDecorationIdsRef.current, []);
                                                        }
                                                    } catch (e) {
                                                        // ignore
                                                    }
                                                    ghostDecorationIdsRef.current = [];
                                                    try {
                                                        if (ghostStyleElementRef.current && ghostStyleElementRef.current.parentNode) {
                                                            ghostStyleElementRef.current.parentNode.removeChild(ghostStyleElementRef.current);
                                                        }
                                                    } catch (e) {
                                                        // ignore
                                                    }
                                                    ghostStyleElementRef.current = null;
                                                    ghostClassRef.current = null;
                                                });
                                                eventDisposablesRef.current.push(contentDisposable);
                                                window.MonacoEnvironment = {
                                                    getWorker: function (moduleId, label) {
                                                        if (label === 'json') {
                                                            return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker', import.meta.url));
                                                        }
                                                        if (label === 'css' || label === 'scss' || label === 'less') {
                                                            return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker', import.meta.url));
                                                        }
                                                        if (label === 'html' || label === 'handlebars' || label === 'razor') {
                                                            return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker', import.meta.url));
                                                        }
                                                        if (label === 'typescript' || label === 'javascript') {
                                                            return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker', import.meta.url));
                                                        }
                                                        return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker', import.meta.url));
                                                    }
                                                };
                                            }}
                                        />
                                    </div>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-48">
                                    <ContextMenuItem onClick={() => onRun()}>Run File</ContextMenuItem>
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('editor.action.formatDocument')?.run()}>Format Document</ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('actions.find')?.run()}>Find…</ContextMenuItem>
                                </ContextMenuContent>
                            </ContextMenu>
                        </div>
                    </div>
                </ResizablePanel>
                {/* Terminal Panel */}
                {showTerminal && (
                    <>
                        <ResizableHandle
                            withHandle
                            className="!pointer-events-auto bg-[#545454] hover:bg-emerald-500 w-0.5 z-50"
                            onMouseDown={(e) => e.stopPropagation()}
                        />
                        <ResizablePanel defaultSize={30} minSize={15} >
                            <TerminalManagerDyn visible={true} onCloseAll={onToggleTerminal} />
                        </ResizablePanel>
                    </>
                )}
            </ResizablePanelGroup>
        </ResizablePanel>
    );
};
export default EditorPanel;
