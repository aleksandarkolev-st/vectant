import { useEffect } from 'react';
import { resolvePath } from '@/utils/dependencyResolver';
import { selectFileThunk } from '@/redux/workspaceSlice';
import { getFileLanguage } from '@/utils/fileUtils';

const COMMON_KEYWORDS = [
    'int', 'float', 'double', 'char', 'void', 'bool', 'auto',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
    'return', 'break', 'continue', 'struct', 'class', 'public', 'private', 'protected',
    'namespace', 'using', 'template', 'typename', 'const', 'static', 'virtual', 'override',
    'new', 'delete', 'true', 'false', 'nullptr', 'this', 'friend', 'inline'
];

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
    activeFile,
    fileCacheEntries = []
}) => {
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        const disposables = [];
        let linkDecorations = [];
        let isCtrlPressed = false;

        const findSymbolDefinition = (symbolName) => {
            if (!symbolName) return null;
            
            const entries = Array.isArray(fileCacheEntries) ? fileCacheEntries : [];
            const currentContent = editorInstance.getModel().getValue();
            const currentPath = activeFile?.path || '';
            
            // Helper to get extension
            const getExt = (p) => {
                const idx = p.lastIndexOf('.');
                return idx !== -1 ? p.substring(idx) : '';
            };
            const currentExt = getExt(currentPath);

            // Define compatible extensions
            let compatibleExts = [];
            if (['.cpp', '.c', '.h', '.hpp', '.cc', '.hh'].includes(currentExt)) {
                compatibleExts = ['.cpp', '.c', '.h', '.hpp', '.cc', '.hh'];
            } else if (['.js', '.jsx', '.ts', '.tsx'].includes(currentExt)) {
                compatibleExts = ['.js', '.jsx', '.ts', '.tsx'];
            } else if (['.java'].includes(currentExt)) {
                compatibleExts = ['.java'];
            } else if (['.rs'].includes(currentExt)) {
                compatibleExts = ['.rs'];
            } else {
                compatibleExts = [currentExt];
            }

            // Identify Included Files
            const includedPaths = new Set();
            // C/C++ includes
            const includeRegex = /#include\s+["<]([^">]+)[">]/g;
            let match;
            while ((match = includeRegex.exec(currentContent)) !== null) {
                const importPath = match[1];
                const resolved = resolvePath(currentPath, importPath);
                includedPaths.add(resolved);
                includedPaths.add(importPath); // Add raw path too
            }
            // JS/TS imports (basic support)
            const jsImportRegex = /from\s+['"]([^'"]+)['"]/g;
            while ((match = jsImportRegex.exec(currentContent)) !== null) {
                 const importPath = match[1];
                 const resolved = resolvePath(currentPath, importPath);
                 includedPaths.add(resolved);
            }

            // Sort Entries: Included files first, then same-language files
            const sortedEntries = [...entries].sort((a, b) => {
                const pathA = a[0];
                const pathB = b[0];
                
                const aIncluded = includedPaths.has(pathA);
                const bIncluded = includedPaths.has(pathB);
                
                if (aIncluded && !bIncluded) return -1;
                if (!aIncluded && bIncluded) return 1;
                
                // If neither is included, prefer compatible extensions
                const aCompat = compatibleExts.includes(getExt(pathA));
                const bCompat = compatibleExts.includes(getExt(pathB));
                
                if (aCompat && !bCompat) return -1;
                if (!aCompat && bCompat) return 1;
                
                return 0;
            });
            
            for (const [path, content] of sortedEntries) {
                if (!content) continue;

                // Skip incompatible files if we have a known extension type
                if (compatibleExts.length > 0 && !compatibleExts.includes(getExt(path))) continue;

                // Check for class definition
                const classRegex = new RegExp(`(?:class|struct)\\s+${symbolName}\\b`, 'g');
                const classMatch = classRegex.exec(content);
                if (classMatch) {
                    const lines = content.substring(0, classMatch.index).split('\n');
                    const fileMap = flattenFiles(rawFiles);
                    const node = fileMap.get(path);
                    if (node) return { node, lineNumber: lines.length };
                }

                // Check for function definition
                const functionRegex = new RegExp(`^\\s*(?:static\\s+|inline\\s+|virtual\\s+)*([a-zA-Z_][a-zA-Z0-9_]*)\\s+${symbolName}\\s*\\(`, 'gm');
                const funcMatch = functionRegex.exec(content);
                if (funcMatch) {
                     const lines = content.substring(0, funcMatch.index).split('\n');
                     const fileMap = flattenFiles(rawFiles);
                     const node = fileMap.get(path);
                     if (node) return { node, lineNumber: lines.length };
                }
            }
            return null;
        };

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

            // Check for symbols
            const wordInfo = model.getWordAtPosition(position);
            if (wordInfo) {
                const word = wordInfo.word;
                if (!COMMON_KEYWORDS.includes(word)) {
                    const definition = findSymbolDefinition(word);
                    if (definition) {
                        return {
                            node: definition.node,
                            range: new monacoInstance.Range(position.lineNumber, wordInfo.startColumn, position.lineNumber, wordInfo.endColumn),
                            targetLine: definition.lineNumber
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
                        if (result.node.path === activeFile?.path && result.targetLine) {
                            editorInstance.revealLineInCenter(result.targetLine);
                            editorInstance.setPosition({ lineNumber: result.targetLine, column: 1 });
                        } else {
                            dispatch(selectFileThunk(result.node));
                        }
                    }
                }
            }));

            let lastMousePosition = null;
            disposables.push(editorInstance.onMouseMove((e) => {
                if (e.target.type === 6) {
                    lastMousePosition = e.target.position;
                    updateDecorations(e.target.position);
                } else {
                    lastMousePosition = null;
                    updateDecorations(null);
                }
            }));

            disposables.push(editorInstance.onKeyDown((e) => {
                if (e.ctrlKey || e.metaKey) {
                    isCtrlPressed = true;
                    const position = lastMousePosition || editorInstance.getPosition();
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
    }, [editorInstance, cancelActiveCompletion, requestAiCompletion, hasActiveDiff, aiAutoEnabled, rawFiles, dispatch, activeFile, fileCacheEntries]);
};
