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
import EditorPanel from "./Editor/Editor.jsx";
import { getFileLanguage } from '@/utils/fileUtils';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { useCompiler } from '@/hooks/useCompiler';
import AIChatWindow from '@/components/chat/AIChatWindow';
import { api } from '@/services/api';
import { resolveDependencies } from '@/utils/dependencyResolver';

export default function EditorPage({ params }) {
    const dispatch = useAppDispatch();
    const [chatVisible, setChatVisible] = useState(false);
    const [guiConfig, setGuiConfig] = useState(null);
    const [isGuiRunning, setIsGuiRunning] = useState(false);
    const guiVideoRef = useRef(null);
    const [editor, setEditor] = useState(null);
    const { analyzeCode, lastResult } = useAnalyzerGateway();
    const { compile, mediaStream } = useCompiler();
    const [latestCompletion, setLatestCompletion] = useState(null);
    const [completionClearSignal, setCompletionClearSignal] = useState(0);
    const [buildLogs, setBuildLogs] = useState([]);
    const [isGuiMode, setIsGuiMode] = useState(false);

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

    // Attach pointer/keyboard handlers to the video element for GUI interaction
    useEffect(() => {
        const el = guiVideoRef.current;
        if (!el || !guiConfig) return;

        const toDisplayCoords = (clientX, clientY) => {
            const rect = el.getBoundingClientRect();
            const dw = guiConfig.width || rect.width;
            const dh = guiConfig.height || rect.height;
            const x = Math.round((clientX - rect.left) * (dw / rect.width));
            const y = Math.round((clientY - rect.top) * (dh / rect.height));
            return { x, y };
        };

        const handleMouseMove = (ev) => {
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'move', x, y });
        };
        const handleMouseDown = (ev) => {
            const button = ev.button === 0 ? 1 : (ev.button === 1 ? 2 : 3);
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'down', x, y, button });
            // focus so keyboard events go to this element
            try { el.focus(); } catch (e) {}
            ev.preventDefault();
        };
        const handleMouseUp = (ev) => {
            const button = ev.button === 0 ? 1 : (ev.button === 1 ? 2 : 3);
            const { x, y } = toDisplayCoords(ev.clientX, ev.clientY);
            sendGuiEvent({ type: 'mouse', action: 'up', x, y, button });
            ev.preventDefault();
        };
        const handleWheel = (ev) => {
            sendGuiEvent({ type: 'mouse', action: 'wheel', deltaY: ev.deltaY });
            ev.preventDefault();
        };

        const handleKeyDown = (ev) => {
            // Prevent global shortcuts interfering
            ev.preventDefault();
            sendGuiEvent({ type: 'key', action: 'down', key: ev.key });
        };
        const handleKeyUp = (ev) => {
            ev.preventDefault();
            sendGuiEvent({ type: 'key', action: 'up', key: ev.key });
        };

        el.addEventListener('mousemove', handleMouseMove);
        el.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mouseup', handleMouseUp);
        el.addEventListener('wheel', handleWheel, { passive: false });
        el.addEventListener('keydown', handleKeyDown);
        el.addEventListener('keyup', handleKeyUp);

        return () => {
            el.removeEventListener('mousemove', handleMouseMove);
            el.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mouseup', handleMouseUp);
            el.removeEventListener('wheel', handleWheel);
            el.removeEventListener('keydown', handleKeyDown);
            el.removeEventListener('keyup', handleKeyUp);
        };
    }, [guiConfig, guiVideoRef]);

    const handleClearLatestCompletion = useCallback(() => {
        setLatestCompletion(null);
        setCompletionClearSignal((v) => v + 1);
    }, []);
    const [aiBusy, setAiBusy] = useState(false);
    
    // 1. Consume the slug parameter and initiate fetch
    const { slug } = use(params);
    useEffect(() => {
        if (slug) {
            dispatch(setSlug(slug)); // Save slug globally
            dispatch(fetchFilesThunk(slug)); // Initiate data fetch
        }
    }, [slug, dispatch]);

    // 2. Consume global state directly via selectors
    const activeFile = useAppSelector(selectActiveFile);
    const showTerminal = useAppSelector(selectShowTerminal);
    const treeOnRight = useAppSelector(selectTreeOnRight);
    const currentContent = useAppSelector(selectCurrentContent);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    const fileContentCache = useAppSelector(state => state.workspace.fileContentCache);

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

        const langSource =
            activeFile.language ||
            (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
            'plaintext';
        const normalizedLang = langSource.toLowerCase();

        analyzeCode({
            lang: normalizedLang,
            code: typeof currentContent === 'string' ? currentContent : '',
        })
        /*.catch((err) => {
            console.error('Static analysis failed', err);
        });*/
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

    const handleRun = useCallback(async () => {
        if (!activeFile) {
            console.warn('No active file selected for compilation.');
            return;
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
            if (fileContentCache.has(path)) {
                return fileContentCache.get(path);
            }
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

        // Use the manual toggle for GUI mode
        const isGui = isGuiMode;

        try {
            await compile({
                filename,
                source,
                files: additionalFiles,
                isGui,
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
    }, [activeFile, currentContent, appendBuildLog, dispatch, showTerminal, rawFiles, fileContentCache, slug, isGuiMode, compile]);

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

    const EditorPanelComponent = (
        <EditorPanel
            onRun={handleRun}
            onToggleTerminal={() => dispatch(toggleTerminal())}
            onEditorMount={handleEditorMount}
            analysisResult={lastResult}
            latestCompletion={latestCompletion}
            aiBusy={aiBusy}
            onClearCompletion={handleClearLatestCompletion}
        />
    );

    const FileTreePanel = (
        <ResizablePanel defaultSize={15} minSize={10} maxSize={35} className={`${treeOnRight? 'border-l' : 'border-r'} border-[#545454] bg-[#252526]`}>
            <FileTreeView
                onToggleOrientation={toggleTreeOrientation}
            />
        </ResizablePanel>
    );

    const ChatPanel = (
        <ResizablePanel defaultSize={24} minSize={22} maxSize={45} className="border-l border-[#545454] bg-[#171717] min-w-0">
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

    return (
        <div className="flex flex-col h-screen bg-[#1e1e1e] text-gray-200">
            <TopNav
                title={activeFile? activeFile.name : 'Synthi Workspace'}
                onRun={handleRun}
                onToggleTerminal={() => dispatch(toggleTerminal())}
                onUndo={handleUndo}
                onRedo={handleRedo}
                onToggleChat={handleToggleChat}
                chatVisible={chatVisible}
                isGuiMode={isGuiMode}
                onToggleGuiMode={() => setIsGuiMode(v => !v)}
            />
            {buildLogs.length > 0 && (
                <div className="border-b border-[#2b2b2b] bg-[#121212] px-3 py-2 text-xs font-mono text-gray-200 max-h-28 overflow-auto">
                    {buildLogs.map((line, idx) => (
                        <div key={idx} className="leading-5 whitespace-pre-wrap">{line}</div>
                    ))}
                </div>
            )}
            {(guiConfig) && (
                <div 
                    className="fixed bottom-4 right-4 bg-black border border-gray-600 shadow-lg z-50 resize overflow-auto"
                    style={{ 
                        width: guiConfig.width, 
                        height: guiConfig.height,
                        maxWidth: '90vw',
                        maxHeight: '90vh'
                    }}
                >
                    <div className="absolute top-0 left-0 bg-gray-800 text-white text-xs px-2 py-1 z-10 flex items-center gap-2">
                        <span>GUI Output ({guiConfig.width}x{guiConfig.height})</span>
                        {!isGuiRunning && <span className="text-red-400 font-bold">[STOPPED]</span>}
                        <button onClick={() => { setGuiConfig(null); setIsGuiRunning(false); }} className="ml-2 text-red-400 hover:text-red-300">x</button>
                    </div>
                    {mediaStream ? (
                        <video
                            tabIndex={0}
                            width={guiConfig.width}
                            height={guiConfig.height}
                            autoPlay
                            playsInline
                            muted
                            className="block"
                            onClick={() => { try { guiVideoRef.current && guiVideoRef.current.focus(); } catch (e) {} }}
                            ref={video => {
                                if (video && mediaStream && video.srcObject !== mediaStream) {
                                    video.srcObject = mediaStream;
                                }
                                // keep ref current
                                if (video) guiVideoRef.current = video;
                            }}
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-500">
                            {isGuiRunning ? 'Waiting for video stream...' : 'Application exited'}
                        </div>
                    )}
                </div>
            )}
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
        </div>
    );
}
