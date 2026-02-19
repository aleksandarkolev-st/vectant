/**
 * useContextWindow — Manages a sliding context window for AI chat sessions.
 *
 * The context window tracks token budgets, summarizes old messages,
 * prioritizes recent context, and ensures the AI always has the most
 * relevant information within the model's token limits.
 *
 * Features:
 * - Token counting (approximate, word-based)
 * - Sliding window with configurable max tokens
 * - Automatic summarization of old messages
 * - Priority-based context inclusion (recent > referenced files > old messages)
 * - Context metadata tracking (what was included/excluded)
 */

import { useCallback, useMemo, useRef } from 'react';

// ── Model Context Windows ───────────────────────────────────────────

/**
 * Maps model name prefixes to their full input context window size (tokens).
 * When the model name starts with a key, the corresponding window is used.
 * Ordered most-specific first so "gemini-2.5-flash-lite" matches before "gemini".
 */
const MODEL_CONTEXT_WINDOWS = [
    // Gemini family
    ['gemini-3-flash',          1_048_576],
    ['gemini-2.5-pro',          1_048_576],
    ['gemini-2.5-flash',        1_048_576],
    ['gemini-2.0-flash',        1_048_576],
    ['gemini-1.5-pro',          2_097_152],
    ['gemini-1.5-flash',        1_048_576],
    ['gemini',                  1_048_576],
    // OpenAI family
    ['gpt-4.1',                 1_047_576],
    ['gpt-4o',                    128_000],
    ['gpt-4-turbo',               128_000],
    ['gpt-4',                       8_192],
    ['gpt-3.5-turbo',             16_385],
    ['o3',                        200_000],
    ['o4-mini',                   200_000],
    // Claude family
    ['claude-3.5-sonnet',         200_000],
    ['claude-3-opus',             200_000],
    ['claude-3-sonnet',           200_000],
    ['claude-3-haiku',            200_000],
    ['claude',                    200_000],
    // DeepSeek
    ['deepseek',                  128_000],
];

/**
 * Look up the context window for a model. Returns the full input token
 * limit, or the fallback default for unknown models.
 */
const getModelContextWindow = (modelName) => {
    if (!modelName || typeof modelName !== 'string') return 1_048_576; // default (Gemini 3 Flash)
    const lower = modelName.toLowerCase();
    for (const [prefix, tokens] of MODEL_CONTEXT_WINDOWS) {
        if (lower.startsWith(prefix)) return tokens;
    }
    return 1_048_576; // unknown model — assume large
};

// ── Token Budget Constants ──────────────────────────────────────────

/** Default maximum context tokens — uses full Gemini 3 Flash window */
const DEFAULT_MAX_CONTEXT_TOKENS = 1_048_576;
/** Tokens reserved for the system prompt */
const SYSTEM_PROMPT_RESERVE = 4000;
/** Tokens reserved for the model's response */
const RESPONSE_RESERVE = 8192;
/** Max tokens for a single file in context */
const MAX_FILE_TOKENS = 100_000;
/** Max tokens for conversation history */
const MAX_HISTORY_TOKENS = 200_000;
/** Max tokens for a conversation summary */
const MAX_SUMMARY_TOKENS = 2000;
/** Number of recent messages always included verbatim */
const RECENT_MESSAGE_COUNT = 10;
/** Approximate chars per token (conservative for code) */
const CHARS_PER_TOKEN = 3.5;

// ── Token Estimation ────────────────────────────────────────────────

/**
 * Estimate token count from text. Uses a simple word/char heuristic
 * that's ~80% accurate for code and English text.
 */
const estimateTokens = (text = '') => {
    if (!text || typeof text !== 'string') return 0;
    // Hybrid: average of word-based and char-based estimates
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const charCount = text.length;
    const wordEstimate = wordCount * 1.3; // ~1.3 tokens per word
    const charEstimate = charCount / CHARS_PER_TOKEN;
    return Math.ceil((wordEstimate + charEstimate) / 2);
};

// ── Message Summarization ───────────────────────────────────────────

/**
 * Create a compressed summary of a batch of messages.
 * Used when old messages exceed the history budget.
 */
const summarizeMessages = (messages = []) => {
    if (!messages.length) return null;

    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    const topics = userMessages
        .map((m) => {
            const content = (m.content || '').trim();
            // Extract first meaningful sentence
            const firstSentence = content.split(/[.!?\n]/).find((s) => s.trim().length > 10);
            return firstSentence?.trim().slice(0, 80) || content.slice(0, 80);
        })
        .filter(Boolean)
        .slice(0, 5);

    const decisions = assistantMessages
        .filter((m) => m.content && m.content.length > 20)
        .map((m) => {
            const content = (m.content || '').trim();
            // Look for action-oriented phrases
            const actionMatch = content.match(
                /(?:created|modified|deleted|fixed|refactored|added|removed|updated|changed|implemented)\s+[^.!?\n]{5,60}/i
            );
            return actionMatch ? actionMatch[0].trim() : null;
        })
        .filter(Boolean)
        .slice(0, 4);

    const filesMentioned = new Set();
    messages.forEach((m) => {
        const content = m.content || '';
        const fileRefs = content.match(/(?:FILE:\s*|`)([\w/.-]+\.\w{1,6})(?:`|)/gi) || [];
        fileRefs.forEach((ref) => {
            const cleaned = ref.replace(/^FILE:\s*|`/gi, '').trim();
            if (cleaned) filesMentioned.add(cleaned);
        });
    });

    return {
        type: 'context-summary',
        messageCount: messages.length,
        timeRange: {
            from: messages[0]?.timestamp,
            to: messages[messages.length - 1]?.timestamp,
        },
        topics,
        decisions,
        filesMentioned: Array.from(filesMentioned).slice(0, 8),
        text: buildSummaryText(topics, decisions, filesMentioned),
    };
};

const buildSummaryText = (topics = [], decisions = [], filesMentioned = new Set()) => {
    const parts = [];
    if (topics.length) {
        parts.push(`Previous topics: ${topics.join('; ')}`);
    }
    if (decisions.length) {
        parts.push(`Actions taken: ${decisions.join('; ')}`);
    }
    if (filesMentioned.size) {
        parts.push(`Files discussed: ${Array.from(filesMentioned).join(', ')}`);
    }
    return parts.join('\n') || 'Previous conversation context (details condensed).';
};

// ── Context Window Priority ─────────────────────────────────────────

/**
 * Priority tiers for context inclusion.
 * Higher priority = included first when budget is tight.
 */
const PRIORITY = {
    /** Current user message */
    CURRENT_MESSAGE: 100,
    /** Active file content */
    ACTIVE_FILE: 90,
    /** Files explicitly mentioned in the current message */
    REFERENCED_FILES: 80,
    /** Recent conversation messages (last N) */
    RECENT_HISTORY: 70,
    /** Agent step results from current pipeline */
    AGENT_RESULTS: 65,
    /** Sibling/related files */
    RELATED_FILES: 50,
    /** Older conversation history */
    OLD_HISTORY: 30,
    /** Summarized old messages */
    SUMMARY: 20,
    /** Code intelligence context */
    CODE_INTEL: 60,
};

// ── Hook ────────────────────────────────────────────────────────────

export const useContextWindow = ({ maxTokens = DEFAULT_MAX_CONTEXT_TOKENS, model = null } = {}) => {
    // Resolve effective max tokens: if a model name is provided, use its full window
    const effectiveMaxTokens = model ? getModelContextWindow(model) : maxTokens;
    const summaryCache = useRef(new Map());

    /**
     * Available tokens after reserves.
     */
    const availableTokens = useMemo(
        () => effectiveMaxTokens - SYSTEM_PROMPT_RESERVE - RESPONSE_RESERVE,
        [effectiveMaxTokens]
    );

    /**
     * Build context entries with priority and token counts.
     * Returns a sorted, budget-fitted array of context items.
     */
    const buildContextWindow = useCallback(
        ({
            currentMessage = '',
            messages = [],
            activeFile = null,
            currentCode = '',
            referencedFiles = [],
            relatedFiles = [],
            codeIntelContext = null,
            agentResults = [],
        }) => {
            const entries = [];
            const metadata = {
                totalTokensAvailable: availableTokens,
                totalTokensUsed: 0,
                includedEntries: 0,
                excludedEntries: 0,
                hasSummary: false,
                truncatedFiles: [],
            };

            // 1. Current user message (always included)
            if (currentMessage) {
                entries.push({
                    id: 'current-message',
                    type: 'message',
                    priority: PRIORITY.CURRENT_MESSAGE,
                    tokens: estimateTokens(currentMessage),
                    content: currentMessage,
                });
            }

            // 2. Active file content
            if (currentCode) {
                const fileTokens = estimateTokens(currentCode);
                const truncated = fileTokens > MAX_FILE_TOKENS;
                const content = truncated
                    ? truncateToTokenBudget(currentCode, MAX_FILE_TOKENS)
                    : currentCode;
                if (truncated) {
                    metadata.truncatedFiles.push(activeFile?.path || 'active-file');
                }
                entries.push({
                    id: 'active-file',
                    type: 'file',
                    priority: PRIORITY.ACTIVE_FILE,
                    tokens: truncated ? MAX_FILE_TOKENS : fileTokens,
                    content,
                    path: activeFile?.path || activeFile?.name || 'active-file',
                });
            }

            // 3. Referenced files (mentioned in current message)
            referencedFiles.forEach(([path, content]) => {
                if (!content || typeof content !== 'string') return;
                const tokens = estimateTokens(content);
                const truncated = tokens > MAX_FILE_TOKENS;
                entries.push({
                    id: `ref-file:${path}`,
                    type: 'file',
                    priority: PRIORITY.REFERENCED_FILES,
                    tokens: truncated ? MAX_FILE_TOKENS : tokens,
                    content: truncated ? truncateToTokenBudget(content, MAX_FILE_TOKENS) : content,
                    path,
                });
            });

            // 4. Agent results from current pipeline
            agentResults.forEach((result, index) => {
                if (!result?.output) return;
                const tokens = estimateTokens(result.output);
                entries.push({
                    id: `agent-result:${index}`,
                    type: 'agent-result',
                    priority: PRIORITY.AGENT_RESULTS,
                    tokens,
                    content: result.output,
                    agentName: result.agentName || 'sub-agent',
                    stepIndex: index,
                });
            });

            // 5. Code intelligence context
            if (codeIntelContext?.context) {
                entries.push({
                    id: 'code-intel',
                    type: 'code-intel',
                    priority: PRIORITY.CODE_INTEL,
                    tokens: estimateTokens(codeIntelContext.context),
                    content: codeIntelContext.context,
                    sufficiency: codeIntelContext.sufficiency,
                });
            }

            // 6. Conversation history (split into recent and old)
            const conversationMessages = messages.filter(
                (m) => m.role === 'user' || m.role === 'assistant'
            );

            const recentMessages = conversationMessages.slice(-RECENT_MESSAGE_COUNT);
            const oldMessages = conversationMessages.slice(0, -RECENT_MESSAGE_COUNT);

            recentMessages.forEach((msg, i) => {
                entries.push({
                    id: `recent-msg:${msg.id || i}`,
                    type: 'message',
                    priority: PRIORITY.RECENT_HISTORY,
                    tokens: estimateTokens(msg.content || ''),
                    content: msg.content || '',
                    role: msg.role,
                    messageId: msg.id,
                });
            });

            // 7. Old messages → summarize if too large
            if (oldMessages.length > 0) {
                const oldTokens = oldMessages.reduce(
                    (sum, m) => sum + estimateTokens(m.content || ''),
                    0
                );

                if (oldTokens > MAX_HISTORY_TOKENS) {
                    // Summarize old messages
                    const cacheKey = oldMessages.map((m) => m.id).join(',');
                    let summary = summaryCache.current.get(cacheKey);
                    if (!summary) {
                        summary = summarizeMessages(oldMessages);
                        summaryCache.current.set(cacheKey, summary);
                        // Evict old cache entries
                        if (summaryCache.current.size > 20) {
                            const firstKey = summaryCache.current.keys().next().value;
                            summaryCache.current.delete(firstKey);
                        }
                    }
                    metadata.hasSummary = true;
                    entries.push({
                        id: 'history-summary',
                        type: 'summary',
                        priority: PRIORITY.SUMMARY,
                        tokens: estimateTokens(summary.text),
                        content: summary.text,
                        summary,
                    });
                } else {
                    // Include old messages verbatim
                    oldMessages.forEach((msg, i) => {
                        entries.push({
                            id: `old-msg:${msg.id || i}`,
                            type: 'message',
                            priority: PRIORITY.OLD_HISTORY,
                            tokens: estimateTokens(msg.content || ''),
                            content: msg.content || '',
                            role: msg.role,
                            messageId: msg.id,
                        });
                    });
                }
            }

            // 8. Related/sibling files
            relatedFiles.forEach(([path, content]) => {
                if (!content || typeof content !== 'string') return;
                const tokens = estimateTokens(content);
                const truncated = tokens > MAX_FILE_TOKENS;
                entries.push({
                    id: `related-file:${path}`,
                    type: 'file',
                    priority: PRIORITY.RELATED_FILES,
                    tokens: truncated ? MAX_FILE_TOKENS : tokens,
                    content: truncated ? truncateToTokenBudget(content, MAX_FILE_TOKENS) : content,
                    path,
                });
            });

            // ── Priority-based fitting ──────────────────────────────
            // Sort by priority (highest first), then fit within budget
            entries.sort((a, b) => b.priority - a.priority);

            const included = [];
            let tokenBudget = availableTokens;

            for (const entry of entries) {
                if (entry.tokens <= tokenBudget) {
                    included.push({ ...entry, included: true });
                    tokenBudget -= entry.tokens;
                    metadata.includedEntries++;
                } else if (tokenBudget > 200 && entry.type === 'file') {
                    // Partial inclusion for large files
                    const truncatedContent = truncateToTokenBudget(
                        entry.content,
                        tokenBudget - 50
                    );
                    included.push({
                        ...entry,
                        content: truncatedContent,
                        tokens: tokenBudget - 50,
                        included: true,
                        partial: true,
                    });
                    metadata.truncatedFiles.push(entry.path || entry.id);
                    tokenBudget = 50;
                    metadata.includedEntries++;
                } else {
                    metadata.excludedEntries++;
                }
            }

            metadata.totalTokensUsed = availableTokens - tokenBudget;

            return { entries: included, metadata };
        },
        [availableTokens]
    );

    /**
     * Format context entries into the conversation history array
     * suitable for sending to the Gemini API.
     */
    const formatForAPI = useCallback((contextWindow) => {
        const { entries } = contextWindow;
        const conversationHistory = [];
        const contextParts = [];

        // Separate messages from context
        for (const entry of entries) {
            if (entry.type === 'message' && entry.role) {
                conversationHistory.push({
                    role: entry.role,
                    content: entry.content,
                });
            } else if (entry.type === 'summary') {
                // Inject summary as a system-like context
                contextParts.push(`[CONVERSATION SUMMARY]\n${entry.content}`);
            } else if (entry.type === 'agent-result') {
                contextParts.push(
                    `[AGENT RESULT: ${entry.agentName}]\n${entry.content}`
                );
            } else if (entry.type === 'code-intel') {
                contextParts.push(`[CODE INTELLIGENCE CONTEXT]\n${entry.content}`);
            }
        }

        return {
            conversationHistory,
            contextPrefix: contextParts.join('\n\n'),
        };
    }, []);

    /**
     * Get a debug view of the current context window allocation.
     */
    const getContextDebugInfo = useCallback((contextWindow) => {
        const { entries, metadata } = contextWindow;
        const byType = {};
        entries.forEach((e) => {
            byType[e.type] = (byType[e.type] || 0) + e.tokens;
        });
        return {
            ...metadata,
            tokensByType: byType,
            utilization: (metadata.totalTokensUsed / metadata.totalTokensAvailable * 100).toFixed(1) + '%',
        };
    }, []);

    return {
        buildContextWindow,
        formatForAPI,
        getContextDebugInfo,
        estimateTokens,
        availableTokens,
        maxTokens: effectiveMaxTokens,
    };
};

// ── Helpers ─────────────────────────────────────────────────────────

function truncateToTokenBudget(text, maxTokens) {
    if (!text) return '';
    const charBudget = Math.floor(maxTokens * CHARS_PER_TOKEN);
    if (text.length <= charBudget) return text;
    const half = Math.floor(charBudget / 2);
    const head = text.slice(0, half);
    const tail = text.slice(text.length - half);
    return `${head}\n\n... [${text.length - charBudget} chars truncated] ...\n\n${tail}`;
}

export { estimateTokens, PRIORITY, DEFAULT_MAX_CONTEXT_TOKENS, MODEL_CONTEXT_WINDOWS, getModelContextWindow };
