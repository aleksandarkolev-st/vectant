'use client';

import { useState, useRef, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { Send, X, Plus } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { getFileLanguage } from '@/utils/fileUtils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { diffLines, applyPatch } from 'diff';

const createChatSession = (index = 1) => ({
    id: `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: `Chat ${index}`,
    messages: [],
    suggestedCode: null,
    showDiff: true,
});

const AIChatWindow = ({ onClose, isVisible = true, activeFile, currentCode, editor = null, docked = false, onSuggest = null, onBusy = null }) => {
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef(null);
    const { askAi, clientReady } = useAnalyzerGateway();
    const sessionCounterRef = useRef(2);
    const initialSessionRef = useRef(createChatSession(1));
    const [chatSessions, setChatSessions] = useState([initialSessionRef.current]);
    const [activeSessionId, setActiveSessionId] = useState(initialSessionRef.current.id);
    const activeSession = chatSessions.find((session) => session.id === activeSessionId) || chatSessions[0] || null;
    const messages = activeSession?.messages ?? [];
    const suggestedCode = activeSession?.suggestedCode ?? null;
    const showDiff = activeSession?.showDiff ?? true;

    const mutateSession = (sessionId, mutator) => {
        setChatSessions((prev) =>
            prev.map((session) => {
                if (session.id !== sessionId) return session;
                return mutator(session);
            })
        );
    };

    const appendMessagesToSession = (sessionId, newMessages) => {
        mutateSession(sessionId, (session) => ({
            ...session,
            messages: [...session.messages, ...newMessages],
        }));
    };

    const handleNewSession = () => {
        const newSession = createChatSession(sessionCounterRef.current);
        sessionCounterRef.current += 1;
        setChatSessions((prev) => [...prev, newSession]);
        setActiveSessionId(newSession.id);
    };

    const handleCloseSession = (sessionId) => {
        if (chatSessions.length <= 1) return;
        setChatSessions((prev) => {
            const filtered = prev.filter((session) => session.id !== sessionId);
            if (activeSessionId === sessionId) {
                const fallback = filtered[filtered.length - 1]?.id ?? filtered[0]?.id ?? null;
                setActiveSessionId(fallback);
            }
            return filtered.length ? filtered : [createChatSession(1)];
        });
    };

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        if (scrollRef.current) {
            const scrollArea = scrollRef.current.querySelector('[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]');
            if (scrollArea) {
                scrollArea.scrollTop = scrollArea.scrollHeight;
            }
        }
    }, [messages, suggestedCode]);

    const extractCodeFromMarkdown = (text) => {
        if (!text) return null;
        // 1) fenced code block
        const fenceRe = /```(?:\w+)?\n([\s\S]*?)```/m;
        let m = text.match(fenceRe);
        if (m && m[1]) return m[1].replace(/\r/g, '');

        // 2) <pre><code>...</code></pre> or <code>...</code>
        const preCodeRe = /<pre[^>]*>[\s\S]*?<code[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/i;
        m = text.match(preCodeRe);
        if (m && m[1]) return m[1].replace(/\r/g, '');

        const codeTagRe = /<code[^>]*>([\s\S]*?)<\/code>/i;
        m = text.match(codeTagRe);
        if (m && m[1]) return m[1].replace(/\r/g, '');

        // 3) fallback: if the whole message looks like plain code, return it
        if (!/[<>]/.test(text) && text.split('\n').length > 3) return text.replace(/\r/g, '');

        return null;
    };

    // Compute a compact diff with line numbers and collapsed equal blocks using `diff`.
    const computeDiffChunks = (oldStr = '', newStr = '') => {
        const parts = diffLines(oldStr, newStr);
        const rows = [];
        let oldLine = 1;
        let newLine = 1;

        parts.forEach((part) => {
            // Split into lines and drop a final empty line caused by trailing newline
            const lines = part.value.split('\n');
            if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

            lines.forEach((line) => {
                if (part.added) {
                    rows.push({ type: 'add', lineNew: newLine, text: line });
                    newLine++;
                } else if (part.removed) {
                    rows.push({ type: 'rem', lineOld: oldLine, text: line });
                    oldLine++;
                } else {
                    rows.push({ type: 'eq', lineOld: oldLine, lineNew: newLine, text: line });
                    oldLine++;
                    newLine++;
                }
            });
        });

        // Collapse long equal sequences into elided chunks for readability
        const chunks = [];
        let i = 0;
        while (i < rows.length) {
            if (rows[i].type !== 'eq') {
                chunks.push({ type: rows[i].type, items: [rows[i]] });
                i++;
                continue;
            }

            const start = i;
            while (i < rows.length && rows[i].type === 'eq') i++;
            const items = rows.slice(start, i);
            const count = items.length;
            if (count > 8) {
                const head = items.slice(0, 2);
                const tail = items.slice(-2);
                chunks.push({ type: 'eq-elide', head, tail, elidedCount: count - 4 });
            } else {
                chunks.push({ type: 'eq', items });
            }
        }

        return chunks;
    };

    const handleSendMessage = async () => {
        if (!inputValue.trim()) return;

        if (!activeSession) return;

        const userMessage = {
            id: Date.now(),
            role: 'user',
            content: inputValue,
            timestamp: new Date(),
        };

        appendMessagesToSession(activeSession.id, [userMessage]);
        setInputValue('');
        setIsLoading(true);

        try {
            const langSource =
                activeFile?.language ||
                (activeFile?.name ? getFileLanguage(activeFile.name) : undefined) ||
                'plaintext';
            const normalizedLang = (langSource || 'plaintext').toLowerCase();
            const code = currentCode || '';
            const userPrompt = inputValue;
            const fullfileRequest = `${userPrompt}\n\nRespond only with the updated full file contents in a fenced code block (triple backticks) with the correct language tag. Do not include extra commentary.`;

            try { if (typeof onBusy === 'function') onBusy(true); } catch (e) {}

            let streamBuffer = '';
            let finalSuggestion = '';

            const response = await askAi({
                lang: normalizedLang,
                code,
                prompt: fullfileRequest,
                mode: 'fullfile',
                onProgress: (data) => {
                    const chunk = typeof data === 'string' ? data : (data?.partial ?? '');
                    const isFinal = typeof data === 'object' ? Boolean(data.final) : false;
                    if (chunk) {
                        streamBuffer += chunk;

                        let partialCode = extractCodeFromMarkdown(streamBuffer);
                        if (!partialCode) {
                            const openIdx = streamBuffer.indexOf('```');
                            if (openIdx !== -1) {
                                const afterFence = streamBuffer.slice(openIdx + 3);
                                const firstNewline = afterFence.indexOf('\n');
                                const contentStart = firstNewline === -1 ? 0 : firstNewline + 1;
                                partialCode = afterFence.slice(contentStart);
                                const closeIdx = partialCode.indexOf('```');
                                if (closeIdx !== -1) partialCode = partialCode.slice(0, closeIdx);
                            } else if (streamBuffer.length > 40) {
                                partialCode = streamBuffer;
                            }
                        }

                        if (partialCode) {
                            const cleaned = partialCode.replace(/\r/g, '');
                            mutateSession(activeSession.id, (session) => ({
                                ...session,
                                suggestedCode: cleaned,
                            }));
                            try {
                                if (typeof onSuggest === 'function') onSuggest({ completion: cleaned, partial: true });
                            } catch (e) {}
                        }
                    }

                    if (isFinal) {
                        finalSuggestion = streamBuffer;
                    }
                }
            });

            const suggestion = response?.ai_suggestion || response?.suggestion || finalSuggestion || '';

            let codeOnly = extractCodeFromMarkdown(suggestion);
            const isRawPatch = /(^---\s+a\/.+\n\+\+\+\s+b\/)|(^@@\s+-\d+,?\d*\s+\+\d+,?\d*\s+@@)/m.test(suggestion || '');
            if (!codeOnly && isRawPatch) {
                const patched = applyPatch(code, suggestion);
                if (patched !== false) {
                    codeOnly = patched;
                }
            }

            let displayedContent = suggestion || 'No response received';
            if (codeOnly) {
                displayedContent = (suggestion || '').replace(/```[\s\S]*?```/g, '');
                displayedContent = displayedContent.replace(/<pre[^>]*>[\s\S]*?<code[^>]*>[\s\S]*?<\/code>[\s\S]*?<\/pre>/gi, '');
                displayedContent = displayedContent.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, '');
                displayedContent = displayedContent.trim();
                if (!displayedContent) {
                    displayedContent = 'AI suggested code changes — preview shown below.';
                }
            }

            const now = Date.now();
            const messagesToAppend = [{
                id: now + 1,
                role: 'assistant',
                content: displayedContent,
                timestamp: new Date(),
            }];

            if (codeOnly) {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    suggestedCode: codeOnly,
                }));
                try {
                    if (typeof onSuggest === 'function') {
                        onSuggest({ completion: codeOnly });
                    }
                } catch (e) {}

                const parts = diffLines(code, codeOnly);
                const countLines = (value = '') => {
                    if (!value) return 0;
                    const lines = value.split('\n');
                    if (lines.length && lines[lines.length - 1] === '') lines.pop();
                    return lines.length;
                };
                let added = 0;
                let removed = 0;
                parts.forEach(part => {
                    if (part.added) added += countLines(part.value);
                    if (part.removed) removed += countLines(part.value);
                });

                messagesToAppend.push({
                    id: now + 2,
                    role: 'assistant',
                    content: `AI suggested code changes — preview shown below. (+${added} / -${removed})`,
                    timestamp: new Date(),
                });
            } else {
                mutateSession(activeSession.id, (session) => ({
                    ...session,
                    suggestedCode: null,
                }));
            }

            appendMessagesToSession(activeSession.id, messagesToAppend);
        } catch (error) {
            const errorMessage = {
                id: Date.now() + 1,
                role: 'assistant',
                content: `Error: ${error.message || 'Failed to get AI response. Make sure the backend is running.'}`,
                timestamp: new Date(),
            };
            if (activeSession) appendMessagesToSession(activeSession.id, [errorMessage]);
        } finally {
            setIsLoading(false);
            try { if (typeof onBusy === 'function') onBusy(false); } catch(e){}
        }
    };

    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    };

    const applySuggestion = () => {
        if (!activeSession || !suggestedCode) return;
        if (editor && typeof editor.setValue === 'function') {
            editor.setValue(suggestedCode);
        }
        // Clear suggestion after applying
        mutateSession(activeSession.id, (session) => ({
            ...session,
            suggestedCode: null,
            showDiff: false,
        }));
        // Add a small assistant confirmation message
        appendMessagesToSession(activeSession.id, [{ id: Date.now(), role: 'assistant', content: 'Suggestion applied to editor.', timestamp: new Date() }]);
    };

    const rejectSuggestion = () => {
        if (!activeSession) return;
        mutateSession(activeSession.id, (session) => ({
            ...session,
            suggestedCode: null,
            showDiff: false,
        }));
        appendMessagesToSession(activeSession.id, [{ id: Date.now(), role: 'assistant', content: 'Suggestion rejected.', timestamp: new Date() }]);
    };

    const toggleDiffView = () => {
        if (!activeSession) return;
        mutateSession(activeSession.id, (session) => ({
            ...session,
            showDiff: !session.showDiff,
        }));
    };

    const formatMessageContent = (content) => {
        // We deliberately do not insert zero-width spaces around angle brackets
        // to avoid breaking HTML tags that the model may return. We still
        // transform simple markdown-like emphasis and inline code to HTML.
        if (!content) return '';
        // Remove markdown headings like `###` because we don't have a full
        // markdown renderer and headers can produce odd output.
        const cleaned = content.replace(/^#{1,6}\s+/gm, '');

        const html = cleaned
            .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>')
            .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')
            .replace(/`([^`]+)`/g, '<code class="bg-[#3a3a3d] px-1 rounded text-xs">$1</code>')
            .replace(/\n/g, '<br />');

        // Sanitize HTML to avoid XSS while allowing basic formatting and code blocks
        try {
            return DOMPurify.sanitize(html, {
                ALLOWED_TAGS: ['strong', 'em', 'code', 'pre', 'br', 'div', 'span', 'p', 'ul', 'ol', 'li'],
                ALLOWED_ATTR: ['class']
            });
        } catch (e) {
            return html;
        }
    };

    if (!isVisible) return null;

    const diffChunks = suggestedCode ? computeDiffChunks(currentCode || '', suggestedCode) : [];

    // Choose container classes based on docked/inline mode
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
                        {suggestedCode && (
                            <div className="text-xs text-gray-300">Suggestion ready</div>
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
                    {messages.length === 0 ? (
                        <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
                            <p>Start a conversation with the AI assistant</p>
                        </div>
                    ) : (
                        messages.map((msg) => (
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
                                        className="break-all whitespace-pre-wrap text-sm leading-relaxed"
                                        dangerouslySetInnerHTML={{ __html: formatMessageContent(msg.content) }}
                                    />
                                    <span className="text-xs opacity-70 mt-1 block">
                                        {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                </div>
                            </div>
                        ))
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

                    {/* Suggested code preview + diff controls */}
                    {suggestedCode && (
                        <div className="px-2 py-2 bg-[#171717] border border-[#3a3a3a] rounded">
                            <div className="flex items-center justify-between mb-2">
                                <div className="text-sm font-medium text-gray-200">Suggested Changes</div>
                                <div className="flex items-center gap-2">
                                    {isLoading ? (
                                        <div className="flex items-center gap-2 text-xs text-gray-300">
                                            <div className="w-3 h-3 rounded-full bg-gray-400 animate-pulse" aria-hidden></div>
                                            <span>Thinking...</span>
                                        </div>
                                    ) : null}
                                    <button className="text-xs text-gray-300 hover:underline" onClick={toggleDiffView}>
                                        {showDiff ? 'Hide Diff' : 'Preview Diff'}
                                    </button>
                                    <Button variant="outline" size="sm" onClick={rejectSuggestion}>Reject</Button>
                                    <Button variant="default" size="sm" onClick={applySuggestion}>Accept</Button>
                                </div>
                            </div>

                            {!showDiff ? (
                                <pre className="max-h-40 overflow-auto text-xs bg-[#0f0f10] text-gray-100 p-2 rounded">{suggestedCode}</pre>
                            ) : (
                                <div className="max-h-40 overflow-auto text-xs font-mono">
                                    {diffChunks.length > 0 ? (
                                        diffChunks.map((chunk, ci) => {
                                            if (chunk.type === 'eq') {
                                                return chunk.items.map((row) => (
                                                    <div key={`eq-${row.lineOld}-${row.lineNew}`} className="px-1 text-gray-400 flex gap-2">
                                                        <div className="w-10 text-right text-[11px] text-gray-500">{row.lineNew}</div>
                                                        <div className="flex-1 break-words">{row.text}</div>
                                                    </div>
                                                ));
                                            }

                                            if (chunk.type === 'eq-elide') {
                                                return (
                                                    <div key={`elide-${ci}`}>
                                                        {chunk.head.map((row) => (
                                                            <div key={`head-${row.lineNew}`} className="px-1 text-gray-400 flex gap-2">
                                                                <div className="w-10 text-right text-[11px] text-gray-500">{row.lineNew}</div>
                                                                <div className="flex-1 break-words">{row.text}</div>
                                                            </div>
                                                        ))}
                                                        <div className="px-1 text-gray-500 text-center">... {chunk.elidedCount} unchanged lines ...</div>
                                                        {chunk.tail.map((row) => (
                                                            <div key={`tail-${row.lineNew}`} className="px-1 text-gray-400 flex gap-2">
                                                                <div className="w-10 text-right text-[11px] text-gray-500">{row.lineNew}</div>
                                                                <div className="flex-1 break-words">{row.text}</div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                );
                                            }

                                            if (chunk.type === 'add') {
                                                return chunk.items.map((row) => (
                                                    <div key={`add-${row.lineNew}`} className="px-1 flex gap-2 text-emerald-300 bg-emerald-900/5">
                                                        <div className="w-10 text-right text-[11px] text-gray-500">{row.lineNew}</div>
                                                        <div className="flex-1 break-words">+ {row.text}</div>
                                                    </div>
                                                ));
                                            }

                                            if (chunk.type === 'rem') {
                                                return chunk.items.map((row) => (
                                                    <div key={`rem-${row.lineOld}`} className="px-1 flex gap-2 text-rose-300 bg-rose-900/5">
                                                        <div className="w-10 text-right text-[11px] text-gray-500">{row.lineOld}</div>
                                                        <div className="flex-1 break-words">- {row.text}</div>
                                                    </div>
                                                ));
                                            }

                                            return null;
                                        })
                                    ) : (
                                        <div className="px-1 text-gray-500">No changes detected.</div>
                                    )}
                                </div>
                            )}
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
                        onClick={handleSendMessage}
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
