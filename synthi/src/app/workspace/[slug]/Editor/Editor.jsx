// src/app/Editor.jsx
'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
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
    updateContent
} from '@/redux/workspaceSlice';
import { selectAutoSaveEnabled, selectAutoCompletionEnabled, toggleAutoCompletion } from '@/redux/uiSlice';
import { Circle, Save, Sparkles } from 'lucide-react'; // Added Sparkles
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
import { takeLastChars } from './utils';

const TerminalManagerDyn = dynamic(() => import('../../TerminalManager.jsx'), {
    ssr: false
});

const EditorPanel = ({
    onRun,
    onToggleTerminal,
    onEditorMount,
    analysisResult,
    latestCompletion,
    aiBusy = false,
    onClearCompletion = null,
}) => {
    const dispatch = useAppDispatch();

    //Global state access
    const activeFile = useAppSelector(selectActiveFile);
    const code = useAppSelector(selectCurrentContent);
    const isUnsaved = useAppSelector(selectIsUnsaved);
    const breadcrumb = useAppSelector(selectBreadcrumb);
    const fileCacheEntries = useAppSelector(selectFileCacheEntries);
    const rawFiles = useAppSelector(state => state.workspace.rawFiles);
    const showTerminal = useAppSelector(state => state.ui.showTerminal);
    const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
    const aiAutoEnabled = useAppSelector(selectAutoCompletionEnabled);

    // Local state
    const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
    const [editorInstance, setEditorInstance] = useState(null);
    const [monacoInstance, setMonacoInstance] = useState(null);
    const latestCodeRef = useRef(code);
    const pendingContentFrameRef = useRef(null);
    const pendingPositionFrameRef = useRef(null);
    
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
        activeFile
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
        }, 400);
    }, [aiAutoEnabled, activeDiffCheck, cancelActiveCompletion, dispatch, requestAiCompletion]);

    const handleSave = useCallback(() => {
        if (activeFile && isUnsaved) dispatch(saveFileContentThunk());
    }, [activeFile, isUnsaved, dispatch]);

    // Auto-save
    useEffect(() => {
        if (!autoSaveEnabled || !isUnsaved || !activeFile) return;
        const t = setTimeout(() => dispatch(saveFileContentThunk()), 500);
        return () => clearTimeout(t);
    }, [code, autoSaveEnabled, isUnsaved, activeFile, dispatch]);

    // Key bindings (Ctrl+S, Alt+F)
    useEffect(() => {
        const handleKeyDown = (e) => {
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
            }
        };
        window.addEventListener('keydown', handleKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
    }, [handleSave, editorInstance, requestAiCompletion, cancelActiveCompletion, dispatch]);

    // Ensure disabling auto AI clears any pending/computed suggestions
    useEffect(() => {
        if (aiAutoEnabled) return;
        cancelActiveCompletion({ resetSuggestion: true, reason: 'auto-disabled' });
        if (aiDebounceTimerRef.current) clearTimeout(aiDebounceTimerRef.current);
    }, [aiAutoEnabled, cancelActiveCompletion]);

    // Handle updates from analysis (Markers)
    useEffect(() => {
        if (!editorInstance || !monacoInstance || !analysisResult) return;
        const issues = analysisResult?.static_analysis || analysisResult?.issues || [];
        const markers = issues.map(issue => ({
            startLineNumber: issue.line === 0 ? 1 : issue.line + 1,
                startColumn: Math.max(1, (issue.column || 0) + 1),
            endLineNumber: issue.end_line ? issue.end_line + 1 : (issue.line === 0 ? 1 : issue.line + 1),
            endColumn: issue.end_column ? issue.end_column + 1 : 100,
            message: issue.message,
            severity: issue.severity === 'error' ? monacoInstance.MarkerSeverity.Error : monacoInstance.MarkerSeverity.Warning
        }));
        monacoInstance.editor.setModelMarkers(editorInstance.getModel(), 'analysis', markers);
    }, [editorInstance, monacoInstance, analysisResult]);

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
                    if (p && typeof p.then === 'function') p.catch(() => {});
                } catch(e){}
            }
        }
    }, [latestCompletion, editorInstance, code, activeLanguage]);


    
    // --- Render ---


    return (
        <ResizablePanel defaultSize={76} minSize={20}>
            <ResizablePanelGroup direction="vertical" className="h-full">
                <ResizablePanel defaultSize={70} minSize={20}>
                    <div className="h-full flex flex-col bg-[#1e1e1e]">
                        {/* Minimal Sleek Header */}
                        <div className="h-9 px-3 border-b border-[#2b2b2b] bg-[#1e1e1e] flex justify-between items-center select-none">
                            
                            {/* Breadcrumbs */}
                            <div className="flex items-center gap-2 overflow-hidden">
                                {activeFileIcon ? (
                                    <span className="flex items-center text-gray-300" aria-hidden="true">
                                        {activeFileIcon}
                                    </span>
                                ) : null}
                                {breadcrumb?.length > 0 ? (
                                    breadcrumb.map((name, idx) => {
                                        const isLast = idx === breadcrumb.length - 1;
                                        return (
                                            <div key={idx} className="flex items-center text-[13px]">
                                                <span className={`${isLast ? 'text-gray-200 font-medium' : 'text-gray-500'}`}>
                                                    {name}
                                                </span>
                                                {!isLast && <span className="text-gray-600 mx-1">/</span>}
                                            </div>
                                        )
                                    })
                                ) : (
                                    <span className="text-gray-500 text-xs italic">No file selected</span>
                                )}
                                {isUnsaved && <Circle className="w-2 h-2 ml-2 text-orange-400 fill-orange-400" />}
                            </div>

                            {/* Status & Controls */}
                            <div className="flex items-center gap-4">
                                {/* Line/Col Info */}
                                <div className="hidden md:flex gap-3 text-[11px] text-gray-500 font-mono">
                                    <span>Ln {position.lineNumber}, Col {position.column}</span>
                                </div>

                                {/* AI Status Indicator (Subtle) */}
                                <div className="flex items-center gap-2 text-[11px]">
                                    <div className={`transition-opacity duration-300 ${(aiCompletionState === 'loading' || aiBusy) ? 'opacity-100' : 'opacity-0'}`}>
                                        <Sparkles className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
                                    </div>
                                    <span className={`uppercase tracking-wide ${aiAutoEnabled ? 'text-emerald-300' : 'text-gray-500'}`}>
                                        AI Auto {aiAutoEnabled ? 'On' : 'Off'}
                                    </span>
                                </div>
                                
                                {/* Manual Save (Optional since we have auto-save) */}
                                <button onClick={handleSave} className="opacity-60 hover:opacity-100 transition-opacity">
                                    <Save className="w-4 h-4 text-gray-400" />
                                </button>
                            </div>
                        </div>

                        {/* Editor Container */}
                        <div className="flex-1 overflow-hidden relative group">
                            <ContextMenu>
                                <ContextMenuTrigger asChild>
                                    <div className="h-full w-full">
                                        <Editor
                                            key={activeFileIdentity}
                                            height="100%"
                                            value={code ?? ''}
                                            language={activeLanguage}
                                            theme="vs-dark"
                                            options={EDITOR_OPTIONS}
                                            onChange={handleCodeChange}
                                            onMount={(editor, monaco) => {
                                                setEditorInstance(editor);
                                                setMonacoInstance(monaco);
                                                if (onEditorMount) onEditorMount(editor);
                                                editor.onDidChangeCursorPosition(e => {
                                                    const nextPos = e.position;
                                                    if (pendingPositionFrameRef.current) return;
                                                    pendingPositionFrameRef.current = requestAnimationFrame(() => {
                                                        setPosition(nextPos);
                                                        pendingPositionFrameRef.current = null;
                                                    });
                                                });
                                                
                                                // Ensure layout refreshes on mount
                                                setTimeout(() => editor.layout(), 100);
                                            }}
                                        />
                                    </div>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-56 bg-[#252526] border-[#454545] text-gray-200">
                                    <ContextMenuItem onClick={onRun}>Run File</ContextMenuItem>
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('editor.action.formatDocument')?.run()}>
                                        Format Document
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
                        <ResizableHandle withHandle className="bg-[#1e1e1e] border-t border-[#2b2b2b]" />
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
