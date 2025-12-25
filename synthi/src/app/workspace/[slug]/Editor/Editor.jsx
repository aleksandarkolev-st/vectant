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
    selectLoadingFiles,
    selectFileThunk,
    closeFile,
    reorderOpenFiles
} from '@/redux/workspaceSlice';
import { selectAutoSaveEnabled, selectAutoCompletionEnabled, toggleAutoCompletion, selectShowAnonymousPresence, selectPresenceGranularity, toggleShowAnonymousPresence, setPresenceGranularity, startCreate, setCursorPosition } from '@/redux/uiSlice';
import { Circle, Save, Sparkles, EyeOff, Loader2 } from 'lucide-react'; // Added Sparkles, EyeOff
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
import { takeLastChars, useCustomScrollbar } from './utils';
import { SYNTHI_THEME } from './theme';
import { ConflictBanner } from './ConflictBanner';
import * as monaco from 'monaco-editor';
import { toast } from 'sonner';

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
import { gitClient } from '@/services/gitClient';
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

// ===== SYNTHI BRAND Design Tokens - Updated for better contrast =====
const TAB_TOKENS = {
    // Active tab matches editor exactly (seamless connection)
    activeBg: '#0c0d12',      // bg-editor (darker)
    // Inactive tabs much more faded
    inactiveBg: '#08090d',    // bg-app (darker)
    hoverBg: '#101118',       // panel bg
    // Accent color for focus indicators - TEAL - brighter
    primary: '#3a8574',       // accent-primary (Synthi teal)
    primaryGlow: '0 0 14px rgba(58, 133, 116, 0.6)',
    // Border colors - stronger
    borderSubtle: '#1a1b24',  // border-subtle
    borderFocus: '#3a3b52',   // border-focus
    // Text colors - more contrast
    textPrimary: '#f4f5f8',   // text-primary
    textSecondary: '#9ba2b8', // text-secondary
    textInactive: '#4a5066',  // text for inactive tabs - much dimmer
    // Status colors
    unsaved: '#ff6b6b',       // coral red for unsaved
};

const EditorPanel = ({
    onRun,
    onSave,
    onToggleTerminal,
    onEditorMount,
    analysisResult,
    diagnostics = [],
    onAiDiagnosticsRecalibrated,
    removeDiagnosticByLocation = null,
    latestCompletion,
    aiBusy = false,
    onClearCompletion = null,
    chatVisible = false,
}) => {
    const dispatch = useAppDispatch();

    //Global state access djsaiodjasiodjasiodjasiodjaoidjasoidjsaiodjasiodjasjdnsaj
    const activeFile = useAppSelector(selectActiveFile);
    const code = useAppSelector(selectCurrentContent);
    const isUnsaved = useAppSelector(selectIsUnsaved);
    const breadcrumb = useAppSelector(selectBreadcrumb);
    const fileCacheEntries = useAppSelector(selectFileCacheEntries);
    const openFiles = useAppSelector(selectOpenFiles);
    const loadingFiles = useAppSelector(selectLoadingFiles);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    const showTerminal = useAppSelector(state => state.ui.showTerminal);
    const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
    const aiAutoEnabled = useAppSelector(selectAutoCompletionEnabled);
    const showAnonymousPresence = useAppSelector(selectShowAnonymousPresence);
    const presenceGranularity = useAppSelector(selectPresenceGranularity);
    
    // Git status for conflict detection
    const gitStatus = useAppSelector(state => state.git?.status);
    const conflictedFiles = gitStatus?.conflictedFiles || [];

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
    
    // Track which file path the editor is currently bound to
    // This prevents stale onChange handlers from writing to the wrong file
    const boundFilePathRef = useRef(null);

    // AI diagnostics are displayed as tracked decorations so they move with edits.
    const aiDecorationIdsRef = useRef([]);
    const aiDiagnosticKeysRef = useRef([]);
    const aiRecalcRafRef = useRef(null);
    const markerPruneInProgressRef = useRef(false);

    // Same lightweight content hash as `page.jsx` (FNV-1a-ish).
    // Used to gate diagnostics to the exact Monaco snapshot they were produced for.
    const computeContentHash = useCallback((content) => {
        if (typeof content !== 'string') return '00000000';
        let hash = 2166136261;
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        return hash.toString(16).padStart(8, '0');
    }, []);

    // Animated tab indicator state - simple underline that slides
    const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0, visible: false });
    const tabRefs = useRef({});

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
        console.log(`[Editor DEBUG] Collab effect triggered. ActiveFile: ${activeFile?.path}, Slug: ${slug}`);
        if (!editorInstance || !monacoInstance || !activeFile || !slug || isPrivateMode) {
            // Clear collab connected state if dependencies are missing
            setCollabConnected(false);
            return;
        }

        // Skip Yjs collaboration for files with merge conflicts
        // This ensures the editor shows the actual filesystem content with conflict markers
        // rather than stale content from Yjs persistence
        const isConflicted = conflictedFiles.includes(activeFile.path);
        if (isConflicted) {
            console.log('[Collab] Skipping Yjs binding for conflicted file:', activeFile.path);
            // Destroy any existing collab doc for this file to ensure fresh content
            try { collabClient.destroyDocument(slug, activeFile.path); } catch (e) { /* ignore */ }
            setCollabConnected(false);
            return;
        }

        // Verify the editor is still mounted and has a valid model before binding
        const model = editorInstance.getModel?.();
        if (!model) {
            console.warn('[Collab] Editor model not available, skipping collab binding');
            setCollabConnected(false);
            return;
        }

        const user = (session?.data?.user) ? { id: session.data.user.id || session.data.user.email || session.data.user.name, name: session.data.user.name || session.data.user.email, email: session.data.user.email || null, isAnonymous: false } : { id: null, name: 'Anonymous', email: null, isAnonymous: true };

        // Attach the editor to the collaboration binding
        // IMPORTANT: Get content from file cache for THIS specific file path
        // Do NOT use `code` as it may still contain content from the previous file
        // during the transition between files.
        try {
            const showLineDecorations = (presenceGranularity === 'line');
            // Get content specifically for this file from the cache
            const cachedContent = fileCacheEntries.find(([path]) => path === activeFile.path)?.[1];
            const initialContent = typeof cachedContent === 'string' ? cachedContent : (typeof code === 'string' ? code : '');
            
            console.log(`[Editor DEBUG] Attaching editor to collab session for ${activeFile.path}`);
            const bindingHandle = collabClient.attachEditor({ 
                editor: editorInstance, 
                monaco: monacoInstance, 
                slug, 
                path: activeFile.path, 
                user, 
                initialContent,
                options: { showLineDecorations } 
            });
            collabBindingRef.current = bindingHandle;
            boundFilePathRef.current = activeFile.path; // Track which file we're bound to
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
            console.log(`[Editor DEBUG] Detaching editor from collab session for ${activeFile?.path}`);
            try { collabBindingRef.current?._awarenessUnsub?.(); } catch (e) { /* ignore */ }
            try { collabBindingRef.current?.dispose(); } catch (e) { /* ignore */ }
            collabBindingRef.current = null;
            boundFilePathRef.current = null; // Clear bound file path
            setCollabConnected(false);
            setRemoteUnsaved(false);
        };
    }, [editorInstance, monacoInstance, activeFile, slug, session, presenceGranularity, isPrivateMode, conflictedFiles]);

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

    // Clean up editor instance when activeFile changes to prevent stale references
    useEffect(() => {
        // When file identity changes, clear the editor instance to force re-bind
        return () => {
            // On cleanup (file switch), null out editor to prevent stale usage
            setEditorInstance(null);
            setCollabConnected(false);
        };
    }, [activeFileIdentity]);

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
        lspReady: lspStatus.startsWith('Ready'),
        diagnostics, // Pass proactive analysis diagnostics for quick fixes
        removeDiagnosticByLocation, // Callback to remove diagnostic after fix applied
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
        // CRITICAL: Only process changes if we're bound to the correct file
        // This prevents stale onChange handlers from writing content to the wrong file
        // during file transitions.
        if (activeFile && boundFilePathRef.current && boundFilePathRef.current !== activeFile.path) {
            return;
        }
        
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
    }, [activeFile, aiAutoEnabled, activeDiffCheck, cancelActiveCompletion, dispatch, requestAiCompletion]);

    // Keep a ref to the latest handleCodeChange to avoid stale closures in the editor onMount listener
    const handleCodeChangeRef = useRef(handleCodeChange);
    useEffect(() => {
        handleCodeChangeRef.current = handleCodeChange;
    }, [handleCodeChange]);

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
                toast(aiAutoEnabled ? 'AI Auto Completion disabled' : 'AI Auto Completion enabled', {
                    duration: 2000,
                });
            }
            // New File: Ctrl + M
            if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'm' || e.key === 'M')) {
                e.preventDefault();
                let target = null;
                if (activeFile && activeFile.path.includes('/')) {
                    const parentPath = activeFile.path.substring(0, activeFile.path.lastIndexOf('/'));
                    target = { path: parentPath, isFolder: true };
                }
                dispatch(startCreate({ type: 'file', target }));
            }
            // New Folder: Ctrl + Shift + M
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'm' || e.key === 'M')) {
                e.preventDefault();
                let target = null;
                if (activeFile && activeFile.path.includes('/')) {
                    const parentPath = activeFile.path.substring(0, activeFile.path.lastIndexOf('/'));
                    target = { path: parentPath, isFolder: true };
                }
                dispatch(startCreate({ type: 'folder', target }));
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
        if (!editorInstance || !monacoInstance) return;
        const model = editorInstance.getModel?.();
        if (!model) return; // Guard against disposed editor

        // Strict VFS gating: only show diagnostics computed for the current model snapshot.
        const currentHash = computeContentHash(model.getValue?.() ?? '');
        
        // Use only proactive diagnostics - they include static analysis tier
        // and are properly invalidated when content changes
        const proactiveDiagnostics = diagnostics || [];

        // IMPORTANT: Filter to only show diagnostics for the CURRENT FILE
        // This prevents test.cpp errors from showing in test.h editor
        const currentFilePath = activeFile?.path || activeFile?.name || '';

        // Robust normalization function
        const normalizePath = (p) => {
            if (!p) return '';
            // Remove leading ./ or / or \ and normalize slashes
            return p.replace(/^[./\\]+/, '').replace(/\\/g, '/').toLowerCase();
        };

        const getDiagPath = (diag) => diag?.filePath || diag?.file || diag?.path || '';

        const currentFileDiagnostics = proactiveDiagnostics.filter(diag => {
            const diagPath = getDiagPath(diag);
            if (!diagPath) return false;

            // Snapshot gate: refuse diagnostics from other snapshots.
            if (!diag?.__analysisVersion || diag.__analysisVersion !== currentHash) return false;

            const p1 = normalizePath(diagPath);
            const p2 = normalizePath(currentFilePath);
            return p1 === p2;
        });

        // Non-AI diagnostics are rendered as Monaco markers (but we clear markers on every edit).
        const nonAiDiagnostics = currentFileDiagnostics.filter(d => {
            const tier = d.tier || '';
            const source = (d.source || '').toString().toLowerCase();
            return tier !== 'ai' && !source.includes('ai');
        });
        
        // console.log(`[Editor] Filtering diagnostics for "${currentFilePath}": ${proactiveDiagnostics.length} total -> ${currentFileDiagnostics.length} for current file`);
        
        // Convert proactive diagnostics format to markers
        const proactiveMarkers = nonAiDiagnostics.map(diag => {
            const location = diag.location || {};
            const column = location.column ?? 0;
            const endColumn = location.endColumn ?? column;
            const startCol = Math.max(1, column + 1);
            // Ensure at least 1 character width for the marker
            const endCol = Math.max(endColumn + 1, startCol + 1);
            
            return {
                startLineNumber: (location.line ?? 0) + 1,
                startColumn: startCol,
                endLineNumber: (location.endLine ?? location.line ?? 0) + 1,
                endColumn: endCol,
                message: `[${(diag.tier || 'STATIC').toUpperCase()}] ${diag.message}`,
                severity: diag.severity === 'error' ? monacoInstance.MarkerSeverity.Error :
                         diag.severity === 'warning' ? monacoInstance.MarkerSeverity.Warning :
                         diag.severity === 'hint' ? monacoInstance.MarkerSeverity.Hint :
                         monacoInstance.MarkerSeverity.Info,
                source: `synthi-${diag.tier || 'static'}`,
                code: diag.code,
            };
        });
        
        try {
            monacoInstance.editor.setModelMarkers(model, 'synthi-analysis', proactiveMarkers);
        } catch (e) {
            // Editor may have been disposed
        }
    }, [editorInstance, monacoInstance, diagnostics, activeFile?.path, computeContentHash]);

    // Track AI diagnostics with Monaco decorations so they shift with edits.
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        const model = editorInstance.getModel?.();
        if (!model) return;

        // Strict VFS gating: only show diagnostics computed for the current model snapshot.
        const currentHash = computeContentHash(model.getValue?.() ?? '');

        const currentFilePath = activeFile?.path || activeFile?.name || '';
        const normalizePath = (p) => {
            if (!p) return '';
            return p.replace(/^[./\\]+/, '').replace(/\\/g, '/').toLowerCase();
        };
        const getDiagPath = (diag) => diag?.filePath || diag?.file || diag?.path || '';

        const fileDiagnostics = (diagnostics || []).filter(diag => {
            const diagPath = getDiagPath(diag);
            if (!diagPath) return false;
            if (!diag?.__analysisVersion || diag.__analysisVersion !== currentHash) return false;
            return normalizePath(diagPath) === normalizePath(currentFilePath);
        });

        const aiDiagnostics = fileDiagnostics.filter(d => {
            const tier = d.tier || '';
            const source = (d.source || '').toString().toLowerCase();
            return tier === 'ai' || source.includes('ai');
        });

        const keys = aiDiagnostics.map((d, idx) => d.__id || d.id || `${idx}`);
        const keysChanged =
            keys.length !== aiDiagnosticKeysRef.current.length ||
            keys.some((k, i) => k !== aiDiagnosticKeysRef.current[i]);

        const decorationDefs = aiDiagnostics.map(d => {
            const loc = d.location || {};
            const column = loc.column ?? 0;
            const endColumn = loc.endColumn ?? column;
            const startLine = (loc.line ?? 0) + 1;
            const endLine = (loc.endLine ?? loc.line ?? 0) + 1;
            const startCol = Math.max(1, column + 1);
            const endCol = Math.max(endColumn + 1, startCol + 1);

            return {
                range: new monacoInstance.Range(startLine, startCol, endLine, endCol),
                options: {
                    // Invisible tracked range: we only use it to keep AI diagnostics anchored
                    // to the underlying content across edits.
                    stickiness: monacoInstance.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                },
            };
        });

        // Classic Monaco markers for AI diagnostics.
        const aiMarkers = aiDiagnostics.map((diag) => {
            const location = diag.location || {};
            const column = location.column ?? 0;
            const endColumn = location.endColumn ?? column;
            const startCol = Math.max(1, column + 1);
            const endCol = Math.max(endColumn + 1, startCol + 1);

            return {
                startLineNumber: (location.line ?? 0) + 1,
                startColumn: startCol,
                endLineNumber: (location.endLine ?? location.line ?? 0) + 1,
                endColumn: endCol,
                message: `[AI] ${diag.message}`,
                severity: diag.severity === 'error' ? monacoInstance.MarkerSeverity.Error :
                    diag.severity === 'warning' ? monacoInstance.MarkerSeverity.Warning :
                        diag.severity === 'hint' ? monacoInstance.MarkerSeverity.Hint :
                            monacoInstance.MarkerSeverity.Info,
                source: 'synthi-ai',
                code: diag.code,
            };
        });

        try {
            if (keysChanged) {
                aiDiagnosticKeysRef.current = keys;
            }
            aiDecorationIdsRef.current = editorInstance.deltaDecorations(aiDecorationIdsRef.current, decorationDefs);
            // Replace AI markers immediately on analysis arrival.
            monacoInstance.editor.setModelMarkers(model, 'synthi-ai', aiMarkers);
        } catch (_) {
            // ignore (disposed)
        }
        // Intentionally re-run when file changes, editor changes, or diagnostics set changes
    }, [editorInstance, monacoInstance, diagnostics, activeFile?.path, computeContentHash]);

    // Clear AI decorations when the editor instance changes/unmounts.
    useEffect(() => {
        if (!editorInstance) return;
        return () => {
            try {
                const model = editorInstance.getModel?.();
                if (model && monacoInstance?.editor) {
                    monacoInstance.editor.setModelMarkers(model, 'synthi-ai', []);
                }
            } catch (_) {
                // ignore
            }
            try {
                aiDecorationIdsRef.current = editorInstance.deltaDecorations(aiDecorationIdsRef.current, []);
            } catch (_) {
                // ignore
            }
            aiDecorationIdsRef.current = [];
            aiDiagnosticKeysRef.current = [];
        };
    }, [editorInstance, monacoInstance]);

    // On any edit, recompute AI diagnostic locations from decoration ranges and report back.
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        if (typeof onAiDiagnosticsRecalibrated !== 'function') return;

        const model = editorInstance.getModel?.();
        if (!model) return;

        const currentFilePath = activeFile?.path || activeFile?.name || '';

        const normalizePath = (p) => {
            if (!p) return '';
            return p.replace(/^[./\\]+/, '').replace(/\\/g, '/').toLowerCase();
        };
        const getDiagPath = (diag) => diag?.filePath || diag?.file || diag?.path || '';

        const schedule = () => {
            if (aiRecalcRafRef.current) return;
            aiRecalcRafRef.current = requestAnimationFrame(() => {
                aiRecalcRafRef.current = null;
                try {
                    const ids = aiDecorationIdsRef.current || [];
                    const keys = aiDiagnosticKeysRef.current || [];
                    if (ids.length === 0 || keys.length === 0) {
                        // If there are no tracked ranges (e.g. new analysis removed all AI diags),
                        // ensure we clear the AI marker owner.
                        try {
                            monacoInstance.editor.setModelMarkers(model, 'synthi-ai', []);
                        } catch (_) {
                            // ignore
                        }
                        return;
                    }

                    const currentNorm = normalizePath(currentFilePath);
                    const fileAiDiags = (diagnostics || []).filter(d => {
                        const diagPath = getDiagPath(d);
                        if (!diagPath) return false;
                        return normalizePath(diagPath) === currentNorm;
                    }).filter(d => {
                        const tier = d.tier || '';
                        const source = (d.source || '').toString().toLowerCase();
                        return tier === 'ai' || source.includes('ai');
                    });

                    const diagByKey = new Map(
                        fileAiDiags.map((d, idx) => [d.__id || d.id || `${idx}`, d])
                    );

                    const updates = [];
                    const markers = [];
                    for (let i = 0; i < ids.length; i++) {
                        const decId = ids[i];
                        const key = keys[i];
                        const r = model.getDecorationRange(decId);
                        if (!r) continue;
                        updates.push({
                            __id: key,
                            location: {
                                line: r.startLineNumber - 1,
                                column: r.startColumn - 1,
                                endLine: r.endLineNumber - 1,
                                endColumn: r.endColumn - 1,
                            },
                        });

                        const d = diagByKey.get(key);
                        if (d) {
                            markers.push({
                                startLineNumber: r.startLineNumber,
                                startColumn: r.startColumn,
                                endLineNumber: r.endLineNumber,
                                endColumn: r.endColumn,
                                message: `[AI] ${d.message}`,
                                severity: d.severity === 'error' ? monacoInstance.MarkerSeverity.Error :
                                    d.severity === 'warning' ? monacoInstance.MarkerSeverity.Warning :
                                        d.severity === 'hint' ? monacoInstance.MarkerSeverity.Hint :
                                            monacoInstance.MarkerSeverity.Info,
                                source: 'synthi-ai',
                                code: d.code,
                            });
                        }
                    }

                    if (updates.length) {
                        onAiDiagnosticsRecalibrated(currentFilePath, updates);
                    }

                    // Render AI diagnostics using Monaco markers (old squiggly UI).
                    try {
                        monacoInstance.editor.setModelMarkers(model, 'synthi-ai', markers);
                    } catch (_) {
                        // ignore
                    }
                } catch (_) {
                    // ignore
                }
            });
        };

        const disposable = editorInstance.onDidChangeModelContent(() => {
            schedule();
        });

        // Also schedule once on mount/model switch to align state.
        schedule();

        return () => {
            try {
                disposable?.dispose?.();
            } catch (_) {}
            if (aiRecalcRafRef.current) {
                cancelAnimationFrame(aiRecalcRafRef.current);
                aiRecalcRafRef.current = null;
            }
        };
    }, [editorInstance, monacoInstance, diagnostics, activeFile?.path, onAiDiagnosticsRecalibrated]);

    // Suppress external marker owners (Monaco language services / LSP) so syntax/semantic markers
    // do not reappear while editing. We only allow Synthi-owned marker sets.
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        const model = editorInstance.getModel?.();
        if (!model) return;

        // Only allow Synthi-owned marker sets. NOTE: We intentionally do NOT allow
        // the legacy 'synthi-proactive' owner because it can keep stale markers alive
        // even when the new unified pipeline has cleared diagnostics.
        const allowedOwners = new Set(['synthi-analysis', 'synthi-ai']);

        const prune = () => {
            if (markerPruneInProgressRef.current) return;
            markerPruneInProgressRef.current = true;
            try {
                const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri }) || [];
                const ownersToClear = new Set();
                for (const m of markers) {
                    if (m && m.owner && !allowedOwners.has(m.owner)) ownersToClear.add(m.owner);
                }
                ownersToClear.forEach((owner) => {
                    try {
                        monacoInstance.editor.setModelMarkers(model, owner, []);
                    } catch (_) {
                        // ignore
                    }
                });
            } catch (_) {
                // ignore
            } finally {
                // Release on next tick to avoid re-entrancy loops.
                setTimeout(() => {
                    markerPruneInProgressRef.current = false;
                }, 0);
            }
        };

        // Run once after mount/model switch.
        prune();

        // Some publishers re-apply diagnostics asynchronously after startup.
        // Keep pruning briefly to ensure stale external markers don't stick.
        const pruneInterval = setInterval(prune, 200);
        const pruneTimeout = setTimeout(() => {
            clearInterval(pruneInterval);
        }, 2000);

        // Monaco API: onDidChangeMarkers(listener) where listener receives an array of changed resources.
        const disposable = monacoInstance.editor.onDidChangeMarkers((resources) => {
            try {
                const modelUriStr = model?.uri?.toString?.() || '';
                if (!modelUriStr) {
                    prune();
                    return;
                }
                const list = Array.isArray(resources) ? resources : [];
                const touched = list.some((u) => (u?.toString?.() || '') === modelUriStr);
                if (touched || list.length === 0) prune();
            } catch (_) {
                prune();
            }
        });

        return () => {
            try { disposable?.dispose?.(); } catch (_) {}
            clearInterval(pruneInterval);
            clearTimeout(pruneTimeout);
        };
    }, [editorInstance, monacoInstance, activeFile?.path]);

    // Hard guarantee: clear stale markers immediately on any edit.
    // We maintain multiple marker "owners" (AI/proactive + extension host).
    // If the user edits text, any existing diagnostics are for an older snapshot and
    // can appear pinned to the wrong lines/columns (ghost markers).
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        const clearAllKnownOwners = () => {
            const model = editorInstance.getModel?.();
            if (!model) return;
            try {
                const owners = new Set([
                    'synthi-analysis',
                    'synthi-proactive',
                    'synthi-ai',
                    'extension',
                ]);

                // Extension bridge registers every marker owner it uses here.
                const tracked = monacoInstance.__synthiMarkerOwners;
                if (tracked && typeof tracked.forEach === 'function') {
                    tracked.forEach((o) => owners.add(o));
                }

                // Also clear any markers created by built-in Monaco language services
                // or LSP clients that use their own owner strings.
                try {
                    const existing = monacoInstance.editor.getModelMarkers({ resource: model.uri }) || [];
                    for (const m of existing) {
                        if (m && m.owner) owners.add(m.owner);
                    }
                } catch (_) {
                    // ignore
                }

                owners.forEach((owner) => {
                    monacoInstance.editor.setModelMarkers(model, owner, []);
                });
            } catch (e) {
                // ignore (disposed)
            }
        };

        // Clear immediately once when model changes (tab switch) to avoid showing
        // diagnostics from a previous model while new analysis/diagnostics load.
        clearAllKnownOwners();

        const disposable = editorInstance.onDidChangeModelContent(() => {
            clearAllKnownOwners();
        });

        return () => disposable?.dispose?.();
    }, [editorInstance, monacoInstance, activeFile?.path]);

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

    // --- Custom Scrollbar Logic ---
    const {
        tabsContainerRef,
        scrollbarThumbRef,
        handleScroll,
        handleThumbMouseDown
    } = useCustomScrollbar([openFiles]);

    // --- Animated Tab Indicator Logic ---
    useEffect(() => {
        if (!activeFile || !tabsContainerRef.current) {
            setTabIndicator(prev => ({ ...prev, visible: false }));
            return;
        }

        const updateIndicator = () => {
            const activeTabEl = tabRefs.current[activeFile.path];
            const container = tabsContainerRef.current;
            
            if (activeTabEl && container) {
                const containerRect = container.getBoundingClientRect();
                const tabRect = activeTabEl.getBoundingClientRect();
                
                setTabIndicator({
                    left: tabRect.left - containerRect.left + container.scrollLeft,
                    width: tabRect.width,
                    visible: true
                });
            }
        };

        // Small delay to ensure DOM is ready after tab switch
        const timeoutId = setTimeout(updateIndicator, 10);

        // Also update on scroll
        const container = tabsContainerRef.current;
        container?.addEventListener('scroll', updateIndicator);
        
        // Update on resize
        const resizeObserver = new ResizeObserver(updateIndicator);
        if (container) resizeObserver.observe(container);

        return () => {
            clearTimeout(timeoutId);
            container?.removeEventListener('scroll', updateIndicator);
            resizeObserver.disconnect();
        };
    }, [activeFile, openFiles]);

    // --- Render ---


    return (
        <ResizablePanel defaultSize={76} minSize={20}>
            <ResizablePanelGroup direction="vertical" className="h-full">
                <ResizablePanel defaultSize={70} minSize={20}>
                    <div className="h-full flex flex-col bg-[#0c0d12] rounded-tl-lg rounded-tr-lg overflow-hidden">
                        {/* Minimal Sleek Header - Synthi Brand Theme */}
                        <div className="h-10 border-b-2 border-[#1a1b24] bg-[#08090d] flex justify-between select-none shadow-sm">

                            {/* Breadcrumbs */}
                                <div className="h-full flex min-w-0 relative group tabs-container-wrapper">
                                    {/* Tabs bar (sleek) */}
                                    <div
                                        ref={tabsContainerRef}
                                        onScroll={handleScroll}
                                        className="h-full whitespace-nowrap min-w-0 flex flex-row overflow-x-auto overflow-y-hidden no-scrollbar relative"
                                    >
                                        {/* Animated Tab Indicator - Strong underline */}
                                        <div
                                            className="absolute bottom-0 h-[3px] pointer-events-none"
                                            style={{
                                                left: tabIndicator.left,
                                                width: tabIndicator.width,
                                                opacity: tabIndicator.visible ? 1 : 0,
                                                background: 'linear-gradient(90deg, #3a8574, #4aba9a, #3a8574)',
                                                backgroundSize: '200% 100%',
                                                animation: 'tab-underline-shimmer 2s ease-in-out infinite',
                                                boxShadow: '0 0 10px rgba(58, 133, 116, 0.6), 0 0 3px rgba(74, 186, 154, 0.9)',
                                                transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.15s ease',
                                                borderRadius: '2px 2px 0 0',
                                            }}
                                        />
                                        {openFiles && openFiles.length > 0 ? openFiles.map((file, idx) => {
                                                const isActive = activeFile && file.path === activeFile.path;
                                            const fileIcon = getFileIcon(file.name || file.path || '');
                                            // Generate breadcrumb path (show parent folders)
                                            const pathParts = file.path.split('/').filter(Boolean);
                                            const parentPath = pathParts.length > 1 ? pathParts.slice(0, -1).join(' › ') : '';
                                            return (
                                                <div 
                                                    key={`tab-wrap-${file.path}`} 
                                                    ref={(el) => { tabRefs.current[file.path] = el; }}
                                                    className="inline-flex items-center h-9 align-top flex-shrink-0"
                                                >
                                                    

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
                                                    className={`group flex items-center gap-2 px-3 cursor-pointer select-none transition-all duration-200 ${isActive ? 'text-[#f4f5f8] bg-[#0c0d12]' : 'text-[#4a5066] bg-[#08090d] hover:bg-[#0c0d12] hover:text-[#9ba2b8] opacity-60 hover:opacity-90'}`}
                                                    title={file.path}
                                                    style={{
                                                        minWidth: 130,
                                                        maxWidth: 260,
                                                        height: '100%',
                                                        borderRight: `1px solid ${TAB_TOKENS.borderSubtle}`,
                                                        borderLeft: idx === 0 ? 'none' : 'none',
                                                        borderTop: '2px solid transparent',
                                                        borderBottom: isActive ? 'none' : `1px solid ${TAB_TOKENS.borderSubtle}`,
                                                        borderRadius: isActive ? '8px 8px 0 0' : '0',
                                                        marginLeft: '0',
                                                        position: 'relative',
                                                    }}
                                                >
                                                    <span className={`flex-shrink-0 text-sm ${isActive ? 'opacity-90' : 'opacity-50'}`} aria-hidden="true">
                                                        {loadingFiles.includes(file.path) ? <Loader2 className="w-4 h-4 animate-spin text-[#3a8574]" /> : fileIcon}
                                                    </span>
                                                    <div className="flex flex-col min-w-0 overflow-hidden">
                                                        <span className={`text-[13px] truncate ${isActive ? 'text-[#f4f5f8] font-semibold' : 'text-[#9ba2b8] font-normal'}`}>
                                                            {file.name}
                                                        </span>
                                                        {/* Breadcrumb path - shows parent folder context - only for active */}
                                                        {parentPath && isActive && (
                                                            <span className="text-[9px] text-[#5a6178] truncate">
                                                                {parentPath}
                                                            </span>
                                                        )}
                                                    </div>

                                                    {/* Unsaved marker - coral dot with glow */}
                                                    <span aria-hidden="true" className={`ml-auto w-2 h-2 rounded-full flex-shrink-0 transition-opacity shadow-[0_0_6px_rgba(255,107,107,0.6)] ${file.isUnsaved || (isActive && remoteUnsaved) ? '' : 'opacity-0'}`} style={{ backgroundColor: '#ff6b6b' }} />

                                                    {/* Close button appears on hover (VSCode behavior) */}
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); dispatch(closeFile(file.path)); }}
                                                        className={`flex items-center justify-center w-5 h-5 rounded-full transition-all duration-150 ${isActive ? 'text-[#f4f5f8]/80 hover:text-[#f4f5f8] hover:bg-[#3a857430]' : 'text-[#5a6178] hover:text-[#f4f5f8] hover:bg-[#1a1b24]'}`}
                                                        aria-label={`Close ${file.name}`}
                                                        style={{ opacity: 0 }}
                                                    >
                                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="pointer-events-none">
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
                                        <span className="text-[#5a6178] text-xs italic px-3 flex items-center">No file open</span>
                                    )}
                                    </div>
                                    {/* Custom Scrollbar - Synthi accent */}
                                    <div className="absolute left-0 right-0 bottom-0 h-[3px] z-20 pointer-events-none">
                                        <div
                                            ref={scrollbarThumbRef}
                                            className="absolute top-0 bottom-0 bg-gradient-to-r from-[#3a857450] to-[#4a9a8850] rounded-[3px] cursor-pointer pointer-events-auto opacity-0 transition-opacity duration-200 group-hover:opacity-100 [&.visible]:opacity-100"
                                            onMouseDown={handleThumbMouseDown}
                                        />
                                    </div>
                                </div>
                                {/* Context menu for tabs - Synthi styled */}
                                {tabContext.visible && (
                                    <div
                                        style={{ position: 'fixed', left: tabContext.x, top: tabContext.y, zIndex: 9999 }}
                                        onMouseLeave={() => setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 })}
                                    >
                                        <div className="bg-[#0c0d12] border border-[#1a1b24] rounded-lg shadow-lg text-sm text-[#f4f5f8]">
                                            <div className="px-3 py-2 hover:bg-[#3a857418] hover:text-[#4aba9a] cursor-pointer rounded-t-lg transition-colors" onClick={() => { if (tabContext.file) dispatch(closeFile(tabContext.file.path)); setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 }); }}>Close</div>
                                            <div className="px-3 py-2 hover:bg-[#3a857418] hover:text-[#4aba9a] cursor-pointer transition-colors" onClick={() => {
                                                if (tabContext.file) {
                                                    const keep = tabContext.file.path;
                                                    const toClose = openFiles.filter(f => f.path !== keep).map(f => f.path);
                                                    toClose.forEach(p => dispatch(closeFile(p)));
                                                }
                                                setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 });
                                            }}>Close Others</div>
                                            <div className="px-3 py-2 hover:bg-[#3a857418] hover:text-[#4aba9a] cursor-pointer rounded-b-lg transition-colors" onClick={() => {
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
                            

                            {/* Status & Controls */}
                            <div className="flex items-center gap-2 pr-2">
                                {/* Collaboration presence */}
                                <div className="flex items-center gap-1 text-[11px] text-[#9ba2b8]">
                                    <button 
                                        onClick={() => setIsPrivateMode(!isPrivateMode)}
                                        className={`flex items-center px-1.5 py-0.5 rounded-full transition-all ${isPrivateMode ? 'bg-[#ff575720] text-[#ff5757] border border-[#ff575740]' : 'hover:bg-[#1a1b24]'}`}
                                        title={isPrivateMode ? "Enable Collaboration" : "Disable Collaboration (Private Mode)"}
                                    >
                                        {isPrivateMode ? <EyeOff className="w-3 h-3" /> : <div className="text-xs text-[#9ba2b8] h-5">👥</div>}
                                        {isPrivateMode && <span className="text-[10px] font-bold ml-1">PRIVATE</span>}
                                    </button>
                                    
                                    {!isPrivateMode && (
                                    <div className="flex items-center gap-2">
                                        {/* small presence list */}
                                        {(() => {
                                            // only show active editors (users with cursor) to avoid many idle/default slots
                                            const allUsers = (presenceGranularity === 'workspace') ? collabClient.getWorkspaceActiveEditors(slug) : collabClient.getActiveEditors(slug, activeFile?.path);
                                            const users = allUsers.filter(u => (showAnonymousPresence ? true : !(u.state?.user?.isAnonymous)));
                                            if (!users || users.length === 0) return <span className="text-xs text-[#6b7089] px-2 py-0.5 rounded-full bg-[#1c1d26] border border-[#32334a]">Solo</span>;
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
                                                            className="w-6 h-6 rounded-full flex items-center justify-center text-xs text-white cursor-default shadow-sm"
                                                            style={{ border: `2px solid ${user.color || '#327464'}`, background: user.color ? 'rgba(255,255,255,0.05)' : '#12131a' }}
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

                                {/* AI Status Indicator - Shows only when loading */}
                                <div className={`transition-opacity duration-300 ${(aiCompletionState === 'loading' || aiBusy) ? 'opacity-100' : 'opacity-0'}`}>
                                    <Sparkles className="w-3.5 h-3.5 text-[#327464] animate-pulse" />
                                </div>

                                {/* Manual Save (Optional since we have auto-save) */}
                                <button onClick={handleSave} className="opacity-60 hover:opacity-100 transition-opacity px-1">
                                    <Save className="w-4 h-4 text-[#71717a]" />
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

                        {/* Merge Conflict Banner */}
                        {activeFile && (
                            <ConflictBanner
                                content={code}
                                filePath={activeFile.path}
                                slug={slug}
                                onContentChange={async (newContent) => {
                                    dispatch(updateContent(newContent));
                                    // Also write to git filesystem to persist resolution
                                    try {
                                        await gitClient.writeFile(slug, activeFile.path, newContent);
                                    } catch (e) {
                                        console.warn('[Conflict] Failed to write resolved content:', e);
                                    }
                                }}
                                editorInstance={editorInstance}
                            />
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
                                                // Always pass value on initial mount, then let collab take over
                                                // This ensures Monaco has valid content before Yjs binds
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
                                                onMount={(editor, monaco) => {
                                                    // Verify editor has a valid model before storing reference
                                                    const model = editor.getModel?.();
                                                    if (!model) {
                                                        console.warn('[Editor] onMount called but model is undefined, skipping');
                                                        return;
                                                    }
                                                    setEditorInstance(editor);
                                                    setMonacoInstance(monaco);
                                                    if (onEditorMount) onEditorMount(editor);

                                                    // Hard reset: clear any pre-existing markers on initial mount.
                                                    // Some language services may publish diagnostics immediately.
                                                    try {
                                                        const model = editor.getModel?.();
                                                        if (model) {
                                                            const existing = monaco.editor.getModelMarkers({ resource: model.uri }) || [];
                                                            const owners = new Set(existing.map(m => m?.owner).filter(Boolean));
                                                            owners.add('synthi-analysis');
                                                            owners.add('synthi-proactive');
                                                            owners.add('synthi-ai');
                                                            owners.add('extension');
                                                            owners.forEach((owner) => {
                                                                try { monaco.editor.setModelMarkers(model, owner, []); } catch (_) {}
                                                            });

                                                            // Catch late marker publishers (e.g. extension host) right after mount.
                                                            const clearLate = () => {
                                                                try {
                                                                    const late = monaco.editor.getModelMarkers({ resource: model.uri }) || [];
                                                                    const lateOwners = new Set(late.map(m => m?.owner).filter(Boolean));
                                                                    lateOwners.add('synthi-analysis');
                                                                    lateOwners.add('synthi-proactive');
                                                                    lateOwners.add('synthi-ai');
                                                                    lateOwners.add('extension');

                                                                    const tracked = monaco.__synthiMarkerOwners;
                                                                    if (tracked && typeof tracked.forEach === 'function') {
                                                                        tracked.forEach((o) => lateOwners.add(o));
                                                                    }

                                                                    lateOwners.forEach((owner) => {
                                                                        try { monaco.editor.setModelMarkers(model, owner, []); } catch (_) {}
                                                                    });
                                                                } catch (_) {}
                                                            };
                                                            setTimeout(clearLate, 0);
                                                            setTimeout(clearLate, 200);
                                                        }
                                                    } catch (_) {}
                                                    editor.onDidChangeCursorPosition(e => {
                                                        const nextPos = e.position;
                                                        if (pendingPositionFrameRef.current) return;
                                                        pendingPositionFrameRef.current = requestAnimationFrame(() => {
                                                            setPosition(nextPos);
                                                            dispatch(setCursorPosition({ lineNumber: nextPos.lineNumber, column: nextPos.column }));
                                                            pendingPositionFrameRef.current = null;
                                                        });
                                                    });
                                                    
                                                    // Subscribe directly to Monaco's content change event
                                                    // This ensures ALL changes are captured, including whitespace/enter
                                                    // that @monaco-editor/react's onChange might skip
                                                    editor.onDidChangeModelContent(() => {
                                                        // Hard-clear markers synchronously on every edit.
                                                        // This runs even before React effects register listeners,
                                                        // preventing the "markers never clear" race after file open.
                                                        try {
                                                            const model = editor.getModel?.();
                                                            if (model) {
                                                                const owners = new Set([
                                                                    'synthi-analysis',
                                                                    'synthi-proactive',
                                                                    'synthi-ai',
                                                                    'extension',
                                                                ]);

                                                                // Extension bridge registers owners here.
                                                                const tracked = monaco.__synthiMarkerOwners;
                                                                if (tracked && typeof tracked.forEach === 'function') {
                                                                    tracked.forEach((o) => owners.add(o));
                                                                }

                                                                // Also clear any existing owners currently present on this model.
                                                                try {
                                                                    const existing = monaco.editor.getModelMarkers({ resource: model.uri }) || [];
                                                                    for (const m of existing) {
                                                                        if (m && m.owner) owners.add(m.owner);
                                                                    }
                                                                } catch (_) {
                                                                    // ignore
                                                                }

                                                                owners.forEach((owner) => {
                                                                    try {
                                                                        monaco.editor.setModelMarkers(model, owner, []);
                                                                    } catch (_) {
                                                                        // ignore
                                                                    }
                                                                });
                                                            }
                                                        } catch (_) {
                                                            // ignore
                                                        }

                                                        const newCode = editor.getModel()?.getValue() ?? '';
                                                        handleCodeChangeRef.current(newCode);
                                                    });

                                                    // Ensure layout refreshes on mount
                                                    setTimeout(() => {
                                                        try {
                                                            editor.layout();
                                                        } catch (e) {
                                                            // Editor may have been disposed
                                                        }
                                                    }, 100);
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
                                    <ContextMenuItem onClick={() => handleSave()}>
                                        Save
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
                        <ResizableHandle className="bg-[#1a1a1e] h-px hover:bg-[#327464]" />
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
