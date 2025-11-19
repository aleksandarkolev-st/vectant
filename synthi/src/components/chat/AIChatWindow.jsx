'use client';

import { useState, useRef, useEffect } from 'react';
import DOMPurify from 'dompurify';
import { Send, X } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { getFileLanguage } from '@/utils/fileUtils';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { diffLines, createPatch, applyPatch } from 'diff';

const AIChatWindow = ({ onClose, isVisible = true, activeFile, currentCode, editor = null, docked = false, onSuggest = null, onBusy = null }) => {
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [suggestedCode, setSuggestedCode] = useState(null);
    const [suggestedRaw, setSuggestedRaw] = useState('');
    const [showDiff, setShowDiff] = useState(false);
    const scrollRef = useRef(null);
    const { askAi, clientReady } = useAnalyzerGateway();
    const [forcePatchMode, setForcePatchMode] = useState(false);

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

        const userMessage = {
            id: Date.now(),
            role: 'user',
            content: inputValue,
            timestamp: new Date(),
        };

        setMessages((prev) => [...prev, userMessage]);
        setInputValue('');
        setIsLoading(true);

        try {
            const langSource =
                activeFile?.language ||
                (activeFile?.name ? getFileLanguage(activeFile.name) : undefined) ||
                'plaintext';
            const normalizedLang = langSource.toLowerCase();
            const code = currentCode || '';
            const userPrompt = inputValue;

                // Decide prompt text based on chosen mode (default to patch mode unless user requests full file)
                // Default behavior: return a unified diff (patch) to minimize edits.
                const fullfileRequest = `${userPrompt}\n\nRespond only with the updated full file contents in a fenced code block (triple backticks) with the correct language tag. Do not include extra commentary.`;
                const patchRequest = `${userPrompt}\n\nRespond only with a unified diff (unified patch) showing the minimal changes required. Return ONLY the diff in a single fenced code block or raw unified-diff text using --- a/ and +++ b/ headers and @@ hunk markers. Do not include any extra commentary.`;

            // notify parent that we're working
            try { if (typeof onBusy === 'function') onBusy(true); } catch(e){}

            // Prepare streaming buffer
            let streamBuffer = '';
            let finalSuggestion = '';

            // Decide mode: user-forced patch or heuristic detection of small edits
            const patchKeywords = /\b(rename|rename variable|rename function|rename var|rename variables|change name|change variable|replace variable|replace name|only change|minimal|diff|patch|rename)\b/i;
                // Default to patch mode; allow force toggle or explicit fullfile request
                const fullfileKeywords = /\b(return full file|full file|fullfile|complete file|entire file)\b/i;
                const chosenMode = forcePatchMode ? 'patch' : (fullfileKeywords.test(userPrompt) ? 'fullfile' : 'patch');

                const response = await askAi({
                    lang: normalizedLang,
                    code,
                    prompt: chosenMode === 'patch' ? patchRequest : fullfileRequest,
                    mode: chosenMode,
                    onProgress: (data) => {
                    // `data` may be a string or { partial, final }
                    const chunk = typeof data === 'string' ? data : (data?.partial ?? '');
                    const isFinal = typeof data === 'object' ? Boolean(data.final) : false;
                    if (chunk) {
                        streamBuffer += chunk;

                        // Try to derive partial code content from buffer
                        let partialCode = extractCodeFromMarkdown(streamBuffer);
                        if (!partialCode) {
                            // If an opening fence exists, stream content inside it
                            const openIdx = streamBuffer.indexOf('```');
                            if (openIdx !== -1) {
                                // Skip the opening fence and optional language tag
                                const afterFence = streamBuffer.slice(openIdx + 3);
                                const firstNewline = afterFence.indexOf('\n');
                                const contentStart = firstNewline === -1 ? 0 : firstNewline + 1;
                                partialCode = afterFence.slice(contentStart);
                                // Remove any closing fence if present
                                const closeIdx = partialCode.indexOf('```');
                                if (closeIdx !== -1) partialCode = partialCode.slice(0, closeIdx);
                            } else if (streamBuffer.length > 40) {
                                // Fallback: treat the buffer as code-like when it's long
                                partialCode = streamBuffer;
                            }
                        }

                        if (partialCode) {
                            setSuggestedCode(partialCode.replace(/\r/g, ''));
                            setSuggestedRaw(streamBuffer);
                            // Notify parent/page with partial completion for streaming ghost text
                            try {
                                if (typeof onSuggest === 'function') onSuggest({ completion: partialCode, partial: true });
                            } catch (e) {}
                        }
                    }

                    if (isFinal) {
                        finalSuggestion = streamBuffer;
                    }
                }
            });

            const suggestion = response?.ai_suggestion || response?.suggestion || finalSuggestion || '';

                // Attempt to extract a code block from final suggestion or detect a raw unified diff
                let codeOnly = extractCodeFromMarkdown(suggestion);
                const isRawPatch = /(^---\s+a\/.+\n\+\+\+\s+b\/)|(^@@\s+-\d+,?\d*\s+\+\d+,?\d*\s+@@)/m.test(suggestion || '');
                if (!codeOnly && isRawPatch) {
                    // Treat the raw suggestion as the patch
                    codeOnly = suggestion;
                }

            // If the assistant returned a code block, strip it from the chat
            // message and show an explanation instead. The actual code is
            // shown only in the Suggested Changes preview/diff below.
            let displayedContent = suggestion || 'No response received';
            if (codeOnly) {
                // Remove fenced code blocks and inline <pre><code> blocks
                displayedContent = (suggestion || '').replace(/```[\s\S]*?```/g, '');
                displayedContent = displayedContent.replace(/<pre[^>]*>[\s\S]*?<code[^>]*>[\s\S]*?<\/code>[\s\S]*?<\/pre>/gi, '');
                displayedContent = displayedContent.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, '');
                displayedContent = displayedContent.trim();
                if (!displayedContent) {
                    displayedContent = 'AI suggested code changes — preview shown below.';
                }
            }

            const aiMessage = {
                id: Date.now() + 1,
                role: 'assistant',
                content: displayedContent,
                timestamp: new Date(),
            };
                if (codeOnly) {
                    setSuggestedCode(codeOnly);
                    setSuggestedRaw(suggestion);
                    // Build hunks to send to parent for editor integration
                    let hunksForParent = [];
                    try {
                        let patchText = '';
                        let rawHunks = [];
                        // If the model already returned a unified diff/patch, parse it directly
                        if (isRawPatch) {
                            patchText = codeOnly;
                            const idx = patchText.indexOf('\n@@ ');
                            const rest = idx === -1 ? '' : patchText.slice(idx + 1);
                            rawHunks = rest ? rest.split('\n@@ ').map((h, i) => (i === 0 ? '@@ ' + h : '@@ ' + h)) : [];
                            const header = idx === -1 ? patchText : patchText.slice(0, idx + 1);
                            hunksForParent = rawHunks.map((h, i) => ({ id: i, text: h, patchForHunk: header + h }));
                        } else {
                            // Otherwise the model returned a full file; compute a unified diff client-side
                            const fileName = (activeFile && activeFile.name) ? activeFile.name : 'file';
                            patchText = createPatch(fileName, currentCode || '', codeOnly);
                            const idx = patchText.indexOf('\n@@ ');
                            const rest = idx === -1 ? '' : patchText.slice(idx + 1);
                            rawHunks = rest ? rest.split('\n@@ ').map((h, i) => (i === 0 ? '@@ ' + h : '@@ ' + h)) : [];
                            hunksForParent = rawHunks.map((h, i) => ({ id: i, text: h, patchForHunk: (idx === -1 ? patchText : patchText.slice(0, idx + 1) + h) }));
                        }
                    } catch (e) {
                        hunksForParent = [];
                    }

                // Notify parent/page so the editor can display inline suggestion and hunks
                try {
                    if (typeof onSuggest === 'function') {
                        onSuggest({ completion: codeOnly, hunks: hunksForParent });
                    }
                } catch (e) {
                    // ignore
                }
            } else {
                setSuggestedCode(null);
                setSuggestedRaw('');
            }

            setMessages((prev) => [...prev, aiMessage]);
        } catch (error) {
            const errorMessage = {
                id: Date.now() + 1,
                role: 'assistant',
                content: `Error: ${error.message || 'Failed to get AI response. Make sure the backend is running.'}`,
                timestamp: new Date(),
            };
            setMessages((prev) => [...prev, errorMessage]);
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
        if (!suggestedCode) return;
        if (editor && typeof editor.setValue === 'function') {
            editor.setValue(suggestedCode);
        }
        // Clear suggestion after applying
        setSuggestedCode(null);
        setSuggestedRaw('');
        setShowDiff(false);
        // Add a small assistant confirmation message
        setMessages((prev) => [...prev, { id: Date.now(), role: 'assistant', content: 'Suggestion applied to editor.', timestamp: new Date() }]);
    };

    const rejectSuggestion = () => {
        setSuggestedCode(null);
        setSuggestedRaw('');
        setShowDiff(false);
        setMessages((prev) => [...prev, { id: Date.now(), role: 'assistant', content: 'Suggestion rejected.', timestamp: new Date() }]);
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

    // Build a unified patch and split into hunks for per-hunk application
    const buildPatchAndHunks = (oldStr = '', newStr = '') => {
        try {
            const fileName = (activeFile && activeFile.name) ? activeFile.name : 'file';
            const patch = createPatch(fileName, oldStr, newStr);
            // Split into header and hunks
            const idx = patch.indexOf('\n@@ ');
            if (idx === -1) return { patch, header: patch, hunks: [] };
            const header = patch.slice(0, idx + 1);
            const rest = patch.slice(idx + 1);
            // Each hunk starts with @@
            const rawHunks = rest.split('\n@@ ').map((h, i) => (i === 0 ? '@@ ' + h : '@@ ' + h));
            const hunks = rawHunks.map((h, i) => ({
                id: i,
                text: h,
                patchForHunk: header + h
            }));
            return { patch, header, hunks };
        } catch (e) {
            return { patch: '', header: '', hunks: [] };
        }
    };

    // Helpers: copy and apply hunk
    const copyToClipboard = async (text) => {
        try {
            await navigator.clipboard.writeText(text);
            setMessages((prev) => [...prev, { id: Date.now(), role: 'assistant', content: 'Hunk copied to clipboard.', timestamp: new Date() }]);
        } catch (e) {
            setMessages((prev) => [...prev, { id: Date.now(), role: 'assistant', content: 'Failed to copy hunk.', timestamp: new Date() }]);
        }
    };

    const applyHunk = (hunk) => {
        if (!hunk || !hunk.patchForHunk) return;
        if (!editor || !editor.getModel) return;

        try {
            const model = editor.getModel();
            const original = model.getValue();
            const patched = applyPatch(original, hunk.patchForHunk);
            if (patched === false) {
                // applyPatch returns false when patch failed
                setMessages((prev) => [...prev, { id: Date.now(), role: 'assistant', content: 'Failed to apply hunk: context mismatch.', timestamp: new Date() }]);
                return;
            }

            // Apply new text to editor and update suggested preview
            if (typeof editor.setValue === 'function') {
                editor.setValue(patched);
                setSuggestedCode(null);
                setSuggestedRaw('');
                setShowDiff(false);
                setMessages((prev) => [...prev, { id: Date.now(), role: 'assistant', content: 'Hunk applied to editor.', timestamp: new Date() }]);
            }
        } catch (e) {
            setMessages((prev) => [...prev, { id: Date.now(), role: 'assistant', content: `Error applying hunk: ${e.message}`, timestamp: new Date() }]);
        }
    };

    if (!isVisible) return null;

    const diffChunks = suggestedCode ? computeDiffChunks(currentCode || '', suggestedCode) : [];
    const { patch, header, hunks } = buildPatchAndHunks(currentCode || '', suggestedCode || '');

    // Choose container classes based on docked/inline mode
    const containerClass = docked
        ? 'h-full w-full bg-transparent flex flex-col min-h-0'
        : 'fixed top-10 right-0 bottom-0 w-96 bg-[#1e1e1e] border-l border-[#545454] rounded-l-lg shadow-2xl flex flex-col min-h-0 z-40';

    return (
        <div className={containerClass}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#545454] bg-[#252526]">
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
                                    <button className="text-xs text-gray-300 hover:underline" onClick={() => setShowDiff(v => !v)}>
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
                                    {hunks.length > 0 ? (
                                        hunks.map((hunk) => (
                                            <div key={`hunk-${hunk.id}`} className="border-b border-[#2b2b2b] py-1 px-1">
                                                <pre className="whitespace-pre-wrap text-xs bg-transparent p-1 rounded font-mono">{hunk.text}</pre>
                                                <div className="flex gap-2 mt-1">
                                                    <Button size="sm" variant="outline" onClick={() => applyHunk(hunk)}>
                                                        Apply Hunk
                                                    </Button>
                                                    <Button size="sm" variant="ghost" onClick={() => copyToClipboard(hunk.text)}>
                                                        Copy Hunk
                                                    </Button>
                                                </div>
                                            </div>
                                        ))
                                    ) : (
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

                                            // add/remove rows
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
                    <Button
                        variant={forcePatchMode ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setForcePatchMode(v => !v)}
                        title="Toggle diff/patch mode (Alt+auto-detect)"
                        className="self-center"
                    >
                        {forcePatchMode ? 'Diff ON' : 'Diff'}
                    </Button>
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