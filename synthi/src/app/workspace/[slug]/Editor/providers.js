import { useEffect, useRef } from 'react';
import { CPP_STD_LIBS, COMMON_KEYWORDS } from '@/utils/cppStandardLibrary';
import { resolvePath } from '@/utils/dependencyResolver';

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

const parseSymbols = (content) => {
    const symbols = [];
    if (!content) return symbols;

    // Regex for function definitions/declarations: Type Name(Args)
    // This is a heuristic and won't catch everything, but covers common cases
    // Excludes keywords like 'if', 'while', 'for', 'switch' to avoid false positives
    const functionRegex = /^\s*(?:static\s+|inline\s+|virtual\s+)*([a-zA-Z_][a-zA-Z0-9_]*)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/gm;

    // Regex for classes/structs
    const classRegex = /^\s*(?:class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;

    let match;
    while ((match = functionRegex.exec(content)) !== null) {
        const returnType = match[1];
        const name = match[2];
        if (!COMMON_KEYWORDS.includes(name) && !COMMON_KEYWORDS.includes(returnType)) {
            symbols.push({
                label: name,
                kind: 'Function',
                detail: `${returnType} ${name}(...)`,
                insertText: name
            });
        }
    }

    while ((match = classRegex.exec(content)) !== null) {
        const name = match[1];
        symbols.push({
            label: name,
            kind: 'Class',
            detail: `class ${name}`,
            insertText: name
        });
    }

    return symbols;
};

export const useEditorProviders = ({
    editorInstance,
    monacoInstance,
    activeLanguage,
    aiCompletionState,
    aiCompletionCacheRef,
    aiCompletionCursorRef,
    inlineAcceptCommandIdRef,
    applyAiCompletionText,
    rawFiles = [],
    fileCacheEntries = new Map(),
    activeFile
}) => {
    const hoverProviderRef = useRef(null);
    const inlineCompletionProviderRef = useRef(null);
    const completionProviderRef = useRef(null);

    // Use refs for complex objects to avoid useEffect dependency crashes
    const fileCacheRef = useRef(fileCacheEntries);
    const rawFilesRef = useRef(rawFiles);
    const activeFileRef = useRef(activeFile);

    useEffect(() => {
        fileCacheRef.current = fileCacheEntries;
        rawFilesRef.current = rawFiles;
        activeFileRef.current = activeFile;
    }, [fileCacheEntries, rawFiles, activeFile]);

    // 0. Standard Library & Workspace IntelliSense (C++)
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        // Dispose previous provider if any
        completionProviderRef.current?.dispose();

        if (activeLanguage === 'cpp' || activeLanguage === 'c') {
            completionProviderRef.current = monacoInstance.languages.registerCompletionItemProvider(activeLanguage, {
                triggerCharacters: ['.', ':', '<', '"', '/', '>', ' '],
                provideCompletionItems: async (model, position) => {
                    const fullText = model.getValue();
                    const suggestions = [];

                    // 1. Check for includes
                    const includeRegex = /#include\s+[<"]([^>"]+)[>"]/g;
                    let match;
                    const includedHeaders = new Set();
                    while ((match = includeRegex.exec(fullText)) !== null) {
                        includedHeaders.add(match[1]);
                    }

                    // 2. Add items based on includes (Standard Libs)
                    includedHeaders.forEach(header => {
                        if (CPP_STD_LIBS[header]) {
                            suggestions.push(...CPP_STD_LIBS[header].map(item => ({
                                ...item,
                                kind: monacoInstance.languages.CompletionItemKind[item.kind]
                            })));
                        }
                    });

                    // 3. Workspace Symbols (Cross-file)
                    const fileMap = flattenFiles(rawFilesRef.current);
                    const currentPath = activeFileRef.current?.path || '';

                    for (const header of includedHeaders) {
                        // Skip std libs
                        if (CPP_STD_LIBS[header]) continue;

                        // Resolve path
                        const candidates = [];
                        candidates.push(resolvePath(currentPath, header));
                        if (!header.startsWith('./') && !header.startsWith('../')) {
                            candidates.push(header);
                        }

                        let foundNode = null;
                        for (const candidatePath of candidates) {
                            if (fileMap.has(candidatePath)) {
                                foundNode = fileMap.get(candidatePath);
                                break;
                            }
                        }

                        if (foundNode) {
                            // Try to get content from cache ref
                            let content = null;
                            const cache = fileCacheRef.current;

                            if (cache instanceof Map) {
                                content = cache.get(foundNode.path);
                            } else if (Array.isArray(cache)) {
                                // Handle array of entries (from selectFileCacheEntries)
                                const entry = cache.find(([path]) => path === foundNode.path);
                                if (entry) content = entry[1];
                            } else if (typeof cache === 'object' && cache !== null) {
                                content = cache[foundNode.path];
                            }

                            if (content) {
                                const symbols = parseSymbols(content);
                                suggestions.push(...symbols.map(item => ({
                                    ...item,
                                    kind: monacoInstance.languages.CompletionItemKind[item.kind]
                                })));
                            }
                        }
                    }

                    // 4. Always add common keywords
                    COMMON_KEYWORDS.forEach(kw => {
                        suggestions.push({
                            label: kw,
                            kind: monacoInstance.languages.CompletionItemKind.Keyword,
                            insertText: kw
                        });
                    });

                    return { suggestions };
                }
            });
        }

        return () => {
            completionProviderRef.current?.dispose();
        };
    }, [editorInstance, monacoInstance, activeLanguage]); // Removed complex dependencies

    // 1. Inline Completion Provider (The "Ghost Text")
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        inlineCompletionProviderRef.current?.dispose();

        const provider = monacoInstance.languages.registerInlineCompletionsProvider(activeLanguage, {
            provideInlineCompletions: (model, position) => {
                const cached = aiCompletionCacheRef.current;
                const cursor = aiCompletionCursorRef.current;

                // Only show if we have a suggestion and the cursor hasn't moved far (or is the same)
                if (!cached?.suggestion || !cursor) return { items: [] };

                // Simple validation: line must match
                if (position.lineNumber !== cursor.lineNumber) return { items: [] };

                const visibleText = cached.suggestion;

                return {
                    items: [{
                        insertText: visibleText,
                        range: new monacoInstance.Range(
                            position.lineNumber, position.column,
                            position.lineNumber, position.column
                        ),
                        command: inlineAcceptCommandIdRef.current ? { id: inlineAcceptCommandIdRef.current } : undefined
                    }]
                };
            },
            freeInlineCompletions: () => { },
            // Some Monaco builds call `disposeInlineCompletions` when disposing providers.
            // Add an alias to be defensive across versions to avoid runtime errors.
            disposeInlineCompletions: () => { }
        });
        inlineCompletionProviderRef.current = provider;

        return () => inlineCompletionProviderRef.current?.dispose();
    }, [editorInstance, monacoInstance, activeLanguage, aiCompletionState, aiCompletionCacheRef, aiCompletionCursorRef, inlineAcceptCommandIdRef]);

    // 2. Register Command for Accept
    useEffect(() => {
        if (!editorInstance) return;
        const commandId = editorInstance.addCommand(0, () => {
            const cached = aiCompletionCacheRef.current;
            if (cached?.suggestion) {
                applyAiCompletionText(cached.suggestion);
            }
        });
        inlineAcceptCommandIdRef.current = commandId;
    }, [editorInstance, applyAiCompletionText, aiCompletionCacheRef]);

    // 3. Hover Provider (Diagnostics)
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        hoverProviderRef.current?.dispose();
        // Keep hover provider only for diagnostics; do not surface AI hunks via hover
        hoverProviderRef.current = monacoInstance.languages.registerHoverProvider(activeLanguage, {
            provideHover: (model, position) => {
                // Only return diagnostics (errors/warnings) in hover. AI hunks are shown
                // as persistent widgets in the editor and should not appear in hovers.
                const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
                const hits = markers.filter(m =>
                    position.lineNumber >= m.startLineNumber && position.lineNumber <= m.endLineNumber &&
                    position.column >= m.startColumn && position.column <= m.endColumn
                );
                if (!hits.length) return null;

                const contents = [];
                hits.forEach(m => contents.push({ value: `**${m.severity === 8 ? 'Error' : 'Warning'}**: ${m.message}` }));

                const range = new monacoInstance.Range(hits[0].startLineNumber, hits[0].startColumn, hits[0].endLineNumber, hits[0].endColumn);
                return { range, contents };
            }
        });
        return () => hoverProviderRef.current?.dispose();
    }, [monacoInstance, editorInstance, activeLanguage]);

    // 4. Semantic Tokens (Custom Highlighting for Classes/Types)
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;

        // Only apply for C/C++
        if (activeLanguage !== 'cpp' && activeLanguage !== 'c') return;

        const tokenTypes = ['class', 'struct', 'interface', 'enum', 'function', 'variable', 'parameter', 'comment', 'string', 'keyword', 'number', 'regexp', 'operator'];
        const tokenModifiers = ['declaration', 'readonly', 'static', 'abstract', 'deprecated', 'modification', 'async'];
        const legend = { tokenTypes, tokenModifiers };

        const CPP_KEYWORDS = new Set([
            'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor', 'bool', 'break', 'case', 'catch', 'char', 'char16_t', 'char32_t', 'class', 'compl', 'const', 'constexpr', 'const_cast', 'continue', 'decltype', 'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum', 'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private', 'protected', 'public', 'register', 'reinterpret_cast', 'return', 'short', 'signed', 'sizeof', 'static', 'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq',
            'include', 'define', 'ifdef', 'ifndef', 'endif', 'pragma' // Preprocessor
        ]);

        const provider = monacoInstance.languages.registerDocumentSemanticTokensProvider(activeLanguage, {
            getLegend: () => legend,
            provideDocumentSemanticTokens: (model) => {
                const lines = model.getLinesContent();
                const text = model.getValue();
                
                // Map of Name -> Type Index (0=class, 1=struct, etc)
                const knownTypes = new Map();
                
                // Common std types
                ['string', 'vector', 'map', 'set', 'iostream', 'ostream', 'istream', 'unique_ptr', 'shared_ptr', 'cout', 'cin', 'endl'].forEach(t => knownTypes.set(t, 0));

                // 1. Scan current file for definitions
                const classRegex = /(?:class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
                let match;
                while ((match = classRegex.exec(text)) !== null) {
                    const typeStr = match[0].startsWith('struct') ? 'struct' : 'class';
                    knownTypes.set(match[1], typeStr === 'struct' ? 1 : 0);
                }

                // 2. Scan other cached files for definitions (Global knowledge)
                const cache = fileCacheRef.current;
                if (cache) {
                    const entries = cache instanceof Map ? cache.entries() : (Array.isArray(cache) ? cache : Object.entries(cache));
                    for (const [path, content] of entries) {
                        if (typeof content !== 'string') continue;
                        const globalClassRegex = /(?:class|struct)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gm;
                        while ((match = globalClassRegex.exec(content)) !== null) {
                            const typeStr = match[0].startsWith('struct') ? 'struct' : 'class';
                            knownTypes.set(match[1], typeStr === 'struct' ? 1 : 0);
                        }
                    }
                }

                // 3. Generate Tokens
                const tokens = [];
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const wordRegex = /([a-zA-Z_][a-zA-Z0-9_]*)/g;
                    let wordMatch;
                    while ((wordMatch = wordRegex.exec(line)) !== null) {
                        const word = wordMatch[1];
                        const start = wordMatch.index;

                        if (CPP_KEYWORDS.has(word)) continue;

                        let type = -1;
                        let modifiers = 0;

                        // Check lookahead for function call/def: "name ("
                        const afterWord = line.slice(start + word.length).trim();
                        const isFunction = afterWord.startsWith('(');

                        if (isFunction) {
                            type = 4; // function (index 4 in new list)
                        } else if (knownTypes.has(word)) {
                            type = knownTypes.get(word);
                        } else if (/^[A-Z]/.test(word) && word.length > 1) {
                            // Heuristic: Capitalized = Class
                            type = 0; // class
                        } else {
                            // Default: Variable
                            type = 5; // variable (index 5 in new list)
                        }

                        if (type !== -1) {
                            tokens.push({
                                line: i,
                                start: start,
                                length: word.length,
                                type: type,
                                modifiers: modifiers
                            });
                        }
                    }
                }

                // 4. Encode to Uint32Array
                const data = [];
                let prevLine = 0;
                let prevStart = 0;
                for (const token of tokens) {
                    data.push(
                        token.line - prevLine,
                        prevLine === token.line ? token.start - prevStart : token.start,
                        token.length,
                        token.type,
                        token.modifiers
                    );
                    prevLine = token.line;
                    prevStart = token.start;
                }

                return { data: new Uint32Array(data) };
            },
            releaseDocumentSemanticTokens: () => { }
        });

        return () => provider.dispose();
    }, [editorInstance, monacoInstance, activeLanguage]);
};
