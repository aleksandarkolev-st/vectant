'use client';

import { useState, useRef, useEffect } from 'react';
import { Send, X } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { getFileLanguage } from '@/utils/fileUtils';

const AIChatWindow = ({ onClose, isVisible = true, activeFile, currentCode }) => {
    const [messages, setMessages] = useState([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef(null);
    const { askAi, clientReady } = useAnalyzerGateway();

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        if (scrollRef.current) {
            // support either the local data-slot attribute or radix's runtime attribute
            const scrollArea = scrollRef.current.querySelector('[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]');
            if (scrollArea) {
                scrollArea.scrollTop = scrollArea.scrollHeight;
            }
        }
    }, [messages]);

    const handleSendMessage = async () => {
        if (!inputValue.trim()) return;

        // Add user message
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
            // Get AI suggestion from analyzer gateway with context
            console.log('Requesting AI suggestion for:', {
                lang: activeFile?.language,
                code: currentCode,
                prompt: inputValue,
            });
            const langSource =
                activeFile.language ||
                (activeFile.name ? getFileLanguage(activeFile.name) : undefined) ||
                'plaintext';
            const normalizedLang = langSource.toLowerCase();
            const code = currentCode || '';
            const userPrompt = inputValue;

            // Send structured request to AI analyzer
            const response = await askAi({
                lang: normalizedLang,
                code,
                prompt: userPrompt, // User's specific question
            });

            // Extract suggestion from response
            const suggestion = response?.ai_suggestion || response?.suggestion || 'No response received';

            const aiMessage = {
                id: Date.now() + 1,
                role: 'assistant',
                content: suggestion,
                timestamp: new Date(),
            };
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
        }
    };

    const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    };

    const formatMessageContent = (content) => {
        return content
            .replace(/\*\*(.*?)\*\*/g, '<strong class="font-semibold">$1</strong>') // Bold
            .replace(/\*(.*?)\*/g, '<em class="italic">$1</em>')                   // Italic
            .replace(/`([^`]+)`/g, '<code class="bg-[#3a3a3d] px-1 rounded text-xs">$1</code>') // Code
            .replace(/\n/g, '<br />')
            // Critical: Insert zero-width spaces after common delimiters to allow breaking
            .replace(/([\/\-\_\.\,\:\;\)\(\>\<\}\{\]\[\+\=\*\|\&])/g, '$1\u200B')
            .replace(/\*\*/g, '**\u200B')
            .replace(/\*\//g, '*/\u200B');
    };

    if (!isVisible) return null;

    return (
        <div className="fixed bottom-4 right-4 w-96 h-[500px] bg-[#1e1e1e] border border-[#545454] rounded-lg shadow-2xl flex flex-col min-h-0 z-40">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#545454] bg-[#252526]">
                <h2 className="text-sm font-semibold text-gray-200">AI Assistant</h2>
                <button
                    onClick={onClose}
                    className="p-1 hover:bg-[#3e3e42] rounded transition-colors"
                    title="Close chat"
                >
                    <X className="w-4 h-4 text-gray-400" />
                </button>
            </div>

            {/* Messages Area */}
            <ScrollArea ref={scrollRef} className="flex-1 min-h-0 px-4 py-3">
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
                                        {msg.timestamp.toLocaleTimeString([], {
                                            hour: '2-digit',
                                            minute: '2-digit',
                                        })}
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
                </div>
            </ScrollArea>

            {/* Input Area */}
            <div className="px-4 py-3 border-t border-[#545454] bg-[#252526]">
                <div className="flex gap-2">
                    <textarea
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder="Ask AI for suggestions... (Shift+Enter for new line)"
                        disabled={isLoading || !clientReady}
                        className="flex-1 bg-[#3e3e42] text-gray-200 text-sm rounded px-3 py-2 border border-[#454545] focus:outline-none focus:border-emerald-500 resize-none disabled:opacity-50"
                        rows={2}
                    />
                    <button
                        onClick={handleSendMessage}
                        disabled={!inputValue.trim() || isLoading || !clientReady}
                        className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded transition-colors flex items-center justify-center"
                        title="Send message (Enter)"
                    >
                        <Send className="w-4 h-4" />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default AIChatWindow;
