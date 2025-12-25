'use client';
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { use } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { fetchFilesThunk, selectActiveFile, setSlug, selectFileThunk, selectCurrentContent, selectFileCacheEntries } from '@/redux/workspaceSlice';
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
    // Track editor content version to force re-analysis on every change (including remote/undo)
    const [editorVersion, setEditorVersion] = useState(0);
    const { analyzeCode, analyzeProactive, analyzeContainer, analyzeUnified, lastResult, isAnalyzing: isAnalyzingGateway } = useAnalyzerGateway();
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
                return {
                    ...d,
                    location: {
                        ...(d.location || {}),
                        ...nextLoc,
                    },
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

                        // Trigger full workspace analysis on initialization
                        const { files } = result.payload;
                        if (files && files.length > 0) {
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

    // 2. Consume global state directly via selectors
    const activeFile = useAppSelector(selectActiveFile);
    const showTerminal = useAppSelector(selectShowTerminal);
    const showEmulatorPreview = useAppSelector(selectShowEmulatorPreview);
    const treeOnRight = useAppSelector(selectTreeOnRight);
    const currentContent = useAppSelector(selectCurrentContent);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    // Redux file content cache - contains edited content of open files
    const fileCacheEntries = useAppSelector(selectFileCacheEntries);

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
        const reduxCacheMap = new Map(fileCacheEntries);
        
        const getContentForDep = async (path) => {
            // If it's the active file, use the current editor content
            if (path === activeFile.path) {
                return typeof currentContent === 'string' ? currentContent : '';
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
    }, [activeFile, rawFiles, currentContent, slug, fileCacheEntries]);

    // Subscribe to editor changes to force re-analysis even for remote changes or undo/redo
    useEffect(() => {
        if (!editor) return;

        const disposable = editor.onDidChangeModelContent(() => {
            setEditorVersion(v => v + 1);
        });

        // Important: Monaco/Yjs may apply an initial sync update immediately after the editor instance
        // is created, before we can attach onDidChangeModelContent. Force a short re-check to avoid
        // analyzing an old snapshot and pinning diagnostics to the wrong lines.
        setEditorVersion(v => v + 1);
        const recheckTimer = setTimeout(() => {
            setEditorVersion(v => v + 1);
        }, 250);

        return () => {
            disposable.dispose();
            clearTimeout(recheckTimer);
        };
    }, [editor]);

    useEffect(() => {
        if (!activeFile || !hasLoadedInitialFile || !slug) return;
        
        // Get content from Monaco if available, falling back to Redux
        // IMPORTANT: On initial load, Monaco might not have Y.js synced changes yet.
        // We use a small delay to allow Y.js to sync before running analysis.
        const getContentToAnalyze = () => {
            return editor ? editor.getValue() : (typeof currentContent === 'string' ? currentContent : '');
        };
        
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
            setDiagnostics(prev => prev.filter(d => {
                const diagPath = d?.filePath || d?.file || d?.path || '';
                if (!diagPath) return true;
                return normalizePath(diagPath) !== currentNorm;
            }));

            // Force a fresh analysis even if we previously analyzed the same hash.
            lastFastHashMapRef.current.delete(currentFilePath);
            lastAiHashMapRef.current.delete(currentFilePath);
            lastFastSignatureRef.current = '';
            lastAiSignatureRef.current = '';
        }
        
        // DEBUG: Log content hash and preview to trace stale content issues
        // console.log(`[page.jsx] Content changed - Hash: ${contentHash}, Length: ${contentToAnalyze.length}`);
        
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
                return prev.filter(d => {
                    const diagPath = d.filePath || d.file || '';
                    if (!diagPath) return false;
                    const isSameFile = normalizePath(diagPath) === currentNorm;
                    if (!isSameFile) return true;
                    const isAi = d.tier === 'ai' || (d.source && String(d.source).toLowerCase().includes('ai'));
                    return isAi;
                });
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
                    const currentEditorContent = editor ? editor.getValue() : (typeof currentContent === 'string' ? currentContent : '');
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

                            const currentEditorContent = editor ? editor.getValue() : (typeof currentContent === 'string' ? currentContent : '');
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

        return () => {
            if (proactiveTimeoutRef.current) {
                clearTimeout(proactiveTimeoutRef.current);
                proactiveTimeoutRef.current = null;
            }
            if (aiTimeoutRef.current) {
                clearTimeout(aiTimeoutRef.current);
                aiTimeoutRef.current = null;
            }
        };
    }, [currentContent, activeFile, hasLoadedInitialFile, slug, analyzeUnified, computeContentHash, editorVersion, editor]);

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
            onAiDiagnosticsRecalibrated={handleAiDiagnosticsRecalibrated}
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

            <ResizablePanelGroup direction="vertical" className="flex-1 min-h-0">
                <ResizablePanel defaultSize={showProblemsPanel ? 75 : 100} minSize={20}>
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
                </ResizablePanel>

                {showProblemsPanel && (
                    <>
                        <ResizableHandle className="!pointer-events-auto bg-[#1a1a1e] hover:bg-[#327464] h-px z-50" />
                        <ResizablePanel defaultSize={25} minSize={10}>
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
                        </ResizablePanel>
                    </>
                )}
            </ResizablePanelGroup>
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