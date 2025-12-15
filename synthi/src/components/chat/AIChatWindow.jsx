'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, X, Plus, ChevronDown, ChevronRight, Sparkles, Eye, FileCode } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { selectFileThunk } from '@/redux/workspaceSlice';
import { selectFileCacheEntries } from '@/redux/workspaceSlice';
import { useChatSessions } from './hooks/useChatSessions';
import { useChatInput } from './hooks/useChatInput';
import { useAISuggestions } from './hooks/useAISuggestions';
import { useChatAttachments } from './hooks/useChatAttachments';
import { renderDiffChunkList, diffStats } from './utils/diffUtils';
import { fileSuggestionStatusClasses, fileSuggestionStatusLabel } from './utils/fileSuggestionsUtils';
import { formatMessageContent } from './utils/formatMessage';
import { ThinkingDots } from './ThinkingDots';

const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    editor = null,
    docked = false,
    onSuggest = null,
    onBusy = null,
    clearSignal = 0,
}) => {
    const scrollRef = useRef(null);
    const dispatch = useAppDispatch();
    const fileCacheEntries = useAppSelector(selectFileCacheEntries);
    const workspaceSlug = useAppSelector((state) => state.workspace.slug);
    const rawFiles = useAppSelector((state) => state.workspace.rawFiles || []);

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
    const modelButtonRef = useRef(null);
    const [modelMenuPos, setModelMenuPos] = useState({ top: 0, left: 0 });
    const [isThinking, setIsThinking] = useState(false);
    const [streamingMessage, setStreamingMessage] = useState('');
    const [controller, setController] = useState(null);
    const [showThinking, setShowThinking] = useState(false);
    const thinkingStartRef = useRef(0);
    const [progressLog, setProgressLog] = useState([]);
    const [progressExpanded, setProgressExpanded] = useState(true);
    const [progressStatus, setProgressStatus] = useState('');
    const [suggestionExpanded, setSuggestionExpanded] = useState(true);
    const [collapsedFiles, setCollapsedFiles] = useState({});

    useEffect(() => {
        try {
            const savedChoice = localStorage.getItem('synthi-ai-model-choice');
            const savedModel = localStorage.getItem('synthi-ai-custom-model');
            const savedKey = localStorage.getItem('synthi-ai-custom-api-key');
            if (savedChoice) setModelChoice(savedChoice);
            if (savedModel) setCustomModel(savedModel);
            if (savedKey) setCustomApiKey(savedKey);
        } catch (e) {}
    }, []);

    useEffect(() => {
        try {
            localStorage.setItem('synthi-ai-model-choice', modelChoice);
            localStorage.setItem('synthi-ai-custom-model', customModel);
            if (customApiKey) {
                localStorage.setItem('synthi-ai-custom-api-key', customApiKey);
            }
        } catch (e) {}
    }, [modelChoice, customModel, customApiKey]);

    const effectiveModel = modelChoice === 'custom' && customModel.trim() ? customModel.trim() : null;
    const effectiveApiKey = modelChoice === 'custom' && customApiKey.trim() ? customApiKey.trim() : null;

    const updateModelMenuPosition = () => {
        const el = modelButtonRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setModelMenuPos({ top: rect.bottom + 6, left: rect.left });
    };

    useEffect(() => {
        if (!modelMenuOpen) return;
        updateModelMenuPosition();
        const handler = () => updateModelMenuPosition();
        window.addEventListener('resize', handler);
        window.addEventListener('scroll', handler, true);
        return () => {
            window.removeEventListener('resize', handler);
            window.removeEventListener('scroll', handler, true);
        };
    }, [modelMenuOpen]);

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
    } = useAISuggestions({
        activeSession,
        chatSessions,
        mutateSession,
        appendMessagesToSession,
        resetSuggestionsForSession,
        activeFile,
        currentCode,
        editor,
        onSuggest,
        onBusy,
        clearSignal,
        fileCacheEntries,
        workspaceSlug,
        rawFiles,
        dispatch,
        aiModel: effectiveModel,
        aiApiKey: effectiveApiKey,
    });

    const {
        attachments,
        isDragging,
        handleDrop,
        handleDragOver,
        handleDragLeave,
        handlePaste,
        removeAttachment,
        clearAttachments,
        formatBytes,
    } = useChatAttachments();

    const { inputValue, setInputValue, handleKeyPress, handleSubmit } = useChatInput((value) => {
        const aborter = new AbortController();
        thinkingStartRef.current = Date.now();
        setController(aborter);
        setStreamingMessage('');
        setIsThinking(true);
        setProgressLog([{ id: Date.now(), text: 'Working…' }]);
        setProgressStatus('Working…');
        setProgressExpanded(true);
        setSuggestionExpanded(true);
        handleSendMessage(value, attachments, {
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
        });
        clearAttachments();
        setInputValue('');
    });

    useEffect(() => {
        if (isThinking) {
            setShowThinking(true);
            return () => {};
        }
        if (!showThinking) return () => {};
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
    timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    useEffect(() => {
        if (scrollRef.current) {
            const scrollArea = scrollRef.current.querySelector('[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]');
            if (scrollArea) {
                scrollArea.scrollTo({ top: scrollArea.scrollHeight, behavior: 'smooth' });
            }
        }
    }, [messages, suggestedCode, fileSuggestions, streamingMessage, showThinking, progressLog, progressExpanded]);

    const toggleProgressMessage = (id) => {
        if (!activeSession) return;
        mutateSession(activeSession.id, (session) => ({
            ...session,
            messages: session.messages.map((m) => m.id === id ? { ...m, expanded: !m.expanded } : m),
        }));
    };

    const toggleFilePreview = (path) => {
        setCollapsedFiles((prev) => ({
            ...prev,
            [path]: !prev[path],
        }));
    };

    const handleCancel = () => {
        if (controller) {
            try { controller.abort(); } catch (e) {}
        }
        setIsThinking(false);
        setProgressStatus('Cancelled');
    };

    if (!isVisible) return null;

    const containerClass = docked
        ? 'h-full w-full min-w-0 max-w-full bg-transparent flex flex-col min-h-0'
        : 'fixed top-10 right-0 bottom-0 w-96 bg-[#0d0f12] border-l border-[#252830] rounded-l-lg shadow-2xl flex flex-col min-h-0 z-40';

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
            className={`${containerClass} ${isDragging ? 'ring-2 ring-[#8b5cf6]/50' : ''}`}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onPaste={handlePaste}
        >
            {/* Header */}
            <div className="flex flex-col border-b border-[#252830] bg-[#0d0f12]">
                <div className="flex items-center justify-between px-4 py-3 relative">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#8b5cf6] to-[#ec4899] flex items-center justify-center">
                                <Sparkles className="w-4 h-4 text-white" strokeWidth={2} />
                            </div>
                            <h2 className="text-sm font-semibold text-[#e8eaed]">AI Assistant</h2>
                        </div>
                        <div className="relative">
                            <Button
                                ref={modelButtonRef}
                                variant="ghost"
                                size="sm"
                                className="text-xs px-2.5 py-1.5 h-7 rounded-full bg-[#1a1d23] border border-[#252830] text-[#9ba1ab] hover:text-[#e8eaed] hover:border-[#8b5cf6] hover:bg-[#252830] transition-all"
                                onClick={() => setModelMenuOpen((v) => !v)}
                                title="Switch AI model"
                            >
                                <span className="flex items-center gap-1.5">
                                    {modelChoice === 'custom' ? 'Custom' : 'Gemini'}
                                    <ChevronDown className="w-3 h-3" />
                                </span>
                            </Button>
                            {modelMenuOpen && (
                                <div
                                    className="fixed w-72 bg-[#14161a] border border-[#252830] rounded-lg shadow-2xl z-[9999] p-3 space-y-3"
                                    style={{ top: modelMenuPos.top, left: modelMenuPos.left }}
                                >
                                    <div className="text-xs text-[#6b7280] font-semibold uppercase tracking-wider">Model selection</div>
                                    <div className="flex gap-2 text-xs text-[#e8eaed]">
                                        <button
                                            className={`flex-1 px-3 py-2 rounded-lg border transition-all ${modelChoice === 'gemini' ? 'border-[#8b5cf6] bg-[#8b5cf6]/10 text-[#a78bfa]' : 'border-[#252830] hover:border-[#3d4250] hover:bg-[#1a1d23]'}`}
                                            onClick={() => setModelChoice('gemini')}
                                        >
                                            Gemini (default)
                                        </button>
                                        <button
                                            className={`flex-1 px-3 py-2 rounded-lg border transition-all ${modelChoice === 'custom' ? 'border-[#8b5cf6] bg-[#8b5cf6]/10 text-[#a78bfa]' : 'border-[#252830] hover:border-[#3d4250] hover:bg-[#1a1d23]'}`}
                                            onClick={() => setModelChoice('custom')}
                                        >
                                            Custom
                                        </button>
                                    </div>
                                    {modelChoice === 'custom' && (
                                        <div className="space-y-3 pt-1">
                                            <div>
                                                <label className="block text-[11px] text-[#6b7280] mb-1.5 uppercase tracking-wider">Model ID</label>
                                                <Input
                                                    value={customModel}
                                                    onChange={(e) => setCustomModel(e.target.value)}
                                                    placeholder="e.g. gpt-4.1, gemini-1.5-pro"
                                                    className="text-xs bg-[#0d0f12] border-[#252830] focus:border-[#8b5cf6]"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-[11px] text-[#6b7280] mb-1.5 uppercase tracking-wider">API Key</label>
                                                <Input
                                                    type="password"
                                                    value={customApiKey}
                                                    onChange={(e) => setCustomApiKey(e.target.value)}
                                                    placeholder="Enter custom API key"
                                                    className="text-xs bg-[#0d0f12] border-[#252830] focus:border-[#8b5cf6]"
                                                />
                                            </div>
                                            <div className="text-[11px] text-[#6b7280] flex items-center gap-1.5">
                                                <Eye className="w-3 h-3" />
                                                Key stored locally in your browser
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {(suggestedCode || fileSuggestions.length > 0) && (
                            <div className="text-xs text-[#86efac] bg-[#86efac]/10 px-2 py-1 rounded-full">
                                {fileSuggestions.length > 0 ? `${fileSuggestions.length} file${fileSuggestions.length > 1 ? 's' : ''} ready` : 'Suggestion ready'}
                            </div>
                        )}
                        <button
                            onClick={onClose}
                            className="p-1.5 hover:bg-[#252830] rounded-lg transition-colors"
                            title="Close chat"
                        >
                            <X className="w-4 h-4 text-[#6b7280] hover:text-[#e8eaed]" strokeWidth={1.5} />
                        </button>
                    </div>
                </div>
                
                {/* Context Awareness Indicator */}
                {activeFile && (
                    <div className="px-4 pb-2">
                        <div className="flex items-center gap-1.5 text-[11px] text-[#6b7280]">
                            <Eye className="w-3 h-3" />
                            <span>Context:</span>
                            <span className="flex items-center gap-1 px-1.5 py-0.5 bg-[#1a1d23] rounded text-[#9ba1ab]">
                                <FileCode className="w-3 h-3" />
                                {activeFile.name || activeFile.path?.split('/').pop()}
                            </span>
                        </div>
                    </div>
                )}
                
                <div className="px-3 pb-2 flex items-center gap-2 overflow-x-auto">
                    {chatSessions.map((session) => {
                        const isActive = session.id === activeSession?.id;
                        return (
                            <button
                                key={session.id}
                                onClick={() => setActiveSessionId(session.id)}
                                className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-all ${
                                    isActive
                                        ? 'bg-[#8b5cf6]/15 border-[#8b5cf6] text-[#a78bfa]'
                                        : 'bg-[#14161a] border-[#252830] text-[#6b7280] hover:text-[#e8eaed] hover:border-[#3d4250]'
                                }`}
                            >
                                <span className="truncate max-w-[120px]">{session.title}</span>
                                {chatSessions.length > 1 && (
                                    <X
                                        className="w-3 h-3 text-[#6b7280] hover:text-[#e8eaed]"
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
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-dashed border-[#3f3f46] text-[#a1a1aa] hover:border-[#3b82f6] hover:text-[#3b82f6] transition-colors"
                        title="Start a new chat"
                    >
                        <Plus className="w-3 h-3" strokeWidth={1.5} />
                        New
                    </button>
                </div>
            </div>

            {/* Messages Area */}
            <ScrollArea ref={scrollRef} className="flex-1 px-4 py-3 min-h-0 min-w-0">
                <div className="space-y-4 min-w-0">
                    {timeline.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-48 text-center px-6">
                            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#8b5cf6]/20 to-[#ec4899]/20 flex items-center justify-center mb-4">
                                <Sparkles className="w-8 h-8 text-[#8b5cf6]" strokeWidth={1.5} />
                            </div>
                            <h3 className="text-sm font-medium text-[#e8eaed] mb-2">How can I help you?</h3>
                            <p className="text-xs text-[#6b7280] leading-relaxed">
                                Ask me to explain code, fix bugs, add features, or refactor your project.
                            </p>
                            {activeFile && (
                                <div className="mt-4 flex items-center gap-1.5 text-[11px] text-[#6b7280] bg-[#1a1d23] px-3 py-1.5 rounded-full">
                                    <Eye className="w-3 h-3" />
                                    <span>I can see: {activeFile.name || activeFile.path?.split('/').pop()}</span>
                                </div>
                            )}
                        </div>
                    ) : (
                        timeline.map((msg) => {
                            if (msg.role === 'progress') {
                                const expanded = msg.expanded !== false;
                                const statusLabel = msg.status === 'finished' ? 'Finished working' : msg.status === 'failed' ? 'Failed' : 'Working…';
                                return (
                                    <div key={msg.id} className="text-xs text-[#a1a1aa]">
                                        <button
                                            className="w-full flex items-center gap-2 text-left hover:text-[#e4e4e7] transition-colors"
                                            onClick={() => toggleProgressMessage(msg.id)}
                                        >
                                            {expanded ? <ChevronDown className="w-4 h-4" strokeWidth={1.5} /> : <ChevronRight className="w-4 h-4" strokeWidth={1.5} />}
                                            <div className="flex flex-col">
                                                <div className="font-semibold text-sm text-[#e4e4e7]">{statusLabel}</div>
                                                <div className="text-[11px] text-[#a1a1aa] leading-tight">
                                                    {summarizeLog(msg.logs)}
                                                </div>
                                            </div>
                                        </button>
                                        {expanded && (
                                            <div className="mt-2 space-y-2 text-[11px]">
                                                {(msg.logs || []).map((entry, idx) => {
                                                    return (
                                                        <div key={`${msg.id}-log-${idx}`} className="text-[#a1a1aa]">
                                                            <span className="block whitespace-normal break-words leading-snug">
                                                                {entry}
                                                            </span>
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
                                                        const collapsed = collapsedFiles[suggestion.path] === true;
                                                        return (
                                                        <div
                                                            key={`${suggestion.path}-${suggestion.status}-${idx}`}
                                                            className="px-3 py-3 bg-[#18181b] border border-[#27272a] rounded min-w-0 "
                                                            style={codeContainerStyle}
                                                        >
                                                            <div className="flex items-center justify-between gap-2 mb-3">
                                                                <div>
                                                                    <div className="text-sm font-medium text-[#e4e4e7] break-all">
                                                                        <button
                                                                            onClick={async () => {
                                                                                const parts = suggestion.path.split('/');
                                                                                const name = parts[parts.length - 1] || suggestion.path;
                                                                                try {
                                                                                    // Dispatch selection and wait for content payload
                                                                                    const action = await dispatch(selectFileThunk({ path: suggestion.path, name }));
                                                                                    const payload = action?.payload || null;

                                                                                    // Compute first changed line from suggestion chunks
                                                                                    const findFirstChangedLine = (chunks) => {
                                                                                        if (!Array.isArray(chunks)) return null;
                                                                                        for (const chunk of chunks) {
                                                                                            if (!chunk || !Array.isArray(chunk.rows)) continue;
                                                                                            for (const row of chunk.rows) {
                                                                                                if (!row) continue;
                                                                                                if (row.type === 'add' || row.type === 'rem') {
                                                                                                    // Prefer the new file line number when available
                                                                                                    const candidate = (typeof row.lineNew === 'number' && row.lineNew > 0) ? row.lineNew : (typeof row.lineOld === 'number' && row.lineOld > 0 ? row.lineOld : null);
                                                                                                    if (candidate) return candidate;
                                                                                                }
                                                                                            }
                                                                                        }
                                                                                        return null;
                                                                                    };

                                                                                    const targetLine = findFirstChangedLine(suggestion.chunks) || 1;

                                                                                    // Wait for the editor instance to mount with the selected content
                                                                                    if (editor && payload && typeof payload.content === 'string') {
                                                                                        const desiredContent = payload.content;
                                                                                        let attempts = 0;
                                                                                        const maxAttempts = 20; // ~1s total (20 * 50ms)
                                                                                        while (attempts < maxAttempts) {
                                                                                            try {
                                                                                                const model = editor.getModel && editor.getModel();
                                                                                                const current = model && typeof editor.getValue === 'function' ? editor.getValue() : null;
                                                                                                if (current !== null && current === desiredContent) {
                                                                                                    // Move cursor and reveal
                                                                                                    try {
                                                                                                        editor.revealLineInCenter && editor.revealLineInCenter(targetLine);
                                                                                                        editor.setPosition && editor.setPosition({ lineNumber: targetLine, column: 1 });
                                                                                                        editor.focus && editor.focus();
                                                                                                    } catch (e) { /* ignore */ }
                                                                                                    break;
                                                                                                }
                                                                                            } catch (e) {
                                                                                                // ignore transient errors
                                                                                            }
                                                                                            attempts += 1;
                                                                                            await new Promise(r => setTimeout(r, 50));
                                                                                        }
                                                                                    }
                                                                                } catch (e) {
                                                                                    // ignore
                                                                                }
                                                                            }}
                                                                            className="text-left w-full text-sm font-medium text-[#e4e4e7] hover:underline hover:text-[#3b82f6]"
                                                                        >
                                                                            {suggestion.path}
                                                                        </button>
                                                                    </div>
                                                                    <div className={`inline-flex mt-1 px-2 py-0.5 rounded-full text-[11px] ${fileSuggestionStatusClasses(suggestion.status)}`}>
                                                                        {badgeText}
                                                                    </div>
                                                                    <div className={`inline-flex mt-1 px-2 py-0.5 text-[11px] text-[#86efac]`}>
                                                                        {statsAddText} 
                                                                    </div>
                                                                    <div className={`inline-flex mt-1 py-0.5 text-[11px] text-[#f87171]`}>
                                                                        {statsRemText}
                                                                    </div>
                                                                </div>
                                                                <button
                                                                    className="text-[#a1a1aa] hover:text-[#e4e4e7] text-xs flex items-center gap-1"
                                                                    onClick={() => toggleFilePreview(suggestion.path)}
                                                                >
                                                                    {collapsed ? <ChevronRight className="w-4 h-4" strokeWidth={1.5} /> : <ChevronDown className="w-4 h-4" strokeWidth={1.5} />}
                                                                    {collapsed ? 'Show diff' : 'Hide diff'}
                                                                </button>
                                                                {suggestion.status === 'pending' && msg.role === 'suggestion-live' && (
                                                                    <div className="flex items-center gap-2 flex-wrap justify-end">
                                                                        {!suggestion.isNewFile && !suggestion.deleteFile && !suggestion.deleteFolder && !suggestion.isFolder && (
                                                                            <Button
                                                                                variant="secondary"
                                                                                size="sm"
                                                                                disabled={Boolean(suggestion.error)}
                                                                                onClick={() => handlePreviewFileSuggestion(activeSession?.id || activeSessionId, suggestion.path)}
                                                                            >
                                                                                Preview
                                                                            </Button>
                                                                        )}
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="sm"
                                                                            disabled={suggestion.status !== 'pending'}
                                                                            onClick={() => handleRejectFileSuggestion(activeSession?.id || activeSessionId, suggestion.path)}
                                                                        >
                                                                            Reject
                                                                        </Button>
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="sm"
                                                                            disabled={suggestion.status !== 'pending' || Boolean(suggestion.error)}
                                                                            onClick={() => handleApplyFileSuggestion(activeSession?.id || activeSessionId, suggestion.path)}
                                                                        >
                                                                            Apply
                                                                        </Button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {suggestion.error ? (
                                                                <div className="text-sm text-[#f87171] bg-[#f87171]/5 border border-[#f87171]/40 px-3 py-2 rounded">
                                                                    {suggestion.error}
                                                                </div>
                                                            ) : !collapsed ? (
                                                                <div
                                                                    className="max-h-[70vh] min-h-[140px] overflow-auto overflow-x-auto text-xs font-mono bg-[#09090b] rounded p-2 ai-diff-code min-w-0 w-full max-w-full"
                                                                    style={codeContainerStyle}
                                                                >
                                                                    {renderDiffChunkList(suggestion.chunks)}
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    );
                                                    })}
                                                </div>
                                            ) : snapshot.suggestedCode ? (
                                                <div className="px-2 py-2 bg-[#18181b] border border-[#27272a] rounded min-w-0">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <div className="text-sm font-medium text-[#e4e4e7]">Suggestion</div>
                                                        {snapshot.suggestedCode && msg.role === 'suggestion-live' && (
                                                            <div className="flex items-center gap-2">
                                                                {isLoading ? (
                                                                    <div className="flex items-center gap-2 text-xs text-[#a1a1aa]">
                                                                        <div className="w-3 h-3 rounded-full bg-[#a1a1aa] animate-pulse" aria-hidden></div>
                                                                        <span>Thinking...</span>
                                                                    </div>
                                                                ) : null}
                                                                <Button variant="secondary" size="sm" onClick={() => { setSuggestionExpanded(false); rejectSuggestion(); }}>Reject</Button>
                                                                <Button variant="default" size="sm" onClick={() => { setSuggestionExpanded(false); applySuggestion(); }}>Accept</Button>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center justify-between text-xs text-[#a1a1aa] mb-2">
                                                        <div>Preview</div>
                                                        <button
                                                            className="text-[#a1a1aa] hover:text-[#e4e4e7] flex items-center gap-1"
                                                            onClick={() => setSuggestionExpanded((v) => !v)}
                                                        >
                                                            {suggestionExpanded ? <ChevronDown className="w-4 h-4" strokeWidth={1.5} /> : <ChevronRight className="w-4 h-4" strokeWidth={1.5} />}
                                                            {suggestionExpanded ? 'Hide' : 'Show'}
                                                        </button>
                                                    </div>
                                                    {suggestionExpanded && (
                                                        <div className="max-h-[70vh] min-h-[140px] overflow-auto overflow-x-auto text-xs font-mono ai-diff-code min-w-0 w-full max-w-full rounded bg-[#09090b] border border-[#27272a] p-2">
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
                                                <div key={att.id || att.name} className="bg-[#18181b] border border-[#27272a] rounded p-2">
                                                    <div className="flex items-center justify-between text-xs text-[#a1a1aa] mb-1">
                                                        <span className="truncate max-w-[200px]">{att.name || 'Attachment'}</span>
                                                        {att.size ? <span className="text-[#52525b]">{att.size} bytes</span> : null}
                                                    </div>
                                                    {att.kind === 'image' && att.content ? (
                                                        <img
                                                            src={att.content}
                                                            alt={att.name || 'image'}
                                                            className="max-h-48 rounded border border-[#27272a]"
                                                        />
                                                    ) : att.kind === 'text' ? (
                                                        <pre className="text-[11px] whitespace-pre-wrap max-h-32 overflow-auto bg-[#09090b] rounded p-2">
                                                            {att.content?.slice(0, 2000) || ''}
                                                        </pre>
                                                    ) : (
                                                        <div className="text-[11px] text-[#a1a1aa] italic">Binary attachment</div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    <div
                                        className="break-normal whitespace-normal text-xs leading-relaxed ai-chat-content min-w-0"
                                        dangerouslySetInnerHTML={{ __html: formatMessageContent(msg.content) }}
                                    />
                                    <span className="text-xs opacity-70 mt-1 block">
                                        {formatTimestamp(msg.timestamp)}
                                    </span>
                                </>
                            );

                            if (isInlineSummary) {
                                return (
                                    <div key={msg.id} className="text-xs text-[#e4e4e7]">
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
                                        className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ai-chat-message min-w-0 ${
                                            msg.role === 'user'
                                                ? 'bg-[#3b82f6] text-white'
                                                : 'bg-[#18181b] text-[#e4e4e7] border border-[#27272a]'
                                        }`}
                                    >
                                        {baseContent}
                                    </div>
                                </div>
                            );
                        })
                    )}
                    {streamingMessage ? (
                        <div className="text-xs text-[#e4e4e7] whitespace-pre-wrap leading-relaxed">
                            {streamingMessage}
                        </div>
                    ) : null}
                    {showThinking && (
                        <div className="flex justify-start">
                            <div className={`bg-[#18181b] border border-[#27272a] px-3 py-2 rounded-lg transition-opacity duration-200 ${isThinking ? 'opacity-100' : 'opacity-0'}`}>
                                <ThinkingDots />
                            </div>
                        </div>
                    )}
                </div>
            </ScrollArea>

            {/* Input Area */}
            <div className="px-4 py-3 border-t border-[#27272a] bg-[#09090b]">
                {attachments.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                        {attachments.map((att) => (
                            <div key={att.id} className="flex items-center gap-2 bg-[#18181b] border border-[#27272a] px-2 py-1 rounded text-xs">
                                <span className="truncate max-w-[160px]">{att.name}</span>
                                <span className="text-[#a1a1aa]">{formatBytes(att.size)}</span>
                                <button
                                    onClick={() => removeAttachment(att.id)}
                                    className="p-1 text-[#a1a1aa] hover:text-[#e4e4e7]"
                                    title="Remove attachment"
                                >
                                    <X className="w-3 h-3" strokeWidth={1.5} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="flex gap-2">
                    <textarea
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder="Ask AI for suggestions... (Enter to send)"
                        disabled={isLoading || !clientReady}
                        className="flex-1 min-h-[42px] max-h-[140px] resize-y overflow-auto placeholder:text-[#52525b] w-full min-w-0 rounded-md border border-[#3f3f46] bg-[#18181b] px-3 py-2 text-base text-[#e4e4e7] shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-[#3b82f6] focus-visible:ring-[#3b82f6]/50 focus-visible:ring-[3px]"
                        rows={1}
                        style={{ minHeight: '42px', maxHeight: '140px' }}
                    />
                    {controller ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={handleCancel}
                            className="text-xs"
                            title="Cancel generation"
                        >
                            Cancel
                        </Button>
                    ) : null}
                    <Button
                        onClick={handleSubmit}
                        disabled={!inputValue.trim() || isLoading || !clientReady}
                        title="Send message (Enter)"
                    >
                        <Send className="w-4 h-4" strokeWidth={1.5} />
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default AIChatWindow;