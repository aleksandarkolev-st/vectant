// src/app/Editor.jsx
'use client';
import { useCallback, useEffect, useLayoutEffect, useState, useRef, useMemo } from 'react';
import Editor, { DiffEditor, loader } from '@monaco-editor/react';
import { getMonacoLanguage } from '@/utils/languageMapper';
import dynamic from 'next/dynamic';
import { useAppDispatch, useAppSelector, useAppStore } from '@/redux/hooks';
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
    clearSavedBaselines,
    markFileSavedRemotely,
} from '@/redux/workspaceSlice';
import { selectAutoCompletionEnabled, toggleAutoCompletion, selectPresenceGranularity, startCreate, setCursorPosition, selectAutoSaveEnabled } from '@/redux/uiSlice';
import { fetchGitStatus, closeConflictResolver } from '@/redux/gitSlice';
import { Circle, Save, Sparkles, Loader2, X, Plus, TerminalSquare } from 'lucide-react';
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
// PERF: Prettier (~1.5MB) was imported eagerly but never used at runtime.
// Removed static imports.  If formatting is needed in the future, lazy-load:
//   const prettier = (await import('prettier/standalone')).default;
//   const babel = (await import('prettier/plugins/babel')).default;
//   const estree = (await import('prettier/plugins/estree')).default;
import { EDITOR_OPTIONS, getResponsiveEditorOverrides } from './options';
import { useViewport } from '@/hooks/useViewport';
import { useAiCompletion } from './AICompletion';
import { useNextEditPrediction } from './NextEditPrediction';
import { useDiffManager } from './diffManager';
import { useGitGutter } from './gitGutterService';
import { useEditorProviders } from './providers';
import { useEditorEvents } from './events';
import { takeLastChars, useCustomScrollbar } from './utils';
import { SYNTHI_THEME } from './theme';
import { useTheme } from '@/components/ThemeProvider';
import { ConflictBanner } from './ConflictBanner';
import MergeConflictEditor from '@/components/git/MergeConflictEditor';
import UnsavedChangesDialog from '@/components/ui/UnsavedChangesDialog';
import { useSessionPermissions } from '@/hooks/useCollabSession';
import { initSynthiFileSystem, updateFile as updateVirtualFile, disposeSynthiFileSystem, registerSystemFile, hasSystemFile } from './SynthiFileSystemProvider';
import { fileCache } from '@/services/fileCache';
import { registerMonarchTokenizers } from './languageTokenizers';
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

// ── Suppress known @codingame/monaco-vscode-api "Unsupported" noise ─
// The stub in missing-services.js fires a console.error for every unregistered
// service method (e.g. MarkdownRendererService.setDefaultCodeBlockRenderer).
// These are harmless in the standalone editor and clutter the dev overlay.
if (typeof window !== 'undefined') {
    const _origConsoleError = console.error;
    console.error = function (...args) {
        if (typeof args[0] === 'string' && args[0].startsWith('Unsupported:') && args[0].includes('is not supported')) return;
        return _origConsoleError.apply(this, args);
    };
}

// ── Language registration for @codingame/monaco-vscode-api ──────────
// The vscode-api layer doesn't know about languages like Java, Go, Rust, etc.
// unless a vscode extension is registered for them.  Without this, models
// created from file URIs default to 'plaintext', breaking documentSelector
// matching and LSP provider activation.
const SUPPORTED_LANGUAGES = [
    // JavaScript/TypeScript must be registered explicitly so @codingame/monaco-vscode-api
    // maps file URIs (.js, .ts, etc.) to the correct languageId instead of 'plaintext'.
    { id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], aliases: ['JavaScript', 'JS'] },
    { id: 'typescript', extensions: ['.ts', '.tsx'], aliases: ['TypeScript', 'TS'] },
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
    { id: 'prisma', extensions: ['.prisma'], aliases: ['Prisma'] },
    { id: 'graphql', extensions: ['.graphql', '.gql'], aliases: ['GraphQL'] },
    { id: 'yaml', extensions: ['.yaml', '.yml'], aliases: ['YAML'] },
    { id: 'toml', extensions: ['.toml'], aliases: ['TOML'] },
    { id: 'dockerfile', extensions: [], aliases: ['Dockerfile'] },
];

// Build a reverse map: language id → glob patterns for documentSelector fallback
const LANG_TO_GLOB = {};
for (const lang of SUPPORTED_LANGUAGES) {
    LANG_TO_GLOB[lang.id] = lang.extensions.map(ext => `**/*${ext}`);
}
// Also add built-in languages with additional extension patterns
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
import { useFilePresence } from '@/hooks/useFilePresence';

// Configure Monaco workers
if (typeof window !== 'undefined') {
    // Use bundled monaco-editor instead of CDN to ensure compatibility with monaco-languageclient
    loader.config({ monaco });

    // Expose monaco globally so hooks/services that need Range, MarkerSeverity,
    // etc. can access it without a direct import (many files rely on this).
    window.monaco = monaco;
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

const DOCK_LAYOUT_RESIZE_EVENT = 'synthi:dock-layout-resize';

let servicesInitialized = false;
let servicesInitPromise = null; // serialize concurrent init attempts

// ===== SYNTHI BRAND Design Tokens - Theme-aware via CSS vars =====
const TAB_TOKENS = {
    activeBg: 'var(--bg-editor, #0c0d12)',
    inactiveBg: 'var(--bg-app, #08090d)',
    hoverBg: 'var(--bg-surface, #101118)',
    primary: 'var(--accent-primary, #3a8574)',
    primaryGlow: '0 0 14px color-mix(in srgb, var(--accent-primary, #3a8574) 60%, transparent)',
    borderSubtle: 'var(--border-subtle, #1a1b24)',
    borderFocus: 'var(--border-focus, #3a3b52)',
    textPrimary: 'var(--text-primary, #f4f5f8)',
    textSecondary: 'var(--text-secondary, #9ba2b8)',
    textInactive: 'var(--text-dim, #4a5066)',
    unsaved: 'var(--accent-danger, #ff6b6b)',
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
    collabHostId = null,
    dockingMode = false,
    filePath = null,
    paneId = null,
    selfEditFlagRef = null,
}) => {
    const dispatch = useAppDispatch();
    const store = useAppStore();

    // Responsive Monaco options — recalculated when the viewport breakpoint
    // changes. Memoised so we don't re-spread on every render.
    const viewport = useViewport();
    const responsiveOverrides = useMemo(
        () => getResponsiveEditorOverrides(viewport) || {},
        [viewport.isMobile, viewport.isTablet],
    );

    //Global state access djsaiodjasiodjasiodjasiodjaoidjasoidjsaiodjasiodjasjdnsaj
    const activeFile = useAppSelector(selectActiveFile);
    const code = store.getState().workspace.currentContent;
    const isUnsaved = useAppSelector(selectIsUnsaved);
    const breadcrumb = useAppSelector(selectBreadcrumb);
    const fileCacheEntries = useAppSelector(selectFileCacheEntries);
    const openFiles = useAppSelector(selectOpenFiles);
    const loadingFiles = useAppSelector(selectLoadingFiles);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    const showTerminalRedux = useAppSelector(state => state.ui.showTerminal);
    const showTerminal = dockingMode ? false : showTerminalRedux;
    const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
    const savedContent = useAppSelector(state => state.workspace.savedContent);
    const aiAutoEnabled = useAppSelector(selectAutoCompletionEnabled);
    const presenceGranularity = useAppSelector(selectPresenceGranularity);
    const diffMode = useAppSelector(state => state.workspace.diffMode);
    const originalContent = useAppSelector(state => state.workspace.originalContent);

    // In docking mode each pane renders its OWN file (props.filePath); fall back
    // to the global activeFile only outside docking (single-editor mode).
    const paneFile = useMemo(() => {
        if (dockingMode && filePath) {
            return openFiles.find((f) => f.path === filePath)
                || { path: filePath, name: filePath.split('/').pop() };
        }
        return activeFile;
    }, [dockingMode, filePath, openFiles, activeFile]);

    // Focused pane drives the global content/save buffer; unfocused panes edit
    // their own Monaco model only.
    const isFocusedPane = !dockingMode || (!!paneFile?.path && activeFile?.path === paneFile.path);

    // Git status for conflict detection
    const gitStatus = useAppSelector(state => state.git?.status);
    const conflictedFiles = gitStatus?.conflictedFiles || [];
    const conflictResolverFile = useAppSelector(state => state.git?.conflictResolverFile);

    // Collaboration permissions — enforce read-only for guests without canEdit
    const { canEdit: collabCanEdit, role: collabRole } = useSessionPermissions();
    const isCollabReadOnly = collabRole === 'guest' && !collabCanEdit;

    // Theme context — provides monacoRef for live theme switching
    const { monacoRef: themeMonacoRef, reapply: reapplyTheme } = useTheme();

    // Local state
    const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
    const [editorInstance, setEditorInstance] = useState(null);
    const [monacoInstance, setMonacoInstance] = useState(null);
    // Track whether the DiffEditor has ever been activated — once true, we keep
    // it mounted (hidden) to avoid React unmount crash in passive effects.
    const [diffModeEverActive, setDiffModeEverActive] = useState(false);
    const diffEditorRef = useRef(null);
    const latestCodeRef = useRef(code);
    const pendingContentFrameRef = useRef(null);
    const pendingPositionFrameRef = useRef(null);
    // P0: Debounced Redux sync — only flush content to Redux after 300ms pause
    const reduxSyncTimerRef = useRef(null);
    // Background HMR edit classification — debounced 300ms
    const editDeltaTimerRef = useRef(null);
    // P0: Debounced marker clearing — avoid blocking main thread on every keystroke
    const markerClearTimerRef = useRef(null);
    // P2: Cached content hash — avoid O(n) FNV-1a on every keystroke
    const contentHashRef = useRef({ content: '', hash: '00000000' });
    const [tabContext, setTabContext] = useState({ visible: false, x: 0, y: 0, file: null, index: -1 });
    // Unsaved-changes dialog state: { path, name } of the file pending close, or null
    const [pendingClose, setPendingClose] = useState(null);
    const [lspStatus, setLspStatus] = useState('Idle');
    const [servicesReady, setServicesReady] = useState(false);
    const editorViewportRef = useRef(null);
    const slug = useAppSelector(state => state.workspace.slug);

    // Refs for file cache data — used during async service init to pre-populate
    // the virtual filesystem BEFORE servicesReady is set, preventing the
    // "Unable to read file" error from @codingame/monaco-vscode-api.
    const fileCacheEntriesRef = useRef(fileCacheEntries);
    const rawFilesRef = useRef(rawFiles);
    fileCacheEntriesRef.current = fileCacheEntries;
    rawFilesRef.current = rawFiles;
    const session = useSession();
    // Derive authenticated user id from the session — used as a guard for
    // collab binding so we never open Yjs docs before identity is set.
    const authUserId = session?.data?.user?.id || session?.data?.user?.email || null;
    const collabBindingRef = useRef(null);
    const [collabConnected, setCollabConnected] = useState(false); // Track if collab is actively bound
    const [isPrivateMode, setIsPrivateMode] = useState(false);
    const [remoteUnsaved, setRemoteUnsaved] = useState(false);
    // Debounce ref for markFileSavedRemotely — on rapid remote edits
    // (e.g., host typing quickly), this prevents dozens of Redux dispatches
    // per second, coalescing them into one per animation frame.
    const remoteSaveRAFRef = useRef(null);
    
    // File-level presence: which remote users are editing which files
    const { presenceByFile } = useFilePresence(slug, authUserId);
    
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
    //
    // PERF: For files > 100 KB the hashing is dispatched to a Web Worker using
    // crypto.subtle (native C++ backed), keeping the main thread unblocked.
    // The synchronous return value still comes from the FNV-1a fast-path so
    // callers are never blocked — the worker result updates the cache async.
    const hashWorkerRef = useRef(null);
    const hashMsgIdRef = useRef(0);
    const computeContentHash = useCallback((content) => {
        if (typeof content !== 'string') return '00000000';
        const cached = contentHashRef.current;
        if (cached.content === content) return cached.hash;
        // Inline FNV-1a for immediate (synchronous) return
        let hash = 2166136261;
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        const result = hash.toString(16).padStart(8, '0');
        contentHashRef.current = { content, hash: result };
        // For large files, also fire-and-forget a crypto.subtle hash in worker
        // so the next call for identical content gets a stronger hash for free.
        if (content.length > 100_000) {
            try {
                if (!hashWorkerRef.current) {
                    hashWorkerRef.current = new Worker('/content-hash-worker.js');
                    hashWorkerRef.current.onmessage = (e) => {
                        const { id: _id, hash: workerHash } = e.data;
                        // Update cache only if content hasn't changed since we sent
                        if (contentHashRef.current.content === content) {
                            contentHashRef.current = { content, hash: workerHash };
                        }
                    };
                }
                hashWorkerRef.current.postMessage({ id: ++hashMsgIdRef.current, content });
            } catch (_) { /* worker unavailable */ }
        }
        return result;
    }, []);

    // Animated tab indicator state - simple underline that slides
    const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0, visible: false });
    const [hoveredTabPath, setHoveredTabPath] = useState(null);
    const tabRefs = useRef({});

    // ── Presence hover-card state ────────────────
    const [hoverPresence, setHoverPresence] = useState(null); // { user, clientId, rect, cursor }
    const hoverHideTimeoutRef = useRef(null);
    const showAnonymousPresence = false; // flip to true to show anonymous users in the presence list
    const hoverCardStyle = useMemo(() => {
        if (!hoverPresence?.rect) return null;
        const { rect } = hoverPresence;
        return {
            position: 'fixed',
            left: rect.left + rect.width / 2 - 112, // centre the 224px card on the avatar
            top: rect.bottom + 6,
            zIndex: 9999,
        };
    }, [hoverPresence]);

    const { client: compilerClient, status: compilerStatus } = useCompiler();
    const languageClientsRef = useRef(new Map());
    const lspInitPendingRef = useRef(new Set()); // Guard against concurrent init for same language
    // Track the previously-opened file URI per language client so we can send didClose on file switch
    const lspOpenedUrisRef = useRef(new Map()); // Map<clientKey, { uri, languageId }>
    // Track textDocumentSync capability reported by each language server
    const lspSyncCapRef = useRef(new Map()); // Map<clientKey, number> (1=Full, 2=Incremental)

    useEffect(() => {
        if (typeof window === 'undefined') return undefined;

        let animationFrameId = null;
        let settleTimerId = null;

        const relayoutEditors = () => {
            try { editorInstance?.layout?.(); } catch (_) { /* ignored */ }
            try { diffEditorRef.current?.layout?.(); } catch (_) { /* ignored */ }
        };

        const handleDockLayoutResize = () => {
            relayoutEditors();
            if (animationFrameId != null) {
                window.cancelAnimationFrame(animationFrameId);
            }
            if (settleTimerId != null) {
                window.clearTimeout(settleTimerId);
            }
            animationFrameId = window.requestAnimationFrame(relayoutEditors);
            settleTimerId = window.setTimeout(relayoutEditors, 280);
        };

        window.addEventListener(DOCK_LAYOUT_RESIZE_EVENT, handleDockLayoutResize);
        return () => {
            window.removeEventListener(DOCK_LAYOUT_RESIZE_EVENT, handleDockLayoutResize);
            if (animationFrameId != null) {
                window.cancelAnimationFrame(animationFrameId);
            }
            if (settleTimerId != null) {
                window.clearTimeout(settleTimerId);
            }
        };
    }, [editorInstance]);

    useEffect(() => {
        const viewport = editorViewportRef.current;
        if (!viewport) return undefined;

        let animationFrameId = null;
        let settleTimerId = null;
        let previousWidth = 0;
        let previousHeight = 0;

        const relayoutEditors = () => {
            try { editorInstance?.layout?.(); } catch (_) { /* ignored */ }
            try { diffEditorRef.current?.layout?.(); } catch (_) { /* ignored */ }
        };

        const observer = new ResizeObserver(([entry]) => {
            const width = entry?.contentRect?.width ?? 0;
            const height = entry?.contentRect?.height ?? 0;
            if (width === previousWidth && height === previousHeight) return;
            previousWidth = width;
            previousHeight = height;

            relayoutEditors();
            if (animationFrameId != null) {
                window.cancelAnimationFrame(animationFrameId);
            }
            if (settleTimerId != null) {
                window.clearTimeout(settleTimerId);
            }
            animationFrameId = window.requestAnimationFrame(relayoutEditors);
            settleTimerId = window.setTimeout(relayoutEditors, 280);
        });

        observer.observe(viewport);
        return () => {
            observer.disconnect();
            if (animationFrameId != null) {
                window.cancelAnimationFrame(animationFrameId);
            }
            if (settleTimerId != null) {
                window.clearTimeout(settleTimerId);
            }
        };
    }, [editorInstance, diffMode]);

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

                // P0: Load Monarch tokenizers for all supported languages.
                // @codingame/monaco-vscode-api disables Monaco's built-in
                // contribution loading, so languages like Rust, Java, Go, etc.
                // have no tokenizer unless we explicitly register one.
                await registerMonarchTokenizers();

                // P0: Pre-populate the virtual filesystem BEFORE marking services
                // as ready.  @codingame/monaco-vscode-api's TextDocument service
                // will try to read file:///synthi/ URIs as soon as it activates.
                // If the overlay isn't registered yet, we get "Unable to read file"
                // errors and the TextDocument is never created properly, which
                // breaks completion provider document matching.
                try {
                    await initSynthiFileSystem(
                        fileCacheEntriesRef.current,
                        rawFilesRef.current,
                        slug
                    );
                    console.log('[SynthiFS] Virtual filesystem pre-initialized during service startup');
                } catch (e) {
                    console.warn('[SynthiFS] Pre-init failed (will retry later):', e?.message);
                }

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
        initSynthiFileSystem(fileCacheEntries, rawFiles, slug).catch(e =>
            console.warn('[SynthiFS] Failed to init virtual filesystem:', e)
        );
    }, [servicesReady, fileCacheEntries, rawFiles, slug]);

    // ── Worker file-sync seeding ────────────────────────────────
    // Push every cached workspace file to the worker disk as soon as the
    // file-sync DataChannel opens. Without this clangd / pyright / etc.
    // only see the active file (via didOpen) plus whatever
    // storage::download pulled from GCS, so cross-file symbol lookups
    // ("undefined reference to compute") fail for files the user opened
    // but never saved.
    const fileSyncSeededRef = useRef(false);
    useEffect(() => {
        if (!compilerClient) return undefined;
        if (compilerStatus !== CompilerStatus.CONNECTED) {
            fileSyncSeededRef.current = false;
            return undefined;
        }
        const seed = () => {
            if (fileSyncSeededRef.current) return;
            const entries = fileCacheEntriesRef.current || [];
            if (!entries || entries.length === 0) return;
            try {
                compilerClient.syncAllFiles(entries);
                fileSyncSeededRef.current = true;
            } catch (e) {
                console.warn('[Editor] syncAllFiles failed:', e?.message);
            }
        };
        const dispose = compilerClient.onFileSyncOpen(seed);
        // Channel may already be open (reconnect path) — call seed() once.
        if (compilerClient.fileSyncChannel?.readyState === 'open') seed();
        return () => { try { dispose?.(); } catch (_) { /* ignored */ } };
    }, [compilerClient, compilerStatus]);

    // Re-seed whenever the file cache grows so newly-loaded tabs land on
    // the worker without waiting for save.
    useEffect(() => {
        if (!compilerClient) return;
        if (compilerStatus !== CompilerStatus.CONNECTED) return;
        if (compilerClient.fileSyncChannel?.readyState !== 'open') return;
        try { compilerClient.syncAllFiles(fileCacheEntries || []); }
        catch (_) { /* best-effort */ }
    }, [compilerClient, compilerStatus, fileCacheEntries]);

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
                // Do NOT tear down running LSP clients here.
                // The data channel's own 'close' event handler (registered
                // when the LSP was initialized) will clean up each client
                // when the underlying transport actually dies.
                // Immediately destroying clients on a transient WebRTC
                // 'disconnected' state kills LSP even when the connection
                // self-recovers seconds later.
            }
            return;
        }

        const lang = getMonacoLanguage(activeFile.name);

        // ── Language → LSP backend mapping table ──────────────────
        // Single source of truth — replaces the old if-else chain.
        // Each entry maps one or more Monaco language IDs to:
        //   backend    – language string sent to the worker (controls
        //                which server is spawned and which config is
        //                generated, e.g. jsconfig.json vs tsconfig.json)
        //   clientKey  – dedup key for the frontend client map.  Languages
        //                that share the same LSP server use the same key
        //                so only ONE WebRTC channel + client is created.
        //   selector   – Monaco language IDs the client provides features for.
        const LSP_LANG_TABLE = {
            cpp:                { backend: 'cpp',        clientKey: 'cpp',        selector: ['cpp', 'c'] },
            c:                  { backend: 'c',          clientKey: 'cpp',        selector: ['cpp', 'c'] },
            rust:               { backend: 'rust',       clientKey: 'rust',       selector: ['rust'] },
            python:             { backend: 'python',     clientKey: 'python',     selector: ['python'] },
            typescript:         { backend: 'typescript', clientKey: 'typescript', selector: ['typescript', 'typescriptreact'] },
            typescriptreact:    { backend: 'typescript', clientKey: 'typescript', selector: ['typescript', 'typescriptreact'] },
            javascript:         { backend: 'javascript', clientKey: 'javascript', selector: ['javascript', 'javascriptreact'] },
            javascriptreact:    { backend: 'javascript', clientKey: 'javascript', selector: ['javascript', 'javascriptreact'] },
            java:               { backend: 'java',       clientKey: 'java',       selector: ['java'] },
            go:                 { backend: 'go',         clientKey: 'go',         selector: ['go'] },
            csharp:             { backend: 'csharp',     clientKey: 'csharp',     selector: ['csharp'] },
            ruby:               { backend: 'ruby',       clientKey: 'ruby',       selector: ['ruby'] },
            php:                { backend: 'php',        clientKey: 'php',        selector: ['php'] },
            kotlin:             { backend: 'kotlin',     clientKey: 'kotlin',     selector: ['kotlin'] },
            zig:                { backend: 'zig',        clientKey: 'zig',        selector: ['zig'] },
            dart:               { backend: 'dart',       clientKey: 'dart',       selector: ['dart'] },
            lua:                { backend: 'lua',        clientKey: 'lua',        selector: ['lua'] },
            elixir:             { backend: 'elixir',     clientKey: 'elixir',     selector: ['elixir'] },
            svelte:             { backend: 'svelte',     clientKey: 'svelte',     selector: ['svelte'] },
            css:                { backend: 'css',        clientKey: 'css',        selector: ['css', 'scss', 'less'] },
            scss:               { backend: 'scss',       clientKey: 'css',        selector: ['css', 'scss', 'less'] },
            less:               { backend: 'less',       clientKey: 'css',        selector: ['css', 'scss', 'less'] },
            html:               { backend: 'html',       clientKey: 'html',       selector: ['html'] },
            prisma:             { backend: 'prisma',     clientKey: 'prisma',     selector: ['prisma'] },
            yaml:               { backend: 'yaml',       clientKey: 'yaml',       selector: ['yaml'] },
            toml:               { backend: 'toml',       clientKey: 'toml',       selector: ['toml'] },
            json:               { backend: 'json',       clientKey: 'json',       selector: ['json', 'jsonc'] },
            jsonc:              { backend: 'json',       clientKey: 'json',       selector: ['json', 'jsonc'] },
            graphql:            { backend: 'graphql',    clientKey: 'graphql',    selector: ['graphql'] },
            dockerfile:         { backend: 'dockerfile', clientKey: 'dockerfile', selector: ['dockerfile'] },
        };

        // ── Supplementary (augmentation) LSP servers ──────────────
        // These are language servers that don't own a file type but
        // provide additional intelligence (linting, utility classes)
        // for files that already have a primary language server.
        // Each entry maps primary language IDs → supplementary LSP backends.
        const SUPPLEMENTARY_SERVERS = {
            eslint: {
                backend: 'eslint',
                clientKey: 'eslint',
                selector: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
                // Which primary languages trigger this supplementary server
                activatesOn: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact'],
            },
            tailwindcss: {
                backend: 'tailwindcss',
                clientKey: 'tailwindcss',
                selector: ['css', 'scss', 'less', 'html', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'svelte'],
                activatesOn: ['css', 'scss', 'less', 'html', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'svelte'],
            },
        };

        // ── Merge dynamic LSP entries from extension registry ─────
        // Extensions can register additional language→LSP mappings at
        // install time. These are stored in window.__synthiLspRegistry
        // and merged here so they participate in LSP startup.
        if (typeof window !== 'undefined' && window.__synthiLspRegistry) {
            for (const [langId, entry] of Object.entries(window.__synthiLspRegistry)) {
                if (!LSP_LANG_TABLE[langId]) {
                    LSP_LANG_TABLE[langId] = entry;
                }
            }
        }

        const langEntry = LSP_LANG_TABLE[lang];
        const backendLang = langEntry?.backend ?? null;
        const clientKey = langEntry?.clientKey ?? backendLang;
        const documentSelector = langEntry?.selector ?? [];

        if (!backendLang) {
            setLspStatus('No LSP for this file');
            return;
        }

        if (languageClientsRef.current.has(clientKey)) {
            const client = languageClientsRef.current.get(clientKey);
            if (client && client.isRunning()) {
                setLspStatus(`Ready (${backendLang})`);
                console.log(`[LSP] Reusing existing ${clientKey} client for ${backendLang}`);

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
                    const prev = lspOpenedUrisRef.current.get(clientKey);

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
                            lspOpenedUrisRef.current.set(clientKey, { uri: fileUri, languageId: lang });
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
            console.warn(`[LSP] Stale client for ${clientKey} — removing and re-initializing`);
            languageClientsRef.current.delete(clientKey);
        }

        // Prevent concurrent initialization for the same language
        // (effect can re-fire while the async .then() is still in flight)
        if (lspInitPendingRef.current.has(clientKey)) {
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
        lspInitPendingRef.current.add(clientKey);

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
        const rawSocket = toSocket(adapter);

        // ── Smart socket wrapper ──────────────────────────────────
        // Track outgoing request IDs and incoming response IDs so we
        // can suppress $/cancelRequest notifications for requests the
        // server already completed.  Without this, the cancel/response
        // race condition causes lsp4j to log "Unmatched cancel
        // notification" and — in some servers like Eclipse JDT.LS —
        // can corrupt internal request tracking, breaking all
        // subsequent LSP features (completion, hover, diagnostics).
        //
        // KEY INSIGHT: Even with tracking, there's a network race —
        // the response can be in-flight over WebRTC while the client
        // sends the cancel.  We solve this by **debouncing** cancels:
        // hold each $/cancelRequest for a short window (400ms).  If
        // the response arrives in that window the cancel is dropped.
        // If not, we send it normally so the server can stop work.
        const _completedRequestIds = new Set();
        const _pendingRequestIds = new Set();
        const _pendingCancelTimers = new Map(); // cancelId → timerId
        let _cancelFilterStats = { filtered: 0, passed: 0 };
        const CANCEL_DEBOUNCE_MS = 400;

        // ── In-flight request capping ────────────────────────────
        // Drop the oldest pending completion request when we exceed
        // this limit.  Prevents piling up expensive requests on
        // slow servers when the user types quickly.
        const MAX_IN_FLIGHT_COMPLETIONS = 3;
        const _inFlightCompletionIds = new Set(); // track completion request IDs
        const socket = {
            send: (content) => {
                try {
                    const msg = JSON.parse(content);
                    // Track outgoing requests (has both id AND method)
                    if (msg.id !== undefined && msg.method && msg.method !== '$/cancelRequest') {
                        _pendingRequestIds.add(msg.id);

                        // Cap in-flight completion requests
                        if (msg.method === 'textDocument/completion') {
                            _inFlightCompletionIds.add(msg.id);
                            if (_inFlightCompletionIds.size > MAX_IN_FLIGHT_COMPLETIONS) {
                                // Cancel the oldest one
                                const oldest = _inFlightCompletionIds.values().next().value;
                                _inFlightCompletionIds.delete(oldest);
                                _pendingRequestIds.delete(oldest);
                                try {
                                    rawSocket.send(JSON.stringify({
                                        jsonrpc: '2.0',
                                        method: '$/cancelRequest',
                                        params: { id: oldest },
                                    }));
                                } catch (_) { /* best effort */ }
                            }
                        }
                    }
                    // Debounce $/cancelRequest — hold for CANCEL_DEBOUNCE_MS
                    // to give in-flight responses time to arrive.
                    if (msg.method === '$/cancelRequest' && msg.params?.id !== undefined) {
                        const cancelId = msg.params.id;
                        // Already completed — drop immediately
                        if (_completedRequestIds.has(cancelId)) {
                            _completedRequestIds.delete(cancelId);
                            _pendingRequestIds.delete(cancelId);
                            _cancelFilterStats.filtered++;
                            return;
                        }
                        // Not yet completed — debounce: wait for response
                        const timerId = setTimeout(() => {
                            _pendingCancelTimers.delete(cancelId);
                            // Re-check after the debounce window
                            if (_completedRequestIds.has(cancelId) || !_pendingRequestIds.has(cancelId)) {
                                // Response arrived during debounce, or request
                                // was already cleaned up — drop the cancel.
                                _completedRequestIds.delete(cancelId);
                                _pendingRequestIds.delete(cancelId);
                                _cancelFilterStats.filtered++;
                            } else {
                                // Response still hasn't arrived — send the cancel
                                _pendingRequestIds.delete(cancelId);
                                _cancelFilterStats.passed++;
                                rawSocket.send(content);
                            }
                        }, CANCEL_DEBOUNCE_MS);
                        _pendingCancelTimers.set(cancelId, timerId);
                        return; // don't send yet
                    }
                } catch (_e) { /* not JSON, pass through */ }
                rawSocket.send(content);
            },
            onMessage: (cb) => {
                rawSocket.onMessage((data) => {
                    try {
                        const msg = JSON.parse(data);
                        // Track incoming responses (has id but NO method)
                        if (msg.id !== undefined && !msg.method) {
                            _pendingRequestIds.delete(msg.id);
                            _completedRequestIds.add(msg.id);
                            _inFlightCompletionIds.delete(msg.id);
                            // If a cancel for this ID is pending in debounce,
                            // clear it — no need to send it anymore.
                            const pendingTimer = _pendingCancelTimers.get(msg.id);
                            if (pendingTimer !== undefined) {
                                clearTimeout(pendingTimer);
                                _pendingCancelTimers.delete(msg.id);
                                _cancelFilterStats.filtered++;
                            }
                            // Bound memory — keep only the last 500 IDs
                            if (_completedRequestIds.size > 500) {
                                const iter = _completedRequestIds.values();
                                for (let i = 0; i < 250; i++) {
                                    _completedRequestIds.delete(iter.next().value);
                                }
                            }
                        }
                    } catch (_e) { /* not JSON, pass through */ }
                    cb(data);
                });
            },
            onError: rawSocket.onError.bind(rawSocket),
            onClose: rawSocket.onClose.bind(rawSocket),
            dispose: () => {
                // Clean up any pending cancel timers
                for (const timerId of _pendingCancelTimers.values()) {
                    clearTimeout(timerId);
                }
                _pendingCancelTimers.clear();
                rawSocket.dispose();
            },
        };
        const reader = new WebSocketMessageReader(socket);
        const writer = new WebSocketMessageWriter(socket);

        // FIX: Monitor reader/writer errors so we know when the transport
        // dies.  Without this, silent send failures create orphaned promises
        // in vscode-jsonrpc that hang every LSP feature.
        reader.onError((error) => {
            console.error(`[LSP] Reader error for ${backendLang}:`, error);
        });
        writer.onError(([error]) => {
            console.error(`[LSP] Writer error for ${backendLang}:`, error);
        });
        reader.onClose(() => {
            console.warn(`[LSP] Reader closed for ${backendLang} — transport is dead`);
        });

        Promise.all([
            import('monaco-languageclient'),
            import('monaco-languageclient/vscodeApiWrapper'),
            import('vscode-languageclient/lib/common/completion'),
        ]).then(async ([{ MonacoLanguageClient }, { MonacoVscodeApiWrapper }, { CompletionItemFeature }]) => {
            if (languageClientsRef.current.has(clientKey)) {
                lspInitPendingRef.current.delete(clientKey);
                return;
            }

            // Services should be initialized by the other useEffect, but double check
            if (!servicesInitialized) {
                console.warn('[LSP] Services not initialized yet, waiting...');
                lspInitPendingRef.current.delete(clientKey);
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
                // Skip the built-in CompletionItemFeature.  It registers
                // a VS Code completion provider through the extension host
                // that races against our direct Monaco completion provider.
                // When both are active, the built-in one returns empty
                // results instantly (via middleware returning []), which
                // causes VS Code's suggest model to dismiss the widget
                // before our async provider's 34 items arrive.
                //
                // Also skip the built-in InlineCompletionItemFeature. LSPs
                // that advertise `inlineCompletionProvider` capability
                // (newer rust-analyzer, gopls, etc.) would otherwise
                // register a Monaco inline-completion provider for the
                // same languages as Synthi's AI ghost-text provider.
                // Monaco merges results from all registered inline
                // providers; an LSP returning [] interleaves with our AI
                // suggestion and dismisses it.
                registerFeature(feature) {
                    // Use multiple checks — instanceof can fail when
                    // bundlers duplicate the vscode-languageclient module.
                    const ctorName = feature?.constructor?.name;
                    const method = feature?.registrationType?.method;

                    const isCompletionFeature =
                        feature instanceof CompletionItemFeature ||
                        ctorName === 'CompletionItemFeature' ||
                        method === 'textDocument/completion';
                    if (isCompletionFeature) {
                        console.log('[LSP] Skipping built-in CompletionItemFeature — using direct provider');
                        return;
                    }

                    const isInlineCompletionFeature =
                        ctorName === 'InlineCompletionItemFeature' ||
                        ctorName === 'InlineCompletionFeature' ||
                        method === 'textDocument/inlineCompletion';
                    if (isInlineCompletionFeature) {
                        console.log('[LSP] Skipping built-in InlineCompletionItemFeature — Synthi AI owns inline completions');
                        return;
                    }

                    super.registerFeature(feature);
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

            // rust-analyzer initializationOptions: disable heavy cargo
            // features that require a full toolchain (cargo check, build scripts)
            // to avoid "No such file or directory" errors in containers where
            // cargo may not be fully configured.  RA still provides completions,
            // hover, go-to-def, and diagnostics from source analysis alone.
            const initializationOptions = backendLang === 'rust' ? {
                cargo: {
                    // Don't run `cargo check` on save — it fails without cargo
                    buildScripts: { enable: false },
                    // Let RA auto-discover sysroot from cargo/rustc so it can
                    // index stdlib source (Vec::new, HashMap::insert, etc.)
                    // Setting sysroot to "discover" is the default but being
                    // explicit ensures it's not accidentally turned off.
                    sysroot: 'discover',
                },
                // Disable check-on-save (requires cargo)
                checkOnSave: false,
                // Disable proc-macro expansion (requires cargo)
                procMacro: { enable: false },
                // NOTE: Do NOT set linkedProjects: [] — leaving it absent lets
                // rust-analyzer auto-discover Cargo.toml / rust-project.json
                // from the workspace rootUri.  Explicitly setting [] can cause
                // some RA versions to disable project discovery entirely.
            } : undefined;

            // Timestamp of the last didChange middleware call.
            // Declared here (before the client constructor) so the
            // middleware closure and the completion provider can both
            // access it.
            let _lastDidChangeTs = 0;

            // Pre-load any URIs in an LSP navigation response that point at
            // the worker's filesystem outside of /synthi/ (system headers,
            // stdlib source). Without this Monaco's default file service
            // tries to read e.g. /usr/include/c++/11/iostream from the
            // user's local disk and fails. We fetch via the file-sync
            // `read` op and register the content in the FS overlay so the
            // subsequent open call resolves cleanly.
            const SYSTEM_URI_RE = /^file:\/\/(?!\/synthi\/)\/[^?#]+/;
            const seenSystemPathsThisSession = new Set();

            const collectSystemUrisFromValue = (value, out) => {
                if (!value) return;
                if (typeof value === 'string') {
                    if (SYSTEM_URI_RE.test(value)) out.add(value);
                    return;
                }
                if (Array.isArray(value)) {
                    for (const v of value) collectSystemUrisFromValue(v, out);
                    return;
                }
                if (typeof value === 'object') {
                    // monaco-languageclient surfaces locations as
                    // { uri: Uri, range }, { targetUri: Uri, ... } objects
                    // where Uri has a .toString() method we want to use.
                    if (value.uri) {
                        const s = typeof value.uri === 'string' ? value.uri : value.uri.toString?.();
                        if (s && SYSTEM_URI_RE.test(s)) out.add(s);
                    }
                    if (value.targetUri) {
                        const s = typeof value.targetUri === 'string' ? value.targetUri : value.targetUri.toString?.();
                        if (s && SYSTEM_URI_RE.test(s)) out.add(s);
                    }
                    for (const k of Object.keys(value)) {
                        if (k === 'uri' || k === 'targetUri') continue;
                        collectSystemUrisFromValue(value[k], out);
                    }
                }
            };

            const preloadSystemUris = async (result) => {
                if (!result) return;
                if (!compilerClient || typeof compilerClient.readRemoteFile !== 'function') return;
                const uris = new Set();
                collectSystemUrisFromValue(result, uris);
                if (uris.size === 0) return;
                await Promise.all(Array.from(uris).map(async (uriStr) => {
                    const m = uriStr.match(/^file:\/\/(\/[^?#]+)/);
                    if (!m) return;
                    const absPath = decodeURIComponent(m[1]);
                    if (seenSystemPathsThisSession.has(absPath)) return;
                    if (hasSystemFile(absPath)) {
                        seenSystemPathsThisSession.add(absPath);
                        return;
                    }
                    try {
                        const res = await compilerClient.readRemoteFile(absPath);
                        if (res?.ok && typeof res.content === 'string') {
                            await registerSystemFile(absPath, res.content, uriStr);
                            seenSystemPathsThisSession.add(absPath);
                        } else if (res?.error) {
                            console.warn(`[LSP] readRemoteFile(${absPath}) failed: ${res.error}`);
                        }
                    } catch (e) {
                        console.warn(`[LSP] system-uri preload threw for ${absPath}:`, e?.message);
                    }
                }));
            };

            const navMiddleware = async (document, position, token, next) => {
                const result = await next(document, position, token);
                try { await preloadSystemUris(result); } catch (_) { /* best-effort */ }
                return result;
            };
            const referencesMiddleware = async (document, position, context, token, next) => {
                const result = await next(document, position, context, token);
                try { await preloadSystemUris(result); } catch (_) { /* best-effort */ }
                return result;
            };

            const languageClient = new SynthiLanguageClient({
                name: `Synthi Language Client (${backendLang})`,
                clientOptions: {
                    documentSelector: fullDocumentSelector,
                    ...(initializationOptions && { initializationOptions }),
                    middleware: {
                        // P0: Let monaco-languageclient handle the full document lifecycle
                        // natively — didOpen, didChange, didClose, didSave are all passed
                        // through to the server via next().  This enables hover, definition,
                        // references, rename, code actions, and signature help.
                        //
                        // NOTE: The middleware receives a TextDocument object (with .uri),
                        // NOT DidOpenTextDocumentParams (with .textDocument.uri).
                        didOpen: (document, next) => {
                            const uri = document.uri?.toString?.() ?? document.uri;
                            console.log('[LSP] middleware didOpen', uri);
                            autoDidOpenUris.add(uri);
                            return next(document);
                        },
                        didChange: (data, next) => {
                            _lastDidChangeTs = performance.now();
                            return next(data);
                        },
                        didClose: (document, next) => {
                            const uri = document.uri?.toString?.() ?? document.uri;
                            console.log('[LSP] middleware didClose', uri);
                            return next(document);
                        },
                        didSave: (document, next) => {
                            const uri = document.uri?.toString?.() ?? document.uri;
                            console.log('[LSP] middleware didSave', uri);
                            return next(document);
                        },
                        // Pre-load system header / stdlib source URIs so
                        // Monaco's open-editor flow doesn't try to read
                        // them from the user's local disk and fail. Hooked
                        // into every navigation response that may contain
                        // a non-/synthi/ URI.
                        provideDefinition: navMiddleware,
                        provideDeclaration: navMiddleware,
                        provideTypeDefinition: navMiddleware,
                        provideImplementation: navMiddleware,
                        provideReferences: referencesMiddleware,
                        // NOTE: provideCompletionItem middleware is NOT needed —
                        // CompletionItemFeature is skipped entirely in
                        // registerFeature() above, so the built-in bridge
                        // never registers a completion provider.  Completions
                        // are handled solely by the direct Monaco provider below.
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
                lspInitPendingRef.current.delete(clientKey);
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
                    lspInitPendingRef.current.delete(clientKey);
                    try { lspChannel.close(); } catch (_) {}
                    setLspStatus('Channel Timeout');
                    return;
                }
            }
            console.log(`[LSP] Channel ready for ${backendLang}`);
            // Disposables for the direct completion provider(s) registered
            // below.  Cleaned up when the data channel closes.
            const completionDisposables = [];


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
                // Log server capabilities for debugging completion/trigger issues
                try {
                    const caps = languageClient.initializeResult?.capabilities;
                    if (caps) {
                        console.log(`[LSP] Server capabilities for ${backendLang}:`, {
                            completionTriggerChars: caps.completionProvider?.triggerCharacters,
                            signatureHelpTriggerChars: caps.signatureHelpProvider?.triggerCharacters,
                            textDocumentSync: caps.textDocumentSync,
                        });
                    }
                } catch (_) {}
            } catch (e) {
                console.error(`[LSP] Client start failed for ${backendLang}:`, e.message || e);
                lspInitPendingRef.current.delete(clientKey);
                try { languageClient.stop(); } catch (_) {}
                try { lspChannel.close(); } catch (_) {}
                setLspStatus(`${backendLang} server unavailable`);
                return;
            }

            // Disable Monaco's built-in validation for languages where we have an LSP,
            // to avoid double diagnostics and double work on every keystroke.
            try {
                if (backendLang === 'typescript') {
                    monacoInstance.languages.typescript?.typescriptDefaults?.setDiagnosticsOptions({
                        noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true
                    });
                } else if (backendLang === 'javascript') {
                    // JS now uses typescript-language-server — disable Monaco's
                    // built-in JS IntelliSense to avoid double completions/diagnostics.
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

            // ── Direct Monaco completion provider ─────────────────
            // Sends textDocument/completion straight to the LSP server
            // over JSON-RPC, bypassing the vscode-languageclient's
            // built-in CompletionItemFeature (which is skipped in
            // registerFeature() to avoid dual-provider conflicts).
            {
                const serverTriggerChars = languageClient.initializeResult
                    ?.capabilities?.completionProvider?.triggerCharacters || [];
                const KNOWN_TRIGGERS = {
                    rust: ['.', ':', '(', '<'],
                    cpp: ['.', ':', '>', '(', '<'],
                    python: ['.', '('],
                    typescript: ['.', '(', "'", '"', '/', '<'],
                    javascript: ['.', '(', "'", '"', '/', '<'],
                    java: ['.', '(', '@'],
                    go: ['.', '('],
                    csharp: ['.', '('],
                    ruby: ['.', ':'],
                    php: ['.', '>', ':', '$', '\\'],
                    dart: ['.', '('],
                };
                const langTriggers = KNOWN_TRIGGERS[backendLang] || ['.'];
                const allTriggers = [...new Set([...serverTriggerChars, ...langTriggers])];
                console.log(`[LSP] Registering direct completion provider for ${backendLang} with triggers: ${allTriggers.join(', ')}`);

                // ── LSP ↔ Monaco position conversion ─────────────────
                // LSP positions use UTF-16 code unit offsets (0-based).
                // Monaco columns are 1-based and also UTF-16 (JS strings
                // are UTF-16), but off-by-one bugs are rampant because
                // of the +1 offset.  These helpers make the conversion
                // explicit and handle surrogate pairs correctly.

                /** LSP character (0-based UTF-16 offset) → Monaco column (1-based) */
                const lspCharToMonacoCol = (lspChar) => {
                    const n = Number(lspChar);
                    return Number.isFinite(n) && n >= 0 ? n + 1 : 1;
                };

                /** Monaco column (1-based) → LSP character (0-based UTF-16 offset) */
                const monacoColToLspChar = (monacoCol) => {
                    const n = Number(monacoCol);
                    return Number.isFinite(n) && n >= 1 ? n - 1 : 0;
                };

                /**
                 * Convert an LSP Range to a Monaco IRange.
                 * Returns null if the range is malformed.
                 */
                const lspRangeToMonaco = (range) => {
                    if (!range?.start || !range?.end) return null;
                    const sl = Math.max(1, (range.start.line ?? 0) + 1);
                    const el = Math.max(sl, (range.end.line ?? 0) + 1);
                    const sc = lspCharToMonacoCol(range.start.character ?? 0);
                    const ec = lspCharToMonacoCol(range.end.character ?? 0);
                    return {
                        startLineNumber: sl,
                        startColumn:     sc,
                        endLineNumber:   el,
                        endColumn:       ec,
                    };
                };

                const lspKindToMonaco = (kind) => {
                    const m = monacoInstance.languages.CompletionItemKind;
                    const map = {
                        1: m.Text, 2: m.Method, 3: m.Function, 4: m.Constructor,
                        5: m.Field, 6: m.Variable, 7: m.Class, 8: m.Interface,
                        9: m.Module, 10: m.Property, 11: m.Unit, 12: m.Value,
                        13: m.Enum, 14: m.Keyword, 15: m.Snippet, 16: m.Color,
                        17: m.File, 18: m.Reference, 19: m.Folder, 20: m.EnumMember,
                        21: m.Constant, 22: m.Struct, 23: m.Event, 24: m.Operator,
                        25: m.TypeParameter,
                    };
                    return map[kind] ?? m.Text;
                };

                // ── Completion generation tracking ────────────────────
                // Each completion request gets a monotonically-increasing
                // generation number tied to the model version at request
                // time.  When the response arrives, we check whether the
                // generation still matches — if not, the result is stale
                // (user kept typing) and we discard it instead of showing
                // outdated suggestions.
                let _completionGeneration = 0;
                let _currentCompletionGen = 0; // the live "latest" gen
                // Track the cancellation token source for the last completion
                // request so we can cancel it when a new one arrives.
                let _lastCompletionCts = null;
                // Debounce timer for trigger-character completions.
                // Multi-char triggers like :: -> .. fire two separate trigger
                // events in rapid succession.  Without debounce, the first
                // char triggers a wasted request at an invalid position
                // (e.g. `Vec:` instead of `Vec::`) and the second request
                // may arrive before didChange propagates.
                let _triggerDebounceTimer = null;
                const TRIGGER_DEBOUNCE_MS = 120;
                // Debounce timer for regular (Invoked / quickSuggestions)
                // completions.  Without this, every keystroke fires a
                // separate textDocument/completion request, hammering the
                // server (especially heavy ones like rust-analyzer).
                let _typingDebounceTimer = null;
                const TYPING_DEBOUNCE_MS = 180;
                // Deferred re-trigger: when all inline retries fail but the
                // server said incomplete=true, schedule a delayed re-invoke
                // of the suggest widget.  Limited to avoid infinite loops.
                let _deferredRetriggerCount = 0;
                let _pendingDeferredRetrigger = null;
                const MAX_DEFERRED_RETRIGGERS = 2;
                // Minimum gap (ms) between the last didChange notification
                // and sending a completion request.  Ensures the server has
                // time to ingest the change before we ask for completions.
                const MIN_CHANGE_GAP_MS = 30;

                // Cache the CancellationTokenSource constructor to avoid
                // a dynamic import() on every completion request.
                let _CancellationTokenSource = null;
                const getCTS = async () => {
                    if (!_CancellationTokenSource) {
                        const mod = await import('vscode-jsonrpc');
                        _CancellationTokenSource = mod.CancellationTokenSource;
                    }
                    return _CancellationTokenSource;
                };

                for (const langId of documentSelector) {
                    const disp = monacoInstance.languages.registerCompletionItemProvider(langId, {
                        triggerCharacters: allTriggers,
                        provideCompletionItems: async (model, position, context, token) => {
                            const lineText = model.getLineContent(position.lineNumber);
                            const textBeforeCursor = lineText.substring(0, position.column - 1);
                            const providerT0 = performance.now();
                            if (!languageClient.isRunning()) {
                                console.log('[LSP] provideCompletionItems: client not running, returning empty');
                                return { suggestions: [] };
                            }

                            // Determine the correct URI.  The model URI is
                            // something like file:///synthi/src/main.rs — the
                            // worker-side URI rewriter will translate this to
                            // the real server workspace path.
                            const uri = model.uri.toString();

                            // Stamp this request with a generation number.
                            // If the user types again before we get a response,
                            // _currentCompletionGen will advance and we'll
                            // discard the stale result.
                            // Prevent overflow: reset counter well before
                            // Number.MAX_SAFE_INTEGER so equality checks
                            // stay reliable.
                            if (_completionGeneration >= 0x40000000) {
                                _completionGeneration = 0;
                            }
                            const myGeneration = ++_completionGeneration;
                            _currentCompletionGen = myGeneration;

                            // Build the LSP triggerKind:
                            //  1 = Invoked (Ctrl+Space or quickSuggestions auto-trigger)
                            //  2 = TriggerCharacter (typed a trigger char like . : etc.)
                            //  3 = TriggerForIncompleteCompletions (re-query after incomplete)
                            const isTriggerChar = context.triggerKind === monacoInstance.languages.CompletionTriggerKind.TriggerCharacter;
                            const isIncompleteRetrigger = context.triggerKind === monacoInstance.languages.CompletionTriggerKind.TriggerForIncompleteCompletions;

                            // ── Debounce trigger-character completions ────────
                            // Multi-char triggers (::, ->, ..) fire two events
                            // in quick succession.  Wait a short interval to
                            // coalesce them and let didChange propagate.
                            if (isTriggerChar) {
                                // New user input — reset deferred retrigger state
                                _deferredRetriggerCount = 0;
                                if (_pendingDeferredRetrigger) {
                                    clearTimeout(_pendingDeferredRetrigger);
                                    _pendingDeferredRetrigger = null;
                                }
                                // Cancel any pending debounce timer
                                if (_triggerDebounceTimer) {
                                    clearTimeout(_triggerDebounceTimer);
                                    _triggerDebounceTimer = null;
                                }
                                await new Promise((resolve) => {
                                    _triggerDebounceTimer = setTimeout(() => {
                                        _triggerDebounceTimer = null;
                                        resolve();
                                    }, TRIGGER_DEBOUNCE_MS);
                                    // If Monaco cancels while waiting, resolve
                                    // immediately (we'll check the token below).
                                    token.onCancellationRequested(() => resolve());
                                });
                                // After debounce, check if we've been superseded
                                if (myGeneration !== _currentCompletionGen || token.isCancellationRequested) {
                                    return { suggestions: [] };
                                }
                            }

                            // ── Debounce regular typing completions ───────────
                            // quickSuggestions fires triggerKind=1 on every
                            // keystroke.  Debounce so we only send one request
                            // after the user pauses typing.
                            if (!isTriggerChar && !isIncompleteRetrigger) {
                                if (_typingDebounceTimer) {
                                    clearTimeout(_typingDebounceTimer);
                                    _typingDebounceTimer = null;
                                }
                                await new Promise((resolve) => {
                                    _typingDebounceTimer = setTimeout(() => {
                                        _typingDebounceTimer = null;
                                        resolve();
                                    }, TYPING_DEBOUNCE_MS);
                                    token.onCancellationRequested(() => resolve());
                                });
                                if (myGeneration !== _currentCompletionGen || token.isCancellationRequested) {
                                    return { suggestions: [] };
                                }
                            }

                            // ── Skip known-invalid trigger contexts ───────────
                            // After the debounce we re-read the text before the
                            // cursor.  Some single-char triggers are only valid
                            // when preceded by certain characters:
                            //  • Rust  ':' → only valid as '::' (path separator)
                            //  • C/C++ '>' → only valid as '->'
                            // Sending a request for a lone ':' or '>' wastes a
                            // round-trip and often returns 0 items.
                            //
                            // For *valid* multi-char sequences (::, ->), keep
                            // the original triggerKind=2 + triggerCharacter.
                            // rust-analyzer specifically expects triggerKind=2
                            // with ':' for :: path completions — sending as
                            // Invoked causes it to skip the trigger-char path
                            // resolution and return fewer or no results.
                            let effectiveTriggerKind = isTriggerChar ? 2 : (isIncompleteRetrigger ? 3 : 1);
                            let effectiveTriggerChar = isTriggerChar ? context.triggerCharacter : undefined;

                            if (isTriggerChar) {
                                const freshLine = model.getLineContent(position.lineNumber);
                                const freshBefore = freshLine.substring(0, position.column - 1);
                                const ch = context.triggerCharacter;
                                const prev = freshBefore.length >= 2 ? freshBefore[freshBefore.length - 2] : '';

                                const isInvalidContext =
                                    (ch === ':' && prev !== ':' && (backendLang === 'rust' || backendLang === 'cpp' || backendLang === 'c')) ||
                                    (ch === '>' && prev !== '-' && (backendLang === 'rust' || backendLang === 'cpp' || backendLang === 'c'));

                                if (isInvalidContext) {
                                    console.log(`[LSP] Skipping invalid trigger context '${prev}${ch}' for ${backendLang}`);
                                    return { suggestions: [] };
                                }


                            }

                            // We rely on the middleware passthrough for didChange
                            // to keep the server in sync.  The micro-yield above
                            // ensures the notification is flushed before we send
                            // the completion request.
                            if (token.isCancellationRequested) return { suggestions: [] };

                            // Cancel the previous in-flight completion request
                            // so the server can free resources.  The JSON-RPC
                            // layer sends $/cancelRequest automatically.
                            if (_lastCompletionCts) {
                                _lastCompletionCts.cancel();
                                _lastCompletionCts = null;
                            }

                            try {
                                // Yield at least MIN_CHANGE_GAP_MS after the
                                // last didChange so the server has time to
                                // ingest the notification before we send the
                                // completion request.
                                const sinceLast = _lastDidChangeTs > 0
                                    ? performance.now() - _lastDidChangeTs
                                    : Infinity; // No didChange yet — don't delay
                                const yieldMs = Math.max(10, MIN_CHANGE_GAP_MS - sinceLast);
                                if (yieldMs > 10) {
                                    await new Promise((r) => setTimeout(r, yieldMs));
                                }
                                if (token.isCancellationRequested || myGeneration !== _currentCompletionGen) {
                                    return { suggestions: [] };
                                }

                                // Create a cancellation source that combines Monaco's
                                // token with our own generation-based cancellation.
                                const CancellationTokenSource = await getCTS();
                                const cts = new CancellationTokenSource();
                                _lastCompletionCts = cts;

                                // If Monaco cancels, propagate to our CTS
                                const monacoDisp = token.onCancellationRequested(() => cts.cancel());

                                const t0 = performance.now();
                                const result = await languageClient.sendRequest('textDocument/completion', {
                                    textDocument: { uri },
                                    position: {
                                        line: position.lineNumber - 1,
                                        character: position.column - 1,
                                    },
                                    context: {
                                        triggerKind: effectiveTriggerKind,
                                        triggerCharacter: effectiveTriggerChar,
                                    },
                                }, cts.token);
                                const elapsed = (performance.now() - t0).toFixed(0);

                                monacoDisp.dispose();
                                cts.dispose();
                                // Clear the reference so that the *next*
                                // request does not wastefully cancel a
                                // finished CTS.
                                if (_lastCompletionCts === cts) {
                                    _lastCompletionCts = null;
                                }

                                if (!result || token.isCancellationRequested) {
                                    console.log(
                                        `[LSP] provideCompletionItems: ${!result ? 'server returned null' : 'cancelled after response'} for ${backendLang} (gen=${myGeneration}, ${elapsed}ms)`
                                    );
                                    return { suggestions: [] };
                                }

                                // ── Drop stale responses ──────────────────────
                                // If a newer completion request was issued while
                                // this one was in-flight, our generation is stale.
                                // Returning these results would overwrite the
                                // newer (correct) suggestions with outdated ones.
                                if (myGeneration !== _currentCompletionGen) {
                                    console.log(`[LSP] Dropping stale completion response for ${backendLang} (gen ${myGeneration} vs current ${_currentCompletionGen})`);
                                    return { suggestions: [] };
                                }

                                let items = Array.isArray(result) ? result : (result.items || []);
                                let isIncomplete = !Array.isArray(result) && result.isIncomplete;

                                // ── Retry on 0-item incomplete ────────────────
                                // Servers (especially rust-analyzer) may return
                                // incomplete=true with 0 items when their internal
                                // index hasn't caught up with the latest didChange.
                                // Wait a short interval and retry once.  This is
                                // critical for multi-char triggers (::, ->) where
                                // the didChange for the final character was only
                                // just sent.
                                if (items.length === 0 && isIncomplete && myGeneration === _currentCompletionGen && !token.isCancellationRequested) {
                                    // Retry with escalating delays.  rust-analyzer
                                    // cold start can take seconds to index stdlib.
                                    // Use longer delays for rust since it's heavier.
                                    //
                                    // If the server responded in under 5ms, it
                                    // hasn't even started processing — use bigger
                                    // initial delay.
                                    const instantResponse = parseFloat(elapsed) < 5;
                                    const retryDelays = (backendLang === 'rust')
                                        ? (instantResponse ? [400, 800] : [250, 500])
                                        : (instantResponse ? [250, 500] : [200, 400]);
                                    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
                                        const delay = retryDelays[attempt];
                                        console.log(`[LSP] 0 items + incomplete — retry ${attempt + 1}/${retryDelays.length} in ${delay}ms for ${backendLang} (gen=${myGeneration})`);
                                        await new Promise((r) => setTimeout(r, delay));

                                        if (myGeneration !== _currentCompletionGen || token.isCancellationRequested) {
                                            return { suggestions: [] };
                                        }

                                        const cts2 = new CancellationTokenSource();
                                        _lastCompletionCts = cts2;
                                        const monacoDisp2 = token.onCancellationRequested(() => cts2.cancel());

                                        // Use triggerKind=3 (TriggerForIncompleteCompletions)
                                        // which is the LSP-standard way to re-query after
                                        // an incomplete result.  This tells the server we're
                                        // continuing from a previous incomplete response.
                                        const retryContext = { triggerKind: 3 };

                                        const t1 = performance.now();
                                        const retryResult = await languageClient.sendRequest('textDocument/completion', {
                                            textDocument: { uri },
                                            position: {
                                                line: position.lineNumber - 1,
                                                character: position.column - 1,
                                            },
                                            context: retryContext,
                                        }, cts2.token);
                                        const retryElapsed = (performance.now() - t1).toFixed(0);

                                        monacoDisp2.dispose();
                                        cts2.dispose();
                                        if (_lastCompletionCts === cts2) _lastCompletionCts = null;

                                        if (!retryResult || token.isCancellationRequested || myGeneration !== _currentCompletionGen) {
                                            console.log(`[LSP] Retry ${attempt + 1}: ${!retryResult ? 'null' : 'stale/cancelled'} for ${backendLang} (gen=${myGeneration}, ${retryElapsed}ms)`);
                                            return { suggestions: [] };
                                        }

                                        items = Array.isArray(retryResult) ? retryResult : (retryResult.items || []);
                                        isIncomplete = !Array.isArray(retryResult) && retryResult.isIncomplete;
                                        console.log(`[LSP] Retry ${attempt + 1} returned ${items.length} items for ${backendLang} in ${retryElapsed}ms (incomplete=${!!isIncomplete})`);

                                        if (items.length > 0) break;
                                        if (!isIncomplete) break; // server says it's done
                                    }
                                }

                                if (items.length === 0) {
                                    console.log(`[LSP] provideCompletionItems: server returned 0 items for ${backendLang} (gen=${myGeneration}, ${elapsed}ms, incomplete=${!!isIncomplete})`);

                                    // If the server is still incomplete (e.g. rust-analyzer
                                    // still indexing stdlib), schedule a deferred re-trigger
                                    // of the suggest widget after a longer delay.  This gives
                                    // heavy servers time to finish analysis without blocking
                                    // the completion provider for too long.
                                    if (isIncomplete && _deferredRetriggerCount < MAX_DEFERRED_RETRIGGERS
                                        && myGeneration === _currentCompletionGen && !token.isCancellationRequested) {
                                        _deferredRetriggerCount++;
                                        const retriggerDelay = backendLang === 'rust' ? 4000 : 2000;
                                        console.log(`[LSP] Scheduling deferred suggest re-trigger ${_deferredRetriggerCount}/${MAX_DEFERRED_RETRIGGERS} in ${retriggerDelay}ms for ${backendLang}`);
                                        if (_pendingDeferredRetrigger) clearTimeout(_pendingDeferredRetrigger);
                                        _pendingDeferredRetrigger = setTimeout(() => {
                                            _pendingDeferredRetrigger = null;
                                            if (myGeneration === _currentCompletionGen && editorInstance) {
                                                editorInstance.trigger('lsp-deferred', 'editor.action.triggerSuggest', {});
                                            }
                                        }, retriggerDelay);
                                    }

                                    return { suggestions: [], incomplete: !!isIncomplete };
                                }

                                // ── Compute replacement range ──────────────────
                                // Use a PLAIN IRange object for maximum compat with
                                // @codingame/monaco-vscode-editor-api.
                                //
                                // Strategy: respect the server's textEdit range when
                                // it is a simple same-line replacement that won't
                                // break Monaco's prefix filtering.  Fall back to the
                                // word-based range when the edit spans multiple lines
                                // or when the server range start is AFTER the cursor
                                // (InsertReplaceEdit edge-case).
                                const word = model.getWordUntilPosition(position);
                                let rangeStartCol = word.word.length > 0
                                    ? word.startColumn
                                    : position.column;

                                // When the word is empty (cursor right after :: . ->),
                                // the default range is zero-width and Monaco has no
                                // prefix to match against.  Widen it to include the
                                // preceding separator chain so items can still show.
                                if (word.word.length === 0 && position.column > 1) {
                                    const lineText = model.getLineContent(position.lineNumber);
                                    const textBefore = lineText.substring(0, position.column - 1);
                                    // Walk backwards past separator chars (::, ., ->)
                                    const sepMatch = textBefore.match(/[.:>-]+$/);
                                    if (sepMatch) {
                                        // Include the identifier before the separator
                                        const beforeSep = textBefore.substring(0, textBefore.length - sepMatch[0].length);
                                        const identMatch = beforeSep.match(/[\w$]+$/);
                                        if (identMatch) {
                                            // Don't move startCol — keep it at cursor.
                                            // The filterText for items after :: should
                                            // match against an empty prefix (all items show).
                                            // But if the server provides a textEdit that
                                            // starts before the separator, safeServerRange
                                            // will handle it.
                                        }
                                    }
                                }

                                const defaultRange = {
                                    startLineNumber: position.lineNumber,
                                    startColumn: rangeStartCol,
                                    endLineNumber: position.lineNumber,
                                    endColumn: position.column,
                                };

                                /**
                                 * Try to extract a Monaco-safe range from the server's
                                 * textEdit.  Returns null if the edit is unsuitable.
                                 *
                                 * Safety checks (all must pass):
                                 *  1. Same-line edit only
                                 *  2. Range start ≤ cursor (not after)
                                 *  3. Range end doesn't extend unreasonably past cursor
                                 *     when the word at cursor doesn't match the server's
                                 *     range (filter misalignment)
                                 *  4. Range start aligns with the word boundary Monaco
                                 *     would compute, OR is before it (for dotted chains)
                                 */
                                const safeServerRange = (textEdit) => {
                                    if (!textEdit) return null;

                                    // LSP defines two edit shapes:
                                    //   TextEdit:           { range, newText }
                                    //   InsertReplaceEdit:  { insert, replace, newText }
                                    // For InsertReplaceEdit, prefer the `insert` range
                                    // (narrower, doesn't overwrite text after cursor)
                                    // so Monaco's prefix filtering stays aligned.
                                    const isInsertReplace = !textEdit.range && (textEdit.insert || textEdit.replace);
                                    const range = isInsertReplace
                                        ? (textEdit.insert || textEdit.replace)
                                        : textEdit.range;
                                    if (!range?.start || !range?.end) return null;

                                    // Use UTF-16 aware conversion
                                    const startLine = range.start.line + 1;
                                    const endLine   = range.end.line + 1;
                                    const startCol  = lspCharToMonacoCol(range.start.character);
                                    const endCol    = lspCharToMonacoCol(range.end.character);

                                    // Rule 1: same-line only
                                    if (startLine !== position.lineNumber) return null;
                                    if (endLine   !== position.lineNumber) return null;

                                    // Rule 2: range start must not be after cursor
                                    if (startCol  >  position.column)      return null;

                                    // Rule 3: reject ranges that extend far past the
                                    // cursor when the current word doesn't cover that
                                    // span.  A server might return endCol way past the
                                    // cursor for replace-style edits; Monaco uses the
                                    // range to compute the typed prefix for filtering,
                                    // so a mismatch silently filters ALL items.
                                    if (endCol > position.column) {
                                        // How far past the cursor does the server range go?
                                        const overreach = endCol - position.column;
                                        // How far past the cursor does Monaco's word go?
                                        const wordEnd = word.endColumn; // 1-based, end of word at cursor
                                        const wordOverreach = Math.max(0, wordEnd - position.column);
                                        // If the server extends further than the word, it's
                                        // likely a replace-range that won't match filtering.
                                        if (overreach > wordOverreach + 1) return null;
                                    }

                                    // Rule 4: if the server range starts well before
                                    // the word boundary AND the text between range-start
                                    // and word-start isn't just dots/colons/arrows,
                                    // fall back (avoids mangling unrelated code).
                                    if (startCol < word.startColumn && word.word.length > 0) {
                                        const gapText = lineText.substring(startCol - 1, word.startColumn - 1);
                                        // Allow common chain separators: `.` `::` `->`
                                        if (!/^[.:\->]+$/.test(gapText)) return null;
                                    }

                                    const result = {
                                        startLineNumber: startLine,
                                        startColumn: startCol,
                                        endLineNumber: endLine,
                                        endColumn: endCol,
                                    };

                                    // For InsertReplaceEdit, also compute the replace
                                    // range and return { inserting, replacing } if the
                                    // replace range differs (Monaco supports this format).
                                    if (isInsertReplace && textEdit.replace) {
                                        const rep = textEdit.replace;
                                        if (rep?.start && rep?.end) {
                                            const repEndCol = lspCharToMonacoCol(rep.end.character);
                                            if (repEndCol !== endCol) {
                                                return {
                                                    inserting: result,
                                                    replacing: {
                                                        startLineNumber: startLine,
                                                        startColumn: startCol,
                                                        endLineNumber: rep.end.line + 1,
                                                        endColumn: repEndCol,
                                                    },
                                                };
                                            }
                                        }
                                    }

                                    return result;
                                };

                                const suggestions = items.map((item, idx) => {
                                    // Handle both plain string labels and structured
                                    // CompletionItemLabelDetails ({ label, detail, description })
                                    const label = typeof item.label === 'string'
                                        ? item.label
                                        : item.label?.label || '';
                                    const labelDetail = typeof item.label === 'object'
                                        ? item.label?.detail || ''
                                        : '';
                                    const labelDescription = typeof item.label === 'object'
                                        ? item.label?.description || ''
                                        : '';

                                    // Convert LSP documentation to Monaco format
                                    let doc = item.documentation;
                                    if (doc && typeof doc === 'object' && doc.value) {
                                        doc = { value: doc.value };
                                    }

                                    // Determine insertText — prefer textEdit.newText
                                    const insertText = item.textEdit?.newText
                                        || item.insertText
                                        || label;

                                    // Snippet support: insertTextFormat 2 = Snippet
                                    const isSnippet = item.insertTextFormat === 2;
                                    const insertTextRules = isSnippet
                                        ? monacoInstance.languages.CompletionItemInsertTextRule.InsertAsSnippet
                                        : undefined;

                                    // Prefer server textEdit range when it's safe
                                    const serverRange = safeServerRange(item.textEdit);
                                    const range = serverRange || defaultRange;

                                    // Respect the server's filterText — it knows which
                                    // characters match the typed prefix (e.g. snake_case
                                    // vs camelCase, re-exports, etc.).  Only fall back
                                    // to the label when truly absent.
                                    const filterText = item.filterText || label;

                                    return {
                                        label: labelDetail
                                            ? { label, detail: labelDetail, description: labelDescription }
                                            : label,
                                        kind: lspKindToMonaco(item.kind),
                                        detail: item.detail || '',
                                        documentation: doc,
                                        insertText,
                                        insertTextRules,
                                        range,
                                        sortText: item.sortText || String(idx).padStart(5, '0'),
                                        filterText,
                                        preselect: item.preselect,
                                        commitCharacters: item.commitCharacters,
                                        // Attach original LSP item for resolveCompletionItem
                                        data: item.data,
                                        _lspItem: item,
                                    };
                                });

                                // ── Final cancellation check ──────────────────
                                // A new trigger-character keystroke may have fired
                                // between our await and now.  If the token is
                                // cancelled, Monaco will discard our result anyway,
                                // so bail early to avoid confusing the suggest model.
                                if (token.isCancellationRequested) {
                                    console.log(`[LSP] Completion for ${backendLang} cancelled after mapping ${suggestions.length} items — discarding`);
                                    return { suggestions: [] };
                                }

                                // Successful completion — reset deferred retrigger state
                                _deferredRetriggerCount = 0;
                                if (_pendingDeferredRetrigger) {
                                    clearTimeout(_pendingDeferredRetrigger);
                                    _pendingDeferredRetrigger = null;
                                }

                                const totalMs = (performance.now() - providerT0).toFixed(0);
                                console.log(`[LSP] completion ${backendLang}: ${suggestions.length} items, ${elapsed}ms server / ${totalMs}ms total`);
                                return { suggestions, incomplete: !!isIncomplete };
                            } catch (err) {
                                // Ensure the CTS is cleaned up on error too,
                                // otherwise a failed request blocks future
                                // cancel logic from seeing a null slot.
                                if (_lastCompletionCts) {
                                    try { _lastCompletionCts.dispose(); } catch (_) { /* already disposed */ }
                                    _lastCompletionCts = null;
                                }
                                const msg = err?.message || String(err);
                                const code = err?.code;

                                // JSON-RPC cancellation / lifecycle codes:
                                // -32800 = RequestCancelled
                                // -32802 = ServerCancelled
                                // -32803 = RequestFailed (server busy)
                                // Also match common message strings from various
                                // JSON-RPC libraries.
                                const isCancellation =
                                    code === -32800 || code === -32802 || code === -32803 ||
                                    msg === 'Canceled' || msg === 'cancelled' ||
                                    msg.includes('Request failed');
                                if (isCancellation) {
                                    return { suggestions: [] };
                                }

                                // JSON-RPC -32801 = ContentModified — the server
                                // is still processing a didChange.  Retry once
                                // after a delay.
                                if (code === -32801 && myGeneration === _currentCompletionGen && !token.isCancellationRequested) {
                                    console.log(`[LSP] ContentModified from ${backendLang} — retrying in 300ms (gen=${myGeneration})`);
                                    try {
                                        await new Promise((r) => setTimeout(r, 300));
                                        if (myGeneration !== _currentCompletionGen || token.isCancellationRequested) {
                                            return { suggestions: [] };
                                        }
                                        const CancellationTokenSource = await getCTS();
                                        const cts3 = new CancellationTokenSource();
                                        _lastCompletionCts = cts3;
                                        const monacoDisp3 = token.onCancellationRequested(() => cts3.cancel());
                                        const retryResult = await languageClient.sendRequest('textDocument/completion', {
                                            textDocument: { uri },
                                            position: { line: position.lineNumber - 1, character: position.column - 1 },
                                            context: { triggerKind: 1 },
                                        }, cts3.token);
                                        monacoDisp3.dispose();
                                        cts3.dispose();
                                        if (_lastCompletionCts === cts3) _lastCompletionCts = null;
                                        if (!retryResult || token.isCancellationRequested || myGeneration !== _currentCompletionGen) {
                                            return { suggestions: [] };
                                        }
                                        const retryItems = Array.isArray(retryResult) ? retryResult : (retryResult.items || []);
                                        console.log(`[LSP] ContentModified retry: ${retryItems.length} items from ${backendLang}`);
                                        // Return incomplete=true so Monaco will
                                        // re-trigger completions on next keystroke
                                        // and pick up the full results then.
                                        return { suggestions: [], incomplete: true };
                                    } catch (retryErr) {
                                        const retryMsg = retryErr?.message || '';
                                        if (retryMsg !== 'Canceled' && retryMsg !== 'cancelled') {
                                            console.warn(`[LSP] ContentModified retry failed for ${backendLang}:`, retryMsg);
                                        }
                                        return { suggestions: [] };
                                    }
                                }

                                console.warn(`[LSP] Direct completion error for ${backendLang}:`, msg, code ? `(code=${code})` : '');
                                return { suggestions: [] };
                            }
                        },
                        resolveCompletionItem: async (item, token) => {
                            // Ask the LSP server for full documentation/detail.
                            // This is called lazily when the user highlights an
                            // item in the suggest widget.
                            if (!languageClient.isRunning() || !item._lspItem) return item;
                            try {
                                const resolved = await languageClient.sendRequest(
                                    'completionItem/resolve', item._lspItem
                                );
                                if (!resolved || token.isCancellationRequested) return item;

                                // Merge resolved fields back into the Monaco item
                                if (resolved.documentation) {
                                    let doc = resolved.documentation;
                                    if (doc && typeof doc === 'object' && doc.value) doc = { value: doc.value };
                                    item.documentation = doc;
                                }
                                if (resolved.detail) item.detail = resolved.detail;
                                // Some servers refine insertText on resolve
                                if (resolved.insertText && resolved.insertText !== item.insertText) {
                                    item.insertText = resolved.insertText;
                                }
                                if (resolved.additionalTextEdits) {
                                    item.additionalTextEdits = resolved.additionalTextEdits
                                        .map(e => {
                                            const r = lspRangeToMonaco(e.range);
                                            if (!r) return null;
                                            return { range: r, text: e.newText };
                                        })
                                        .filter(Boolean);
                                }
                            } catch (err) {
                                // Resolve is best-effort — log but don't fail
                                const msg = err?.message || '';
                                if (msg !== 'Canceled' && msg !== 'cancelled') {
                                    console.warn(`[LSP] resolveCompletionItem error:`, msg);
                                }
                            }
                            return item;
                        },
                    });
                    completionDisposables.push(disp);
                }
            }

            // ── Fallback didOpen for the active file ────────────────
            // monaco-languageclient auto-sends didOpen for matching models
            // after start().  However, when @codingame/monaco-vscode-api is
            // active the internal TextDocument wrapper may have cached the
            // old 'plaintext' languageId at model-creation time, causing the
            // documentSelector to miss the file even after setModelLanguage.
            // Detect this and send a manual didOpen as a safety net.
            //
            // Wait a tick for auto-didOpen to propagate through middleware
            // before checking — start() can resolve before didOpen fires.
            await new Promise(r => setTimeout(r, 200));
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
                                // Use version 1 (not getVersionId() which can
                                // be very large after many edits).  The worker
                                // tracks versions — starting high would make
                                // all subsequent didChange versions look out-
                                // of-order and get rejected.
                                version: 1,
                                text: content,
                            }
                        });
                    } catch (e) {
                        console.warn('[LSP] Manual didOpen failed:', e.message);
                    }
                }
                // Track the URI so the reuse path can send didClose on file switch
                lspOpenedUrisRef.current.set(clientKey, { uri: activeUri, languageId: lang });
            }

            // ── Multi-file workspace priming ──────────────────────
            // Most LSP servers auto-discover workspace files from the
            // rootUri and their own file watchers (gopls, rust-analyzer,
            // jdtls, clangd, etc.).  Sending didOpen for files not
            // actively edited is non-standard — some servers treat
            // didOpen as "actively edited" which wastes memory and can
            // trigger expensive per-file analysis.
            //
            // Only servers that genuinely need priming (TS/JS, Python)
            // get a limited didOpen blast.  All others rely on disk
            // discovery via rootUri / workspaceFolders.
            // Check both backendLang and clientKey so languages that share
            // a server (e.g. JS shares with TS via clientKey='typescript')
            // still get primed even if only one variant is listed.
            const SERVERS_NEEDING_PRIMING = new Set(['typescript', 'javascript', 'python']);

            if (SERVERS_NEEDING_PRIMING.has(backendLang) || SERVERS_NEEDING_PRIMING.has(clientKey)) {
                setTimeout(() => {
                    if (!languageClient.isRunning()) return;

                    const cacheMap = new Map(fileCacheEntries || []);
                    const allFiles = [];
                    const walk = (nodes) => {
                        if (!nodes) return;
                        for (const node of nodes) {
                            if (node.isFolder) {
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

                    const langSet = new Set(documentSelector);
                    const activeUri = editorInstance.getModel()?.uri?.toString();
                    const MAX_BLAST_FILES = 15;
                    const BATCH_SIZE = 3;
                    const BATCH_DELAY_MS = 300;

                    const filesToOpen = [];
                    for (const file of allFiles) {
                        if (filesToOpen.length >= MAX_BLAST_FILES) break;
                        const fileLang = getMonacoLanguage(file.name);
                        if (!langSet.has(fileLang)) continue;
                        const fileUri = `file:///synthi/${file.path}`;
                        if (fileUri === activeUri) continue;
                        const content = cacheMap.get(file.path);
                        if (!content) continue;
                        filesToOpen.push({ uri: fileUri, lang: fileLang, content });
                    }

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
                    console.log(`[LSP] Priming blast queued: ${filesToOpen.length} files for ${backendLang}`);
                }, 800);
            } else {
                console.log(`[LSP] Skipping didOpen blast for ${backendLang} — server auto-indexes via rootUri`);
            }

            // P1: Since middleware now passes didChange through to next(), monaco-languageclient
            // handles sync natively and will respect the server's textDocumentSync capability.
            // No manual onDidChangeModelContent handler needed — avoids double-sending.
            // We keep a no-op disposable for the cleanup in the close handler.
            const changeDisposable = { dispose: () => {} };

            languageClientsRef.current.set(clientKey, languageClient);
            lspInitPendingRef.current.delete(clientKey);
            setLspStatus(`Ready (${backendLang})`);

            // ── Start supplementary (augmentation) LSP servers ────────
            // After the primary LSP client is ready, check if any
            // supplementary servers should also be started for this
            // language (e.g. ESLint for JS/TS, Tailwind for CSS/HTML).
            // These run as separate WebRTC channels and provide
            // additional diagnostics/completions alongside the primary
            // server.
            for (const [suppKey, suppConfig] of Object.entries(SUPPLEMENTARY_SERVERS)) {
                if (!suppConfig.activatesOn.includes(lang)) continue;
                if (languageClientsRef.current.has(suppConfig.clientKey)) continue;
                if (lspInitPendingRef.current.has(suppConfig.clientKey)) continue;

                // Check if this supplementary server is enabled via lspRegistry
                // (i.e. the user has the corresponding extension installed)
                const registry = (typeof window !== 'undefined' && window.__synthiLspRegistry) || {};
                const isRegistered = registry[suppKey] || suppConfig.activatesOn.some(l => {
                    const entry = registry[l];
                    return entry && entry.backend === suppConfig.backend;
                });
                // Also check if the server is explicitly in LSP_LANG_TABLE
                // (it was moved out to SUPPLEMENTARY_SERVERS but the backend
                // route still exists on the worker)
                if (!isRegistered && !LSP_LANG_TABLE[suppKey]) {
                    // Server not registered — user hasn't installed the extension.
                    // Still start it if the backend is known (the worker has it).
                    // This allows supplementary servers to work out-of-the-box.
                }

                console.log(`[LSP] Starting supplementary server: ${suppConfig.backend} for primary language ${lang}`);
                lspInitPendingRef.current.add(suppConfig.clientKey);

                // Fire-and-forget: start the supplementary server asynchronously
                // so it doesn't block the primary server's completion provider.
                (async () => {
                    try {
                        const suppChannel = compilerClient.createLspChannel(suppConfig.backend);
                        const suppAdapter = new MonacoSocketAdapter(suppChannel);
                        const suppRawSocket = toSocket(suppAdapter);
                        const suppReader = new WebSocketMessageReader(suppRawSocket);
                        const suppWriter = new WebSocketMessageWriter(suppRawSocket);

                        const { MonacoLanguageClient } = await import('monaco-languageclient');

                        const suppDocSelector = [
                            ...suppConfig.selector.map(l => ({ language: l, scheme: 'file' })),
                            ...suppConfig.selector.flatMap(l =>
                                (LANG_TO_GLOB[l] || []).map(pattern => ({ scheme: 'file', pattern }))
                            ),
                        ];

                        // ESLint server requires specific initializationOptions
                        const suppInitOpts = suppConfig.backend === 'eslint' ? {
                            run: 'onType',
                            validate: 'on',
                            experimental: { useFlatConfig: false },
                        } : suppConfig.backend === 'tailwindcss' ? {
                            // Tailwind needs to know about the user's config
                            userLanguages: Object.fromEntries(
                                suppConfig.selector.map(l => [l, l === 'javascript' || l === 'typescript' ? 'html' : l])
                            ),
                        } : undefined;

                        class SupplementaryClient extends MonacoLanguageClient {
                            fillInitializeParams(params) {
                                super.fillInitializeParams(params);
                                params.rootUri = "file:///synthi/";
                                params.workspaceFolders = [{
                                    uri: "file:///synthi/",
                                    name: "synthi"
                                }];
                            }
                        }

                        const suppClient = new SupplementaryClient({
                            name: `Synthi Supplementary LSP (${suppConfig.backend})`,
                            clientOptions: {
                                documentSelector: suppDocSelector,
                                ...(suppInitOpts && { initializationOptions: suppInitOpts }),
                                middleware: {
                                    didOpen: (doc, next) => next(doc),
                                    didChange: (data, next) => next(data),
                                    didClose: (doc, next) => next(doc),
                                    didSave: (doc, next) => next(doc),
                                },
                                errorHandler: {
                                    error: () => ({ action: ErrorAction.Continue }),
                                    closed: () => ({ action: CloseAction.DoNotRestart }),
                                },
                                workspaceFolder: {
                                    uri: monacoInstance.Uri.parse('file:///synthi/'),
                                    name: 'synthi',
                                    index: 0
                                }
                            },
                            messageTransports: { reader: suppReader, writer: suppWriter }
                        });

                        // Wait for channel to open
                        if (suppAdapter.readyState !== 1) {
                            await suppAdapter.waitUntilOpen(15000);
                        }

                        // Start with timeout
                        await Promise.race([
                            suppClient.start(),
                            new Promise((_, reject) =>
                                setTimeout(() => reject(new Error(`${suppConfig.backend} server timeout`)), 30000)
                            )
                        ]);

                        languageClientsRef.current.set(suppConfig.clientKey, suppClient);
                        lspInitPendingRef.current.delete(suppConfig.clientKey);
                        console.log(`[LSP] Supplementary server ${suppConfig.backend} ready`);

                        // Clean up on channel close
                        suppChannel.addEventListener('close', async () => {
                            console.log(`[LSP] Supplementary channel closed: ${suppConfig.backend}`);
                            if (suppClient.isRunning()) {
                                try {
                                    await Promise.race([
                                        suppClient.sendRequest('shutdown'),
                                        new Promise((_, rej) => setTimeout(() => rej(), 3000))
                                    ]);
                                    suppClient.sendNotification('exit');
                                } catch (_) {}
                            }
                            suppClient.stop();
                            languageClientsRef.current.delete(suppConfig.clientKey);
                            lspInitPendingRef.current.delete(suppConfig.clientKey);
                        });
                    } catch (e) {
                        console.warn(`[LSP] Supplementary server ${suppConfig.backend} failed:`, e.message);
                        lspInitPendingRef.current.delete(suppConfig.clientKey);
                    }
                })();
            }

            // Use addEventListener instead of setting onclose directly so
            // we don't overwrite MonacoSocketAdapter's own close handler.
            lspChannel.addEventListener('close', async () => {
                console.log(`[LSP] Channel closed for ${backendLang}`);
                completionDisposables.forEach(d => d.dispose());
                changeDisposable.dispose();
                // Clean up any pending debounce timer.
                // Guard with try/catch: Turbopack code-splitting can
                // occasionally hoist this handler into a chunk where the
                // `let` bindings from the parent .then() are absent.
                try {
                    if (typeof _triggerDebounceTimer !== 'undefined' && _triggerDebounceTimer) {
                        clearTimeout(_triggerDebounceTimer);
                        _triggerDebounceTimer = null;
                    }
                } catch (_) {}
                // Dispose the CTS if a request was in-flight
                try {
                    if (typeof _lastCompletionCts !== 'undefined' && _lastCompletionCts) {
                        _lastCompletionCts.dispose();
                        _lastCompletionCts = null;
                    }
                } catch (_) {}

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
                languageClientsRef.current.delete(clientKey);
                lspInitPendingRef.current.delete(clientKey);
                lspOpenedUrisRef.current.delete(clientKey);
                lspSyncCapRef.current.delete(clientKey);
                setLspStatus('Disconnected');
            });
        }).catch(e => {
            console.error(`[LSP] Init failed for ${backendLang}:`, e);
            lspInitPendingRef.current.delete(clientKey);
            try { lspChannel.close(); } catch (_) {}
        });

    }, [monacoInstance, compilerClient, compilerStatus, activeFile, editorInstance, servicesReady]);

    // Dynamically sync read-only state when collab permissions change mid-session
    useEffect(() => {
        if (!editorInstance) return;
        editorInstance.updateOptions({ readOnly: isCollabReadOnly });
    }, [editorInstance, isCollabReadOnly]);

    // Hook up Yjs-based collaboration when an editor and activeFile are present.
    useEffect(() => {
        if (!editorInstance || !monacoInstance || !paneFile || !slug || isPrivateMode) {
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
        const isConflicted = conflictedFiles.includes(paneFile.path);
        if (isConflicted) {
            console.log('[Collab] Skipping Yjs binding for conflicted file:', paneFile.path);
            // Destroy any existing collab doc for this file to ensure fresh content
            try { collabClient.destroyDocument(slug, paneFile.path); } catch (e) { /* ignore */ }
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

        const user = (session?.data?.user) ? { id: session.data.user.id || session.data.user.email || session.data.user.name, name: session.data.user.name || (session.data.user.email ? session.data.user.email.split('@')[0] : null) || 'Anonymous', email: session.data.user.email || null, image: session.data.user.image || null, isAnonymous: false } : { id: null, name: 'Anonymous', email: null, image: null, isAnonymous: true };

        // Attach the editor to the collaboration binding
        // IMPORTANT: Get content from file cache for THIS specific file path
        // Do NOT use `code` as it may still contain content from the previous file
        // during the transition between files.
        try {
            const showLineDecorations = (presenceGranularity === 'line');
            // Get content specifically for this file from the cache
            const cachedContent = fileCacheEntries.find(([path]) => path === paneFile.path)?.[1];
            const initialContent = typeof cachedContent === 'string' ? cachedContent : (isFocusedPane && typeof code === 'string' ? code : '');
            
            const bindingHandle = collabClient.attachEditor({ 
                editor: editorInstance, 
                monaco: monacoInstance, 
                slug, 
                path: paneFile.path,
                user, 
                initialContent,
                options: { showLineDecorations } 
            });
            collabBindingRef.current = bindingHandle;
            boundFilePathRef.current = paneFile.path; // Track which file we're bound to
            setCollabConnected(true); // Mark collab as connected
            
            // CRITICAL: After the binding is established, the model content
            // may differ from Redux (e.g. Yjs has unsaved edits from a
            // previous session that were seeded via model.setValue, which
            // our isFlush guard intentionally skips).  Do a one-time sync
            // so Redux currentContent matches what the user sees.
            const modelContent = editorInstance.getModel()?.getValue() ?? '';
            if (isFocusedPane && modelContent && modelContent !== code) {
                dispatch(updateContent(modelContent));
            }
            
            // Sync initial unsaved state
            bindingHandle.updateLocalUnsaved(isUnsaved);

            // Listen for remote unsaved changes
            const awarenessUnsub = collabClient.addAwarenessListener(slug, paneFile.path, (states) => {
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
    }, [editorInstance, monacoInstance, paneFile, slug, session, authUserId, presenceGranularity, isPrivateMode, conflictedFiles, collabHostId]);

    // ── Ghost-revert fix ─────────────────────────────────────────────────
    // Listen for server-side 'file-reverted' events (emitted after discard,
    // pull, checkout, or any operation that changes files on disk).
    // When the active file was reverted:
    //   1. Tear down the Yjs binding so stale dirty content can't re-flush
    //   2. Re-fetch the clean content via selectFileThunk (which reads disk)
    //   3. Reset the Monaco model to the clean content
    // A revert lock prevents CRDT content from being applied during the
    // transition window, eliminating brief content duplication on pull.
    const revertLockRef = useRef(false);
    useEffect(() => {
        const handler = async (ev) => {
            const { slug: evSlug, filePaths } = ev.detail || {};
            if (evSlug !== slug) return;

            const allFiles = !filePaths || filePaths.length === 0;
            const affectsActive = allFiles
                || (activeFile && filePaths.includes(activeFile.path));

            if (!affectsActive || !activeFile) return;

            console.log('[Editor] file-reverted received for', activeFile.path, '— resetting editor');

            // ── Revert lock: prevent stale CRDT content from being applied
            // during the transition.  The lock is checked by handleCodeChange
            // and the collab binding observer.
            revertLockRef.current = true;

            // 0. Snapshot current model content BEFORE teardown so we can
            //    immediately restore it after the Yjs binding is destroyed.
            //    This prevents the visible blank flash while selectFileThunk
            //    fetches fresh content from the server.
            const preRevertSnapshot = (() => {
                try { return editorInstance?.getModel?.()?.getValue?.() ?? null; } catch (_) { return null; }
            })();

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

            // 4. Yield to microtask queue so collabClient.destroyAllForSlug
            //    (fired by the notification handler) finishes before we
            //    re-create a fresh provider. No artificial delay needed —
            //    the destroy already ran synchronously in the notification
            //    handler before this DOM event was dispatched.
            await new Promise(r => queueMicrotask(r));

            // 4b. Clear the Monaco model completely BEFORE fetching fresh
            //     content.  Using applyEdits (not pushEditOperations) so we
            //     don't pollute the undo stack.  This prevents any stale
            //     CRDT merge from appending to old content on reconnect. 
            //     Show the pre-revert snapshot as placeholder to avoid blank.
            try {
                const modelNow = editorInstance?.getModel?.();
                if (modelNow && preRevertSnapshot !== null) {
                    modelNow.applyEdits([{
                        range: modelNow.getFullModelRange(),
                        text: preRevertSnapshot,
                    }]);
                    latestCodeRef.current = preRevertSnapshot;
                }
            } catch (_) {}

            // 5. Re-select the file — this fetches clean content from the
            //    server and updates Redux (savedContent, currentContent).
            //    It also triggers the collab binding effect to re-run, which
            //    will create a fresh Yjs provider seeded from disk content.
            await dispatch(selectFileThunk(activeFile));

            // 6. Force-set the Monaco model to the clean content so the editor
            //    doesn't flash stale text before the binding kicks in.
            //    Use model.setValue() for a complete replacement — this ensures
            //    no residual CRDT merge content survives the transition.
            let freshContent = null;
            try {
                const model = editorInstance?.getModel?.();
                if (model) {
                    const next = store.getState()?.workspace?.currentContent;
                    if (typeof next === 'string') {
                        freshContent = next;
                        model.setValue(next);
                        latestCodeRef.current = next;
                    } else {
                        latestCodeRef.current = model.getValue();
                    }
                }
            } catch (_) {}

            // 7. Force-seed the CRDT with disk content once the new binding
            //    is attached.  Without this, if Y-Sweet's server-side state
            //    still holds the pre-restore content (resetDocContent on the
            //    backend silently no-ops on older SDKs that lack updateDoc),
            //    the worker reconnects, syncs that stale content, and overwrites
            //    Monaco — causing the restored version to flicker back to the
            //    pre-restore buffer with an "unsaved" dot.  resetDocument() does
            //    a LOCAL transact (delete + insert) whose delta propagates to
            //    Y-Sweet as a normal local change, making disk content the
            //    canonical room state regardless of what Y-Sweet had before.
            if (typeof freshContent === 'string' && activeFile?.path) {
                const targetPath = activeFile.path;
                let attempts = 0;
                const trySeed = () => {
                    attempts += 1;
                    const key = collabClient.getRoomKey?.(slug, targetPath);
                    const entry = key ? collabClient.docs.get(key) : null;
                    if (entry) {
                        try { collabClient.resetDocument(slug, targetPath, freshContent); } catch (_) {}
                        return;
                    }
                    if (attempts < 30) setTimeout(trySeed, 100);
                };
                setTimeout(trySeed, 150);
            }

            // 8. Release the revert lock after a longer settling period to
            //    cover the Yjs provider reconnect + initial sync + force-seed
            //    round-trip.  600ms was too short — a remote delta arriving
            //    after release would dispatch updateContent with stale text and
            //    re-flag the file as unsaved.
            setTimeout(() => { revertLockRef.current = false; }, 3000);
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

        // Patch console.error to suppress ONLY the known-harmless "Canceled"
        // logs from Monaco/vscode-api internals.  The previous filter was too
        // broad — it swallowed real LSP pipeline errors that happened to
        // contain the word "Canceled", making transport failures invisible.
        const originalError = console.error;
        console.error = (...args) => {
            if (args.length > 0) {
                const first = args[0];
                // Suppress bare "Canceled" strings (Monaco dispose noise)
                if (first === 'Canceled') return;
                // Suppress CancellationError objects (vscode-api internals)
                if (first?.name === 'CancellationError' || (first?.constructor?.name === 'CancellationError')) return;
                // DO NOT suppress strings that merely *contain* "Canceled"
                // — those often carry important diagnostic context like
                // "Response handler 'textDocument/completion' failed: Canceled"
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
    // File-identity derivations follow the PANE'S file (paneFile), not the
    // global activeFile — so each docked editor view tokenizes, re-keys its
    // model, and renders the icon for the file IT is showing.
    const activeLanguage = paneFile ? getMonacoLanguage(paneFile.name) : 'plaintext';
    const activeFileIdentity = paneFile ? `${paneFile.path ?? ''}-${paneFile.name ?? ''}` : 'no-file';
    const activeFileIcon = paneFile ? getFileIcon(paneFile.name || paneFile.path || '') : null;

    // Pre-create/switch Monaco models when activeFile changes.
    // This eliminates the 1-second blank flash by reusing cached models
    // instead of destroying and recreating the editor.
    useEffect(() => {
        if (!editorInstance || !monacoInstance || !paneFile) return;
        // System headers (isSystem=true, e.g. /usr/include/c++/11/iostream)
        // live in the worker's filesystem, not under /synthi/. Use URI.file
        // so the model URI matches what SynthiFileSystemProvider registered
        // via registerSystemFile — otherwise Monaco's default file service
        // tries to read /synthi/usr/include/... from local disk and fails.
        const uri = paneFile.isSystem
            ? monacoInstance.Uri.file(paneFile.path)
            : monacoInstance.Uri.parse(`file:///synthi/${paneFile.path.startsWith('/') ? paneFile.path.slice(1) : paneFile.path}`);
        let model = monacoInstance.editor.getModel(uri);
        if (!model) {
            // Pre-create the model with cached content so there's no blank.
            // Only the focused pane may seed from the global `code` buffer; an
            // unfocused pane showing a different file must NOT inherit it.
            const cachedContent = fileCacheEntries.find(([p]) => p === paneFile.path)?.[1];
            const initialContent = typeof cachedContent === 'string' ? cachedContent : (isFocusedPane ? (code ?? '') : '');
            const lang = getMonacoLanguage(paneFile.name);
            model = monacoInstance.editor.createModel(initialContent, lang || 'plaintext', uri);
        }
        // Switch to the model atomically — no blank flash
        const currentModel = editorInstance.getModel();
        if (currentModel !== model) {
            editorInstance.setModel(model);
        }
        // Correct model language if needed
        if (activeLanguage && activeLanguage !== 'plaintext' && model.getLanguageId() !== activeLanguage) {
            monacoInstance.editor.setModelLanguage(model, activeLanguage);
        }
        // Disconnect collab binding for previous file — the collab effect below will re-bind
        setCollabConnected(false);
    }, [activeFileIdentity]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // Lazy getter: avoids recreating the inline-completion callback every
        // time the file cache mutates. The hook reads through this ref on
        // each request so it always sees the latest workspace contents.
        getFileCacheEntries: () => fileCacheEntriesRef.current || [],
        workspaceSlug: slug,
        hasActiveDiff: () => false,
    });

    // --- Next-Edit Prediction (NEP) — Phase 1, feature-flagged off by default ---
    // Enable via NEXT_PUBLIC_NEXT_EDIT_PREDICTION=1 or window.__SYNTHI_NEP_ENABLED__.
    // Forward ref for persistNepApply, which is defined further down because
    // it depends on `compilerClient` (a useState) and shares structure with
    // handleSave. The ref lets the NEP hook above call into it without us
    // having to hoist the whole save pipeline above the hook chain.
    const persistNepApplyRef = useRef(null);
    const {
        predictedPaths: nepPredictedPaths,
        fireCapReached: nepFireCapReached,
        fireCap: nepFireCap,
    } = useNextEditPrediction({
        editorInstance,
        monacoInstance,
        activeFile,
        activeLanguage,
        workspaceSlug: slug,
        // Cross-file unblock: NEP can now decorate predictions targeting
        // any file (not just the active one) by writing decorations to the
        // file's Monaco model, and on Tab it dispatches selectFileThunk to
        // switch tabs when the target isn't already active. dispatch +
        // rawFiles power that path; without them NEP falls back to the
        // old active-file-only behaviour.
        dispatch,
        rawFiles,
        // Read from the singleton fileCache, not just Redux. loadScheduler
        // populates the singleton with every fetched file (active + sibling
        // prefetch + impact-driven hydration), but the Redux Map only sees
        // explicit selectFileThunk fulfillments. NEP needs the broader set
        // so its prompt actually contains the workspace files the user
        // hasn't manually opened yet — that's where most cross-file
        // predictions land.
        getFileCacheEntries: () => {
            try {
                const merged = new Map();
                for (const [p, c] of fileCache.entries()) {
                    if (typeof c === 'string') merged.set(p, c);
                }
                for (const [p, c] of (fileCacheEntriesRef.current || [])) {
                    if (typeof c === 'string' && !merged.has(p)) merged.set(p, c);
                }
                return Array.from(merged.entries());
            } catch (_) {
                return fileCacheEntriesRef.current || [];
            }
        },
        // Read live model contents — falls back to the Redux file cache,
        // then to the singleton fileCache (loadScheduler-populated). The
        // singleton fallback is what lets NEP read content for any file in
        // the workspace, not just ones the user has opened as tabs.
        getLiveFileContent: (path) => {
            try {
                if (!path) return null;
                const activePath = activeFile?.path || activeFile?.name;
                if (path === activePath) {
                    const m = editorInstance?.getModel?.();
                    if (m) return m.getValue();
                }
                const entries = fileCacheEntriesRef.current || [];
                for (const [p, content] of entries) {
                    if (p === path && typeof content === 'string') return content;
                }
                const fromSingleton = fileCache.get(path);
                if (typeof fromSingleton === 'string') return fromSingleton;
                return null;
            } catch (_) {
                return null;
            }
        },
        // Plan Q1: NEP shares the workspace-switch reset hook with the primary
        // buffer. Slug change → both buffers drop.
        workspaceResetKey: slug,
        // Run the full Ctrl+S save pipeline after every NEP apply so the
        // edit gets durable cloud persistence + LSP didSave + HMR retrigger,
        // not just a Yjs broadcast that y-sweet flushes on its own schedule.
        // The wrapper hops through the ref because persistNepApply itself is
        // defined further down (closures over compilerClient + onSave).
        onApply: (path, content) => {
            const fn = persistNepApplyRef.current;
            return fn ? fn(path, content) : Promise.resolve();
        },
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

    // --- Git Gutter Decorations ---
    useGitGutter({
        editorInstance,
        monacoInstance,
        activeFile,
        slug,
    });

    // System-header opener.
    //
    // When the user Ctrl+clicks an `#include <iostream>` or `#include "config.h"`
    // that doesn't resolve in the workspace tree, ask the active LSP client
    // for the absolute path, fetch the contents from the worker, prime the
    // file cache, and return a synthetic file node the events handler can
    // dispatch through selectFileThunk so the file lands in a proper Synthi
    // tab (with our editor pane, not Monaco's hidden internal one).
    const resolveSystemHeader = useCallback(async ({ importPath, position, modelUri }) => {
        try {
            if (!compilerClient || typeof compilerClient.readRemoteFile !== 'function') {
                console.warn('[SystemHeader] compilerClient not ready');
                return null;
            }

            // Find any running LSP client. Most C/C++ workspaces only have
            // clangd, but a multi-language workspace might have several —
            // we want one that's actually able to answer textDocument/definition.
            let client = null;
            for (const c of languageClientsRef.current.values()) {
                if (c?.isRunning?.()) { client = c; break; }
            }
            if (!client) {
                console.warn('[SystemHeader] no running LSP client to resolve include');
                return null;
            }

            let defResult = null;
            try {
                defResult = await client.sendRequest('textDocument/definition', {
                    textDocument: { uri: modelUri },
                    position: { line: position.lineNumber - 1, character: position.column - 1 },
                });
            } catch (e) {
                console.warn('[SystemHeader] textDocument/definition failed:', e?.message);
                return null;
            }
            if (!defResult) return null;

            const locs = Array.isArray(defResult) ? defResult : [defResult];
            let absPath = null;
            let originalUri = null;
            for (const loc of locs) {
                const uriStr = loc?.uri ?? loc?.targetUri ?? null;
                if (!uriStr) continue;
                const m = String(uriStr).match(/^file:\/\/(\/[^?#]+)/);
                if (!m) continue;
                const p = decodeURIComponent(m[1]);
                // Pick the first non-`/synthi/` URI — those are the ones
                // that point at the LSP worker's real filesystem (system
                // headers, stdlib source). `/synthi/...` URIs would just
                // bounce us back to a workspace file, which findTargetFile
                // already handled before we got here.
                if (!p.startsWith('/synthi/')) {
                    absPath = p;
                    originalUri = String(uriStr);
                    break;
                }
            }
            if (!absPath) {
                console.warn(`[SystemHeader] LSP returned no system-path location for include "${importPath}"`);
                return null;
            }

            let content;
            try {
                const res = await compilerClient.readRemoteFile(absPath);
                if (!res?.ok || typeof res.content !== 'string') {
                    console.warn('[SystemHeader] readRemoteFile failed:', res?.error || 'unknown');
                    return null;
                }
                content = res.content;
            } catch (e) {
                console.warn('[SystemHeader] readRemoteFile threw:', e?.message);
                return null;
            }

            // Prime the per-session file cache so selectFileThunk's
            // cache-hit path returns the system file's content directly,
            // skipping the workspace loadScheduler (which has no concept
            // of `/usr/include/...` paths).
            try { fileCache.set(absPath, content); } catch (_) { /* best-effort */ }

            // Also register in the Monaco filesystem overlay so any
            // subsequent LSP-driven navigation (clangd "go to definition"
            // jumping inside iostream) resolves cleanly.
            try { await registerSystemFile(absPath, content, originalUri); } catch (_) { /* best-effort */ }

            const name = absPath.split('/').filter(Boolean).pop() || importPath;
            // Pick a sensible language for syntax highlighting. Files like
            // `iostream` / `vector` have no extension, so getMonacoLanguage
            // falls back to plaintext — but they're C++ headers, so use the
            // calling file's language as a hint.
            let language = getMonacoLanguage(name);
            if (language === 'plaintext' && activeFile?.name) {
                const callerLang = getMonacoLanguage(activeFile.name);
                if (callerLang === 'cpp' || callerLang === 'c') language = callerLang;
            }

            return {
                name,
                type: 'file',
                path: absPath,
                language,
                isSystem: true,
                readOnly: true,
            };
        } catch (e) {
            console.warn('[SystemHeader] resolve threw:', e?.message);
            return null;
        }
    }, [compilerClient, activeFile]);

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
        activeFile,
        resolveSystemHeader,
    });

    useEffect(() => {
        latestCodeRef.current = code;
    }, []);

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
        if (paneFile && collabConnected && boundFilePathRef.current && boundFilePathRef.current !== paneFile.path) {
            console.warn('[Editor] Skipping — boundFilePathRef mismatch:', boundFilePathRef.current, '!==', paneFile.path);
            return;
        }

        // Suppress content changes during revert/pull to prevent brief
        // duplication from stale CRDT merges.
        if (revertLockRef.current) return;
        
        // Always track latest content for flush-on-unmount and save
        latestCodeRef.current = newCode;

        // Check if collab is applying remote changes
        const remoteApplying = !!collabBindingRef.current?.isApplyingRemote?.();


        // P0: ALWAYS dispatch to Redux immediately — no debounce.
        // The unsaved indicator, save flow, and tab dot all depend on Redux
        // currentContent being up-to-date.  Debouncing this caused the unsaved
        // dot to appear seconds after the first keystroke.  The updateContent
        // reducer already short-circuits when content hasn't changed, so
        // dispatching on every keystroke is cheap.
        if (reduxSyncTimerRef.current) {
            clearTimeout(reduxSyncTimerRef.current);
            reduxSyncTimerRef.current = null;
        }
        // Only the focused pane writes the global content/save buffer; an
        // unfocused pane editing a different file must not clobber it.
        if (isFocusedPane) dispatch(updateContent(newCode));

        // ── Background HMR classification ───────────────────────────
        // Stream the edit to the worker so it can classify what changed
        // (value/expression/addition/deletion) in the background.  When
        // the user saves, the compile handler reads the cached classification
        // and dispatches instantly without re-analyzing.  300ms debounce
        // to avoid flooding the DataChannel on fast typing.
        if (isFocusedPane && compilerClient && paneFile?.path) {
            if (editDeltaTimerRef.current) clearTimeout(editDeltaTimerRef.current);
            editDeltaTimerRef.current = setTimeout(() => {
                compilerClient.sendEditDelta(paneFile.path, newCode);
            }, 300);
        }

        // ── Save-state sync for guests ──────────────────────────────
        // When remote edits arrive via Yjs (from the host), automatically
        // align the guest's savedContent so the tab never shows a false
        // "unsaved" indicator.  The host's edits are the source of truth;
        // persisting to disk is the host's responsibility.
        // Debounced via requestAnimationFrame to coalesce rapid remote
        // character edits into a single Redux dispatch per frame.
        if (remoteApplying && collabRole === 'guest' && paneFile?.path) {
            if (!remoteSaveRAFRef.current) {
                const pathToSync = paneFile.path;
                remoteSaveRAFRef.current = requestAnimationFrame(() => {
                    remoteSaveRAFRef.current = null;
                    dispatch(markFileSavedRemotely(pathToSync));
                });
            }
        }

        // Skip AI auto-complete and active completion cancel for remote changes
        // — these should only fire on local user edits
        if (remoteApplying) return;

        // Skip AI auto-complete cancel and re-trigger when the self-healing
        // system just applied a fix.  Cancelling completions during healing
        // edits causes unnecessary visual disruption.
        if (selfEditFlagRef?.current) return;

        cancelActiveCompletion({ resetSuggestion: true, reason: 'edit' });

        // Debounce AI Auto-Complete. The previous 900ms wait was the dominant
        // contributor to perceived completion latency: with a typical 500-800ms
        // model+network roundtrip, total time-to-first-ghost was 1.5-2s, which
        // reads as broken rather than as "AI assistance". 350ms matches the
        // Copilot/Cursor band — short enough that the suggestion appears
        // shortly after a natural typing pause, long enough that it doesn't
        // fire mid-token. The MIN_AUTO_INTERVAL_MS rate-limit in AICompletion.js
        // (350ms) acts as a floor against burst-typing flooding the API.
        if (aiDebounceTimerRef.current) clearTimeout(aiDebounceTimerRef.current);
        if (!aiAutoEnabled) return;
        aiDebounceTimerRef.current = setTimeout(() => {
            if (!activeDiffCheck()) {
                requestAiCompletion(true, latestCodeRef.current, { reason: 'pause', pauseTrigger: true, recentEditSnippet: takeLastChars(latestCodeRef.current, 512) });
            }
        }, 350);
    }, [activeFile, paneFile, isFocusedPane, aiAutoEnabled, activeDiffCheck, cancelActiveCompletion, dispatch, requestAiCompletion, collabConnected]);

    // Keep a ref to the latest handleCodeChange to avoid stale closures in the editor onMount listener
    const handleCodeChangeRef = useRef(handleCodeChange);
    useEffect(() => {
        handleCodeChangeRef.current = handleCodeChange;
    }, [handleCodeChange]);

    const handleSave = useCallback(() => {
        console.log('[Editor] handleSave triggered. activeFile:', activeFile?.name);
        // Ensure Redux has the absolute latest content before saving.
        // Since updateContent is now dispatched synchronously in handleCodeChange,
        // this is a safety net for edge cases (e.g. rapid save before React tick).
        dispatch(updateContent(latestCodeRef.current));
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
        // Also update the in-memory virtual filesystem so Monaco's FileService
        // can resolve the latest content for cross-file features.
        if (activeFile?.path) {
            updateVirtualFile(activeFile.path, latestCodeRef.current ?? code).catch(() => {});
        }
        // P1: Send textDocument/didSave to LSP servers so they re-index.
        // Skip system headers — they're read-only and live outside the
        // workspace, so a save event with a /synthi/-prefixed URI would
        // confuse the LSP server's indexer.
        if (activeFile?.path && !activeFile.isSystem) {
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
        console.log('[Editor] Calling onSave prop with latest code');
        if (onSave) onSave(latestCodeRef.current ?? code);
    }, [activeFile, dispatch, onSave, compilerClient, slug]);

    // Mirror handleSave for the NEP apply path. The Yjs broadcast that
    // pushEditOperations triggers gets the edit into the CRDT, but cloud
    // durability and the editor's other "saved!" side effects (REST save,
    // worker disk sync, LSP didSave, HMR compile) only land if we run the
    // same pipeline Ctrl+S runs. The signature takes (path, content)
    // explicitly so we don't depend on `latestCodeRef`, which is racey
    // immediately after a programmatic model edit (the React render that
    // refreshes the ref hasn't run yet when this is invoked).
    const persistNepApply = useCallback(async (path, content) => {
        if (!path || typeof content !== 'string') return;
        const activePath = activeFile?.path || activeFile?.name;
        const isActive = path === activePath;

        // 1. REST save → collab-server. Active file goes through the
        //    Redux thunk so optimistic isUnsaved + savedContent updates
        //    happen exactly like a Ctrl+S would. Non-active paths take
        //    the per-path write API.
        if (isActive) {
            try { dispatch(saveFileContentThunk()); }
            catch (_) { /* best-effort */ }
        } else if (slug) {
            try { await gitClient.writeFile(slug, path, content); }
            catch (_) { /* best-effort — Yjs broadcast is the fallback */ }
        }

        // 2. Worker disk sync — the LSP server reads from worker disk
        //    for cross-file indexing; without this a NEP-applied rename
        //    that touches a non-active file leaves the index stale.
        if (compilerClient && typeof compilerClient.syncFile === 'function') {
            try { compilerClient.syncFile(path, content); }
            catch (_) { /* best-effort */ }
        }

        // 3. Monaco virtual filesystem overlay refresh.
        try { await updateVirtualFile(path, content); } catch (_) { /* best-effort */ }

        // 4. LSP didSave — re-index trigger. Match the URI shape the rest
        //    of the editor uses (file:///synthi/<rel>). Skip system
        //    headers (read-only, not part of the workspace).
        const isSystemPath = path.startsWith('/') && !path.startsWith('/synthi/');
        if (!isSystemPath) {
            const safePath = path.startsWith('/') ? path.slice(1) : path;
            const fileUri = `file:///synthi/${safePath}`;
            languageClientsRef.current?.forEach((client) => {
                if (client?.isRunning?.()) {
                    try {
                        client.sendNotification('textDocument/didSave', {
                            textDocument: { uri: fileUri },
                            text: content,
                        });
                    } catch (_) { /* best-effort */ }
                }
            });
        }

        // 5. HMR / compile trigger. Only meaningful for the active file —
        //    `onSave` is the page-level pipeline that recompiles whatever
        //    the user is currently looking at. Non-active applies skip
        //    this and let the worker pick up the change on next compile.
        if (isActive && typeof onSave === 'function') {
            try { onSave(content); } catch (_) { /* best-effort */ }
        }
    }, [activeFile, slug, dispatch, compilerClient, onSave]);

    // Plug the implementation into the ref the NEP hook reads through.
    useEffect(() => {
        persistNepApplyRef.current = persistNepApply;
    }, [persistNepApply]);

    // ── Close-tab guard: prompt when a file has unsaved changes ──────
    // For the *active* file we check the live `isUnsaved` selector.
    // For background tabs we fall back to the per-tab `file.isUnsaved` flag.
    const handleCloseTab = useCallback((file) => {
        if (autoSaveEnabled) {
            // Auto-save is on — just close, content is already flushed.
            dispatch(closeFile(file.path));
            return;
        }
        const dirty = activeFile?.path === file.path
            ? isUnsaved
            : file.isUnsaved;
        if (dirty) {
            setPendingClose({ path: file.path, name: file.name });
        } else {
            dispatch(closeFile(file.path));
        }
    }, [autoSaveEnabled, activeFile, isUnsaved, dispatch]);

    // Auto-save mode: persist edits after a period of typing inactivity.
    // Wait 500ms of quiet before firing the save command so the main UI
    // thread remains unblocked for typing.  Flush the pending Redux
    // debounce first (same as handleSave does for Ctrl+S) so
    // saveFileContentThunk reads the absolute latest content.
    useEffect(() => {
        if (!autoSaveEnabled || !activeFile) return;
        const normalizeTrailing = (s) => (typeof s === 'string' ? s.replace(/[\r\n]+$/, '') : '');
        if (normalizeTrailing(code) === normalizeTrailing(savedContent)) return;
        const timer = setTimeout(() => {
            // Safety: ensure Redux has the absolute latest content
            dispatch(updateContent(latestCodeRef.current));
            dispatch(saveFileContentThunk());
        }, 500);
        return () => clearTimeout(timer);
    }, [autoSaveEnabled, activeFile, dispatch, savedContent, slug]);

    // ── Pre-compile heal: sync fixed code back to the editor ──────────────
    // When page.jsx's handleSave fixes syntax issues before compilation,
    // it dispatches `synthi:pre-compile-heal` with the individual line fixes.
    // We apply those fixes to the Monaco model so the editor stays in sync
    // with what was actually compiled. Uses the same undo-friendly pattern
    // as useSelfHealing (executeEdits + pushUndoStop).
    useEffect(() => {
        const handler = (e) => {
            const editor = editorRef?.current;
            if (!editor) return;

            const model = editor.getModel();
            if (!model) return;

            const { fixes } = e.detail || {};
            if (!fixes || fixes.length === 0) return;

            const monaco = typeof window !== 'undefined' && window.monaco;
            if (!monaco) return;

            // Build edit operations from the fix list
            const edits = fixes.map((fix) => {
                const lineNum = fix.line; // 1-indexed
                if (lineNum < 1 || lineNum > model.getLineCount()) return null;

                const lineContent = model.getLineContent(lineNum);
                // Only apply if the line still matches the original (hasn't changed)
                if (lineContent.trimEnd() !== fix.original.trimEnd()) return null;

                return {
                    range: new monaco.Range(lineNum, 1, lineNum, lineContent.length + 1),
                    text: fix.fixed,
                    forceMoveMarkers: true,
                };
            }).filter(Boolean);

            if (edits.length === 0) return;

            // Apply with self-edit guard so self-healing doesn't re-trigger
            editor.executeEdits('pre-compile-heal', edits);
            editor.pushUndoStop();

            console.log(`[PreCompileHeal] Applied ${edits.length} fix(es) back to editor`);
        };

        window.addEventListener('synthi:pre-compile-heal', handler);
        return () => window.removeEventListener('synthi:pre-compile-heal', handler);
    }, []);

    // Latch diffModeEverActive so the DiffEditor stays mounted (hidden) once
    // the user first opens it — avoids React passive-unmount crash.
    // Also generate a unique diffSessionKey per diff activation to prevent
    // Monaco model URI collisions between files.
    const [diffSessionKey, setDiffSessionKey] = useState(0);
    useEffect(() => {
        if (diffMode) {
            setDiffModeEverActive(true);
            setDiffSessionKey(k => k + 1);
        }
    }, [diffMode]);

    // Snapshot diff content when diff mode activates so the DiffEditor
    // is fully decoupled from live editing state (prevents false "unsaved"
    // indicator and contamination between files).
    const diffSnapshotRef = useRef({ original: '', modified: '', path: '' });
    useEffect(() => {
        if (diffMode && activeFile) {
            diffSnapshotRef.current = {
                original: originalContent || '',
                modified: code ?? '',
                path: activeFile.path || '',
            };
        }
    }, [diffMode, activeFile?.path]); // intentionally NOT depending on code/originalContent

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
            // Run: Ctrl+Enter
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                // Ensure Redux has the absolute latest content before running
                dispatch(updateContent(latestCodeRef.current));
                if (onRun) onRun({ latestCode: latestCodeRef.current ?? code });
            }
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
    }, [latestCompletion, editorInstance, activeLanguage]);

    // --- Custom Scrollbar Logic ---
    const {
        tabsContainerRef,
        scrollbarThumbRef,
        handleScroll,
        handleThumbMouseDown
    } = useCustomScrollbar([openFiles]);

    // --- Animated Tab Indicator Logic ---
    // Use useLayoutEffect for synchronous DOM measurement before paint (no flicker)
    const updateIndicatorRef = useRef(null);
    updateIndicatorRef.current = () => {
        const container = tabsContainerRef.current;
        const activePath = activeFile?.path || null;
        const targetPath = hoveredTabPath && hoveredTabPath !== activePath ? hoveredTabPath : activePath;
        if (!targetPath || !container) {
            setTabIndicator(prev => prev.visible ? { ...prev, visible: false } : prev);
            return;
        }
        const targetTabEl = tabRefs.current[targetPath] || tabRefs.current[activePath];
        if (targetTabEl) {
            const containerRect = container.getBoundingClientRect();
            const tabRect = targetTabEl.getBoundingClientRect();
            const newLeft = tabRect.left - containerRect.left + container.scrollLeft;
            const newWidth = tabRect.width;
            setTabIndicator(prev => {
                if (prev.left === newLeft && prev.width === newWidth && prev.visible) return prev;
                return { left: newLeft, width: newWidth, visible: true };
            });
        }
    };

    useLayoutEffect(() => {
        updateIndicatorRef.current();
    }, [activeFile, openFiles, hoveredTabPath]);

    // Scroll & resize listeners for the tab indicator (stable, set up once)
    useEffect(() => {
        const container = tabsContainerRef.current;
        if (!container) return;
        const onScroll = () => updateIndicatorRef.current();
        container.addEventListener('scroll', onScroll, { passive: true });
        const resizeObserver = new ResizeObserver(() => {
            window.requestAnimationFrame(() => {
                updateIndicatorRef.current();
            });
        });
        resizeObserver.observe(container);
        return () => {
            container.removeEventListener('scroll', onScroll);
            resizeObserver.disconnect();
        };
    }, []);

    // --- Render ---


    const editorUI = (
                    <div className="h-full flex flex-col rounded-tl-lg rounded-tr-lg overflow-hidden" style={{ background: 'var(--bg-editor)' }}>
                        {/* Minimal Sleek Header - Synthi Brand Theme */}
                        {/* Editor toolbar — the file-tab strip has been lifted
                            into the TopNav (smart strip); this row now holds
                            only the editor-level actions (collab avatars, Solo
                            pill, save). The tabs DOM stays mounted (hidden) so
                            scroll-into-view + middle-click + drag handlers
                            remain wired for any code that still references them. */}
                        <div className="hidden h-8 border-b justify-between select-none shadow-sm" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-app)' }}>

                            {/* Breadcrumbs — visually hidden, the tab strip
                                was lifted into the TopNav. We keep the DOM
                                mounted because refs & handlers are still
                                wired throughout the editor. */}
                                <div className="hidden h-full flex min-w-0 relative group tabs-container-wrapper">
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
                                                backgroundImage: [
                                                    'var(--brand-gradient-horizontal)',
                                                    'linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 78%, transparent), color-mix(in srgb, var(--accent-primary) 78%, transparent))',
                                                ].join(', '),
                                                backgroundRepeat: 'no-repeat, no-repeat',
                                                backgroundSize: `${hoveredTabPath ? '100% 100%' : '0% 100%'}, 100% 100%`,
                                                boxShadow: hoveredTabPath
                                                    ? '0 0 8px color-mix(in srgb, var(--brand-stop-3) 28%, transparent)'
                                                    : '0 0 8px color-mix(in srgb, var(--accent-primary) 30%, transparent)',
                                                transition: 'left 0.15s cubic-bezier(0.4, 0, 0.2, 1), width 0.15s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.1s ease, background-size 0.2s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.2s ease',
                                                borderRadius: '2px 2px 0 0',
                                                willChange: 'left, width, background-size',
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
                                                    onMouseEnter={() => setHoveredTabPath(file.path)}
                                                    onMouseLeave={() => {
                                                        setHoveredTabPath(prev => (prev === file.path ? null : prev));
                                                    }}
                                                    onContextMenu={(e) => {
                                                        e.preventDefault();
                                                        setTabContext({ visible: true, x: e.clientX, y: e.clientY, file, index: idx });
                                                    }}
                                                    className={`group flex items-center gap-2 px-3 cursor-pointer select-none transition-all duration-200`}
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
                                                        background: isActive ? TAB_TOKENS.activeBg : TAB_TOKENS.inactiveBg,
                                                        color: isActive ? TAB_TOKENS.textPrimary : TAB_TOKENS.textInactive,
                                                        opacity: isActive ? 1 : 0.6,
                                                    }}
                                                >
                                                    <span className={`flex-shrink-0 text-sm ${isActive ? 'opacity-90' : 'opacity-50'}`} aria-hidden="true">
                                                        {loadingFiles.includes(file.path) ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: TAB_TOKENS.primary }} /> : fileIcon}
                                                    </span>
                                                    {/* NEP prediction badge: a queued next-edit prediction
                                                        targets this file. The gutter dot is only visible
                                                        in the active editor, so without this the user has
                                                        no way to know there's a Tab-actionable prediction
                                                        waiting in a hidden tab. Hidden on the active tab
                                                        because the gutter dot already signals "look here". */}
                                                    {nepPredictedPaths?.has?.(file.path) && !isActive && (
                                                        <span
                                                            aria-label="Next-edit prediction queued for this file"
                                                            title="Next-edit prediction queued · open this tab to Tab-jump"
                                                            className="flex-shrink-0 rounded-full"
                                                            style={{
                                                                width: 6,
                                                                height: 6,
                                                                background: 'var(--accent-primary, #6f7eff)',
                                                                boxShadow: '0 0 5px color-mix(in srgb, var(--accent-primary, #6f7eff) 70%, transparent)',
                                                            }}
                                                        />
                                                    )}
                                                    <div className="flex flex-col min-w-0 overflow-hidden">
                                                        <span className={`text-[13px] truncate ${isActive ? 'font-semibold' : 'font-normal'}`} style={{ color: isActive ? TAB_TOKENS.textPrimary : TAB_TOKENS.textSecondary }}>
                                                            {file.name}
                                                        </span>
                                                        {/* Breadcrumb path - shows parent folder context - only for active */}
                                                        {parentPath && isActive && (
                                                            <span className="text-[9px] truncate" style={{ color: 'var(--text-muted)' }}>
                                                                {parentPath}
                                                            </span>
                                                        )}
                                                    </div>

                                                    {/* Persistent permission-denied indicator: shown whenever a save
                                                        was rejected with 403 on this file.  Survives focus changes so
                                                        a missed 5s toast doesn't leave the user retrying blindly.
                                                        Cleared by any successful save. */}
                                                    {file.permissionDenied && (
                                                        <span
                                                            aria-label="Read-only — permission denied"
                                                            title={file.saveError || 'Read-only: your collab role cannot write this file. Ask the Host.'}
                                                            className="flex-shrink-0 flex items-center justify-center"
                                                            style={{
                                                                width: 14,
                                                                height: 14,
                                                                color: 'var(--accent-warning, #e0a83c)',
                                                            }}
                                                        >
                                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                                <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="2" />
                                                                <path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                                            </svg>
                                                        </span>
                                                    )}

                                                 {/* Presence avatars — small colored dots/avatars for remote users on this file */}
                                                {(() => {
                                                    const fileUsers = presenceByFile[file.path];
                                                    if (!fileUsers || fileUsers.length === 0) return null;
                                                    return (
                                                        <div 
                                                            className="flex items-center -space-x-1 flex-shrink-0 group-hover:hidden" 
                                                            title={fileUsers.map(u => u.name).join(', ')}
                                                        >
                                                            {fileUsers.slice(0, 3).map((u) => (
                                                                u.image ? (
                                                                    <img
                                                                        key={u.userId}
                                                                        src={u.image}
                                                                        alt={u.name}
                                                                        style={{
                                                                            width: 14, height: 14,
                                                                            borderRadius: '50%',
                                                                            border: `1.5px solid ${u.color}`,
                                                                            objectFit: 'cover',
                                                                        }}
                                                                    />
                                                                ) : (
                                                                    <span
                                                                        key={u.userId}
                                                                        style={{
                                                                            width: 10, height: 10,
                                                                            borderRadius: '50%',
                                                                            backgroundColor: u.color,
                                                                            display: 'inline-block',
                                                                            border: '1.5px solid var(--bg-primary, #0c0d12)',
                                                                            flexShrink: 0,
                                                                        }}
                                                                    />
                                                                )
                                                            ))}
                                                            {fileUsers.length > 3 && (
                                                                <span style={{
                                                                    fontSize: 8, 
                                                                    color: 'var(--text-muted)', 
                                                                    marginLeft: 2,
                                                                    fontWeight: 600, 
                                                                    lineHeight: 1,
                                                                }}>+{fileUsers.length - 3}</span>
                                                            )}
                                                        </div>
                                                    );
                                                })()}

                                                {/* VSCode-style: unsaved dot and close button share the same slot. */}
                                                <div className="ml-auto w-5 h-5 flex-shrink-0 flex items-center justify-center relative">
                                                    {/* Unsaved dot — using TAB_TOKENS for theme-adaptive coloring.
                                                        Logic: Only show if (Manual Save + Local Unsaved) OR (Remote Unsaved).
                                                    */}
                                                    {((!autoSaveEnabled && (file.isUnsaved || (isActive && isUnsaved))) || (isActive && remoteUnsaved)) ? (
                                                        <span
                                                            aria-hidden="true"
                                                            className="w-2 h-2 rounded-full flex-shrink-0 transition-opacity group-hover:hidden"
                                                            style={{
                                                                backgroundColor: TAB_TOKENS.unsaved,
                                                                boxShadow: `0 0 6px color-mix(in srgb, ${TAB_TOKENS.unsaved} 60%, transparent)`
                                                            }}
                                                        />
                                                    ) : (
                                                        // Transient "just saved" checkmark.  Remounted on each save
                                                        // via the lastSavedAt key; the CSS keyframe fades it in and
                                                        // back out so there's no timer to manage and the indicator
                                                        // cleans up automatically.  Silent success makes failures
                                                        // invisible by contrast — this closes that gap.
                                                        file.lastSavedAt && (
                                                            <span
                                                                key={file.lastSavedAt}
                                                                aria-hidden="true"
                                                                className="flex-shrink-0 flex items-center justify-center group-hover:hidden synthi-save-pulse"
                                                                style={{
                                                                    width: 10,
                                                                    height: 10,
                                                                    color: 'var(--accent-success, #4caf87)',
                                                                }}
                                                            >
                                                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                                    <path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                                                                </svg>
                                                            </span>
                                                        )
                                                    )}

                                                    {/* Close button — uses theme variables for text and hover backgrounds */}
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleCloseTab(file); }}
                                                        className={`absolute inset-0 items-center justify-center rounded-full transition-all duration-150 hidden group-hover:flex 
                                                            ${isActive 
                                                                ? 'text-[var(--text-primary)] opacity-80 hover:opacity-100 hover:bg-[var(--hover-bg-active)]' 
                                                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--hover-bg-inactive)]'
                                                            }`}
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
                                        <span className="text-xs italic px-3 flex items-center" style={{ color: 'var(--text-muted)' }}>No file open</span>
                                    )}
                                    </div>
                                    {/* Custom Scrollbar - Synthi accent */}
                                    <div className="absolute left-0 right-0 bottom-0 h-[3px] z-20 pointer-events-none">
                                        <div
                                            ref={scrollbarThumbRef}
                                            className="absolute top-0 bottom-0 rounded-[3px] cursor-pointer pointer-events-auto opacity-0 transition-opacity duration-200 group-hover:opacity-100 [&.visible]:opacity-100"
                                            style={{ background: 'linear-gradient(90deg, color-mix(in srgb, var(--brand-stop-3) 35%, transparent), color-mix(in srgb, var(--brand-stop-4) 35%, transparent))' }}
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
                                        <div className="rounded-lg shadow-lg text-sm border" style={{ background: TAB_TOKENS.activeBg, borderColor: TAB_TOKENS.borderSubtle, color: TAB_TOKENS.textPrimary }}>
                                            <div className="px-3 py-2 cursor-pointer rounded-t-lg transition-colors" style={{ ':hover': undefined }} onClick={() => { if (tabContext.file) handleCloseTab(tabContext.file); setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 }); }}>Close</div>
                                            <div className="px-3 py-2 cursor-pointer transition-colors" onClick={() => {
                                                if (tabContext.file) {
                                                    const keep = tabContext.file.path;
                                                    const toClose = openFiles.filter(f => f.path !== keep).map(f => f.path);
                                                    toClose.forEach(p => dispatch(closeFile(p)));
                                                }
                                                setTabContext({ visible: false, x: 0, y: 0, file: null, index: -1 });
                                            }}>Close Others</div>
                                            <div className="px-3 py-2 cursor-pointer rounded-b-lg transition-colors" onClick={() => {
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
                                <div className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                                    <button 
                                        onClick={() => setIsPrivateMode(!isPrivateMode)}
                                        className={`flex items-center px-1.5 py-0.5 rounded-full transition-all`}
                                        style={isPrivateMode ? { background: 'color-mix(in srgb, var(--accent-danger) 12%, transparent)', color: 'var(--accent-danger)', border: '1px solid color-mix(in srgb, var(--accent-danger) 25%, transparent)' } : {}}
                                        title={isPrivateMode ? "Enable Collaboration" : "Disable Collaboration (Private Mode)"}
                                    >
                                        {isPrivateMode ? <EyeOff className="w-3 h-3" /> : <div className="text-xs h-5" style={{ color: 'var(--text-secondary)' }}>👥</div>}
                                        {isPrivateMode && <span className="text-[10px] font-bold ml-1">PRIVATE</span>}
                                    </button>
                                    
                                    {!isPrivateMode && (
                                    <div className="flex items-center gap-2">
                                        {/* small presence list */}
                                        {(() => {
                                            // only show active editors (users with cursor) to avoid many idle/default slots
                                            const allUsers = (presenceGranularity === 'workspace') ? collabClient.getWorkspaceActiveEditors(slug) : collabClient.getActiveEditors(slug, activeFile?.path);
                                            const users = allUsers.filter(u => (showAnonymousPresence ? true : !(u.state?.user?.isAnonymous)));
                                            if (!users || users.length === 0) return <span className="text-xs px-2 py-0.5 rounded-full border" style={{ color: 'var(--text-muted)', background: 'var(--bg-surface)', borderColor: 'var(--border-medium)' }}>Solo</span>;
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
                                                            style={{ border: `2px solid ${user.color || 'var(--accent-primary)'}`, background: user.color ? 'color-mix(in srgb, var(--text-primary) 5%, transparent)' : 'var(--bg-surface)' }}
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
                                    <Sparkles className="w-3.5 h-3.5 animate-pulse" style={{ color: 'var(--accent-primary)' }} />
                                </div>

                                {/* Manual Save (Optional since we have auto-save) */}
                                <button onClick={handleSave} className="opacity-60 hover:opacity-100 transition-opacity px-1">
                                    <Save className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                                </button>
                            </div>
                        </div>

                        {/* Hover card for presence */}
                        {hoverCardStyle && hoverPresence && hoverPresence.user && (
                            <div style={hoverCardStyle} onMouseEnter={() => { if (hoverHideTimeoutRef.current) { clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = null; } }} onMouseLeave={() => { if (hoverHideTimeoutRef.current) clearTimeout(hoverHideTimeoutRef.current); hoverHideTimeoutRef.current = setTimeout(() => setHoverPresence(null), 140); }}>
                                <div className="border rounded-md p-2 text-sm shadow-lg w-56" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}>
                                    <div className="flex items-center gap-2">
                                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm text-white" style={{ background: hoverPresence.user.color || 'var(--accent-primary)' }}>{(hoverPresence.user.name || 'Anonymous').split(' ').map(p => p[0]).slice(0,2).join('').toUpperCase()}</div>
                                        <div className="flex flex-col">
                                            <div className="font-semibold text-sm">{hoverPresence.user.name || 'Anonymous'}</div>
                                            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{hoverPresence.user.email || (hoverPresence.user.id ? `id: ${hoverPresence.user.id}` : 'Anonymous user')}</div>
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
                                            }} className="px-2 py-1 rounded text-xs border" style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-medium)', color: 'var(--text-secondary)' }}>Jump</button>
                                        </div>
                                    </div>
                                </div>      
                            </div>
                        )}

                        {/* Merge Conflict Resolver — overlays the editor when active.
                            Kept as a sibling (not a conditional replacement) so the Monaco
                            editor stays mounted and its passive-unmount effects don't throw
                            during the React reconciliation (commitPassiveUnmountOnFiber). */}
                        {conflictResolverFile && (
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
                        )}

                        {/* Normal editor area — hidden (not unmounted) when conflict resolver is active */}
                        <div style={{ display: conflictResolverFile ? 'none' : 'contents' }}>
                        {/* Merge Conflict Banner */}
                        {activeFile && (
                            <ConflictBanner
                                content={code}
                                filePath={activeFile.path}
                                slug={slug}
                                monacoInstance={monacoInstance}
                                onContentChange={async (newContent) => {
                                    // Apply resolved content to the Monaco model directly.
                                    // The model is bound to Yjs via MonacoBinding, so
                                    // model.setValue() propagates to the CRDT → server.
                                    // Without this, only Redux is updated but the Monaco
                                    // model (from Yjs) still shows conflict markers.
                                    const model = editorInstance?.getModel?.();
                                    if (model) {
                                        const fullRange = model.getFullModelRange();
                                        editorInstance.executeEdits('conflict-resolve', [{
                                            range: fullRange,
                                            text: newContent,
                                        }]);
                                    }
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
                        <div ref={editorViewportRef} className="flex-1 overflow-hidden relative group">
                            <ContextMenu>
                                <ContextMenuTrigger asChild>
                                    <div className="h-full w-full">
                                        {/* Gate Monaco editor mounting on servicesReady so that
                                            wrapper.start() has installed the real MarkdownRendererService
                                            (and all other service overrides) BEFORE the standalone editor
                                            constructor runs.  Without this, the @codingame/monaco-vscode-api
                                            missing-services stub throws:
                                              "Unsupported: MarkdownRendererService.setDefaultCodeBlockRenderer
                                               is not supported" */}
                                        {!servicesReady ? (
                                            <div className="h-full w-full flex items-center justify-center bg-[#0a0b10]">
                                                <span className="text-[#4d5168] text-sm select-none animate-pulse">Initializing editor…</span>
                                            </div>
                                        ) : (<>
                                        {/* DiffEditor — kept mounted (display:none) once activated
                                            to prevent React unmount crash in
                                            recursivelyTraversePassiveUnmountEffects.
                                            Monaco DiffEditor's internal useEffect cleanup can throw
                                            during React passive unmount; keeping it in the DOM and
                                            hiding via CSS avoids the disposal race entirely. */}
                                        {diffModeEverActive && (
                                            <div className="h-full w-full relative flex flex-col" style={{ display: diffMode ? 'flex' : 'none' }}>
                                                {/* Diff view header with close button */}
                                                <div className="flex items-center justify-between px-3 py-1 border-b text-xs shrink-0 select-none" style={{ height: 32, background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}>
                                                    <div className="flex items-center gap-2 min-w-0">
                                                        <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>{activeFile?.name || 'Unknown'}</span>
                                                        <span style={{ color: 'var(--text-dim, var(--text-muted))' }}>•</span>
                                                        <span className="whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                                                            {activeFile?.commitDiff
                                                                ? `${activeFile.commitHash?.substring(0, 7)}~1 ↔ ${activeFile.commitHash?.substring(0, 7)}`
                                                                : 'Working Copy ↔ HEAD'}
                                                        </span>
                                                    </div>
                                                    <button
                                                        onClick={() => dispatch(setDiffMode(false))}
                                                        className="flex items-center justify-center w-6 h-6 rounded transition-colors shrink-0"
                                                        style={{ color: 'var(--text-secondary)' }}
                                                        title="Close diff view (Esc)"
                                                        aria-label="Close diff view"
                                                    >
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                                <div className="flex-1 min-h-0 relative overflow-hidden">
                                                    <DiffEditor
                                                        key={`diff-${diffSessionKey}`}
                                                        height="100%"
                                                        original={diffSnapshotRef.current.original}
                                                        modified={diffSnapshotRef.current.modified}
                                                        language={activeLanguage}
                                                        theme="synthi-theme"
                                                        originalModelPath={activeFile ? `inmemory://synthi/diff/original/${activeFile.path}?v=${diffSessionKey}` : undefined}
                                                        modifiedModelPath={activeFile ? `inmemory://synthi/diff/modified/${activeFile.path}?v=${diffSessionKey}` : undefined}
                                                        options={{
                                                            ...EDITOR_OPTIONS,
                                                            ...responsiveOverrides,
                                                            readOnly: true,
                                                            readOnlyMessage: { value: '' },
                                                            renderSideBySide: true,
                                                            glyphMargin: true,
                                                        }}
                                                        beforeMount={(monaco) => {
                                                            monaco.editor.defineTheme('synthi-theme', SYNTHI_THEME);
                                                        }}
                                                        onMount={(editor) => {
                                                            diffEditorRef.current = editor;
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        )}
                                        {/* Branded empty state — replaces the bare Monaco buffer
                                            when no file is open. Atmospheric: ambient gradient halo,
                                            wordmark, three keyboard hints. */}
                                        {!activeFile && (!openFiles || openFiles.length === 0) && !diffMode && (
                                            <div
                                                className="absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none select-none"
                                                style={{ background: 'var(--bg-editor)' }}
                                            >
                                                <div
                                                    aria-hidden="true"
                                                    className="absolute pointer-events-none"
                                                    style={{
                                                        width: 520,
                                                        height: 520,
                                                        borderRadius: '50%',
                                                        background: 'radial-gradient(circle, color-mix(in srgb, var(--brand-stop-3) 10%, transparent) 0%, color-mix(in srgb, var(--brand-stop-1) 4%, transparent) 35%, transparent 70%)',
                                                        filter: 'blur(28px)',
                                                    }}
                                                />
                                                <div
                                                    className="vt-brand-text relative text-[44px] font-semibold tracking-tight leading-none mb-3"
                                                    style={{ letterSpacing: '-0.02em' }}
                                                >
                                                    VECTANT
                                                </div>
                                                <div className="relative text-[12px] mb-7" style={{ color: 'var(--text-muted)' }}>
                                                    An editor that heals, thinks, and ships with you.
                                                </div>
                                                <div className="relative flex items-center gap-5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                                    <div className="flex items-center gap-1.5">
                                                        <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                                                             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                                                            Ctrl
                                                        </kbd>
                                                        <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                                                             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                                                            P
                                                        </kbd>
                                                        <span className="ml-1">Quick open</span>
                                                    </div>
                                                    <span style={{ color: 'var(--text-dim)' }}>·</span>
                                                    <div className="flex items-center gap-1.5">
                                                        <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                                                             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                                                            Ctrl
                                                        </kbd>
                                                        <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                                                             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                                                            K
                                                        </kbd>
                                                        <span className="ml-1">AI assist</span>
                                                    </div>
                                                    <span style={{ color: 'var(--text-dim)' }}>·</span>
                                                    <div className="flex items-center gap-1.5">
                                                        <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                                                             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                                                            Ctrl
                                                        </kbd>
                                                        <kbd className="px-1.5 py-0.5 rounded text-[10px] font-mono"
                                                             style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                                                            B
                                                        </kbd>
                                                        <span className="ml-1">Toggle tree</span>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {/* Regular Editor — hidden when diff is active */}
                                        <div className="h-full w-full" style={{ display: diffMode ? 'none' : undefined }}>
                                            <Editor
                                                height="100%"
                                                path={paneFile
                                                    ? (paneFile.isSystem && monacoInstance
                                                        ? monacoInstance.Uri.file(paneFile.path).toString()
                                                        : `file:///synthi/${paneFile.path.startsWith('/') ? paneFile.path.slice(1) : paneFile.path}`)
                                                    : undefined}
                                                // Model caching: the editor instance stays alive across file switches.
                                                // Models are pre-created and switched via editor.setModel() in the
                                                // useEffect above, so there is no blank flash between tab switches.
                                                // Only the focused pane may seed a new model from the global buffer.
                                                defaultValue={isFocusedPane ? (code ?? '') : ''}
                                                language={activeLanguage}
                                                theme="synthi-theme"
                                                options={{
                                                    ...EDITOR_OPTIONS,
                                                    ...responsiveOverrides,
                                                    semanticHighlighting: { enabled: true },
                                                    readOnly: isCollabReadOnly,
                                                    readOnlyMessage: isCollabReadOnly
                                                        ? { value: 'You have view-only access in this session. Ask the host to grant edit permission.' }
                                                        : undefined,
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

                                                    // Wire Monaco into ThemeProvider for live theme switching
                                                    if (themeMonacoRef) {
                                                        themeMonacoRef.current = monaco;
                                                        reapplyTheme();
                                                    }

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
                                                    let _remoteContentSyncPending = false;
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

                                                        // CRITICAL: Skip when the collab binding is applying
                                                        // remote CRDT changes.  During remote apply, the model
                                                        // may be transiently incorrect (delta inserted on top of
                                                        // existing content) before the safeguard corrects it.
                                                        // Dispatching the transient doubled content to Redux
                                                        // pollutes the file cache and causes accumulating
                                                        // duplication on subsequent tab switches.  Instead, defer
                                                        // a single Redux sync to after the synchronous apply
                                                        // block completes so only the final correct content is
                                                        // dispatched.
                                                        if (collabBindingRef.current?.isApplyingRemote?.()) {
                                                            if (!_remoteContentSyncPending) {
                                                                _remoteContentSyncPending = true;
                                                                queueMicrotask(() => {
                                                                    _remoteContentSyncPending = false;
                                                                    const v = editor.getModel()?.getValue() ?? '';
                                                                    if (v) handleCodeChangeRef.current(v);
                                                                });
                                                            }
                                                            return;
                                                        }
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
                                        </div>
                                        </>)}
                                    </div>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-56" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}>
                                    <ContextMenuItem onClick={() => {
                                        if (onRun) onRun({ latestCode: latestCodeRef.current ?? code });
                                    }}>Run File</ContextMenuItem>
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('editor.action.formatDocument')?.run()}>
                                        Format Document
                                    </ContextMenuItem>
                                    <ContextMenuItem onClick={() => handleSave()}>
                                        Save
                                    </ContextMenuItem>
                                    <ContextMenuSeparator style={{ background: 'var(--border-medium)' }} />
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('actions.find')?.run()}>
                                        Find
                                    </ContextMenuItem>
                                    <ContextMenuItem onClick={() => {
                                        // PERF: 250ms cooldown on manual triggers prevents stacking
                                        // concurrent requests on rapid context-menu invocations.
                                        const now = Date.now();
                                        if (now - (window.__lastManualAiTrigger || 0) < 250) return;
                                        window.__lastManualAiTrigger = now;
                                        requestAiCompletion();
                                    }}>
                                        Trigger AI Suggestion
                                    </ContextMenuItem>
                                </ContextMenuContent>
                            </ContextMenu>
                        </div>
                        </div>
                        {nepFireCapReached && (
                            <div className="synthi-nep-cap-notice" role="status" aria-live="polite">
                                <span className="synthi-nep-cap-notice__dot" aria-hidden="true" />
                                <span className="synthi-nep-cap-notice__text">
                                    Next-edit predictions paused — session limit ({nepFireCap}) reached.
                                    Reload the workspace to resume.
                                </span>
                            </div>
                        )}
                    </div>
    );

    if (dockingMode) {
        return (<>
            {editorUI}
            {pendingClose && (
                <UnsavedChangesDialog
                    fileName={pendingClose.name}
                    onSave={() => {
                        // Save then close
                        dispatch(saveFileContentThunk()).then(() => {
                            dispatch(closeFile(pendingClose.path));
                        });
                        setPendingClose(null);
                    }}
                    onDiscard={() => {
                        dispatch(closeFile(pendingClose.path));
                        setPendingClose(null);
                    }}
                    onCancel={() => setPendingClose(null)}
                />
            )}
        </>);
    }

    const showReopenBar = !showTerminal && !dockingMode;
    return (
        <ResizablePanel defaultSize={76} minSize={20}>
            <div
                className="h-full grid"
                style={{ gridTemplateRows: showReopenBar ? 'minmax(0, 1fr) auto' : 'minmax(0, 1fr)' }}
            >
                <ResizablePanelGroup direction="vertical" className="h-full min-h-0">
                    <ResizablePanel defaultSize={70} minSize={20}>
                        {editorUI}
                    </ResizablePanel>

                    {showTerminal && (
                        <>
                            <ResizableHandle className="h-px" style={{ background: 'var(--border-subtle)' }} />
                            <ResizablePanel defaultSize={30} minSize={15}>
                                <TerminalManagerDyn visible={true} onCloseAll={onToggleTerminal} workspaceSlug={slug} />
                            </ResizablePanel>
                        </>
                    )}
                </ResizablePanelGroup>

                {showReopenBar && (
                    <div
                        className="h-7 flex items-center justify-end px-2 border-t select-none"
                        style={{
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--bg-sidebar)',
                        }}
                    >
                        <button
                            className="h-6 flex items-center gap-1.5 px-2 rounded text-xs font-medium th-btn-ghost transition-colors"
                            onClick={onToggleTerminal}
                            title="Open Terminal"
                            style={{ color: 'var(--text-secondary)' }}
                        >
                            <TerminalSquare className="w-3.5 h-3.5" strokeWidth={2} />
                            <span>Terminal</span>
                            <Plus className="w-3.5 h-3.5 ml-0.5" strokeWidth={2} />
                        </button>
                    </div>
                )}
            </div>
            {pendingClose && (
                <UnsavedChangesDialog
                    fileName={pendingClose.name}
                    onSave={() => {
                        dispatch(saveFileContentThunk()).then(() => {
                            dispatch(closeFile(pendingClose.path));
                        });
                        setPendingClose(null);
                    }}
                    onDiscard={() => {
                        dispatch(closeFile(pendingClose.path));
                        setPendingClose(null);
                    }}
                    onCancel={() => setPendingClose(null)}
                />
            )}
        </ResizablePanel>
    );
};

export default EditorPanel;
