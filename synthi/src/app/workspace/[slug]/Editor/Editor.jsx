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
import { initSynthiFileSystem, updateFile as updateVirtualFile, disposeSynthiFileSystem } from './SynthiFileSystemProvider';
import * as monaco from '@codingame/monaco-vscode-editor-api';
import { toast } from 'sonner';

const CloseAction = {
    DoNotRestart: 1,
    Restart: 2,
};

const ErrorAction = {
    Continue: 1,
    Shutdown: 2,
};

// ── Language registration for @codingame/monaco-vscode-api ──────────
// The vscode-api layer doesn't know about languages like Java, Go, Rust, etc.
// unless a vscode extension is registered for them.  Without this, models
// created from file URIs default to 'plaintext', breaking documentSelector
// matching and LSP provider activation.
const SUPPORTED_LANGUAGES = [
    { id: 'java', extensions: ['.java'], aliases: ['Java'] },
    { id: 'python', extensions: ['.py', '.pyw', '.pyx'], aliases: ['Python'] },
    { id: 'go', extensions: ['.go'], aliases: ['Go'] },
    { id: 'rust', extensions: ['.rs'], aliases: ['Rust'] },
    { id: 'cpp', extensions: ['.cpp', '.cc', '.cxx', '.hpp'], aliases: ['C++'] },
    { id: 'c', extensions: ['.c', '.h'], aliases: ['C'] },
    { id: 'csharp', extensions: ['.cs'], aliases: ['C#'] },
    { id: 'kotlin', extensions: ['.kt', '.kts'], aliases: ['Kotlin'] },
    { id: 'dart', extensions: ['.dart'], aliases: ['Dart'] },
    { id: 'zig', extensions: ['.zig'], aliases: ['Zig'] },
    { id: 'lua', extensions: ['.lua'], aliases: ['Lua'] },
    { id: 'elixir', extensions: ['.ex', '.exs'], aliases: ['Elixir'] },
    { id: 'svelte', extensions: ['.svelte'], aliases: ['Svelte'] },
    { id: 'swift', extensions: ['.swift'], aliases: ['Swift'] },
    { id: 'scala', extensions: ['.scala', '.sc'], aliases: ['Scala'] },
    { id: 'ruby', extensions: ['.rb'], aliases: ['Ruby'] },
    { id: 'php', extensions: ['.php'], aliases: ['PHP'] },
    { id: 'haskell', extensions: ['.hs'], aliases: ['Haskell'] },
];

// Build a reverse map: language id → glob patterns for documentSelector fallback
const LANG_TO_GLOB = {};
for (const lang of SUPPORTED_LANGUAGES) {
    LANG_TO_GLOB[lang.id] = lang.extensions.map(ext => `**/*${ext}`);
}
// Also add built-in languages that Monaco already knows about
LANG_TO_GLOB['javascript'] = ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'];
LANG_TO_GLOB['typescript'] = ['**/*.ts', '**/*.tsx'];
LANG_TO_GLOB['html'] = ['**/*.html', '**/*.htm'];
LANG_TO_GLOB['css'] = ['**/*.css'];
LANG_TO_GLOB['scss'] = ['**/*.scss', '**/*.sass'];
LANG_TO_GLOB['less'] = ['**/*.less'];
LANG_TO_GLOB['json'] = ['**/*.json'];

/** Register all supported languages with Monaco/vscode-api */
function registerSupportedLanguages() {
    for (const lang of SUPPORTED_LANGUAGES) {
        try { monaco.languages.register(lang); } catch (_) {}
    }
    console.log('[LSP] Registered', SUPPORTED_LANGUAGES.length, 'languages with Monaco');
}

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
    const lspInitPendingRef = useRef(new Set()); // Guard against concurrent init for same language
    // Track the previously-opened file URI per language client so we can send didClose on file switch
    const lspOpenedUrisRef = useRef(new Map()); // Map<backendLang, { uri, languageId }>
    // Track textDocumentSync capability reported by each language server
    const lspSyncCapRef = useRef(new Map()); // Map<backendLang, number> (1=Full, 2=Incremental)

    // Initialize Monaco Services ONCE — uses a module-level promise so that
    // concurrent callers (StrictMode double-fire, fast remounts) all wait for
    // the *real* initialization instead of treating a no-op start() as success.
    useEffect(() => {
        if (servicesInitialized) {
            setServicesReady(true);
            return;
        }

        if (!servicesInitPromise) {
            servicesInitPromise = (async () => {
                const { MonacoVscodeApiWrapper } = await import('monaco-languageclient/vscodeApiWrapper');

                // Attempt to start the wrapper. On HMR reloads the underlying
                // @codingame/monaco-vscode-api will throw "Services are already
                // initialized" because its internal flag persists across module
                // re-evaluations.  Catch that specific error and treat as success.
                try {
                    // Provide a real MarkdownRendererService implementation
                    // via serviceOverrides so the @Unsupported stub from
                    // missing-services.js is never used. This prevents the
                    // "setDefaultCodeBlockRenderer is not supported" error
                    // that fires when StandaloneCodeEditor's constructor
                    // accesses the service.
                    const { SyncDescriptor } = await import(
                        '@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors'
                    );
                    const { MarkdownRendererService } = await import(
                        '@codingame/monaco-vscode-api/vscode/vs/platform/markdown/browser/markdownRenderer'
                    );

                    const wrapper = new MonacoVscodeApiWrapper({
                        $type: 'classic',
                        viewsConfig: {
                            $type: 'EditorService'
                        },
                        monacoWorkerFactory: configureClassicWorkerFactory,
                        serviceOverrides: {
                            // Key must match createDecorator('markdownRendererService')
                            markdownRendererService: new SyncDescriptor(MarkdownRendererService),
                        },
                    });
                    await wrapper.start();
                } catch (e) {
                    if (e?.message?.includes('already initialized')) {
                        console.warn('[LSP] Services already initialized (HMR), continuing…');
                    } else {
                        throw e;
                    }
                }

                // Register all supported languages so the vscode-api layer
                // correctly auto-detects language from file URIs (e.g. .java → java)
                // and setModelLanguage() actually works.
                registerSupportedLanguages();

                servicesInitialized = true;
                console.log('[LSP] Monaco Services Initialized');
            })();
        }

        servicesInitPromise
            .then(() => setServicesReady(true))
            .catch(e => console.error('Failed to initialize monaco-vscode-api', e));

        return () => {
            // Tear down virtual FS on full unmount
            disposeSynthiFileSystem();
        };
    }, []);

    // ── Virtual filesystem overlay ──────────────────────────────
    // Populate the in-memory file system that backs file:///synthi/ URIs.
    // This allows Monaco's FileService (go-to-definition, workspace symbols,
    // etc.) to resolve files that only exist on the remote worker.
    useEffect(() => {
        if (!servicesReady) return;
        initSynthiFileSystem(fileCacheEntries, rawFiles).catch(e =>
            console.warn('[SynthiFS] Failed to init virtual filesystem:', e)
        );
    }, [servicesReady, fileCacheEntries, rawFiles]);

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
                console.log(`[LSP] Reusing existing ${backendLang} client`);

                // P0: The editor remounted with a new model (key={activeFileIdentity}).
                // @codingame/monaco-vscode-api creates the model with 'plaintext',
                // so the documentSelector won't match and auto-didOpen won't fire.
                // Fix the model language and manually send didOpen for the new file.
                const model = editorInstance.getModel();
                if (model) {
                    // Correct model language
                    if (lang && lang !== 'plaintext' && model.getLanguageId() !== lang) {
                        console.log(`[LSP] Reuse: correcting model language: ${model.getLanguageId()} → ${lang}`);
                        monacoInstance.editor.setModelLanguage(model, lang);
                    }

                    const fileUri = model.uri.toString();
                    const prev = lspOpenedUrisRef.current.get(backendLang);

                    // Only send didClose/didOpen if the file actually changed,
                    // or if we never tracked an open URI for this language yet.
                    if (!prev || prev.uri !== fileUri) {
                        // Send didClose for the previously-opened file so the server
                        // doesn't reject the new didOpen as a duplicate.
                        if (prev) {
                            try {
                                client.sendNotification('textDocument/didClose', {
                                    textDocument: { uri: prev.uri }
                                });
                                console.log(`[LSP] Reuse: sent didClose for previous file ${prev.uri}`);
                            } catch (_) {}
                        }

                        // Send didOpen for the new file so the LSP knows about it
                        try {
                            client.sendNotification('textDocument/didOpen', {
                                textDocument: {
                                    uri: fileUri,
                                    languageId: lang,
                                    version: model.getVersionId?.() ?? 1,
                                    text: model.getValue(),
                                }
                            });
                            lspOpenedUrisRef.current.set(backendLang, { uri: fileUri, languageId: lang });
                            console.log(`[LSP] Reuse: sent manual didOpen for ${fileUri}`);
                        } catch (e) {
                            console.warn(`[LSP] Reuse: manual didOpen failed:`, e.message);
                        }
                    }
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

            // Track whether auto-didOpen fired for the active file so we
            // can send a manual fallback if @codingame/monaco-vscode-api's
            // TextDocument wrapper cached a stale languageId.
            const autoDidOpenUris = new Set();

            // Build a robust documentSelector that matches BOTH by language
            // AND by file pattern.  This is critical because @codingame/monaco-
            // vscode-api may assign 'plaintext' to models whose language isn't
            // registered — the pattern fallback ensures the LSP bridge still
            // activates completion/hover/diagnostics for those files.
            const fullDocumentSelector = [
                ...documentSelector.map(l => ({ language: l, scheme: 'file' })),
                ...documentSelector.flatMap(l =>
                    (LANG_TO_GLOB[l] || []).map(pattern => ({ scheme: 'file', pattern }))
                ),
            ];

            const languageClient = new SynthiLanguageClient({
                name: `Synthi Language Client (${backendLang})`,
                clientOptions: {
                    documentSelector: fullDocumentSelector,
                    middleware: {
                        // P0: Let monaco-languageclient handle the full document lifecycle
                        // natively — didOpen, didChange, didClose, didSave are all passed
                        // through to the server via next().  This enables hover, definition,
                        // references, rename, code actions, and signature help.
                        didOpen: (data, next) => {
                            console.log('[LSP] middleware didOpen', data.textDocument?.uri);
                            autoDidOpenUris.add(data.textDocument?.uri);
                            return next(data);
                        },
                        didChange: (data, next) => {
                            return next(data);
                        },
                        didClose: (data, next) => {
                            console.log('[LSP] middleware didClose', data.textDocument?.uri);
                            return next(data);
                        },
                        didSave: (data, next) => {
                            console.log('[LSP] middleware didSave', data.textDocument?.uri);
                            return next(data);
                        },
                        // P0: Let monaco-languageclient's built-in bridge handle completions
                        // for better isIncomplete handling and fewer edge cases.
                        provideCompletionItem: (document, position, context, token, next) => {
                            return next(document, position, context, token);
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

            // P0: Ensure the model language matches the backendLang before the
            // client starts.  When @codingame/monaco-vscode-api is active the
            // model may have been created with 'plaintext' (see onMount fix).
            // The MonacoLanguageClient's documentSelector needs the correct
            // languageId to send didOpen and route diagnostics.
            if (currentModel.getLanguageId() !== lang) {
                console.log(`[LSP] Correcting model language before client start: ${currentModel.getLanguageId()} → ${lang}`);
                monacoInstance.editor.setModelLanguage(currentModel, lang);
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
            // Completions are handled entirely by monaco-languageclient's built-in
            // provider (activated by the middleware passthrough).  No manual bridge
            // needed — having both caused duplicate textDocument/completion requests
            // and "Unmatched cancel notification" spam from the server.
            const bridgeDisposables = [];


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

            // ── Fallback didOpen for the active file ────────────────
            // monaco-languageclient auto-sends didOpen for matching models
            // after start().  However, when @codingame/monaco-vscode-api is
            // active the internal TextDocument wrapper may have cached the
            // old 'plaintext' languageId at model-creation time, causing the
            // documentSelector to miss the file even after setModelLanguage.
            // Detect this and send a manual didOpen as a safety net.
            {
                const activeUri = currentModel.uri.toString();
                if (!autoDidOpenUris.has(activeUri)) {
                    const content = currentModel.getValue();
                    console.log(`[LSP] Auto-didOpen missed for active file, sending manual didOpen: ${activeUri} (lang: ${lang})`);
                    try {
                        languageClient.sendNotification('textDocument/didOpen', {
                            textDocument: {
                                uri: activeUri,
                                languageId: lang,
                                version: currentModel.getVersionId?.() ?? 1,
                                text: content,
                            }
                        });
                    } catch (e) {
                        console.warn('[LSP] Manual didOpen failed:', e.message);
                    }
                }
                // Track the URI so the reuse path can send didClose on file switch
                lspOpenedUrisRef.current.set(backendLang, { uri: activeUri, languageId: lang });
            }

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
            }, 800); // Give the server time to finish initialize before blast

            // P1: Since middleware now passes didChange through to next(), monaco-languageclient
            // handles sync natively and will respect the server's textDocumentSync capability.
            // No manual onDidChangeModelContent handler needed — avoids double-sending.
            // We keep a no-op disposable for the cleanup in the close handler.
            const changeDisposable = { dispose: () => {} };

            languageClientsRef.current.set(backendLang, languageClient);
            lspInitPendingRef.current.delete(backendLang);
            setLspStatus(`Ready (${backendLang})`);

            // Use addEventListener instead of setting onclose directly so
            // we don't overwrite MonacoSocketAdapter's own close handler.
            lspChannel.addEventListener('close', async () => {
                console.log(`[LSP] Channel closed for ${backendLang}`);
                bridgeDisposables.forEach(d => d.dispose());
                changeDisposable.dispose();

                // P2: Send shutdown→exit for a clean server shutdown
                if (languageClient.isRunning()) {
                    try {
                        console.log(`[LSP] Sending shutdown request for ${backendLang}`);
                        await Promise.race([
                            languageClient.sendRequest('shutdown'),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('shutdown timeout')), 3000))
                        ]);
                        languageClient.sendNotification('exit');
                        console.log(`[LSP] Sent exit notification for ${backendLang}`);
                    } catch (e) {
                        console.warn(`[LSP] Clean shutdown failed for ${backendLang}:`, e.message);
                    }
                }

                languageClient.stop();
                languageClientsRef.current.delete(backendLang);
                lspInitPendingRef.current.delete(backendLang);
                lspOpenedUrisRef.current.delete(backendLang);
                lspSyncCapRef.current.delete(backendLang);
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
            // P2: Send shutdown→exit for clean server shutdown before stopping
            languageClientsRef.current.forEach(async (client, lang) => {
                if (client.isRunning()) {
                    try {
                        await Promise.race([
                            client.sendRequest('shutdown'),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))
                        ]);
                        client.sendNotification('exit');
                    } catch (_) { /* best-effort */ }
                }
                client.stop();
            });
            languageClientsRef.current.clear();
            lspOpenedUrisRef.current.clear();
            lspSyncCapRef.current.clear();
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

        // P0: Debounce Redux sync — only dispatch to Redux after 300ms pause.
        // Monaco holds the source of truth; Redux only needs eventual consistency
        // for save, tab bar, file explorer, etc.
        if (reduxSyncTimerRef.current) clearTimeout(reduxSyncTimerRef.current);
        reduxSyncTimerRef.current = setTimeout(() => {
            reduxSyncTimerRef.current = null;
            dispatch(updateContent(latestCodeRef.current));
        }, 300);

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
        // P0: Flush pending Redux debounce before save so latest content is in state
        if (reduxSyncTimerRef.current) {
            clearTimeout(reduxSyncTimerRef.current);
            reduxSyncTimerRef.current = null;
            dispatch(updateContent(latestCodeRef.current));
        }
        if (activeFile && isUnsaved) dispatch(saveFileContentThunk());
        // ── Push saved content to worker disk via file-sync channel ──
        // This ensures the worker's filesystem (used by the LSP server for
        // cross-file indexing) always has the latest content.
        if (activeFile?.path && compilerClient) {
            try {
                compilerClient.syncFile(activeFile.path, latestCodeRef.current ?? code);
            } catch (_) { /* best-effort */ }
        }
        // Also update the in-memory virtual filesystem so Monaco's FileService
        // can resolve the latest content for cross-file features.
        if (activeFile?.path) {
            updateVirtualFile(activeFile.path, latestCodeRef.current ?? code).catch(() => {});
        }
        // P1: Send textDocument/didSave to LSP servers so they re-index
        if (activeFile?.path) {
            const safePath = activeFile.path.startsWith('/') ? activeFile.path.slice(1) : activeFile.path;
            const fileUri = `file:///synthi/${safePath}`;
            languageClientsRef.current.forEach((client, lang) => {
                if (client && client.isRunning()) {
                    try {
                        client.sendNotification('textDocument/didSave', {
                            textDocument: { uri: fileUri },
                            // Some servers (e.g. gopls) want the text on save
                            text: latestCodeRef.current ?? code
                        });
                        console.log(`[LSP] Sent didSave for ${fileUri} to ${lang}`);
                    } catch (_) { /* best-effort */ }
                }
            });
        }
        // Trigger HMR/Compilation on save
        if (onSave) onSave();
    }, [activeFile, isUnsaved, dispatch, onSave, compilerClient, code]);

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
                                        {!servicesReady ? (
                                            <div className="flex items-center justify-center h-full w-full" style={{ background: TAB_TOKENS.activeBg }}>
                                                <Loader2 className="animate-spin" style={{ color: TAB_TOKENS.textSecondary }} size={24} />
                                            </div>
                                        ) : diffMode ? (
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
                                                path={activeFile ? `file:///synthi/${activeFile.path.startsWith('/') ? activeFile.path.slice(1) : activeFile.path}` : undefined}
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

                                                    // P0: Force-set the model language to match our file-extension
                                                    // detection.  When @codingame/monaco-vscode-api is active it
                                                    // overrides Monaco's built-in language detection and defaults
                                                    // to 'plaintext' for languages that have no registered vscode
                                                    // extension (Java, Go, Rust, etc.).  Without this, the
                                                    // MonacoLanguageClient's documentSelector won't match and the
                                                    // LSP will never send textDocument/didOpen for the file.
                                                    if (activeLanguage && activeLanguage !== 'plaintext' && model.getLanguageId() !== activeLanguage) {
                                                        console.log(`[Editor] Correcting model language: ${model.getLanguageId()} → ${activeLanguage}`);
                                                        monaco.editor.setModelLanguage(model, activeLanguage);
                                                    }

                                                    setEditorInstance(editor);
                                                    setMonacoInstance(monaco);
                                                    if (onEditorMount) onEditorMount(editor);

                                                    // Hard reset: clear only SYNTHI-owned markers on initial mount.
                                                    // P0: Do NOT clear all markers — LSP-published diagnostics must survive.
                                                    try {
                                                        const model = editor.getModel?.();
                                                        if (model) {
                                                            const synthiOwners = new Set([
                                                                'synthi-analysis', 'synthi-proactive', 'synthi-ai', 'extension',
                                                            ]);
                                                            const tracked = monaco.__synthiMarkerOwners;
                                                            if (tracked && typeof tracked.forEach === 'function') {
                                                                tracked.forEach((o) => synthiOwners.add(o));
                                                            }
                                                            synthiOwners.forEach((owner) => {
                                                                try { monaco.editor.setModelMarkers(model, owner, []); } catch (_) {}
                                                            });
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
                                                    editor.onDidChangeModelContent(() => {
                                                        // (a) P0: Debounce marker clearing — NOT synchronous.
                                                        // Only clear SYNTHI-owned markers. LSP-published diagnostics
                                                        // (from the language server) are left intact so red/yellow
                                                        // squiggles actually appear.
                                                        if (!markerClearTimerRef.current) {
                                                            markerClearTimerRef.current = requestAnimationFrame(() => {
                                                                markerClearTimerRef.current = null;
                                                                try {
                                                                    const model = editor.getModel?.();
                                                                    if (model) {
                                                                        const synthiOwners = new Set([
                                                                            'synthi-analysis',
                                                                            'synthi-proactive',
                                                                            'synthi-ai',
                                                                        ]);
                                                                        const tracked = monaco.__synthiMarkerOwners;
                                                                        if (tracked && typeof tracked.forEach === 'function') {
                                                                            tracked.forEach((o) => synthiOwners.add(o));
                                                                        }
                                                                        synthiOwners.forEach((owner) => {
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
