'use client';

import { useEffect, useRef } from 'react';
import { Send, X, Plus } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { selectFileCacheEntries } from '@/redux/workspaceSlice';
import { useChatSessions } from './hooks/useChatSessions';
import { useChatInput } from './hooks/useChatInput';
import { useAISuggestions } from './hooks/useAISuggestions';
import { renderDiffChunkList, diffStats } from './utils/diffUtils';
import { fileSuggestionStatusClasses, fileSuggestionStatusLabel } from './utils/fileSuggestionsUtils';
import { formatMessageContent } from './utils/formatMessage';

const formatTimestamp = (timestamp) => {
    if (!timestamp) return '';
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    });

    const { inputValue, setInputValue, handleKeyPress, handleSubmit } = useChatInput((value) => {
        handleSendMessage(value);
        setInputValue('');
    });

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
                scrollArea.scrollTop = scrollArea.scrollHeight;
            }
        }
    }, [messages, suggestedCode, fileSuggestions]);

    if (!isVisible) return null;

    const containerClass = docked
        ? 'h-full w-full bg-transparent flex flex-col min-h-0'
        : 'fixed top-10 right-0 bottom-0 w-96 bg-[#1e1e1e] border-l border-[#545454] rounded-l-lg shadow-2xl flex flex-col min-h-0 z-40';

    return (
        <div className={containerClass}>
            {/* Header */}
            <div className="flex flex-col border-b border-[#545454] bg-[#252526]">
                <div className="flex items-center justify-between px-4 py-3">
                    <h2 className="text-sm font-semibold text-gray-200">AI Assistant</h2>
                    <div className="flex items-center gap-2">
                        {(suggestedCode || fileSuggestions.length > 0) && (
                            <div className="text-xs text-gray-300">
                                {fileSuggestions.length > 0 ? `${fileSuggestions.length} file${fileSuggestions.length > 1 ? 's' : ''} ready` : 'Suggestion ready'}
                            </div>
                        )}
                        <button
                            onClick={onClose}
                            className="p-1 hover:bg-[#3e3e42] rounded transition-colors"
                            title="Close chat"
                        >
                            <X className="w-4 h-4 text-gray-400" />
                        </button>
                    </div>
                </div>
                <div className="px-3 pb-2 flex items-center gap-2 overflow-x-auto">
                    {chatSessions.map((session) => {
                        const isActive = session.id === activeSession?.id;
                        return (
                            <button
                                key={session.id}
                                onClick={() => setActiveSessionId(session.id)}
                                className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs border transition-colors ${
                                    isActive
                                        ? 'bg-emerald-600/15 border-emerald-500 text-emerald-200'
                                        : 'bg-[#1e1e1e] border-[#2f2f2f] text-gray-400 hover:text-gray-200'
                                }`}
                            >
                                <span className="truncate max-w-[120px]">{session.title}</span>
                                {chatSessions.length > 1 && (
                                    <X
                                        className="w-3 h-3 text-gray-400 hover:text-gray-200"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleCloseSession(session.id);
                                        }}
                                    />
                                )}
                            </button>
                        );
                    })}
                    <button
                        onClick={handleNewSession}
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-dashed border-[#3a3a3a] text-gray-300 hover:border-emerald-500 hover:text-emerald-200 transition-colors"
                        title="Start a new chat"
                    >
                        <Plus className="w-3 h-3" />
                        New
                    </button>
                </div>
            </div>

            {/* Messages Area */}
            <ScrollArea ref={scrollRef} className="flex-1 px-4 py-2 min-h-0">
                <div className="space-y-3">
                    {timeline.length === 0 ? (
                        <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
                            <p>Start a conversation with the AI assistant</p>
                        </div>
                    ) : (
                        timeline.map((msg) => {
                            if (msg.role === 'suggestion-live' || msg.role === 'suggestion-history') {
                                const snapshot = msg.snapshot || {};
                                const hasFiles = (snapshot.fileSuggestions || []).length > 0;
                                return (
                                    <div key={msg.id} className="flex justify-start">
                                        <div className="w-full">
                                            {hasFiles ? (
                                                <div className="space-y-3">
                                                    {snapshot.fileSuggestions.map((suggestion) => {
                                                        const stats = diffStats(suggestion.chunks);
                                                        const badgeText = `${fileSuggestionStatusLabel(suggestion.status)}`;
                                                        const statsAddText = `+${stats.adds}`;
                                                        const statsRemText = `-${stats.removals}`;
                                                        return (
                                                        <div key={suggestion.path} className="px-3 py-3 bg-[#171717] border border-[#3a3a3a] rounded">
                                                            <div className="flex items-center justify-between gap-2 mb-3">
                                                                <div>
                                                                    <div className="text-sm font-medium text-gray-100 break-all">{suggestion.path}</div>
                                                                    <div className={`inline-flex mt-1 px-2 py-0.5 rounded-full text-[11px] ${fileSuggestionStatusClasses(suggestion.status)}`}>
                                                                        {badgeText}
                                                                    </div>
                                                                    <div className={`inline-flex mt-1 px-2 py-0.5 text-[11px] text-emerald-400`}>
                                                                        {statsAddText} 
                                                                    </div>
                                                                    <div className={`inline-flex mt-1 py-0.5 text-[11px] text-rose-400`}>
                                                                        {statsRemText}
                                                                    </div>
                                                                </div>
                                                                {suggestion.status === 'pending' && msg.role === 'suggestion-live' && (
                                                                    <div className="flex items-center gap-2 flex-wrap justify-end">
                                                                        <Button
                                                                            variant="secondary"
                                                                            size="sm"
                                                                            disabled={Boolean(suggestion.error)}
                                                                            onClick={() => handlePreviewFileSuggestion(activeSession?.id || activeSessionId, suggestion.path)}
                                                                        >
                                                                            Preview
                                                                        </Button>
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
                                                                <div className="text-sm text-rose-300 bg-rose-500/5 border border-rose-500/40 px-3 py-2 rounded">
                                                                    {suggestion.error}
                                                                </div>
                                                            ) : (
                                                                <div className="max-h-[55vh] overflow-auto overflow-x-auto text-xs font-mono bg-[#0f0f10] rounded p-2">
                                                                    {renderDiffChunkList(suggestion.chunks)}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                    })}
                                                </div>
                                            ) : snapshot.suggestedCode ? (
                                                <div className="px-2 py-2 bg-[#171717] border border-[#3a3a3a] rounded">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <div className="text-sm font-medium text-gray-200">Suggestion</div>
                                                        {snapshot.suggestedCode && msg.role === 'suggestion-live' && (
                                                            <div className="flex items-center gap-2">
                                                                {isLoading ? (
                                                                    <div className="flex items-center gap-2 text-xs text-gray-300">
                                                                        <div className="w-3 h-3 rounded-full bg-gray-400 animate-pulse" aria-hidden></div>
                                                                        <span>Thinking...</span>
                                                                    </div>
                                                                ) : null}
                                                                <Button variant="secondary" size="sm" onClick={rejectSuggestion}>Reject</Button>
                                                                <Button variant="default" size="sm" onClick={applySuggestion}>Accept</Button>
                                                            </div>
                                                        )}
                                                    </div>

                                                    <div className="max-h-[55vh] overflow-auto text-xs font-mono">
                                                        {renderDiffChunkList(snapshot.diffChunks || [])}
                                                    </div>
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>
                                );
                            }

                            return (
                                <div
                                    key={msg.id}
                                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                    <div
                                        className={`max-w-[80%] px-3 py-2 rounded-lg text-sm ${
                                            msg.role === 'user'
                                                ? 'bg-emerald-600 text-white'
                                                : 'bg-[#2d2d30] text-gray-200 border border-[#454545]'
                                        }`}
                                    >
                                        <div
                                            className="break-normal whitespace-normal text-xs leading-relaxed"
                                            dangerouslySetInnerHTML={{ __html: formatMessageContent(msg.content) }}
                                        />
                                        <span className="text-xs opacity-70 mt-1 block">
                                            {formatTimestamp(msg.timestamp)}
                                        </span>
                                    </div>
                                </div>
                            );
                        })
                    )}
                    {isLoading && (
                        <div className="flex justify-start">
                            <div className="bg-[#2d2d30] border border-[#454545] px-3 py-2 rounded-lg">
                                <div className="flex space-x-2">
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse"></div>
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-100"></div>
                                    <div className="w-2 h-2 bg-gray-500 rounded-full animate-pulse delay-200"></div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </ScrollArea>

            {/* Input Area */}
            <div className="px-4 py-3 border-t border-[#545454] bg-[#252526]">
                <div className="flex gap-2">
                    <Input
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder="Ask AI for suggestions... (Enter to send)"
                        disabled={isLoading || !clientReady}
                        className="flex-1"
                    />
                    <Button
                        onClick={handleSubmit}
                        disabled={!inputValue.trim() || isLoading || !clientReady}
                        title="Send message (Enter)"
                    >
                        <Send className="w-4 h-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default AIChatWindow;
