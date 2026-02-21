/**
 * Gemini Function Calling — Tool Definitions & Executors
 *
 * Provides the tool declarations for Gemini's native function-calling API
 * and the executor functions that fulfil each tool call against the
 * collab-server / workspace filesystem.
 *
 * Design: keep this module pure — no streaming logic, no Gemini client.
 * route.js imports declarations + executors and wires them into the
 * streaming loop.
 */

const COLLAB_BASE =
    (process.env.COLLAB_SERVER_URL || process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234').replace(/\/$/, '');

const MAX_READ_CHARS = 30_000;
const MAX_SEARCH_RESULTS = 8;
const MAX_DIR_ENTRIES = 60;

/* ─── Gemini function declarations ────────────────────────────────── */

export const TOOL_DECLARATIONS = [
    {
        name: 'read_file',
        description:
            'Read the full contents of a file from the workspace. Use this when you need to see code that was not provided in the initial context.',
        parameters: {
            type: 'OBJECT',
            properties: {
                path: { type: 'STRING', description: 'Relative workspace path, e.g. "src/utils/auth.js"' },
            },
            required: ['path'],
        },
    },
    {
        name: 'search_workspace',
        description:
            'Search all workspace file paths for a keyword or pattern. Returns matching relative paths (not file contents). Use this to discover files relevant to the task.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: { type: 'STRING', description: 'Search keyword or pattern to match against file paths' },
            },
            required: ['query'],
        },
    },
    {
        name: 'list_directory',
        description:
            'List files and subdirectories in a workspace directory. Returns names only (suffixed with "/" for directories).',
        parameters: {
            type: 'OBJECT',
            properties: {
                path: { type: 'STRING', description: 'Relative directory path, e.g. "src/components". Use "" or "." for the root.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'run_command',
        description:
            'Execute a shell command in the workspace directory and return its stdout/stderr. ' +
            'Use this for: installing dependencies (npm install), running build tools, ' +
            'checking versions, running tests, linting, or any CLI task. ' +
            'Commands run with a 30-second timeout. Avoid long-running or interactive commands. ' +
            'IMPORTANT: Each call opens a new terminal tab. To minimize tabs, chain related commands ' +
            'into ONE call using && (e.g. "git add . && git commit -m msg && git push"). ' +
            'Only use separate calls when you need to read output from one command before deciding the next.',
        parameters: {
            type: 'OBJECT',
            properties: {
                command: {
                    type: 'STRING',
                    description: 'The shell command to run. Chain multiple commands with && to minimize terminal tabs, e.g. "mkdir project && cd project && npm init -y" or "git add . && git commit -m \'Initial commit\' && git push"',
                },
            },
            required: ['command'],
        },
    },
    {
        name: 'web_search',
        description:
            'Search the internet for information. Returns titles, snippets, and URLs from web results. ' +
            'ONLY use this when: (1) the user explicitly asks you to search/find something online, ' +
            '(2) the user asks for a real URL, image link, CDN link, or online resource, or ' +
            '(3) you need up-to-date information not available in the workspace or your training data ' +
            '(e.g., current API docs, latest package versions, live URLs). ' +
            'Do NOT use this for general coding questions you can already answer.',
        parameters: {
            type: 'OBJECT',
            properties: {
                query: {
                    type: 'STRING',
                    description: 'The search query, e.g. "unsplash free landscape image url" or "tailwindcss v4 installation docs"',
                },
                num_results: {
                    type: 'INTEGER',
                    description: 'Number of results to return (1-10, default 5)',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'create_file',
        description:
            'Create a new file in the workspace with the given content, or overwrite an existing file. ' +
            'Use this instead of run_command with echo/touch/cat when creating or writing source files. ' +
            'Parent directories are created automatically. ' +
            'This is the PREFERRED way to create files — it writes directly to disk without the terminal.',
        parameters: {
            type: 'OBJECT',
            properties: {
                path: {
                    type: 'STRING',
                    description: 'Relative workspace path for the new file, e.g. "src/pages/about.jsx"',
                },
                content: {
                    type: 'STRING',
                    description: 'Full file content to write',
                },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'create_directory',
        description:
            'Create a new directory in the workspace. Parent directories are created automatically. ' +
            'Use this instead of run_command with mkdir.',
        parameters: {
            type: 'OBJECT',
            properties: {
                path: {
                    type: 'STRING',
                    description: 'Relative workspace directory path, e.g. "src/components/ui"',
                },
            },
            required: ['path'],
        },
    },
];

/* ─── Helpers ─────────────────────────────────────────────────────── */

const encodePath = (p = '') =>
    String(p || '')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/');

/* ─── Tool executors ──────────────────────────────────────────────── */

async function execReadFile(slug, args, signal) {
    const filePath = args?.path;
    if (!filePath) return { error: 'Missing required parameter: path' };
    try {
        const url = `${COLLAB_BASE}/file-content/${encodeURIComponent(slug)}/${encodePath(filePath)}`;
        const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: `File not found or unreadable: ${filePath} (${res.status})` };
        let text = await res.text();
        if (text.length > MAX_READ_CHARS) text = text.slice(0, MAX_READ_CHARS) + '\n…[truncated]';
        return { path: filePath, content: text };
    } catch (e) {
        return { error: `Failed to read ${filePath}: ${e.message}` };
    }
}

async function execSearchWorkspace(slug, args, signal) {
    const query = (args?.query || '').toLowerCase();
    if (!query) return { error: 'Missing required parameter: query' };
    try {
        const url = `${COLLAB_BASE}/git/${encodeURIComponent(slug)}/files-meta`;
        const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { matches: [], note: 'Could not retrieve workspace file list' };
        const data = await res.json();
        const files = Array.isArray(data?.files) ? data.files : [];
        const matches = files
            .map((f) => f?.path || '')
            .filter((p) => p && p.toLowerCase().includes(query))
            .slice(0, MAX_SEARCH_RESULTS);
        return { query, matches, total: matches.length };
    } catch (e) {
        return { matches: [], note: `Search failed: ${e.message}` };
    }
}

async function execListDirectory(slug, args, signal) {
    const dirPath = (args?.path || '').replace(/^[./\\]+/, '');
    try {
        const url = `${COLLAB_BASE}/git/${encodeURIComponent(slug)}/files-meta`;
        const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { error: `Could not list directory (${res.status})` };
        const data = await res.json();
        const files = Array.isArray(data?.files) ? data.files : [];
        // Filter to direct children of dirPath
        const prefix = dirPath ? `${dirPath}/` : '';
        const entries = new Set();
        for (const f of files) {
            const p = f?.path || '';
            if (!p) continue;
            if (prefix && !p.startsWith(prefix)) continue;
            const rest = prefix ? p.slice(prefix.length) : p;
            const slashIdx = rest.indexOf('/');
            entries.add(slashIdx === -1 ? rest : rest.slice(0, slashIdx) + '/');
            if (entries.size >= MAX_DIR_ENTRIES) break;
        }
        return { path: dirPath || '.', entries: [...entries] };
    } catch (e) {
        return { error: `Failed to list directory: ${e.message}` };
    }
}

const MAX_CMD_OUTPUT = 20_000;
const CMD_TIMEOUT_MS = 30_000;

/**
 * Blocked commands / patterns that could damage the workspace or host.
 */
const BLOCKED_PATTERNS = [
    /\brm\s+-rf\s+[\/~]/i,
    /\bformat\b.*\b[a-z]:\\?/i,
    /\bdd\b.*\bof=/i,
    /\bmkfs\b/i,
    /\b:(){ ?:|:& ?};:/,             // fork bomb
    /\bshutdown\b|\breboot\b/i,
    /\bkill\s+-9\s+1\b/i,
];

async function execRunCommand(slug, args) {
    let command = (args?.command || '').trim();
    if (!command) return { error: 'Missing required parameter: command' };

    // Safety: block obviously destructive patterns
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
            return { error: `Blocked: command matches a restricted pattern` };
        }
    }

    // ── Windows PowerShell 5.1 compatibility ──
    // The AI often generates bash-style `cmd1 && cmd2` chains, but
    // PowerShell 5.1 does NOT support `&&` as a pipeline chain operator
    // (that was added in PowerShell 7+). Replace with `;` which is the
    // PowerShell statement separator. This makes chained commands work
    // correctly in the PTY terminal.
    if (typeof process !== 'undefined' && process.platform === 'win32' && command.includes('&&')) {
        command = command.replace(/\s*&&\s*/g, ' ; ');
    }

    try {
        // Use /exec-terminal to run in a real PTY that the user can see
        // Falls back to /exec if /exec-terminal is unavailable
        const terminalUrl = `${COLLAB_BASE}/exec-terminal/${encodeURIComponent(slug)}`;
        const execUrl = `${COLLAB_BASE}/exec/${encodeURIComponent(slug)}`;

        let res;
        let usedTerminal = false;
        try {
            res = await fetch(terminalUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ command, timeout: CMD_TIMEOUT_MS }),
                signal: AbortSignal.timeout(CMD_TIMEOUT_MS + 5000),
            });
            usedTerminal = res.ok;
        } catch (_) {
            // /exec-terminal not available, fall through to /exec
        }

        if (!usedTerminal) {
            res = await fetch(execUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ command, timeout: CMD_TIMEOUT_MS }),
                signal: AbortSignal.timeout(CMD_TIMEOUT_MS + 5000),
            });
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { error: `Exec endpoint error (${res.status}): ${body.slice(0, 500)}` };
        }
        const data = await res.json();

        // Build output depending on which endpoint responded
        let output;
        if (usedTerminal) {
            output = data.output || '(no output)';
        } else {
            output = (data.stdout || '') + (data.stderr ? `\n[stderr]\n${data.stderr}` : '');
        }
        if (output.length > MAX_CMD_OUTPUT) output = output.slice(0, MAX_CMD_OUTPUT) + '\n…[truncated]';

        return {
            command,
            exitCode: data.exitCode ?? null,
            output: output || '(no output)',
            timedOut: Boolean(data.timedOut),
            // Include sessionId so the frontend can open the terminal tab
            sessionId: data.sessionId || null,
        };
    } catch (e) {
        return { error: `Failed to execute command: ${e.message}` };
    }
}

/* ─── Web Search executor ─────────────────────────────────────────── */

const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || '';
const GOOGLE_SEARCH_CX = process.env.GOOGLE_SEARCH_CX || '';

async function execWebSearch(_slug, args, _signal, options = {}) {
    const query = (args?.query || '').trim();
    if (!query) return { error: 'Missing required parameter: query' };
    const numResults = Math.min(Math.max(args?.num_results || 5, 1), 10);

    // Strategy 1: Serper.dev (fastest, most reliable)
    if (SERPER_API_KEY) {
        try {
            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: {
                    'X-API-KEY': SERPER_API_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ q: query, num: numResults }),
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) throw new Error(`Serper error ${res.status}`);
            const data = await res.json();
            const results = (data.organic || []).slice(0, numResults).map((r) => ({
                title: r.title || '',
                url: r.link || '',
                snippet: r.snippet || '',
            }));
            const answerBox = data.answerBox
                ? { answer: data.answerBox.answer || data.answerBox.snippet || '', source: data.answerBox.link || '' }
                : null;
            return { query, results, answerBox, source: 'serper' };
        } catch (e) {
            console.warn('[web_search] Serper failed, trying fallback:', e.message);
        }
    }

    // Strategy 2: Google Custom Search API
    if (GOOGLE_SEARCH_API_KEY && GOOGLE_SEARCH_CX) {
        try {
            const params = new URLSearchParams({
                key: GOOGLE_SEARCH_API_KEY,
                cx: GOOGLE_SEARCH_CX,
                q: query,
                num: String(numResults),
            });
            const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`, {
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) throw new Error(`Google CSE error ${res.status}`);
            const data = await res.json();
            const results = (data.items || []).slice(0, numResults).map((r) => ({
                title: r.title || '',
                url: r.link || '',
                snippet: r.snippet || '',
            }));
            return { query, results, answerBox: null, source: 'google_cse' };
        } catch (e) {
            console.warn('[web_search] Google CSE failed:', e.message);
        }
    }

    // Strategy 3: Gemini grounding via Google Search (uses existing Gemini API key)
    const geminiKey = options?.apiKey || process.env.GEMINI_API_KEY || '';
    if (geminiKey) {
        try {
            // Try grounding with Google Search tool
            const model = 'gemini-3-flash';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: `Search the web for: ${query}\n\nReturn the top ${numResults} results with title, URL, and a brief snippet for each.` }] }],
                    tools: [{ google_search: {} }],
                    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
                }),
                signal: AbortSignal.timeout(12000),
            });
            if (!res.ok) {
                const errBody = await res.text().catch(() => '');
                console.warn(`[web_search] Gemini grounding HTTP ${res.status}:`, errBody.slice(0, 300));
                throw new Error(`Gemini grounding error ${res.status}`);
            }
            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const groundingMeta = data?.candidates?.[0]?.groundingMetadata;
            const chunks = groundingMeta?.groundingChunks || [];
            const results = chunks.length > 0
                ? chunks.slice(0, numResults).map((c) => ({
                    title: c.web?.title || '',
                    url: c.web?.uri || '',
                    snippet: '',
                }))
                : [{ title: 'Search results', url: '', snippet: text.slice(0, 2000) }];
            const searchQueries = (groundingMeta?.webSearchQueries || []).slice(0, 3);
            return { query, results, answerBox: null, source: 'gemini_grounding', searchQueries };
        } catch (e) {
            console.warn('[web_search] Gemini grounding failed:', e.message);
        }

        // Strategy 3b: Fallback — ask Gemini WITHOUT grounding tool (uses model knowledge)
        try {
            const model = 'gemini-3-flash';
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: `I need information about: ${query}\n\nProvide a concise, factual answer. Include any relevant URLs, versions, or documentation links you know of.` }] }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
                }),
                signal: AbortSignal.timeout(10000),
            });
            if (!res.ok) throw new Error(`Gemini fallback error ${res.status}`);
            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (text) {
                return { query, results: [{ title: 'AI Knowledge', url: '', snippet: text.slice(0, 3000) }], answerBox: { answer: text.slice(0, 1000), source: 'gemini' }, source: 'gemini_knowledge' };
            }
        } catch (e) {
            console.warn('[web_search] Gemini knowledge fallback failed:', e.message);
        }
    }

    return { error: 'No search API configured. Set SERPER_API_KEY, GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX, or GEMINI_API_KEY in environment variables.' };
}

/* ─── Create File executor ─────────────────────────────────────── */

async function execCreateFile(slug, args) {
    const filePath = (args?.path || '').trim();
    const content = args?.content ?? '';
    if (!filePath) return { error: 'Missing required parameter: path' };
    try {
        const url = `${COLLAB_BASE}/git/${encodeURIComponent(slug)}/write-file`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, content }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { error: `Failed to write file (${res.status}): ${body.slice(0, 300)}` };
        }
        return { success: true, path: filePath, bytesWritten: content.length };
    } catch (e) {
        return { error: `Failed to create file: ${e.message}` };
    }
}

/* ─── Create Directory executor ───────────────────────────────── */

async function execCreateDirectory(slug, args) {
    const dirPath = (args?.path || '').trim();
    if (!dirPath) return { error: 'Missing required parameter: path' };
    try {
        const url = `${COLLAB_BASE}/git/${encodeURIComponent(slug)}/create-directory`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dirPath }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { error: `Failed to create directory (${res.status}): ${body.slice(0, 300)}` };
        }
        return { success: true, path: dirPath };
    } catch (e) {
        return { error: `Failed to create directory: ${e.message}` };
    }
}

const EXECUTORS = {
    read_file: execReadFile,
    search_workspace: execSearchWorkspace,
    list_directory: execListDirectory,
    run_command: execRunCommand,
    web_search: execWebSearch,
    create_file: execCreateFile,
    create_directory: execCreateDirectory,
};

/**
 * Execute a single tool call.
 * @param {string} name  Tool name
 * @param {Object} args  Tool arguments (from Gemini functionCall)
 * @param {string} slug  Workspace slug for collab-server
 * @param {AbortSignal} signal
 * @param {Object} [options]  Extra options (e.g. apiKey for web_search)
 * @returns {Promise<Object>} JSON-serialisable result
 */
export async function executeTool(name, args, slug, signal, options = {}) {
    const fn = EXECUTORS[name];
    if (!fn) return { error: `Unknown tool: ${name}` };
    return fn(slug, args, signal, options);
}

/* ─── Complexity detector ─────────────────────────────────────────── */

const COMPLEX_PATTERNS = [
    /\bcreate\b.*\b(app|project|page|component|module|file)/i,
    /\bmulti[- ]?file/i,
    /\brefactor\b.*\b(across|all|every|multiple)/i,
    /\bsearch\b.*\b(for|find|locate|where)\b/i,
    /\badd\b.*\bnew\b.*\b(file|page|route|component)/i,
    /\bbuild\b.*\b(from scratch|new)/i,
    /\b(install|run|execute|npm|yarn|pnpm|pip|cargo|make)\b/i,
    /\btest(s|ing)?\b.*\b(run|fix|check)/i,
    /\bset\s?up\b/i,
    /\bscaffold\b/i,
    /\bmigrat(e|ion)\b/i,
    /\bintegrat(e|ion)\b/i,
    // Terminal / command / git operations — need tool use
    /\bgit\s+(status|log|diff|branch|remote|stash|show|checkout|pull|push|commit|add)\b/i,
    /\bcheck\b.*\b(status|version|installed|dependencies|packages)\b/i,
    /\b(ls|dir|pwd|cat|echo|which|where|whoami)\b/i,
    /\bshow\b.*\b(status|output|result|log)\b/i,
    /\bversion\b/i,
    // Web search triggers
    /\b(find|get|search|look\s?up)\b.*\b(online|web|internet|url|link|image|icon|font|cdn)\b/i,
    /\bfrom\s+(the\s+)?(web|internet|online|an?\s+online)\b/i,
    /\b(image|photo|picture)\s+(url|link|from)\b/i,
    /\blatest\b.*\b(version|docs|documentation|release)\b/i,
];

/**
 * Decide whether a prompt is complex enough to warrant agentic tool use.
 * Returns true when the task likely needs file exploration, multi-file creation,
 * or command execution.
 */
export function isComplexTask(prompt = '', fileCount = 0) {
    const score = COMPLEX_PATTERNS.reduce((n, re) => n + (re.test(prompt) ? 1 : 0), 0);
    // Two or more signals → agentic; or if the user explicitly asks for Agent mode
    // One signal with no files also qualifies (e.g., "check git status" needs tools, not file context)
    return score >= 2 || (score >= 1 && fileCount === 0) || score >= 1;
}
