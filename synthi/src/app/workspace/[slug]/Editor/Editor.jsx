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
    reorderOpenFiles,
    setDiffMode,
    clearSavedBaselines
} from '@/redux/workspaceSlice';
import { selectAutoCompletionEnabled, toggleAutoCompletion, selectPresenceGranularity, startCreate, setCursorPosition, selectAutoSaveEnabled } from '@/redux/uiSlice';
import { fetchGitStatus, closeConflictResolver } from '@/redux/gitSlice';
import { Circle, Save, Sparkles, Loader2, X } from 'lucide-react';
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
import MergeConflictEditor from '@/components/git/MergeConflictEditor';
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
}

// Worker factory for MonacoVscodeApiWrapper — must be passed via monacoWorkerFactory
// so it isn't overwritten by the wrapper's own useWorkerFactory({}) call.
function configureClassicWorkerFactory() {
    const { useWorkerFactory } = require('monaco-languageclient/workerFactory');
    useWorkerFactory({
        workerLoaders: {
            editorWorkerService: () => new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url)),
            json: () => new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker.js', import.meta.url)),
            css: () => new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url)),
            scss: () => new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url)),
            less: () => new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker.js', import.meta.url)),
            html: () => new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url)),
            handlebars: () => new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url)),
            razor: () => new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker.js', import.meta.url)),
            typescript: () => new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url)),
            javascript: () => new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker.js', import.meta.url)),
        }
    });
}

const TerminalManagerDyn = dynamic(() => import('../../TerminalManager.jsx'), {
    ssr: false
});

let servicesInitialized = false;
let servicesInitPromise = null; // serialize concurrent init attempts

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
    const savedContent = useAppSelector(state => state.workspace.savedContent);
    const aiAutoEnabled = useAppSelector(selectAutoCompletionEnabled);
    const presenceGranularity = useAppSelector(selectPresenceGranularity);
    const diffMode = useAppSelector(state => state.workspace.diffMode);
    const originalContent = useAppSelector(state => state.workspace.originalContent);
    
    // Git status for conflict detection
    const gitStatus = useAppSelector(state => state.git?.status);
    const conflictedFiles = gitStatus?.conflictedFiles || [];
    const conflictResolverFile = useAppSelector(state => state.git?.conflictResolverFile);

    // Local state
    const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
    const [editorInstance, setEditorInstance] = useState(null);
    const [monacoInstance, setMonacoInstance] = useState(null);
    // Track whether the DiffEditor has ever been activated — once true, we keep
    // it mounted (hidden) to avoid React unmount crash in passive effects.
    const [diffModeEverActive, setDiffModeEverActive] = useState(false);
    const latestCodeRef = useRef(code);
    const pendingContentFrameRef = useRef(null);
    const pendingPositionFrameRef = useRef(null);
    // P0: Debounced Redux sync — only flush content to Redux after 300ms pause
    const reduxSyncTimerRef = useRef(null);
    // P0: Debounced marker clearing — avoid blocking main thread on every keystroke
    const markerClearTimerRef = useRef(null);
    // P2: Cached content hash — avoid O(n) FNV-1a on every keystroke
    const contentHashRef = useRef({ content: '', hash: '00000000' });
    const [tabContext, setTabContext] = useState({ visible: false, x: 0, y: 0, file: null, index: -1 });
    const [lspStatus, setLspStatus] = useState('Idle');
    const [servicesReady, setServicesReady] = useState(false);
    const slug = useAppSelector(state => state.workspace.slug);
    const session = useSession();
    // Derive authenticated user id from the session — used as a guard for
    // collab binding so we never open Yjs docs before identity is set.
    const authUserId = session?.data?.user?.id || session?.data?.user?.email || null;
    const collabBindingRef = useRef(null);
    const [collabConnected, setCollabConnected] = useState(false); // Track if collab is actively bound
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
    // P2: Cached — only recomputes when content actually changes.
    const computeContentHash = useCallback((content) => {
        if (typeof content !== 'string') return '00000000';
        const cached = contentHashRef.current;
        if (cached.content === content) return cached.hash;
        let hash = 2166136261;
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        const result = hash.toString(16).padStart(8, '0');
        contentHashRef.current = { content, hash: result };
        return result;
    }, []);

    // Animated tab indicator state - simple underline that slides
    const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0, visible: false });
    const tabRefs = useRef({});

    const { client: compilerClient, status: compilerStatus } = useCompiler();
    const languageClientsRef = useRef(new Map());
    const lspInitPendingRef = useRef(new Set()); // Guard against concurrent init for same language

    // Initialize Monaco Services ONCE — uses a module-level promise so that
    // concurrent callers (StrictMode double-fire, fast remounts) all wait for
    // the *real* initialization instead of treating a no-op start() as success.
    useEffect(() => {
        if (servicesInitialized) {
            setServicesReady(true);
            return;
        }

        if (!servicesInitPromise) {
            servicesInitPromise = import('monaco-languageclient/vscodeApiWrapper').then(
                async ({ MonacoVscodeApiWrapper }) => {
                    const wrapper = new MonacoVscodeApiWrapper({
                        $type: 'classic',
                        viewsConfig: {
                            $type: 'EditorService'
                        },
                        monacoWorkerFactory: configureClassicWorkerFactory
                    });
                    await wrapper.start();
                    servicesInitialized = true;
                    console.log('[LSP] Monaco Services Initialized');
                }
            );
        }

        servicesInitPromise
            .then(() => setServicesReady(true))
            .catch(e => console.error('Failed to initialize monaco-vscode-api', e));
    }, []);

    useEffect(() => {
        console.log('[LSP-EFFECT] Guard check:', {
            monacoInstance: !!monacoInstance,
            compilerClient: !!compilerClient,
            compilerStatus,
            activeFile: activeFile?.name || null,
            servicesReady,
            editorInstance: !!editorInstance,
        });
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
        } else if (lang === 'java') {
            backendLang = 'java';
            documentSelector = ['java'];
        } else if (lang === 'go') {
            backendLang = 'go';
            documentSelector = ['go'];
        } else if (lang === 'csharp') {
            backendLang = 'csharp';
            documentSelector = ['csharp'];
        } else if (lang === 'ruby') {
            backendLang = 'ruby';
            documentSelector = ['ruby'];
        } else if (lang === 'php') {
            backendLang = 'php';
            documentSelector = ['php'];
        } else if (lang === 'kotlin') {
            backendLang = 'kotlin';
            documentSelector = ['kotlin'];
        } else if (lang === 'zig') {
            backendLang = 'zig';
            documentSelector = ['zig'];
        } else if (lang === 'dart') {
            backendLang = 'dart';
            documentSelector = ['dart'];
        } else if (lang === 'lua') {
            backendLang = 'lua';
            documentSelector = ['lua'];
        } else if (lang === 'elixir') {
            backendLang = 'elixir';
            documentSelector = ['elixir'];
        } else if (lang === 'svelte') {
            backendLang = 'svelte';
            documentSelector = ['svelte'];
        } else if (['css', 'scss', 'less'].includes(lang)) {
            backendLang = 'css';
            documentSelector = ['css', 'scss', 'less'];
        } else if (lang === 'html') {
            backendLang = 'html';
            documentSelector = ['html'];
        }

        if (!backendLang) {
            setLspStatus('No LSP for this file');
            return;
        }

        if (languageClientsRef.current.has(backendLang)) {
            const client = languageClientsRef.current.get(backendLang);
            if (client && client.isRunning()) {
                setLspStatus(`Ready (${backendLang})`);
                // Ensure we send didOpen for the new file even if client exists
                const model = editorInstance.getModel();
                if (model) {
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
            // Client exists but is no longer running (channel closed, crashed, etc.)
            // Remove the stale entry so we re-initialize below.
            console.warn(`[LSP] Stale client for ${backendLang} — removing and re-initializing`);
            languageClientsRef.current.delete(backendLang);
        }

        // Prevent concurrent initialization for the same language
        // (effect can re-fire while the async .then() is still in flight)
        if (lspInitPendingRef.current.has(backendLang)) {
            return;
        }

        // Check model BEFORE creating a WebRTC channel — if the editor model
        // isn't ready yet the effect will re-run when editorInstance updates
        const model = editorInstance.getModel();
        if (!model) {
            console.log(`[LSP] Editor model not ready yet for ${backendLang}, will retry on next effect cycle`);
            return;
        }

        console.log(`[LSP] Initializing for ${backendLang}...`);
        setLspStatus(`Initializing ${backendLang}...`);
        lspInitPendingRef.current.add(backendLang);

        let lspChannel;
        let adapter;
        try {
            lspChannel = compilerClient.createLspChannel(backendLang);
            console.log(`[LSP] Created channel for ${backendLang}, readyState: ${lspChannel.readyState}`);
        } catch (e) {
            console.error("[LSP] Failed to create channel", e);
            setLspStatus('Channel Error');
            return;
        }

        // The adapter owns ALL dataChannel event handlers (onopen, onmessage,
        // onerror, onclose).  External code must NEVER overwrite them directly.
        adapter = new MonacoSocketAdapter(lspChannel);
        const socket = toSocket(adapter);
        const reader = new WebSocketMessageReader(socket);
        const writer = new WebSocketMessageWriter(socket);

        Promise.all([
            import('monaco-languageclient'),
            import('monaco-languageclient/vscodeApiWrapper')
        ]).then(async ([{ MonacoLanguageClient }, { MonacoVscodeApiWrapper }]) => {
            if (languageClientsRef.current.has(backendLang)) {
                lspInitPendingRef.current.delete(backendLang);
                return;
            }

            // Services should be initialized by the other useEffect, but double check
            if (!servicesInitialized) {
                console.warn('[LSP] Services not initialized yet, waiting...');
                lspInitPendingRef.current.delete(backendLang);
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
                    documentSelector: documentSelector.map(lang => ({ language: lang, scheme: 'file' })),
                    middleware: {
                        didOpen: (data, next) => {
                            // Suppressed — we send didOpen manually
                        },
                        didChange: (data, next) => {
                            // Suppressed — we send didChange manually (debounced)
                        },
                        provideCompletionItem: (document, position, context, token, next) => {
                            // Suppressed — we use the manual bridge for completions
                            return [];
                        },
                        resolveCompletionItem: (item, token, next) => {
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
            // model was already verified before channel creation — re-read in case editor changed
            const currentModel = editorInstance.getModel();
            if (!currentModel) {
                console.warn('[LSP] Editor model disappeared during async init, aborting');
                lspInitPendingRef.current.delete(backendLang);
                try { lspChannel.close(); } catch (_) {}
                return;
            }
            console.log(`[LSP] Model Details - URI: ${currentModel.uri.toString()}, Scheme: ${currentModel.uri.scheme}, Language: ${currentModel.getLanguageId()}`);

            // Wait for the data channel to open (in-band SCTP negotiation).
            // Uses the adapter's helper so we don't clobber its event handlers.
            if (adapter.readyState !== 1) {
                console.log(`[LSP] Waiting for channel to open (adapter.readyState: ${adapter.readyState}, dc.readyState: ${lspChannel.readyState})...`);
                setLspStatus(`Waiting for channel (${backendLang})...`);
                try {
                    await adapter.waitUntilOpen(15000);
                } catch (e) {
                    console.error(`[LSP] ${e.message} for ${backendLang}`);
                    lspInitPendingRef.current.delete(backendLang);
                    try { lspChannel.close(); } catch (_) {}
                    setLspStatus('Channel Timeout');
                    return;
                }
            }
            console.log(`[LSP] Channel ready for ${backendLang}`);
            // Manual LSP Bridge: Force completion requests to the server
            // This bypasses monaco-languageclient's document selector issues
            // Register for every language in the selector so all file types get completions
            const triggerCharsMap = {
                cpp: ['.', '>', ':', '/', '"', '<'],
                c: ['.', '>', ':', '/', '"', '<'],
                rust: ['.', ':', '<'],
                python: ['.', '/'],
                typescript: ['.', '/', '"', "'", '`'],
                javascript: ['.', '/', '"', "'", '`'],
                java: ['.', '@'],
                go: ['.'],
                csharp: ['.', '<'],
                ruby: ['.', ':'],
                php: ['.', '>', ':', '$', '\\'],
                kotlin: ['.', ':'],
                zig: ['.', '@'],
                dart: ['.'],
                lua: ['.', ':'],
                elixir: ['.', '%', '@'],
                svelte: ['.', '/', '<', '"', "'"],
                css: [':', ';', ' '],
                scss: [':', ';', ' ', '$', '@'],
                less: [':', ';', ' ', '@'],
                html: ['<', '/', '"', "'", '='],
            };
            const defaultTriggers = ['.', '>', ':', '/', '"', '<'];
            // Track the AbortController for the previous in-flight completion
            // request so we can cancel it when a new one arrives — this stops
            // stale requests from piling up and generating $/cancelRequest spam.
            let _prevCompletionCancel = null;
            const bridgeDisposables = documentSelector.map(langId => {
                const triggers = triggerCharsMap[langId] || defaultTriggers;
                return monacoInstance.languages.registerCompletionItemProvider(langId, {
                    triggerCharacters: triggers,
                provideCompletionItems: async (model, position, context, token) => {
                    // Wait for client to be ready
                    if (!languageClient.isRunning()) {
                        return { suggestions: [] };
                    }

                    // Cancel any previous in-flight completion request
                    if (_prevCompletionCancel) {
                        _prevCompletionCancel.cancel();
                        _prevCompletionCancel = null;
                    }

                    // Create a cancellation source for this request
                    const cancellation = { cancelled: false, cancel() { this.cancelled = true; } };
                    _prevCompletionCancel = cancellation;

                    try {
                        // P1: Flush only pending incremental changes before completion.
                        // No full-document serialization — trust the incremental sync.
                        if (_didChangeTimer) {
                            clearTimeout(_didChangeTimer);
                            _didChangeTimer = null;
                        }
                        if (_pendingChanges.length > 0) {
                            languageClient.sendNotification('textDocument/didChange', {
                                textDocument: { uri: model.uri.toString(), version: model.getVersionId() },
                                contentChanges: _pendingChanges
                            });
                            _pendingChanges = [];
                        }

                        // Build LSP CompletionContext — servers use triggerKind
                        // to decide between full vs filtered suggestions.
                        // 1 = Invoked, 2 = TriggerCharacter, 3 = TriggerForIncompleteCompletions
                        let triggerKind = 1; // Invoked (manual / typing)
                        let triggerCharacter;
                        if (context.triggerKind === monacoInstance.languages.CompletionTriggerKind.TriggerCharacter) {
                            triggerKind = 2;
                            triggerCharacter = context.triggerCharacter;
                        }

                        const params = {
                            textDocument: { uri: model.uri.toString() },
                            position: { line: position.lineNumber - 1, character: position.column - 1 },
                            context: { triggerKind, ...(triggerCharacter ? { triggerCharacter } : {}) }
                        };
                        const result = await languageClient.sendRequest('textDocument/completion', params, token);

                        // If a newer request superseded us, discard this result
                        if (cancellation.cancelled) return { suggestions: [] };

                        if (!result) return { suggestions: [] };

                        const items = Array.isArray(result) ? result : (result.items || []);
                        const isIncomplete = !Array.isArray(result) && !!result.isIncomplete;

                        // Helper: convert an LSP Range to a Monaco IRange
                        const toMonacoRange = (r) => ({
                            startLineNumber: r.start.line + 1,
                            startColumn: r.start.character + 1,
                            endLineNumber: r.end.line + 1,
                            endColumn: r.end.character + 1
                        });

                        // Helper: LSP CompletionItemKind (1-based) → Monaco CompletionItemKind (0-based)
                        const mapKind = (k) => {
                            if (k === undefined || k === null) return monacoInstance.languages.CompletionItemKind.Text;
                            // LSP kinds 1..25 map to Monaco kinds 0..24
                            const mapped = k - 1;
                            return mapped >= 0 ? mapped : monacoInstance.languages.CompletionItemKind.Text;
                        };

                        // Helper: extract text from LSP MarkupContent | string
                        const docToString = (doc) => {
                            if (!doc) return undefined;
                            if (typeof doc === 'string') return doc;
                            if (doc.kind === 'markdown') return { value: doc.value };
                            return doc.value || undefined;
                        };

                        // Map LSP items to Monaco items
                        const suggestions = items.map((item, idx) => {
                            // LSP 3.17+ label can be { label, detail, description }
                            const labelText = typeof item.label === 'object' ? item.label.label : item.label;
                            const labelDetail = typeof item.label === 'object' ? item.label.detail : undefined;
                            const labelDescription = typeof item.label === 'object' ? item.label.description : undefined;

                            let insertText = item.insertText || labelText;
                            let insertTextRules = 0;
                            if (item.insertTextFormat === 2) {
                                insertTextRules = monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet;
                            }

                            let range = undefined;
                            if (item.textEdit) {
                                if (item.textEdit.range) {
                                    insertText = item.textEdit.newText;
                                    range = toMonacoRange(item.textEdit.range);
                                } else if (item.textEdit.insert && item.textEdit.replace) {
                                    insertText = item.textEdit.newText;
                                    range = {
                                        insert: toMonacoRange(item.textEdit.insert),
                                        replace: toMonacoRange(item.textEdit.replace)
                                    };
                                }
                            }

                            // Build additionalTextEdits (auto-imports, etc.)
                            let additionalTextEdits;
                            if (item.additionalTextEdits?.length) {
                                additionalTextEdits = item.additionalTextEdits.map(e => ({
                                    range: toMonacoRange(e.range),
                                    text: e.newText
                                }));
                            }

                            const suggestion = {
                                label: labelDetail
                                    ? { label: labelText, detail: labelDetail, description: labelDescription || item.detail }
                                    : labelText,
                                kind: mapKind(item.kind),
                                insertText,
                                insertTextRules,
                                range,
                                detail: item.detail,
                                documentation: docToString(item.documentation),
                                sortText: item.sortText || String(idx).padStart(5, '0'),
                                filterText: item.filterText || labelText,
                                preselect: item.preselect,
                                commitCharacters: item.commitCharacters,
                                additionalTextEdits,
                                // Stash the original LSP item for completionItem/resolve
                                _lspItem: item
                            };
                            return suggestion;
                        });

                        return {
                            suggestions,
                            incomplete: isIncomplete,
                        };
                    } catch (e) {
                        if (e?.code !== -32800) console.warn('[LSP-BRIDGE] Error:', e.message);
                        return { suggestions: [] };
                    }
                },
                resolveCompletionItem: async (item, token) => {
                    // Ask the LSP for full details (documentation, additional edits, etc.)
                    if (!languageClient.isRunning() || !item._lspItem) return item;
                    try {
                        const resolved = await languageClient.sendRequest(
                            'completionItem/resolve', item._lspItem, token
                        );
                        if (!resolved) return item;
                        if (resolved.documentation) {
                            const doc = resolved.documentation;
                            item.documentation = typeof doc === 'string'
                                ? doc
                                : (doc.kind === 'markdown' ? { value: doc.value } : (doc.value || undefined));
                        }
                        if (resolved.detail) item.detail = resolved.detail;
                        if (resolved.additionalTextEdits?.length) {
                            item.additionalTextEdits = resolved.additionalTextEdits.map(e => ({
                                range: {
                                    startLineNumber: e.range.start.line + 1,
                                    startColumn: e.range.start.character + 1,
                                    endLineNumber: e.range.end.line + 1,
                                    endColumn: e.range.end.character + 1
                                },
                                text: e.newText
                            }));
                        }
                    } catch (_) { /* resolve is best-effort */ }
                    return item;
                }
                });
            });


            // start() sends 'initialize' to the server and waits for a response.
            // The worker may be downloading the workspace, installing deps, and
            // spawning the language server — all of which can take a while.
            // Add a timeout so we don't hang the UI forever if the server is
            // missing or unreachable.
            setLspStatus(`Starting ${backendLang} server...`);
            const LSP_START_TIMEOUT = 60000; // 60s — Java/Gradle can be slow
            try {
                await Promise.race([
                    languageClient.start(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(
                            `Language server for ${backendLang} did not respond within ${LSP_START_TIMEOUT / 1000}s. ` +
                            `The server may not be installed on the worker.`
                        )), LSP_START_TIMEOUT)
                    )
                ]);
                console.log(`[LSP] Client started for ${backendLang}`);
            } catch (e) {
                console.error(`[LSP] Client start failed for ${backendLang}:`, e.message || e);
                lspInitPendingRef.current.delete(backendLang);
                try { languageClient.stop(); } catch (_) {}
                try { lspChannel.close(); } catch (_) {}
                setLspStatus(`${backendLang} server unavailable`);
                return;
            }

            // Disable Monaco's built-in validation for languages where we have an LSP,
            // to avoid double diagnostics and double work on every keystroke.
            try {
                if (['typescript', 'javascript'].includes(backendLang)) {
                    monacoInstance.languages.typescript?.typescriptDefaults?.setDiagnosticsOptions({
                        noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true
                    });
                    monacoInstance.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({
                        noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true
                    });
                } else if (backendLang === 'css') {
                    monacoInstance.languages.css?.cssDefaults?.setDiagnosticsOptions({ validate: false });
                    monacoInstance.languages.css?.scssDefaults?.setDiagnosticsOptions({ validate: false });
                    monacoInstance.languages.css?.lessDefaults?.setDiagnosticsOptions({ validate: false });
                } else if (backendLang === 'html') {
                    monacoInstance.languages.html?.htmlDefaults?.setOptions?.({ suggest: { html5: false } });
                }
            } catch (_) { /* language defaults may not exist */ }

            // Manually trigger didOpen to ensure the server knows about the file immediately
            setTimeout(() => {
                if (!languageClient.isRunning()) return;
                const m = editorInstance.getModel();
                if (!m) return;
                const textDocument = {
                    uri: m.uri.toString(),
                    languageId: m.getLanguageId(),
                    version: m.getVersionId(),
                    text: m.getValue()
                };
                console.log('[LSP] Manually sending didOpen for', textDocument.uri);
                languageClient.sendNotification('textDocument/didOpen', { textDocument });
            }, 500);

            // ── Multi-file didOpen blast ──────────────────────────
            // Send didOpen for ALL relevant workspace files so the LSP
            // can index cross-file symbols, resolve imports, and provide
            // Go-to-Definition across modules.
            //
            // Servers like gopls, rust-analyzer, and jdtls auto-index the
            // workspace from disk, so they don't strictly need this.  But
            // servers like typescript-language-server and pylsp rely on
            // didOpen to know about files.  We send content from the file
            // cache when available; for uncached files we read nothing here
            // — the worker already wrote them to disk during download, and
            // we send an empty string (servers that need content will fall
            // back to their disk watcher / rootUri scan).
            setTimeout(() => {
                if (!languageClient.isRunning()) return;

                // Build a fast lookup for cached content
                const cacheMap = new Map(fileCacheEntries || []);

                // Flatten the file tree into a list of file nodes
                const allFiles = [];
                const walk = (nodes) => {
                    if (!nodes) return;
                    for (const node of nodes) {
                        if (node.isFolder) {
                            // Skip heavy dependency / build directories
                            const name = node.name?.toLowerCase();
                            if (['node_modules', '.git', '__pycache__', 'target', 'build', 'dist',
                                 '.gradle', '.idea', 'bin', 'obj', '.dart_tool', '_build', 'deps',
                                 '.elixir_ls', '.jdtls-data', 'zig-cache', '.next', 'vendor',
                                 'zig-out', '.zig-cache', 'coverage', '.nyc_output'].includes(name)) continue;
                            walk(node.children);
                        } else if (node.path) {
                            allFiles.push(node);
                        }
                    }
                };
                walk(rawFiles);

                // Filter to files whose language is in this client's documentSelector
                const langSet = new Set(documentSelector);
                const activeUri = editorInstance.getModel()?.uri?.toString();
                // P2: Reduced blast — only open 20 most relevant files with 200ms delay
                // to prevent DataChannel saturation on init
                const MAX_BLAST_FILES = 20;
                const BATCH_SIZE = 5;
                const BATCH_DELAY_MS = 200;

                // Collect eligible files first
                const filesToOpen = [];
                for (const file of allFiles) {
                    if (filesToOpen.length >= MAX_BLAST_FILES) break;
                    const fileLang = getMonacoLanguage(file.name);
                    if (!langSet.has(fileLang)) continue;
                    const fileUri = `file:///synthi/${file.path}`;
                    if (fileUri === activeUri) continue;
                    // Only send files that have cached content — the LSP can
                    // discover files on disk itself; sending empty strings just
                    // wastes bandwidth and triggers unnecessary disk writes.
                    const content = cacheMap.get(file.path);
                    if (!content) continue;
                    filesToOpen.push({ uri: fileUri, lang: fileLang, content });
                }

                // Send in throttled batches to avoid overwhelming the LSP and
                // the WebRTC data channel with hundreds of messages at once.
                const sendBatch = (startIdx) => {
                    if (!languageClient.isRunning()) return;
                    const end = Math.min(startIdx + BATCH_SIZE, filesToOpen.length);
                    for (let i = startIdx; i < end; i++) {
                        const f = filesToOpen[i];
                        languageClient.sendNotification('textDocument/didOpen', {
                            textDocument: { uri: f.uri, languageId: f.lang, version: 1, text: f.content }
                        });
                    }
                    if (end < filesToOpen.length) {
                        setTimeout(() => sendBatch(end), BATCH_DELAY_MS);
                    }
                };
                if (filesToOpen.length > 0) sendBatch(0);
                console.log(`[LSP] Multi-file didOpen blast queued: ${filesToOpen.length} files for ${backendLang}`);
            }, 1500); // Wait a bit longer than the active-file didOpen

            // Manual Sync: Ensure server gets updates
            // P1: Incremental sync — send only changed ranges from Monaco events
            // instead of serializing the entire file with model.getValue().
            // Debounced at 100ms to coalesce rapid edits without adding latency.
            let _pendingChanges = [];
            let _didChangeTimer = null;
            const changeDisposable = editorInstance.onDidChangeModelContent((e) => {
                if (!languageClient.isRunning()) return;
                // Accumulate incremental changes from this event
                for (const change of e.changes) {
                    _pendingChanges.push({
                        range: {
                            start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
                            end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 }
                        },
                        rangeLength: change.rangeLength,
                        text: change.text
                    });
                }
                if (_didChangeTimer) clearTimeout(_didChangeTimer);
                _didChangeTimer = setTimeout(() => {
                    _didChangeTimer = null;
                    const currentModel = editorInstance.getModel();
                    if (!currentModel || _pendingChanges.length === 0) return;
                    languageClient.sendNotification('textDocument/didChange', {
                        textDocument: {
                            uri: currentModel.uri.toString(),
                            version: currentModel.getVersionId()
                        },
                        contentChanges: _pendingChanges
                    });
                    _pendingChanges = [];
                }, 100);
            });

            languageClientsRef.current.set(backendLang, languageClient);
            lspInitPendingRef.current.delete(backendLang);
            setLspStatus(`Ready (${backendLang})`);

            // Use addEventListener instead of setting onclose directly so
            // we don't overwrite MonacoSocketAdapter's own close handler.
            lspChannel.addEventListener('close', () => {
                console.log(`[LSP] Channel closed for ${backendLang}`);
                bridgeDisposables.forEach(d => d.dispose());
                changeDisposable.dispose();
                languageClient.stop();
                languageClientsRef.current.delete(backendLang);
                lspInitPendingRef.current.delete(backendLang);
                setLspStatus('Disconnected');
            });
        }).catch(e => {
            console.error(`[LSP] Init failed for ${backendLang}:`, e);
            lspInitPendingRef.current.delete(backendLang);
            try { lspChannel.close(); } catch (_) {}
        });

    }, [monacoInstance, compilerClient, compilerStatus, activeFile, editorInstance, servicesReady]);

    // Hook up Yjs-based collaboration when an editor and activeFile are present.
    useEffect(() => {
        if (!editorInstance || !monacoInstance || !activeFile || !slug || isPrivateMode) {
            // Clear collab connected state if dependencies are missing
            setCollabConnected(false);
            boundFilePathRef.current = null;
            return;
        }

        // CRITICAL: Wait for authenticated user id before opening Yjs docs.
        // Without this guard the collab binding can fire before setIdentity()
        // has been called on the singleton collabClient, causing legacy room
        // names (workspace:<slug>:<path>) that bypass per-user isolation.
        if (!authUserId) {
            console.debug('[Collab] Waiting for authenticated user id before binding');
            setCollabConnected(false);
            boundFilePathRef.current = null;
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
            boundFilePathRef.current = null;
            return;
        }

        // Verify the editor is still mounted and has a valid model before binding
        const model = editorInstance.getModel?.();
        if (!model) {
            console.warn('[Collab] Editor model not available, skipping collab binding');
            setCollabConnected(false);
            boundFilePathRef.current = null;
            return;
        }

        const user = (session?.data?.user) ? { id: session.data.user.id || session.data.user.email || session.data.user.name, name: session.data.user.name || session.data.user.email, email: session.data.user.email || null, image: session.data.user.image || null, isAnonymous: false } : { id: null, name: 'Anonymous', email: null, image: null, isAnonymous: true };

        // Attach the editor to the collaboration binding
        // IMPORTANT: Get content from file cache for THIS specific file path
        // Do NOT use `code` as it may still contain content from the previous file
        // during the transition between files.
        try {
            const showLineDecorations = (presenceGranularity === 'line');
            // Get content specifically for this file from the cache
            const cachedContent = fileCacheEntries.find(([path]) => path === activeFile.path)?.[1];
            const initialContent = typeof cachedContent === 'string' ? cachedContent : (typeof code === 'string' ? code : '');
            
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
            
            // CRITICAL: After the binding is established, the model content
            // may differ from Redux (e.g. Yjs has unsaved edits from a
            // previous session that were seeded via model.setValue, which
            // our isFlush guard intentionally skips).  Do a one-time sync
            // so Redux currentContent matches what the user sees.
            const modelContent = editorInstance.getModel()?.getValue() ?? '';
            if (modelContent && modelContent !== code) {
                dispatch(updateContent(modelContent));
            }
            
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
            // Critical: if binding failed, clear stale path guard so local edits
            // still propagate to Redux/save pipeline.
            boundFilePathRef.current = null;
        }

        return () => {
            try { collabBindingRef.current?._awarenessUnsub?.(); } catch (e) { /* ignore */ }
            try { collabBindingRef.current?.dispose(); } catch (e) { /* ignore */ }
            collabBindingRef.current = null;
            boundFilePathRef.current = null; // Clear bound file path
            setCollabConnected(false);
            setRemoteUnsaved(false);
        };
    }, [editorInstance, monacoInstance, activeFile, slug, session, authUserId, presenceGranularity, isPrivateMode, conflictedFiles]);

    // ── Ghost-revert fix ─────────────────────────────────────────────────
    // Listen for server-side 'file-reverted' events (emitted after discard,
    // pull, checkout, or any operation that changes files on disk).
    // When the active file was reverted:
    //   1. Tear down the Yjs binding so stale dirty content can't re-flush
    //   2. Re-fetch the clean content via selectFileThunk (which reads disk)
    //   3. Reset the Monaco model to the clean content
    // The collab binding effect above will re-run automatically because
    // selectFileThunk updates `activeFile` in Redux, triggering the
    // dependency array.
    useEffect(() => {
        const handler = async (ev) => {
            const { slug: evSlug, filePaths } = ev.detail || {};
            if (evSlug !== slug) return;

            const allFiles = !filePaths || filePaths.length === 0;
            const affectsActive = allFiles
                || (activeFile && filePaths.includes(activeFile.path));

            if (!affectsActive || !activeFile) return;

            console.log('[Editor] file-reverted received for', activeFile.path, '— resetting editor');

            // 1. Cancel any pending Redux sync timer (prevent stale content from being dispatched)
            if (reduxSyncTimerRef.current) {
                clearTimeout(reduxSyncTimerRef.current);
                reduxSyncTimerRef.current = null;
            }

            // 2. Tear down the local binding reference.
            //    Note: The Yjs doc/provider are already destroyed by
            //    collabClient.connectNotifications (which fires first and
            //    calls destroyDocument/destroyAllForSlug).  We only need
            //    to clear the local ref + awareness subscription.
            try { collabBindingRef.current?._awarenessUnsub?.(); } catch (_) {}
            try { collabBindingRef.current?.dispose(); } catch (_) {}
            collabBindingRef.current = null;

            // 3. Close diff view if open — reverted content invalidates it
            if (diffMode) {
                dispatch(setDiffMode(false));
            }

            // 3b. Clear stale saved-content baselines so selectFileThunk
            //     doesn't re-apply the old savedContent from _savedContentByPath.
            //     Without this, the tab would still show an unsaved dot after revert.
            dispatch(clearSavedBaselines(
                allFiles ? { all: true } : { paths: filePaths }
            ));

            // 4. Re-select the file — this fetches clean content from the
            //    server and updates Redux (savedContent, currentContent).
            //    It also triggers the collab binding effect to re-run, which
            //    will create a fresh Yjs provider seeded from disk content.
            await dispatch(selectFileThunk(activeFile));

            // 5. Force-set the Monaco model to the clean content so the editor
            //    doesn't flash stale text before the binding kicks in.
            try {
                const model = editorInstance?.getModel?.();
                if (model) {
                    const cleanContent = model.getValue();
                    latestCodeRef.current = cleanContent;
                }
            } catch (_) {}
        };

        window.addEventListener('synthi:file-reverted', handler);
        return () => window.removeEventListener('synthi:file-reverted', handler);
    }, [slug, activeFile, editorInstance, dispatch, diffMode]);

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
            // P0: Flush pending Redux sync on unmount so content isn't lost
            if (reduxSyncTimerRef.current) {
                clearTimeout(reduxSyncTimerRef.current);
                reduxSyncTimerRef.current = null;
                dispatch(updateContent(latestCodeRef.current));
            }
            // P0: Cancel pending marker clear
            if (markerClearTimerRef.current) {
                cancelAnimationFrame(markerClearTimerRef.current);
                markerClearTimerRef.current = null;
            }
        };
    }, [dispatch]);

    const handleCodeChange = useCallback((newCode) => {

        // CRITICAL: Only process changes if we're bound to the correct file
        // This prevents stale onChange handlers from writing content to the wrong file
        // during file transitions.
        if (activeFile && collabConnected && boundFilePathRef.current && boundFilePathRef.current !== activeFile.path) {
            console.warn('[Editor] Skipping — boundFilePathRef mismatch:', boundFilePathRef.current, '!==', activeFile.path);
            return;
        }
        
        // Always track latest content for flush-on-unmount and save
        latestCodeRef.current = newCode;

        // Check if collab is applying remote changes
        const remoteApplying = !!collabBindingRef.current?.isApplyingRemote?.();


        // P0: ALWAYS dispatch to Redux regardless of isApplyingRemote.
        // The unsaved indicator, save flow, and tab dot all depend on Redux
        // currentContent being up-to-date.  The value prop → setValue feedback
        // loop that isApplyingRemote was guarding against is NOT triggered by
        // Redux updates — the Editor does NOT call editor.setValue() from
        // currentContent.  The only feedback path was Yjs → executeEdits →
        // onChange → Yjs, which is already guarded by _applyingRemote inside
        // MonacoTextBinding._modelListener.
        if (reduxSyncTimerRef.current) clearTimeout(reduxSyncTimerRef.current);
        reduxSyncTimerRef.current = setTimeout(() => {
            reduxSyncTimerRef.current = null;
            dispatch(updateContent(latestCodeRef.current));
        }, 150);

        // Skip AI auto-complete and active completion cancel for remote changes
        // — these should only fire on local user edits
        if (remoteApplying) return;

        cancelActiveCompletion({ resetSuggestion: true, reason: 'edit' });

        // Debounce AI Auto-Complete (The "Cursor" experience)
        if (aiDebounceTimerRef.current) clearTimeout(aiDebounceTimerRef.current);
        if (!aiAutoEnabled) return;
        aiDebounceTimerRef.current = setTimeout(() => {
            if (!activeDiffCheck()) {
                requestAiCompletion(true, latestCodeRef.current, { reason: 'pause', pauseTrigger: true, recentEditSnippet: takeLastChars(latestCodeRef.current, 512) });
            }
        }, 900);
    }, [activeFile, aiAutoEnabled, activeDiffCheck, cancelActiveCompletion, dispatch, requestAiCompletion, collabConnected]);

    // Keep a ref to the latest handleCodeChange to avoid stale closures in the editor onMount listener
    const handleCodeChangeRef = useRef(handleCodeChange);
    useEffect(() => {
        handleCodeChangeRef.current = handleCodeChange;
    }, [handleCodeChange]);

    const handleSave = useCallback(() => {
        // P0: Flush pending Redux debounce before save so latest content is in state.
        // dispatch(updateContent(...)) is synchronous in Redux — the store is
        // updated immediately.  However, the React component has NOT re-rendered
        // yet, so closure values like `isUnsaved` are stale.  Therefore we must
        // NOT rely on the closure `isUnsaved` to gate the save — instead, always
        // dispatch saveFileContentThunk which reads live state via getState().
        if (reduxSyncTimerRef.current) {
            clearTimeout(reduxSyncTimerRef.current);
            reduxSyncTimerRef.current = null;
            dispatch(updateContent(latestCodeRef.current));
        }
        if (activeFile) {
            // Always dispatch — the thunk uses getState() to read the latest
            // currentContent vs savedContent and skips the network call when
            // content is already saved.  This avoids the race where the closure
            // `isUnsaved` is stale (false) because the debounced updateContent
            // just ran but React hasn't re-rendered yet.
            dispatch(saveFileContentThunk());
        }
        // ── Push saved content to worker disk via file-sync channel ──
        // This ensures the worker's filesystem (used by the LSP server for
        // cross-file indexing) always has the latest content.
        if (activeFile?.path && compilerClient) {
            try {
                compilerClient.syncFile(activeFile.path, latestCodeRef.current ?? code);
            } catch (_) { /* best-effort */ }
        }
        // Trigger HMR/Compilation on save
        if (onSave) onSave();
    }, [activeFile, dispatch, onSave, compilerClient, code, slug]);

    // Auto-save mode: persist edits after a short idle period.
    // Flush the pending Redux debounce first (same as handleSave does for
    // Ctrl+S) so saveFileContentThunk reads the absolute latest content.
    useEffect(() => {
        if (!autoSaveEnabled || !activeFile) return;
        const normalizeTrailing = (s) => (typeof s === 'string' ? s.replace(/[\r\n]+$/, '') : '');
        if (normalizeTrailing(code) === normalizeTrailing(savedContent)) return;
        const timer = setTimeout(() => {
            // Flush any pending Redux debounce so the thunk reads latest content
            if (reduxSyncTimerRef.current) {
                clearTimeout(reduxSyncTimerRef.current);
                reduxSyncTimerRef.current = null;
                dispatch(updateContent(latestCodeRef.current));
            }
            dispatch(saveFileContentThunk()).then(() => {
                // Force git status refresh after autosave — the normal
                // fetchGitStatus inside saveFileContentThunk may be
                // deduplicated by the _statusFetching guard.  This explicit
                // delayed dispatch ensures Source Control updates.
                setTimeout(() => dispatch(fetchGitStatus(slug)), 200);
            });
        }, 900);
        return () => clearTimeout(timer);
    }, [autoSaveEnabled, activeFile, dispatch, code, savedContent, slug]);

    // Latch diffModeEverActive so the DiffEditor stays mounted (hidden) once
    // the user first opens it — avoids React passive-unmount crash.
    useEffect(() => {
        if (diffMode) setDiffModeEverActive(true);
    }, [diffMode]);

    // Git status refresh — in manual-save mode, status updates after explicit save.
    // In auto-save mode, status updates after each debounced autosave write.
    // Git status is refreshed:
    //  1. On explicit save (Ctrl/Cmd+S)
    //  2. On debounced autosave when enabled
    //  2. Via the 5-second poll (existing setInterval in the workspace page)
    //  3. When the server broadcasts git-status-changed (after explicit flush)

    // ── Direct disk-write fallback (REMOVED) ───────────────────────────────
    // Previously, this effect wrote content via HTTP (syncFileToGit) on a 1.5s
    // debounce on EVERY keystroke, regardless of the autosave setting.  This
    // meant changes were persisted to disk/GCS even when the user expected
    // "editor-only" (unsaved) behavior.
    //
    // Content is now ONLY written to disk on explicit save (Ctrl+S / the save
    // button) via handleSave → saveFileContentThunk.  The Yjs auto-flush still
    // keeps the CRDT document in memory for real-time collab, but disk/GCS
    // persistence is controlled separately (see server-side _setupAutoFlush).

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
            // Escape: close diff view
            if (e.key === 'Escape' && diffMode) {
                e.preventDefault();
                dispatch(setDiffMode(false));
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
    }, [handleSave, editorInstance, requestAiCompletion, cancelActiveCompletion, dispatch, activeFile, aiCompletionState, applyAiCompletionText, diffMode]);

    // Ensure disabling auto AI clears any pending/computed suggestions
    useEffect(() => {
        if (aiAutoEnabled) return;
        cancelActiveCompletion({ resetSuggestion: true, reason: 'auto-disabled' });
        if (aiDebounceTimerRef.current) clearTimeout(aiDebounceTimerRef.current);
    }, [aiAutoEnabled, cancelActiveCompletion]);

    // Handle updates from analysis (Markers)
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        const applyNonAiMarkers = () => {
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
        
        console.log(`[Editor] Filtering diagnostics for "${currentFilePath}": ${proactiveDiagnostics.length} total -> ${currentFileDiagnostics.length} for current file`);
        
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
        };

        // Apply immediately on diagnostics/model change.
        applyNonAiMarkers();

        // Also re-apply after any model content change.
        // Collab/Yjs rebinds can trigger a content event that clears markers;
        // snapshot gating keeps this safe (real edits will yield empty markers).
        const disposable = editorInstance.onDidChangeModelContent(() => {
            // Defer to allow any immediate clear() calls to run first.
            requestAnimationFrame(() => applyNonAiMarkers());
        });

        return () => {
            try { disposable?.dispose?.(); } catch (_) {}
        };
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

    // Suppress built-in Monaco language service markers (TS/JS/CSS/HTML/JSON) that can
    // double-up with real LSP diagnostics.  We use a **blocklist** of known built-in
    // owners — everything else (including LSP client markers) is preserved.
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        const model = editorInstance.getModel?.();
        if (!model) return;

        // Monaco's built-in language service owners that we already disable via
        // setDiagnosticsOptions — prune any stragglers that sneak through.
        const builtInOwners = new Set([
            'typescript', 'javascript', 'css', 'json', 'html',
            'css-lint', 'scss-lint', 'less-lint',
            'json-schema', 'html-lint',
            // Legacy Synthi owner that can keep stale markers alive
            'synthi-proactive',
        ]);

        const prune = () => {
            if (markerPruneInProgressRef.current) return;
            markerPruneInProgressRef.current = true;
            try {
                const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri }) || [];
                const ownersToClear = new Set();
                for (const m of markers) {
                    if (m && m.owner && builtInOwners.has(m.owner)) ownersToClear.add(m.owner);
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

    // P0: Marker clearing on tab switch only — per-keystroke clearing is handled
    // by the consolidated onDidChangeModelContent listener in onMount (debounced via rAF).
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        // Clear Synthi markers once on tab switch; LSP markers are left intact.
        try {
            const model = editorInstance.getModel?.();
            if (model) {
                const owners = new Set([
                    'synthi-analysis', 'synthi-proactive', 'synthi-ai', 'extension',
                ]);
                const tracked = monacoInstance.__synthiMarkerOwners;
                if (tracked && typeof tracked.forEach === 'function') {
                    tracked.forEach((o) => owners.add(o));
                }
                owners.forEach((owner) => {
                    try { monacoInstance.editor.setModelMarkers(model, owner, []); } catch (_) {}
                });
            }
        } catch (_) {}
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
                                                        e.dataTransfer?.setData('text/workspace-path', file.path);
                                                        e.dataTransfer?.setData('text/plain', file.name);
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

                                                    {/* VSCode-style: unsaved dot and close button share the same slot.
                                                        • When unsaved & not hovered → coral dot visible
                                                        • When hovered (regardless of state) → close ✕ visible
                                                        • When saved & not hovered → empty (reserving space) */}
                                                    <div className="ml-auto w-5 h-5 flex-shrink-0 flex items-center justify-center relative">
                                                        {/* Unsaved dot — hidden on group hover so the close ✕ takes over.
                                                            When autosave is ON, suppress the dot entirely to avoid
                                                            a brief flicker between the edit and the autosave debounce. */}
                                                        {!autoSaveEnabled && ((file.isUnsaved || (isActive && isUnsaved)) || (isActive && remoteUnsaved)) && (
                                                            <Circle
                                                                className="w-2.5 h-2.5 fill-[#ff6b6b] text-[#ff6b6b] drop-shadow-[0_0_4px_rgba(255,107,107,0.6)] group-hover:hidden"
                                                            />
                                                        )}
                                                        {/* Close button — always in DOM for hover, hidden until group hover */}
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); dispatch(closeFile(file.path)); }}
                                                            className={`absolute inset-0 items-center justify-center rounded-full transition-all duration-150 hidden group-hover:flex ${isActive ? 'text-[#f4f5f8]/80 hover:text-[#f4f5f8] hover:bg-[#3a857430]' : 'text-[#5a6178] hover:text-[#f4f5f8] hover:bg-[#1a1b24]'}`}
                                                            aria-label={`Close ${file.name}`}
                                                        >
                                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="pointer-events-none">
                                                                <path d="M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                                <path d="M6 6L18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                            </svg>
                                                        </button>
                                                    </div>
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

                        {/* Merge Conflict Resolver — replaces editor when active */}
                        {conflictResolverFile ? (
                            <div className="flex-1 overflow-hidden relative">
                                <MergeConflictEditor
                                    slug={slug}
                                    filePath={conflictResolverFile}
                                    onClose={() => dispatch(closeConflictResolver())}
                                    onResolved={() => {
                                        dispatch(closeConflictResolver());
                                        dispatch(fetchGitStatus(slug));
                                        toast.success('Conflict resolved');
                                    }}
                                />
                            </div>
                        ) : (
                        <>
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
                                        {/* DiffEditor — kept mounted (display:none) once activated
                                            to prevent React unmount crash in
                                            recursivelyTraversePassiveUnmountEffects.
                                            Monaco DiffEditor's internal useEffect cleanup can throw
                                            during React passive unmount; keeping it in the DOM and
                                            hiding via CSS avoids the disposal race entirely. */}
                                        {diffModeEverActive && (
                                            <div className="h-full w-full relative flex flex-col" style={{ display: diffMode ? 'flex' : 'none' }}>
                                                {/* Diff view header with close button */}
                                                <div className="flex items-center justify-between px-3 py-1 bg-[#0d0e14] border-b border-[#1e1f2e] text-xs shrink-0 select-none" style={{ height: 32 }}>
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <span className="text-[#e8eaf0] font-medium truncate">{activeFile?.name || 'Unknown'}</span>
                                                        <span className="text-[#4d5168]">•</span>
                                                        <span className="text-[#7c80a0] whitespace-nowrap">Working Copy ↔ HEAD</span>
                                                    </div>
                                                    <button
                                                        onClick={() => dispatch(setDiffMode(false))}
                                                        className="flex items-center justify-center w-6 h-6 rounded hover:bg-[#1e1f2e] text-[#7c80a0] hover:text-[#e8eaf0] transition-colors shrink-0"
                                                        title="Close diff view (Esc)"
                                                        aria-label="Close diff view"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                                <div className="flex-1 min-h-0">
                                                    <DiffEditor
                                                        height="100%"
                                                        original={diffMode ? (originalContent || '') : ''}
                                                        modified={diffMode ? (code ?? '') : ''}
                                                        language={activeLanguage}
                                                        theme="synthi-theme"
                                                        options={{
                                                            ...EDITOR_OPTIONS,
                                                            readOnly: true,
                                                            renderSideBySide: true
                                                        }}
                                                        beforeMount={(monaco) => {
                                                            monaco.editor.defineTheme('synthi-theme', SYNTHI_THEME);
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                        {/* Regular Editor — hidden when diff is active */}
                                        <div className="h-full w-full" style={{ display: diffMode ? 'none' : undefined }}>
                                            <Editor
                                                key={activeFileIdentity}
                                                height="100%"
                                                path={activeFile ? `/synthi/${activeFile.path.startsWith('/') ? activeFile.path.slice(1) : activeFile.path}` : undefined}
                                                // Use defaultValue for initial content to prevent cursor jumping issues during typing.
                                                // The key={activeFileIdentity} ensures component remounts on file switch.
                                                defaultValue={code ?? ''}
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
                                                    
                                                    // P0: CONSOLIDATED onDidChangeModelContent listener.
                                                    // Instead of 5 separate listeners each doing work on
                                                    // every keystroke, this single listener:
                                                    //  (a) Debounces marker clearing (200ms) via rAF — unblocks main thread
                                                    //  (b) Updates the latestCodeRef immediately (cheap ref write)
                                                    //  (c) Syncs to Redux on 300ms debounce pause (not every frame)
                                                    //  (d) Triggers AI debounce via handleCodeChangeRef
                                                    // No model.getValue() on every keystroke — only when flushing.
                                                    editor.onDidChangeModelContent((e) => {
                                                        // CRITICAL: Skip model.setValue() calls (isFlush=true).
                                                        // These come from Yjs seeding / doSeed() sync handler
                                                        // and should NOT propagate to Redux via handleCodeChange,
                                                        // because they carry server/CRDT content that may reset
                                                        // isUnsaved to false.  The Yjs binding uses
                                                        // editor.executeEdits() (which does NOT set isFlush) for
                                                        // its _yObserver path, so real remote edits still flow
                                                        // through.  User edits (typing) also don't set isFlush.
                                                        if (e.isFlush) return;
                                                        // (a) P0: Debounce marker clearing — NOT synchronous.
                                                        // Markers are for stale diagnostic snapshots; 200ms delay is fine.
                                                        if (!markerClearTimerRef.current) {
                                                            markerClearTimerRef.current = requestAnimationFrame(() => {
                                                                markerClearTimerRef.current = null;
                                                                try {
                                                                    const model = editor.getModel?.();
                                                                    if (model) {
                                                                        const owners = new Set([
                                                                            'synthi-analysis',
                                                                            'synthi-proactive',
                                                                            'synthi-ai',
                                                                            'extension',
                                                                        ]);
                                                                        const tracked = monaco.__synthiMarkerOwners;
                                                                        if (tracked && typeof tracked.forEach === 'function') {
                                                                            tracked.forEach((o) => owners.add(o));
                                                                        }
                                                                        owners.forEach((owner) => {
                                                                            try { monaco.editor.setModelMarkers(model, owner, []); } catch (_) {}
                                                                        });
                                                                    }
                                                                } catch (_) {}
                                                            });
                                                        }

                                                        // (b) + (c) P0: Defer model.getValue() to the debounced flush.
                                                        // Only read the full content when we're actually going to use it.
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
                                        </div>
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
                        </>
                        )}
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
