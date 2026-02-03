'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, X, Plus, ChevronDown, ChevronRight, Sparkles, FileCode, Paperclip } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { selectFileThunk } from '@/redux/workspaceSlice';
import { selectFileCacheEntries } from '@/redux/workspaceSlice';
import { useChatSessions } from './hooks/useChatSessions';
import { useChatInput } from './hooks/useChatInput';
import { useAISuggestions } from './hooks/useAISuggestions';
import { useCodeIntelMetrics } from '@/hooks/useCodeIntelMetrics';
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
    const fileInputRef = useRef(null);
    const dispatch = useAppDispatch();
    const fileCacheEntries = useAppSelector(selectFileCacheEntries);
    const workspaceSlug = useAppSelector((state) => state.workspace.slug);
    const rawFiles = useAppSelector((state) => state.workspace.rawFiles || []);
    const { metrics: codeIntelMetrics, isLoading: isMetricsLoading, error: metricsError, refresh: refreshMetrics } = useCodeIntelMetrics({
        workspacePath: workspaceSlug,
        enabled: isVisible,
        pollMs: 12000,
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
        handleFilesSelected,
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
            try { controller.abort(); } catch (e) { }
        }
        setIsThinking(false);
        setProgressStatus('Cancelled');
    };

    if (!isVisible) return null;

    const containerClass = docked
        ? 'h-full w-full min-w-0 max-w-full bg-transparent flex flex-col min-h-0'
        : 'fixed top-10 right-0 bottom-0 w-80 bg-[#0a0b10] border-l-2 border-[#1a1b24] shadow-2xl flex flex-col min-h-0 z-40';

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
            {/* Header - Clear hierarchy with stronger separation */}
            <div className="flex flex-col border-b-2 border-[#1a1b24] bg-[#08090d]">
                <div className="flex items-center justify-end px-3 py-2.5 relative">
                    <div className="flex items-center gap-2">
                        {(suggestedCode || fileSuggestions.length > 0) && (
                            <div className="text-[10px] font-medium text-[#4aba9a] bg-[#3a857420] px-2 py-0.5 rounded-full">
                                {fileSuggestions.length > 0 ? `${fileSuggestions.length} file${fileSuggestions.length > 1 ? 's' : ''}` : 'Ready'}
                            </div>
                        )}
                        <button
                            onClick={onClose}
                            className="p-1 hover:bg-[#1a1b24] rounded-md transition-colors"
                            title="Close chat"
                        >
                            <X className="w-4 h-4 text-[#5a6178] hover:text-[#9ba2b8]" strokeWidth={1.5} />
                        </button>
                    </div>
                </div>

                {isVisible && (
                    <div className="mx-3 mb-2 rounded-md border border-[#1a1b24] bg-[#0b0c11] px-2.5 py-1.5 text-[10px] text-[#9ba2b8]">
                        <div className="flex items-center justify-between gap-2">
                            <div className="font-semibold uppercase tracking-[0.2em] text-[9px] text-[#6b7280]">
                                Code Intel
                            </div>
                            <button
                                onClick={refreshMetrics}
                                className="text-[9px] uppercase tracking-[0.18em] text-[#5a6178] hover:text-[#9ba2b8]"
                                title="Refresh metrics"
                            >
                                Refresh
                            </button>
                        </div>
                        {metricsError && (
                            <div className="mt-1 text-[10px] text-rose-400">{metricsError}</div>
                        )}
                        {!metricsError && (
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                                <span className="text-[#8b93a7]">p95:</span>
                                {Object.entries(codeIntelMetrics?.latency || {}).map(([stage, vals]) => (
                                    <span key={stage} className="text-[#c7ccd9]">
                                        {stage} {Math.round(vals?.p95 || 0)}ms
                                    </span>
                                ))}
                                <span className="text-[#8b93a7]">counters:</span>
                                {Object.entries(codeIntelMetrics?.counters || {}).map(([k, v]) => (
                                    <span key={k} className="text-[#c7ccd9]">
                                        {k}:{v}
                                    </span>
                                ))}
                                <span className="text-[#8b93a7]">budgets:</span>
                                {Object.entries(codeIntelMetrics?.budgets || {}).map(([k, v]) => (
                                    <span key={k} className="text-[#c7ccd9]">
                                        {k}:{v}
                                    </span>
                                ))}
                                {codeIntelMetrics?.index_generation && (
                                    <span className="text-[#8b93a7]">gen:{codeIntelMetrics.index_generation}</span>
                                )}
                                {isMetricsLoading && (
                                    <span className="text-[#5a6178]">loading…</span>
                                )}
                            </div>
                        )}
                    </div>
                )}

                <div className="px-2 pb-2 flex items-center gap-1.5 overflow-x-auto">
                    {chatSessions.map((session) => {
                        const isActive = session.id === activeSession?.id;
                        return (
                            <button
                                key={session.id}
                                onClick={() => setActiveSessionId(session.id)}
                                className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] border transition-all ${isActive
                                        ? 'bg-[#3a857418] border-[#3a8574] text-[#4aba9a] font-medium'
                                        : 'bg-transparent border-[#1a1b24] text-[#5a6178] hover:text-[#9ba2b8] hover:border-[#2a2b38] opacity-60 hover:opacity-100'
                                    }`}
                            >
                                <span className="truncate max-w-[100px]">{session.title}</span>
                                {chatSessions.length > 1 && (
                                    <X
                                        className="w-2.5 h-2.5 text-[#5a6178] hover:text-[#9ba2b8]"
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
                        className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-md border border-dashed border-[#2a2b38] text-[#5a6178] hover:border-[#3a8574] hover:text-[#4aba9a] transition-colors opacity-60 hover:opacity-100"
                        title="Start a new chat"
                    >
                        <Plus className="w-3 h-3" strokeWidth={1.5} />
                        New
                    </button>
                </div>
            </div>

            {/* Messages Area */}
            <ScrollArea ref={scrollRef} className="flex-1 px-3 py-3 min-h-0 min-w-0 bg-[#08090d]">
                <div className="space-y-3 min-w-0">
                    {timeline.length === 0 ? (
                        <div className="flex flex-col items-start justify-center h-40 px-1 pt-4">
                            <h3 className="text-sm font-semibold text-[#f4f5f8] mb-1.5">What can I help with?</h3>
                            <p className="text-[11px] text-[#5a6178] leading-relaxed">
                                Explain code, fix bugs, add features, or refactor.
                            </p>
                        </div>
                    ) : (
                        timeline.map((msg) => {
                            if (msg.role === 'progress') {
                                const expanded = msg.expanded === true;
                                const isFinished = msg.status === 'finished';
                                const isFailed = msg.status === 'failed';
                                const statusLabel = isFinished ? 'Completed' : isFailed ? 'Failed' : 'Working…';
                                const statusColor = isFinished ? 'text-emerald-400' : isFailed ? 'text-rose-400' : 'text-amber-400';
                                const statusBg = isFinished ? 'bg-emerald-500/10' : isFailed ? 'bg-rose-500/10' : 'bg-amber-500/10';
                                const statusBorder = isFinished ? 'border-emerald-500/30' : isFailed ? 'border-rose-500/30' : 'border-amber-500/30';
                                return (
                                    <div key={msg.id} className={`text-xs font-mono rounded-md border ${statusBorder} ${statusBg} overflow-hidden`}>
                                        <button
                                            className={`w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors`}
                                            onClick={() => toggleProgressMessage(msg.id)}
                                        >
                                            {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[#71717a]" strokeWidth={2} /> : <ChevronRight className="w-3.5 h-3.5 text-[#71717a]" strokeWidth={2} />}
                                            <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${statusColor}`}>
                                                {isFinished && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>}
                                                {isFailed && <span className="w-1.5 h-1.5 rounded-full bg-rose-400"></span>}
                                                {!isFinished && !isFailed && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>}
                                                {statusLabel}
                                            </span>
                                            <span className="text-[10px] text-[#71717a] truncate flex-1">{summarizeLog(msg.logs)}</span>
                                        </button>
                                        {expanded && (
                                            <div className="px-3 pb-2 pt-1 space-y-1 border-t border-[#27272a]/50 bg-black/20">
                                                {(msg.logs || []).map((entry, idx) => {
                                                    return (
                                                        <div key={`${msg.id}-log-${idx}`} className="text-[10px] text-[#71717a] font-mono">
                                                            <span className="block whitespace-normal break-words leading-relaxed">
                                                                <span className="text-[#52525b] select-none">›</span> {entry}
                                                            </span>
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
                                    <div key={msg.id} className="text-xs rounded-md border border-[#2a2b38] bg-[#0d0d11] px-3 py-2">
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="flex items-center gap-2">
                                                <FileCode className="w-3.5 h-3.5 text-[#4aba9a]" />
                                                <span className="text-[11px] uppercase tracking-wide text-[#9ba2b8]">Context used</span>
                                            </div>
                                            {meta.traceSummary ? (
                                                <span className="text-[10px] text-[#71717a] truncate max-w-[220px]">{meta.traceSummary}</span>
                                            ) : null}
                                        </div>
                                        {sources.length > 0 && (
                                            <div className="mt-2 space-y-1">
                                                {sources.map((src, idx) => {
                                                    const file = src?.file || 'unknown';
                                                    const symbol = src?.symbol ? ` · ${src.symbol}` : '';
                                                    const lineInfo = src?.start_line && src?.end_line
                                                        ? ` (L${src.start_line}-${src.end_line})`
                                                        : '';
                                                    return (
                                                        <div key={`${file}-${idx}`} className="text-[11px] text-[#c7c9d1] font-mono truncate">
                                                            {file}{lineInfo}{symbol}
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
                                                                className="rounded-lg border border-[#2f2f35] bg-[#0d0d11] overflow-hidden min-w-0 shadow-[0_8px_24px_rgba(0,0,0,0.28)]"
                                                                style={codeContainerStyle}
                                                            >
                                                                {/* File header - visually dominant */}
                                                                <div className="flex items-center justify-between gap-3 px-3 py-2 bg-[#141418] border-b border-[#1f1f23]">
                                                                    <div className="flex items-center gap-3 min-w-0 flex-1">
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
                                                                            className="text-left font-mono text-[13px] font-semibold text-[#e4e4e7] hover:text-[#4aba9a] truncate transition-colors"
                                                                            title={suggestion.path}
                                                                        >
                                                                            {suggestion.path}
                                                                        </button>
                                                                        {/* Stats - more prominent */}
                                                                        <div className="flex items-center gap-1.5 flex-shrink-0">
                                                                            <span className="font-mono text-xs font-semibold text-emerald-400 bg-emerald-500/15 px-1.5 py-0.5 rounded">{statsAddText}</span>
                                                                            <span className="font-mono text-xs font-semibold text-rose-400 bg-rose-500/15 px-1.5 py-0.5 rounded">{statsRemText}</span>
                                                                        </div>
                                                                    </div>
                                                                    {/* Status badge */}
                                                                    <div className={`flex-shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide opacity-80 ${fileSuggestionStatusClasses(suggestion.status)}`}>
                                                                        {badgeText}
                                                                    </div>
                                                                </div>
                                                                {/* Actions bar */}
                                                                <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-[#111116] border-b border-[#1c1c20]">
                                                                    <button
                                                                        className="text-[#71717a] hover:text-[#e4e4e7] text-xs flex items-center gap-1 font-medium transition-colors"
                                                                        onClick={() => toggleFilePreview(suggestion.path)}
                                                                    >
                                                                        {collapsed ? <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} /> : <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} />}
                                                                        {collapsed ? 'Show diff' : 'Hide diff'}
                                                                    </button>
                                                                    {suggestion.status === 'pending' && msg.role === 'suggestion-live' && (
                                                                        <div className="flex items-center gap-4">
                                                                            {/* Preview - tertiary (very passive) */}
                                                                            {!suggestion.isNewFile && !suggestion.deleteFile && !suggestion.deleteFolder && !suggestion.isFolder && (
                                                                                <button
                                                                                    disabled={Boolean(suggestion.error)}
                                                                                    onClick={() => handlePreviewFileSuggestion(activeSession?.id || activeSessionId, suggestion.path)}
                                                                                    className="text-[11px] font-medium text-[#6b7280] hover:text-[#9ca3af] px-1.5 py-1 rounded disabled:opacity-40 disabled:cursor-not-allowed"
                                                                                >
                                                                                    Preview
                                                                                </button>
                                                                            )}
                                                                            {/* Reject - neutral */}
                                                                            <button
                                                                                disabled={suggestion.status !== 'pending'}
                                                                                onClick={() => handleRejectFileSuggestion(activeSession?.id || activeSessionId, suggestion.path)}
                                                                                className="text-[11px] font-semibold text-red-500 opacity-75 py-1 rounded-md hover:border-[#3a3b41] bg-transparent hover:-translate-y-1 cursor-pointer hover:underline duration-300 hover:opacity-100 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                                                                            >
                                                                                Reject
                                                                            </button>
                                                                            {/* Apply - primary (filled, dangerous feel) */}
                                                                            <button
                                                                                disabled={suggestion.status !== 'pending' || Boolean(suggestion.error)}
                                                                                onClick={() => handleApplyFileSuggestion(activeSession?.id || activeSessionId, suggestion.path)}
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
                                                                        className="max-h-[45vh] min-h-[80px] overflow-auto overflow-x-auto text-xs font-mono bg-[#09090b] ai-diff-code min-w-0 w-full max-w-full"
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
                                                <div className="rounded-lg border border-[#2f2f35] bg-[#0d0d11] overflow-hidden min-w-0 shadow-[0_8px_24px_rgba(0,0,0,0.28)]">
                                                    {/* Header */}
                                                    <div className="flex items-center justify-between px-3 py-2 bg-[#141418] border-b border-[#1f1f23]">
                                                        <div className="flex items-center gap-2">
                                                            <Sparkles className="w-4 h-4 text-[#4aba9a]" />
                                                            <span className="text-[13px] font-semibold text-[#e4e4e7]">AI Suggestion</span>
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
                                                                    onClick={() => { setSuggestionExpanded(false); rejectSuggestion(); }}
                                                                    className="text-[11px] font-semibold text-red-500 px-2.5 py-1.25 rounded-md border border-[#2f3035] hover:border-[#3a3b41] bg-transparent hover:bg-[#18181f] transition-all"
                                                                >
                                                                    Reject
                                                                </button>
                                                                {/* Apply - primary */}
                                                                <button
                                                                    onClick={() => { setSuggestionExpanded(false); applySuggestion(); }}
                                                                    className="text-xs font-semibold px-4 text-emerald-400 py-1.5 rounded-md bg-[#4aba9a] hover:bg-[#3da88a] border border-[#4aba9a] shadow-sm shadow-[#4aba9a]/20 transition-all"
                                                                >
                                                                    Apply
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                    {/* Toggle bar */}
                                                    <div className="flex items-center justify-between px-3 py-1.5 bg-[#111116] border-b border-[#1c1c20]">
                                                        <span className="text-[11px] text-[#71717a] font-medium">Preview diff</span>
                                                        <button
                                                            className="text-[#71717a] hover:text-[#e4e4e7] text-xs flex items-center gap-1 font-medium transition-colors"
                                                            onClick={() => setSuggestionExpanded((v) => !v)}
                                                        >
                                                            {suggestionExpanded ? <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} /> : <ChevronRight className="w-3.5 h-3.5" strokeWidth={2} />}
                                                            {suggestionExpanded ? 'Hide' : 'Show'}
                                                        </button>
                                                    </div>
                                                    {/* Diff content */}
                                                    {suggestionExpanded && (
                                                        <div className="max-h-[45vh] min-h-[80px] overflow-auto overflow-x-auto text-xs font-mono ai-diff-code min-w-0 w-full max-w-full bg-[#09090b]">
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
                                    <span className="text-[10px] text-[#52525b] mt-1.5 block">
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
                                        className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ai-chat-message min-w-0 ${msg.role === 'user'
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

            {/* Input Area - Cleaner, less visually heavy */}
            <div className="px-3 py-2.5 bg-[#08090d] border-t border-[#1a1b24]">
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
                        };
                        return map[ext] || { label: ext ? ext.toUpperCase().slice(0, 4) : 'FILE', color: '#9ba2b8' };
                    };

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
                        <div className="mb-2 grid grid-cols-2 gap-1.5">
                            {chips.map((chip) => {
                                const meta = buildLanguageMeta(chip.name || '');
                                return (
                                    <div
                                        key={chip.id}
                                        className="flex items-center gap-1.5 bg-[#101118] border border-[#1a1b24] px-2 py-1 rounded text-[10px] min-w-0"
                                    >
                                        <span
                                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                                            style={{ color: meta.color, backgroundColor: `${meta.color}20` }}
                                        >
                                            <FileCode className="w-3 h-3" strokeWidth={1.5} />
                                            <span className="font-semibold">{meta.label}</span>
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <span className="truncate text-[#e4e4e7] block leading-tight">
                                                {chip.isContext ? <span className="italic">{chip.name}</span> : chip.name}
                                            </span>
                                            {chip.size ? (
                                                <span className="text-[#5a6178] whitespace-nowrap">{formatBytes(chip.size)}</span>
                                            ) : null}
                                        </div>
                                        {!chip.isContext ? (
                                            <button
                                                onClick={() => removeAttachment(chip.id)}
                                                className="p-0.5 text-[#5a6178] hover:text-[#9ba2b8]"
                                                title="Remove attachment"
                                            >
                                                <X className="w-2.5 h-2.5" strokeWidth={1.5} />
                                            </button>
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                    );
                })()}
                <div className="flex gap-2">
                    <div className="flex-1 flex flex-col gap-0 border border-[#2a2b38] rounded-lg bg-[#0c0d12] overflow-hidden focus-within:border-[#3a8574] focus-within:ring-2 focus-within:ring-[#3a8574]/30 transition-[border-color,box-shadow]">
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
                            placeholder="Describe your task..."
                            disabled={isLoading || !clientReady}
                            className="w-full min-h-[38px] max-h-[120px] resize-none overflow-y-auto placeholder:text-[#3d4256] min-w-0 border-none bg-transparent px-3 pt-2 pb-2 text-[13px] text-[#f4f5f8] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50"
                            rows={1}
                            style={{ height: '38px', maxHeight: '120px' }}
                        />
                        <div className="flex items-center px-2 pb-2 relative">
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled
                                className="text-xs px-2.5 py-1 h-6 rounded-md bg-transparent border-none text-[#6b7280] hover:text-[#9ba1ab] transition-colors"
                                title="Agent selection (coming soon)"
                            >
                                <span className="flex items-center gap-1.5">
                                    Agent
                                    <ChevronDown className="w-3 h-3 transition-transform duration-200 animate-bounce-subtle" />
                                </span>
                            </Button>
                            <Popover open={modelMenuOpen} onOpenChange={setModelMenuOpen}>
                                <PopoverTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs px-2.5 py-1 h-6 rounded-md bg-transparent border-none text-[#9ba1ab] hover:text-[#e8eaed] transition-colors"
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
                                    className="w-72 mr-6 bg-[#14161a] border-none p-3 space-y-3"
                                    side="top"
                                    align="start"
                                    sideOffset={10}
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
                                </PopoverContent>
                            </Popover>
                            <div className='inline-block absolute right-2'>
                                {controller ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={handleCancel}
                                        className="text-xs h-6 px-2"
                                        title="Cancel generation"
                                    >
                                        Cancel
                                    </Button>
                                ) : null}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => fileInputRef.current?.click()}
                                    className="text-xs h-6 px-2"
                                    title="Attach files"
                                >
                                    <Paperclip className="w-3.5 h-3.5" strokeWidth={2} />
                                </Button>
                                <Button
                                    onClick={handleSubmit}
                                    disabled={!inputValue.trim() || isLoading || !clientReady}
                                    title="Send message (Enter)"
                                    size="sm"
                                    className="h-6 w-6 p-0 bg-transparent text-[#327464]"
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