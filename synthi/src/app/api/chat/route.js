import { NextResponse } from 'next/server';
import { TOOL_DECLARATIONS, executeTool, isComplexTask } from './toolDefinitions.js';

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

GROUNDING RULES (CRITICAL - prevents hallucination):
8. When EXPLAINING or REFERENCING existing code, ONLY reference files, functions, classes, and symbols that appear in the provided CODE CONTEXT section.
9. If you need to mention code that is NOT in the context, explicitly state "This is not in the provided context but..."
10. NEVER invent or assume the existence of files, functions, or symbols not shown in context when answering questions about existing code.
11. If the context doesn't contain enough information to answer, say so clearly rather than guessing.
12. When explaining code, quote or reference specific lines from the context to ground your answer.

FILE CREATION RULES:
13. When the user explicitly asks you to CREATE NEW FILES (e.g., "create a todo app", "make a new component", "add a new page"), you MUST create them at the requested paths using FILE: blocks - even if those paths don't exist in the context yet.
14. New file paths should respect the workspace structure shown in context. Place files in logical locations (e.g., components in src/components/, pages in src/app/).
15. You are NOT limited to only modifying existing files. If the user's request requires new files, create them.

FORMAT RULES FOR CODE CHANGES (CRITICAL - violation = rejection):

RULE 1 — MODIFYING EXISTING FILES: Use SEARCH/REPLACE blocks.
Show ONLY the changed sections, not the entire file. Each change uses this exact format:

FILE: path/to/file.js
\`\`\`
<<<<<<< SEARCH
exact lines from the current file to find (include 2-3 lines of surrounding context)
=======
the replacement lines (with surrounding context preserved)
>>>>>>> REPLACE
\`\`\`

You may include multiple SEARCH/REPLACE blocks within a single FILE: block.
The SEARCH section must match the existing file EXACTLY (same whitespace, indentation, symbols).
Include 2-3 unchanged lines before and after the changed lines for safe anchoring.

RULE 2 — CREATING NEW FILES: Use full file content.
FILE: path/to/new-file.js
\`\`\`javascript
[complete file content]
\`\`\`

RULE 3 — DELETING FILES:
FILE: path/to/file.js
\`\`\`
DELETE
\`\`\`

IMPORTANT FORMAT DETAILS:
- Each file gets EXACTLY ONE FILE: block. Never repeat the same file path.
- For existing files, use SEARCH/REPLACE. NEVER return the full file — it causes data loss.
- Do NOT use diff markers (---, +++, @@, +/- line prefixes).
- Do NOT mix HTML into JavaScript files or vice versa — match content to extension.
- Close all code fences with \`\`\` on their own line.

EXAMPLES OF CORRECT FORMAT:

✓ Modifying an existing file (adding a nav link):
FILE: index.html
\`\`\`
<<<<<<< SEARCH
    <nav>
        <a href="about.html">About</a>
    </nav>
=======
    <nav>
        <a href="about.html">About</a>
        <a href="shop.html">Shop</a>
    </nav>
>>>>>>> REPLACE
\`\`\`

✓ Multiple SEARCH/REPLACE changes in one file:
FILE: src/App.js
\`\`\`
<<<<<<< SEARCH
import React from 'react';
=======
import React from 'react';
import { Shop } from './Shop';
>>>>>>> REPLACE

<<<<<<< SEARCH
  return <div>Hello</div>;
=======
  return <div>Hello<Shop /></div>;
>>>>>>> REPLACE
\`\`\`

✓ Creating a NEW file (full content, NO SEARCH/REPLACE):
FILE: src/pages/todo.html
\`\`\`html
<!DOCTYPE html>
<html><head><title>Todo</title></head>
<body><div id="app"></div></body>
</html>
\`\`\`

EXAMPLES OF WRONG FORMAT (WILL BE REJECTED):
✗ Returning full or partial file content for an existing file WITHOUT SEARCH/REPLACE markers (CAUSES DATA LOSS — the system replaces the entire file with whatever you return)
✗ Truncating the file — returning content starting from the middle of the file
✗ Duplicate FILE: blocks for the same path
✗ Mixing HTML content in a .js file
✗ Unclosed code fences
✗ Truncated content with "...rest omitted..."

You have access to code context retrieved from the user's workspace. Use this context to provide accurate, specific answers.

If the context is insufficient to answer the question, say so clearly rather than guessing.`;

// Extended system prompt for the agentic (tool-calling) path.
// Tells Gemini about its tools so it actually uses them.
const AGENTIC_SYSTEM_PROMPT = `${CODE_INTEL_SYSTEM_PROMPT}

TOOL USE:
You have access to the following tools to help answer the user's request. USE THEM proactively when they would help you give a better answer:

- read_file(path): Read the contents of a file in the workspace.
- search_workspace(query): Search for text/symbols across the workspace.
- list_directory(path): List files and folders in a directory.
- run_command(command): Execute a shell command in the workspace and see its output (stdout/stderr). Use this for tasks like checking versions, running build tools, installing packages, running tests, linting, etc.

IMPORTANT TOOL GUIDELINES:
- When the user asks you to run a command, check a version, install something, or perform any terminal task — call run_command immediately. Do NOT tell the user to do it themselves.
- When you need to understand the codebase, use read_file and search_workspace to gather context before answering.
- You CAN and SHOULD use multiple tools in sequence. Call a tool, read the result, then decide what to do next.
- After running commands, report the actual output to the user.
- If a command fails, report the error and suggest fixes.
`;


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

const NODE_MODULES_PATTERN = /[\/\\]node_modules[\/\\]/;

/**
 * Filter node_modules paths from code intel context text.
 * Removes entire chunks that reference node_modules files.
 */
const filterNodeModulesFromContext = (contextText = '') => {
    if (!contextText) return '';
    // Split on chunk boundaries (common patterns: "--- FILE:" or "## " or line-separated code blocks)
    // Remove any section whose file path contains node_modules
    return contextText
        .split(/(?=^(?:---|##|FILE:|Source:)\s)/m)
        .filter((chunk) => !NODE_MODULES_PATTERN.test(chunk))
        .join('')
        .trim();
};

const buildTraceSummary = (trace = []) => {
    if (!Array.isArray(trace) || trace.length === 0) return '';
    // Filter out node_modules and blocked entries
    const validTrace = trace.filter((t) => {
        if (!t) return false;
        const file = t.file || '';
        if (NODE_MODULES_PATTERN.test(file)) return false;
        if (t.reason === 'blocked_path') return false;
        return true;
    });
    if (validTrace.length === 0) return '';
    const included = validTrace.filter((t) => t?.reason === 'included');
    const top = (included.length ? included : validTrace).slice(0, 6);
    const parts = top.map((t) => {
        const file = t?.file || 'unknown';
        const symbol = t?.symbol ? `:${t.symbol}` : '';
        const score = typeof t?.score === 'number' ? `(${t.score.toFixed(2)})` : '';
        return `${file}${symbol}${score}`;
    });
    const text = parts.join(' | ');
    return text.length > 380 ? `${text.slice(0, 377)}...` : text;
};

const parseDataUri = (value = '') => {
    if (typeof value !== 'string') return null;
    const match = value.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) return null;
    return { mimeType: match[1], data: match[2] };
};

const buildImageParts = (attachments = []) => {
    if (!Array.isArray(attachments) || attachments.length === 0) return [];
    const parts = [];
    attachments.forEach((att) => {
        if (!att || att.kind !== 'image' || typeof att.content !== 'string') return;
        const parsed = parseDataUri(att.content);
        const mimeType = parsed?.mimeType || att.type || 'image/png';
        const data = parsed?.data || (att.content.startsWith('data:') ? '' : att.content);
        if (!data) return;
        parts.push({ text: `Image attachment: ${att.name || 'image'} (${mimeType})` });
        parts.push({ inlineData: { mimeType, data } });
    });
    return parts;
};

/**
 * Validate response format to catch malformed outputs BEFORE sending to client.
 * Catches:
 * - Duplicate FILE blocks (same file mentioned multiple times)
 * - Empty file blocks
 * - Missing closing code fences
 * - HTML/JS content mixing
 * @param {string} response - The raw model response
 * @returns {Object} - { isValid: boolean, errors: string[], warnings: string[] }
 */
const validateResponseFormat = (response = '') => {
    const errors = [];
    const warnings = [];
    
    if (!response || typeof response !== 'string') {
        return { isValid: false, errors: ['Empty or invalid response'], warnings: [] };
    }
    
    // Extract all FILE: blocks
    const fileRegex = /FILE:\s*([^\n]+)\n([\s\S]*?)(?=FILE:|$)/gi;
    const fileBlocks = [];
    let match;
    const seenFiles = new Set();
    
    while ((match = fileRegex.exec(response)) !== null) {
        const filePath = (match[1] || '').trim();
        const content = match[2] || '';
        
        if (!filePath) {
            errors.push('Found FILE: block with empty path');
            continue;
        }
        
        // Check for duplicates
        if (seenFiles.has(filePath)) {
            errors.push(`Duplicate FILE block for ${filePath} - model repeated the same file`);
        } else {
            seenFiles.add(filePath);
        }
        
        // Check for empty content
        if (!content || !content.trim() || content.trim() === '```') {
            warnings.push(`FILE ${filePath} has empty or placeholder content`);
        }
        
        // Check for unclosed code fences — downgrade to warning since template
        // literals, inline markdown, and CSS content can contain legitimate backticks
        const openFences = (content.match(/```/g) || []).length;
        if (openFences % 2 !== 0) {
            warnings.push(`FILE ${filePath} has unclosed code fence (odd number of backticks)`);
        }
        
        // Check for HTML/JS mixing (common problem)
        const hasHTML = /<html|<body|<head|<!DOCTYPE/i.test(content);
        const hasJSImport = /^import\s|^export\s|^const\s|^function\s/m.test(filePath);
        if (hasHTML && hasJSImport) {
            errors.push(`FILE ${filePath}: mixing HTML and JS content - likely wrong file`);
        }
        
        fileBlocks.push({ filePath, content });
    }
    
    // Check for HTML DOCTYPE appearing multiple times (sign of duplication)
    const doctypeCount = (response.match(/<!DOCTYPE/gi) || []).length;
    if (doctypeCount > 1) {
        errors.push(`Multiple <!DOCTYPE> tags found (${doctypeCount}) - file duplication in response`);
    }
    
    // Check if response looks like it's mixing multiple unrelated files (high FILE: count)
    if (fileBlocks.length > 8) {
        warnings.push(`Response modifies ${fileBlocks.length} files - unusually high; might be unfocused`);
    }
    
    const isValid = errors.length === 0;
    return { isValid, errors, warnings };
};


const buildUserContent = ({ prompt, code, files, lang, focusPath, codeIntelContext }) => {
    const parts = [];
    
    // If code intelligence provided context, include it first with clear boundaries
    if (codeIntelContext?.context) {
        // Filter out any node_modules content that leaked through
        const filteredContext = filterNodeModulesFromContext(codeIntelContext.context);
        if (filteredContext) {
            parts.push('=== RELEVANT CODE CONTEXT (retrieved by deterministic controller) ===');
            parts.push(filteredContext);
            parts.push('=== END CODE CONTEXT ===');
        }
        
        // Add grounded symbols list for LLM to reference (excluding node_modules)
        if (Array.isArray(codeIntelContext.sources) && codeIntelContext.sources.length > 0) {
            const filteredSources = codeIntelContext.sources.filter(
                (s) => s?.file && !NODE_MODULES_PATTERN.test(s.file)
            );
            const groundedFiles = [...new Set(filteredSources.map(s => s?.file).filter(Boolean))];
            const groundedSymbols = [...new Set(filteredSources.map(s => s?.symbol).filter(Boolean))];
            if (groundedFiles.length > 0) {
                parts.push(`[GROUNDED FILES: ${groundedFiles.join(', ')}]`);
            }
            if (groundedSymbols.length > 0) {
                parts.push(`[GROUNDED SYMBOLS: ${groundedSymbols.join(', ')}]`);
            }
            if (groundedFiles.length > 0) {
                parts.push('[IMPORTANT: Only reference the above files and symbols in your response. Do not invent or assume other code exists.]');
            }
        }
        
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

const MAX_TOOL_ROUNDS = 6; // hard cap on tool-call round-trips

/**
 * Make a single (non-streaming) Gemini call that may include tool results.
 * Returns the parsed response body.
 */
const callGeminiOnce = async ({ endpoint, systemInstruction, contents, tools, generationConfig, signal }) => {
    const body = { systemInstruction, contents, generationConfig };
    if (tools) body.tools = tools;
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) throw new Error(`Gemini error ${res.status}`);
    return res.json();
};

/**
 * Agentic streaming: Gemini with function-calling tool loop.
 *
 * Flow:
 *  1. Initial Gemini call (non-streaming) with tool declarations
 *  2. If response contains functionCall parts → execute tools, append results, loop
 *  3. Once Gemini returns only text → stream the final text to the client
 *
 * We use non-streaming for tool-loop turns (they're fast, small) and then
 * convert the final text into the same NDJSON stream format the frontend expects.
 *
 * @returns {ReadableStream} NDJSON stream compatible with the existing frontend
 */
const streamGeminiWithTools = async ({
    model,
    apiKey,
    userContent,
    conversationHistory = [],
    attachments = [],
    workspacePath = '',
    signal,
    maxRetries = 3,
}) => {
    const key = apiKey || process.env.GEMINI_API_KEY || '';
    if (!key) throw new Error('Gemini API key is not configured');

    const targetModel = model || DEFAULT_GEMINI_MODEL;
    // Use non-streaming generateContent for tool rounds, streaming for final pass
    const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(targetModel)}:generateContent?key=${key}`;
    const streamEndpoint = `${GEMINI_BASE}/models/${encodeURIComponent(targetModel)}:streamGenerateContent?alt=sse&key=${key}`;

    const systemInstruction = { parts: [{ text: AGENTIC_SYSTEM_PROMPT }] };
    const generationConfig = { maxOutputTokens: 4096, temperature: 0.2 };
    const tools = [{ functionDeclarations: TOOL_DECLARATIONS }];

    // Build contents array (same as streamGemini)
    const contents = [];
    const recentHistory = Array.isArray(conversationHistory) ? conversationHistory.slice(-20) : [];
    for (const msg of recentHistory) {
        if (msg.role && msg.content) {
            const geminiRole = msg.role === 'assistant' ? 'model' : msg.role;
            if (geminiRole === 'user' || geminiRole === 'model') {
                contents.push({ role: geminiRole, parts: [{ text: msg.content }] });
            }
        }
    }
    const imageParts = buildImageParts(attachments);
    contents.push({ role: 'user', parts: [{ text: userContent }, ...imageParts] });

    // Collect tool-call events for the frontend progress stream
    const toolEvents = [];
    let round = 0;

    // ── Tool loop ────────────────────────────────────────────────────
    while (round < MAX_TOOL_ROUNDS) {
        let data;
        // Retry wrapper for 429s
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                data = await callGeminiOnce({ endpoint, systemInstruction, contents, tools, generationConfig, signal });
                break;
            } catch (e) {
                const msg = String(e?.message || '').toLowerCase();
                if ((msg.includes('429') || msg.includes('quota')) && attempt < maxRetries) {
                    await sleep(500 * Math.pow(2, attempt) + Math.random() * 300);
                    continue;
                }
                throw e;
            }
        }

        const candidate = data?.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        // Check for function calls
        const fnCalls = parts.filter((p) => p.functionCall);
        if (fnCalls.length === 0) {
            // No tool calls — model produced final text. Stream it out.
            const finalText = parts.map((p) => p.text || '').join('');
            return createTextStream(finalText, toolEvents);
        }

        // Append model's function-call turn to contents
        contents.push({ role: 'model', parts });

        // Execute each tool call in parallel
        const fnResponses = await Promise.all(
            fnCalls.map(async (part) => {
                const { name, args } = part.functionCall;
                toolEvents.push({ tool: name, args, status: 'running' });
                const result = await executeTool(name, args, workspacePath, signal);
                toolEvents[toolEvents.length - 1].status = 'done';
                return { functionResponse: { name, response: result } };
            })
        );

        // Append function responses to contents so Gemini sees the results
        contents.push({ role: 'function', parts: fnResponses });
        round++;
    }

    // If we exhausted rounds, do a final streaming call WITHOUT tools to force text output
    const finalBody = { systemInstruction, contents, generationConfig };
    const finalRes = await fetch(streamEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(finalBody),
        signal,
    });
    if (!finalRes.ok) throw new Error(`Gemini error ${finalRes.status}`);
    return createAgenticValidatedStream(finalRes.body, toolEvents);
};

/**
 * Convert a plain text string into an NDJSON ReadableStream,
 * prefixed with any tool-call events the frontend can display.
 */
const createTextStream = (text, toolEvents = []) => {
    const chunks = [];
    // Emit tool events first
    for (const evt of toolEvents) {
        chunks.push(JSON.stringify({ toolCall: evt }) + '\n');
    }
    // Chunk the text so the frontend gets incremental deltas
    const CHUNK_SIZE = 120;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        chunks.push(JSON.stringify({ delta: text.slice(i, i + CHUNK_SIZE) }) + '\n');
    }
    chunks.push(JSON.stringify({ done: true }) + '\n');

    let idx = 0;
    return new ReadableStream({
        pull(controller) {
            if (idx < chunks.length) {
                controller.enqueue(encoder.encode(chunks[idx++]));
            } else {
                controller.close();
            }
        },
    });
};

/**
 * Wrap a streaming SSE response with validation AND prepend tool events.
 */
const createAgenticValidatedStream = (upstreamBody, toolEvents = []) => {
    const reader = upstreamBody.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedText = '';
    let headerSent = false;

    return new ReadableStream({
        async pull(controller) {
            // First, emit tool events as header
            if (!headerSent) {
                for (const evt of toolEvents) {
                    controller.enqueue(encoder.encode(JSON.stringify({ toolCall: evt }) + '\n'));
                }
                headerSent = true;
            }
            try {
                const { value, done } = await reader.read();
                if (done) {
                    const validation = validateResponseFormat(accumulatedText);
                    if (!validation.isValid && validation.errors.length > 0) {
                        controller.enqueue(encoder.encode(JSON.stringify({ validationError: validation.errors.join('\n'), validationFailed: true }) + '\n'));
                    }
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
                        const parts = parsed?.candidates?.[0]?.content?.parts || [];
                        const textDelta = parts.map((p) => p?.text || '').join('');
                        if (textDelta) {
                            accumulatedText += textDelta;
                            controller.enqueue(encoder.encode(JSON.stringify({ delta: textDelta }) + '\n'));
                        }
                        if (parsed?.candidates?.[0]?.finishReason) {
                            controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                        }
                    } catch (e) { /* skip malformed */ }
                }
            } catch (error) {
                controller.error(error);
            }
        },
        cancel() { try { reader.cancel(); } catch (e) {} },
    });
};

/**
 * Stream from Gemini with automatic retry on 429 rate limiting
 */
const streamGemini = async ({ model, apiKey, userContent, conversationHistory = [], attachments = [], signal, maxRetries = 3 }) => {
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
    
    // Add current user message (with inline image parts if provided)
    const imageParts = buildImageParts(attachments);
    const userParts = [{ text: userContent }, ...imageParts];
    contents.push({ role: 'user', parts: userParts });

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
 * Wrap a response stream with validation checks.
 * Accumulates response chunks and validates format in real-time.
 * If critical validation errors are detected, sends validation error instead of bad response.
 */
const createValidatedStream = (upstream) => {
    const reader = upstream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedText = '';
    let validationErrorSent = false;
    
    return new ReadableStream({
        async pull(controller) {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    // Final validation check
                    if (!validationErrorSent) {
                        const validation = validateResponseFormat(accumulatedText);
                        if (!validation.isValid && validation.errors.length > 0) {
                            // Send validation error as metadata only — never as visible delta text
                            const errorMsg = `[VALIDATION ERROR] Response violated format rules:\n${validation.errors.join('\n')}`;
                            console.warn('[Validated Stream]', errorMsg);
                            controller.enqueue(encoder.encode(JSON.stringify({ validationError: errorMsg, validationFailed: true }) + '\n'));
                            validationErrorSent = true;
                        }
                    }
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
                            accumulatedText += textDelta;
                            
                            // Check for critical errors mid-stream (stop early if found)
                            if (!validationErrorSent && accumulatedText.length > 600) {
                                // Every ~600 chars, do a quick check
                                const validation = validateResponseFormat(accumulatedText);
                                if (!validation.isValid && validation.errors.some(e => e.includes('Duplicate') || e.includes('DOCTYPE'))) {
                                    // Critical error detected - send as metadata, not visible text
                                    const errorMsg = `[VALIDATION ERROR] Critical format violation detected:\n${validation.errors.slice(0, 2).join('\n')}`;
                                    console.warn('[Validated Stream]', errorMsg);
                                    controller.enqueue(encoder.encode(JSON.stringify({ validationError: errorMsg, validationFailed: true }) + '\n'));
                                    validationErrorSent = true;
                                    // Don't try to further validate, just pass through
                                }
                            }
                            
                            controller.enqueue(encoder.encode(JSON.stringify({ delta: textDelta }) + '\n'));
                        }
                        if (candidate?.finishReason) {
                            controller.enqueue(encoder.encode(JSON.stringify({ done: true }) + '\n'));
                        }
                    } catch (e) {
                        // ignore malformed lines
                    }
                }
            } catch (error) {
                console.error('[Validated Stream] Error:', error.message);
                controller.error(error);
            }
        },
        cancel() {
            try {
                reader.cancel();
            } catch (e) {}
        },
    });
};

/**
 * Create a ReadableStream from Gemini SSE response
 */
const createGeminiReadableStream = (upstream) => {
    return createValidatedStream(upstream.body);
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
        attachments = [],
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
        // Agentic tool-use mode
        useTools = 'auto', // 'auto' | true | false
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

        // ── Choose fast path vs. agentic path ───────────────────────
        const shouldUseTools =
            useTools === true ||
            (useTools === 'auto' && workspacePath && isComplexTask(prompt, (files || []).length));
        
        let stream;
        if (shouldUseTools && workspacePath) {
            console.log('[Chat API] Using agentic tool-calling path');
            stream = await streamGeminiWithTools({
                model,
                apiKey: geminiKey,
                userContent,
                conversationHistory,
                attachments,
                workspacePath,
                signal,
            });
        } else {
            stream = await streamGemini({ model, apiKey: geminiKey, userContent, conversationHistory, attachments, signal });
        }

        const traceSummary = buildTraceSummary(codeIntelContext?.trace || []);
        // Build sources from code-intel backend; fall back to files sent by the frontend
        let sources = Array.isArray(codeIntelContext?.sources) && codeIntelContext.sources.length > 0
            ? codeIntelContext.sources
                .filter((s) => s?.file && !NODE_MODULES_PATTERN.test(s.file))
                .slice(0, 8)
                .map((s) => ({
                    file: s?.file || '',
                    symbol: s?.symbol || '',
                    start_line: s?.start_line || 0,
                    end_line: s?.end_line || 0,
                    score: typeof s?.score === 'number' ? s.score : null,
                }))
            : [];
        // If code-intel didn't provide sources, derive them from the files the user sent
        if (sources.length === 0 && Array.isArray(files) && files.length > 0) {
            sources = files
                .filter(f => (f?.path || f?.name))
                .slice(0, 8)
                .map(f => ({
                    file: f.path || f.name,
                    symbol: '',
                    start_line: 0,
                    end_line: 0,
                    score: null,
                }));
        }
        const traceFallback = traceSummary || (sources.length > 0 ? sources.map(s => s.file).join(', ') : '');
        const sourcesHeader = sources.length ? encodeURIComponent(JSON.stringify(sources)) : '';

        return new NextResponse(stream, {
            headers: {
                'content-type': 'application/x-ndjson',
                'cache-control': 'no-cache',
                // Include context metadata in headers for debugging
                'x-code-intel-sufficiency': codeIntelContext?.sufficiency || 'NONE',
                'x-code-intel-tokens': String(codeIntelContext?.tokensUsed || 0),
                // Count only included entries for accurate telemetry
                'x-code-intel-trace-count': String(
                    codeIntelContext?.trace?.filter(t => t?.reason === 'included')?.length || 0
                ),
                ...(traceFallback ? { 'x-code-intel-trace-summary': traceFallback } : {}),
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
