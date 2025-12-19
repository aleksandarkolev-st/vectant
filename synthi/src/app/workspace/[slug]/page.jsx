'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { use } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { fetchFilesThunk, selectActiveFile, setSlug, selectFileThunk, selectCurrentContent } from '@/redux/workspaceSlice';
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
import { useWorkspaceAnalysis } from '@/hooks/useWorkspaceAnalysis';
import { useCompiler } from '@/hooks/useCompiler';
import AIChatWindow from '@/components/chat/AIChatWindow';
import { api } from '@/services/api';
import WorkspaceNotFoundModal from '@/components/WorkspaceNotFoundModal';
import { fileCache } from '@/services/fileCache';
import { resolveDependencies } from '@/utils/dependencyResolver';
import { DraggableVideoWidget } from '@/components/DraggableVideoWidget';
import { useHMR } from '@/hooks/useHMR';
import ErrorOverlay from '@/components/ErrorOverlay';
import { GitStatus } from '@/components/git/GitStatus';
import ActivityBar from '../ActivityBar.jsx';
import SearchView from './SearchView.jsx';
import EmulatorPanel from '@/components/emulator/EmulatorPanel';
import { EMULATOR_STATES } from '@/components/emulator/emulatorStates';
import StatusBar from '../StatusBar.jsx';
import WorkspaceHydrator from '@/components/WorkspaceHydrator';
import { ProblemsPanel } from '@/components/analysis';

export default function EditorPage({ params }) {
    const dispatch = useAppDispatch();
    
    // 1. Consume the slug parameter first (needed by hooks below)
    const { slug } = use(params);
    
    const [chatVisible, setChatVisible] = useState(false);
    const [sidebarView, setSidebarView] = useState('explorer');
    const [showProblemsPanel, setShowProblemsPanel] = useState(false);
    const [guiConfig, setGuiConfig] = useState(null);
    const [isGuiRunning, setIsGuiRunning] = useState(false);
    const [editor, setEditor] = useState(null);
    const { analyzeCode, analyzeProactive, lastResult, isAnalyzing: isAnalyzingGateway } = useAnalyzerGateway();
    const { compile, mediaStream } = useCompiler();
    useHMR();
    const [latestCompletion, setLatestCompletion] = useState(null);
    const [completionClearSignal, setCompletionClearSignal] = useState(0);
    const [buildLogs, setBuildLogs] = useState([]);
    const [useAiSplit, setUseAiSplit] = useState(false);
    const [emulatorRunNonce, setEmulatorRunNonce] = useState(0);
    const analysisTimeoutRef = useRef(null);
    const lastAnalyzedSignatureRef = useRef('');
    
    // Proactive analysis state - keyed by file path
    const [diagnostics, setDiagnostics] = useState([]);
    const [isAnalyzingProactive, setIsAnalyzingProactive] = useState(false);
    const proactiveTimeoutRef = useRef(null);
    const lastProactiveSignatureRef = useRef('');
    const currentAnalysisFileRef = useRef(null); // Track which file diagnostics belong to
    const aiAnalysisRef = useRef(null);
    const lastContentHashRef = useRef('');
    
    // Multi-file workspace analysis (cross-file issue detection)
    const {
        trackFileChange,
        trackFileDeletion,
        setFocusFile: setWorkspaceFocusFile,
        triggerAnalysis: triggerWorkspaceAnalysis,
        allDiagnostics: workspaceDiagnostics,
        summary: workspaceSummary,
        isAnalyzing: isWorkspaceAnalyzing,
        clientReady: workspaceClientReady,
    } = useWorkspaceAnalysis({
        workspaceId: slug || '',
        debounceMs: 1200,  // Slightly longer debounce for workspace-level analysis
        includeAi: false,  // Disabled by default, can be enabled via settings
    });

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
                        } else {
                            // Non-404 errors: log and do not display the not-found modal
                            console.error('Failed to fetch workspace files:', message);
                        }
                    } else {
                        // Successful
                        setWorkspaceMissing(false);
                        setWorkspaceMissingMessage('');
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

    // 2. Consume global state directly via selectors
    const activeFile = useAppSelector(selectActiveFile);
    const showTerminal = useAppSelector(selectShowTerminal);
    const showEmulatorPreview = useAppSelector(selectShowEmulatorPreview);
    const treeOnRight = useAppSelector(selectTreeOnRight);
    const currentContent = useAppSelector(selectCurrentContent);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    // File contents are cached via an in-memory LRU cache service (not Redux)

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
        
        // Also invalidate the signature so next analysis runs fresh
        lastProactiveSignatureRef.current = '';
    }, [activeFile]);

    const [initialContent, setInitialContent] = useState('');
    const [hasInitialSnapshot, setHasInitialSnapshot] = useState(false);


    // Track if we've loaded the initial file content
    const [hasLoadedInitialFile, setHasLoadedInitialFile] = useState(false);

    // 3. Load content for the initially selected file
    useEffect(() => {
        if (activeFile && !hasLoadedInitialFile) {
            dispatch(selectFileThunk(activeFile));
            setHasLoadedInitialFile(true);
        }
    }, [activeFile, hasLoadedInitialFile, dispatch]);

    // 4. Track file changes for analysis - don't clear diagnostics from other files
    useEffect(() => {
        const currentFilePath = activeFile?.path || activeFile?.name;
        const previousFilePath = currentAnalysisFileRef.current;
        
        // If we're switching files, reset analysis state but keep diagnostics from other files
        if (currentFilePath && previousFilePath && currentFilePath !== previousFilePath) {
            // Reset analysis signature so new file gets analyzed
            lastProactiveSignatureRef.current = '';
            lastContentHashRef.current = '';
            // Cancel any pending analysis for the old file
            if (proactiveTimeoutRef.current) {
                clearTimeout(proactiveTimeoutRef.current);
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
    const toggleTreeOrientation = () => {
        dispatch(setTreeOrientation());
        setPanelGroupKey(prev => prev + 1); // Force remount
    };

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
    // Simple but effective hash function for content comparison
    const computeContentHash = useCallback((content) => {
        if (!content) return '';
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString(16);
    }, []);

    // Get related files for cross-file analysis (includes, imports)
    const getRelatedFilesForAnalysis = useCallback(async () => {
        if (!activeFile || !rawFiles) return [];
        
        const getContentForDep = async (path) => {
            // If it's the active file, use the current editor content
            if (path === activeFile.path) {
                return typeof currentContent === 'string' ? currentContent : '';
            }
            // Check cache
            const cached = fileCache.get(path);
            if (cached !== undefined) return cached;
            // Fetch
            try {
                return await api.fetchFileContent(slug, path);
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
    }, [activeFile, rawFiles, currentContent, slug]);

    useEffect(() => {
        if (!activeFile || !currentContent || !hasLoadedInitialFile) return;

        if (proactiveTimeoutRef.current) {
            clearTimeout(proactiveTimeoutRef.current);
        }

        // Cancel any pending AI analysis when content changes
        if (aiAnalysisRef.current) {
            aiAnalysisRef.current.cancelled = true;
        }

        // Capture the content we're analyzing (for freshness checks)
        const contentToAnalyze = typeof currentContent === 'string' ? currentContent : '';
        const contentHash = computeContentHash(contentToAnalyze);
        
        // When content changes, IMMEDIATELY clear all diagnostics for this file
        // New analysis will provide fresh diagnostics
        const currentFilePath = activeFile?.path || activeFile?.name || 'untitled';
        if (lastContentHashRef.current && lastContentHashRef.current !== contentHash) {
            // Clear diagnostics for this file - fresh analysis will repopulate
            setDiagnostics(prev => prev.filter(d => d.filePath !== currentFilePath));
        }
        lastContentHashRef.current = contentHash;

        // Debounce proactive analysis to avoid overwhelming the backend
        proactiveTimeoutRef.current = setTimeout(async () => {
            const langSource =
                activeFile.language ||
                (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
                'plaintext';
            const normalizedLang = langSource.toLowerCase();
            const signature = `proactive::${activeFile?.path || activeFile?.name || ''}::${contentToAnalyze}`;

            if (lastProactiveSignatureRef.current === signature) {
                return;
            }

            setIsAnalyzingProactive(true);
            
            // Get related files for cross-file analysis (includes, imports)
            let relatedFiles = [];
            try {
                relatedFiles = await getRelatedFilesForAnalysis();
            } catch (e) {
                console.warn('Failed to get related files for analysis:', e);
            }
            
            // STEP 1: Run fast static+semantic analysis first for immediate feedback
            analyzeProactive({
                code: contentToAnalyze,
                lang: normalizedLang,
                filePath: activeFile?.path || activeFile?.name || 'untitled',
                includeAi: false, // Fast tier first
                relatedFiles, // Pass related files for cross-file include resolution
            })
                .then((fastResult) => {
                    const fastDiags = fastResult?.diagnostics || fastResult?.data?.diagnostics || [];
                    const currentFilePath = activeFile?.path || activeFile?.name || 'untitled';
                    // Add filePath to each diagnostic for proper grouping in ProblemsPanel
                    const diagsWithPath = fastDiags.map(d => ({ ...d, filePath: d.filePath || currentFilePath }));
                    // Replace diagnostics for this file only, keep diagnostics from other files
                    setDiagnostics(prev => {
                        const otherFileDiags = prev.filter(d => d.filePath !== currentFilePath);
                        return [...otherFileDiags, ...diagsWithPath];
                    });
                    lastProactiveSignatureRef.current = signature;
                    setIsAnalyzingProactive(false);
                    
                    // STEP 2: Run AI analysis in background for logic error detection
                    // Track the exact content that was analyzed for freshness verification
                    const aiTracker = { 
                        cancelled: false, 
                        contentHash,
                        analyzedContent: contentToAnalyze  // Store actual content for verification
                    };
                    aiAnalysisRef.current = aiTracker;
                    
                    analyzeProactive({
                        code: contentToAnalyze,
                        lang: normalizedLang,
                        filePath: currentFilePath,
                        includeAi: true, // AI tier for logic errors
                        relatedFiles, // Pass related files for cross-file analysis
                    })
                        .then((aiResult) => {
                            // Only update if:
                            // 1. Not cancelled
                            // 2. This is still the current tracker
                            // 3. The content hash hasn't changed since we started
                            const currentHash = lastContentHashRef.current;
                            const isStillCurrent = !aiTracker.cancelled && 
                                                   aiAnalysisRef.current === aiTracker &&
                                                   currentHash === contentHash;
                            if (isStillCurrent) {
                                const aiDiags = aiResult?.diagnostics || aiResult?.data?.diagnostics || [];
                                // Add filePath to each diagnostic
                                const aiDiagsWithPath = aiDiags.map(d => ({ ...d, filePath: d.filePath || currentFilePath }));
                                // Replace diagnostics for this file only
                                setDiagnostics(prev => {
                                    const otherFileDiags = prev.filter(d => d.filePath !== currentFilePath);
                                    return [...otherFileDiags, ...aiDiagsWithPath];
                                });
                            }
                        })
                        .catch((err) => {
                            if (!aiTracker.cancelled) {
                                console.error('AI analysis failed:', err);
                            }
                        });
                })
                .catch((err) => {
                    console.error('Proactive analysis failed', err);
                    setIsAnalyzingProactive(false);
                });
        }, 300); // Fast 300ms debounce for near-realtime feedback

        return () => {
            if (proactiveTimeoutRef.current) {
                clearTimeout(proactiveTimeoutRef.current);
            }
        };
    }, [currentContent, activeFile, hasLoadedInitialFile, analyzeProactive, getRelatedFilesForAnalysis, computeContentHash]);

    // Track focused file and content changes for workspace analysis
    useEffect(() => {
        if (!activeFile || !hasLoadedInitialFile) return;
        
        const filePath = activeFile?.path || activeFile?.name;
        if (filePath) {
            setWorkspaceFocusFile(filePath);
        }
    }, [activeFile, hasLoadedInitialFile, setWorkspaceFocusFile]);
    
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

    // Merge single-file diagnostics with workspace-level cross-file diagnostics
    const mergedDiagnostics = useMemo(() => {
        // Start with single-file diagnostics (these are more immediate/responsive)
        const merged = [...diagnostics];
        
        // Add cross-file diagnostics from workspace analysis
        // Filter to avoid duplicates by comparing message + location
        const existingKeys = new Set(
            diagnostics.map(d => `${d.message}::${d.location?.line}::${d.location?.column}`)
        );
        
        for (const d of workspaceDiagnostics) {
            const key = `${d.message}::${d.location?.line}::${d.location?.column}`;
            if (!existingKeys.has(key)) {
                merged.push(d);
                existingKeys.add(key);
            }
        }
        
        return merged;
    }, [diagnostics, workspaceDiagnostics]);

    // Compute diagnostic summary from merged diagnostics
    const diagnosticSummary = useMemo(() => {
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

    // NOTE: Completion requests are handled centrally by the Editor component
    // to avoid duplicate requests, races, and abort-related errors. If you need
    // a page-level completion flow (for example, for collaborative features),
    // reintroduce a single centralized caller with an AbortController and proper
    // dedupe. Leaving this commented-out avoids the 'Canceled' errors caused by
    // concurrent requests from both page and editor.

    const appendBuildLog = useCallback((line) => {
        setBuildLogs((prev) => [...prev, line].slice(-200));
    }, []);

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

    const handleRun = useCallback(async () => {
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

        const source = typeof currentContent === 'string' ? currentContent : '';
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

        // Define a getter for content that checks current editor state, cache, or API
        const getContentForDependency = async (path) => {
            // If it's the active file, use the current editor content (which might be unsaved)
            if (path === activeFile.path) {
                return typeof currentContent === 'string' ? currentContent : '';
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
        const target = isReactNative ? 'react-native-emulator' : null;

        // Auto-open the UI-only emulator panel when we run a mobile build.
        // This is intentionally NOT a real emulator: it only shows the preview panel.
        if (isReactNative) {
            dispatch(setEmulatorPreviewVisible(true));
            setEmulatorRunNonce((v) => v + 1); // remount to simulate a fresh boot
        }
        
        // Derive project root from active file's directory path
        // e.g., "mobile/app.tsx" -> "mobile", "src/screens/Home.tsx" -> "src/screens"
        let projectRoot = null;
        if (isReactNative && filename) {
            const fileParts = filename.replace(/\\/g, '/').split('/');
            // Remove the filename to get directory
            fileParts.pop();
            projectRoot = fileParts.join('/') || '/';
            appendBuildLog(`Detected React Native project at: ${projectRoot}`);
        }

        try {
            await compile({
                filename,
                source,
                files: additionalFiles,
                useAiSplit,
                target,
                projectRoot,
                slug, // Pass workspace slug for mobile builds to download synced files
                onLog: (line) => {
                    appendBuildLog(line);
                    console.log('[build]', line);
                },
            });
            appendBuildLog('Build succeeded.');
        } catch (err) {
            console.error('Compile failed', err);
            appendBuildLog(`error: ${err?.message || err}`);
        }
    }, [activeFile, currentContent, appendBuildLog, dispatch, showTerminal, rawFiles, slug, compile, detectReactNativeProject, detectReactNativeInSource, useAiSplit]);

    const handleSave = useCallback(async () => {
        if (!activeFile) return;

        // Dispatch optimistic "compiling" status immediately for fast feedback
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('synthi:hmr-status', {
                detail: { status: 'compiling', module: activeFile?.name || 'unknown' }
            }));
        }

        // Similar to handleRun but silent and doesn't force terminal open
        const source = typeof currentContent === 'string' ? currentContent : '';
        const filename = activeFile?.path || activeFile?.name || 'main';

        // Check if language is supported for compilation to avoid errors
        const ext = (filename.split('.').pop() || '').toLowerCase();
        const supportedExts = ['cpp', 'cc', 'cxx', 'hpp', 'h', 'rs', 'ts', 'tsx'];
        if (!supportedExts.includes(ext)) {
            console.log(`[HMR] Skipping silent compilation for unsupported extension: .${ext}`);
            return;
        }

        const getContentForDependency = async (path) => {
            if (path === activeFile.path) return typeof currentContent === 'string' ? currentContent : '';
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
            console.log('[HMR] Triggering silent compile for save...');
            await compile({
                filename,
                source,
                files: additionalFiles,
                // We don't attach onLog here to avoid spamming the build log on every save
                // unless we want to see HMR logs.
            });
        } catch (err) {
            console.error('[HMR] Silent compile failed', err);
        }
    }, [activeFile, currentContent, rawFiles, slug, compile]);

    const handleEditorMount = (editorInstance) => {
        setEditor(editorInstance);
        // Wait until file is loaded, then capture snapshot
        if (activeFile && !hasInitialSnapshot) {
            const currentValue = editorInstance.getValue();
            setInitialContent(currentValue);
            setHasInitialSnapshot(true);
        }
    };

    const handleToggleChat = useCallback(() => {
        setChatVisible((v) => !v);
    }, []);

    const handleUndo = () => {
        if (editor) {
            const currentValue = editor.getValue();
            // Prevent undo if no change since initial load
            if (currentValue !== initialContent) {
                editor.trigger('keyboard', 'undo', null);
            }
        }
    };

    const handleRedo = () => {
        if (editor) {
            editor.trigger('keyboard', 'redo', null);
        }
    };

    const handleCopyLineUp = () => editor?.getAction('editor.action.copyLinesUpAction')?.run();
    const handleCopyLineDown = () => editor?.getAction('editor.action.copyLinesDownAction')?.run();
    const handleMoveLineUp = () => editor?.getAction('editor.action.moveLinesUpAction')?.run();
    const handleMoveLineDown = () => editor?.getAction('editor.action.moveLinesDownAction')?.run();
    const handleDuplicateSelection = () => editor?.getAction('editor.action.duplicateSelection')?.run();

    const EditorPanelComponent = (
        <EditorPanel
            onRun={handleRun}
            onSave={handleSave}
            onToggleTerminal={() => dispatch(toggleTerminal())}
            onEditorMount={handleEditorMount}
            analysisResult={lastResult}
            diagnostics={mergedDiagnostics}
            removeDiagnosticByLocation={removeDiagnosticByLocation}
            latestCompletion={latestCompletion}
            aiBusy={aiBusy}
            onClearCompletion={handleClearLatestCompletion}
            chatVisible={chatVisible}
        />
    );

    const FileTreePanel = (
        <ResizablePanel defaultSize={20} minSize={12} maxSize={35} className={`${treeOnRight ? 'border-l' : 'border-r'} border-[#27272a] bg-[#09090b]`}>
            <div className="flex h-full min-w-0">
                <ActivityBar
                    active={sidebarView}
                    onSelect={(id) => setSidebarView(id === 'search' ? 'search' : 'explorer')}
                />
                <div className="flex-1 min-w-0">
                    <ResizablePanelGroup direction="vertical">
                        <ResizablePanel defaultSize={65} minSize={20}>
                            {sidebarView === 'search' ? (
                                <SearchView slug={slug} onToggleOrientation={toggleTreeOrientation} />
                            ) : (
                                <FileTreeView onToggleOrientation={toggleTreeOrientation} />
                            )}
                        </ResizablePanel>
                        <ResizableHandle />
                        <ResizablePanel defaultSize={7} minSize={7}>
                            <GitStatus slug={slug} />
                        </ResizablePanel>
                    </ResizablePanelGroup>
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
                currentCode={currentContent}
                editor={editor}
                onSuggest={(s) => setLatestCompletion(s)}
                onBusy={(b) => setAiBusy(Boolean(b))}
                clearSignal={completionClearSignal}
            />
        </ResizablePanel>
    );

    // UI-only dockable panel (hidden by default). Opening will be hooked up later
    // via command palette / toolbar (stub only per requirements).
    const EmulatorPreviewPanel = (
        <ResizablePanel defaultSize={24} minSize={18} maxSize={55} className="border-l border-[#545454] bg-[#0c0c0e] min-w-0">
            <EmulatorPanel
                key={emulatorRunNonce}
                defaultState={EMULATOR_STATES.BOOTING}
                onClose={() => dispatch(setEmulatorPreviewVisible(false))}
            />
        </ResizablePanel>
    );

    if (workspaceMissing) {
        return <WorkspaceNotFoundModal slug={slug} message={workspaceMissingMessage} open={true} />;
    }

    return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#09090b] text-[#D7DAE0]">
        <div className="flex flex-col flex-1 bg-[#1e1e1e] text-gray-200">
            {/* Hydrate workspace-specific tabs from localStorage */}
            <WorkspaceHydrator slug={slug} />

            <TopNav
                title={activeFile ? activeFile.name : 'Synthi Workspace'}
                onRun={handleRun}
                onToggleTerminal={() => dispatch(toggleTerminal())}
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
                mediaStream={mediaStream}
                sendGuiEvent={sendGuiEvent}
            />

            <ResizablePanelGroup
                direction="horizontal"
                className="flex-1 min-h-0"
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

                        {showEmulatorPreview && (
                            <>
                                <ResizableHandle className="!pointer-events-auto bg-[#1a1a1e] hover:bg-[#327464] w-px z-50" />
                                {EmulatorPreviewPanel}
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

                        {showEmulatorPreview && (
                            <>
                                <ResizableHandle className="!pointer-events-auto bg-[#1a1a1e] hover:bg-[#327464] w-px z-50" />
                                {EmulatorPreviewPanel}
                            </>
                        )}
                    </>
                )}
            </ResizablePanelGroup>

            {/* Problems Panel */}
            {showProblemsPanel && (
                <div className="h-48 max-h-48 flex-shrink-0 border-t border-[#1a1b24]">
                    <ProblemsPanel
                        diagnostics={mergedDiagnostics}
                        summary={diagnosticSummary}
                        isAnalyzing={isAnalyzingProactive || isWorkspaceAnalyzing}
                        filePath={activeFile?.path || activeFile?.name || 'Current File'}
                        onClose={() => setShowProblemsPanel(false)}
                        onNavigate={(location) => {
                            const targetFile = location.filePath;
                            const currentFile = activeFile?.path || activeFile?.name;
                            
                            // If navigating to a different file, select it first
                            if (targetFile && targetFile !== currentFile) {
                                // Find the file in rawFiles and select it
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
                                    // Wait a bit for file to load, then navigate
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
                                // Same file, just navigate
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
                </div>
            )}
        </div>

        {/* Status Bar */}
        <StatusBar
            slug={slug}
            diagnosticSummary={diagnosticSummary}
            isAnalyzing={isAnalyzingProactive || isWorkspaceAnalyzing}
            onProblemsClick={() => setShowProblemsPanel(prev => !prev)}
        />

        {/* Error Overlay */}
        <ErrorOverlay />
    </div>
);
}