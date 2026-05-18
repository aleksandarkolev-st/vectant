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
    hasActiveDiff,
    aiAutoEnabled = true,
    rawFiles = [],
    dispatch,
    activeFile,
    fileCacheEntries = [],
    // Async fallback for `#include <iostream>` / `#include "..."` references
    // that don't resolve to a workspace file. Returns a synthetic file node
    // (with content already primed in fileCache) ready to dispatch through
    // selectFileThunk, or null on failure. Provided by Editor.jsx; absent in
    // test contexts.
    resolveSystemHeader = null,
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

            // Look for include-style references on this line. Two shapes:
            //   `…"foo.h"…`   → quoted form, usually workspace-relative
            //   `#include <iostream>`  → angle-bracket form, system header
            // We collect both kinds of hits, see which one the cursor is
            // inside, then try a workspace lookup; if the file isn't in the
            // workspace tree we fall through to a `systemInclude` marker so
            // the click handler can resolve it via the LSP.
            const inclusionMatches = [];
            const stringRegex = /["']([^"']+)["']/g;
            let m;
            while ((m = stringRegex.exec(lineContent)) !== null) {
                inclusionMatches.push({
                    importPath: m[1],
                    startCol: m.index + 1,
                    endCol: m.index + m[0].length + 1,
                    isAngleBracket: false,
                });
            }
            // `<...>` only counts as an include when the line begins with
            // `#include` (or its variants like `# include`, `# include  <…>`).
            // Without that gate, expressions like `if (a < b > c)` would
            // false-match and break Ctrl+click on regular code.
            if (/^\s*#\s*include\b/.test(lineContent)) {
                const angleRegex = /<([^<>]+)>/g;
                while ((m = angleRegex.exec(lineContent)) !== null) {
                    inclusionMatches.push({
                        importPath: m[1],
                        startCol: m.index + 1,
                        endCol: m.index + m[0].length + 1,
                        isAngleBracket: true,
                    });
                }
            }

            for (const inc of inclusionMatches) {
                if (position.column < inc.startCol || position.column > inc.endCol) continue;
                const { importPath, startCol, endCol, isAngleBracket } = inc;

                const range = new monacoInstance.Range(
                    position.lineNumber, startCol + 1,
                    position.lineNumber, endCol - 1
                );

                // Workspace lookup — only for the quoted form. Angle-bracket
                // includes go straight to the system resolver: clangd's
                // include search path determines the right answer, and our
                // fileMap probe would either miss or accidentally match a
                // similarly-named workspace file.
                if (!isAngleBracket) {
                    const currentPath = activeFile?.path || '';
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
                        return { kind: 'workspace', node: foundNode, range };
                    }
                }

                // Either an angle-bracket include or a quoted include the
                // workspace doesn't have — defer resolution to the LSP. The
                // click handler awaits resolveSystemHeader; the underline
                // decoration shows immediately so the user gets the same
                // visual affordance as workspace includes.
                return {
                    kind: 'systemInclude',
                    importPath,
                    position: { lineNumber: position.lineNumber, column: position.column },
                    range,
                };
            }

            // Check for symbols (function / class definitions) elsewhere
            // in the workspace.
            const wordInfo = model.getWordAtPosition(position);
            if (wordInfo) {
                const word = wordInfo.word;
                if (!COMMON_KEYWORDS.includes(word)) {
                    const definition = findSymbolDefinition(word);
                    if (definition) {
                        return {
                            kind: 'workspace',
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
                    if (!result) return;
                    event.preventDefault();

                    if (result.kind === 'workspace') {
                        if (result.node.path === activeFile?.path && result.targetLine) {
                            editorInstance.revealLineInCenter(result.targetLine);
                            editorInstance.setPosition({ lineNumber: result.targetLine, column: 1 });
                        } else {
                            dispatch(selectFileThunk(result.node));
                        }
                        return;
                    }

                    if (result.kind === 'systemInclude') {
                        if (typeof resolveSystemHeader !== 'function') {
                            console.warn('[events] system include click but no resolveSystemHeader prop wired');
                            return;
                        }
                        // Capture the model URI now — by the time the LSP
                        // round-trip resolves, the user could have switched
                        // tabs, and editorInstance.getModel() would point at
                        // the wrong document.
                        const modelUri = editorInstance.getModel()?.uri?.toString?.();
                        if (!modelUri) return;
                        Promise.resolve(resolveSystemHeader({
                            importPath: result.importPath,
                            position: result.position,
                            modelUri,
                        })).then((node) => {
                            if (node) dispatch(selectFileThunk(node));
                        }).catch((err) => {
                            console.warn('[events] resolveSystemHeader threw:', err?.message);
                        });
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
                // When AI completions are unavailable (diff mode active or
                // user toggled auto off), wipe any leftover cache so stale
                // ghost text can't linger as the user keeps typing.
                if (hasActiveDiff()) {
                    cancelActiveCompletion({ resetSuggestion: true, reason: 'diff-active' });
                    return;
                }
                if (!aiAutoEnabled) {
                    cancelActiveCompletion({ resetSuggestion: true, reason: 'ai-disabled' });
                    return;
                }

                // AI is active — keep the cache. The consolidated
                // onDidChangeModelContent path in Editor.jsx owns the
                // debounced refresh; this onDidType listener only tears down
                // any in-flight stream so visible ghost text can be re-sliced
                // as the user types along the suggestion.
                cancelActiveCompletion({ resetSuggestion: false, reason: 'typing' });
            }));
            disposables.push(editorInstance.onDidChangeCursorSelection((e) => {
                // Ignore cursor moves that come from normal typing; only cancel if the
                // user actually moves/extends the selection (mouse or keyboard select).
                const source = e?.source;
                const selection = e?.selection;
                const hasSelection = selection && !selection.isEmpty();
                const isMouse = source === 'mouse';

                // Detect a line change between old and new cursor positions.
                // Monaco fires this event for typing too, with source === 'modelChange';
                // we let those pass so the typing handler manages the cache.
                // Keyboard navigation (arrow keys, Page Up/Down, Home/End that
                // crosses a line) lands here with source === 'keyboard' and a
                // different startLineNumber — without this the cached suggestion
                // stays bound to the old line and re-renders if the user bounces
                // back, which the user reads as "completions for another line
                // still showing". computeVisibleSuggestion guards on line, but
                // clearing the cache makes the staleness durable across moves.
                const oldLine = e?.oldSelections?.[0]?.startLineNumber ?? null;
                const newLine = selection?.startLineNumber ?? null;
                const lineChanged = oldLine !== null && newLine !== null && oldLine !== newLine;

                if (isMouse || hasSelection) {
                    cancelActiveCompletion({ resetSuggestion: true, reason: isMouse ? 'cursor-move' : 'selection-change' });
                    return;
                }
                if (lineChanged && source !== 'modelChange') {
                    cancelActiveCompletion({ resetSuggestion: true, reason: 'line-change' });
                }
            }));
        } catch (e) {
            // ignore if monaco is missing APIs
        }

        return () => {
            disposables.forEach((disposable) => disposable?.dispose?.());
        };
    }, [editorInstance, monacoInstance, cancelActiveCompletion, hasActiveDiff, aiAutoEnabled, rawFiles, dispatch, activeFile, fileCacheEntries, resolveSystemHeader]);
};
