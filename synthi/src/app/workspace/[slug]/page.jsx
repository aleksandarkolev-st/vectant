'use client';
import { useState, useEffect, useCallback } from 'react';
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
import EditorPanel from "./Editor.jsx";
import { getFileLanguage } from '@/utils/fileUtils';
import { API_COMPLETION_ROUTE } from '@/lib/completion';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { AnalysisPanel } from '@/components/analysis/AnalysisPanel';
import AIChatWindow from '@/components/chat/AIChatWindow';

export default function EditorPage({ params }) {
    const dispatch = useAppDispatch();
    const [chatVisible, setChatVisible] = useState(false);
    const [editor, setEditor] = useState(null);
    const {
        connectionStatus,
        isAnalyzing,
        lastResult,
        lastError,
        analyzeCode,
        resetResult,
        resetError,
    } = useAnalyzerGateway();
    const [analysisVisible, setAnalysisVisible] = useState(false);
    const [latestCompletion, setLatestCompletion] = useState(null);
    
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

    useEffect(() => {
        if (!analysisVisible && (isAnalyzing || lastResult || lastError)) {
            setAnalysisVisible(true);
        }
    }, [analysisVisible, isAnalyzing, lastResult, lastError]);

    // Run static analysis whenever current file content changes
    useEffect(() => {
        if (activeFile && currentContent && hasLoadedInitialFile) {
            const langSource =
                activeFile.language ||
                (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
                'plaintext';
            const normalizedLang = langSource.toLowerCase();

            analyzeCode({
                lang: normalizedLang,
                code: typeof currentContent === 'string' ? currentContent : '',
            }).catch((err) => {
                console.error('Static analysis failed', err);
            }).finally(() => {
                console.log(`Static analysis completed: ${JSON.stringify(lastResult)}`);
            });
        }
    }, [currentContent, activeFile, hasLoadedInitialFile, analyzeCode]);

    // Send code completion requests when the code changes (debounced)
    useEffect(() => {
        if (!activeFile || !editor || typeof currentContent !== 'string') return;

        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const pos = editor.getPosition?.();
                const cursor = pos ? { line: pos.lineNumber, column: pos.column } : undefined;
                const langSource =
                    activeFile.language ||
                    (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
                    'plaintext';
                const normalizedLang = langSource.toLowerCase();

                const payload = {
                    language: normalizedLang,
                    code: currentContent,
                    cursor,
                };

                const resp = await fetch(API_COMPLETION_ROUTE, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });

                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    console.warn('Completion API error', err);
                    return;
                }

                const json = await resp.json().catch(() => null);
                if (cancelled) return;
                setLatestCompletion(json?.completion || null);
                if (json?.completion) {
                    console.debug('Received completion:', json.completion);
                }
            } catch (err) {
                console.error('Completion request failed', err);
            }
        }, 500);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [currentContent, activeFile, editor]);

    const handleRun = useCallback(async () => {
        if (!activeFile) {
            console.warn('No active file selected for analysis.');
            return;
        }
        const langSource =
            activeFile.language ||
            (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
            'plaintext';
        const normalizedLang = langSource.toLowerCase();

        try {
            await analyzeCode({
                lang: normalizedLang,
                code: typeof currentContent === 'string' ? currentContent : '',
            });
        } catch (err) {
            console.error('Failed to run analyzer', err);
        }
    }, [activeFile, currentContent, analyzeCode]);

    

    const handleDismissAnalysis = useCallback(() => {
        setAnalysisVisible(false);
        resetResult();
        resetError();
    }, [resetError, resetResult]);

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
        />
    );

    const FileTreePanel = (
        <ResizablePanel defaultSize={15} minSize={1} maxSize={35} className={`${treeOnRight? 'border-l' : 'border-r'} border-[#545454] bg-[#252526]`}>
            <FileTreeView
                onToggleOrientation={toggleTreeOrientation}
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
            />
            <AnalysisPanel
                visible={analysisVisible}
                status={connectionStatus}
                result={lastResult}
                error={lastError}
                isAnalyzing={isAnalyzing}
                onRetry={handleRun}
                onClose={handleDismissAnalysis}
            />
            <ResizablePanelGroup
                direction="horizontal"
                className="flex-1 min-h-0"
                key={panelGroupKey}
            >
                {treeOnRight? (
                    <>
                        {EditorPanelComponent}
                        <ResizableHandle withHandle className="!pointer-events-auto bg-[#545454] hover:bg-emerald-500 w-0.5 z-50" />
                        {FileTreePanel}
                    </>
                ) : (
                    <>
                        {FileTreePanel}
                        <ResizableHandle withHandle className="!pointer-events-auto bg-[#545454] hover:bg-emerald-500 w-0.5 z-50" />
                        {EditorPanelComponent}
                    </>
                )}
            </ResizablePanelGroup>

            {/* AI Chat Window (right side) */}
            <AIChatWindow
                isVisible={chatVisible}
                onClose={() => setChatVisible(false)}
                activeFile={activeFile}
                currentCode={currentContent}
            />
        </div>
    );
}
