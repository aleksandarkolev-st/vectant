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
    cancelActiveCompletion,
    requestAiCompletion,
    hasActiveDiff,
    aiAutoEnabled = true,
    rawFiles = [],
    dispatch,
    activeFile
}) => {
    useEffect(() => {
        if (!editorInstance) return;
        const disposables = [];
        try {
            // Handle Ctrl + Click for Go to Definition
            disposables.push(editorInstance.onMouseDown((e) => {
                const event = e.event;
                const target = e.target;

                if (event.ctrlKey && target.type === 6 /* monaco.editor.MouseTargetType.CONTENT_TEXT */) {
                    const position = target.position;
                    const model = editorInstance.getModel();
                    const lineContent = model.getLineContent(position.lineNumber);
                    
                    // Simple regex to extract string literals on the line
                    // This covers #include "..." and import ... from "..."
                    const stringRegex = /["']([^"']+)["']/g;
                    let match;
                    while ((match = stringRegex.exec(lineContent)) !== null) {
                        const startCol = match.index + 1;
                        const endCol = match.index + match[0].length + 1;
                        
                        // Check if click is within the string
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
                                event.preventDefault();
                                dispatch(selectFileThunk(foundNode));
                            }
                            break;
                        }
                    }
                }
            }));

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
