'use client';

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Send, X, Plus, ChevronDown, ChevronRight, Sparkles, FileCode, Paperclip, Link, Unlink } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppDispatch, useAppSelector, useAppStore } from '@/redux/hooks';
import { selectFileThunk } from '@/redux/workspaceSlice';
import { setShowTerminal } from '@/redux/uiSlice';
import { findFileInTree } from '@/utils/fileUtils';
import { useChatSessions } from './hooks/useChatSessions';
import { useChatInput } from './hooks/useChatInput';
import { useAISuggestions } from './hooks/useAISuggestions';
import { useCodeIntelMetrics } from '@/hooks/useCodeIntelMetrics';
import { useChatAttachments } from './hooks/useChatAttachments';
import { renderDiffChunkList, diffStats } from './utils/diffUtils';
import { fileSuggestionStatusClasses, fileSuggestionStatusLabel } from './utils/fileSuggestionsUtils';
import { formatMessageContent } from './utils/formatMessage';
import MessageContent from './utils/MessageContent';
import { ThinkingDots } from './ThinkingDots';
import CommandApprovalCard from './CommandApprovalCard';

const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const buildLanguageMeta = (filename = '') => {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const map = {
        js: { label: 'JS', color: '#fcd34d' },
        jsx: { label: 'JSX', color: '#fcd34d' },
        ts: { label: 'TS', color: '#60a5fa' },
        tsx: { label: 'TSX', color: '#60a5fa' },
        json: { label: 'JSON', color: '#c084fc' },
        md: { label: 'MD', color: '#a78bfa' },
        txt: { label: 'TXT', color: '#a3a3a3' },
        py: { label: 'PY', color: '#f59e0b' },
        rb: { label: 'RB', color: '#ef4444' },
        go: { label: 'GO', color: '#38bdf8' },
        rs: { label: 'RS', color: '#f97316' },
        java: { label: 'JAVA', color: '#ef4444' },
        cpp: { label: 'C++', color: '#60a5fa' },
        c: { label: 'C', color: '#60a5fa' },
        cs: { label: 'C#', color: '#22c55e' },
        php: { label: 'PHP', color: '#a78bfa' },
        html: { label: 'HTML', color: '#f97316' },
        css: { label: 'CSS', color: '#60a5fa' },
        scss: { label: 'SCSS', color: '#ec4899' },
        yml: { label: 'YML', color: '#cbd5e1' },
        yaml: { label: 'YAML', color: '#cbd5e1' },
        sql: { label: 'SQL', color: '#22c55e' },
        prisma: { label: 'DB', color: '#22c55e' },
        sh: { label: 'SH', color: '#4ade80' },
        bash: { label: 'SH', color: '#4ade80' },
        toml: { label: 'TOML', color: '#cbd5e1' },
        xml: { label: 'XML', color: '#f97316' },
        svg: { label: 'SVG', color: '#f97316' },
        mjs: { label: 'MJS', color: '#fcd34d' },
        cjs: { label: 'CJS', color: '#fcd34d' },
    };
    return map[ext] || { label: ext ? ext.toUpperCase().slice(0, 4) : 'FILE', color: '#9ba2b8' };
};

const summarizeLog = (logs = []) => {
    if (!Array.isArray(logs) || logs.length === 0) return '';
    const pick = () => {
        const nonMeta = logs.filter((l) => l && !/^working/i.test(l));
        if (nonMeta.length) return nonMeta[nonMeta.length - 1];
        return logs[logs.length - 1];
    };
    const base = pick() || '';
    const sentence = base.split(/[\.\n]/).find((s) => s.trim()) || base;
    const trimmed = sentence.trim();
    if (trimmed.length <= 140) return trimmed;
    return `${trimmed.slice(0, 137)}...`;
};

const AIChatWindow = ({
    onClose,
    isVisible = true,
    activeFile,
    currentCode,
    getCurrentCode = null,
    editor = null,
    docked = false,
    onSuggest = null,
    onBusy = null,
    clearSignal = 0,
    initialPrompt = null,
    initialAttachments = null,
}) => {
    const scrollRef = useRef(null);
    const fileInputRef = useRef(null);
    const dispatch = useAppDispatch();
    const store = useAppStore();
    const fileCacheEntriesRef = useRef([]);
    const workspaceSlug = useAppSelector((state) => state.workspace.slug);
    const rawFiles = useAppSelector((state) => state.workspace.rawFiles || []);

    useEffect(() => {
        const syncFileCacheEntries = () => {
            const cache = store.getState()?.workspace?.fileContentCache;
            fileCacheEntriesRef.current = cache && typeof cache.entries === 'function'
                ? Array.from(cache.entries())
                : [];
        };

        syncFileCacheEntries();
        return store.subscribe(syncFileCacheEntries);
    }, [store]);

    const getFileCacheEntries = useCallback(() => fileCacheEntriesRef.current, []);
    const { metrics: codeIntelMetrics, isLoading: isMetricsLoading, error: metricsError, refresh: refreshMetrics } = useCodeIntelMetrics({
        workspacePath: workspaceSlug,
        slug: workspaceSlug,
        enabled: isVisible,
        fallbackPollMs: 120000,
    });

    const {
        chatSessions,
        activeSession,
        activeSessionId,
        setActiveSessionId,
        mutateSession,
        appendMessagesToSession,
        handleNewSession,
        handleCloseSession,
        resetSuggestionsForSession,
    } = useChatSessions();

    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [modelChoice, setModelChoice] = useState('gemini');
    const [customModel, setCustomModel] = useState('');
    const [customApiKey, setCustomApiKey] = useState('');
    const [isThinking, setIsThinking] = useState(false);
    const [streamingMessage, setStreamingMessage] = useState('');
    const [controller, setController] = useState(null);
    const [showThinking, setShowThinking] = useState(false);
    const thinkingStartRef = useRef(0);
    const [progressLog, setProgressLog] = useState([]);
    const [progressExpanded, setProgressExpanded] = useState(true);
    const [progressStatus, setProgressStatus] = useState('');
    const [suggestionExpanded, setSuggestionExpanded] = useState(false);
    const [collapsedFiles, setCollapsedFiles] = useState({});
    const scrollLockRef = useRef(false);
    const [agentMenuOpen, setAgentMenuOpen] = useState(false);
    const [pendingCommands, setPendingCommands] = useState([]); // {id, command, status: 'pending'|'approved'|'rejected'}
    const [contextFileAttached, setContextFileAttached] = useState(false); // active file NOT auto-attached as context

    useEffect(() => {
        try {
            const savedChoice = localStorage.getItem('synthi-ai-model-choice');
            const savedModel = localStorage.getItem('synthi-ai-custom-model');
            const savedKey = localStorage.getItem('synthi-ai-custom-api-key');
            if (savedChoice) setModelChoice(savedChoice);
            if (savedModel) setCustomModel(savedModel);
            if (savedKey) setCustomApiKey(savedKey);
        } catch (e) { }
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem('synthi-ai-model-choice', modelChoice);
            localStorage.setItem('synthi-ai-custom-model', customModel);
            if (customApiKey) {
                localStorage.setItem('synthi-ai-custom-api-key', customApiKey);
            }
        } catch (e) { }
    }, [modelChoice, customModel, customApiKey]);

    const effectiveModel = modelChoice === 'custom' && customModel.trim() ? customModel.trim() : null;
    const effectiveApiKey = modelChoice === 'custom' && customApiKey.trim() ? customApiKey.trim() : null;

    const {
        isLoading,
        clientReady,
        fileSuggestions,
        suggestedCode,
        diffChunks,
        handleSendMessage,
        applySuggestion,
        rejectSuggestion,
        handleApplyFileSuggestion,
        handleRejectFileSuggestion,
        handlePreviewFileSuggestion,
        // Agent pipeline
        agentMode,
        setAgentMode,
        activePipeline,
        cancelPipeline,
        // Context window
        contextWindowInfo,
    } = useAISuggestions({
        activeSession,
        chatSessions,
        mutateSession,
        appendMessagesToSession,
        resetSuggestionsForSession,
        activeFile,
        currentCode,
        getCurrentCode,
        editor,
        onSuggest,
        onBusy,
        clearSignal,
        getFileCacheEntries,
        workspaceSlug,
        rawFiles,
        dispatch,
        aiModel: effectiveModel,
        aiApiKey: effectiveApiKey,
    });

    const {
        attachments,
        isDragging,
        handleFilesSelected,
        handleDrop,
        handleDragOver,
        handleDragLeave,
        handlePaste,
        removeAttachment,
        clearAttachments,
        formatBytes,
        addWorkspaceFiles,
    } = useChatAttachments({ getFileCacheEntries, rawFiles });

    const { inputValue, setInputValue, handleKeyPress, handleSubmit } = useChatInput((value) => {
        const aborter = new AbortController();
        // Abort any in-flight request before starting a new one
        if (controller) {
            try { controller.abort(); } catch (e) { }
        }
        thinkingStartRef.current = Date.now();
        setController(aborter);
        setStreamingMessage('');
        setIsThinking(true);
        setProgressLog([{ id: Date.now(), text: 'Working…' }]);
        setProgressStatus('Working…');
        setProgressExpanded(true);
        setSuggestionExpanded(false);
        setPendingCommands([]);
        handleSendMessage(value, attachments, {
            includeActiveFile: contextFileAttached,
            controller: aborter,
            onStreamStart: () => setIsThinking(true),
            onFirstToken: () => {
                const elapsed = Date.now() - thinkingStartRef.current;
                const delay = Math.max(0, 150 - elapsed);
                setTimeout(() => setIsThinking(false), delay);
            },
            onChunk: (text) => setStreamingMessage(text),
            onDone: () => {
                setController(null);
                setStreamingMessage('');
                setIsThinking(false);
                setProgressStatus('Finished working');
                setProgressExpanded(false);
                setProgressLog((prev) => [...prev, { id: Date.now() + Math.random(), text: 'Finished working' }]);
            },
            onCanceled: (partial) => {
                setController(null);
                setIsThinking(false);
                setStreamingMessage('');
            },
            onError: () => {
                setController(null);
                setIsThinking(false);
                setStreamingMessage('');
                setProgressStatus('Failed');
                setProgressExpanded(true);
                setProgressLog((prev) => [...prev, { id: Date.now() + Math.random(), text: 'Request failed' }]);
            },
            onLog: (line) => {
                setProgressLog((prev) => {
                    const last = prev[prev.length - 1];
                    if (last && last.text === line) return prev;
                    return [...prev, { id: Date.now() + Math.random(), text: line }];
                });
            },
            onCommandPending: (cp) => {
                setPendingCommands((prev) => [
                    ...prev,
                    { id: cp.id, command: cp.command, status: 'pending', timestamp: new Date(), filesCount: cp.filesCount || 0 },
                ]);
            },
        });
        clearAttachments();
        setInputValue('');
    });

    // Reset local UI state when switching sessions (fixes new chat showing old state)
    useEffect(() => {
        setIsThinking(false);
        setShowThinking(false);
        setStreamingMessage('');
        setController(null);
        setProgressLog([]);
        setProgressStatus('');
        setProgressExpanded(true);
        setSuggestionExpanded(false);
        setCollapsedFiles({});
        setPendingCommands([]);
        scrollLockRef.current = false;
    }, [activeSessionId]);

    // ── AI Jumpstart: auto-send initial prompt once on first mount ──
    const hasConsumedInitialPrompt = useRef(false);
    useEffect(() => {
        if (!initialPrompt) return;

        // Use a short delay to let the component hydrate and session initialize
        const timer = setTimeout(() => {
            if (hasConsumedInitialPrompt.current) return;
            hasConsumedInitialPrompt.current = true;
            
            const aborter = new AbortController();
            thinkingStartRef.current = Date.now();
            setController(aborter);
            setStreamingMessage('');
            setIsThinking(true);
            setProgressLog([{ id: Date.now(), text: 'Working…' }]);
            setProgressStatus('Working…');
            setProgressExpanded(true);
            setSuggestionExpanded(false);
            setPendingCommands([]);

            // Pass pre-processed attachments directly (already in { id, name, content, kind } format)
            const jumpstartAttachmentsList = initialAttachments || [];

            handleSendMessage(initialPrompt, jumpstartAttachmentsList, {
                includeActiveFile: false,
                controller: aborter,
                onStreamStart: () => setIsThinking(true),
                onFirstToken: () => {
                    const elapsed = Date.now() - thinkingStartRef.current;
                    const delay = Math.max(0, 150 - elapsed);
                    setTimeout(() => setIsThinking(false), delay);
                },
                onChunk: (text) => setStreamingMessage(text),
                onDone: () => {
                    setController(null);
                    setStreamingMessage('');
                    setIsThinking(false);
                    setProgressStatus('Finished working');
                    setProgressExpanded(false);
                    setProgressLog((prev) => [...prev, { id: Date.now() + Math.random(), text: 'Finished working' }]);
                },
                onCanceled: () => {
                    setController(null);
                    setIsThinking(false);
                    setStreamingMessage('');
                },
                onError: () => {
                    setController(null);
                    setIsThinking(false);
                    setStreamingMessage('');
                    setProgressStatus('Failed');
                    setProgressExpanded(true);
                    setProgressLog((prev) => [...prev, { id: Date.now() + Math.random(), text: 'Request failed' }]);
                },
                onLog: (line) => {
                    setProgressLog((prev) => {
                        const last = prev[prev.length - 1];
                        if (last && last.text === line) return prev;
                        return [...prev, { id: Date.now() + Math.random(), text: line }];
                    });
                },
                onCommandPending: (cp) => {
                    setPendingCommands((prev) => [
                        ...prev,
                        { id: cp.id, command: cp.command, status: 'pending', timestamp: new Date(), filesCount: cp.filesCount || 0 },
                    ]);
                },
            });
        }, 500); // 500ms to let workspace + collab fully initialize

        return () => clearTimeout(timer);
        // Only run once on mount — deps intentionally minimal
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialPrompt]);

    useEffect(() => {
        if (isThinking) {
            setShowThinking(true);
            return () => { };
        }
        if (!showThinking) return () => { };
        const timer = setTimeout(() => setShowThinking(false), 200);
        return () => clearTimeout(timer);
    }, [isThinking, showThinking]);

    const messages = activeSession?.messages ?? [];
    const suggestionTimestamp = activeSession?.suggestionTimestamp
        ? new Date(activeSession.suggestionTimestamp)
        : null;
    const liveSuggestionEntry = (fileSuggestions.length > 0 || suggestedCode) && suggestionTimestamp
        ? { id: 'suggestion-live', role: 'suggestion-live', timestamp: suggestionTimestamp, snapshot: { fileSuggestions, suggestedCode, diffChunks } }
        : null;
    const timeline = liveSuggestionEntry ? [...messages, liveSuggestionEntry] : [...messages];
    // Inject pending command approval cards into the timeline
    for (const cmd of pendingCommands) {
        timeline.push({
            id: `cmd-approval-${cmd.id}`,
            role: 'command-approval',
            command: cmd.command,
            approvalId: cmd.id,
            approvalStatus: cmd.status,
            timestamp: cmd.timestamp,
            output: cmd.output || null,
            filesCount: cmd.filesCount || 0,
        });
    }
    timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    useEffect(() => {
        if (scrollLockRef.current) return;
        if (scrollRef.current) {
            const scrollArea = scrollRef.current.querySelector('[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]');
            if (scrollArea) {
                scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior: 'smooth' });
            }
        }
    }, [messages, streamingMessage, showThinking, progressLog, progressExpanded, pendingCommands]);

    const toggleProgressMessage = (id) => {
        if (!activeSession) return;
        mutateSession(activeSession.id, (session) => ({
            ...session,
            messages: session.messages.map((m) => m.id === id ? { ...m, expanded: !m.expanded } : m),
        }));
    };

    // ── Command approval handlers ───────────────────────────────────
    const handleCommandApprove = useCallback(async (approvalId) => {
        try {
            // Set to 'running' immediately while we wait for execution
            setPendingCommands((prev) =>
                prev.map((c) => (c.id === approvalId ? { ...c, status: 'running' } : c))
            );
            const res = await fetch('/api/chat/approve-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: approvalId, approved: true }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                // Server error (404 = expired/not found, 500 = exec failed)
                console.error('[CommandApproval] Server error:', res.status, data);
                setPendingCommands((prev) =>
                    prev.map((c) => (c.id === approvalId ? { ...c, status: 'failed', output: data?.error || `Server error ${res.status}` } : c))
                );
                return;
            }
            // For deferred commands, the endpoint executes and returns the result
            if (data?.deferred && data?.result) {
                // exitCode === 0 is success. null/undefined means unknown — check for explicit error.
                const hasExplicitError = Boolean(data.result.error);
                const exitOk = data.result.exitCode === 0;
                const exitUnknown = data.result.exitCode == null;
                const success = exitOk || (exitUnknown && !hasExplicitError);
                setPendingCommands((prev) =>
                    prev.map((c) => (c.id === approvalId ? { ...c, status: success ? 'approved' : 'failed', output: data.result.output || data.result.error } : c))
                );
                // Open a terminal tab so the user can see the command output
                if (data.result.sessionId && typeof window !== 'undefined') {
                    try { dispatch(setShowTerminal(true)); } catch (_) {}
                    window.dispatchEvent(new CustomEvent('ai-terminal-open', {
                        detail: { sessionId: data.result.sessionId, command: data.result.command || '' },
                    }));
                }
            } else if (data?.deferred) {
                // Deferred but no result body
                setPendingCommands((prev) =>
                    prev.map((c) => (c.id === approvalId ? { ...c, status: 'approved' } : c))
                );
            } else {
                // Live command — just mark approved (tool loop continues server-side)
                setPendingCommands((prev) =>
                    prev.map((c) => (c.id === approvalId ? { ...c, status: 'approved' } : c))
                );
            }
        } catch (e) {
            console.error('[CommandApproval] Approve failed:', e);
            setPendingCommands((prev) =>
                prev.map((c) => (c.id === approvalId ? { ...c, status: 'failed' } : c))
            );
        }
    }, []);

    const handleCommandReject = useCallback(async (approvalId) => {
        try {
            await fetch('/api/chat/approve-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: approvalId, approved: false }),
            });
            setPendingCommands((prev) =>
                prev.map((c) => (c.id === approvalId ? { ...c, status: 'rejected' } : c))
            );
        } catch (e) {
            console.error('[CommandApproval] Reject failed:', e);
        }
    }, []);

    const toggleFilePreview = (path) => {
        scrollLockRef.current = true;
        setCollapsedFiles((prev) => ({
            ...prev,
            [path]: !prev[path],
        }));
        setTimeout(() => { scrollLockRef.current = false; }, 100);
    };

    /**
     * Search for a symbol definition across all cached files.
     * Prioritizes actual definitions (class, struct, function) over usages.
     * For C++, prioritizes header files (.h, .hpp) for class definitions.
     */
    const findSymbolInWorkspace = useCallback((symbolName) => {
        const cachedFileMap = new Map(getFileCacheEntries());

        // Helper to find file node by path
        const findNodeByPath = (nodes, targetPath) => {
            for (const node of nodes) {
                if (!node.isFolder && node.path === targetPath) {
                    return node;
                }
                if (node.isFolder && node.children) {
                    const found = findNodeByPath(node.children, targetPath);
                    if (found) return found;
                }
            }
            return null;
        };

        // Definition patterns - these indicate where the symbol is DEFINED, not just used
        const getDefinitionPatterns = (name) => [
            new RegExp(`\\bclass\\s+${name}\\b`),           // class definition
            new RegExp(`\\bstruct\\s+${name}\\b`),          // struct definition
            new RegExp(`\\benum\\s+${name}\\b`),            // enum definition
            new RegExp(`\\binterface\\s+${name}\\b`),       // interface definition
            new RegExp(`\\btype\\s+${name}\\b`),            // type alias
            new RegExp(`\\bdef\\s+${name}\\s*\\(`),         // Python function def
            new RegExp(`\\bfunction\\s+${name}\\s*\\(`),    // JS function declaration
            new RegExp(`\\bconst\\s+${name}\\s*=`),         // JS const declaration
            new RegExp(`^\\s*${name}\\s*::`),               // C++ method implementation
            new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*{`),   // Function with body
            new RegExp(`\\b${name}\\s*\\([^)]*\\)\\s*:`),   // Constructor initializer list
        ];

        const defPatterns = getDefinitionPatterns(symbolName);
        
        // Collect all matches with priority scores
        const matches = [];
        
        for (const [path, content] of cachedFileMap.entries()) {
            if (!content) continue;
            const lines = content.split('\n');
            
            // Check file type for prioritization
            const isHeader = /\.(h|hpp|hxx)$/i.test(path);
            const isSource = /\.(c|cpp|cxx|cc)$/i.test(path);
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line.includes(symbolName)) continue;
                
                // Check if this is a definition
                const isDefinition = defPatterns.some(p => p.test(line));
                
                // Calculate priority score
                // Higher score = better match
                let priority = 0;
                if (isDefinition) {
                    priority += 100;  // Definitions are strongly preferred
                    if (isHeader) {
                        priority += 50;  // Header file definitions are best for C++
                    }
                }
                // For C++ class methods, the .cpp file implementation
                if (isSource && new RegExp(`${symbolName}\\s*::`).test(line)) {
                    priority += 80;  // Method implementation in source file
                }
                
                const fileNode = findNodeByPath(rawFiles, path);
                if (fileNode) {
                    matches.push({
                        fileNode,
                        lineNumber: i + 1,
                        priority,
                        path
                    });
                }
                
                // Only keep the first match per file (the definition if found)
                if (isDefinition) break;
            }
        }
        
        // Sort by priority (highest first)
        matches.sort((a, b) => b.priority - a.priority);
        
        // Return the best match
        if (matches.length > 0) {
            const best = matches[0];
            return { fileNode: best.fileNode, lineNumber: best.lineNumber };
        }
        
        return null;
    }, [getFileCacheEntries, rawFiles]);

    /**
     * Handle clicks on file names and symbols in AI chat messages.
     * Delegates click events to navigate to the referenced file or symbol.
     */
    const handleContentNavClick = useCallback((e) => {
        const navLink = e.target.closest('.ai-nav-link');
        if (!navLink) return;
        
        const navType = navLink.dataset.navType;
        const navTarget = navLink.dataset.navTarget;
        if (!navType || !navTarget) return;
        
        e.preventDefault();
        e.stopPropagation();
        
        if (navType === 'file') {
            // Find the file in the workspace tree by name
            let fileNode = findFileInTree(rawFiles, navTarget);
            
            // Fallback: try searching for a file ending with this name
            if (!fileNode) {
                const findByPath = (nodes, filename) => {
                    for (const node of nodes) {
                        if (!node.isFolder) {
                            if (node.name === filename || 
                                node.path?.endsWith('/' + filename) || 
                                node.path?.endsWith('\\' + filename) ||
                                node.path === filename) {
                                return node;
                            }
                        }
                        if (node.isFolder && node.children) {
                            const found = findByPath(node.children, filename);
                            if (found) return found;
                        }
                    }
                    return null;
                };
                fileNode = findByPath(rawFiles, navTarget);
            }
            
            if (fileNode) {
                dispatch(selectFileThunk(fileNode));
            } else {
                console.warn(`[AI Chat] Could not find file: ${navTarget}`);
            }
        } else if (navType === 'symbol') {
            // Search for the symbol in workspace files
            const result = findSymbolInWorkspace(navTarget);
            if (result) {
                const { fileNode, lineNumber } = result;
                // Navigate to the file
                dispatch(selectFileThunk(fileNode)).then(() => {
                    // Wait a bit for the file to load and editor to update
                    setTimeout(() => {
                        if (editor) {
                            try {
                                editor.revealLineInCenter(lineNumber);
                                editor.setPosition({ lineNumber, column: 1 });
                                editor.focus();
                            } catch (err) {
                                console.warn('[AI Chat] Could not scroll to symbol:', err);
                            }
                        }
                    }, 150);
                });
            } else {
                console.warn(`[AI Chat] Could not find symbol: ${navTarget}`);
            }
        }
    }, [dispatch, editor, findSymbolInWorkspace, rawFiles]);

    const handleCancel = () => {
        if (controller) {
            try { controller.abort(); } catch (e) { }
        }
        setIsThinking(false);
        setProgressStatus('Cancelled');
    };

    if (!isVisible) return null;

    const containerClass = docked
        ? 'h-full w-full min-w-0 max-w-full bg-transparent flex flex-col min-h-0'
        : 'fixed top-10 right-0 bottom-0 w-[340px] flex flex-col min-h-0 z-40';

    const containerStyle = docked ? undefined : {
        background: 'var(--bg-app)',
        borderLeft: '1px solid var(--border-subtle)',
        boxShadow: '0 0 40px rgba(0,0,0,0.5)',
    };

    const codeContainerStyle = {
        width: '100%',
        maxWidth: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        overflowX: 'auto',
        overflowY: 'auto',
    };

    return (
        <div
            className={`${containerClass} ${isDragging ? 'ring-2 ring-inset' : ''}`}
            style={{ ...containerStyle, ...(isDragging ? { '--tw-ring-color': 'color-mix(in srgb, var(--accent-secondary) 60%, transparent)' } : {}) }}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onPaste={handlePaste}
        >
            {/* Drop overlay */}
            {isDragging && (
                <div className="absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm pointer-events-none" style={{ background: 'color-mix(in srgb, var(--bg-app) 90%, transparent)' }}>
                    <div className="flex flex-col items-center gap-3 p-6 rounded-xl border-2 border-dashed" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary) 50%, transparent)', background: 'color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel))' }}>
                        <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--accent-secondary) 20%, transparent)' }}>
                            <FileCode className="w-6 h-6" style={{ color: 'var(--accent-secondary)' }} />
                        </div>
                        <div className="text-center">
                            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Drop files here</p>
                            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>Add files or folders as context</p>
                        </div>
                    </div>
                </div>
            )}
            {/* Header */}
            <div className="flex flex-col" style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-app)' }}>
                <div className="flex items-center justify-between px-3.5 py-2.5 relative">
                    <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(to bottom right, var(--accent-primary), var(--accent-secondary))', boxShadow: '0 0 12px color-mix(in srgb, var(--accent-primary) 30%, transparent)' }}>
                            <Sparkles className="w-3 h-3 text-white" strokeWidth={2.5} />
                        </div>
                        <span className="text-[12px] font-semibold tracking-wide" style={{ color: 'var(--text-primary)' }}>Synthi AI</span>
                        {(suggestedCode || fileSuggestions.length > 0) && (
                            <div className="text-[9px] font-semibold px-2 py-0.5 rounded-full" style={{ color: 'var(--accent-secondary)', background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent)' }}>
                                {fileSuggestions.length > 0 ? `${fileSuggestions.length} file${fileSuggestions.length > 1 ? 's' : ''}` : 'Ready'}
                            </div>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-lg transition-all duration-200"
                        style={{ color: 'var(--text-muted)' }}
                        title="Close chat"
                    >
                        <X className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </button>
                </div>

                {/* Code Intel */}
                {isVisible && (
                    <div className="mx-3 mb-1.5 rounded-lg px-2.5 py-1.5 text-[10px]" style={{ border: '1px solid var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-panel) 80%, transparent)', color: 'var(--text-secondary)' }}>
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent-primary)', boxShadow: '0 0 6px color-mix(in srgb, var(--accent-primary) 40%, transparent)' }}></span>
                                <span className="font-semibold uppercase tracking-[0.12em] text-[9px]" style={{ color: 'var(--text-muted)' }}>Code Intel</span>
                            </div>
                            <button
                                onClick={refreshMetrics}
                                className="text-[9px] uppercase tracking-[0.12em] transition-colors"
                                style={{ color: 'var(--text-dim)' }}
                                title="Refresh metrics"
                            >
                                Refresh
                            </button>
                        </div>
                        {metricsError && (
                            <div className="mt-1 text-[10px] text-rose-400/80">{metricsError}</div>
                        )}
                        {!metricsError && (
                            <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[9px]">
                                <span style={{ color: 'var(--text-muted)' }}>p95:</span>
                                {Object.entries(codeIntelMetrics?.latency || {}).map(([stage, vals]) => (
                                    <span key={stage} style={{ color: 'var(--text-secondary)' }}>
                                        {stage} {Math.round(vals?.p95 || 0)}ms
                                    </span>
                                ))}
                                <span style={{ color: 'var(--text-muted)' }}>counters:</span>
                                {Object.entries(codeIntelMetrics?.counters || {}).map(([k, v]) => (
                                    <span key={k} style={{ color: 'var(--text-secondary)' }}>
                                        {k}:{v}
                                    </span>
                                ))}
                                <span style={{ color: 'var(--text-muted)' }}>budgets:</span>
                                {Object.entries(codeIntelMetrics?.budgets || {}).map(([k, v]) => (
                                    <span key={k} style={{ color: 'var(--text-secondary)' }}>
                                        {k}:{v}
                                    </span>
                                ))}
                                {codeIntelMetrics?.index_generation && (
                                    <span style={{ color: 'var(--text-muted)' }}>gen:{codeIntelMetrics.index_generation}</span>
                                )}
                                {isMetricsLoading && (
                                    <span style={{ color: 'var(--text-dim)' }}>syncing…</span>
                                )}
                            </div>
                        )}
                    </div>
                )}

                <div className="px-2.5 pb-2 flex items-center gap-1 overflow-x-auto">
                    {chatSessions.map((session) => {
                        const isActive = session.id === activeSession?.id;
                        return (
                            <button
                                key={session.id}
                                onClick={() => setActiveSessionId(session.id)}
                                className={`relative flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] transition-all duration-200 ${isActive
                                        ? 'font-semibold'
                                        : 'opacity-60 hover:opacity-100'
                                    }`}
                                style={isActive
                                    ? { background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)', color: 'var(--accent-secondary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)' }
                                    : { color: 'var(--text-muted)' }
                                }
                            >
                                {isActive && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-3 rounded-full" style={{ background: 'linear-gradient(to bottom, var(--accent-primary), var(--accent-secondary))' }}></span>}
                                <span className="truncate max-w-[80px]">{session.title}</span>
                                {chatSessions.length > 1 && (
                                    <X
                                        className="w-2.5 h-2.5 ml-0.5"
                                        style={{ color: 'var(--text-muted)' }}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleCloseSession(session.id);
                                        }}
                                        strokeWidth={1.5}
                                    />
                                )}
                            </button>
                        );
                    })}
                    <button
                        onClick={handleNewSession}
                        className="flex items-center gap-0.5 text-[10px] px-2 py-1 rounded-md transition-all duration-200"
                        style={{ color: 'var(--text-muted)' }}
                        title="Start a new chat"
                    >
                        <Plus className="w-2.5 h-2.5" strokeWidth={2} />
                    </button>
                </div>
            </div>

            {/* Messages Area */}
            <ScrollArea ref={scrollRef} className="flex-1 px-3 py-3 min-h-0 min-w-0 relative overflow-hidden" style={{ background: 'var(--bg-app)' }}>
                {/* Subtle ambient glow */}
                <div className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[200px] h-[120px] rounded-full blur-[60px] z-0" style={{ background: 'color-mix(in srgb, var(--accent-primary) 4%, transparent)' }}></div>
                <div className="space-y-3 min-w-0 relative z-10">
                    {timeline.length === 0 ? (
                        <div className="relative flex flex-col items-center justify-center h-56 px-4 pt-8">
                            {/* Big ambient glow behind everything */}
                            <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[280px] h-[200px] rounded-full blur-[80px]" style={{ background: 'color-mix(in srgb, var(--accent-primary) 7%, transparent)' }}></div>
                            <div className="pointer-events-none absolute top-[35%] left-1/2 -translate-x-1/2 -translate-y-1/2 w-[180px] h-[100px] rounded-full blur-[50px]" style={{ background: 'color-mix(in srgb, var(--accent-secondary) 5%, transparent)' }}></div>
                            {/* Icon */}
                            <div className="relative z-10">
                                <div className="relative w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'linear-gradient(to bottom right, color-mix(in srgb, var(--accent-primary) 25%, transparent), color-mix(in srgb, var(--accent-secondary) 15%, transparent))', border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)', boxShadow: '0 0 40px color-mix(in srgb, var(--accent-primary) 18%, transparent)' }}>
                                    <Sparkles className="w-6 h-6" style={{ color: 'var(--accent-secondary)' }} strokeWidth={1.5} />
                                </div>
                            </div>
                            <h3 className="relative z-10 text-[14px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>What can I help with?</h3>
                            <p className="relative z-10 text-[11px] leading-relaxed text-center max-w-[220px]" style={{ color: 'var(--text-muted)' }}>
                                Explain code, fix bugs, add features, or refactor your project.
                            </p>
                        </div>
                    ) : (
                        timeline.map((msg) => {
                            // ── Command Approval Card ────────────────────────
                            if (msg.role === 'command-approval') {
                                return (
                                    <div key={msg.id} className="flex justify-start min-w-0">
                                        <div className="w-full min-w-0">
                                            <CommandApprovalCard
                                                id={msg.approvalId}
                                                command={msg.command}
                                                status={msg.approvalStatus}
                                                output={msg.output}
                                                filesCount={msg.filesCount}
                                                onApprove={handleCommandApprove}
                                                onReject={handleCommandReject}
                                            />
                                        </div>
                                    </div>
                                );
                            }

                            if (msg.role === 'progress') {
                                const expanded = msg.expanded === true;
                                const isFinished = msg.status === 'finished';
                                const isFailed = msg.status === 'failed';
                                const isWorking = !isFinished && !isFailed;
                                const statusLabel = isFinished ? 'Completed' : isFailed ? 'Failed' : 'Working…';
                                const statusColor = isFinished ? 'text-emerald-400' : isFailed ? 'text-rose-400' : 'text-amber-400';
                                const iconColor = isFinished ? 'text-emerald-400' : isFailed ? 'text-rose-400' : 'text-amber-400';
                                return (
                                    <div key={msg.id} className={`relative text-xs rounded-xl overflow-hidden`}
                                        style={{
                                            background: isFinished
                                                ? 'linear-gradient(to bottom, color-mix(in srgb, var(--accent-primary) 8%, var(--bg-panel)), var(--bg-panel))'
                                                : isFailed
                                                ? 'linear-gradient(to bottom, color-mix(in srgb, #ef4444 6%, var(--bg-panel)), var(--bg-panel))'
                                                : 'linear-gradient(to bottom, var(--bg-surface), var(--bg-panel))',
                                            border: isFinished
                                                ? '1px solid color-mix(in srgb, var(--accent-primary) 25%, transparent)'
                                                : isFailed
                                                ? '1px solid color-mix(in srgb, #ef4444 25%, transparent)'
                                                : '1px solid var(--border-subtle)',
                                        }}
                                    >
                                        {/* Accent bar on left */}
                                        <div className={`absolute left-0 top-0 bottom-0 w-[2px]`}
                                            style={{
                                                background: isFinished
                                                    ? 'linear-gradient(to bottom, var(--accent-primary), var(--accent-secondary))'
                                                    : isFailed
                                                    ? 'linear-gradient(to bottom, #b91c1c, #ef4444)'
                                                    : 'linear-gradient(to bottom, var(--text-dim), var(--border-subtle))'
                                            }}
                                        ></div>
                                        <button
                                            className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-all duration-200"
                                            onClick={() => toggleProgressMessage(msg.id)}
                                        >
                                            <div className={`flex items-center justify-center w-5 h-5 rounded-md`}
                                                style={{ background: isFinished ? 'color-mix(in srgb, var(--accent-primary) 20%, transparent)' : isFailed ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)' }}
                                            >
                                                {expanded ? 
                                                    <ChevronDown className={`w-3 h-3 ${isFailed ? 'text-rose-400' : isFinished ? '' : 'text-amber-400'}`} style={isFinished ? { color: 'var(--accent-secondary)' } : undefined} strokeWidth={2.5} /> : 
                                                    <ChevronRight className={`w-3 h-3 ${isFailed ? 'text-rose-400' : isFinished ? '' : 'text-amber-400'}`} style={isFinished ? { color: 'var(--accent-secondary)' } : undefined} strokeWidth={2.5} />
                                                }
                                            </div>
                                            <div className="flex items-center gap-2 flex-1 min-w-0">
                                                <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-wide ${
                                                    isFailed ? 'text-rose-400' : isFinished ? '' : 'text-amber-400'
                                                }`} style={isFinished ? { color: 'var(--accent-secondary)' } : undefined}>
                                                    {isFinished && <span className="w-2 h-2 rounded-full" style={{ background: 'var(--accent-secondary)', boxShadow: '0 0 10px color-mix(in srgb, var(--accent-secondary) 60%, transparent)' }}></span>}
                                                    {isFailed && <span className="w-2 h-2 rounded-full bg-rose-400 shadow-[0_0_10px_rgba(251,113,133,0.5)]"></span>}
                                                    {!isFinished && !isFailed && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.5)]"></span>}
                                                    {statusLabel}
                                                </span>
                                                <span className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{summarizeLog(msg.logs)}</span>
                                            </div>
                                        </button>
                                        {expanded && (
                                            <div className={`px-3.5 pb-3 pt-2 space-y-1.5`}
                                                style={{
                                                    borderTop: isFinished
                                                        ? '1px solid color-mix(in srgb, var(--accent-primary) 15%, transparent)'
                                                        : isFailed
                                                        ? '1px solid color-mix(in srgb, #ef4444 15%, transparent)'
                                                        : '1px solid color-mix(in srgb, var(--border-subtle) 80%, transparent)',
                                                    background: 'color-mix(in srgb, var(--bg-panel) 50%, transparent)',
                                                }}
                                            >
                                                {(msg.logs || []).map((entry, idx) => {
                                                    return (
                                                        <div key={`${msg.id}-log-${idx}`} className="flex items-start gap-2 text-[10px] font-mono leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                                                            <span className="select-none mt-0.5 text-[9px]" style={{ color: 'var(--text-dim)' }}>›</span>
                                                            <span className="whitespace-normal break-words">{entry}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            }

                            if (msg.role === 'context') {
                                const meta = msg.contextMeta || {};
                                const sources = Array.isArray(meta.sources) ? meta.sources : [];
                                return (
                                    <div key={msg.id} className="text-xs rounded-xl backdrop-blur-sm px-3 py-2" style={{ border: '1px solid var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-panel) 80%, transparent)' }}>
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2">
                                                <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' }}>
                                                    <FileCode className="w-3 h-3" style={{ color: 'var(--accent-secondary)' }} />
                                                </div>
                                                <span className="text-[10px] uppercase tracking-[0.12em] font-semibold" style={{ color: 'var(--text-muted)' }}>Context used</span>
                                            </div>
                                            {meta.traceSummary ? (
                                                <span className="text-[9px] truncate max-w-[200px] font-mono" style={{ color: 'var(--text-dim)' }}>{meta.traceSummary}</span>
                                            ) : null}
                                        </div>
                                        {sources.length > 0 && (
                                            <div className="mt-2 space-y-1 pl-7">
                                                {sources.map((src, idx) => {
                                                    const file = src?.file || 'unknown';
                                                    const symbol = src?.symbol ? ` · ${src.symbol}` : '';
                                                    const lineInfo = src?.start_line && src?.end_line
                                                        ? ` (L${src.start_line}-${src.end_line})`
                                                        : '';
                                                    return (
                                                        <div key={`${file}-${idx}`} className="text-[10px] font-mono truncate" style={{ color: 'var(--text-secondary)' }}>
                                                            <span className="mr-1" style={{ color: 'var(--text-dim)' }}>›</span>{file}{lineInfo}<span style={{ color: 'var(--text-muted)' }}>{symbol}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            }

                            if (msg.role === 'suggestion-live' || msg.role === 'suggestion-history') {
                                const snapshot = msg.snapshot || {};
                                const hasFiles = (snapshot.fileSuggestions || []).length > 0;
                                return (
                                    <div key={msg.id} className="flex justify-start min-w-0">
                                        <div className="w-full min-w-0">
                                            {hasFiles ? (
                                                <div className="space-y-3 min-w-0">
                                                    {snapshot.fileSuggestions.map((suggestion, idx) => {
                                                        const stats = diffStats(suggestion.chunks);
                                                        const badgeText = `${fileSuggestionStatusLabel(suggestion.status)}`;
                                                        const statsAddText = `+${stats.adds}`;
                                                        const statsRemText = `-${stats.removals}`;
                                                        const collapsed = collapsedFiles[suggestion.path] !== false;
                                                        return (
                                                            <div
                                                                key={`${suggestion.path}-${suggestion.status}-${idx}`}
                                                                className="rounded-lg overflow-hidden min-w-0 shadow-sm"
                                                                style={{ ...codeContainerStyle, border: '1px solid var(--bg-elevated)', background: 'var(--bg-panel)' }}
                                                            >
                                                                {/* File header - compact */}
                                                                <div className="flex items-center justify-between gap-2 px-1.5 py-1" style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--bg-elevated)' }}>
                                                                    <div className="flex items-center gap-1.5 min-w-0 flex-1">
                                                                        {(() => {
                                                                            const meta = buildLanguageMeta(suggestion.path);
                                                                            return (
                                                                                <span
                                                                                    className="inline-flex items-center justify-center flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide"
                                                                                    style={{ color: meta.color, backgroundColor: `${meta.color}25` }}
                                                                                    title={meta.label}
                                                                                >
                                                                                    <FileCode className="w-3 h-3 mr-1" strokeWidth={2} style={{ color: meta.color }} />
                                                                                    {meta.label}
                                                                                </span>
                                                                            );
                                                                        })()}
                                                                        <button
                                                                            onClick={async () => {
                                                                                const parts = suggestion.path.split('/');
                                                                                const name = parts[parts.length - 1] || suggestion.path;
                                                                                try {
                                                                                    const action = await dispatch(selectFileThunk({ path: suggestion.path, name }));
                                                                                    const payload = action?.payload || null;
                                                                                    const findFirstChangedLine = (chunks) => {
                                                                                        if (!Array.isArray(chunks)) return null;
                                                                                        for (const chunk of chunks) {
                                                                                            if (!chunk || !Array.isArray(chunk.items)) continue;
                                                                                            for (const row of chunk.items) {
                                                                                                if (!row) continue;
                                                                                                if (row.type === 'add' || row.type === 'rem') {
                                                                                                    const candidate = (typeof row.lineNew === 'number' && row.lineNew > 0) ? row.lineNew : (typeof row.lineOld === 'number' && row.lineOld > 0 ? row.lineOld : null);
                                                                                                    if (candidate) return candidate;
                                                                                                }
                                                                                            }
                                                                                        }
                                                                                        return null;
                                                                                    };
                                                                                    const targetLine = findFirstChangedLine(suggestion.chunks) || 1;
                                                                                    if (editor && payload && typeof payload.content === 'string') {
                                                                                        const desiredContent = payload.content;
                                                                                        let attempts = 0;
                                                                                        const maxAttempts = 20;
                                                                                        while (attempts < maxAttempts) {
                                                                                            try {
                                                                                                const model = editor.getModel && editor.getModel();
                                                                                                const current = model && typeof editor.getValue === 'function' ? editor.getValue() : null;
                                                                                                if (current !== null && current === desiredContent) {
                                                                                                    try {
                                                                                                        editor.revealLineInCenter && editor.revealLineInCenter(targetLine);
                                                                                                        editor.setPosition && editor.setPosition({ lineNumber: targetLine, column: 1 });
                                                                                                        editor.focus && editor.focus();
                                                                                                    } catch (e) { /* ignore */ }
                                                                                                    break;
                                                                                                }
                                                                                            } catch (e) { }
                                                                                            attempts += 1;
                                                                                            await new Promise(r => setTimeout(r, 50));
                                                                                        }
                                                                                    }
                                                                                } catch (e) { }
                                                                            }}
                                                                            className="text-left font-mono text-[10px] truncate transition-colors"
                                                                            style={{ color: 'var(--text-primary)' }}
                                                                            title={suggestion.path}
                                                                        >
                                                                            {suggestion.path}
                                                                        </button>
                                                                        {/* Stats - more prominent */}
                                                                        <div className="flex items-center gap-1 flex-shrink-0">
                                                                            <span className="font-mono text-[10px] font-semibold text-emerald-400 bg-emerald-500/15 px-1 py-px rounded">{statsAddText}</span>
                                                                            <span className="font-mono text-[10px] font-semibold text-rose-400 bg-rose-500/15 px-1 py-px rounded">{statsRemText}</span>
                                                                        </div>
                                                                    </div>
                                                                    {/* Status badge */}
                                                                    <div className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide opacity-80 ${fileSuggestionStatusClasses(suggestion.status)}`}>
                                                                        {badgeText}
                                                                    </div>
                                                                </div>
                                                                {/* Actions bar */}
                                                                <div className="flex items-center justify-between gap-1.5 px-2 py-1" style={{ background: 'var(--bg-panel)', borderBottom: '1px solid var(--bg-elevated)' }}>
                                                                    <button
                                                                        className="text-[10px] flex items-center gap-0.5 font-medium transition-colors"
                                                                        style={{ color: 'var(--text-muted)' }}
                                                                        onClick={() => toggleFilePreview(suggestion.path)}
                                                                    >
                                                                        {collapsed ? <ChevronRight className="w-3 h-3" strokeWidth={2} /> : <ChevronDown className="w-3 h-3" strokeWidth={2} />}
                                                                        {collapsed ? 'Show diff' : 'Hide diff'}
                                                                        {collapsed && <span className="text-[9px] ml-1" style={{ color: 'var(--text-dim)' }}>(click to expand)</span>}
                                                                    </button>
                                                                    {suggestion.status === 'pending' && msg.role === 'suggestion-live' && (
                                                                        <div className="flex items-center gap-4">
                                                                            {/* Preview - tertiary (very passive) */}
                                                                            {!suggestion.isNewFile && !suggestion.deleteFile && !suggestion.deleteFolder && !suggestion.isFolder && (
                                                                                <button
                                                                                    disabled={Boolean(suggestion.error)}
                                                                                    onClick={() => handlePreviewFileSuggestion(activeSession?.id || activeSessionId, suggestion.path)}
                                                                                    className="text-[11px] font-medium px-1.5 py-1 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                                                                                    style={{ color: 'var(--text-muted)' }}
                                                                                >
                                                                                    Preview
                                                                                </button>
                                                                            )}
                                                                            {/* Reject - neutral */}
                                                                            <button
                                                                                disabled={suggestion.status !== 'pending'}
                                                                                onClick={() => {
                                                                                    scrollLockRef.current = true;
                                                                                    handleRejectFileSuggestion(activeSession?.id || activeSessionId, suggestion.path);
                                                                                    setTimeout(() => { scrollLockRef.current = false; }, 300);
                                                                                }}
                                                                                className="text-[11px] font-semibold text-red-500 opacity-75 py-1 rounded-md bg-transparent hover:-translate-y-1 cursor-pointer hover:underline duration-300 hover:opacity-100 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                                                            >
                                                                                Reject
                                                                            </button>
                                                                            {/* Apply - primary (filled, dangerous feel) */}
                                                                            <button
                                                                                disabled={suggestion.status !== 'pending' || Boolean(suggestion.error)}
                                                                                onClick={() => {
                                                                                    scrollLockRef.current = true;
                                                                                    handleApplyFileSuggestion(activeSession?.id || activeSessionId, suggestion.path);
                                                                                    setTimeout(() => { scrollLockRef.current = false; }, 300);
                                                                                }}
                                                                                className="text-xs font-semibold text-emerald-400 hover:-translate-y-1 cursor-pointer duration-300 opacity-75 hover:opacity-100 py-1 rounded-md shadow-sm hover:underline transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                                                                            >
                                                                                Apply
                                                                            </button>
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                {/* Diff content area */}
                                                                {suggestion.error ? (
                                                                    <div className="text-xs font-mono text-rose-400 bg-rose-500/5 border-t border-rose-500/20 px-3 py-3">
                                                                        <span className="text-rose-500/70">Error:</span> {suggestion.error}
                                                                    </div>
                                                                ) : !collapsed ? (
                                                                    <div
                                                                        className="max-h-[35vh] min-h-[60px] overflow-auto overflow-x-auto text-[10px] font-mono ai-diff-code min-w-0 w-full max-w-full"
                                                                        style={{ ...codeContainerStyle, background: 'var(--bg-app)' }}
                                                                    >
                                                                        {renderDiffChunkList(suggestion.chunks)}
                                                                    </div>
                                                                ) : null}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : snapshot.suggestedCode ? (
                                                <div className="rounded-lg overflow-hidden min-w-0 shadow-sm" style={{ border: '1px solid var(--bg-elevated)', background: 'var(--bg-panel)' }}>
                                                    {/* Header */}
                                                    <div className="flex items-center justify-between px-2 py-1.5" style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--bg-elevated)' }}>
                                                        <div className="flex items-center gap-1.5">
                                                            <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent-secondary)' }} />
                                                            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>AI Suggestion</span>
                                                            {isLoading && (
                                                                <span className="inline-flex items-center gap-1.5 text-xs text-amber-400">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
                                                                    Processing...
                                                                </span>
                                                            )}
                                                        </div>
                                                        {snapshot.suggestedCode && msg.role === 'suggestion-live' && (
                                                            <div className="flex items-center gap-2">
                                                                {/* Reject - neutral */}
                                                                <button
                                                                    onClick={() => { scrollLockRef.current = true; setSuggestionExpanded(false); rejectSuggestion(); setTimeout(() => { scrollLockRef.current = false; }, 300); }}
                                                                    className="text-[11px] font-semibold text-red-500 px-2.5 py-1.25 rounded-md bg-transparent transition-all"
                                                                    style={{ border: '1px solid var(--border-medium)' }}
                                                                >
                                                                    Reject
                                                                </button>
                                                                {/* Apply - primary */}
                                                                <button
                                                                    onClick={() => { scrollLockRef.current = true; setSuggestionExpanded(false); applySuggestion(); setTimeout(() => { scrollLockRef.current = false; }, 300); }}
                                                                    className="text-xs font-semibold px-4 text-emerald-400 py-1.5 rounded-md shadow-sm transition-all"
                                                                    style={{ background: 'var(--accent-secondary)', borderColor: 'var(--accent-secondary)', border: '1px solid var(--accent-secondary)' }}
                                                                >
                                                                    Apply
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                    {/* Toggle bar */}
                                                    <div className="flex items-center justify-between px-2 py-1" style={{ background: 'var(--bg-surface)', borderBottom: '1px solid var(--border-subtle)' }}>
                                                        <span className="text-[10px] font-medium" style={{ color: 'var(--text-muted)' }}>Preview diff</span>
                                                        <button
                                                            className="text-[10px] flex items-center gap-0.5 font-medium transition-colors"
                                                            style={{ color: 'var(--text-muted)' }}
                                                            onClick={() => setSuggestionExpanded((v) => !v)}
                                                        >
                                                            {suggestionExpanded ? <ChevronDown className="w-3 h-3" strokeWidth={2} /> : <ChevronRight className="w-3 h-3" strokeWidth={2} />}
                                                            {suggestionExpanded ? 'Hide' : 'Show'}
                                                        </button>
                                                    </div>
                                                    {/* Diff content */}
                                                    {suggestionExpanded && (
                                                        <div className="max-h-[35vh] min-h-[60px] overflow-auto overflow-x-auto text-[10px] font-mono ai-diff-code min-w-0 w-full max-w-full" style={{ background: 'var(--bg-app)' }}>
                                                            {renderDiffChunkList(snapshot.diffChunks || [])}
                                                        </div>
                                                    )}
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            }

                            const isInlineSummary = msg.inlineSummary === true;
                            const baseContent = (
                                <>
                                    {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
                                        <div className="mb-2 space-y-2">
                                            {msg.attachments.map((att) => (
                                                <div key={att.id || att.name} className="rounded p-2" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-medium)' }}>
                                                    <div className="flex items-center justify-between text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>
                                                        <span className="truncate max-w-[200px]">{att.name || 'Attachment'}</span>
                                                        {att.size ? <span style={{ color: 'var(--text-dim)' }}>{att.size} bytes</span> : null}
                                                    </div>
                                                    {att.kind === 'image' && att.content ? (
                                                        <img
                                                            src={att.content}
                                                            alt={att.name || 'image'}
                                                            className="max-h-48 rounded" style={{ border: '1px solid var(--border-medium)' }}
                                                        />
                                                    ) : att.kind === 'text' ? (
                                                        <pre className="text-[10px] whitespace-pre-wrap max-h-24 overflow-auto rounded p-1.5" style={{ background: 'var(--bg-app)' }}>
                                                            {att.content?.slice(0, 2000) || ''}
                                                        </pre>
                                                    ) : (
                                                        <div className="text-[11px] italic" style={{ color: 'var(--text-secondary)' }}>Binary attachment</div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <div
                                        className="break-normal whitespace-normal text-[11px] leading-normal ai-chat-content min-w-0 w-full overflow-hidden"
                                        onClick={handleContentNavClick}
                                    >
                                        <MessageContent content={msg.content} enableNavigation={true} />
                                    </div>
                                    <span className="text-[9px] mt-2 block tracking-wide" style={{ color: 'var(--text-dim)' }}>
                                        {formatTimestamp(msg.timestamp)}
                                    </span>
                                </>
                            );

                            if (isInlineSummary) {
                                return (
                                    <div key={msg.id} className="text-xs" style={{ color: 'var(--text-primary)' }}>
                                        {baseContent}
                                    </div>
                                );
                            }

                            return (
                                <div
                                    key={msg.id}
                                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div
                                        className={`max-w-[88%] px-3.5 py-2.5 rounded-2xl text-sm ai-chat-message min-w-0 overflow-hidden transition-all duration-200 ${msg.role === 'user'
                                                ? 'rounded-br-md'
                                                : 'rounded-bl-md'
                                            }`}
                                        style={msg.role === 'user'
                                            ? { background: 'linear-gradient(to bottom right, color-mix(in srgb, var(--accent-primary) 15%, var(--bg-panel)), color-mix(in srgb, var(--accent-primary) 8%, var(--bg-panel)))', color: 'var(--text-primary)', border: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)' }
                                            : { background: 'var(--bg-panel)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }
                                        }
                                    >
                                        {baseContent}
                                    </div>
                                </div>
                            );
                        })
                    )}
                    {streamingMessage ? (
                        <div className="flex justify-start">
                            <div className="max-w-[88%] px-3.5 py-2.5 rounded-2xl rounded-bl-md min-w-0 overflow-hidden" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)' }}>
                                <div 
                                    className="text-[11px] leading-normal ai-chat-content min-w-0 w-full overflow-hidden"
                                    style={{ color: 'var(--text-primary)' }}
                                    onClick={handleContentNavClick}
                                >
                                    <MessageContent content={streamingMessage} enableNavigation={true} />
                                </div>
                            </div>
                        </div>
                    ) : null}
                    {showThinking && (
                        <div className="flex justify-start">
                            <div className={`px-4 py-3 rounded-2xl rounded-bl-md transition-opacity duration-200 ${isThinking ? 'opacity-100' : 'opacity-0'}`} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)' }}>
                                <ThinkingDots />
                            </div>
                        </div>
                    )}
                </div>
            </ScrollArea>

            {/* Input Area */}
            <div className="px-3.5 py-2.5" style={{ background: 'var(--bg-app)', borderTop: '1px solid var(--border-subtle)' }}>
                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                        handleFilesSelected(e.target.files);
                        if (e.target) e.target.value = '';
                    }}
                />
                {(() => {
                    const chips = [];
                    if (activeFile && (activeFile.name || activeFile.path)) {
                        chips.push({
                            id: 'context-file',
                            name: activeFile.name || activeFile.path?.split('/').pop() || 'File',
                            size: null,
                            isContext: true,
                        });
                    }
                    attachments.forEach((att) => chips.push({ ...att, isContext: false }));

                    if (!chips.length) return null;

                    return (
                        <div className="mb-1.5 grid grid-cols-2 gap-1">
                            {chips.map((chip) => {
                                const meta = buildLanguageMeta(chip.name || '');
                                const isWorkspaceFile = chip.isWorkspaceFile;
                                const isDetachedContext = chip.isContext && !contextFileAttached;
                                return (
                                    <div
                                        key={chip.id}
                                        className={`flex items-center gap-1.5 border px-1.5 py-0.5 rounded text-[10px] min-w-0`}
                                        style={{
                                            background: isDetachedContext
                                                ? 'var(--bg-editor)'
                                                : isWorkspaceFile
                                                    ? 'color-mix(in srgb, var(--accent-primary) 5%, var(--bg-editor))'
                                                    : 'var(--bg-editor)',
                                            borderColor: isWorkspaceFile
                                                ? 'color-mix(in srgb, var(--accent-primary) 20%, transparent)'
                                                : 'var(--bg-elevated)',
                                            opacity: isDetachedContext ? 0.4 : 1,
                                        }}
                                        title={chip.isContext ? (contextFileAttached ? `${chip.name} (attached as context — click link to detach)` : `${chip.name} (not attached — click link to attach as context)`) : (chip.path || chip.name)}
                                    >
                                        <span
                                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                                            style={{ color: isWorkspaceFile ? '#4aba9a' : meta.color, backgroundColor: isWorkspaceFile ? '#4aba9a20' : `${meta.color}20` }}
                                        >
                                            <FileCode className="w-3 h-3" strokeWidth={1.5} />
                                            <span className="font-semibold">{meta.label}</span>
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <span className={`truncate block leading-tight`} style={{ color: isDetachedContext ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                                                {chip.name}
                                            </span>
                                            {chip.size ? (
                                                <span className="whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{formatBytes(chip.size)}</span>
                                            ) : null}
                                        </div>
                                        {chip.isContext ? (
                                            <button
                                                type="button"
                                                onClick={() => setContextFileAttached((prev) => !prev)}
                                                className="p-0.5 rounded transition-colors"
                                                style={{ color: contextFileAttached ? 'var(--accent-secondary)' : 'var(--text-muted)' }}
                                                title={contextFileAttached ? 'Detach from context' : 'Attach as context'}
                                            >
                                                {contextFileAttached
                                                    ? <Link className="w-3 h-3" strokeWidth={1.5} />
                                                    : <Unlink className="w-3 h-3" strokeWidth={1.5} />}
                                            </button>
                                        ) : (
                                            <button
                                                onClick={() => removeAttachment(chip.id)}
                                                className="p-0.5"
                                                style={{ color: 'var(--text-muted)' }}
                                                title="Remove attachment"
                                            >
                                                <X className="w-2.5 h-2.5" strokeWidth={1.5} />
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })()}
                <div className="flex gap-2">
                    <div className="flex-1 flex flex-col gap-0 rounded-xl overflow-hidden transition-all duration-200" style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-editor)' }}>
                        <textarea
                            value={inputValue}
                            onChange={(e) => {
                                setInputValue(e.target.value);
                                const maxHeight = 120;
                                e.target.style.height = 'auto';
                                const newHeight = Math.min(e.target.scrollHeight, maxHeight);
                                e.target.style.height = newHeight + 'px';
                            }}
                            onKeyPress={handleKeyPress}
                            placeholder="Ask Synthi anything..."
                            disabled={isLoading || !clientReady}
                            className="w-full min-h-[36px] max-h-[120px] resize-none overflow-y-auto min-w-0 border-none bg-transparent px-3 pt-2.5 pb-1.5 text-[12px] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
                            rows={1}
                            style={{ color: 'var(--text-primary)', height: '36px', maxHeight: '120px' }}
                        />
                            <div className="flex items-center px-2 pb-1.5 relative">
                            <Popover open={agentMenuOpen} onOpenChange={setAgentMenuOpen}>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs px-2.5 py-1 h-6 rounded-md bg-transparent border-none transition-colors"
                                        style={{ color: agentMode === 'direct' ? 'var(--text-muted)' : 'var(--accent-secondary)' }}
                                        title="Agent mode"
                                    >
                                        <span className="flex items-center gap-1.5">
                                            {agentMode === 'direct' ? 'Agent' : agentMode === 'auto' ? 'Auto Agent' : agentMode === 'plan' ? 'Plan Agent' : 'Research'}
                                            <ChevronDown className={`w-3 h-3 transition-transform duration-300 ${agentMenuOpen ? 'rotate-180' : 'rotate-0'}`} />
                                        </span>
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent
                                    className="w-64 mr-6 p-2.5 space-y-1.5"
                                    style={{ background: 'var(--bg-panel)', border: '1px solid var(--bg-elevated)' }}
                                    side="top"
                                    align="start"
                                >
                                    <p className="text-[9px] uppercase tracking-wider mb-1 px-1" style={{ color: 'var(--text-muted)' }}>Agent Mode</p>
                                    {[
                                        { key: 'direct', label: 'Direct', desc: 'Single LLM call, no agents' },
                                        { key: 'auto', label: 'Auto Agent', desc: 'AI decides when to use sub-agents' },
                                        { key: 'plan', label: 'Plan & Execute', desc: 'Plan changes, then execute step-by-step' },
                                        { key: 'research', label: 'Research', desc: 'Multi-step search and file reading' },
                                    ].map((mode) => (
                                        <button
                                            key={mode.key}
                                            onClick={() => { setAgentMode(mode.key); setAgentMenuOpen(false); }}
                                            className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors`}
                                            style={agentMode === mode.key
                                                ? { background: 'color-mix(in srgb, var(--accent-secondary) 10%, transparent)', color: 'var(--accent-secondary)' }
                                                : { color: 'var(--text-secondary)' }
                                            }
                                        >
                                            <span className="font-medium">{mode.label}</span>
                                            <span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{mode.desc}</span>
                                        </button>
                                    ))}
                                    {activePipeline && activePipeline.status !== 'completed' && activePipeline.status !== 'failed' && (
                                        <button
                                            onClick={() => { cancelPipeline(); setAgentMenuOpen(false); }}
                                            className="w-full text-left px-2 py-1.5 rounded text-xs text-red-400 transition-colors mt-1"
                                        >
                                            Cancel running pipeline
                                        </button>
                                    )}
                                    {contextWindowInfo && (
                                        <div className="pt-2 mt-2" style={{ borderTop: '1px solid var(--border-medium)' }}>
                                            <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                                Context: {Math.round(contextWindowInfo.availableTokens / 1000)}K tokens available
                                            </p>
                                        </div>
                                    )}
                                </PopoverContent>
                            </Popover>
                            <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs px-2.5 py-1 h-6 rounded-md bg-transparent border-none transition-colors"
                                        style={{ color: 'var(--text-secondary)' }}
                                        title="Switch AI model"
                                    >
                                        <span className="flex items-center gap-1.5">
                                            {modelChoice === 'custom' ? (effectiveModel || 'Custom') : 'Gemini'}
                                            <ChevronDown
                                                className={`w-3 h-3 transition-transform duration-300 ${modelMenuOpen ? 'rotate-180' : 'rotate-0'}`}
                                                style={{ animation: modelMenuOpen ? 'none' : 'chevron-float 2s ease-in-out infinite' }}
                                            />
                                        </span>
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent
                                    className="w-72 mr-6 p-2.5 space-y-2.5"
                                    style={{ background: 'var(--bg-panel)', border: '1px solid var(--bg-elevated)' }}
                                    side="top"
                                    align="start"
                                    sideOffset={10}
                                >
                                    <div className="text-[9px] font-semibold uppercase tracking-wider px-1" style={{ color: 'var(--text-muted)' }}>Model selection</div>
                                    <div className="flex gap-1.5 text-xs" style={{ color: 'var(--text-primary)' }}>
                                        <button
                                            className={`flex-1 px-3 py-1.5 rounded-lg border transition-all`}
                                            style={modelChoice === 'gemini'
                                                ? { borderColor: 'color-mix(in srgb, var(--accent-secondary) 40%, transparent)', background: 'color-mix(in srgb, var(--accent-secondary) 8%, transparent)', color: 'var(--accent-secondary)' }
                                                : { borderColor: 'var(--bg-elevated)' }
                                            }
                                            onClick={() => setModelChoice('gemini')}
                                        >
                                            Gemini (default)
                                        </button>
                                        <button
                                            className={`flex-1 px-3 py-1.5 rounded-lg border transition-all`}
                                            style={modelChoice === 'custom'
                                                ? { borderColor: 'color-mix(in srgb, var(--accent-secondary) 40%, transparent)', background: 'color-mix(in srgb, var(--accent-secondary) 8%, transparent)', color: 'var(--accent-secondary)' }
                                                : { borderColor: 'var(--bg-elevated)' }
                                            }
                                            onClick={() => setModelChoice('custom')}
                                        >
                                            Custom
                                        </button>
                                    </div>
                                    {modelChoice === 'custom' && (
                                        <div className="space-y-3 pt-1">
                                            <div>
                                                <label className="block text-[11px] mb-1.5 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Model ID</label>
                                                <Input
                                                    value={customModel}
                                                    onChange={(e) => setCustomModel(e.target.value)}
                                                    placeholder="e.g. gpt-4.1, gemini-1.5-pro"
                                                    className="text-xs"
                                                    style={{ background: 'var(--bg-app)', borderColor: 'var(--bg-elevated)' }}
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[11px] mb-1.5 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>API Key</label>
                                                <Input
                                                    type="password"
                                                    value={customApiKey}
                                                    onChange={(e) => setCustomApiKey(e.target.value)}
                                                    placeholder="Enter custom API key"
                                                    className="text-xs"
                                                    style={{ background: 'var(--bg-app)', borderColor: 'var(--bg-elevated)' }}
                                                />
                                            </div>
                                            <div className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                                                <Eye className="w-3 h-3" />
                                                Key stored locally in your browser
                                            </div>
                                        </div>
                                    )}
                                </PopoverContent>
                            </Popover>
                            <div className='inline-flex items-center gap-0.5 absolute right-1.5'>
                                {controller ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={handleCancel}
                                        className="text-[10px] h-5 px-1.5 text-rose-400/70 hover:text-rose-400"
                                        title="Cancel generation"
                                    >
                                        Cancel
                                    </Button>
                                ) : null}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="h-6 w-6 p-0"
                                    style={{ color: 'var(--text-muted)' }}
                                    title="Attach files"
                                >
                                    <Paperclip className="w-3 h-3" strokeWidth={2} />
                                </Button>
                                <Button
                                    onClick={handleSubmit}
                                    disabled={!inputValue.trim() || isLoading || !clientReady}
                                    title="Send message (Enter)"
                                    size="sm"
                                    className="h-6 w-6 p-0 bg-transparent disabled:opacity-50"
                                    style={{ color: 'var(--accent-secondary)' }}
                                >
                                    <Send className="w-3.5 h-3.5" strokeWidth={2} />
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AIChatWindow;