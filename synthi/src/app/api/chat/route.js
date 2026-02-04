import { NextResponse } from 'next/server';

const encoder = new TextEncoder();
const GEMINI_BASE =
    (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

const COLLAB_BASE =
    (process.env.COLLAB_SERVER_URL || process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234').replace(/\/$/, '');

const MAX_REPO_FILES = Number(process.env.AI_FULL_REPO_MAX_FILES || 80);
const MAX_REPO_CHARS = Number(process.env.AI_FULL_REPO_MAX_CHARS || 200_000);
const MAX_FILE_CHARS = Number(process.env.AI_FULL_REPO_MAX_FILE_CHARS || 20_000);
const DEFAULT_IGNORE = [
    'node_modules/',
    '.git/',
    '.next/',
    'dist/',
    'build/',
    'out/',
    '.cache/',
    '.code_intel/',
    '.turbo/',
];

// Code Intelligence Backend
const CODE_INTEL_BASE = process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

const DEFAULT_GEMINI_MODEL = process.env.SYNTHI_AI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const UPSTREAM_TIMEOUT_MS = 45_000;

/**
 * Classify user query intent using the AI backend's LLM-based classifier.
 * This determines whether the user wants code changes or just an explanation.
 * 
 * @param {string} query - The user's query
 * @param {string} context - Optional context (e.g., current file content)
 * @returns {Promise<Object>} - { intent, needs_code_changes, response_mode }
 */
async function classifyIntent(query, context = null) {
    try {
        const response = await fetch(`${CODE_INTEL_BASE}/classify/intent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, context }),
            signal: AbortSignal.timeout(3000), // Fast timeout - intent classification should be quick
        });
        
        if (!response.ok) {
            console.warn(`Intent classification failed: ${response.status}`);
            return { intent: 'unknown', needs_code_changes: true, response_mode: 'patch' };
        }
        
        return await response.json();
    } catch (e) {
        console.warn('Intent classification error:', e.message);
        // Default to assuming code changes are needed (safer for the editor use case)
        return { intent: 'unknown', needs_code_changes: true, response_mode: 'patch' };
    }
}

// System prompt for code intelligence chat
// Key principle: Only act on explicit requests, never suggest changes unprompted
const CODE_INTEL_SYSTEM_PROMPT = `You are a code intelligence assistant integrated into an IDE.

CRITICAL RULES:
1. ANSWER what the user asks - nothing more, nothing less.
2. DO NOT suggest code changes, refactors, or improvements unless explicitly asked.
3. DO NOT offer to help with things the user didn't ask about.
4. When explaining code, focus on understanding, not "fixing" or "improving" it.
5. If asked to explain code, explain it. Do not suggest how to change it.
6. If asked a question about code behavior, answer the question. Do not suggest modifications.
7. Only provide code changes when the user explicitly asks for them (e.g., "fix this", "refactor this", "change this to...").

You have access to code context retrieved from the user's workspace. Use this context to provide accurate, specific answers.

If the context is insufficient to answer the question, say so clearly rather than guessing.`;

/**
 * Fetch code intelligence context from the backend.
 * This uses the deterministic retrieval controller to decide what context to include.
 * 
 * @param {Object} params - Parameters for context retrieval
 * @param {string} params.workspacePath - Path to the workspace
 * @param {string} params.query - User's query/prompt
 * @param {number} params.maxTokens - Maximum tokens for context
 * @param {Array} params.conversationHistory - Previous messages
 * @returns {Promise<Object>} - Context response with sufficiency indicator
 */
async function fetchCodeIntelContext({ workspacePath, query, maxTokens = 6000, conversationHistory = [] }) {
    if (!workspacePath) {
        return { context: '', sufficiency: 'UNKNOWN', sources: [], refusal: null };
    }
    
    try {
        const response = await fetch(`${CODE_INTEL_BASE}/code-intel/context`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                workspace_path: workspacePath,
                query: query,
                max_tokens: maxTokens,
                conversation_history: conversationHistory,
            }),
            // TTFT optimization: Reduced timeout to 3s - if code intel is slow, skip it
            // This ensures we don't block streaming for too long
            signal: AbortSignal.timeout(3000),
        });
        
        if (!response.ok) {
            console.warn(`Code intel context failed: ${response.status}`);
            return { context: '', sufficiency: 'UNKNOWN', sources: [], refusal: null };
        }
        
        const data = await response.json();
        return {
            context: data.context || '',
            sufficiency: data.sufficiency || 'UNKNOWN',
            sources: data.sources || [],
            tokensUsed: data.tokens_used || 0,
            refusal: data.refusal || null,
            trace: Array.isArray(data.trace) ? data.trace : [],
        };
    } catch (e) {
        console.warn('Code intel fetch error:', e.message);
        return { context: '', sufficiency: 'UNKNOWN', sources: [], refusal: null };
    }
}

const buildTraceSummary = (trace = []) => {
    if (!Array.isArray(trace) || trace.length === 0) return '';
    const included = trace.filter((t) => t?.reason === 'included');
    const top = (included.length ? included : trace).slice(0, 6);
    const parts = top.map((t) => {
        const file = t?.file || 'unknown';
        const symbol = t?.symbol ? `:${t.symbol}` : '';
        const score = typeof t?.score === 'number' ? `(${t.score.toFixed(2)})` : '';
        return `${file}${symbol}${score}`;
    });
    const text = parts.join(' | ');
    return text.length > 380 ? `${text.slice(0, 377)}...` : text;
};


const buildUserContent = ({ prompt, code, files, lang, focusPath, codeIntelContext }) => {
    const parts = [];
    
    // If code intelligence provided context, include it first with clear boundaries
    if (codeIntelContext?.context) {
        parts.push('=== RELEVANT CODE CONTEXT (retrieved by deterministic controller) ===');
        parts.push(codeIntelContext.context);
        parts.push('=== END CODE CONTEXT ===');
        
        // Add sufficiency indicator so LLM knows if context is complete
        if (codeIntelContext.sufficiency === 'INSUFFICIENT') {
            parts.push('[CONTEXT WARNING: The retrieved context may be incomplete for this query. If you cannot confidently answer, please indicate what additional context would be needed.]');
        } else if (codeIntelContext.sufficiency === 'PARTIAL') {
            parts.push('[CONTEXT NOTE: Some relevant context may be missing. Consider asking for clarification if needed.]');
        }
        
        // If there's a refusal reason, include it
        if (codeIntelContext.refusal) {
            parts.push(`[CONTEXT LIMITATION: ${codeIntelContext.refusal}]`);
        }
    }
    
    if (prompt) parts.push(String(prompt));
    if (focusPath) parts.push(`Focus path: ${focusPath}`);
    if (lang) parts.push(`Language: ${lang}`);
    if (code) parts.push(`ACTIVE FILE:\n${code}`);
    if (Array.isArray(files)) {
        for (const file of files) {
            const name = file?.path || file?.name || 'file';
            const content =
                typeof file?.content === 'string'
                    ? file.content
                    : typeof file?.text === 'string'
                        ? file.text
                        : typeof file?.value === 'string'
                            ? file.value
                            : '';
            if (content) {
                parts.push(`FILE: ${name}\n${content}`);
            }
        }
    }
    return parts.filter(Boolean).join('\n\n').trim();
};

const encodeFilePath = (filePath = '') =>
    String(filePath || '')
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => encodeURIComponent(segment))
        .join('/');

const fetchCollabFileContent = async (slug, filePath, signal) => {
    if (!slug || !filePath) return null;
    try {
        const safePath = encodeFilePath(filePath);
        const url = `${COLLAB_BASE}/file-content/${encodeURIComponent(slug)}/${safePath}`;
        const res = await fetch(url, { method: 'GET', signal });
        if (!res.ok) return null;
        return await res.text();
    } catch (e) {
        return null;
    }
};

const shouldIgnorePath = (path = '') => {
    const normalized = String(path || '').replace(/\\/g, '/');
    return DEFAULT_IGNORE.some((prefix) => normalized.startsWith(prefix));
};

const fetchRepoFileList = async (slug, signal) => {
    if (!slug) return [];
    try {
        const url = `${COLLAB_BASE}/git/${encodeURIComponent(slug)}/files-meta`;
        const res = await fetch(url, { method: 'GET', signal });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data?.files) ? data.files : [];
    } catch (e) {
        return [];
    }
};

const hydrateFullRepoFiles = async ({ workspacePath, existingFiles, signal }) => {
    const fileMeta = await fetchRepoFileList(workspacePath, signal);
    if (!fileMeta.length) return [];

    const seen = new Set((existingFiles || []).map((f) => f?.path || f?.name).filter(Boolean));
    const hydrated = [];
    let totalChars = 0;

    for (const entry of fileMeta) {
        const relPath = String(entry?.path || '').replace(/\\/g, '/');
        if (!relPath || relPath.endsWith('/') || seen.has(relPath)) continue;
        if (shouldIgnorePath(relPath)) continue;
        if (hydrated.length >= MAX_REPO_FILES) break;
        if (totalChars >= MAX_REPO_CHARS) break;

        const content = await fetchCollabFileContent(workspacePath, relPath, signal);
        if (typeof content !== 'string' || !content) continue;

        const trimmed = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content;
        totalChars += trimmed.length;
        hydrated.push({ path: relPath, content: trimmed });
    }

    return hydrated;
};

const hydrateFromCollab = async ({ workspacePath, focusPath, code, files, signal, fullRepoContext = false }) => {
    if (!workspacePath) return { code, files };

    let hydratedCode = code;
    if (focusPath) {
        const serverCode = await fetchCollabFileContent(workspacePath, focusPath, signal);
        if (typeof serverCode === 'string') {
            hydratedCode = serverCode;
        }
    }

    const hydratedFiles = [];
    const seen = new Set();
    for (const file of Array.isArray(files) ? files : []) {
        const path = file?.path || file?.name || '';
        if (!path || seen.has(path)) {
            hydratedFiles.push(file);
            continue;
        }
        seen.add(path);
        const serverContent = await fetchCollabFileContent(workspacePath, path, signal);
        if (typeof serverContent === 'string') {
            hydratedFiles.push({ ...file, content: serverContent });
        } else {
            hydratedFiles.push(file);
        }
    }

    let finalFiles = hydratedFiles;
    if (fullRepoContext) {
        const extraFiles = await hydrateFullRepoFiles({
            workspacePath,
            existingFiles: hydratedFiles,
            signal,
        });
        if (extraFiles.length) {
            finalFiles = [...hydratedFiles, ...extraFiles];
        }
    }

    return { code: hydratedCode, files: finalFiles };
};

/**
 * Sleep helper for retry delays
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Stream from Gemini with automatic retry on 429 rate limiting
 */
const streamGemini = async ({ model, apiKey, userContent, conversationHistory = [], signal, maxRetries = 3 }) => {
    const key = apiKey || process.env.GEMINI_API_KEY || '';
    if (!key) {
        throw new Error('Gemini API key is not configured');
    }
    const targetModel = model || DEFAULT_GEMINI_MODEL;
    const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(targetModel)}:streamGenerateContent?alt=sse&key=${key}`;

    // Build contents array for Gemini with conversation history
    const contents = [];
    
    // Add system instruction as first user message (Gemini doesn't have a dedicated system role in older API)
    // For newer models, we use systemInstruction
    const recentHistory = Array.isArray(conversationHistory) 
        ? conversationHistory.slice(-20) 
        : [];
    
    // Add conversation history
    for (const msg of recentHistory) {
        if (msg.role && msg.content) {
            // Map 'assistant' role to 'model' for Gemini
            const geminiRole = msg.role === 'assistant' ? 'model' : msg.role;
            if (geminiRole === 'user' || geminiRole === 'model') {
                contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
            }
        }
    }
    
    // Add current user message
    contents.push({ role: 'user', parts: [{ text: userContent }] });

    const requestBody = JSON.stringify({
        systemInstruction: { parts: [{ text: CODE_INTEL_SYSTEM_PROMPT }] },
        contents,
        generationConfig: { maxOutputTokens: 4096, temperature: 0.2 },
    });

    // Retry loop for 429 rate limiting
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const upstream = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'text/event-stream',
                },
                body: requestBody,
                signal,
            });

            // Handle rate limiting (429) with retry
            if (upstream.status === 429) {
                if (attempt < maxRetries) {
                    // Exponential backoff: 500ms, 1s, 2s + jitter
                    const delay = (500 * Math.pow(2, attempt)) + (Math.random() * 300);
                    console.warn(`[Gemini] Rate limited (429), retry ${attempt + 1}/${maxRetries} after ${delay.toFixed(0)}ms`);
                    await sleep(delay);
                    continue;
                }
                throw new Error(`Upstream error 429 (rate limited after ${maxRetries} retries)`);
            }

            if (!upstream.ok || !upstream.body) {
                throw new Error(`Upstream error ${upstream.status}`);
            }

            // Success - return the stream
            return createGeminiReadableStream(upstream);
            
        } catch (e) {
            lastError = e;
            const errMsg = String(e?.message || '').toLowerCase();
            
            // Only retry on rate limiting or transient errors
            if ((errMsg.includes('429') || errMsg.includes('resource') || errMsg.includes('quota')) && attempt < maxRetries) {
                const delay = (500 * Math.pow(2, attempt)) + (Math.random() * 300);
                console.warn(`[Gemini] Retryable error, retry ${attempt + 1}/${maxRetries} after ${delay.toFixed(0)}ms:`, e.message);
                await sleep(delay);
                continue;
            }
            
            throw e;
        }
    }
    
    throw lastError || new Error('Max retries exceeded');
};

/**
 * Create a ReadableStream from Gemini SSE response
 */
const createGeminiReadableStream = (upstream) => {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    return new ReadableStream({
        async pull(controller) {
            const { value, done } = await reader.read();
            if (done) {
                controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                controller.close();
                return;
            }
            if (!value) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const raw of lines) {
                const line = raw.replace(/^data:\s*/, '').trim();
                if (!line || line === '[DONE]') continue;
                try {
                    const parsed = JSON.parse(line);
                    const candidate = parsed?.candidates?.[0] || {};
                    const contentParts = candidate?.content?.parts || [];
                    const deltaParts = candidate?.delta?.content || candidate?.delta?.parts || [];
                    const textDelta =
                        contentParts.map((p) => p?.text || '').join('') ||
                        deltaParts.map((p) => (p?.parts ? p.parts.map((x) => x?.text || '').join('') : p?.text || '')).join('');
                    if (textDelta) {
                        controller.enqueue(encoder.encode(JSON.stringify({ delta: textDelta }) + '\n'));
                    }
                    if (candidate?.finishReason) {
                        controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                    }
                } catch (e) {
                    // ignore malformed lines
                }
            }
        },
        cancel() {
            try {
                reader.cancel();
            } catch (e) {}
        },
    });
};

const withTimeoutSignal = (requestSignal, timeoutMs = UPSTREAM_TIMEOUT_MS) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new Error('upstream-timeout'));
    }, timeoutMs);

    if (requestSignal) {
        const onAbort = () => {
            controller.abort(requestSignal.reason || new Error('client-abort'));
        };
        try {
            requestSignal.addEventListener('abort', onAbort, { once: true });
        } catch (e) {
            /* ignore */
        }
    }

    return {
        signal: controller.signal,
        dispose: () => clearTimeout(timer),
    };
};

export async function POST(request) {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    }

    const {
        prompt = '',
        code = '',
        files = [],
        lang = 'plaintext',
        focusPath = '',
        model = '',
        apiKey = '',
        // Code intelligence integration
        workspacePath = '',
        useCodeIntel = true, // Enable by default when workspacePath is provided
        maxContextTokens = 6000,
        conversationHistory = [],
        fullRepoContext = false,
    } = body || {};

    // TTFT optimization: Fetch code intel and hydrate from collab IN PARALLEL
    // This reduces latency by running both operations concurrently
    const codeIntelPromise = (useCodeIntel && workspacePath && prompt)
        ? fetchCodeIntelContext({
            workspacePath,
            query: prompt,
            maxTokens: maxContextTokens,
            conversationHistory,
        }).catch(e => {
            console.warn('[CodeIntel] Fetch failed, continuing without context:', e.message);
            return { context: '', sufficiency: 'UNKNOWN', sources: [], refusal: null };
        })
        : Promise.resolve(null);
    
    const hydratePromise = hydrateFromCollab({
        workspacePath,
        focusPath,
        code,
        files,
        signal: request.signal,
        fullRepoContext: Boolean(fullRepoContext),
    });

    // Wait for both in parallel
    const [codeIntelContext, { code: hydratedCode, files: hydratedFiles }] = await Promise.all([
        codeIntelPromise,
        hydratePromise,
    ]);
    
    if (codeIntelContext?.context) {
        console.log('[CodeIntel] Context fetched:', {
            contextLength: codeIntelContext.context.length,
            sufficiency: codeIntelContext.sufficiency,
            sourcesCount: codeIntelContext.sources?.length || 0,
        });
    }

    const userContent = buildUserContent({
        prompt,
        code: hydratedCode,
        files: hydratedFiles,
        lang,
        focusPath,
        codeIntelContext,
    });
    if (!userContent) {
        return NextResponse.json({ error: 'Empty prompt' }, { status: 400 });
    }

    const { signal, dispose } = withTimeoutSignal(request.signal);

    try {
        const geminiKey = apiKey || process.env.GEMINI_API_KEY || '';
        if (!geminiKey) {
            return NextResponse.json(
                {
                    error: 'Missing API key',
                    detail: 'Gemini API key is not configured. Set GEMINI_API_KEY environment variable.',
                },
                { status: 401 }
            );
        }
        const stream = await streamGemini({ model, apiKey: geminiKey, userContent, conversationHistory, signal });

        const traceSummary = buildTraceSummary(codeIntelContext?.trace || []);
        const sources = Array.isArray(codeIntelContext?.sources)
            ? codeIntelContext.sources.slice(0, 8).map((s) => ({
                file: s?.file || '',
                symbol: s?.symbol || '',
                start_line: s?.start_line || 0,
                end_line: s?.end_line || 0,
                score: typeof s?.score === 'number' ? s.score : null,
            }))
            : [];
        const sourcesHeader = sources.length ? encodeURIComponent(JSON.stringify(sources)) : '';

        return new NextResponse(stream, {
            headers: {
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-cache',
                // Include context metadata in headers for debugging
                'x-code-intel-sufficiency': codeIntelContext?.sufficiency || 'NONE',
                'x-code-intel-tokens': String(codeIntelContext?.tokensUsed || 0),
                'x-code-intel-trace-count': String(codeIntelContext?.trace?.length || 0),
                ...(traceSummary ? { 'x-code-intel-trace-summary': traceSummary } : {}),
                ...(sourcesHeader ? { 'x-code-intel-sources': sourcesHeader } : {}),
            },
        });
    } catch (e) {
        const errMsg = String(e?.message || '');
        const isTimeout = errMsg.includes('timeout');
        const isRateLimit = errMsg.includes('429') || errMsg.includes('rate') || errMsg.includes('quota');
        
        // Better status codes and messages
        let status = 502;
        let error = 'Upstream failure';
        let detail = errMsg || 'stream failed';
        
        if (errMsg.includes('401')) {
            status = 401;
            error = 'Authentication failed';
        } else if (isRateLimit) {
            status = 429;
            error = 'Rate limited';
            detail = 'The AI service is temporarily overloaded. Please wait a moment and try again.';
        } else if (isTimeout) {
            status = 504;
            error = 'Request timeout';
            detail = 'The request took too long to complete. Please try again.';
        }
        
        console.error(`[Chat API] Error: ${error} - ${detail}`);
        return NextResponse.json({ error, detail }, { status });
    } finally {
        dispose();
    }
}
