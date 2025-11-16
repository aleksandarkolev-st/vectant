// src/app/Editor.jsx
'use client';
import { useEffect, useState, useRef } from 'react';
import Editor from '@monaco-editor/react';
import { getMonacoLanguage } from '@/utils/languageMapper';
import dynamic from 'next/dynamic';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { 
    selectActiveFile, 
    selectCurrentContent, 
    selectIsUnsaved, 
    selectBreadcrumb, 
    saveFileContentThunk, 
    updateContent 
} from '@/redux/workspaceSlice';
import { selectAutoSaveEnabled } from '@/redux/uiSlice';
import { Folder, FileText, Circle, Save } from 'lucide-react';
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

const TerminalManagerDyn = dynamic(() => import('../TerminalManager.jsx'), {
    ssr: false
});

const EditorPanel = ({
    onRun,
    onToggleTerminal,
    onEditorMount,
    analysisResult
}) => {
    const dispatch = useAppDispatch();
    
    // Global state access (Granular selectors for performance)
    const activeFile = useAppSelector(selectActiveFile);
    const code = useAppSelector(selectCurrentContent);
    const isUnsaved = useAppSelector(selectIsUnsaved);
    const breadcrumb = useAppSelector(selectBreadcrumb);
    const showTerminal = useAppSelector(state => state.ui.showTerminal);
    const autoSaveEnabled = useAppSelector(selectAutoSaveEnabled);
    
    // Local state retention
    const [position, setPosition] = useState({ lineNumber: 1, column: 1 });
    const [editorInstance, setEditorInstance] = useState(null);
    const [monacoInstance, setMonacoInstance] = useState(null);
    const hoverProviderRef = useRef(null);

    // Update markers when analysis results change
    useEffect(() => {
        if (!editorInstance || !monacoInstance || !analysisResult) return;

        const markers = [];
        
        // Extract issues from analysis result - supports both 'static_analysis' and 'issues' arrays
        const issues = analysisResult?.static_analysis || analysisResult?.issues || [];
        
        issues.forEach((issue) => {
            const {
                line = 1,
                column = 0,
                end_line,
                end_column,
                message = '',
                severity = 'info', // 'error', 'warning', 'info'
            } = issue;

            // Map severity to Monaco severity
            const monacoSeverity = {
                error: monacoInstance.MarkerSeverity.Error,
                warning: monacoInstance.MarkerSeverity.Warning,
                info: monacoInstance.MarkerSeverity.Information,
            }[severity.toLowerCase()] || monacoInstance.MarkerSeverity.Information;

            // Line numbers in Monaco are 1-indexed, convert from 0-indexed if needed
            const startLine = line === 0 ? 1 : line + 1;
            const finishLine = end_line !== undefined ? (end_line === 0 ? 1 : end_line + 1) : startLine;
            const finishColumn = end_column !== undefined ? Math.max(1, end_column + 1) : Math.max(2, column + 2);
            
            markers.push({
                startLineNumber: startLine,
                startColumn: Math.max(1, column + 1),
                endLineNumber: finishLine,
                endColumn: finishColumn,
                message,
                severity: monacoSeverity,
                source: 'Static Analysis',
            });
        });

        monacoInstance.editor.setModelMarkers(editorInstance.getModel(), 'analysis', markers);
    }, [editorInstance, monacoInstance, analysisResult]);

    // Register a hover provider so hovering over underlined diagnostics shows a popup
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        // Dispose previous provider if any
        try {
            hoverProviderRef.current?.dispose?.();
        } catch (e) {
            // ignore
        }

        const language = activeFile ? getMonacoLanguage(activeFile.name) : 'plaintext';

        hoverProviderRef.current = monacoInstance.languages.registerHoverProvider(
            language,
            {
                provideHover: (model, position) => {
                    const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
                    const hits = markers.filter((m) => {
                        return (
                            position.lineNumber >= m.startLineNumber &&
                            position.lineNumber <= m.endLineNumber &&
                            position.column >= m.startColumn &&
                            position.column <= m.endColumn
                        );
                    });

                    if (!hits.length) return null;

                    // Build markdown contents for all hits at this position
                    const contents = hits.map((m) => {
                        const severity =
                            m.severity === monacoInstance.MarkerSeverity.Error
                                ? 'Error'
                                : m.severity === monacoInstance.MarkerSeverity.Warning
                                ? 'Warning'
                                : 'Info';
                        const code = m.code ? ` (${m.code})` : '';
                        const md = `**${severity}**${code}\n\n${m.message}`;
                        return { value: md };
                    });

                    const first = hits[0];
                    const range = new monacoInstance.Range(
                        first.startLineNumber,
                        first.startColumn,
                        first.endLineNumber,
                        first.endColumn
                    );

                    const lineCount = model.getLineCount();
                    const isNearTop = position.lineNumber <= 3;
                    const isNearBottom = position.lineNumber >= lineCount - 2;

                    monacoInstance.editor.updateOptions({
                        hover: {
                            enabled: true,
                            sticky: true,
                            above: !isNearTop,
                            bottom: !isNearBottom
                        },
                    });

                    return {
                        range,
                        contents
                    };
                },
            }
        );

        return () => {
            try {
                hoverProviderRef.current?.dispose?.();
            } catch (e) {
                // ignore
            }
            hoverProviderRef.current = null;
        };
    }, [monacoInstance, editorInstance, activeFile, analysisResult]);

    // Handler to update content in Redux
    const handleCodeChange = (newCode) => {
        dispatch(updateContent(newCode));
    };
    
    // Handler to save content via Thunk
    const handleSave = () => {
        if (activeFile && isUnsaved) {
            dispatch(saveFileContentThunk());
        }
    };

    // Auto-save functionality with debouncing
    useEffect(() => {
        if (!autoSaveEnabled || !isUnsaved || !activeFile) return;
        
        const autoSaveTimer = setTimeout(() => {
            dispatch(saveFileContentThunk());
        }, 500);
        
        return () => clearTimeout(autoSaveTimer);
    }, [code, autoSaveEnabled, isUnsaved, activeFile, dispatch]);

    // Add keyboard shortcuts (Ctrl+S uses the centralized save function)
    useEffect(() => {
        const handleKeyDown = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                e.stopPropagation();
                handleSave();
            }
        };
        // The handleSave function is stable as its dependencies (dispatch, activeFile, isUnsaved)
        // are accessed through closures or stable dispatch reference.
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    },); 

    return (
        <ResizablePanel defaultSize={76} minSize={20}>
            <ResizablePanelGroup direction="vertical" className="h-full">
                <ResizablePanel defaultSize={70} minSize={20}>
                    <div className="h-full flex flex-col bg-[#1e1e1e]">
                        {/* Tab/Breadcrumb area */}
                        <div className="px-3 py-2 text-sm border-b border-[#545454] bg-[#252526] flex justify-between items-center gap-1 overflow-x-auto whitespace-nowrap">
                            <div className='flex flex-row items-center gap-2'>
                                {breadcrumb && breadcrumb.length > 0? (
                                    breadcrumb.map((name, idx) => {
                                        const isLast = idx === breadcrumb.length - 1;
                                        const isFile = isLast && activeFile && name === activeFile.name;
                                        return (
                                            <span key={`${name}-${idx}`} className="flex items-center">
                                                {isFile? (
                                                    <FileText className="w-3.5 h-3.5 mr-1 text-gray-400" />
                                                ) : (
                                                    <Folder className="w-3.5 h-3.5 mr-1 text-gray-400" />
                                                )}
                                                <span className={`text-xs ${isLast? 'text-gray-100' : 'text-gray-400'}`}>
                                                    {name}
                                                </span>
                                                {idx < breadcrumb.length - 1 && <span className="px-1 text-gray-500">›</span>}
                                            </span>
                                        );
                                    })
                                ) : (
                                    <span className="text-xs text-gray-400">No file selected</span>
                                )}
                                {/* Unsaved indicator */}
                                {isUnsaved && (
                                    <Circle className="w-3 h-3 text-orange-400 fill-orange-400" />
                                )}
                                {/* Save button */}
                                {activeFile && (
                                    <button
                                        onClick={handleSave}
                                        className="p-1 hover:bg-[#2f2f2f] rounded transition-colors"
                                        title="Save file (Ctrl+S)"
                                    >
                                        <Save className="w-3.5 h-3.5 text-gray-400 hover:text-gray-200" />
                                    </button>
                                )}
                            </div>
                            <div className='flex flex-row gap-2'>
                                <p className='text-xs text-gray-400'>Ln: {position.lineNumber}</p>
                                <p className='text-xs text-gray-400'>Col: {position.column}</p>
                            </div>
                        </div>
                        {/* Editor area */}
                        <div className="flex-1 overflow-hidden">
                            <ContextMenu>
                                <ContextMenuTrigger asChild>
                                    <div className="h-full">
                                        <Editor
                                            key={activeFile? activeFile.path : 'no-file'} // Use path for a better key
                                            height="100%"
                                            value={code}
                                            language={activeFile ? getMonacoLanguage(activeFile.name) : 'plaintext'}
                                            onChange={handleCodeChange}
                                            theme="vs-dark"
                                            options={{
                                                minimap: { enabled: true },
                                                fontSize: 14,
                                                wordWrap: 'off',
                                                scrollBeyondLastLine: true,
                                                automaticLayout: true,
                                                lineNumbers: true,
                                                scrollbar: {
                                                    verticalHasArrows: true,
                                                    horizontalHasArrows: true,
                                                }
                                            }}
                                            onMount={(editor, monaco) => {
                                               setEditorInstance(editor);
                                               setMonacoInstance(monaco);
                                                if (onEditorMount) {
                                                    onEditorMount(editor);
                                                }
                                                editor.onDidChangeCursorPosition(e => {
                                                    setPosition({
                                                    lineNumber: e.position.lineNumber,
                                                    column: e.position.column
                                                    });
                                                });
                                                window.MonacoEnvironment = {
                                                    getWorker: function (moduleId, label) {
                                                        if (label === 'json') {
                                                            return new Worker(new URL('monaco-editor/esm/vs/language/json/json.worker', import.meta.url));
                                                        }
                                                        if (label === 'css' || label === 'scss' || label === 'less') {
                                                            return new Worker(new URL('monaco-editor/esm/vs/language/css/css.worker', import.meta.url));
                                                        }
                                                        if (label === 'html' || label === 'handlebars' || label === 'razor') {
                                                            return new Worker(new URL('monaco-editor/esm/vs/language/html/html.worker', import.meta.url));
                                                        }
                                                        if (label === 'typescript' || label === 'javascript') {
                                                            return new Worker(new URL('monaco-editor/esm/vs/language/typescript/ts.worker', import.meta.url));
                                                        }
                                                        return new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker', import.meta.url));
                                                    }
                                                };
                                            }}
                                        />
                                    </div>
                                </ContextMenuTrigger>
                                <ContextMenuContent className="w-48">
                                    <ContextMenuItem onClick={() => onRun()}>Run File</ContextMenuItem>
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('editor.action.formatDocument')?.run()}>Format Document</ContextMenuItem>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem onClick={() => editorInstance?.getAction('actions.find')?.run()}>Find…</ContextMenuItem>
                                </ContextMenuContent>
                            </ContextMenu>
                        </div>
                    </div>
                </ResizablePanel>
                {/* Terminal Panel */}
                {showTerminal && (
                    <>
                        <ResizableHandle
                            withHandle
                            className="!pointer-events-auto bg-[#545454] hover:bg-emerald-500 w-0.5 z-50"
                            onMouseDown={(e) => e.stopPropagation()}
                        />
                        <ResizablePanel defaultSize={30} minSize={15} >
                            <TerminalManagerDyn visible={true} onCloseAll={onToggleTerminal} />
                        </ResizablePanel>
                    </>
                )}
            </ResizablePanelGroup>
        </ResizablePanel>
    );
};
export default EditorPanel;