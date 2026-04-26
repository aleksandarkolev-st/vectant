'use client';
import { useState, useEffect, useCallback, useRef, useMemo, startTransition, useDeferredValue } from 'react';
import { use } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useAppDispatch, useAppSelector, useAppStore } from '@/redux/hooks';
import { fetchFilesThunk, selectActiveFile, setSlug, selectFileThunk, markFileSavedRemotely } from '@/redux/workspaceSlice';
import { fetchGitStatus, forceRefreshGitStatus } from '@/redux/gitSlice';
import collabClient from '@/services/collabClient';
import collabSessionService from '@/services/collabSessionService';
import { consumeJumpstartPayload } from '@/lib/ai-jumpstart-session';
import { USER_ID_KEY, USER_NAME_KEY, USER_AVATAR_KEY } from '@/services/userIdentity';
import {
    selectShowTerminal,
    selectShowEmulatorPreview,
    selectTreeOnRight,
    toggleTerminal,
    setTreeOrientation,
    setEmulatorPreviewVisible
} from '@/redux/uiSlice';
import TopNav from '../TopNav.jsx';
import {
    ResizableHandle,
    ResizablePanel,
    ResizablePanelGroup,
} from '@/components/ui/resizable';
import FileTreeView from "./FileTree.jsx";
import dynamic from 'next/dynamic';

const EditorPanel = dynamic(() => import('./Editor/Editor.jsx'), {
    ssr: false,
    loading: () => (
        <ResizablePanel defaultSize={76} minSize={20} className="min-w-0 bg-[#18181b]">
            <div className="h-full w-full bg-[#18181b]" />
        </ResizablePanel>
    ),
});

import { getFileLanguage } from '@/utils/fileUtils';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { useSelfHealing } from '@/hooks/useSelfHealing';
import { useAIHealing } from '@/hooks/useAIHealing';
import { useAIHealingKeyboard } from '@/hooks/useAIHealingKeyboard';
import { useAIAutoAnalysis } from '@/hooks/useAIAutoAnalysis';
import { useAISelectionAnalysis } from '@/hooks/useAISelectionAnalysis';
import { useHealingUndo } from '@/hooks/useHealingUndo';
import { usePendingFixCodeActions } from '@/hooks/usePendingFixCodeActions';
import { useSmartRuleSuggestions } from '@/hooks/useSmartRuleSuggestions';
import { HealingToast } from '@/components/healing/HealingToast';
import { PreCompileHealToast } from '@/components/healing/PreCompileHealToast';
import { HealingSettingsPanel } from '@/components/healing/HealingSettingsPanel';
import { clearAIFixes, clearPendingFixes, enqueueToast, hydrateHealing, markDiagnosticsHealed, pruneHealedDiagnostics, setLiveDiagnostics } from '@/redux/healingSlice';
import { loadHealingPersistedState, saveHealingPersistedState } from '@/lib/healing/persistence';
import { selectHealingEnabled, selectHealingConfig, selectRecentlyHealedIds } from '@/redux/healingSelectors';
import { useWorkspaceAnalysis } from '@/hooks/useWorkspaceAnalysis';
import { useCompiler } from '@/hooks/useCompiler';
import { useCompileManifestListener } from '@/hooks/useCompileManifestListener';
import { useCodeIntelIndex } from '@/hooks/useCodeIntelIndex';
import AIChatWindow from '@/components/chat/AIChatWindow';
import { api } from '@/services/api';
import { gitClient } from '@/services/gitClient';
import WorkspaceNotFoundModal from '@/components/WorkspaceNotFoundModal';
import { fileCache } from '@/services/fileCache';
import { preCompileHeal, detectLanguage } from '@/services/preCompileHealer';
import { resolveDependencies } from '@/utils/dependencyResolver';
import { DraggableVideoWidget } from '@/components/DraggableVideoWidget';
import { useHMR } from '@/hooks/useHMR';
import { useRuntimeHealing } from '@/hooks/useRuntimeHealing';
import { useRetryCompile } from '@/hooks/useRetryCompile';
import { HMRStatusIndicator } from '@/components/HMRStatusIndicator';
import { RuntimeHealingIndicator } from '@/components/healing/RuntimeHealingIndicator';
import { installPreviewBridge } from '@/lib/preview-store-bridge';
import ErrorOverlay from '@/components/ErrorOverlay';
import { GitStatus } from '@/components/git/GitStatus';
import { GitSummaryPanel } from '@/components/git/GitSummaryPanel';
import { PullRequestsPanel } from '@/components/git/PullRequestsPanel';
import ActivityBar from '../ActivityBar.jsx';
import SearchView from './SearchView.jsx';
import FloatingEmulatorWindow from '@/components/emulator/FloatingEmulatorWindow';
import { EMULATOR_STATES } from '@/components/emulator/emulatorStates';
import StatusBar from '../StatusBar.jsx';
import WorkspaceHydrator from '@/components/WorkspaceHydrator';
import { ProblemsPanel } from '@/components/analysis';
import { DockablePanel, DockablePanelProvider, PANEL_STATE, DOCK_POSITION } from '@/components/docking';
import { AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSSE, useSSEEvent } from '@/hooks/useSSE';
import { useCollabNotifications } from '@/hooks/useCollabNotifications';
import { GuestBanner } from '@/components/collaboration';
import { useExtensions } from '@/hooks/useExtensions';
import ExtensionSidebar from '@/components/extensions/ExtensionSidebar';
import ExtensionViewContainer from '@/components/extensions/ExtensionViewContainer';
import { SettingsPanelContent } from '@/components/SettingsPanelContent';

// ─── New Docking Window Manager ────────────────────────
import { DockableWorkspace } from '@/components/docking-wm/DockableWorkspace';

// Feature flag: set to true to enable the new docking layout.
// When false, the existing rigid ResizablePanelGroup layout is used.
const USE_DOCKING_WM = true;

export default function EditorPage({ params }) {
    const dispatch = useAppDispatch();
    const store = useAppStore();
    const { data: authSession, status: authStatus } = useSession();
    const router = useRouter();

    // ── Auth guard: redirect unauthenticated users to the home page ─────
    useEffect(() => {
        if (authStatus === 'unauthenticated') {
            router.replace('/');
        }
    }, [authStatus, router]);

    // ── Persist auth identity into localStorage so getCurrentUser() works ──
    // Guest pages set this for guest users; workspace pages must do the same
    // for authenticated users so components like WorkspaceUsersPanel can
    // identify the current user and filter them from the list, prevent
    // self-blocking, etc.
    useEffect(() => {
        if (authSession?.user) {
            const { id, name, email, image } = authSession.user;
            if (id || email) localStorage.setItem(USER_ID_KEY, id || email);
            // Persist a human-readable name — prefer display name, then email
            // local part, to avoid leaking opaque database IDs into the UI.
            const displayName = name || (email ? email.split('@')[0] : null);
            if (displayName) localStorage.setItem(USER_NAME_KEY, displayName);
            if (image) localStorage.setItem(USER_AVATAR_KEY, image);
        }
    }, [authSession]);

    // 1. Consume the slug parameter first (needed by hooks below)
    const { slug } = use(params);

    const [chatVisible, setChatVisible] = useState(false);

    // AI Jumpstart — initial prompt/attachments from dashboard
    const [jumpstartPrompt, setJumpstartPrompt] = useState(null);
    const [jumpstartAttachments, setJumpstartAttachments] = useState(null);
    const [sidebarView, setSidebarView] = useState('explorer');
    const openPRCount = useAppSelector(s => s.pr?.prList?.filter(p => p.state === 'open' && !p.merged).length || 0);
    const [showProblemsPanel, setShowProblemsPanel] = useState(false);
    const [isProblemsPanelDocked, setIsProblemsPanelDocked] = useState(true); // Track if panel is docked or floating
    const problemsPanelRef = useRef(null); // Imperative handle for the dock slot ResizablePanel
    const sidebarPanelRef = useRef(null); // Imperative handle for the file tree panel
    const [guiConfig, setGuiConfig] = useState(null);
    const [isGuiRunning, setIsGuiRunning] = useState(false);
    const [isHmrRecompiling, setIsHmrRecompiling] = useState(false);
    const [runInGuiMode, setRunInGuiMode] = useState(false);
    const [editor, setEditor] = useState(null);
    const editorRef = useRef(null); // Ref wrapper for editor state (used by useSelfHealing)
    // Track editor content version to force re-analysis on every change (including remote/undo)
    const triggerAnalysisRef = useRef(null);
    const gateway = useAnalyzerGateway();
    const { analyzeCode, analyzeProactive, analyzeContainer, analyzeUnified, lastResult, isAnalyzing: isAnalyzingGateway, connectionMeta } = gateway;
    const { client, compile, mediaStream, cancelMobileJob, isCompiling, status: compilerStatus } = useCompiler();
    // ULTRAPLAN Phase 8: listen for compile-manifest events from the worker
    // and populate the Redux compileManifestSlice. Powers the StatusBar
    // framework pill, CompileErrorCard, and ConfidenceWarning components.
    useCompileManifestListener();
    const hmrState = useHMR();
    const healingState = useRuntimeHealing({ editorRef, gateway, autoHeal: false });
    const { canRetry, retryCount, isRetrying, retry } = useRetryCompile({ compilerClient: client, autoRetry: true });

    // ── Self-healing state: hydrate from localStorage on mount ──────────
    // The previous implementation hard-reset healing to disabled on every
    // page load, overriding whatever the user toggled.  Now we load the
    // persisted settings and let the user's choice stick.  Pending / AI
    // fix buffers are still cleared because they're per-session.
    useEffect(() => {
        const saved = loadHealingPersistedState();
        if (saved) {
            dispatch(hydrateHealing(saved));
        }
        // Always start with empty transient buffers
        dispatch(clearPendingFixes());
        dispatch(clearAIFixes());
    }, [dispatch]);

    // Persist healing enabled + config to localStorage on any change
    const healingEnabledForPersist = useAppSelector(selectHealingEnabled);
    const healingConfigForPersist = useAppSelector(selectHealingConfig);
    useEffect(() => {
        saveHealingPersistedState({
            enabled: healingEnabledForPersist,
            config: healingConfigForPersist,
        });
    }, [healingEnabledForPersist, healingConfigForPersist]);

    // Install preview-store bridge (routes window events → preview store)
    useEffect(() => {
        const cleanup = installPreviewBridge();
        return cleanup;
    }, []);

    const activeFile = useAppSelector(selectActiveFile);

    // ─── Self-Healing system ───────────────────────────────
    const activeFilePath = activeFile?.path || '';
    const activeLanguage = activeFile?.name ? getFileLanguage(activeFile.name) : 'plaintext';

    // Indirection ref for AI-escalation: useSelfHealing is declared before
    // useAIHealing, but needs to call aiHealing.analyze() for fixes routed
    // to AI_ESCALATE.  We attach the live analyze fn to this ref after
    // both hooks mount so the callback always sees the latest closure.
    const aiAnalyzeRef = useRef(null);
    const aiCallsWindowRef = useRef([]);  // timestamps — for rate-limiting

    const { selfEditFlagRef, healFromDiagnostics, triggerHealNow } = useSelfHealing({
        editorRef,
        gateway,
        filePath: activeFilePath,
        language: activeLanguage,
        active: !!editor && !!activeFile,
        onFixesApplied: useCallback((healedIds) => {
            // Remove healed diagnostics from the Problems panel so
            // auto-fixed issues no longer linger after the fix is applied.
            //
            // healedIds === null  → file was edited by the regex heal pass;
            //                       ALL diagnostics for the current file are stale.
            // healedIds === Set   → specific diagnostics were fixed by the
            //                       AI-driven healFromDiagnostics path.
            setDiagnostics(prev => prev.filter(d => {
                const diagId = d.__id || d.id;
                if (healedIds === null) {
                    // Drop every diagnostic that belongs to the active file
                    const dPath = (d.filePath || d.file || '').replace(/^[./\\]+/, '').replace(/\\/g, '/').toLowerCase();
                    const aPath = (activeFilePath || '').replace(/^[./\\]+/, '').replace(/\\/g, '/').toLowerCase();
                    return dPath !== aPath;
                }
                return !diagId || !healedIds.has(diagId);
            }));

            // Also hide the same diagnostics in mergedDiagnostics — workspace
            // analysis re-emits them with the same id until its next sweep,
            // so we keep them suppressed via Redux for ~60s.
            if (healedIds && healedIds.size > 0) {
                dispatch(markDiagnosticsHealed(Array.from(healedIds).map(String)));
            }
        }, [activeFilePath, dispatch]),
        onAIEscalate: useCallback((escalated) => {
            const analyzeFn = aiAnalyzeRef.current;
            if (!analyzeFn || !escalated?.length) return;

            // Rate-limit: drop bursts above maxAiCallsPerMinute
            const max = healingConfigForPersist?.maxAiCallsPerMinute ?? 10;
            const cutoff = Date.now() - 60_000;
            aiCallsWindowRef.current = aiCallsWindowRef.current.filter(t => t > cutoff);
            if (aiCallsWindowRef.current.length >= max) return;
            aiCallsWindowRef.current.push(Date.now());

            // Batch: request a focused analysis spanning all escalated fixes.
            const lines = escalated
                .map(e => e.fix)
                .filter(f => typeof f.startLine === 'number');
            if (!lines.length) return;
            const focusStart = Math.max(0, Math.min(...lines.map(f => f.startLine)) - 2);
            const focusEnd = Math.max(...lines.map(f => f.endLine ?? f.startLine)) + 2;

            analyzeFn({ focusStartLine: focusStart, focusEndLine: focusEnd });
        }, [healingConfigForPersist?.maxAiCallsPerMinute]),
    });
    const { undoLastFix, undoToFix } = useHealingUndo({ editorRef });

    // Wire the history panel's "Revert to here" button.  The panel
    // dispatches a CustomEvent so it stays decoupled from the Monaco editor.
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onRevert = (e) => {
            const fixId = e?.detail?.fixId;
            if (fixId) undoToFix(fixId);
        };
        window.addEventListener('synthi:heal-revert-to-fix', onRevert);
        return () => window.removeEventListener('synthi:heal-revert-to-fix', onRevert);
    }, [undoToFix]);

    // Manual "Heal current problems" button (HealingSettingsPanel) → run the
    // rule engine against the live diagnostics in Redux right now.  Held in a
    // ref so the listener doesn't re-attach on every diagnostic change.
    // The panel may have already drained its AI safe-fix bucket before
    // dispatching — we honour that count when summarising the toast.
    const healNowRef = useRef({ fn: null, diags: [] });
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const onHealNow = (e) => {
            const { fn, diags } = healNowRef.current;
            const aiAlreadyApplied = Number(e?.detail?.aiApplied) || 0;
            if (typeof fn !== 'function') {
                if (aiAlreadyApplied === 0) {
                    dispatch(enqueueToast({
                        type: 'info',
                        message: 'Self-Healing not ready — open a file first.',
                    }));
                }
                return;
            }
            const fixable = (diags || []).filter(
                (d) => d.fixes?.length > 0 && d.fixes.some((f) => f.replacementText != null)
            );
            if (fixable.length === 0) {
                if (aiAlreadyApplied > 0) {
                    // The AI bucket already cleared something — don't shout
                    // "nothing to heal".
                    dispatch(enqueueToast({
                        type: 'healing',
                        message: `Auto-fixed ${aiAlreadyApplied} AI fix${aiAlreadyApplied === 1 ? '' : 'es'}`,
                        fixCount: aiAlreadyApplied,
                        undoable: true,
                    }));
                    return;
                }
                dispatch(enqueueToast({
                    type: 'info',
                    message: (diags || []).length === 0
                        ? 'No problems detected — nothing to heal.'
                        : `${diags.length} issue${diags.length === 1 ? '' : 's'} found, but none have applicable auto-fixes. Try enabling "Also try AI for tricky errors".`,
                }));
                return;
            }
            fn(fixable);
        };
        window.addEventListener('synthi:heal-now', onHealNow);
        return () => window.removeEventListener('synthi:heal-now', onHealNow);
    }, [dispatch]);

    // Expose suggest-bucket fixes as Monaco lightbulb quick-fixes
    usePendingFixCodeActions({
        editorRef,
        filePath: activeFilePath,
        language: activeLanguage,
        active: !!editor && !!activeFile && healingEnabledForPersist,
    });

    // Smart rule suggestions: after N accepts/dismissals of the same
    // category, propose a rule via toast.
    useSmartRuleSuggestions();

    // ─── AI Healing system (LLM-powered deep analysis) ─────
    // Complements useSelfHealing (regex): catches logic errors, type
    // mismatches, null safety, off-by-one, missing awaits, etc.
    //
    // Previously gated behind window.SYNTHI_ENABLE_PROACTIVE to avoid
    // saturating Gemini.  Now driven by Redux config — user opts in via
    // the healing settings panel ("Also try AI for tricky errors").
    const aiTriggerEnabled = !!healingConfigForPersist?.triggers?.useAIForHard;
    const aiHealing = useAIHealing({
        editorRef,
        gateway,
        filePath: activeFilePath,
        language: activeLanguage,
        workspaceRoot: slug,
        analyzeOnSave: aiTriggerEnabled && healingEnabledForPersist,
        mode: 'hybrid',   // regex + LLM merged (rule engine still routes)
        selfEditFlagRef,
    });

    // Keep the ref in sync so useSelfHealing's onAIEscalate callback can
    // drive focused AI analyses.
    useEffect(() => {
        aiAnalyzeRef.current = aiHealing?.analyze || null;
    }, [aiHealing]);

    // Keyboard shortcuts: Ctrl+Shift+I (analyze), Y (apply safe), N (dismiss), M (toggle mode)
    useAIHealingKeyboard({ aiHealing });

    // Auto-analyze after 4s of inactivity (background, non-intrusive).
    // Gated behind the user's "Ask AI for tricky errors" setting.
    useAIAutoAnalysis({
        editorRef,
        analyzeCallback: aiHealing.analyze,
        enabled: aiTriggerEnabled && healingEnabledForPersist && !!editor && !!activeFile,
        debounceMs: 4000,
    });

    // Right-click → "AI: Analyze Selection" context menu
    const { registerContextMenu: registerAISelectionMenu } = useAISelectionAnalysis({
        aiHealing,
        editorRef,
    });

    // Register context menu when editor mounts
    useEffect(() => {
        if (!editor) return;
        const disposable = registerAISelectionMenu(editor);
        return () => disposable?.dispose();
    }, [editor, registerAISelectionMenu]);

    useEffect(() => {
        const handleSwitchView = (e) => {
            if (e.detail) setSidebarView(e.detail);
        };
        window.addEventListener('synthi:switch-sidebar', handleSwitchView);
        return () => window.removeEventListener('synthi:switch-sidebar', handleSwitchView);
    }, []);

    // ─── Extension system ──────────────────────────────────
    const {
        ready: extensionsReady,
        hostStatus: extensionHostStatus,
        extensions: installedExtensions,
        errors: extensionErrors,
        install: installExtension,
        enable: enableExtension,
        disable: disableExtension,
        uninstall: uninstallExtension,
        restart: restartExtension,
        executeCommand: executeExtensionCommand,
        dismissError: dismissExtensionError,
        contributedContainers,
        contributedViews,
        webviewPanels: extensionWebviewPanels,
        treeDataMap: extensionTreeDataMap,
        webviewManager: extensionWebviewManager,
        statusBarItems: extensionStatusBarItems,
        vscodeServerState,
        vscodeServerWorkspaceDir,
        vscodeTunnelService: extensionTunnelService,
        requestTreeRefresh,
        viewsWelcome: extensionViewsWelcome,
    } = useExtensions({ editor, workspaceId: slug });

    // Collaboration event toast notifications
    useCollabNotifications();

    // Code Intelligence - auto-index workspace for AI context retrieval
    const {
        isIndexing: isCodeIntelIndexing,
        isIndexed: isCodeIntelIndexed,
        filesIndexed: codeIntelFilesIndexed,
        indexWorkspace: triggerCodeIntelIndex,
        indexFile: triggerCodeIntelFileIndex,
        deleteFile: triggerCodeIntelDeleteFile,
        renameFile: triggerCodeIntelRenameFile,
    } = useCodeIntelIndex({
        workspaceSlug: slug,
        autoIndex: true, // Auto-index when workspace opens
        onIndexComplete: (result) => {
            console.log(`[Workspace] Code intelligence ready: ${result.files_indexed} files indexed`);
        },
    });

    const [latestCompletion, setLatestCompletion] = useState(null);
    const [completionClearSignal, setCompletionClearSignal] = useState(0);
    const [buildLogs, setBuildLogs] = useState([]);
    const [hmrEnabled, setHmrEnabled] = useState(true);
    const [emulatorRunNonce, setEmulatorRunNonce] = useState(0);
    const [emulatorSessionId, setEmulatorSessionId] = useState(null);
    const [emulatorForcedError, setEmulatorForcedError] = useState('');
    const reconcileRef = useRef({});
    const analysisTimeoutRef = useRef(null);
    const lastAnalyzedSignatureRef = useRef('');

    // Proactive analysis state - keyed by file path
    const [diagnostics, setDiagnostics] = useState([]);
    const [isAnalyzingProactive, setIsAnalyzingProactive] = useState(false);
    // Spinner visibility lags the truth by 800ms so quick passes never flash
    // the "Analyzing…" indicator at the user.  Only sustained analyses
    // (e.g. AI tier round-trips) actually surface the spinner.
    const [showAnalyzingSpinner, setShowAnalyzingSpinner] = useState(false);
    useEffect(() => {
        if (!isAnalyzingProactive) {
            setShowAnalyzingSpinner(false);
            return undefined;
        }
        const t = setTimeout(() => setShowAnalyzingSpinner(true), 800);
        return () => clearTimeout(t);
    }, [isAnalyzingProactive]);
    // FAST analysis: static + semantic
    const proactiveTimeoutRef = useRef(null);
    const lastFastSignatureRef = useRef('');
    const pendingFastSignatureRef = useRef('');

    // AI analysis: slower and runs separately
    const aiTimeoutRef = useRef(null);
    const lastAiSignatureRef = useRef('');
    const pendingAiSignatureRef = useRef('');
    const currentAnalysisFileRef = useRef(null); // Track which file diagnostics belong to
    const aiAnalysisRef = useRef(null);
    const lastContentHashRef = useRef('');
    // Track last analyzed hash per file per tier
    const lastFastHashMapRef = useRef(new Map());
    const lastAiHashMapRef = useRef(new Map());
    // Version counter for stale detection - increments on each edit
    const docVersionRef = useRef(0);
    const lastActiveFilePathRef = useRef('');
    const proactiveInFlightRef = useRef(0);

    const normalizePath = useCallback((p) => {
        if (!p) return '';
        return p.replace(/^[./\\]+/, '').replace(/\\/g, '/').toLowerCase();
    }, []);

    const handleAiDiagnosticsRecalibrated = useCallback((filePath, updates) => {
        if (!filePath || !Array.isArray(updates) || updates.length === 0) return;

        const target = normalizePath(filePath);
        const updateMap = new Map(
            updates
                .filter(u => u && (u.__id || u.id) && u.location)
                .map(u => [u.__id || u.id, u.location])
        );

        if (updateMap.size === 0) return;

        setDiagnostics(prev => {
            let changed = false;
            const next = prev.map(d => {
                const dPath = normalizePath(d.filePath || d.file || '');
                if (dPath !== target) return d;
                const isAi = d.tier === 'ai' || (d.source && String(d.source).toLowerCase().includes('ai'));
                if (!isAi) return d;
                const key = d.__id || d.id;
                if (!key) return d;
                const nextLoc = updateMap.get(key);
                if (!nextLoc) return d;
                changed = true;
                
                // Compute how many lines/columns the diagnostic shifted by
                const prevLoc = d.location || {};
                const lineDelta = (nextLoc.line ?? 0) - (prevLoc.line ?? 0);
                
                // Also shift fix locations so they stay aligned with the moved diagnostic
                const updatedFixes = (d.fixes || []).map(fix => {
                    if (!fix.location) return fix;
                    return {
                        ...fix,
                        location: {
                            ...fix.location,
                            line: (fix.location.line ?? 0) + lineDelta,
                            endLine: (fix.location.endLine ?? fix.location.line ?? 0) + lineDelta,
                        },
                    };
                });
                
                return {
                    ...d,
                    location: {
                        ...(d.location || {}),
                        ...nextLoc,
                    },
                    fixes: updatedFixes,
                };
            });
            return changed ? next : prev;
        });
    }, [normalizePath]);

    // Multi-file workspace analysis (cross-file issue detection)
    const {
        trackFileChange,
        trackFileDeletion,
        setFocusFile: setWorkspaceFocusFile,
        triggerAnalysis: triggerWorkspaceAnalysis,
        runFullAnalysis,
        trackFiles,
        allDiagnostics: workspaceDiagnostics,
        summary: workspaceSummary,
        isAnalyzing: isWorkspaceAnalyzing,
        clientReady: workspaceClientReady,
    } = useWorkspaceAnalysis({
        workspaceId: slug || '',
        debounceMs: 1200,  // Slightly longer debounce for workspace-level analysis
        includeAi: false,  // Disabled by default, can be enabled via settings
    });

    // ── Problems panel imperative expand/collapse ───────────────────────
    // Open: expand panel (CSS flex transition handles the smooth slide-up).
    // Close: collapse after a short delay so the content opacity fades first.
    useEffect(() => {
        const panel = problemsPanelRef.current;
        if (!panel) return;

        let rafId;
        let timerId;

        if (showProblemsPanel && isProblemsPanelDocked) {
            // Expand – use RAF so the call happens after react-resizable-panels
            // finishes its first layout measurement.
            rafId = requestAnimationFrame(() => {
                panel.resize(25);
            });
        } else {
            // Collapse – let content opacity transition (150ms) play first,
            // then collapse the panel slot so the slide-down looks intentional.
            timerId = setTimeout(() => {
                rafId = requestAnimationFrame(() => {
                    panel.collapse();
                });
            }, 120);
        }

        return () => {
            cancelAnimationFrame(rafId);
            clearTimeout(timerId);
        };
    }, [showProblemsPanel, isProblemsPanelDocked]);

    useEffect(() => {
        const handleGuiStart = (e) => {
            console.log('GUI Start event received in page', e.detail);
            setGuiConfig(e.detail);
            setIsGuiRunning(true);
        };
        const handleGuiEnd = (e) => {
            console.log('GUI End event received in page', e.detail);
            setIsGuiRunning(false);
            // Do not clear guiConfig automatically so the window stays open
            // setGuiConfig(null);
            // Do not clear mediaStream so it can be reused if the connection persists
            // setMediaStream(null);
        };

        if (typeof window !== 'undefined') {
            window.addEventListener('synthi:gui-start', handleGuiStart);
            window.addEventListener('synthi:gui-end', handleGuiEnd);
        }
        return () => {
            if (typeof window !== 'undefined') {
                window.removeEventListener('synthi:gui-start', handleGuiStart);
                window.removeEventListener('synthi:gui-end', handleGuiEnd);
            }
        };
    }, []);

    // ── CodeIntel CRUD event listeners ──────────────────────────────────
    // Redux thunks (workspaceSlice) emit CustomEvents for file create/delete/rename.
    // We listen here so we can call the hook-based CodeIntel functions.
    useEffect(() => {
        if (typeof window === 'undefined') return;

        const onIndexFile = (e) => {
            const { filePath } = e.detail || {};
            if (filePath && triggerCodeIntelFileIndex) triggerCodeIntelFileIndex(filePath);
        };
        const onDeleteFile = (e) => {
            const { filePath } = e.detail || {};
            if (filePath && triggerCodeIntelDeleteFile) triggerCodeIntelDeleteFile(filePath);
        };
        const onRenameFile = (e) => {
            const { oldPath, newPath } = e.detail || {};
            if (oldPath && newPath && triggerCodeIntelRenameFile) triggerCodeIntelRenameFile(oldPath, newPath);
        };

        window.addEventListener('synthi:codeintel-index-file', onIndexFile);
        window.addEventListener('synthi:codeintel-delete-file', onDeleteFile);
        window.addEventListener('synthi:codeintel-rename-file', onRenameFile);

        return () => {
            window.removeEventListener('synthi:codeintel-index-file', onIndexFile);
            window.removeEventListener('synthi:codeintel-delete-file', onDeleteFile);
            window.removeEventListener('synthi:codeintel-rename-file', onRenameFile);
        };
    }, [triggerCodeIntelFileIndex, triggerCodeIntelDeleteFile, triggerCodeIntelRenameFile]);

    // Helper to dispatch GUI events to the backend via CompilerClient middleware
    const sendGuiEvent = (eventPayload) => {
        try {
            if (!guiConfig || !guiConfig.sessionId) return;
            const payload = {
                type: 'gui-event',
                sessionId: guiConfig.sessionId,
                event: eventPayload
            };
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('synthi:gui-input', { detail: payload }));
            }
        } catch (e) { /* ignore */ }
    };



    const handleClearLatestCompletion = useCallback(() => {
        setLatestCompletion(null);
        setCompletionClearSignal((v) => v + 1);
    }, []);
    const [aiBusy, setAiBusy] = useState(false);

    // Workspace state
    const [workspaceMissing, setWorkspaceMissing] = useState(false);
    const [workspaceMissingMessage, setWorkspaceMissingMessage] = useState('');
    const [activeSessionId, setActiveSessionId] = useState(collabSessionService?.isActive ? collabSessionService.sessionId : null);
    const [collabHostId, setCollabHostId] = useState(collabSessionService?.hostId || null);

    useEffect(() => {
        return collabSessionService.onChange(() => {
            setActiveSessionId(collabSessionService?.isActive ? collabSessionService.sessionId : null);
            setCollabHostId(collabSessionService?.hostId || null);
        });
    }, []);

    // ── Restore guest session after redirect from collab join page ──────
    // When a guest is admitted and redirected to the host's workspace, the
    // full-page navigation resets collabSessionService to idle.  We persist
    // the session info in sessionStorage before navigating and restore it
    // here (after the onChange listener is registered so the state update
    // propagates correctly via the change event).
    useEffect(() => {
        try {
            const raw = sessionStorage.getItem('synthi-pending-guest-session');
            if (!raw) return;
            sessionStorage.removeItem('synthi-pending-guest-session');
            const { sessionId: sId, guestId, hostId, slug: sessionSlug, hostName, permissions } = JSON.parse(raw);
            if (sId && guestId) {
                collabSessionService.joinAsGuest(sId, guestId, hostId || '', sessionSlug || slug, { hostName: hostName || null, permissions: permissions || null });
            }
        } catch (_) { }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── AI Jumpstart: consume pending prompt from dashboard ──────────
    useEffect(() => {
        const payload = consumeJumpstartPayload();
        if (!payload) return;
        setChatVisible(true);
        setSidebarView(null);
        setTimeout(() => sidebarPanelRef.current?.collapse(), 50); // Collapse sidebar initially
        setJumpstartPrompt(payload.prompt || null);
        setJumpstartAttachments(payload.attachments?.length ? payload.attachments : null);
    }, []);

    useEffect(() => {
        if (slug) {
            const init = async () => {
                dispatch(setSlug(slug)); // Save slug globally
                try {
                    const result = await dispatch(fetchFilesThunk(slug));
                    if (fetchFilesThunk.rejected.match(result)) {
                        const message = result.error && result.error.message ? result.error.message : (result.error || 'Unknown error');
                        if (message && message.toLowerCase().includes('workspace not found')) {
                            setWorkspaceMissing(true);
                            setWorkspaceMissingMessage(message);
                        } else if (result.error && (result.error.name === 'AbortError' || result.error.message?.includes('Aborted due to condition'))) {
                            // Condition failed (e.g. redundant fetch prevented) - ignore
                            return;
                        } else {
                            // Non-404 errors: log and do not display the not-found modal
                            console.error('Failed to fetch workspace files:', message);
                        }
                    } else {
                        // Successful
                        setWorkspaceMissing(false);
                        setWorkspaceMissingMessage('');

                        // Initial full workspace analysis — runs only when the user
                        // has opted into continuous diagnostics via the healing
                        // settings (otherwise we'd burn Gemini credits on every
                        // workspace open).  Legacy opt-in: window.SYNTHI_ENABLE_PROACTIVE.
                        const triggers = healingConfigForPersist?.triggers || {};
                        const proactiveEnabled =
                            (healingEnabledForPersist &&
                             (triggers.onDiagnosticsStable || triggers.useAIForHard)) ||
                            (typeof window !== 'undefined' && !!window.SYNTHI_ENABLE_PROACTIVE);
                        const { files } = result.payload;
                        if (proactiveEnabled && files && files.length > 0) {
                            (async () => {
                                try {
                                    // Helper to flatten tree
                                    const flatten = (nodes) => {
                                        let flat = [];
                                        for (const node of nodes) {
                                            if (node.isFolder) {
                                                if (node.children) flat = flat.concat(flatten(node.children));
                                            } else {
                                                flat.push(node);
                                            }
                                        }
                                        return flat;
                                    };

                                    const flatFiles = flatten(files);
                                    // Limit to reasonable number of files to avoid overwhelming the browser/network
                                    const MAX_INIT_FILES = 50;
                                    const filesToAnalyze = flatFiles.slice(0, MAX_INIT_FILES);

                                    // Fetch content for analysis
                                    const filesWithContent = await Promise.all(filesToAnalyze.map(async (f) => {
                                        try {
                                            const content = await api.fetchFileContent(slug, f.path);
                                            return { ...f, content };
                                        } catch (e) {
                                            return null;
                                        }
                                    }));

                                    const validFiles = filesWithContent.filter(f => f && f.content);

                                    if (validFiles.length > 0) {
                                        trackFiles(validFiles);
                                        // Trigger full analysis (AI + Semantic + Static)
                                        await runFullAnalysis({ includeAi: true });
                                    }
                                } catch (err) {
                                    console.error('Failed to trigger initial workspace analysis', err);
                                }
                            })();
                        }
                    }
                } catch (e) {
                    const msg = e?.message || String(e);
                    if (msg.toLowerCase().includes('workspace not found')) {
                        setWorkspaceMissing(true);
                        setWorkspaceMissingMessage(msg);
                    } else {
                        // Don't hide the page for transient errors; just log
                        console.error('Failed to load workspace files', e);
                    }
                }
            };
            init();
        }
    }, [slug, dispatch]);

    // Subscribe to server-side file-tree-changed notifications so
    // all connected clients stay in sync when any teammate mutates the tree.
    const authUserId = authSession?.user?.id || authSession?.user?.email || null;
    useEffect(() => {
        collabClient.setIdentity({ userId: authUserId, sessionId: activeSessionId, hostId: collabHostId });
    }, [authUserId, activeSessionId, collabHostId]);

    useEffect(() => {
        if (!slug || !authUserId) return;
        const teardown = collabClient.connectNotifications(slug, {
            onConnected: () => {
                // Re-fetch git status on (re)connection to ensure we have
                // fresh data, especially on cold load where the initial fetch
                // may have fired before auth was ready.
                dispatch(forceRefreshGitStatus(slug));
            },
            onFileTreeChanged: () => {
                dispatch(fetchFilesThunk(slug));
            },
            onFileReverted: (filePaths) => {
                try {
                    // Invalidate fileCache for reverted files so stale cached
                    // content isn't served to openDiffThunk or other consumers.
                    if (!filePaths || filePaths.length === 0) {
                        fileCache.clear();
                    } else {
                        filePaths.forEach(fp => fileCache.delete(fp));
                    }
                    // Dispatch a DOM custom event so the Editor can react without
                    // prop-drilling. The Editor listens for 'synthi:file-reverted'
                    // and resets its Monaco model + Yjs binding for the affected files.
                    window.dispatchEvent(new CustomEvent('synthi:file-reverted', {
                        detail: { slug, filePaths },
                    }));
                } catch (e) {
                    console.warn('[Page] Error in onFileReverted handler:', e);
                }
                // Refresh git status even if the above threw — always try to
                // reflect the latest state in Source Control.
                dispatch(fetchGitStatus(slug));
            },
            onGitStatusChanged: () => {
                // Server broadcast (stage/unstage/commit etc.) — force refresh
                // bypassing the dedup guard to guarantee fresh data.
                dispatch(forceRefreshGitStatus(slug));
            },
            onFileSaved: (filePath) => {
                // Another collaborator saved this file — sync our saved state
                // so the unsaved indicator clears across all clients.
                if (filePath) {
                    dispatch(markFileSavedRemotely(filePath));
                }
            },
            onCollabInvite: (msg) => {
                // Forward collab-invite to collabSessionService so UI can
                // show accept/decline prompt in WorkspaceUsersPanel.
                import('@/services/collabSessionService').then(({ default: svc }) => {
                    svc._emit('collab-invite', msg);
                });
            },
        }, { userId: authUserId, sessionId: activeSessionId });
        return teardown;
    }, [slug, dispatch, authUserId, activeSessionId]);

    // ── SSE connection — event-driven push from backend ──────────────────
    // Establishes a single EventSource per workspace for server-pushed
    // notifications (git-status, file-tree, presence, etc.).
    // This replaces ALL HTTP polling intervals on the frontend.
    useSSE(slug, { userId: authUserId });

    // SSE: git-status-changed → force refresh git status (replaces 30s poll)
    useSSEEvent(slug, 'git-status-changed', useCallback(() => {
        startTransition(() => {
            dispatch(forceRefreshGitStatus(slug));
        });
    }, [dispatch, slug]));

    // SSE: file-tree-changed → refetch file tree
    useSSEEvent(slug, 'file-tree-changed', useCallback(() => {
        startTransition(() => {
            dispatch(fetchFilesThunk(slug));
        });
    }, [dispatch, slug]));

    // SSE: file-saved → mark file as saved remotely
    useSSEEvent(slug, 'file-saved', useCallback((data) => {
        if (data?.filePath) {
            dispatch(markFileSavedRemotely(data.filePath));
        }
    }, [dispatch]));

    // SSE: file-reverted → invalidate cache and notify editor
    useSSEEvent(slug, 'file-reverted', useCallback((data) => {
        const filePaths = data?.filePaths || [];
        try {
            if (!filePaths.length) {
                fileCache.clear();
            } else {
                filePaths.forEach(fp => fileCache.delete(fp));
            }
            window.dispatchEvent(new CustomEvent('synthi:file-reverted', {
                detail: { slug, filePaths },
            }));
        } catch (e) {
            console.warn('[Page/SSE] Error in file-reverted handler:', e);
        }
        startTransition(() => {
            dispatch(fetchGitStatus(slug));
        });
    }, [dispatch, slug]));

    // ── Re-fetch git status when auth or session becomes available ──────
    // On cold page load, the initial fetchGitStatus may fire before
    // getSession() returns auth data (no x-user-id header → wrong repo).
    // Re-fetch once auth is ready and again when a collab session activates.
    const prevAuthRef = useRef(null);
    const prevSessionRef = useRef(null);
    useEffect(() => {
        if (!slug) return;
        if (authUserId) {
            // setIdentity bundles userId + display name + email so the
            // collab-server can pin commit author/committer to the
            // requesting user — guests get correct GitHub attribution
            // even though their commits land in the host's worktree.
            gitClient.setIdentity({
                userId: authUserId,
                name: authSession?.user?.name || null,
                email: authSession?.user?.email || null,
            });
        }
        const authJustBecameAvailable = authUserId && !prevAuthRef.current;
        const sessionJustBecameAvailable = activeSessionId && !prevSessionRef.current;
        prevAuthRef.current = authUserId;
        prevSessionRef.current = activeSessionId;
        if (authJustBecameAvailable || sessionJustBecameAvailable) {
            // PERF: Git status refresh is non-critical — run in transition lane
            startTransition(() => {
                dispatch(forceRefreshGitStatus(slug));
            });
        }
    }, [slug, dispatch, authUserId, authSession?.user?.name, authSession?.user?.email, activeSessionId]);

    // 2. Consume global state directly via selectors
    const showTerminal = useAppSelector(selectShowTerminal);
    const showEmulatorPreview = useAppSelector(selectShowEmulatorPreview);
    const treeOnRight = useAppSelector(selectTreeOnRight);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    const currentContentRef = useRef(store.getState()?.workspace?.currentContent || '');
    const fileCacheEntriesRef = useRef([]);

    useEffect(() => {
        const syncWorkspaceRefs = () => {
            const state = store.getState();
            currentContentRef.current = state?.workspace?.currentContent || '';
            const cache = state?.workspace?.fileContentCache;
            fileCacheEntriesRef.current = cache && typeof cache.entries === 'function'
                ? Array.from(cache.entries())
                : [];
        };

        syncWorkspaceRefs();
        return store.subscribe(syncWorkspaceRefs);
    }, [store]);

    const getLatestCurrentContent = useCallback(() => {
        if (editor?.getValue) {
            const liveValue = editor.getValue();
            if (typeof liveValue === 'string') {
                return liveValue;
            }
        }
        return typeof currentContentRef.current === 'string' ? currentContentRef.current : '';
    }, [editor]);

    // Remove a specific diagnostic by location (called when a fix is applied)
    const removeDiagnosticByLocation = useCallback((location, filePath) => {
        if (!location) return;
        const targetFile = filePath || activeFile?.path || activeFile?.name;

        setDiagnostics(prev => prev.filter(d => {
            // Only consider diagnostics from the same file
            if (d.filePath !== targetFile) return true;

            const loc = d.location || {};
            // Remove if exact location match
            const sameStart = loc.line === location.line && loc.column === location.column;
            const sameEnd = loc.endLine === location.endLine && loc.endColumn === location.endColumn;
            return !(sameStart && sameEnd);
        }));

        // Invalidate the signature so next analysis runs fresh
        // Use requestAnimationFrame to ensure this happens AFTER the content
        // has propagated to Redux (Editor uses rAF to batch content updates)
        requestAnimationFrame(() => {
            setTimeout(() => {
                lastFastSignatureRef.current = '';
                lastAiSignatureRef.current = '';
                // Also clear the content hash to ensure fresh analysis
                lastContentHashRef.current = '';
                const target = filePath || activeFile?.path || activeFile?.name;
                if (target) {
                    lastFastHashMapRef.current.delete(target);
                    lastAiHashMapRef.current.delete(target);
                }
            }, 50); // Small delay to ensure Redux state is updated
        });
    }, [activeFile]);

    const [initialContent, setInitialContent] = useState('');
    const [hasInitialSnapshot, setHasInitialSnapshot] = useState(false);


    // Track if we've loaded the initial file content
    const [hasLoadedInitialFile, setHasLoadedInitialFile] = useState(false);

    // 3. Load content for the initially selected file
    // IMPORTANT: We must wait for the thunk to complete before setting hasLoadedInitialFile
    // Otherwise analysis may trigger before content is available in Redux
    useEffect(() => {
        if (activeFile && !hasLoadedInitialFile) {
            dispatch(selectFileThunk(activeFile))
                .then(() => {
                    // Only mark as loaded AFTER the content is actually in Redux
                    setHasLoadedInitialFile(true);
                })
                .catch((err) => {
                    console.warn('[page.jsx] Failed to load initial file content:', err);
                    // Still set as loaded to prevent infinite retry loop
                    setHasLoadedInitialFile(true);
                });
        }
    }, [activeFile, hasLoadedInitialFile, dispatch]);

    // 4. Track file changes for analysis - don't clear diagnostics from other files
    useEffect(() => {
        const currentFilePath = activeFile?.path || activeFile?.name;
        const previousFilePath = currentAnalysisFileRef.current;

        // If we're switching files, reset analysis state but keep diagnostics from other files
        if (currentFilePath && previousFilePath && currentFilePath !== previousFilePath) {
            // Reset analysis signature so new file gets analyzed
            lastFastSignatureRef.current = '';
            lastAiSignatureRef.current = '';
            lastContentHashRef.current = '';
            // Cancel any pending analysis for the old file
            if (proactiveTimeoutRef.current) {
                clearTimeout(proactiveTimeoutRef.current);
                proactiveTimeoutRef.current = null;
            }
            if (aiTimeoutRef.current) {
                clearTimeout(aiTimeoutRef.current);
                aiTimeoutRef.current = null;
            }
            if (aiAnalysisRef.current) {
                aiAnalysisRef.current.cancelled = true;
            }
        }

        // Update the current file reference
        currentAnalysisFileRef.current = currentFilePath;
    }, [activeFile]);

    // Local state for layout management (used to force remount of ResizablePanelGroup)
    const [panelGroupKey, setPanelGroupKey] = useState(0);

    // Toggling the tree orientation updates the local key and dispatches global change
    const toggleTreeOrientation = useCallback(() => {
        dispatch(setTreeOrientation());
        setPanelGroupKey(prev => prev + 1); // Force remount
    }, [dispatch]);

    // Static analysis is now handled by proactive analysis (which includes static tier)
    // Keeping this disabled to avoid duplicate/stale diagnostics
    /*
    useEffect(() => {
        if (!activeFile || !currentContent || !hasLoadedInitialFile) return;

        if (analysisTimeoutRef.current) {
            clearTimeout(analysisTimeoutRef.current);
        }

        // Debounce analyzer calls so we don't send a request for every keystroke.
        analysisTimeoutRef.current = setTimeout(() => {
            const langSource =
                activeFile.language ||
                (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
                'plaintext';
            const normalizedLang = langSource.toLowerCase();
            const signature = `${activeFile?.path || activeFile?.name || ''}::${currentContent}`;

            if (lastAnalyzedSignatureRef.current === signature) {
                return;
            }

            analyzeCode({
                lang: normalizedLang,
                code: typeof currentContent === 'string' ? currentContent : '',
            })
                .catch((err) => {
                    console.error('Static analysis failed', err);
                })
                .finally(() => {
                    lastAnalyzedSignatureRef.current = signature;
                });
        }, 500);

        return () => {
            if (analysisTimeoutRef.current) {
                clearTimeout(analysisTimeoutRef.current);
            }
        };
    }, [currentContent, activeFile, hasLoadedInitialFile, analyzeCode]);
    */

    // Run proactive analysis (AI-powered error detection) on content change
    // Simple hash function for content comparison - produces consistent hex format
    // This is used for local change detection, not cryptographic purposes
    const computeContentHash = useCallback((content) => {
        if (!content) return '';
        // FNV-1a hash - produces consistent 32-bit hash as positive hex
        let hash = 2166136261; // FNV offset basis
        for (let i = 0; i < content.length; i++) {
            hash ^= content.charCodeAt(i);
            hash = (hash * 16777619) >>> 0; // FNV prime, keep unsigned
        }
        return hash.toString(16).padStart(8, '0');
    }, []);

    // Get related files for cross-file analysis (includes, imports)
    const getRelatedFilesForAnalysis = useCallback(async () => {
        if (!activeFile || !rawFiles) return [];

        // Build a map from fileCacheEntries for fast lookup
        // This contains the LATEST edited content of open files
        const reduxCacheMap = new Map(fileCacheEntriesRef.current);

        const getContentForDep = async (path) => {
            // If it's the active file, use the current editor content
            if (path === activeFile.path) {
                return getLatestCurrentContent();
            }

            // PRIORITY 1: Check Redux cache (has edited content of open files)
            const reduxCached = reduxCacheMap.get(path);
            if (reduxCached !== undefined) {
                console.log(`[RELATED FILES] Using Redux cache for ${path}: ${reduxCached?.length || 0} chars`);
                return reduxCached;
            }

            // PRIORITY 2: Check fileCache service (LRU cache)
            const cached = fileCache.get(path);
            if (cached !== undefined) {
                console.log(`[RELATED FILES] Using fileCache for ${path}: ${cached?.length || 0} chars`);
                return cached;
            }

            // PRIORITY 3: Fetch from server
            try {
                const fetched = await api.fetchFileContent(slug, path);
                console.log(`[RELATED FILES] Fetched ${path}: ${fetched?.length || 0} chars`);
                return fetched;
            } catch (e) {
                console.warn(`Could not fetch content for ${path}:`, e);
                return '';
            }
        };

        try {
            const deps = await resolveDependencies(activeFile, rawFiles, getContentForDep);
            return deps.map(d => ({
                path: d.name,
                content: d.content,
                language: getFileLanguage(d.name)
            }));
        } catch (e) {
            console.warn('Failed to resolve dependencies for analysis:', e);
            return [];
        }
    }, [activeFile, rawFiles, slug, getLatestCurrentContent]);

    // Subscribe to editor changes to force re-analysis even for remote changes or undo/redo
    useEffect(() => {
        if (!activeFile || !hasLoadedInitialFile) return;
        if (!connectionMeta?.isConnected) return;
        if (!editor) return;

        const disposable = editor.onDidChangeModelContent(() => {
            if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        });

        if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        const recheckTimer = setTimeout(() => {
            if (triggerAnalysisRef.current) triggerAnalysisRef.current();
        }, 250);

        return () => {
            disposable.dispose();
            clearTimeout(recheckTimer);
        };
    }, [editor, activeFile, hasLoadedInitialFile, connectionMeta?.isConnected]);

    useEffect(() => {
        triggerAnalysisRef.current = () => {
        if (!activeFile || !hasLoadedInitialFile || !slug) return;

        // Proactive analysis feeds the Problems panel which drives healing.
        // Run only when the user has opted in to diagnostics-stable or
        // AI-escalate triggers — both imply they want continuous diagnostics.
        // Legacy escape hatch: window.SYNTHI_ENABLE_PROACTIVE still forces on.
        const triggers = healingConfigForPersist?.triggers || {};
        const wantsProactive =
            healingEnabledForPersist &&
            (triggers.onDiagnosticsStable || triggers.useAIForHard);
        const legacyForce = typeof window !== 'undefined' && !!window.SYNTHI_ENABLE_PROACTIVE;
        if (!wantsProactive && !legacyForce) {
            return;
        }

        // Clear timeouts exactly as we did before
        if (proactiveTimeoutRef.current) {
            clearTimeout(proactiveTimeoutRef.current);
            proactiveTimeoutRef.current = null;
        }
        if (aiTimeoutRef.current) {
            clearTimeout(aiTimeoutRef.current);
            aiTimeoutRef.current = null;
        }


        // CRITICAL: Skip analysis when the self-healing system just applied a fix.
        // Without this, the fix changes content → Redux updates currentContent →
        // this effect re-runs → schedules new analysis → which finds the same issue
        // or triggers another fix → infinite loop.
        if (selfEditFlagRef.current) return;

        // Get content from Monaco if available, falling back to Redux
        // IMPORTANT: On initial load, Monaco might not have Y.js synced changes yet.
        // We use a small delay to allow Y.js to sync before running analysis.
        const getContentToAnalyze = () => getLatestCurrentContent();

        let contentToAnalyze = getContentToAnalyze();

        // GUARD: Skip analysis if content is empty - this likely means Y.js hasn't synced yet
        // or the file content hasn't been loaded from Redux. We'll re-trigger when content updates.
        if (contentToAnalyze.length === 0) {
            console.log('[page.jsx] Skipping analysis - content is empty, waiting for Y.js sync or Redux update');
            return;
        }

        // Capture the content/file snapshot we're about to (re)analyze.
        const contentHash = computeContentHash(contentToAnalyze);
        const currentFilePath = activeFile?.path || activeFile?.name || 'untitled';

        // Helper: keep the spinner accurate across fast+AI requests
        const beginProactive = () => {
            proactiveInFlightRef.current += 1;
            setIsAnalyzingProactive(true);
        };
        const endProactive = () => {
            proactiveInFlightRef.current = Math.max(0, proactiveInFlightRef.current - 1);
            if (proactiveInFlightRef.current === 0) {
                setIsAnalyzingProactive(false);
            }
        };

        // Always analyze when a file is opened / becomes active, even if its content hash
        // matches the last analysis. This avoids stale/ghost diagnostics across refresh/tab switches.
        const prevPath = lastActiveFilePathRef.current;
        const isFileSwitch = prevPath !== currentFilePath;
        lastActiveFilePathRef.current = currentFilePath;

        // VFS correctness: when a file becomes active, never show cached/stale diagnostics
        // that were computed for an older Monaco/Yjs snapshot. Clear this file's diagnostics
        // immediately and let the next unified analysis repopulate.
        if (isFileSwitch) {
            const currentNorm = normalizePath(currentFilePath);
            setDiagnostics(prev => {
                const next = prev.filter(d => {
                    const diagPath = d?.filePath || d?.file || d?.path || '';
                    if (!diagPath) return true;
                    return normalizePath(diagPath) !== currentNorm;
                });
                return next.length === prev.length ? prev : next;
            });

            // Force a fresh analysis even if we previously analyzed the same hash.
            lastFastHashMapRef.current.delete(currentFilePath);
            lastAiHashMapRef.current.delete(currentFilePath);
            lastFastSignatureRef.current = '';
            lastAiSignatureRef.current = '';
        }

        // DEBUG: Log content hash and preview to trace stale content issues
        console.log(`[page.jsx] Content changed - Hash: ${contentHash}, Length: ${contentToAnalyze.length}`);

        // Check if content actually changed for this file compared to last analysis
        const lastFastHash = lastFastHashMapRef.current.get(currentFilePath);
        const lastAiHash = lastAiHashMapRef.current.get(currentFilePath);

        // If content hasn't changed since last analysis (e.g. just switched tabs back),
        // DO NOT clear diagnostics and DO NOT trigger new analysis.
        const shouldRunFast = !(lastFastHash === contentHash && !isFileSwitch);
        const shouldRunAi = !(lastAiHash === contentHash && !isFileSwitch);

        // Secure behavior: diagnostics are tied to a specific file snapshot.
        // Monaco markers do NOT reliably "shift" with text edits, so keeping them after edits
        // can pin errors to the wrong lines/columns (ghost underlines).
        // We clear diagnostics for the active file immediately and rely on the next analysis
        // result (validated via content-hash staleness checks) to repopulate them.
        if (lastFastHash !== contentHash) {
            // Increment version counter for stale detection
            docVersionRef.current++;

            // On any edit, immediately clear *non-AI* diagnostics for the active file.
            // AI diagnostics are kept and visually tracked to the underlying content
            // until the next AI analysis result arrives.
            setDiagnostics(prev => {
                const currentNorm = normalizePath(currentFilePath);
                const next = prev.filter(d => {
                    const diagPath = d.filePath || d.file || '';
                    if (!diagPath) return false;
                    const isSameFile = normalizePath(diagPath) === currentNorm;
                    if (!isSameFile) return true;
                    const isAi = d.tier === 'ai' || (d.source && String(d.source).toLowerCase().includes('ai'));
                    return isAi;
                });
                return next.length === prev.length ? prev : next;
            });
        }

        // IMPORTANT: Do NOT mark this hash as "analyzed" yet.
        // Fast re-renders (editorVersion bumps, Yjs sync) can cancel the debounce timer.
        // We only record the analyzed hash after a successful response.
        lastContentHashRef.current = contentHash;

        // Capture version at request time for stale detection
        const requestVersion = docVersionRef.current;

        // If we already scheduled FAST analysis for this exact snapshot, don't cancel it.
        const scheduledFastSignature = `fast::${slug}::${currentFilePath}::${contentHash}`;
        if (shouldRunFast) {
            if (!(proactiveTimeoutRef.current && pendingFastSignatureRef.current === scheduledFastSignature)) {
                if (proactiveTimeoutRef.current) {
                    clearTimeout(proactiveTimeoutRef.current);
                    proactiveTimeoutRef.current = null;
                }
                pendingFastSignatureRef.current = scheduledFastSignature;

                proactiveTimeoutRef.current = setTimeout(async () => {
                    // RE-READ CONTENT AT ANALYSIS TIME
                    // This is crucial: content might have changed (e.g., Y.js sync) since
                    // the effect started. Always use the LATEST Monaco content.
                    const freshContent = getContentToAnalyze();
                    const freshContentHash = computeContentHash(freshContent);

                    // If content is empty now, skip (Y.js might still be syncing)
                    if (freshContent.length === 0) {
                        console.log('[page.jsx] Skipping analysis - content became empty, waiting for sync');
                        return;
                    }

                    // DEBUG: Detect if content changed significantly during debounce (indicates Y.js sync race)
                    if (contentHash !== freshContentHash) {
                        const initialLines = contentToAnalyze.split('\n').length;
                        const freshLines = freshContent.split('\n').length;
                        console.log(`[page.jsx] Content changed during debounce: initial ${initialLines} lines -> fresh ${freshLines} lines (using fresh)`);
                    }

                    const langSource =
                        activeFile.language ||
                        (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
                        'plaintext';
                    const normalizedLang = langSource.toLowerCase();
                    const signature = `fast::${slug}::${currentFilePath}::${freshContentHash}`;

                    if (lastFastSignatureRef.current === signature) {
                        proactiveTimeoutRef.current = null;
                        return;
                    }

                    beginProactive();

                    // DEBUG: Log content preview to trace stale content issues
                    const contentLines = freshContent.split('\n');
                    const leadingBlankCount = contentLines.findIndex(l => l.trim() !== '');
                    const effectiveLeadingBlank = leadingBlankCount === -1 ? contentLines.length : leadingBlankCount;

                    console.log('[page.jsx] === FAST (STATIC+SEMANTIC) ANALYSIS START ===');
                    console.log('[page.jsx] Slug:', slug);
                    console.log('[page.jsx] File:', currentFilePath);
                    console.log('[page.jsx] Language:', normalizedLang);
                    console.log('[page.jsx] Version:', requestVersion);
                    console.log('[page.jsx] Content chars:', freshContent.length);
                    console.log('[page.jsx] Content lines:', contentLines.length);
                    console.log('[page.jsx] Leading blank lines:', effectiveLeadingBlank);
                    console.log('[page.jsx] First non-blank line:', contentLines[effectiveLeadingBlank]?.substring(0, 50) || 'N/A');
                    console.log('[page.jsx] NOTE: Fast pipeline (static+semantic only)');

                    // Use the new unified intelligence pipeline
                    // - Layer A: Static analysis (syntax patterns)
                    // - Layer B: Semantic analysis (CppSemanticAnalyzer, etc.)
                    // - Layer C: AI analysis (optional, auto-triggered when errors found)
                    analyzeUnified({
                        slug,
                        filePath: currentFilePath,
                        lang: normalizedLang,
                        content: freshContent,
                        layers: ['static', 'semantic'],
                        triggerAiOnErrors: false,
                        includeAi: false,
                        version: freshContentHash,           // Use content hash for robust stale detection
                    })
                        .then((result) => {
                            if (proactiveTimeoutRef.current) proactiveTimeoutRef.current = null;
                            // STALE DETECTION: Check if version (hash) matches current content hash
                            // We re-compute hash from current editor content to be absolutely sure
                            const currentEditorContent = getLatestCurrentContent();
                            const currentEditorHash = computeContentHash(currentEditorContent);

                            if (result?.version !== undefined && result.version !== currentEditorHash) {
                                console.log(`[page.jsx] Ignoring stale diagnostics (hash ${result.version} != current ${currentEditorHash})`);
                                endProactive();
                                return;
                            }

                            // Note: Content hash comparison removed - client and server use different algorithms
                            // Version-based staleness detection is sufficient and more reliable

                            console.log('[page.jsx] === FAST ANALYSIS RESULT ===');
                            console.log('[page.jsx] Layers run:', result?.layers_run);
                            console.log('[page.jsx] Summary:', result?.summary);
                            console.log('[page.jsx] Time:', result?.analysis_time_ms, 'ms');
                            console.log('[page.jsx] Content hash from server:', result?.content_hash);

                            // DEBUG: Backend echo of what it actually analyzed
                            if (result?.content_debug) {
                                console.log('[page.jsx] Backend content_debug:', result.content_debug);
                            }

                            const diags = result?.diagnostics || [];
                            console.log('[page.jsx] Diagnostics count:', diags.length);

                            // DEBUG: Print every error and the code line it refers to
                            // Use currentEditorContent which is the most up-to-date content from Monaco
                            const sourceLines = (typeof currentEditorContent === 'string' ? currentEditorContent : '').split('\n');
                            console.log('[page.jsx] Current content lines:', sourceLines.length);

                            // SECURITY GATE: If backend didn't analyze the same snapshot Monaco is showing,
                            // do NOT apply any diagnostics. This avoids ghost/stale markers.
                            const countLeadingEmpty = (lines) => {
                                let n = 0;
                                while (n < lines.length && lines[n] === '') n++;
                                return n;
                            };
                            const editorLeadingEmpty = countLeadingEmpty(sourceLines);
                            const backendDebug = result?.content_debug;
                            if (
                                backendDebug &&
                                (backendDebug.line_count !== sourceLines.length || backendDebug.leading_blank_lines !== editorLeadingEmpty)
                            ) {
                                console.warn('[page.jsx] Rejecting diagnostics: backend analyzed different content fingerprint than Monaco shows');
                                console.warn('[page.jsx]   Monaco:', { line_count: sourceLines.length, leading_blank_lines: editorLeadingEmpty });
                                console.warn('[page.jsx]   Backend:', backendDebug);
                                // Allow retry on next tick
                                lastFastHashMapRef.current.delete(currentFilePath);
                                endProactive();
                                setTimeout(() => setEditorVersion(v => v + 1), 50);
                                return;
                            }

                            let codeMismatchCount = 0;
                            diags.forEach((d, i) => {
                                const lineIdx = d.range?.start ?? d.location?.line ?? 0;
                                // Adjust for 0-based vs 1-based if needed (usually 0-based in API)
                                const codeLine = sourceLines[lineIdx] ?? "<LINE OUT OF BOUNDS>";
                                console.log(`[page.jsx]   [DIAG #${i}] Line ${lineIdx} (display as ${lineIdx + 1}): ${d.message}`);
                                console.log(`[page.jsx]     Frontend code at line ${lineIdx}: "${codeLine.trim()}"`);
                                console.log(`[page.jsx]     Backend code at line ${lineIdx}: "${d.codeAtLine || 'N/A'}"`);
                                if (codeLine.trim() !== (d.codeAtLine || '').trim()) {
                                    console.warn(`[page.jsx]     ⚠️ CODE MISMATCH! Frontend and backend see different content!`);
                                    codeMismatchCount++;
                                }
                                console.log(`[page.jsx]     Source: ${d.source || d.tier}`);
                            });

                            if (codeMismatchCount > 0) {
                                console.warn(`[page.jsx] Rejecting diagnostics due to ${codeMismatchCount} codeAtLine mismatches`);
                                // Allow retry; current snapshot should win
                                lastFastHashMapRef.current.delete(currentFilePath);
                                endProactive();
                                setTimeout(() => setEditorVersion(v => v + 1), 50);
                                return;
                            }

                            // Filter out stale diagnostics where originalText no longer matches current code
                            const filteredDiags = diags.filter(d => {
                                // Keep diagnostics without originalText (can't verify staleness)
                                if (!d.originalText) return true;

                                const loc = d.location || {};
                                const lineNum = loc.line ?? 0;
                                const endLineNum = loc.endLine ?? lineNum;
                                const col = loc.column ?? 0;
                                const endCol = loc.endColumn ?? col;

                                // Extract text at diagnostic location from current content
                                let currentTextAtLocation = '';
                                try {
                                    if (lineNum === endLineNum && lineNum < sourceLines.length) {
                                        currentTextAtLocation = sourceLines[lineNum].substring(col, endCol);
                                    } else if (lineNum < sourceLines.length) {
                                        // Multi-line
                                        const textParts = [];
                                        for (let i = lineNum; i <= Math.min(endLineNum, sourceLines.length - 1); i++) {
                                            if (i === lineNum) textParts.push(sourceLines[i].substring(col));
                                            else if (i === endLineNum) textParts.push(sourceLines[i].substring(0, endCol));
                                            else textParts.push(sourceLines[i]);
                                        }
                                        currentTextAtLocation = textParts.join('\n');
                                    }
                                } catch (e) {
                                    return true; // Keep on error
                                }

                                // FORCE FILTER: If an AI diagnostic points to purely whitespace, it is almost certainly a ghost error.
                                // This overrides any other check because AI logic errors should not attach to empty space.
                                // We check for 'ai' tier or source containing 'ai'.
                                const isAiDiagnostic = d.tier === 'ai' || (d.source && d.source.toLowerCase().includes('ai'));
                                if (isAiDiagnostic && !currentTextAtLocation.trim()) {
                                    console.log(`[page.jsx] Filtering ghost AI diagnostic on whitespace at line ${lineNum}`);
                                    return false;
                                }

                                // If originalText is missing, we can't verify staleness strictly.
                                if (!d.originalText) {
                                    return true;
                                }

                                // If text changed, diagnostic is stale
                                const isStale = currentTextAtLocation !== d.originalText;
                                if (isStale) {
                                    console.log(`[page.jsx] Filtering stale diagnostic at line ${lineNum}: originalText doesn't match current code`);
                                    console.log(`[page.jsx]   Expected: "${d.originalText}"`);
                                    console.log(`[page.jsx]   Actual: "${currentTextAtLocation}"`);
                                }
                                return !isStale;
                            });

                            console.log(`[page.jsx] After staleness filter: ${filteredDiags.length} diagnostics (removed ${diags.length - filteredDiags.length} stale)`);

                            // Normalize diagnostics to consistent format
                            const normalizedDiags = filteredDiags.map((d, idx) => ({
                                ...d,
                                // Strict VFS snapshot gating: only render diagnostics that match
                                // the exact Monaco snapshot the backend analyzed.
                                __analysisVersion: result?.version ?? freshContentHash,
                                __id: d.__id || d.id || `${contentHash}::${idx}`,
                                filePath: d.filePath || d.file || currentFilePath,
                                // Normalize location field for ProblemsPanel compatibility
                                // IMPORTANT: Use ?? instead of || to handle 0 as valid value
                                location: d.location || {
                                    line: d.range?.start ?? 0,
                                    column: d.range?.startColumn ?? 0,
                                    endLine: d.range?.end ?? d.range?.start ?? 0,
                                    endColumn: d.range?.endColumn ?? 0,
                                },
                                // Map source to tier for backward compatibility
                                tier: d.tier || (d.source?.toLowerCase().includes('ai') ? 'ai' :
                                    d.source?.toLowerCase().includes('semantic') ? 'semantic' : 'static'),
                            }));

                            // Replace NON-AI diagnostics for this file only (keep AI until AI pass arrives)
                            // PERF: startTransition — diagnostic rendering is lower-priority than typing
                            startTransition(() => {
                            setDiagnostics(prev => {
                                const currentNorm = normalizePath(currentFilePath || '');
                                const otherFileDiags = prev.filter(d => normalizePath(d.filePath || '') !== currentNorm);
                                const sameFileAi = prev.filter(d => {
                                    const isSameFile = normalizePath(d.filePath || '') === currentNorm;
                                    if (!isSameFile) return false;
                                    const isAi = d.tier === 'ai' || (d.source && String(d.source).toLowerCase().includes('ai'));
                                    return isAi;
                                });
                                console.log('[page.jsx] Setting', normalizedDiags.length, 'diagnostics for', currentFilePath);
                                return [...otherFileDiags, ...sameFileAi, ...normalizedDiags];
                            });
                            });

                            // ─── Auto-heal: feed validated quick-fixes into self-healing ───
                            // Only diagnostics that already carry a .fixes[] array with
                            // replacementText are eligible.  The healing hook applies the
                            // same category/confidence/safety filters before touching the
                            // editor, so this is safe even if the proactive pipeline returns
                            // diagnostics the user hasn't opted into auto-fixing.
                            const fixableDiags = normalizedDiags.filter(
                                (d) => d.fixes?.length > 0 && d.fixes.some((f) => f.replacementText != null)
                            );
                            if (fixableDiags.length > 0) {
                                // Defer slightly so React can flush the new diagnostics to
                                // the ProblemsPanel first (visual feedback + undo tracking).
                                // healFromDiagnostics self-gates on the Redux `enabled` flag.
                                setTimeout(() => healFromDiagnostics(fixableDiags), 60);
                            }

                            // Update hash map with the content we actually analyzed
                            lastFastHashMapRef.current.set(currentFilePath, freshContentHash);

                            // Clear pending schedule marker (only if it matches what we scheduled).
                            if (pendingFastSignatureRef.current === scheduledFastSignature) {
                                pendingFastSignatureRef.current = '';
                            }

                            lastFastSignatureRef.current = signature;
                            endProactive();
                        })
                        .catch((err) => {
                            if (proactiveTimeoutRef.current) proactiveTimeoutRef.current = null;
                            console.error('[page.jsx] Fast analysis failed:', err);
                            // Allow retry if a transient/network error happened
                            lastFastHashMapRef.current.delete(currentFilePath);
                            if (pendingFastSignatureRef.current === scheduledFastSignature) {
                                pendingFastSignatureRef.current = '';
                            }
                            endProactive();
                        });
                }, 100); // 100ms debounce for responsiveness
            }
        }

        // AI analysis is scheduled separately and later.
        const scheduledAiSignature = `ai::${slug}::${currentFilePath}::${contentHash}`;
        if (shouldRunAi) {
            if (!(aiTimeoutRef.current && pendingAiSignatureRef.current === scheduledAiSignature)) {
                if (aiTimeoutRef.current) {
                    clearTimeout(aiTimeoutRef.current);
                    aiTimeoutRef.current = null;
                }
                pendingAiSignatureRef.current = scheduledAiSignature;

                // Cancel any in-flight AI processing when content changes
                if (aiAnalysisRef.current) {
                    aiAnalysisRef.current.cancelled = true;
                }

                aiTimeoutRef.current = setTimeout(async () => {
                    const freshContent = getContentToAnalyze();
                    const freshContentHash = computeContentHash(freshContent);

                    if (freshContent.length === 0) {
                        console.log('[page.jsx] Skipping AI analysis - content became empty, waiting for sync');
                        aiTimeoutRef.current = null;
                        return;
                    }

                    const langSource =
                        activeFile.language ||
                        (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
                        'plaintext';
                    const normalizedLang = langSource.toLowerCase();
                    const signature = `ai::${slug}::${currentFilePath}::${freshContentHash}`;

                    if (lastAiSignatureRef.current === signature) {
                        aiTimeoutRef.current = null;
                        return;
                    }

                    const token = { cancelled: false };
                    aiAnalysisRef.current = token;

                    beginProactive();

                    console.log('[page.jsx] === AI ANALYSIS START ===');
                    console.log('[page.jsx] Slug:', slug);
                    console.log('[page.jsx] File:', currentFilePath);
                    console.log('[page.jsx] Language:', normalizedLang);
                    console.log('[page.jsx] Version:', requestVersion);

                    analyzeUnified({
                        slug,
                        filePath: currentFilePath,
                        lang: normalizedLang,
                        content: freshContent,
                        layers: ['ai'],
                        triggerAiOnErrors: false,
                        includeAi: true,
                        version: freshContentHash,
                    })
                        .then((result) => {
                            aiTimeoutRef.current = null;
                            if (token.cancelled) {
                                endProactive();
                                return;
                            }

                            const currentEditorContent = getLatestCurrentContent();
                            const currentEditorHash = computeContentHash(currentEditorContent);

                            if (result?.version !== undefined && result.version !== currentEditorHash) {
                                console.log(`[page.jsx] Ignoring stale AI diagnostics (hash ${result.version} != current ${currentEditorHash})`);
                                endProactive();
                                return;
                            }

                            console.log('[page.jsx] === AI ANALYSIS RESULT ===');
                            const diags = result?.diagnostics || [];

                            const sourceLines = (typeof currentEditorContent === 'string' ? currentEditorContent : '').split('\n');
                            const countLeadingEmpty = (lines) => {
                                let n = 0;
                                while (n < lines.length && lines[n] === '') n++;
                                return n;
                            };
                            const editorLeadingEmpty = countLeadingEmpty(sourceLines);
                            const backendDebug = result?.content_debug;
                            if (
                                backendDebug &&
                                (backendDebug.line_count !== sourceLines.length || backendDebug.leading_blank_lines !== editorLeadingEmpty)
                            ) {
                                console.warn('[page.jsx] Rejecting AI diagnostics: backend analyzed different content fingerprint than Monaco shows');
                                lastAiHashMapRef.current.delete(currentFilePath);
                                endProactive();
                                setTimeout(() => setEditorVersion(v => v + 1), 50);
                                return;
                            }

                            let codeMismatchCount = 0;
                            diags.forEach((d) => {
                                const lineIdx = d.range?.start ?? d.location?.line ?? 0;
                                const codeLine = sourceLines[lineIdx] ?? "";
                                if (codeLine.trim() !== (d.codeAtLine || '').trim()) {
                                    codeMismatchCount++;
                                }
                            });
                            if (codeMismatchCount > 0) {
                                console.warn(`[page.jsx] Rejecting AI diagnostics due to ${codeMismatchCount} codeAtLine mismatches`);
                                lastAiHashMapRef.current.delete(currentFilePath);
                                endProactive();
                                setTimeout(() => setEditorVersion(v => v + 1), 50);
                                return;
                            }

                            const filteredDiags = diags.filter(d => {
                                if (!d.originalText) return true;

                                const loc = d.location || {};
                                const lineNum = loc.line ?? 0;
                                const endLineNum = loc.endLine ?? lineNum;
                                const col = loc.column ?? 0;
                                const endCol = loc.endColumn ?? col;

                                let currentTextAtLocation = '';
                                try {
                                    if (lineNum === endLineNum && lineNum < sourceLines.length) {
                                        currentTextAtLocation = sourceLines[lineNum].substring(col, endCol);
                                    } else if (lineNum < sourceLines.length) {
                                        const textParts = [];
                                        for (let i = lineNum; i <= Math.min(endLineNum, sourceLines.length - 1); i++) {
                                            if (i === lineNum) textParts.push(sourceLines[i].substring(col));
                                            else if (i === endLineNum) textParts.push(sourceLines[i].substring(0, endCol));
                                            else textParts.push(sourceLines[i]);
                                        }
                                        currentTextAtLocation = textParts.join('\n');
                                    }
                                } catch (e) {
                                    return true;
                                }

                                // Filter ghost AI diagnostics on whitespace
                                if (!currentTextAtLocation.trim()) {
                                    return false;
                                }

                                const isStale = currentTextAtLocation !== d.originalText;
                                return !isStale;
                            });

                            const normalizedDiags = filteredDiags.map((d, idx) => ({
                                ...d,
                                __analysisVersion: result?.version ?? freshContentHash,
                                __id: d.__id || d.id || `${freshContentHash}::ai::${idx}`,
                                filePath: d.filePath || d.file || currentFilePath,
                                location: d.location || {
                                    line: d.range?.start ?? 0,
                                    column: d.range?.startColumn ?? 0,
                                    endLine: d.range?.end ?? d.range?.start ?? 0,
                                    endColumn: d.range?.endColumn ?? 0,
                                },
                                tier: 'ai',
                            }));

                            // PERF: startTransition — AI diagnostic rendering is lower-priority than typing
                            startTransition(() => {
                            setDiagnostics(prev => {
                                const currentNorm = normalizePath(currentFilePath || '');
                                const otherFileDiags = prev.filter(d => normalizePath(d.filePath || '') !== currentNorm);
                                const sameFileNonAi = prev.filter(d => {
                                    const isSameFile = normalizePath(d.filePath || '') === currentNorm;
                                    if (!isSameFile) return false;
                                    const isAi = d.tier === 'ai' || (d.source && String(d.source).toLowerCase().includes('ai'));
                                    return !isAi;
                                });
                                return [...otherFileDiags, ...sameFileNonAi, ...normalizedDiags];
                            });
                            });

                            // ─── Auto-heal AI quick-fixes ──────────────────────────
                            const fixableAiDiags = normalizedDiags.filter(
                                (d) => d.fixes?.length > 0 && d.fixes.some((f) => f.replacementText != null)
                            );
                            if (fixableAiDiags.length > 0) {
                                // healFromDiagnostics self-gates on the Redux `enabled` flag.
                                setTimeout(() => healFromDiagnostics(fixableAiDiags), 60);
                            }

                            lastAiHashMapRef.current.set(currentFilePath, freshContentHash);
                            if (pendingAiSignatureRef.current === scheduledAiSignature) {
                                pendingAiSignatureRef.current = '';
                            }
                            lastAiSignatureRef.current = signature;
                            endProactive();
                        })
                        .catch((err) => {
                            aiTimeoutRef.current = null;
                            console.error('[page.jsx] AI analysis failed:', err);
                            lastAiHashMapRef.current.delete(currentFilePath);
                            if (pendingAiSignatureRef.current === scheduledAiSignature) {
                                pendingAiSignatureRef.current = '';
                            }
                            endProactive();
                        });
                }, 900); // AI debounce (slower)
            }
        }

        }; // end of triggerAnalysisRef.current function
    }); // Runs on every render without deps so it captures fresh scope!


    // Track focused file and content changes for workspace analysis
    useEffect(() => {
        if (!activeFile || !hasLoadedInitialFile) return;

        const filePath = activeFile?.path || activeFile?.name;
        if (filePath) {
            setWorkspaceFocusFile(filePath);
        }
    }, [activeFile, hasLoadedInitialFile, setWorkspaceFocusFile]);

    // NOTE: Workspace analysis is DISABLED because it runs without related files context,
    // causing false positives (e.g., "test228 is not defined" when it IS defined in a header).
    // The proactive analysis (above) already handles single-file analysis with related files.
    // TODO: Re-enable workspace analysis once it properly includes related files.
    /*
    // Notify workspace analyzer when file content changes
    useEffect(() => {
        if (!activeFile || !currentContent || !hasLoadedInitialFile || !workspaceClientReady) return;
        
        const filePath = activeFile?.path || activeFile?.name;
        const language = activeFile.language || (activeFile.name ? getFileLanguage(activeFile.name) : 'plaintext');
        
        if (filePath && typeof currentContent === 'string') {
            // Track the file change
            const didChange = trackFileChange(filePath, currentContent, language);
            if (didChange) {
                // Trigger workspace analysis (debounced internally)
                triggerWorkspaceAnalysis();
            }
        }
    }, [currentContent, activeFile, hasLoadedInitialFile, workspaceClientReady, trackFileChange, triggerWorkspaceAnalysis]);
    */

    // Recently-healed diagnostic ids — Redux-tracked so the filter below
    // hides them between apply and re-analysis.  Without this, workspace
    // analysis re-emits the same diagnostic before the next sweep proves
    // it's actually gone.
    const recentlyHealedIds = useAppSelector(selectRecentlyHealedIds);

    // Merge single-file diagnostics with workspace-level cross-file diagnostics
    const mergedDiagnostics = useMemo(() => {
        const seen = new Set();
        const out = [];
        const cutoff = Date.now() - 30_000;

        for (const d of [...diagnostics, ...workspaceDiagnostics]) {
            // Skip diagnostics we've just healed locally — they hang around
            // until the next analysis pass confirms they're gone.
            const did = d?.__id || d?.id;
            if (did && recentlyHealedIds[String(did)] && recentlyHealedIds[String(did)] > cutoff) {
                continue;
            }

            // Stronger dedup key includes file path + severity so the same
            // message at the same location reported by two tiers (fast vs
            // ai vs workspace) collapses to one entry.
            const path = String(d?.filePath || d?.file || '').toLowerCase();
            const key = `${path}::${d?.message || ''}::${d?.location?.line ?? ''}::${d?.location?.column ?? ''}::${d?.severity || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(d);
        }

        return out;
    }, [diagnostics, workspaceDiagnostics, recentlyHealedIds]);

    // Periodically prune the recently-healed map so it doesn't grow
    // unbounded over a long session.  60s aligns with the cutoff above.
    useEffect(() => {
        const t = setInterval(() => {
            dispatch(pruneHealedDiagnostics(Date.now() - 60_000));
        }, 30_000);
        return () => clearInterval(t);
    }, [dispatch]);

    // Mirror merged diagnostics into Redux so the rule editor can show live
    // preview counts and the file tree can render health dots.
    useEffect(() => {
        dispatch(setLiveDiagnostics(mergedDiagnostics));
    }, [mergedDiagnostics, dispatch]);

    // Keep the manual "Heal Now" listener pointed at the latest
    // healFromDiagnostics callback and the latest diagnostic snapshot.
    useEffect(() => {
        healNowRef.current = { fn: healFromDiagnostics, diags: mergedDiagnostics };
    }, [healFromDiagnostics, mergedDiagnostics]);

    // Compute diagnostic summary from merged diagnostics
    const diagnosticSummaryRaw = useMemo(() => {
        const errors = mergedDiagnostics.filter(d => d.severity === 'error').length;
        const warnings = mergedDiagnostics.filter(d => d.severity === 'warning').length;
        return {
            errors,
            warnings,
            total: mergedDiagnostics.length,
            workspaceErrors: workspaceSummary.errors,
            workspaceWarnings: workspaceSummary.warnings,
        };
    }, [mergedDiagnostics, workspaceSummary]);

    // PERF: Defer the diagnostic summary so the StatusBar and ProblemsPanel
    // re-render in a lower-priority concurrent lane, never blocking keystrokes.
    const diagnosticSummary = useDeferredValue(diagnosticSummaryRaw);

    // NOTE: Completion requests are handled centrally by the Editor component
    // to avoid duplicate requests, races, and abort-related errors. If you need
    // a page-level completion flow (for example, for collaborative features),
    // reintroduce a single centralized caller with an AbortController and proper
    // dedupe. Leaving this commented-out avoids the 'Canceled' errors caused by
    // concurrent requests from both page and editor.

    const appendBuildLog = useCallback((line) => {
        setBuildLogs((prev) => [...prev, line].slice(-200));
    }, []);

    // Apply worker-generated Android/Gradle artifacts back into the real workspace.
    // This is session-scoped and only runs for the active emulator session.
    useEffect(() => {
        if (typeof window === 'undefined') return;

        const handler = async (e) => {
            const msg = e?.detail;
            if (!msg || typeof msg !== 'object') return;
            const sid = msg.sessionId;
            if (!sid) return;

            // Only apply patches for the active mobile session to avoid cross-talk.
            if (emulatorSessionId && sid !== emulatorSessionId) return;

            const state = reconcileRef.current;
            if (!state[sid]) {
                state[sid] = { files: new Map(), ready: [], summary: null };
            }
            const s = state[sid];

            if (msg.type === 'workspace-reconcile-begin') {
                s.files = new Map();
                s.ready = [];
                s.summary = msg.summary || null;
                appendBuildLog('[sync] Capturing generated Android/Gradle artifacts...');
                return;
            }

            if (msg.type === 'workspace-file-begin') {
                const totalChunks = Number(msg.total_chunks) || 0;
                if (!msg.path || totalChunks <= 0) return;
                s.files.set(msg.path, {
                    totalChunks,
                    chunks: new Array(totalChunks),
                    received: 0,
                    mode: msg.mode,
                    sha256: msg.sha256,
                    kind: msg.data,
                });
                return;
            }

            if (msg.type === 'workspace-file-chunk') {
                if (!msg.path) return;
                const entry = s.files.get(msg.path);
                if (!entry) return;
                const idx = Number(msg.idx);
                if (!Number.isFinite(idx) || idx < 0 || idx >= entry.totalChunks) return;
                if (typeof msg.data !== 'string') return;
                if (entry.chunks[idx] === undefined) {
                    entry.chunks[idx] = msg.data;
                    entry.received += 1;
                }
                return;
            }

            if (msg.type === 'workspace-file-end') {
                if (!msg.path) return;
                const entry = s.files.get(msg.path);
                if (!entry) return;
                if (entry.received !== entry.totalChunks) {
                    appendBuildLog(`[sync] Skipping incomplete file: ${msg.path}`);
                    return;
                }
                const base64 = entry.chunks.join('');
                s.ready.push({ path: msg.path, encoding: 'base64', content: base64 });
                return;
            }

            if (msg.type === 'workspace-reconcile-end') {
                const files = s.ready || [];
                const count = files.length;
                if (count === 0) {
                    appendBuildLog('[sync] No generated files to persist.');
                    return;
                }

                appendBuildLog(`[sync] Persisting ${count} generated file(s) into workspace...`);
                try {
                    const result = await gitClient.writeFilesBatch(slug, files, { syncToGcs: true });

                    // Invalidate caches for any text-ish files we may display.
                    for (const f of files) {
                        if (typeof f.path === 'string') fileCache.delete(f.path);
                    }

                    await dispatch(fetchFilesThunk(slug));

                    const writtenCount = Array.isArray(result?.written) ? result.written.length : 0;
                    const skippedCount = Array.isArray(result?.skipped) ? result.skipped.length : 0;
                    const errorCount = Array.isArray(result?.errors) ? result.errors.length : 0;
                    appendBuildLog(`[sync] Applied: ${writtenCount}, skipped: ${skippedCount}, errors: ${errorCount}`);
                } catch (err) {
                    console.error('Workspace reconciliation apply failed', err);
                    appendBuildLog(`[sync] Apply failed: ${err?.message || String(err)}`);
                }
                return;
            }
        };

        window.addEventListener('synthi:workspace-reconcile', handler);
        return () => window.removeEventListener('synthi:workspace-reconcile', handler);
    }, [appendBuildLog, dispatch, emulatorSessionId, slug]);

    // Helper to detect if source code contains React Native imports
    const detectReactNativeInSource = useCallback((source) => {
        if (!source) return false;
        const rnPatterns = [
            /from\s+['"]react-native['"]/,
            /require\s*\(['"]react-native['"]\)/,
            /from\s+['"]@react-native/,
            /from\s+['"]expo/,
            /import.*from\s+['"]react-native-/
        ];
        return rnPatterns.some(pattern => pattern.test(source));
    }, []);

    // Helper to detect if workspace is a React Native project (checks package.json)
    const detectReactNativeProject = useCallback(async () => {
        try {
            // Look for package.json in the workspace (handle various path formats)
            const packageJsonFile = rawFiles?.find(f =>
                f.name === 'package.json' &&
                (!f.path || f.path === 'package.json' || f.path === '/package.json')
            );
            if (!packageJsonFile) return false;

            // Fetch content
            const cached = fileCache.get('package.json');
            let content = cached;
            if (content === undefined) {
                content = await api.fetchFileContent(slug, 'package.json');
            }
            if (!content) return false;

            const pkg = JSON.parse(content);
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            return !!(deps['react-native'] || deps['expo']);
        } catch (e) {
            console.debug('Failed to detect React Native project from package.json', e);
            return false;
        }
    }, [rawFiles, slug]);

    // Helper to detect if source code contains Flutter imports
    const detectFlutterInSource = useCallback((source) => {
        if (!source) return false;
        return source.includes('package:flutter/');
    }, []);

    // Helper to detect if workspace is a Flutter project (checks pubspec.yaml)
    const detectFlutterProject = useCallback(async () => {
        try {
            const pubspecFile = rawFiles?.find(f =>
                f.name === 'pubspec.yaml' &&
                (!f.path || f.path === 'pubspec.yaml' || f.path === '/pubspec.yaml')
            );
            if (!pubspecFile) return false;

            const cached = fileCache.get('pubspec.yaml');
            let content = cached;
            if (content === undefined) {
                content = await api.fetchFileContent(slug, 'pubspec.yaml');
            }
            if (!content) return false;

            return content.includes('sdk: flutter');
        } catch (e) {
            console.debug('Failed to detect Flutter project', e);
            return false;
        }
    }, [rawFiles, slug]);

    const handleRun = useCallback(async (options = {}) => {
        const isEvent = options && typeof options.preventDefault === 'function';
        const skipCancel = isEvent ? false : (options.skipCancel || false);
        const latestCode = isEvent ? null : (options.latestCode || null);

        if (!activeFile) {
            console.warn('No active file selected for compilation.');
            return;
        }

        // Dispatch optimistic "compiling" status immediately for fast feedback
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('synthi:hmr-status', {
                detail: { status: 'compiling', module: activeFile?.name || 'unknown' }
            }));
        }

        const source = typeof latestCode === 'string' ? latestCode : getLatestCurrentContent();
        // Use the full path to preserve directory structure in the worker
        const filename = activeFile?.path || activeFile?.name || 'main';
        // Ensure a terminal is visible when running so output is shown
        try {
            if (!showTerminal) dispatch(toggleTerminal());
        } catch (e) {
            // continue even if toggling the terminal fails
            console.debug('toggleTerminal failed or not available', e);
        }

        setBuildLogs([`Running build for ${filename}...`]);

        // Auto-switch to the Output panel in the docking WM so users see program output
        try {
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('synthi:show-output-panel'));
            }
        } catch (_) { /* ignore */ }

        // Define a getter for content that checks current editor state, cache, or API
        const getContentForDependency = async (path) => {
            // If it's the active file, use the current editor content (which might be unsaved)
            if (path === activeFile.path) {
                return typeof latestCode === 'string' ? latestCode : getLatestCurrentContent();
            }
            // Check cache
            const cached = fileCache.get(path);
            if (cached !== undefined) return cached;
            // Fetch
            return await api.fetchFileContent(slug, path);
        };

        let additionalFiles = [];
        try {
            additionalFiles = await resolveDependencies(activeFile, rawFiles, getContentForDependency);
        } catch (e) {
            console.error("Dependency resolution failed", e);
            appendBuildLog(`Warning: Dependency resolution failed: ${e.message}`);
        }

        // Detect if this is a React Native project for mobile emulator target
        // Check both package.json dependencies AND source code imports
        const ext = (filename || '').split('.').pop().toLowerCase();
        const isJsxFile = ['js', 'jsx', 'tsx', 'ts'].includes(ext);
        const hasRnImports = isJsxFile && detectReactNativeInSource(source);
        const hasRnPackage = await detectReactNativeProject();
        const isReactNative = hasRnImports || hasRnPackage;

        // Detect Flutter
        const isDartFile = ext === 'dart';
        const hasFlutterImports = isDartFile && detectFlutterInSource(source);
        const hasFlutterPackage = await detectFlutterProject();
        const isFlutter = hasFlutterImports || hasFlutterPackage;

        // Detect Java GUI (Swing / AWT / JavaFX) — auto-enable GUI mode.
        // Check both the active file AND resolved dependency files, because
        // the main class may delegate to a GUI class without importing Swing directly.
        const isJavaFile = ext === 'java';
        const javaGuiRe = /\bimport\s+(javax\.swing|java\.awt|javafx\.)/m;
        const hasJavaGuiImports = isJavaFile && (
            javaGuiRe.test(source) ||
            additionalFiles.some(f => javaGuiRe.test(f.content || ''))
        );

        let target = null;
        if (isReactNative) target = 'react-native-emulator';
        else if (isFlutter) target = 'flutter-android-emulator';

        const isMobile = isReactNative || isFlutter;

        // If Java GUI imports are detected, override isGui to true so the
        // backend spawns Xvfb + GStreamer and streams to the in-app preview.
        const effectiveGuiMode = runInGuiMode || hasJavaGuiImports;

        // Auto-open the emulator panel when we run a mobile build.
        let mobileSid = null;
        if (isMobile) {
            // Cancel previous session if restart
            if (emulatorSessionId && !skipCancel) {
                console.log('[handleRun] Restarting - cancelling previous session:', emulatorSessionId);
                await cancelMobileJob(emulatorSessionId);
            }

            mobileSid = `sess-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
            setEmulatorSessionId(mobileSid);
            setEmulatorForcedError('');
            dispatch(setEmulatorPreviewVisible(true));
            setEmulatorRunNonce((v) => v + 1); // remount to simulate a fresh boot
        }

        // Derive project root from active file's directory path
        // e.g., "mobile/app.tsx" -> "mobile", "src/screens/Home.tsx" -> "src/screens"
        let projectRoot = null;
        if (isMobile && filename) {
            const fileParts = filename.replace(/\\/g, '/').split('/');
            // Remove the filename to get directory
            fileParts.pop();
            projectRoot = fileParts.join('/') || '/';
            if (isReactNative) {
                appendBuildLog(`Detected React Native project at: ${projectRoot}`);
            } else if (isFlutter) {
                appendBuildLog(`Detected Flutter project at: ${projectRoot}`);
            }
        }

        try {
            await compile({
                filename,
                source,
                files: additionalFiles,
                isGui: effectiveGuiMode,
                target,
                projectRoot,
                slug, // Pass workspace slug for mobile builds to download synced files
                sessionId: mobileSid,
                onLog: (line) => {
                    appendBuildLog(line);
                    console.log('[build]', line);
                },
            });
            appendBuildLog('Build succeeded.');
        } catch (err) {
            const msg = err?.message || String(err);
            if (msg.includes('cancelled by user') || msg.includes('Cancelled')) {
                console.log('Build cancelled (probably due to restart/stop)');
                return;
            }
            console.error('Compile failed', err);
            appendBuildLog(`error: ${msg}`);
            if (isReactNative) {
                setEmulatorForcedError(msg);
            }
        }
    }, [activeFile, appendBuildLog, dispatch, showTerminal, rawFiles, slug, compile, detectReactNativeProject, detectReactNativeInSource, runInGuiMode, emulatorSessionId, cancelMobileJob, getLatestCurrentContent]);

    const handleStop = useCallback(async () => {
        const activeSessionId = client?.getActiveSessionId?.();
        if (activeSessionId) {
            const result = await client.cancelBuild(activeSessionId);
            if (!result || !result.cancelled) {
                if (typeof window !== 'undefined' && window.alert) {
                    window.alert(
                        `Build did not fully stop yet (session ${activeSessionId}).\n` +
                        `Please wait a moment and try again.`
                    );
                }
                return;
            }
        }
        if (emulatorSessionId) {
            setEmulatorForcedError('Compilation stopped by user.');
            dispatch(setEmulatorPreviewVisible(false));
            // Ensure status shows as stopped/failed immediately to clear UI
            appendBuildLog('Stopped by user.');
        }
        if (!emulatorSessionId) {
            appendBuildLog('Stopped by user.');
        }
        if (client?.reconnect) {
            await client.reconnect();
        }
    }, [emulatorSessionId, dispatch, appendBuildLog, client]);

    const handleRestart = useCallback(async () => {
        const activeSessionId = client?.getActiveSessionId?.();
        if (activeSessionId) {
            const result = await client.cancelBuild(activeSessionId);
            if (!result || !result.cancelled) {
                if (typeof window !== 'undefined' && window.alert) {
                    window.alert(
                        `Build did not fully stop yet (session ${activeSessionId}).\n` +
                        `Please wait a moment and try again.`
                    );
                }
                return;
            }
        }
        if (client?.reconnect) {
            await client.reconnect();
        }
        await handleRun({ skipCancel: true });
    }, [client, handleRun]);

    // Keep the latest heal trigger + settings visible to handleSave without
    // adding them to its dep array (which would churn on every config tweak).
    // The save trigger runs through healFromDiagnostics so it routes through
    // the user rule engine (boldness levels + custom rules) — runHealPass
    // would bypass those and only honour autoHealCategories/minConfidence.
    const healSaveRef = useRef({ enabled: false, onSave: false, fn: null, diags: [] });
    useEffect(() => {
        healSaveRef.current = {
            enabled: healingEnabledForPersist,
            onSave: !!healingConfigForPersist?.triggers?.onSave,
            fn: healFromDiagnostics,
            diags: mergedDiagnostics,
        };
    }, [healingEnabledForPersist, healingConfigForPersist, healFromDiagnostics, mergedDiagnostics]);

    const handleSave = useCallback(async (latestCode) => {
        console.log('[HMR] handleSave called with activeFile:', activeFile?.name);
        if (!activeFile) return;

        // If HMR is disabled, skip recompilation on save
        if (!hmrEnabled) {
            console.log('[HMR] HMR disabled — skipping recompilation on save');
            return;
        }

        // Dispatch optimistic "compiling" status immediately for fast feedback
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('synthi:hmr-status', {
                detail: { status: 'compiling', module: activeFile?.name || 'unknown' }
            }));
        }

        // Similar to handleRun but silent and doesn't force terminal open
        let source = typeof latestCode === 'string' ? latestCode : getLatestCurrentContent();
        const filename = activeFile?.path || activeFile?.name || 'main';

        // Note: CodeIntel re-index is triggered by saveFileContentThunk
        // (via synthi:codeintel-index-file event) so both manual and auto-save
        // paths are covered. No need to trigger it again here.

        // Check if language is supported for compilation to avoid errors
        const ext = (filename.split('.').pop() || '').toLowerCase();
        const supportedExts = ['c', 'cpp', 'cc', 'cxx', 'hpp', 'h', 'rs', 'ts', 'tsx'];
        if (!supportedExts.includes(ext)) {
            console.log(`[HMR] Skipping silent compilation for unsupported extension: .${ext}`);
            return;
        }

        console.log(`[HMR] Proceeding with compilation for ${filename}`);

        // ── Pre-compile healing: fix syntax breakers BEFORE they reach the compiler ──
        // Runs client-side, zero network latency, <5ms. Catches colons, semicolons,
        // brackets — the small typos that break HMR cycles.
        const lang = detectLanguage(filename);
        const healResult = preCompileHeal(source, lang);
        if (healResult.changed) {
            source = healResult.code;
            console.log(`[HMR:PreCompile] Healed ${healResult.fixes.length} syntax issue(s) in ${healResult.elapsedMs.toFixed(1)}ms`);
            // Notify the UI so a toast/indicator can show what was fixed
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('synthi:pre-compile-heal', {
                    detail: {
                        fixes: healResult.fixes,
                        filename,
                        elapsedMs: healResult.elapsedMs,
                    }
                }));
            }
        }

        const getContentForDependency = async (path) => {
            if (path === activeFile.path) return typeof latestCode === 'string' ? latestCode : getLatestCurrentContent();
            const cached = fileCache.get(path);
            if (cached !== undefined) return cached;
            return await api.fetchFileContent(slug, path);
        };

        let additionalFiles = [];
        try {
            additionalFiles = await resolveDependencies(activeFile, rawFiles, getContentForDependency);
        } catch (e) {
            console.error("Dependency resolution failed during save", e);
        }

        try {
            // HMR mode: kill the running app and re-compile with latest code.
            // We dismiss the old session locally (so the old promise doesn't
            // block), then send a fresh compile request. The worker's compile
            // handler sees the existing RunnerState, kills the runner process,
            // but REUSES Xvfb + GStreamer (same resolution + gui mode). The
            // video feed stays live (shows empty desktop briefly) while the
            // new code compiles and the new runner starts.
            console.log('[HMR] Killing app and re-compiling with latest code...');
            setIsHmrRecompiling(true);

            // If there's no active GUI session, we need isGui=true for the
            // worker to set up the video pipeline.
            // Also auto-detect Java GUI (Swing/AWT/JavaFX) imports in main + deps.
            const ext = (filename || '').split('.').pop().toLowerCase();
            const javaGuiRe = /\bimport\s+(javax\.swing|java\.awt|javafx\.)/m;
            const hasJavaGui = ext === 'java' && (
                javaGuiRe.test(source) ||
                additionalFiles.some(f => javaGuiRe.test(f.content || ''))
            );
            const shouldRunGui = runInGuiMode || isGuiRunning || hasJavaGui;

            const activeSessionId = client?.getActiveSessionId?.();
            if (activeSessionId) {
                // Local-only cleanup: reject pending promise, clear session.
                // Does NOT send cancel-build to the worker — the worker's
                // compile handler will kill the old runner process itself.
                client.dismissSession(activeSessionId);
            }

            await compile({
                filename,
                source,
                files: additionalFiles,
                isGui: shouldRunGui,
            });
            setIsHmrRecompiling(false);
            console.log('[HMR] Re-run succeeded after save');
        } catch (err) {
            setIsHmrRecompiling(false);
            // Don't log HMR restart rejections from the dismissed session.
            // SynthiException('Cancelled', 'HMR restart') produces message "Cancelled: HMR restart"
            const msg = err?.message || '';
            if (msg.includes('HMR restart') || msg.includes('Cancelled')) return;
            console.error('[HMR] HMR re-run failed', err);
        }

        // Self-healing on save — non-blocking: heal attempts run AFTER the
        // compile kicks off, so a save is never delayed by healing.
        try {
            const { enabled: hEnabled, onSave: hOnSave, fn: hFn, diags: hDiags } = healSaveRef.current;
            if (hEnabled && hOnSave && typeof hFn === 'function') {
                const fixable = (hDiags || []).filter(
                    (d) => d.fixes?.length > 0 && d.fixes.some((f) => f.replacementText != null)
                );
                if (fixable.length > 0) {
                    setTimeout(() => { try { hFn(fixable); } catch (_) { /* ignore */ } }, 0);
                }
            }
        } catch (_) { /* never let healing break save */ }
    }, [activeFile, rawFiles, slug, compile, hmrEnabled, runInGuiMode, isGuiRunning, client, getLatestCurrentContent]);

    const handleEditorMount = useCallback((editorInstance) => {
        setEditor(editorInstance);
        editorRef.current = editorInstance; // Keep ref in sync for useSelfHealing
        // Wait until file is loaded, then capture snapshot
        if (activeFile && !hasInitialSnapshot) {
            const currentValue = editorInstance.getValue();
            setInitialContent(currentValue);
            setHasInitialSnapshot(true);
        }
    }, [activeFile, hasInitialSnapshot]);

    const handleToggleChat = useCallback(() => {
        setChatVisible((v) => !v);
    }, []);

    const handleUndo = useCallback(() => {
        if (editor) {
            const currentValue = editor.getValue();
            // Prevent undo if no change since initial load
            if (currentValue !== initialContent) {
                editor.trigger('keyboard', 'undo', null);
            }
        }
    }, [editor, initialContent]);

    const handleRedo = useCallback(() => {
        if (editor) {
            editor.trigger('keyboard', 'redo', null);
        }
    }, [editor]);

    const handleCopyLineUp = useCallback(() => editor?.getAction('editor.action.copyLinesUpAction')?.run(), [editor]);
    const handleCopyLineDown = useCallback(() => editor?.getAction('editor.action.copyLinesDownAction')?.run(), [editor]);
    const handleMoveLineUp = useCallback(() => editor?.getAction('editor.action.moveLinesUpAction')?.run(), [editor]);
    const handleMoveLineDown = useCallback(() => editor?.getAction('editor.action.moveLinesDownAction')?.run(), [editor]);
    const handleDuplicateSelection = useCallback(() => editor?.getAction('editor.action.duplicateSelection')?.run(), [editor]);

    const EditorPanelComponent = (
        <EditorPanel
            onRun={handleRun}
            onSave={handleSave}
            onToggleTerminal={() => dispatch(toggleTerminal())}
            onEditorMount={handleEditorMount}
            analysisResult={lastResult}
            diagnostics={mergedDiagnostics}
            onAiDiagnosticsRecalibrated={handleAiDiagnosticsRecalibrated}
            removeDiagnosticByLocation={removeDiagnosticByLocation}
            latestCompletion={latestCompletion}
            aiBusy={aiBusy}
            onClearCompletion={handleClearLatestCompletion}
            chatVisible={chatVisible}
            collabHostId={collabHostId}
            selfEditFlagRef={selfEditFlagRef}
        />
    );

    const FileTreePanel = (
        <ResizablePanel 
            ref={sidebarPanelRef}
            defaultSize={20} minSize={12} maxSize={35} 
            collapsible={true}
            collapsedSize={4}
            className={`${treeOnRight ? 'border-l' : 'border-r'} transition-all duration-300 ease-in-out`}
            style={{ borderColor: 'var(--border-medium)', background: 'var(--bg-sidebar)' }}
            onCollapse={() => {
                if (sidebarView !== null) setSidebarView(null);
            }}
            onExpand={() => {
                if (sidebarView === null) setSidebarView('explorer');
            }}
        >
            <div className="flex h-full min-w-0 overflow-hidden">
                <ActivityBar
                    active={sidebarView}
                    onSelect={(id) => {
                        if (id === 'ai') {
                            setChatVisible(v => !v);
                            return;
                        }
                        const nextView = id === sidebarView ? null : id;
                        setSidebarView(nextView);
                        if (!nextView) {
                            sidebarPanelRef.current?.collapse();
                        } else {
                            sidebarPanelRef.current?.expand();
                        }
                    }}
                    extensionContainers={contributedContainers}
                    badges={{ pullrequests: openPRCount, 'ai-healing': aiHealing.fixCount || 0 }}
                />
                <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
                    {sidebarView === 'scm' ? (
                        <GitStatus slug={slug} />
                    ) : sidebarView === 'pullrequests' ? (
                        <PullRequestsPanel slug={slug} />
                    ) : sidebarView === 'search' ? (
                        <SearchView slug={slug} onToggleOrientation={toggleTreeOrientation} />
                    ) : sidebarView === 'extensions' ? (
                        <ExtensionSidebar
                            extensions={installedExtensions}
                            errors={extensionErrors}
                            ready={extensionsReady}
                            hostStatus={extensionHostStatus}
                            vscodeServerState={vscodeServerState}
                            onInstall={installExtension}
                            onEnable={enableExtension}
                            onDisable={disableExtension}
                            onUninstall={uninstallExtension}
                            onRestart={restartExtension}
                            onDismissError={dismissExtensionError}
                            onExecuteCommand={executeExtensionCommand}
                        />
                    ) : sidebarView && sidebarView.startsWith('ext:') ? (() => {
                        const containerId = sidebarView.replace('ext:', '');
                        const container = contributedContainers.find(c => c.id === containerId);

                        return (
                            <ExtensionViewContainer
                                containerId={containerId}
                                container={container}
                                views={contributedViews[containerId] || []}
                                treeDataMap={extensionTreeDataMap}
                                webviewPanels={extensionWebviewPanels}
                                webviewManager={extensionWebviewManager}
                                extensions={installedExtensions}
                                onExecuteCommand={executeExtensionCommand}
                                onRequestTreeRefresh={requestTreeRefresh}
                                viewsWelcome={extensionViewsWelcome}
                            />
                        );
                    })() : sidebarView === 'settings' ? (
                        <SettingsPanelContent />
                    ) : sidebarView === 'ai-healing' ? (
                        <HealingSettingsPanel aiHealing={aiHealing} />
                    ) : sidebarView ? (
                        <div className="flex flex-col h-full min-h-0">
                            <div className="flex-1 min-h-0 overflow-y-auto">
                                <FileTreeView onToggleOrientation={toggleTreeOrientation} />
                            </div>
                            <div className="flex-shrink-0">
                                <GitSummaryPanel onOpenScm={() => setSidebarView('scm')} />
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
        </ResizablePanel>
    );

    const ChatPanel = (
        <ResizablePanel defaultSize={24} minSize={20} maxSize={45} className="border-l border-[#1a1a1e] bg-[#09090b] min-w-0">
            <AIChatWindow
                docked={true}
                isVisible={chatVisible}
                onClose={() => setChatVisible(false)}
                activeFile={activeFile}
                getCurrentCode={getLatestCurrentContent}
                editor={editor}
                onSuggest={(s) => setLatestCompletion(s)}
                onBusy={(b) => setAiBusy(Boolean(b))}
                clearSignal={completionClearSignal}
                initialPrompt={jumpstartPrompt}
                initialAttachments={jumpstartAttachments}
            />
        </ResizablePanel>
    );

    const onSuggestCb = useCallback((s) => setLatestCompletion(s), []);
    const onBusyCb = useCallback((b) => setAiBusy(Boolean(b)), []);
    const onCloseProblemsCb = useCallback(() => setShowProblemsPanel(false), []);
    const onOpenScmCb = useCallback(() => setSidebarView('scm'), []);
    const onToggleTerminalCb = useCallback(() => dispatch(toggleTerminal()), [dispatch]);
    const onProblemsClickCb = useCallback(() => setShowProblemsPanel(prev => !prev), []);

    // ── Floating emulator window (renders outside the panel layout)
    // This is now independent of the ResizablePanelGroup structure
    const FloatingEmulator = showEmulatorPreview ? (
        <FloatingEmulatorWindow
            key={emulatorRunNonce}
            defaultState={EMULATOR_STATES.BOOTING}
            sessionId={emulatorSessionId}
            mediaStream={mediaStream}
            forcedErrorMessage={emulatorForcedError}
            onClose={() => {
                // Cancel the running mobile job on the worker
                if (emulatorSessionId) {
                    cancelMobileJob(emulatorSessionId);
                    // Only hard-reset when an emulator was actually running;
                    // this clears GStreamer/runner state on the worker.
                    if (client?.reconnect) {
                        client.reconnect();
                    }
                } else if (client?.softReconnect) {
                    // No emulator session — soft reconnect preserves
                    // vscode-server-manager and LSP processes.
                    client.softReconnect();
                }
                dispatch(setEmulatorPreviewVisible(false));
                setEmulatorSessionId(null);
                setEmulatorForcedError('');
            }}
        />
    ) : null;

    // ── Memoised editorProps (nested object in panelProps) ─────────────────────
    const memoEditorProps = useMemo(() => ({
        innerRef: setEditor,
        slug,
        showTerminal,
        analyzeCode,
        analyzeUnified,
        lastResult,
        isAnalyzing: isAnalyzingGateway,
        connectionMeta,
        latestCompletion,
        completionClearSignal,
        onRun: handleRun,
        onSave: handleSave,
        onToggleTerminal: onToggleTerminalCb,
        onEditorMount: handleEditorMount,
        analysisResult: lastResult,
        diagnostics: mergedDiagnostics,
        onAiDiagnosticsRecalibrated: handleAiDiagnosticsRecalibrated,
        removeDiagnosticByLocation,
        aiBusy,
        onClearCompletion: handleClearLatestCompletion,
        chatVisible,
        collabHostId,
    }), [
        slug, showTerminal, analyzeCode, analyzeUnified, lastResult,
        isAnalyzingGateway, connectionMeta, latestCompletion, completionClearSignal,
        handleRun, handleSave, onToggleTerminalCb, handleEditorMount,
        mergedDiagnostics, handleAiDiagnosticsRecalibrated, removeDiagnosticByLocation,
        aiBusy, handleClearLatestCompletion, chatVisible, collabHostId,
    ]);

    // ── Memoised panelProps (the mega-object passed to DockableWorkspace) ──────
    const memoPanelProps = useMemo(() => ({
        editor,
        activeFile,
        diagnostics: mergedDiagnostics,
        diagnosticSummary,
        isAnalyzing: showAnalyzingSpinner || isWorkspaceAnalyzing,
        onSuggest: onSuggestCb,
        onBusy: onBusyCb,
        getCurrentCode: getLatestCurrentContent,
        clearSignal: completionClearSignal,
        initialPrompt: jumpstartPrompt,
        initialAttachments: jumpstartAttachments,
        onCloseProblems: onCloseProblemsCb,
        onToggleOrientation: toggleTreeOrientation,
        onOpenScm: onOpenScmCb,
        editorProps: memoEditorProps,
        // AI healing surface so docked panels (HealingSettingsPanel) can consume it
        aiHealing,
    }), [
        editor, activeFile, mergedDiagnostics, diagnosticSummary,
        showAnalyzingSpinner, isWorkspaceAnalyzing, onSuggestCb, onBusyCb,
        getLatestCurrentContent, completionClearSignal, jumpstartPrompt, jumpstartAttachments,
        onCloseProblemsCb, toggleTreeOrientation, onOpenScmCb, memoEditorProps,
        aiHealing,
    ]);

    if (workspaceMissing) {
        return <WorkspaceNotFoundModal slug={slug} message={workspaceMissingMessage} open={true} />;
    }

    // While auth is loading or redirect is pending, show nothing
    if (authStatus !== 'authenticated') {
        return null;
    }

    return (
        <DockablePanelProvider workspaceId={slug}>
            <div className="flex flex-col h-screen overflow-hidden" style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}>
                <div className="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ background: 'var(--bg-editor)', color: 'var(--text-primary)' }}>
                    {/* Hydrate workspace-specific tabs from localStorage */}
                    <WorkspaceHydrator slug={slug} />

                    <TopNav
                        title={activeFile ? activeFile.name : 'Synthi Workspace'}
                        onRun={handleRun}
                        runInGuiMode={runInGuiMode}
                        setRunInGuiMode={setRunInGuiMode}
                        hmrEnabled={hmrEnabled}
                        setHmrEnabled={setHmrEnabled}
                        onStop={handleStop}
                        onReload={handleRestart}
                        isRunning={isCompiling}
                        onToggleTerminal={onToggleTerminalCb}
                        onUndo={handleUndo}
                        onRedo={handleRedo}
                        onToggleChat={handleToggleChat}
                        chatVisible={chatVisible}
                        onCopyLineUp={handleCopyLineUp}
                        onCopyLineDown={handleCopyLineDown}
                        onMoveLineUp={handleMoveLineUp}
                        onMoveLineDown={handleMoveLineDown}
                        onDuplicateSelection={handleDuplicateSelection}
                    />

                    {/* Collaboration: guest banner when viewing another user's session */}
                    <GuestBanner />

                    {buildLogs.length > 0 && (
                        <div className="border-b border-[#1a1a1e] bg-[#09090b] px-3 py-2 text-xs font-mono text-[#D7DAE0] max-h-28 overflow-auto">
                            {buildLogs.map((line, idx) => (
                                <div key={idx} className="leading-5 whitespace-pre-wrap">
                                    {line}
                                </div>
                            ))}
                        </div>
                    )}

                    <DraggableVideoWidget
                        guiConfig={guiConfig}
                        setGuiConfig={setGuiConfig}
                        isGuiRunning={isGuiRunning}
                        setIsGuiRunning={setIsGuiRunning}
                        isHmrRecompiling={isHmrRecompiling}
                        mediaStream={mediaStream}
                        sendGuiEvent={sendGuiEvent}
                    />

                    {/* ─── Layout: outer vertical group (shared) → main content + bottom problems dock ─── */}
                    <ResizablePanelGroup direction="vertical" className="flex-1 min-h-0">
                        <ResizablePanel minSize={20} defaultSize={75}>
                            {USE_DOCKING_WM ? (
                                <DockableWorkspace
                                    workspaceSlug={slug}
                                    defaultPreset="classic"
                                    panelProps={memoPanelProps}
                                />
                            ) : (
                                <ResizablePanelGroup
                                    direction="horizontal"
                                    className="h-full w-full"
                                    key={panelGroupKey}
                                >
                                    {treeOnRight ? (
                                        <>
                                            {EditorPanelComponent}

                                            <ResizableHandle className="!pointer-events-auto bg-[#1a1a1e] hover:bg-[#327464] w-px z-50" />

                                            {FileTreePanel}

                                            {chatVisible && (
                                                <>
                                                    <ResizableHandle className="!pointer-events-auto bg-[#1a1a1e] hover:bg-[#327464] w-px z-50" />
                                                    {ChatPanel}
                                                </>
                                            )}
                                        </>
                                    ) : (
                                        <>
                                            {FileTreePanel}

                                            <ResizableHandle className="!pointer-events-auto bg-[#1a1a1e] hover:bg-[#327464] w-px z-50" />

                                            {EditorPanelComponent}

                                            {chatVisible && (
                                                <>
                                                    <ResizableHandle className="!pointer-events-auto bg-[#1a1a1e] hover:bg-[#327464] w-px z-50" />
                                                    {ChatPanel}
                                                </>
                                            )}
                                        </>
                                    )}
                                </ResizablePanelGroup>
                            )}
                        </ResizablePanel>

                        {/* Problems dock slot — always present, expanded/collapsed imperatively for smooth animation */}
                        <ResizableHandle
                            className={cn(
                                "!pointer-events-auto h-px z-50 transition-all duration-300",
                                showProblemsPanel && isProblemsPanelDocked
                                    ? "bg-[#1a1a1e] hover:bg-[#3A7AFE]"
                                    : "opacity-0 pointer-events-none"
                            )}
                        />
                        <ResizablePanel
                            ref={problemsPanelRef}
                            defaultSize={0}
                            minSize={10}
                            collapsible={true}
                            collapsedSize={0}
                            className="overflow-hidden"
                            style={{
                                transition: 'flex 350ms cubic-bezier(0.4, 0, 0.2, 1)',
                                willChange: 'flex-grow',
                            }}
                        >
                            <div
                                className={cn(
                                    "h-full overflow-hidden border-t",
                                    showProblemsPanel && isProblemsPanelDocked
                                        ? "opacity-100 transition-opacity duration-200 delay-100"
                                        : "opacity-0 transition-opacity duration-150"
                                )}
                                style={{ borderColor: 'var(--border-medium, #1a1a1e)' }}
                                id="problems-panel-dock-slot"
                            />
                        </ResizablePanel>
                    </ResizablePanelGroup>

                </div>

                {/* Single Problems Panel instance - renders to dock slot or as floating */}
                {showProblemsPanel && (
                    <DockablePanel
                        id="problems-panel"
                        title="Problems"
                        icon={AlertCircle}
                        defaultState={PANEL_STATE.DOCKED}
                        openMode="docked"
                        defaultPosition={DOCK_POSITION.BOTTOM}
                        defaultFloatingPosition={{ x: 200, y: 200 }}
                        defaultFloatingSize={{ width: 600, height: 400 }}
                        isOpen={showProblemsPanel}
                        onOpenChange={setShowProblemsPanel}
                        onDockedChange={setIsProblemsPanelDocked}
                        workspaceId={slug}
                        dockSlotId="problems-panel-dock-slot"
                        className="h-full rounded-none border-0"
                    >
                        <ProblemsPanel
                            diagnostics={mergedDiagnostics}
                            summary={diagnosticSummary}
                            isAnalyzing={showAnalyzingSpinner || isWorkspaceAnalyzing}
                            filePath={activeFile?.path || activeFile?.name || 'Current File'}
                            onClose={() => setShowProblemsPanel(false)}
                            onNavigate={(location) => {
                                const targetFile = location.filePath;
                                const currentFile = activeFile?.path || activeFile?.name;

                                if (targetFile && targetFile !== currentFile) {
                                    const findFile = (files, path) => {
                                        for (const file of files || []) {
                                            if (file.isFolder && file.children) {
                                                const found = findFile(file.children, path);
                                                if (found) return found;
                                            } else if (file.path === path || file.name === path) {
                                                return file;
                                            }
                                        }
                                        return null;
                                    };

                                    const fileToSelect = findFile(rawFiles, targetFile);
                                    if (fileToSelect) {
                                        dispatch(selectFileThunk(fileToSelect));
                                        setTimeout(() => {
                                            if (editor) {
                                                const position = {
                                                    lineNumber: (location.line ?? 0) + 1,
                                                    column: (location.column ?? 0) + 1,
                                                };
                                                editor.setPosition(position);
                                                editor.revealPositionInCenter(position);
                                                editor.focus();
                                            }
                                        }, 100);
                                    }
                                } else if (editor) {
                                    const position = {
                                        lineNumber: (location.line ?? 0) + 1,
                                        column: (location.column ?? 0) + 1,
                                    };
                                    editor.setPosition(position);
                                    editor.revealPositionInCenter(position);
                                    editor.focus();
                                }
                            }}
                            className="h-full rounded-none border-0"
                        />
                    </DockablePanel>
                )}

                {/* Self-Healing Toast Bridge */}
                <HealingToast onUndo={undoLastFix} />
                {/* Pre-Compile Heal Toast */}
                <PreCompileHealToast />

                {/* Status Bar */}
                <StatusBar
                    slug={slug}
                    diagnosticSummary={diagnosticSummary}
                    isAnalyzing={showAnalyzingSpinner || isWorkspaceAnalyzing}
                    onProblemsClick={onProblemsClickCb}
                    extensionStatusBarItems={extensionStatusBarItems}
                    vscodeServerState={vscodeServerState}
                />

                {/* Error Overlay */}
                <ErrorOverlay />

                {/* HMR Status + Runtime Healing indicators */}
                <HMRStatusIndicator pipelineState={hmrState} />
                <RuntimeHealingIndicator healingState={healingState} />

                {/* Floating Emulator Window - rendered outside panel layout */}
                {FloatingEmulator}
            </div>
        </DockablePanelProvider>
    );
}
