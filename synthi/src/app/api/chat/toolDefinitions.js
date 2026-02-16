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
            'Commands run with a 30-second timeout. Avoid long-running or interactive commands.',
        parameters: {
            type: 'OBJECT',
            properties: {
                command: {
                    type: 'STRING',
                    description: 'The shell command to run, e.g. "npm install" or "npx tsc --noEmit"',
                },
            },
            required: ['command'],
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
    const command = (args?.command || '').trim();
    if (!command) return { error: 'Missing required parameter: command' };

    // Safety: block obviously destructive patterns
    for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
            return { error: `Blocked: command matches a restricted pattern` };
        }
    }

    try {
        const url = `${COLLAB_BASE}/exec/${encodeURIComponent(slug)}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ command, timeout: CMD_TIMEOUT_MS }),
            signal: AbortSignal.timeout(CMD_TIMEOUT_MS + 5000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { error: `Exec endpoint error (${res.status}): ${body.slice(0, 500)}` };
        }
        const data = await res.json();
        // Truncate huge outputs
        let output = (data.stdout || '') + (data.stderr ? `\n[stderr]\n${data.stderr}` : '');
        if (output.length > MAX_CMD_OUTPUT) output = output.slice(0, MAX_CMD_OUTPUT) + '\n…[truncated]';
        return {
            command,
            exitCode: data.exitCode ?? null,
            output: output || '(no output)',
            timedOut: Boolean(data.timedOut),
        };
    } catch (e) {
        return { error: `Failed to execute command: ${e.message}` };
    }
}

const EXECUTORS = {
    read_file: execReadFile,
    search_workspace: execSearchWorkspace,
    list_directory: execListDirectory,
    run_command: execRunCommand,
};

/**
 * Execute a single tool call.
 * @param {string} name  Tool name
 * @param {Object} args  Tool arguments (from Gemini functionCall)
 * @param {string} slug  Workspace slug for collab-server
 * @param {AbortSignal} signal
 * @returns {Promise<Object>} JSON-serialisable result
 */
export async function executeTool(name, args, slug, signal) {
    const fn = EXECUTORS[name];
    if (!fn) return { error: `Unknown tool: ${name}` };
    return fn(slug, args, signal);
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
];

/**
 * Decide whether a prompt is complex enough to warrant agentic tool use.
 * Returns true when the task likely needs file exploration / multi-file creation.
 */
export function isComplexTask(prompt = '', fileCount = 0) {
    const score = COMPLEX_PATTERNS.reduce((n, re) => n + (re.test(prompt) ? 1 : 0), 0);
    // Two or more signals → agentic; or if the user explicitly asks for Agent mode
    return score >= 2 || (score >= 1 && fileCount === 0);
}
