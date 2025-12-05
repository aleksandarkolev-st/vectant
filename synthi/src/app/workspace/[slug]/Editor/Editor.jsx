// src/app/Editor.jsx
'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { getMonacoLanguage } from '@/utils/languageMapper';
import dynamic from 'next/dynamic';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import {
    selectActiveFile,
    selectCurrentContent,
    selectIsUnsaved,
    selectBreadcrumb,
    selectFileCacheEntries,
    saveFileContentThunk,
    updateContent,
    selectOpenFiles,
    selectFileThunk,
    closeFile,
    reorderOpenFiles
} from '@/redux/workspaceSlice';
import { selectAutoSaveEnabled, selectAutoCompletionEnabled, toggleAutoCompletion } from '@/redux/uiSlice';
import { Circle, Save, Sparkles } from 'lucide-react'; // Added Sparkles
import { getFileIcon } from '@/utils/fileIcons';
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
} from '@/lib/completion';
import prettier from "prettier/standalone";
import babel from "prettier/plugins/babel";
import estree from "prettier/plugins/estree";
import { EDITOR_OPTIONS } from './options';
import { useAiCompletion } from './AICompletion';
import { useDiffManager } from './diffManager';
import { useEditorProviders } from './providers';
import { useEditorEvents } from './events';
import { takeLastChars } from './utils';
import { SYNTHI_THEME } from './theme';
import * as monaco from 'monaco-editor';

const CloseAction = {
    DoNotRestart: 1,
    Restart: 2,
};

const ErrorAction = {
    Continue: 1,
    Shutdown: 2,
};
import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc';
import { MonacoSocketAdapter } from '@/services/MonacoSocketAdapter';
import { useCompiler } from '@/hooks/useCompiler';
import { CompilerStatus } from '@/services/compilerClient';

// Configure Monaco workers
if (typeof window !== 'undefined') {
    // Use bundled monaco-editor instead of CDN to ensure compatibility with monaco-languageclient
    loader.config({ monaco });

    window.MonacoEnvironment = {
        getWorker: function (workerId, label) {
            if (label === 'json') {
                return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url));
            }
            if (label === 'css' || label === 'scss' || label === 'less') {
                return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url));
            }
            if (label === 'html' || label === 'handlebars' || label === 'razor') {
                return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url));
            }
            if (label === 'typescript' || label === 'javascript') {
                return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url));
            }
            return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url));
        }
    };
}

const TerminalManagerDyn = dynamic(() => import('../../TerminalManager.jsx'), {
    ssr: false
});

let servicesInitialized = false;

// Design tokens for tab styling (tunable) — tuned to a VSCode-like palette
const TAB_TOKENS = {
    activeBg: '#0f1724',
    inactiveBg: '#0b0c10',
    hoverBg: '#0f1114',
    primary: '#007acc',
    separator: 'rgba(255,255,255,0.06)',
    unsaved: '#ff8b3d',
    inactiveText: '#c7c9cc'
};

const EditorPanel = ({
    onRun,
    onToggleTerminal,
    onEditorMount,
    analysisResult,
    latestCompletion,
    aiBusy = false,
    onClearCompletion = null,
}) => {
    const dispatch = useAppDispatch();

    //Global state access djsaiodjasiodjasiodjasiodjaoidjasoidjsaiodjasiodjasjdnsaj
    const activeFile = useAppSelector(selectActiveFile);
    const code = useAppSelector(selectCurrentContent);
    const isUnsaved = useAppSelector(selectIsUnsaved);
    const breadcrumb = useAppSelector(selectBreadcrumb);
    const fileCacheEntries = useAppSelector(selectFileCacheEntries);
    const openFiles = useAppSelector(selectOpenFiles);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    const showTerminal = useAppSelector(state => state.ui.showTerminal);
    const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
    const aiAutoEnabled = useAppSelector(selectAutoCompletionEnabled);

    // Local state
    const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
    const [editorInstance, setEditorInstance] = useState(null);
    const [monacoInstance, setMonacoInstance] = useState(null);
    const latestCodeRef = useRef(code);
    const pendingContentFrameRef = useRef(null);
    const pendingPositionFrameRef = useRef(null);
    const [tabContext, setTabContext] = useState({ visible: false, x: 0, y: 0, file: null, index: -1 });
    const [lspStatus, setLspStatus] = useState('Idle');
    const [servicesReady, setServicesReady] = useState(false);

    const { client: compilerClient, status: compilerStatus } = useCompiler();
    const languageClientsRef = useRef(new Map());

    // Initialize Monaco Services ONCE
    useEffect(() => {
        if (servicesInitialized) {
            setServicesReady(true);
            return;
        }

        import('monaco-languageclient/vscodeApiWrapper').then(async ({ MonacoVscodeApiWrapper }) => {
            if (!servicesInitialized) {
                const wrapper = new MonacoVscodeApiWrapper({
                    $type: 'classic',
                    viewsConfig: {
                        $type: 'EditorService'
                    }
                });
                try {
                    await wrapper.start();
                    servicesInitialized = true;
                    setServicesReady(true);
                    console.log('[LSP] Monaco Services Initialized');
                } catch (e) {
                    console.error('Failed to initialize monaco-vscode-api', e);
                }
            } else {
                setServicesReady(true);
            }
        });
    }, []);

    useEffect(() => {
        if (!monacoInstance || !compilerClient || compilerStatus !== CompilerStatus.CONNECTED || !activeFile || !servicesReady || !editorInstance) {
            if (compilerStatus !== CompilerStatus.CONNECTED) {
                setLspStatus('Compiler Disconnected');
                // Cleanup existing clients if disconnected
                languageClientsRef.current.forEach(client => {
                    try { client.stop(); } catch (e) { }
                });
                languageClientsRef.current.clear();
            }
            return;
        }

        const lang = getMonacoLanguage(activeFile.name);
        let backendLang = null;
        let documentSelector = [];

        if (['cpp', 'c'].includes(lang)) {
            backendLang = 'cpp';
            documentSelector = ['cpp', 'c'];
        } else if (lang === 'rust') {
            backendLang = 'rust';
            documentSelector = ['rust'];
        } else if (lang === 'python') {
            backendLang = 'python';
            documentSelector = ['python'];
        } else if (['typescript', 'javascript'].includes(lang)) {
            backendLang = 'typescript';
            documentSelector = ['typescript', 'javascript'];
        }

        if (!backendLang) {
            setLspStatus('No LSP for this file');
            return;
        }

        if (languageClientsRef.current.has(backendLang)) {
            setLspStatus(`Ready (${backendLang})`);
            // Ensure we send didOpen for the new file even if client exists
            const client = languageClientsRef.current.get(backendLang);
            const model = editorInstance.getModel();
            if (client && client.isRunning() && model) {
                const textDocument = {
                    uri: model.uri.toString(),
                    languageId: model.getLanguageId(),
                    version: model.getVersionId(),
                    text: model.getValue()
                };
                console.log('[LSP] Manually sending didOpen (reuse) for', textDocument.uri);
                client.sendNotification('textDocument/didOpen', { textDocument });
            }
            return;
        }

        console.log(`[LSP] Initializing for ${backendLang}...`);
        setLspStatus(`Initializing ${backendLang}...`);

        let lspChannel;
        try {
            lspChannel = compilerClient.createLspChannel(backendLang);
            console.log(`[LSP] Created channel for ${backendLang}, readyState: ${lspChannel.readyState}`);
            lspChannel.onopen = () => console.log(`[LSP] Channel opened for ${backendLang}`);
        } catch (e) {
            console.error("[LSP] Failed to create channel", e);
            setLspStatus('Channel Error');
            return;
        }

        const socket = toSocket(new MonacoSocketAdapter(lspChannel));
        const reader = new WebSocketMessageReader(socket);
        const writer = new WebSocketMessageWriter(socket);

        Promise.all([
            import('monaco-languageclient'),
            import('monaco-languageclient/vscodeApiWrapper')
        ]).then(async ([{ MonacoLanguageClient }, { MonacoVscodeApiWrapper }]) => {
            if (languageClientsRef.current.has(backendLang)) return;

            // Services should be initialized by the other useEffect, but double check
            if (!servicesInitialized) {
                console.warn('[LSP] Services not initialized yet, waiting...');
                return;
            }

            class SynthiLanguageClient extends MonacoLanguageClient {
                fillInitializeParams(params) {
                    super.fillInitializeParams(params);
                    params.rootUri = "file:///synthi/";
                    params.workspaceFolders = [{
                        uri: "file:///synthi/",
                        name: "synthi"
                    }];
                }
            }

            const languageClient = new SynthiLanguageClient({
                name: `Synthi Language Client (${backendLang})`,
                clientOptions: {
                    documentSelector: documentSelector,
                    middleware: {
                        didOpen: (data, next) => {
                            console.log('[LSP] Suppressing default didOpen (using manual)');
                            // return next(data); 
                        },
                        didChange: (data, next) => {
                            console.log('[LSP] Suppressing default didChange (using manual)');
                            // return next(data);
                        },
                        provideCompletionItem: (document, position, context, token, next) => {
                            console.log('[LSP] provideCompletionItem triggered (middleware) - suppressing default');
                            // Suppress default LSP completion to avoid duplicate requests/race conditions
                            // since we are using the manual bridge.
                            return [];
                        },
                        resolveCompletionItem: (item, token, next) => {
                            console.log('[LSP] resolveCompletionItem triggered for:', item.label);
                            return next(item, token);
                        }
                    },
                    errorHandler: {
                        error: () => ({ action: ErrorAction.Continue }),
                        closed: () => {
                            console.warn('[LSP] Connection closed unexpectedly');
                            return { action: CloseAction.DoNotRestart };
                        }
                    },
                    workspaceFolder: {
                        uri: monacoInstance.Uri.parse('file:///synthi/'),
                        name: 'synthi',
                        index: 0
                    }
                },
                messageTransports: { reader, writer }
            });

            console.log(`[LSP] Starting client for ${backendLang}`);
            const model = editorInstance.getModel();
            console.log(`[LSP] Model Details - URI: ${model.uri.toString()}, Scheme: ${model.uri.scheme}, Language: ${model.getLanguageId()}`);

            // Debug: Register a manual completion provider to verify Monaco is working
            const debugDisposable = monacoInstance.languages.registerCompletionItemProvider(model.getLanguageId(), {
                provideCompletionItems: (model, position) => {
                    console.log('[LSP-DEBUG] Manual completion provider triggered');
                    return { suggestions: [] };
                }
            });

            // Manual LSP Bridge: Force completion requests to the server
            // This bypasses monaco-languageclient's document selector issues
            const bridgeDisposable = monacoInstance.languages.registerCompletionItemProvider(backendLang, {
                triggerCharacters: ['.', '>', ':', '/', '"', '<'],
                provideCompletionItems: async (model, position, context, token) => {
                    console.log('[LSP-BRIDGE] Requesting completion via bridge...');
                    // Wait for client to be ready
                    if (!languageClient.isRunning()) {
                        console.log('[LSP-BRIDGE] Client not running yet');
                        return { suggestions: [] };
                    }

                    try {
                        console.log('[LSP-BRIDGE] Sending request...');
                        const params = {
                            textDocument: { uri: model.uri.toString() },
                            position: { line: position.lineNumber - 1, character: position.column - 1 }
                        };
                        const result = await languageClient.sendRequest('textDocument/completion', params, token);
                        console.log('[LSP-BRIDGE] Request finished, items:', Array.isArray(result) ? result.length : result?.items?.length);

                        if (!result) return { suggestions: [] };

                        const items = Array.isArray(result) ? result : result.items;
                        const isIncomplete = !Array.isArray(result) && result.isIncomplete;

                        // Map LSP items to Monaco items
                        const suggestions = items.map(item => {
                            const kind = item.kind !== undefined ? item.kind - 1 : monacoInstance.languages.CompletionItemKind.Text;

                            let insertText = item.insertText || item.label;
                            let range = undefined;

                            if (item.textEdit) {
                                if (item.textEdit.range) {
                                    insertText = item.textEdit.newText;
                                    range = {
                                        startLineNumber: item.textEdit.range.start.line + 1,
                                        startColumn: item.textEdit.range.start.character + 1,
                                        endLineNumber: item.textEdit.range.end.line + 1,
                                        endColumn: item.textEdit.range.end.character + 1
                                    };
                                } else if (item.textEdit.insert && item.textEdit.replace) {
                                    insertText = item.textEdit.newText;
                                    range = {
                                        insert: {
                                            startLineNumber: item.textEdit.insert.start.line + 1,
                                            startColumn: item.textEdit.insert.start.character + 1,
                                            endLineNumber: item.textEdit.insert.end.line + 1,
                                            endColumn: item.textEdit.insert.end.character + 1
                                        },
                                        replace: {
                                            startLineNumber: item.textEdit.replace.start.line + 1,
                                            startColumn: item.textEdit.replace.start.character + 1,
                                            endLineNumber: item.textEdit.replace.end.line + 1,
                                            endColumn: item.textEdit.replace.end.character + 1
                                        }
                                    };
                                }
                            }
                            return {
                                label: item.label,
                                kind: kind,
                                insertText: insertText,
                                range: range,
                                detail: item.detail,
                                documentation: typeof item.documentation === 'object' ? item.documentation.value : item.documentation,
                                sortText: item.sortText,
                                filterText: item.filterText,
                                insertTextRules: item.insertTextFormat === 2 ? monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet : 0
                            };
                        });

                        return { suggestions, incomplete: isIncomplete };
                    } catch (e) {
                        console.error('[LSP-BRIDGE] Error:', e);
                        return { suggestions: [] };
                    }
                }
            });


            try {
                await languageClient.start();
                console.log(`[LSP] Client started for ${backendLang}`);
            } catch (e) {
                console.error(`[LSP] Client start failed for ${backendLang}`, e);
            }

            // Manually trigger didOpen to ensure the server knows about the file immediately
            if (model) {
                setTimeout(() => {
                    const textDocument = {
                        uri: model.uri.toString(),
                        languageId: model.getLanguageId(),
                        version: model.getVersionId(),
                        text: model.getValue()
                    };
                    console.log('[LSP] Manually sending didOpen for', textDocument.uri);
                    languageClient.sendNotification('textDocument/didOpen', { textDocument });
                }, 500);
            }

            // Manual Sync: Ensure server gets updates
            const changeDisposable = editorInstance.onDidChangeModelContent((e) => {
                if (!languageClient.isRunning()) return;

                const currentModel = editorInstance.getModel();
                if (!currentModel) return;

                // Only send if we suspect the client isn't doing it (or just force it for now)
                // We use full text sync to be safe
                languageClient.sendNotification('textDocument/didChange', {
                    textDocument: {
                        uri: currentModel.uri.toString(),
                        version: currentModel.getVersionId()
                    },
                    contentChanges: [{ text: currentModel.getValue() }]
                });
            });

            languageClientsRef.current.set(backendLang, languageClient);
            setLspStatus(`Ready (${backendLang})`);

            lspChannel.onclose = () => {
                console.log(`[LSP] Channel closed for ${backendLang}`);
                debugDisposable.dispose();
                bridgeDisposable.dispose();
                changeDisposable.dispose();
                languageClient.stop();
                languageClientsRef.current.delete(backendLang);
                setLspStatus('Disconnected');
            };
        });

    }, [monacoInstance, compilerClient, compilerStatus, activeFile, editorInstance]);

    useEffect(() => {
        return () => {
            languageClientsRef.current.forEach(client => client.stop());
            languageClientsRef.current.clear();
        };
    }, []);

    // Swallow Monaco's cancel-notifications so they don't spam the console when
    // inline suggestions are abandoned mid-flight.
    useEffect(() => {
        const handler = (event) => {
            const reason = event?.reason;
            const msg = typeof reason === 'string' ? reason : reason?.message;
            const isCancel = msg && (msg.toLowerCase().includes('canceled') || msg === 'Canceled');
            const hasCancelCode = reason?.name === 'Canceled' || reason?.code === 'Canceled' || reason?.code === 'ERR_CANCELED';
            if (isCancel || hasCancelCode) {
                event.preventDefault?.();
                event.stopImmediatePropagation?.();
            }
        };
        window.addEventListener('unhandledrejection', handler);

        // Also patch console.error to suppress "Canceled" logs from libraries
        const originalError = console.error;
        console.error = (...args) => {
            if (args.length > 0) {
                const first = args[0];
                if (first === 'Canceled' || (typeof first === 'string' && first.includes('Canceled'))) {
                    return;
                }
                if (first?.message === 'Canceled' || first?.name === 'Canceled') {
                    return;
                }
            }
            originalError.apply(console, args);
        };

        return () => {
            window.removeEventListener('unhandledrejection', handler);
            console.error = originalError;
        };
    }, []);
    const notifyCompletionCleared = useCallback(() => {
        if (typeof onClearCompletion === 'function') {
            try {
                onClearCompletion();
            } catch (e) {
                // ignore downstream errors
            }
        }
    }, [onClearCompletion]);
    const activeLanguage = activeFile ? getMonacoLanguage(activeFile.name) : 'plaintext';
    const activeFileIdentity = activeFile ? `${activeFile.path ?? ''}-${activeFile.name ?? ''}` : 'no-file';
    const activeFileIcon = activeFile ? getFileIcon(activeFile.name || activeFile.path || '') : null;

    const {
        aiCompletionState,
        setAiCompletionState,
        applyAiCompletionText,
        requestAiCompletion,
        cancelActiveCompletion,
        aiCompletionCacheRef,
        aiCompletionCursorRef,
        aiDebounceTimerRef,
        inlineAcceptCommandIdRef
    } = useAiCompletion({
        activeFile,
        activeLanguage,
        breadcrumb,
        code,
        editorInstance,
        monacoInstance,
        fileCacheEntries,
        hasActiveDiff: () => false
    });

    const {
        removeDiffChunkVisuals,
        handleRejectDiffChunk,
        handleAcceptDiffChunk,
        hasActiveDiff: hasActiveDiffFromDiffManager,
        clearAllChunks
    } = useDiffManager({
        latestCompletion,
        editorInstance,
        monacoInstance,
        activeLanguage,
        activeFile,
        notifyCompletionCleared,
        aiCompletionCacheRef,
        activeFileIdentity
    });
    const activeDiffCheck = hasActiveDiffFromDiffManager;

    // --- Monaco Providers ---
    useEditorProviders({
        editorInstance,
        monacoInstance,
        activeLanguage,
        aiCompletionState,
        aiCompletionCacheRef,
        aiCompletionCursorRef,
        inlineAcceptCommandIdRef,
        applyAiCompletionText,
        rawFiles,
        fileCacheEntries,
        activeFile,
        lspReady: lspStatus.startsWith('Ready')
    });

    // --- Event Handlers ---
    useEditorEvents({
        editorInstance,
        monacoInstance,
        cancelActiveCompletion,
        requestAiCompletion,
        hasActiveDiff: activeDiffCheck,
        aiAutoEnabled,
        rawFiles,
        fileCacheEntries,
        dispatch,
        activeFile
    });

    useEffect(() => {
        latestCodeRef.current = code;
    }, [code]);

    useEffect(() => {
        return () => {
            if (pendingContentFrameRef.current) {
                cancelAnimationFrame(pendingContentFrameRef.current);
                pendingContentFrameRef.current = null;
            }
            if (aiDebounceTimerRef.current) {
                clearTimeout(aiDebounceTimerRef.current);
                aiDebounceTimerRef.current = null;
            }
        };
    }, []);

    const handleCodeChange = useCallback((newCode) => {
        cancelActiveCompletion({ resetSuggestion: true, reason: 'edit' });
        latestCodeRef.current = newCode;
        if (!pendingContentFrameRef.current) {
            pendingContentFrameRef.current = requestAnimationFrame(() => {
                dispatch(updateContent(latestCodeRef.current));
                pendingContentFrameRef.current = null;
            });
        }

        // Debounce AI Auto-Complete (The "Cursor" experience)
        if (aiDebounceTimerRef.current) clearTimeout(aiDebounceTimerRef.current);
        if (!aiAutoEnabled) return;
        aiDebounceTimerRef.current = setTimeout(() => {
            if (!activeDiffCheck()) {
                requestAiCompletion(true, latestCodeRef.current, { reason: 'pause', pauseTrigger: true, recentEditSnippet: takeLastChars(latestCodeRef.current, 512) });
            }
        }, 900);
    }, [aiAutoEnabled, activeDiffCheck, cancelActiveCompletion, dispatch, requestAiCompletion]);

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
            if (e.key === 'Tab') {
                const cached = aiCompletionCacheRef.current;
                if (aiCompletionState === 'ready' && cached?.suggestion) {
                    e.preventDefault();
                    applyAiCompletionText(cached.suggestion);
                    return;
                }
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                handleSave();
            }
            // Format: Alt+F
            if (e.altKey && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                editorInstance?.getAction('editor.action.formatDocument')?.run();
            }
            // Toggle AI auto-completion: Ctrl/Cmd + K
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                dispatch(toggleAutoCompletion());
            }
            // (Removed Ctrl/Cmd+W to avoid closing the browser tab)
        };
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [handleSave, editorInstance, requestAiCompletion, cancelActiveCompletion, dispatch, activeFile, aiCompletionState, applyAiCompletionText]);

    // Ensure disabling auto AI clears any pending/computed suggestions
    useEffect(() => {
        if (aiAutoEnabled) return;
        cancelActiveCompletion({ resetSuggestion: true, reason: 'auto-disabled' });
        if (aiDebounceTimerRef.current) clearTimeout(aiDebounceTimerRef.current);
    }, [aiAutoEnabled, cancelActiveCompletion]);

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
            cancelActiveCompletion({ resetSuggestion: true, reason: 'external-completion' });
            // If parent passed a completion, inject it into cache and trigger
            const isPartial = typeof latestCompletion === 'object' && latestCompletion?.partial;
            if (isPartial) return;
            const text = typeof latestCompletion === 'string' ? latestCompletion : latestCompletion.completion;
            const sourceLang = typeof latestCompletion === 'object' ? latestCompletion?.language : null;
            const sourcePath = typeof latestCompletion === 'object' ? latestCompletion?.filePath : null;
            if (sourceLang && sourceLang !== activeLanguage) return;
            if (sourcePath && (sourcePath !== (activeFile?.path || activeFile?.name))) return;
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
                    if (p && typeof p.then === 'function') p.catch(() => { });
                } catch (e) { }
            }
        }
    }, [latestCompletion, editorInstance, code, activeLanguage]);



    // --- Render ---


    return (
        <ResizablePanel defaultSize={76} minSize={20}>
            <ResizablePanelGroup direction="vertical" className="h-full">
                <ResizablePanel defaultSize={70} minSize={20}>
                    <div className="h-full flex flex-col bg-[#1e1e1e]">
                        {/* Minimal Sleek Header */}
                        <div className="h-9 px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] flex justify-between items-center select-none">

                            {/* Breadcrumbs */}
                                <div className="flex items-center gap-2 overflow-hidden min-w-0">
                                    {/* Tabs bar (sleek) */}
                                    <div className="flex items-center gap-0 overflow-x-auto scrollbar-hide min-w-0">
                                        {openFiles && openFiles.length > 0 ? openFiles.map((file, idx) => {
                                                const isActive = activeFile && file.path === activeFile.path;
                                            const fileIcon = getFileIcon(file.name || file.path || '');
                                            return (
                                                <div key={`tab-wrap-${file.path}`} className="flex items-center">
                                                    {/* Separator between tabs (subtle) */}
                                                    {idx > 0 && (
                                                        <div
                                                            key={`sep-${file.path}`}
                                                            style={{ width: 1, height: 22, backgroundColor: TAB_TOKENS.separator, marginRight: 1}}
                                                            aria-hidden="true"
                                                        />
                                                    )}

                                                    <div
                                                        key={`sep2-${file.path}`}
                                                        style={{ width: 1, height: 22, backgroundColor: TAB_TOKENS.separator, marginRight: 6 }}
                                                        aria-hidden="true"
                                                    />

                                                <div
                                                    key={file.path}
                                                    draggable
                                                    onDragStart={(e) => {
                                                        e.dataTransfer?.setData('text/tab-index', String(idx));
                                                        e.dataTransfer?.setData('text/tab-path', file.path);
                                                    }}
                                                    onDragOver={(e) => { e.preventDefault(); }}
                                                    onDrop={(e) => {
                                                        e.preventDefault();
                                                        const raw = e.dataTransfer?.getData('text/tab-index');
                                                        if (!raw) return;
                                                        const fromIndex = Number(raw);
                                                        const toIndex = idx;
                                                        if (!Number.isNaN(fromIndex) && fromIndex !== toIndex) {
                                                            dispatch(reorderOpenFiles({ fromIndex, toIndex }));
                                                        }
                                                    }}
                                                    onClick={() => dispatch(selectFileThunk(file))}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault();
                                                        setTabContext({ visible: true, x: e.clientX, y: e.clientY, file, index: idx });
                                                    }}
                                                    className={`group flex items-center gap-2 px-3 py-1 mr-0 rounded-t-md cursor-pointer select-none transition-all duration-180 ease-out ${isActive ? 'text-white' : 'text-gray-200'}`}
                                                    title={file.path}
                                                    style={{
                                                        minWidth: 84,
                                                        maxWidth: 420,
                                                        backgroundColor: isActive ? TAB_TOKENS.activeBg : TAB_TOKENS.inactiveBg,
                                                        borderBottom: isActive ? `2px solid ${TAB_TOKENS.primary}` : '2px solid transparent',
                                                        boxShadow: isActive ? '0 6px 20px rgba(8,15,30,0.6)' : 'none',
                                                        transitionProperty: 'background-color, border-bottom-color, box-shadow',
                                                        transitionDuration: '180ms',
                                                        transitionTimingFunction: 'ease-out'
                                                    }}
                                                >
                                                    <span className="flex-shrink-0 text-sm opacity-90" aria-hidden="true">
                                                        {fileIcon}
                                                    </span>
                                                    <span className={`text-sm font-medium truncate max-w-[220px] ${isActive ? 'text-white' : 'text-gray-200'}`}>
                                                        {file.name}
                                                    </span>

                                                    {/* Unsaved marker (VSCode-style) - small dot near filename, visible when unsaved */}
                                                    <span aria-hidden="true" className={`ml-2 w-2 h-2 rounded-full flex-shrink-0 transition-opacity ${file.isUnsaved ? '' : 'opacity-0'}`} style={{ backgroundColor: TAB_TOKENS.unsaved }} />

                                                    {/* Close button appears on hover (VSCode behavior) */}
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); dispatch(closeFile(file.path)); }}
                                                        className={`ml-3 flex items-center justify-center w-6 h-6 rounded transition-opacity duration-150 ${isActive ? 'text-white/80' : 'text-gray-300'}`}
                                                        aria-label={`Close ${file.name}`}
                                                        style={{ opacity: 0 }}
                                                    >
                                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="pointer-events-none">
                                                            <path d="M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                            <path d="M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                        </svg>
                                                    </button>

                                                    <style jsx>{`
                                                            .group:hover button { opacity: 1 !important; }
                                                        `}</style>
                                                </div>
                                            </div>
                                        );
                                    }) : (
                                        <span className="text-gray-500 text-xs italic">No file open</span>
                                    )}
                                </div>
                                {/* Context menu for tabs */}
                                {tabContext.visible && (
                                    <div
                                        style={{ position: 'fixed', left: tabContext.x, top: tabContext.y, zIndex: 9999 }}
                                        onMouseLeave={() => setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 })}
                                    >
                                        <div className="bg-[#1c1c1c] border border-[#333] rounded shadow-lg text-sm text-gray-200">
                                            <div className="px-3 py-2 hover:bg-[#2b2b2b] cursor-pointer" onClick={() => { if (tabContext.file) dispatch(closeFile(tabContext.file.path)); setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 }); }}>Close</div>
                                            <div className="px-3 py-2 hover:bg-[#2b2b2b] cursor-pointer" onClick={() => {
                                                if (tabContext.file) {
                                                    const keep = tabContext.file.path;
                                                    const toClose = openFiles.filter(f => f.path !== keep).map(f => f.path);
                                                    toClose.forEach(p => dispatch(closeFile(p)));
                                                }
                                                setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 });
                                            }}>Close Others</div>
                                            <div className="px-3 py-2 hover:bg-[#2b2b2b] cursor-pointer" onClick={() => {
                                                if (tabContext.index >= 0) {
                                                    const toClose = openFiles.slice(tabContext.index + 1).map(f => f.path);
                                                    toClose.forEach(p => dispatch(closeFile(p)));
                                                }
                                                setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 });
                                            }}>Close to Right</div>
                                        </div>
                                    </div>
                                )}
                                {/* Removed global right-side unsaved dot; per-tab markers are used now */}
                            </div>

                            {/* Status & Controls */}
                            <div className="flex items-center gap-4">
                                {/* Line/Col Info */}
                                <div className="hidden md:flex gap-3 text-[11px] text-gray-500 font-mono">
                                    <span>Ln {position.lineNumber}, Col {position.column}</span>
                                </div>

                                {/* LSP Status */}
                                <div className="flex items-center gap-2 text-[11px] text-gray-500">
                                    <div className={`w-2 h-2 rounded-full ${lspStatus.startsWith('Ready') ? 'bg-green-500' : lspStatus.startsWith('Initializing') ? 'bg-yellow-500' : 'bg-gray-500'}`} />
                                    <span>{lspStatus}</span>
                                </div>

                                {/* AI Status Indicator (Subtle) */}
                                <div className="flex items-center gap-2 text-[11px]">
                                    <div className={`transition-opacity duration-300 ${(aiCompletionState === 'loading' || aiBusy) ? 'opacity-100' : 'opacity-0'}`}>
                                        <Sparkles className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
                                    </div>
                                    <span className={`uppercase tracking-wide ${aiAutoEnabled ? 'text-emerald-300' : 'text-gray-500'}`}>
                                        AI Auto {aiAutoEnabled ? 'On' : 'Off'}
                                    </span>
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
                                            path={activeFile ? `/synthi/${activeFile.path.startsWith('/') ? activeFile.path.slice(1) : activeFile.path}` : undefined}
                                            value={code ?? ''}
                                            language={activeLanguage}
                                            theme="synthi-theme"
                                            options={{
                                                ...EDITOR_OPTIONS,
                                                semanticHighlighting: { enabled: true }
                                            }}
                                            beforeMount={(monaco) => {
                                                monaco.editor.defineTheme('synthi-theme', SYNTHI_THEME);
                                            }}
                                            onChange={handleCodeChange}
                                            onMount={(editor, monaco) => {
                                                setEditorInstance(editor);
                                                setMonacoInstance(monaco);
                                                if (onEditorMount) onEditorMount(editor);
                                                editor.onDidChangeCursorPosition(e => {
                                                    const nextPos = e.position;
                                                    if (pendingPositionFrameRef.current) return;
                                                    pendingPositionFrameRef.current = requestAnimationFrame(() => {
                                                        setPosition(nextPos);
                                                        pendingPositionFrameRef.current = null;
                                                    });
                                                });

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
