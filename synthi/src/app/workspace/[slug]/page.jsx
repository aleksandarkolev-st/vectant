'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { use } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { fetchFilesThunk, selectActiveFile, setSlug, selectFileThunk, selectCurrentContent } from '@/redux/workspaceSlice';
import { 
    selectShowTerminal, 
    selectTreeOnRight, 
    toggleTerminal, 
    setTreeOrientation 
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
        <ResizablePanel defaultSize={76} minSize={20} className="min-w-0 bg-[#202020]">
            <div className="h-full w-full bg-[#202020]" />
        </ResizablePanel>
    ),
});

import { getFileLanguage } from '@/utils/fileUtils';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
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

export default function EditorPage({ params }) {
    const dispatch = useAppDispatch();
    const [chatVisible, setChatVisible] = useState(false);
    const [sidebarView, setSidebarView] = useState('explorer');
    const [guiConfig, setGuiConfig] = useState(null);
    const [isGuiRunning, setIsGuiRunning] = useState(false);
    const [editor, setEditor] = useState(null);
    const { analyzeCode, lastResult } = useAnalyzerGateway();
    const { compile, mediaStream } = useCompiler();
    useHMR();
    const [latestCompletion, setLatestCompletion] = useState(null);
    const [completionClearSignal, setCompletionClearSignal] = useState(0);
    const [buildLogs, setBuildLogs] = useState([]);
    const [useAiSplit, setUseAiSplit] = useState(false);
    const analysisTimeoutRef = useRef(null);
    const lastAnalyzedSignatureRef = useRef('');

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
    
    // 1. Consume the slug parameter and initiate fetch
    const { slug } = use(params);
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
    const treeOnRight = useAppSelector(selectTreeOnRight);
    const currentContent = useAppSelector(selectCurrentContent);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    // File contents are cached via an in-memory LRU cache service (not Redux)

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
    
    // Local state for layout management (used to force remount of ResizablePanelGroup)
    const [panelGroupKey, setPanelGroupKey] = useState(0);

    // Toggling the tree orientation updates the local key and dispatches global change
    const toggleTreeOrientation = () => {
        dispatch(setTreeOrientation());
        setPanelGroupKey(prev => prev + 1); // Force remount
    };

    // Run static analysis whenever current file content changes
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
            latestCompletion={latestCompletion}
            aiBusy={aiBusy}
            onClearCompletion={handleClearLatestCompletion}
            chatVisible={chatVisible}
        />
    );

    const FileTreePanel = (
        <ResizablePanel defaultSize={15} minSize={12} maxSize={35} className={`${treeOnRight? 'border-l' : 'border-r'} border-[#545454] bg-[#1e1e1e]`}>
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
                        <ResizableHandle withHandle />
                        <ResizablePanel defaultSize={35} minSize={10}>
                            <GitStatus slug={slug} />
                        </ResizablePanel>
                    </ResizablePanelGroup>
                </div>
            </div>
        </ResizablePanel>
    );

    const ChatPanel = (
        <ResizablePanel defaultSize={24} minSize={20} maxSize={45} className="border-l border-[#545454] bg-[#171717] min-w-0">
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

    if (workspaceMissing) {
        return <WorkspaceNotFoundModal slug={slug} message={workspaceMissingMessage} open={true} />;
    }

    return (
        <div className={`flex flex-col h-screen bg-[#1e1e1e] text-gray-200`}>
            <TopNav
                title={activeFile? activeFile.name : 'Synthi Workspace'}
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
                <div className="border-b border-[#2b2b2b] bg-[#121212] px-3 py-2 text-xs font-mono text-gray-200 max-h-28 overflow-auto">
                    {buildLogs.map((line, idx) => (
                        <div key={idx} className="leading-5 whitespace-pre-wrap">{line}</div>
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
                        <ResizableHandle withHandle className="!pointer-events-auto bg-[#545454] hover:bg-emerald-500 w-0.5 z-50" />
                        {FileTreePanel}
                        {chatVisible && (
                            <>
                                            <ResizableHandle withHandle className="!pointer-events-auto bg-[#545454] hover:bg-emerald-500 w-0.5 z-50" />
                                            {ChatPanel}
                            </>
                        )}
                    </>
                ) : (
                    <>
                        {FileTreePanel}
                        <ResizableHandle withHandle className="!pointer-events-auto bg-[#545454] hover:bg-emerald-500 w-0.5 z-50" />
                        {EditorPanelComponent}
                        {chatVisible && (
                            <>
                                <ResizableHandle withHandle className="!pointer-events-auto bg-[#545454] hover:bg-emerald-500 w-0.5 z-50" />
                                {ChatPanel}
                            </>
                        )}
                    </>
                )}
            </ResizablePanelGroup>

            {/* Chat is rendered inside the ResizablePanelGroup when visible (see `ChatPanel`) */}
            
            {/* Error Overlay for compile/runtime errors */}
            <ErrorOverlay />
        </div>
    );
}
