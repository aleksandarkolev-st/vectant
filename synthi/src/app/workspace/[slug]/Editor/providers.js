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
    diagnostics = [], // Proactive analysis diagnostics for quick fixes
    removeDiagnosticByLocation = null, // Callback to remove diagnostic after fix applied
}) => {
    const hoverProviderRef = useRef(null);
    const inlineCompletionProviderRef = useRef(null);
    const completionProviderRef = useRef(null);
    const codeActionProviderRef = useRef(null);
    const fixPreviewDecorationsRef = useRef([]);
    const fixPreviewZoneIdRef = useRef(null);
    const diagnosticsRef = useRef(diagnostics);
    
    // Track pending fix for keyboard shortcuts
    const pendingFixRef = useRef(null); // { fix, range, diagnostic }
    const isPreviewingRef = useRef(false);

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

    // Helper: Apply a fix to the editor
    const applyFix = (fix, range) => {
        if (!editorInstance || !monacoInstance || !fix) return;
        
        const model = editorInstance.getModel();
        if (!model) return;
        
        // Handle both camelCase and snake_case (backend compatibility)
        const text = fix.replacementText ?? fix.replacement_text ?? '';

        // Guard: skip destructive replacements that would delete large content
        const originalText = model.getValueInRange(range);
        if (originalText.length > 0 && text.length === 0 && originalText.length > 50) {
            console.warn('[providers] Skipping destructive fix (would delete', originalText.length, 'chars)');
            return;
        }
        if (originalText.length > 100 && text.length < originalText.length / 4) {
            console.warn('[providers] Skipping suspicious fix:', `(${originalText.length} chars → ${text.length} chars)`);
            return;
        }
        // Guard: reject edits that span more than half the file
        const totalLines = model.getLineCount();
        const editSpan = range.endLineNumber - range.startLineNumber + 1;
        if (totalLines > 3 && editSpan > totalLines * 0.5) {
            console.warn('[providers] Skipping fix that spans', editSpan, 'of', totalLines, 'lines');
            return;
        }

        // Save cursor + scroll so the edit doesn't jump the user
        const savedPos = editorInstance.getPosition();
        const savedScrollTop = editorInstance.getScrollTop();
        const savedScrollLeft = editorInstance.getScrollLeft();

        // Apply the fix as an edit
        editorInstance.executeEdits('synthi-quick-fix', [{
            range: range,
            text: text,
            forceMoveMarkers: true,
        }]);
        
        // Restore cursor + scroll
        if (savedPos) editorInstance.setPosition(savedPos);
        editorInstance.setScrollTop(savedScrollTop);
        editorInstance.setScrollLeft(savedScrollLeft);

        // Post-edit safety: undo if model is nearly empty after the fix
        const afterContent = model.getValue();
        if (afterContent.length < 5 && originalText.length > 20) {
            console.error('[providers] ABORT: model nearly empty after fix, triggering undo');
            editorInstance.trigger('synthi-quick-fix', 'undo', null);
            return;
        }

        // Clear pending fix state
        pendingFixRef.current = null;
        isPreviewingRef.current = false;
        hideFixPreview();
    };
    
    // Helper: Show fix preview ABOVE the error line - just the code, clean and simple
    const showFixPreview = (fix, range) => {
        if (!editorInstance || !monacoInstance) return;
        
        // Clear existing preview
        hideFixPreview();
        
        const model = editorInstance.getModel();
        if (!model) return;
        
        // Handle both camelCase and snake_case (backend compatibility)
        const replacementText = fix.replacementText ?? fix.replacement_text ?? '';
        const isDelete = replacementText === '';
        
        if (isDelete) return; // Don't show preview for deletions
        
        isPreviewingRef.current = true;
        
        // Get indentation from the original line
        const originalLine = model.getLineContent(range.startLineNumber);
        const indentMatch = originalLine.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1] : '';
        
        // Show the replacement code ABOVE the line - just the code
        const viewZone = {
            afterLineNumber: range.startLineNumber - 1,
            heightInLines: replacementText.split('\n').length,
            domNode: document.createElement('div'),
            suppressMouseDown: true,
        };
        
        viewZone.domNode.className = 'synthi-fix-preview-code-above';
        
        // Just show the code with proper indentation
        const escapedCode = replacementText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        viewZone.domNode.innerHTML = `<span class="synthi-fix-indent">${indent}</span><span class="synthi-fix-code">${escapedCode}</span>`;
        
        editorInstance.changeViewZones((accessor) => {
            const zoneId = accessor.addZone(viewZone);
            fixPreviewZoneIdRef.current = zoneId;
        });
        
        // Strikethrough the old code
        fixPreviewDecorationsRef.current = editorInstance.deltaDecorations(
            fixPreviewDecorationsRef.current,
            [{
                range: range,
                options: {
                    inlineClassName: 'synthi-fix-preview-strikethrough',
                },
            }]
        );
    };
    
    const hideFixPreview = () => {
        if (fixPreviewDecorationsRef.current.length > 0 && editorInstance) {
            editorInstance.deltaDecorations(fixPreviewDecorationsRef.current, []);
            fixPreviewDecorationsRef.current = [];
        }
        if (fixPreviewZoneIdRef.current !== null && editorInstance) {
            editorInstance.changeViewZones((accessor) => {
                accessor.removeZone(fixPreviewZoneIdRef.current);
            });
            fixPreviewZoneIdRef.current = null;
        }
        isPreviewingRef.current = false;
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
        
        // Configure editor to show hover BELOW the line
        editorInstance.updateOptions({
            hover: {
                above: false, // Force hover to appear below
                delay: 300,
            }
        });
        
        hoverProviderRef.current = monacoInstance.languages.registerHoverProvider(activeLanguage, {
            provideHover: (model, position) => {
                // Find markers at this position
                const markers = monacoInstance.editor.getModelMarkers({ resource: model.uri });
                const hits = markers.filter(m =>
                    position.lineNumber >= m.startLineNumber && position.lineNumber <= m.endLineNumber &&
                    position.column >= m.startColumn && position.column <= m.endColumn
                );
                
                // Always clear preview when hover position changes
                hideFixPreview();
                isPreviewingRef.current = false;
                
                if (!hits.length) {
                    pendingFixRef.current = null;
                    return null;
                }

                const contents = [];
                const currentDiagnostics = diagnosticsRef.current || [];
                
                // Find matching diagnostics with fixes
                let firstFixDiagnostic = null;
                let firstFixRange = null;
                
                for (const m of hits) {
                    // Find diagnostic with fixes for this marker
                    if (!firstFixDiagnostic) {
                        const matchingDiag = currentDiagnostics.find(d => {
                            if (!d.fixes?.length) return false;
                            
                            const loc = d.location || {};
                            // Check if line matches (loc.line is 0-indexed, m.startLineNumber is 1-indexed)
                            const lineMatches = loc.line === m.startLineNumber - 1;
                            if (!lineMatches) return false;
                            
                            // Strategy 1: Match by diagnostic code (most reliable)
                            // marker.code = "AIDES", diagnostic.code = "AIDES"
                            if (m.code && d.code && m.code === d.code) return true;
                            
                            // Strategy 2: Match by source + code combo
                            if (m.source && d.source && m.source === d.source && m.code === d.code) return true;
                            
                            // Strategy 3: Flexible message matching (fallback)
                            // Monaco marker message has format: "[AI] actual message" or "actual message"
                            // Diagnostic message is just: "actual message"
                            const diagMsg = (d.message || '').toLowerCase().trim();
                            const markerMsg = (m.message || '').toLowerCase().trim();
                            // Strip tier prefix like [AI], [STATIC], etc from marker message
                            const cleanMarkerMsg = markerMsg.replace(/^\[[^\]]+\]\s*/i, '');
                            // Also strip confidence suffix like "(85% confidence)"
                            const cleanDiagMsg = diagMsg.replace(/\s*\(\d+%\s*confidence\)\s*$/i, '').trim();
                            const cleanMarkerMsgNoConf = cleanMarkerMsg.replace(/\s*\(\d+%\s*confidence\)\s*$/i, '').trim();
                            // Also strip any trailing explanation (after double newline)
                            const baseMarkerMsg = cleanMarkerMsgNoConf.split('\n\n')[0].trim();
                            const baseDiagMsg = cleanDiagMsg.split('\n\n')[0].trim();
                            
                            return baseMarkerMsg === baseDiagMsg ||
                                   baseMarkerMsg.includes(baseDiagMsg) || 
                                   baseDiagMsg.includes(baseMarkerMsg);
                        });
                        
                        if (matchingDiag?.fixes?.length > 0) {
                            firstFixDiagnostic = matchingDiag;
                            // Use the fix's own location if available (it has the correct
                            // replacement span), otherwise fall back to the marker range.
                            const fixLoc = matchingDiag.fixes[0]?.location;
                            if (fixLoc) {
                                firstFixRange = new monacoInstance.Range(
                                    (fixLoc.line ?? 0) + 1,
                                    (fixLoc.column ?? 0) + 1,
                                    (fixLoc.endLine ?? fixLoc.line ?? 0) + 1,
                                    (fixLoc.endColumn ?? fixLoc.column ?? 0) + 1
                                );
                            } else {
                                firstFixRange = new monacoInstance.Range(
                                    m.startLineNumber, m.startColumn,
                                    m.endLineNumber, m.endColumn
                                );
                            }
                        }
                    }
                }
                
                // Show fix info with keyboard shortcuts
                if (firstFixDiagnostic && firstFixRange) {
                    const fix = firstFixDiagnostic.fixes[0];
                    
                    // Store pending fix for keyboard shortcuts
                    pendingFixRef.current = { fix, range: firstFixRange, diagnostic: firstFixDiagnostic };
                    
                    contents.push({ value: '\n\n**💡 Quick Fix Available**\n\nPress `Tab` to apply fix immediately.' });
                    
                    // Show preview immediately while hovering
                    showFixPreview(fix, firstFixRange);
                }

                const range = new monacoInstance.Range(
                    hits[0].startLineNumber, hits[0].startColumn,
                    hits[0].endLineNumber, hits[0].endColumn
                );
                return { range, contents };
            }
        });
        
        // Add keyboard shortcut for applying fix (Tab)
        // Add Ctrl+Shift+. for preview toggle
        const keyDownDisposable = editorInstance.onKeyDown((e) => {
            const pending = pendingFixRef.current;
            if (!pending) return;
            
            // Tab = Apply fix immediately
            if (e.code === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                
                const { fix, range, diagnostic } = pending;
                const model = editorInstance.getModel();
                if (!model) return;
                
                // Apply the fix (handle both camelCase and snake_case from backend)
                const fixText = fix.replacementText ?? fix.replacement_text ?? '';
                editorInstance.executeEdits('synthi-quick-fix', [{
                    range: range,
                    text: fixText,
                    forceMoveMarkers: true,
                }]);
                
                // Clear pending fix state
                pendingFixRef.current = null;
                isPreviewingRef.current = false;
                hideFixPreview();
                
                // Remove the diagnostic from state immediately
                if (removeDiagnosticByLocation && diagnostic.location) {
                    removeDiagnosticByLocation(diagnostic.location);
                }
                
                return;
            }
            
            // Ctrl+Shift+. = Toggle preview
            if (e.ctrlKey && e.shiftKey && e.code === 'Period') {
                e.preventDefault();
                e.stopPropagation();
                
                if (isPreviewingRef.current) {
                    hideFixPreview();
                    isPreviewingRef.current = false;
                } else {
                    showFixPreview(pending.fix, pending.range);
                }
                return;
            }
        });
        
        // Hide preview when cursor moves away from the diagnostic line
        const cursorListener = editorInstance.onDidChangeCursorPosition((e) => {
            const pending = pendingFixRef.current;
            if (!pending) return;
            
            // Clear preview when cursor moves to a different line
            if (e.position.lineNumber !== pending.range.startLineNumber) {
                pendingFixRef.current = null;
                hideFixPreview();
                isPreviewingRef.current = false;
            }
        });
        
        // Clear pending fix when typing (content changes)
        const contentListener = editorInstance.onDidChangeModelContent(() => {
            pendingFixRef.current = null;
            hideFixPreview();
            isPreviewingRef.current = false;
        });
        
        // Hide preview when mouse leaves the editor
        // NOTE: Do NOT clear pendingFixRef here — keep the fix available
        // for Tab as long as the cursor stays on the diagnostic line.
        // The cursorListener above handles clearing when the cursor moves away.
        const editorDomNode = editorInstance.getDomNode();
        const handleMouseLeave = () => {
            // Larger delay — let the user move to the hover widget
            setTimeout(() => {
                const hoverWidget = document.querySelector('.monaco-hover');
                if (!hoverWidget || !hoverWidget.matches(':hover')) {
                    hideFixPreview();
                    // Keep pendingFixRef alive — Tab still works while cursor is on the line
                }
            }, 300);
        };
        editorDomNode?.addEventListener('mouseleave', handleMouseLeave);
        
        return () => {
            hoverProviderRef.current?.dispose();
            keyDownDisposable?.dispose();
            cursorListener?.dispose();
            contentListener?.dispose();
            editorDomNode?.removeEventListener('mouseleave', handleMouseLeave);
        };
    }, [monacoInstance, editorInstance, activeLanguage]);

    // 4. Code Action Provider (Quick Fixes with Preview)
    useEffect(() => {
        if (!editorInstance || !monacoInstance) return;
        codeActionProviderRef.current?.dispose();
        
        // Track seen fixes to avoid duplicates
        const seenFixes = new Set();
        
        // Register command to apply fix
        const applyFixCommandId = editorInstance.addCommand(0, (ctx, fix, range, diagnosticLocation) => {
            applyFix(fix, range);
            
            // IMPORTANT: Remove the diagnostic from state immediately
            // This prevents the error from persisting after the fix is applied
            if (removeDiagnosticByLocation && diagnosticLocation) {
                removeDiagnosticByLocation(diagnosticLocation);
            }
        });
        
        // Helper to find diagnostics for a given marker
        // Uses code-based matching first (most reliable), then range overlap as fallback
        const getDiagnosticsForMarker = (marker) => {
            const currentDiagnostics = diagnosticsRef.current || [];
            const startLine = marker.startLineNumber - 1;
            const startCol = marker.startColumn - 1;
            const endLine = marker.endLineNumber - 1;
            const endCol = marker.endColumn - 1;
            
            // Strategy 1: Match by code + line (most reliable for AIDES, AILOG, etc.)
            const codeMatches = currentDiagnostics.filter(d => {
                if (!d.fixes?.length) return false;
                const loc = d.location || {};
                const lineMatches = loc.line === startLine;
                return lineMatches && marker.code && d.code && marker.code === d.code;
            });
            if (codeMatches.length > 0) return codeMatches;
            
            // Strategy 2: Range overlap (fallback)
            return currentDiagnostics.filter(d => {
                if (!d.fixes?.length) return false;
                const loc = d.location || {};
                const dLine = loc.line ?? 0;
                const dCol = loc.column ?? 0;
                const dEndLine = loc.endLine ?? dLine;
                const dEndCol = loc.endColumn ?? dCol;
                
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
                    const matchingDiagnostics = getDiagnosticsForMarker(marker);
                    
                    for (const diagnostic of matchingDiagnostics) {
                        if (!diagnostic.fixes?.length) continue;
                        
                        for (const fix of diagnostic.fixes) {
                            // Handle both camelCase and snake_case (backend compatibility)
                            const text = fix.replacementText ?? fix.replacement_text ?? '';

                            // Create a unique key for this fix to avoid duplicates
                            const fixKey = `${fix.description}:${text}:${fix.location?.line}`;
                            if (seenFixes.has(fixKey)) continue;
                            seenFixes.add(fixKey);
                            
                            const fixRange = new monacoInstance.Range(
                                (fix.location?.line ?? (marker.startLineNumber - 1)) + 1,
                                (fix.location?.column ?? (marker.startColumn - 1)) + 1,
                                (fix.location?.endLine ?? (marker.endLineNumber - 1)) + 1,
                                (fix.location?.endColumn ?? (marker.endColumn - 1)) + 1
                            );
                            
                            // Store the fix info for preview triggering
                            const fixInfo = { fix, range: fixRange, diagnostic };
                            
                            // Store the diagnostic location for clearing after fix
                            const diagnosticLocation = diagnostic.location;
                            
                            // Add the apply fix action using command instead of edit
                            // (Monaco's WorkspaceEdit format has compatibility issues)
                            actions.push({
                                title: fix.description || 'Apply fix',
                                kind: 'quickfix',
                                diagnostics: [marker],
                                isPreferred: fix.isPreferred || false,
                                command: {
                                    id: applyFixCommandId,
                                    title: fix.description || 'Apply fix',
                                    arguments: [fix, fixRange, diagnosticLocation],
                                },
                            });
                        }
                    }
                }
                
                return { actions, dispose: () => {} };
            },
        });
        
        // Register command to show fix preview
        const previewCommandDisposable = editorInstance.addCommand(0, (ctx, fixInfo) => {
            if (fixInfo?.fix && fixInfo?.range) {
                pendingFixRef.current = fixInfo;
                showFixPreview(fixInfo.fix, fixInfo.range);
            }
        }, 'synthi.showFixPreview');
        
        return () => {
            codeActionProviderRef.current?.dispose();
        };
    }, [monacoInstance, editorInstance, activeLanguage, removeDiagnosticByLocation]);

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
