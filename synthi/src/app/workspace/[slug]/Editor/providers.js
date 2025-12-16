import { useEffect, useRef } from 'react';

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
    activeFile,
    lspReady = false,
    diagnostics = [] // Proactive analysis diagnostics for quick fixes
}) => {
    const hoverProviderRef = useRef(null);
    const inlineCompletionProviderRef = useRef(null);
    const completionProviderRef = useRef(null);
    const codeActionProviderRef = useRef(null);
    const fixPreviewDecorationsRef = useRef([]);
    const fixPreviewWidgetRef = useRef(null);
    const diagnosticsRef = useRef(diagnostics);

    // Use refs for complex objects to avoid useEffect dependency crashes
    const fileCacheRef = useRef(fileCacheEntries);
    const rawFilesRef = useRef(rawFiles);
    const activeFileRef = useRef(activeFile);

    useEffect(() => {
        fileCacheRef.current = fileCacheEntries;
        rawFilesRef.current = rawFiles;
        activeFileRef.current = activeFile;
        diagnosticsRef.current = diagnostics;
    }, [fileCacheEntries, rawFiles, activeFile, diagnostics]);

    // 0. Standard Library & Workspace IntelliSense (C++) - REMOVED
    // We rely entirely on the LSP server for IntelliSense.
    useEffect(() => {
        completionProviderRef.current?.dispose();
    }, [editorInstance, monacoInstance]);

    // Helper: Show inline fix preview
    const showFixPreview = (fix, range) => {
        if (!editorInstance || !monacoInstance) return;
        
        // Clear existing preview
        hideFixPreview();
        
        const model = editorInstance.getModel();
        if (!model) return;
        
        // Get original text that would be replaced
        const originalText = model.getValueInRange(range);
        const replacementText = fix.replacementText || '';
        
        // Skip if same content or empty replacement
        if (originalText === replacementText || !replacementText) return;
        
        // Create DOM node once (must be cached for Monaco content widgets)
        const domNode = document.createElement('div');
        domNode.className = 'synthi-fix-preview-container';
        domNode.style.zIndex = '9999';
        domNode.style.position = 'relative';
        domNode.innerHTML = `
            <div class="synthi-fix-preview-header">
                <span class="synthi-fix-preview-icon">💡</span>
                <span>Suggested Fix Preview</span>
            </div>
            <div class="synthi-fix-preview-content">
                <div class="synthi-fix-preview-old">
                    <span class="synthi-fix-label">Current:</span>
                    <code>${escapeHtml(originalText.split('\n').slice(0, 5).join('\n'))}</code>
                </div>
                <div class="synthi-fix-preview-arrow">→</div>
                <div class="synthi-fix-preview-new">
                    <span class="synthi-fix-label">After fix:</span>
                    <code>${escapeHtml(replacementText.split('\n').slice(0, 5).join('\n'))}</code>
                </div>
            </div>
        `;

        // Create content widget with cached DOM node
        const widgetId = 'synthi-fix-preview-widget';
        const widget = {
            getId: () => widgetId,
            getDomNode: () => domNode, // Return cached node
            getPosition: () => ({
                position: { lineNumber: range.endLineNumber + 1, column: 1 },
                preference: [
                    monacoInstance.editor.ContentWidgetPositionPreference.BELOW,
                    monacoInstance.editor.ContentWidgetPositionPreference.ABOVE,
                ],
            }),
        };
        
        editorInstance.addContentWidget(widget);
        fixPreviewWidgetRef.current = widget;
    };
    
    const hideFixPreview = () => {
        if (fixPreviewWidgetRef.current && editorInstance) {
            try {
                editorInstance.removeContentWidget(fixPreviewWidgetRef.current);
            } catch (e) {
                // Widget may already be removed
            }
            fixPreviewWidgetRef.current = null;
        }
        if (fixPreviewDecorationsRef.current.length > 0 && editorInstance) {
            editorInstance.deltaDecorations(fixPreviewDecorationsRef.current, []);
            fixPreviewDecorationsRef.current = [];
        }
    };
    
    // Helper: Escape HTML for safe display
    const escapeHtml = (str) => {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    };

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
    }, [editorInstance, applyAiCompletionText, aiCompletionCacheRef, inlineAcceptCommandIdRef]);

    // 3. Hover Provider (Diagnostics with Fix Preview)
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        hoverProviderRef.current?.dispose();
        
        // Track current hover to show fix preview
        let hoverTimeout = null;
        
        hoverProviderRef.current = monacoInstance.languages.registerHoverProvider(activeLanguage, {
            provideHover: (model, position) => {
                // Clear any pending preview
                if (hoverTimeout) clearTimeout(hoverTimeout);
                hideFixPreview();
                
                // Find markers at this position
                const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
                const hits = markers.filter(m =>
                    position.lineNumber >= m.startLineNumber && position.lineNumber <= m.endLineNumber &&
                    position.column >= m.startColumn && position.column <= m.endColumn
                );
                if (!hits.length) return null;

                const contents = [];
                const currentDiagnostics = diagnosticsRef.current || [];
                
                // Find matching diagnostics with fixes
                let firstFixDiagnostic = null;
                let firstFixRange = null;
                
                for (const m of hits) {
                    const severity = m.severity === 8 ? 'Error' : m.severity === 4 ? 'Warning' : 'Info';
                    contents.push({ value: `**${severity}**: ${m.message}` });
                    
                    // Find diagnostic with fixes for this marker
                    if (!firstFixDiagnostic) {
                        const matchingDiag = currentDiagnostics.find(d => {
                            const loc = d.location || {};
                            // Check if line matches (loc.line is 0-indexed, m.startLineNumber is 1-indexed)
                            const lineMatches = loc.line === m.startLineNumber - 1;
                            // Check if message matches (flexible matching)
                            const msgMatches = m.message.includes(d.message) || d.message.includes(m.message) || 
                                               m.message.toLowerCase() === d.message.toLowerCase();
                            // Must have fixes
                            return d.fixes?.length > 0 && lineMatches && msgMatches;
                        });
                        
                        if (matchingDiag?.fixes?.length > 0) {
                            firstFixDiagnostic = matchingDiag;
                            firstFixRange = new monacoInstance.Range(
                                m.startLineNumber, m.startColumn,
                                m.endLineNumber, m.endColumn
                            );
                        }
                    }
                }
                
                // Show fix preview after a short delay
                if (firstFixDiagnostic && firstFixRange) {
                    const fix = firstFixDiagnostic.fixes[0];
                    contents.push({ value: '\n---' });
                    contents.push({ value: `💡 **Quick Fix Available**: ${fix.description || 'Apply fix'}` });
                    contents.push({ value: '_Click the lightbulb or press Ctrl+. to apply_' });
                    
                    // Show inline preview widget after delay
                    hoverTimeout = setTimeout(() => {
                        showFixPreview(fix, firstFixRange);
                    }, 500);
                }

                const range = new monacoInstance.Range(
                    hits[0].startLineNumber, hits[0].startColumn,
                    hits[0].endLineNumber, hits[0].endColumn
                );
                return { range, contents };
            }
        });
        
        // Hide preview when cursor moves significantly away
        let hideTimeout = null;
        const cursorListener = editorInstance.onDidChangeCursorPosition((e) => {
            if (hoverTimeout) clearTimeout(hoverTimeout);
            // Only hide if cursor moves to a different line
            if (hideTimeout) clearTimeout(hideTimeout);
            hideTimeout = setTimeout(() => hideFixPreview(), 500);
        });
        
        // Also hide on scroll
        const scrollListener = editorInstance.onDidScrollChange(() => {
            if (hoverTimeout) clearTimeout(hoverTimeout);
            hideFixPreview();
        });
        
        return () => {
            hoverProviderRef.current?.dispose();
            cursorListener?.dispose();
            scrollListener?.dispose();
            if (hoverTimeout) clearTimeout(hoverTimeout);
            if (hideTimeout) clearTimeout(hideTimeout);
        };
    }, [monacoInstance, editorInstance, activeLanguage]);

    // 4. Code Action Provider (Quick Fixes with Preview)
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        codeActionProviderRef.current?.dispose();
        
        // Track seen fixes to avoid duplicates
        const seenFixes = new Set();
        
        // Helper to find diagnostics for a given range
        const getDiagnosticsForRange = (startLine, startCol, endLine, endCol) => {
            const currentDiagnostics = diagnosticsRef.current || [];
            return currentDiagnostics.filter(d => {
                const loc = d.location || {};
                const dLine = loc.line ?? 0;
                const dCol = loc.column ?? 0;
                const dEndLine = loc.endLine ?? dLine;
                const dEndCol = loc.endColumn ?? dCol;
                
                // Check if ranges overlap
                return !(dEndLine < startLine || dLine > endLine || 
                        (dLine === endLine && dEndCol < startCol) ||
                        (dEndLine === startLine && dCol > endCol));
            });
        };
        
        codeActionProviderRef.current = monacoInstance.languages.registerCodeActionProvider(activeLanguage, {
            provideCodeActions: (model, range, context, token) => {
                const actions = [];
                const markers = context.markers || [];
                seenFixes.clear(); // Reset for each invocation
                
                for (const marker of markers) {
                    // Find matching diagnostic with fixes
                    const matchingDiagnostics = getDiagnosticsForRange(
                        marker.startLineNumber - 1,
                        marker.startColumn - 1,
                        marker.endLineNumber - 1,
                        marker.endColumn - 1
                    );
                    
                    for (const diagnostic of matchingDiagnostics) {
                        if (!diagnostic.fixes?.length) continue;
                        
                        for (const fix of diagnostic.fixes) {
                            // Create a unique key for this fix to avoid duplicates
                            const fixKey = `${fix.description}:${fix.replacementText}:${fix.location?.line}`;
                            if (seenFixes.has(fixKey)) continue;
                            seenFixes.add(fixKey);
                            
                            const fixRange = new monacoInstance.Range(
                                (fix.location?.line ?? (marker.startLineNumber - 1)) + 1,
                                (fix.location?.column ?? (marker.startColumn - 1)) + 1,
                                (fix.location?.endLine ?? (marker.endLineNumber - 1)) + 1,
                                (fix.location?.endColumn ?? (marker.endColumn - 1)) + 1
                            );
                            
                            actions.push({
                                title: fix.description || 'Apply fix',
                                kind: 'quickfix',
                                diagnostics: [marker],
                                isPreferred: fix.isPreferred || false,
                                edit: {
                                    edits: [{
                                        resource: model.uri,
                                        versionId: undefined,
                                        textEdit: {
                                            range: fixRange,
                                            text: fix.replacementText || '',
                                        },
                                    }],
                                },
                            });
                        }
                    }
                }
                
                return { actions, dispose: () => {} };
            },
        });
        
        return () => codeActionProviderRef.current?.dispose();
    }, [monacoInstance, editorInstance, activeLanguage]);

    // 5. Semantic Tokens (Custom Highlighting for Classes/Types)
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
    
    // Cleanup fix preview on unmount
    useEffect(() => {
        return () => {
            hideFixPreview();
        };
    }, [editorInstance]);
};
