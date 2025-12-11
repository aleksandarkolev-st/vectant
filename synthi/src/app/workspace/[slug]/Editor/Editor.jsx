// src/app/Editor.jsx
'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import Editor, { DiffEditor, loader } from '@monaco-editor/react';
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
import { selectAutoSaveEnabled, selectAutoCompletionEnabled, toggleAutoCompletion, selectShowAnonymousPresence, selectPresenceGranularity, toggleShowAnonymousPresence, setPresenceGranularity } from '@/redux/uiSlice';
import { Circle, Save, Sparkles, EyeOff } from 'lucide-react'; // Added Sparkles, EyeOff
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
import collabClient from '@/services/collabClient';
import { useSession } from 'next-auth/react';
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
    onSave,
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
    const showAnonymousPresence = useAppSelector(selectShowAnonymousPresence);
    const presenceGranularity = useAppSelector(selectPresenceGranularity);

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
    const slug = useAppSelector(state => state.workspace.slug);
    const session = useSession();
    const collabBindingRef = useRef(null);
    const [collabConnected, setCollabConnected] = useState(false); // Track if collab is actively bound
    const [hoverPresence, setHoverPresence] = useState(null); // { user, clientId, rect }
    // small timeout ref used to keep the hover card alive while moving the pointer
    const hoverHideTimeoutRef = useRef(null);
    const [isPrivateMode, setIsPrivateMode] = useState(false);
    const [remoteUnsaved, setRemoteUnsaved] = useState(false);

    // Precompute hover-card style so JSX stays clean and well-formed
    const hoverCardStyle = (hoverPresence && hoverPresence.rect && typeof window !== 'undefined') ? (() => {
        const cardW = 224; const cardH = 76;
        // tighten the horizontal gap a bit to avoid an unreachable gap between
        // avatar and popover (which previously made it hard to move the mouse)
        let left = hoverPresence.rect.left + hoverPresence.rect.width + 6;
        let top = hoverPresence.rect.top - 6;
        // Keep popover on screen
        if (left + cardW > window.innerWidth) {
            left = Math.max(8, hoverPresence.rect.left - cardW - 6);
        }
        if (top + cardH > window.innerHeight) top = Math.max(8, window.innerHeight - cardH - 8);
        if (top < 8) top = 8;
        return { position: 'fixed', left, top, zIndex: 2000 };
    })() : null;

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
            if (!model) {
                console.warn('[LSP] Editor model not found (editor likely disposed or changing), skipping LSP init');
                return;
            }
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

    // Hook up Yjs-based collaboration when an editor and activeFile are present.
    useEffect(() => {
        if (!editorInstance || !monacoInstance || !activeFile || !slug || isPrivateMode) {
            // Clear collab connected state if dependencies are missing
            setCollabConnected(false);
            return;
        }

        const user = (session?.data?.user) ? { id: session.data.user.id || session.data.user.email || session.data.user.name, name: session.data.user.name || session.data.user.email, email: session.data.user.email || null, isAnonymous: false } : { id: null, name: 'Anonymous', email: null, isAnonymous: true };

        // Attach the editor to the collaboration binding
        try {
            const showLineDecorations = (presenceGranularity === 'line');
            const bindingHandle = collabClient.attachEditor({ editor: editorInstance, monaco: monacoInstance, slug, path: activeFile.path, user, options: { showLineDecorations } });
            collabBindingRef.current = bindingHandle;
            setCollabConnected(true); // Mark collab as connected
            
            // Sync initial unsaved state
            bindingHandle.updateLocalUnsaved(isUnsaved);

            // Listen for remote unsaved changes
            const awarenessUnsub = collabClient.addAwarenessListener(slug, activeFile.path, (states) => {
                const anyRemoteUnsaved = states.some(s => s.state && s.state.isUnsaved && s.clientId !== collabClient.docs.get(bindingHandle.key)?.provider?.awareness?.clientID);
                setRemoteUnsaved(anyRemoteUnsaved);
            });
            
            // Store unsub in the binding handle for cleanup convenience (hacky but works)
            bindingHandle._awarenessUnsub = awarenessUnsub;

        } catch (e) {
            console.warn('[Collab] Failed to attach editor to collaborative session', e);
            setCollabConnected(false);
        }

        return () => {
            try { collabBindingRef.current?._awarenessUnsub?.(); } catch (e) { /* ignore */ }
            try { collabBindingRef.current?.dispose(); } catch (e) { /* ignore */ }
            collabBindingRef.current = null;
            setCollabConnected(false);
            setRemoteUnsaved(false);
        };
    }, [editorInstance, monacoInstance, activeFile, slug, session, presenceGranularity, isPrivateMode]);

    // Sync local unsaved state to awareness
    useEffect(() => {
        if (collabBindingRef.current) {
            collabBindingRef.current.updateLocalUnsaved(isUnsaved);
        }
    }, [isUnsaved]);

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

    // Update ref on every render to ensure it's always fresh for callbacks/effects
    // This prevents stale closures in effects that run before the useEffect above
    latestCodeRef.current = code;

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
        // Skip Redux update if collab is applying remote changes to prevent feedback loop
        // This is critical: when remote Yjs changes come in, collabClient applies them via
        // executeEdits which triggers onChange. If we push to Redux, it would cause the 
        // value prop to change, triggering another setValue, conflicting with LSP versioning.
        if (collabBindingRef.current?.isApplyingRemote?.()) {
            latestCodeRef.current = newCode;
            return;
        }

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
        // Trigger HMR/Compilation on save
        if (onSave) onSave();
    }, [activeFile, isUnsaved, dispatch, onSave]);

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



    const diffMode = useAppSelector(state => state.workspace.diffMode);
    const originalContent = useAppSelector(state => state.workspace.originalContent);

    // --- Render ---


    return (
        <ResizablePanel defaultSize={76} minSize={20}>
            <ResizablePanelGroup direction="vertical" className="h-full">
                <ResizablePanel defaultSize={70} minSize={20}>
                    <div className="h-full flex flex-col bg-[#1e1e1e]">
                        {/* Minimal Sleek Header */}
                        <div className="h-9 px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] flex justify-between items-center select-none">

                            {/* Breadcrumbs */}
                                <div className="h-full flex items-center gap-2 overflow-hidden min-w-0">
                                    {/* Tabs bar (sleek) */}
                                    <div className="h-full block whitespace-nowrap scrollbar-overlay min-w-0 overflow-y-hidden">
                                        {openFiles && openFiles.length > 0 ? openFiles.map((file, idx) => {
                                                const isActive = activeFile && file.path === activeFile.path;
                                            const fileIcon = getFileIcon(file.name || file.path || '');
                                            return (
                                                <div key={`tab-wrap-${file.path}`} className="inline-flex items-center h-full align-top">
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
                                                        height: '100%',
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
                                                    <span aria-hidden="true" className={`ml-2 w-2 h-2 rounded-full flex-shrink-0 transition-opacity ${file.isUnsaved || (isActive && remoteUnsaved) ? '' : 'opacity-0'}`} style={{ backgroundColor: TAB_TOKENS.unsaved }} />

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

                                {/* Collaboration presence */}
                                <div className="flex items-center gap-2 text-[11px] text-gray-400 ml-3">
                                    <button 
                                        onClick={() => setIsPrivateMode(!isPrivateMode)}
                                        className={`flex items-center gap-1 px-2 py-0.5 rounded transition-colors ${isPrivateMode ? 'bg-red-900/30 text-red-400' : 'hover:bg-[#2b2b2b]'}`}
                                        title={isPrivateMode ? "Enable Collaboration" : "Disable Collaboration (Private Mode)"}
                                    >
                                        {isPrivateMode ? <EyeOff className="w-3 h-3" /> : <div className="text-xs text-gray-300">👥</div>}
                                        {isPrivateMode && <span className="text-[10px] font-bold">PRIVATE</span>}
                                    </button>
                                    
                                    {!isPrivateMode && (
                                    <div className="flex items-center gap-2">
                                        {/* small presence list */}
                                        {(() => {
                                            // only show active editors (users with cursor) to avoid many idle/default slots
                                            const allUsers = (presenceGranularity === 'workspace') ? collabClient.getWorkspaceActiveEditors(slug) : collabClient.getActiveEditors(slug, activeFile?.path);
                                            const users = allUsers.filter(u => (showAnonymousPresence ? true : !(u.state?.user?.isAnonymous)));
                                            if (!users || users.length === 0) return <span className="text-xs text-gray-400">Solo</span>;
                                            return users.slice(0,6).map(u => {
                                                const user = u.state?.user || {};
                                                const initials = (user.name || 'U').split(' ').filter(Boolean).map(p => p[0]).slice(0,2).join('').toUpperCase();
                                                return (
                                                    <div key={`${u.clientId}-${user.id || 'u'}`} className="relative">
                                                        <div
                                                            onMouseEnter={(e) => {
                                                                // cancel any pending hide
                                                                if (hoverHideTimeoutRef.current) { clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = null; }
                                                                const rect = e.currentTarget.getBoundingClientRect();
                                                                // find cursor info
                                                                const found = allUsers.find(x => x.clientId === u.clientId) || u;
                                                                setHoverPresence({ user, clientId: u.clientId, rect, cursor: found.state?.cursor });
                                                            }}
                                                            onMouseLeave={() => {
                                                                if (hoverHideTimeoutRef.current) clearTimeout(hoverHideTimeoutRef.current);
                                                                hoverHideTimeoutRef.current = setTimeout(() => setHoverPresence(null), 140);
                                                            }}
                                                            className="w-6 h-6 rounded-full flex items-center justify-center text-xs text-white cursor-default"
                                                            style={{ border: `2px solid ${user.color || '#888'}`, background: user.color ? 'rgba(255,255,255,0.03)' : '#111' }}
                                                        >
                                                            <span style={{ fontSize: 10 }}>{initials}</span>
                                                        </div>
                                                    </div>
                                                );
                                            });
                                        })()}
                                    </div>
                                    )}
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

                        {/* Hover card for presence */}
                        {hoverCardStyle && hoverPresence && hoverPresence.user && (
                            <div style={hoverCardStyle} onMouseEnter={() => { if (hoverHideTimeoutRef.current) { clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = null; } }} onMouseLeave={() => { if (hoverHideTimeoutRef.current) clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = setTimeout(() => setHoverPresence(null), 140); }}>
                                <div className="bg-[#151515] border border-[#333] rounded-md p-2 text-sm text-gray-200 shadow-lg w-56">
                                    <div className="flex items-center gap-2">
                                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm text-white" style={{ background: hoverPresence.user.color || '#555' }}>{(hoverPresence.user.name || 'Anonymous').split(' ').map(p => p[0]).slice(0,2).join('').toUpperCase()}</div>
                                        <div className="flex flex-col">
                                            <div className="font-semibold text-sm">{hoverPresence.user.name || 'Anonymous'}</div>
                                            <div className="text-xs text-gray-400">{hoverPresence.user.email || (hoverPresence.user.id ? `id: ${hoverPresence.user.id}` : 'Anonymous user')}</div>
                                        </div>
                                        <div className="ml-auto flex items-center gap-2">
                                            <button onClick={() => {
                                                // jump to user's cursor line if available
                                                if (!hoverPresence || !hoverPresence.cursor || !editorInstance) return;
                                                const pos = hoverPresence.cursor.head || hoverPresence.cursor.anchor || null;
                                                if (!pos) return;
                                                try {
                                                    editorInstance.revealPositionInCenter({ lineNumber: pos.line, column: pos.column });
                                                    editorInstance.setSelection(new monaco.Selection(pos.line, pos.column, pos.line, pos.column));
                                                } catch (_) {}
                                            }} className="px-2 py-1 rounded bg-[#2b2b2b] text-xs border border-[#3a3a3a]">Jump</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Editor Container */}
                        <div className="flex-1 overflow-hidden relative group">
                            <ContextMenu>
                                <ContextMenuTrigger asChild>
                                    <div className="h-full w-full">
                                        {diffMode ? (
                                            <DiffEditor
                                                height="100%"
                                                original={originalContent}
                                                modified={code ?? ''}
                                                language={activeLanguage}
                                                theme="synthi-theme"
                                                options={{
                                                    ...EDITOR_OPTIONS,
                                                    readOnly: true, // Diff view is usually read-only for now
                                                    renderSideBySide: true
                                                }}
                                                beforeMount={(monaco) => {
                                                    monaco.editor.defineTheme('synthi-theme', SYNTHI_THEME);
                                                }}
                                            />
                                        ) : (
                                            <Editor
                                                key={activeFileIdentity}
                                                height="100%"
                                                path={activeFile ? `/synthi/${activeFile.path.startsWith('/') ? activeFile.path.slice(1) : activeFile.path}` : undefined}
                                                // When collab is connected, don't pass value prop (uncontrolled mode)
                                                // This prevents React from fighting with Yjs for model ownership
                                                // The collabClient becomes the single source of truth
                                                {...(collabConnected ? {} : { value: code ?? '' })}
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
                                        )}
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
