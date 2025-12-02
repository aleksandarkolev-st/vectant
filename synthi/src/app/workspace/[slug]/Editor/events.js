import { useEffect } from 'react';
import { resolvePath } from '@/utils/dependencyResolver';
import { selectFileThunk } from '@/redux/workspaceSlice';
import { getFileLanguage } from '@/utils/fileUtils';

const flattenFiles = (nodes, map = new Map()) => {
    for (const node of nodes) {
        if (node.isFolder) {
            if (node.children) flattenFiles(node.children, map);
        } else {
            map.set(node.path, node);
        }
    }
    return map;
};

export const useEditorEvents = ({
    editorInstance,
    monacoInstance,
    cancelActiveCompletion,
    requestAiCompletion,
    hasActiveDiff,
    aiAutoEnabled = true,
    rawFiles = [],
    dispatch,
    activeFile
}) => {
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        const disposables = [];
        let linkDecorations = [];
        let isCtrlPressed = false;

        const findTargetFile = (position) => {
            const model = editorInstance.getModel();
            if (!model) return null;
            const lineContent = model.getLineContent(position.lineNumber);
            
            // Simple regex to extract string literals on the line
            const stringRegex = /["']([^"']+)["']/g;
            let match;
            while ((match = stringRegex.exec(lineContent)) !== null) {
                const startCol = match.index + 1;
                const endCol = match.index + match[0].length + 1;
                
                // Check if position is within the string
                if (position.column >= startCol && position.column <= endCol) {
                    const importPath = match[1];
                    const currentPath = activeFile?.path || '';
                    
                    // Resolve path
                    const candidates = [];
                    candidates.push(resolvePath(currentPath, importPath));
                    if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
                        candidates.push(importPath);
                    }

                    const fileMap = flattenFiles(rawFiles);
                    let foundNode = null;
                    
                    for (const candidatePath of candidates) {
                        if (fileMap.has(candidatePath)) {
                            foundNode = fileMap.get(candidatePath);
                            break;
                        }
                        // Try extensions
                        const extensions = ['.ts', '.tsx', '.js', '.jsx', '.hpp', '.h', '.cpp', '.c'];
                        for (const ext of extensions) {
                            if (fileMap.has(candidatePath + ext)) {
                                foundNode = fileMap.get(candidatePath + ext);
                                break;
                            }
                        }
                        if (foundNode) break;
                    }

                    if (foundNode) {
                        return {
                            node: foundNode,
                            range: new monacoInstance.Range(position.lineNumber, startCol + 1, position.lineNumber, endCol - 1)
                        };
                    }
                }
            }
            return null;
        };

        const updateDecorations = (position) => {
            if (!position) {
                linkDecorations = editorInstance.deltaDecorations(linkDecorations, []);
                return;
            }

            if (isCtrlPressed) {
                const target = findTargetFile(position);
                if (target) {
                    linkDecorations = editorInstance.deltaDecorations(linkDecorations, [{
                        range: target.range,
                        options: {
                            inlineClassName: 'monaco-link-hover',
                            cursor: 'pointer'
                        }
                    }]);
                    return;
                }
            }
            linkDecorations = editorInstance.deltaDecorations(linkDecorations, []);
        };

        try {
            // Handle Ctrl + Click for Go to Definition
            disposables.push(editorInstance.onMouseDown((e) => {
                const event = e.event;
                const target = e.target;

                if (event.ctrlKey && target.type === 6 /* monaco.editor.MouseTargetType.CONTENT_TEXT */) {
                    const result = findTargetFile(target.position);
                    if (result) {
                        event.preventDefault();
                        dispatch(selectFileThunk(result.node));
                    }
                }
            }));

            disposables.push(editorInstance.onMouseMove((e) => {
                if (e.target.type === 6) {
                    updateDecorations(e.target.position);
                } else {
                    updateDecorations(null);
                }
            }));

            disposables.push(editorInstance.onKeyDown((e) => {
                if (e.ctrlKey || e.metaKey) {
                    isCtrlPressed = true;
                    const position = editorInstance.getPosition();
                    if (position) updateDecorations(position);
                }
            }));

            disposables.push(editorInstance.onKeyUp((e) => {
                if (!e.ctrlKey && !e.metaKey) {
                    isCtrlPressed = false;
                    updateDecorations(null);
                }
            }));
            
            // Also listen to window key events to catch Ctrl release outside editor focus or missed events
            const handleWindowKeyUp = (e) => {
                if (e.key === 'Control' || e.key === 'Meta') {
                    isCtrlPressed = false;
                    updateDecorations(null);
                }
            };
            const handleWindowKeyDown = (e) => {
                if (e.key === 'Control' || e.key === 'Meta') {
                    isCtrlPressed = true;
                    // We can't easily get mouse position here without tracking it globally, 
                    // but onMouseMove will handle the decoration update when mouse moves.
                    // If mouse is stationary, we might miss the update until mouse moves.
                    // To fix this, we could track last mouse position in onMouseMove.
                }
            };
            
            window.addEventListener('keydown', handleWindowKeyDown);
            window.addEventListener('keyup', handleWindowKeyUp);
            disposables.push({ dispose: () => {
                window.removeEventListener('keydown', handleWindowKeyDown);
                window.removeEventListener('keyup', handleWindowKeyUp);
            }});

            disposables.push(editorInstance.onDidType((text) => {
                cancelActiveCompletion({ resetSuggestion: true, reason: 'typing' });
                const lastChar = (text || '').slice(-1);
                const isPunctuation = /[\(\)\{\}\[\];,]/.test(lastChar);
                const isEnter = lastChar === '\n';
                if (hasActiveDiff()) return;
                if (!aiAutoEnabled) return;
                if (isPunctuation || isEnter) {
                    requestAiCompletion(true, null, { reason: isEnter ? 'enter' : 'punctuation', enterTrigger: isEnter });
                }
            }));
            disposables.push(editorInstance.onDidChangeCursorSelection((e) => {
                // Ignore cursor moves that come from normal typing; only cancel if the
                // user actually moves/extends the selection (mouse or keyboard select).
                const source = e?.source;
                const selection = e?.selection;
                const hasSelection = selection && !selection.isEmpty();
                const isMouse = source === 'mouse';
                if (!isMouse && !hasSelection) return;
                cancelActiveCompletion({ resetSuggestion: true, reason: isMouse ? 'cursor-move' : 'selection-change' });
            }));
        } catch (e) {
            // ignore if monaco is missing APIs
        }

        return () => {
            disposables.forEach((disposable) => disposable?.dispose?.());
        };
    }, [editorInstance, cancelActiveCompletion, requestAiCompletion, hasActiveDiff, aiAutoEnabled, rawFiles, dispatch, activeFile]);
};
