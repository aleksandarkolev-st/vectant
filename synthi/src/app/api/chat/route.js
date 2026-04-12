import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import { TOOL_DECLARATIONS, executeTool, isComplexTask } from './toolDefinitions.js';

const encoder = new TextEncoder();

/* ─── Pending command approvals (module-level, shared across requests) ─── */
/**
 * Use globalThis to persist Maps across Next.js HMR/module re-evaluations in dev mode.
 * Without this, Maps are reset on every file save, causing deferred commands to be lost.
 */
if (!globalThis.__chatPendingCommandApprovals) {
    globalThis.__chatPendingCommandApprovals = new Map();
}
if (!globalThis.__chatDeferredCommandsMap) {
    globalThis.__chatDeferredCommandsMap = new Map();
}

/**
 * Map of command IDs → { resolve, command, timestamp }
 * When a run_command tool call is encountered, the tool loop pauses and
 * waits for the frontend to approve/reject via POST /api/chat/approve-command.
 */
export const pendingCommandApprovals = globalThis.__chatPendingCommandApprovals;

/**
 * Map of deferred command IDs → { command, workspacePath }
 * Git write commands (add, commit, push) are deferred until after the user
 * reviews FILE: blocks. The approve-command endpoint executes them on approval.
 */
export const deferredCommandsMap = globalThis.__chatDeferredCommandsMap;

/** Regex to detect git write commands that should be deferred until after file review */
const GIT_WRITE_CMD_RE = /\bgit\s+(add|commit|push|merge|rebase|stash|reset|cherry-pick|tag\b)/i;

const COMMAND_APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes to approve

/**
 * Wait for user approval of a pending command.
 * Returns true if approved, false if rejected or timed out.
 */
function waitForCommandApproval(id, command) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            if (pendingCommandApprovals.has(id)) {
                pendingCommandApprovals.delete(id);
                resolve(false);
            }
        }, COMMAND_APPROVAL_TIMEOUT_MS);

        pendingCommandApprovals.set(id, {
            resolve: (approved) => {
                clearTimeout(timeout);
                resolve(approved);
            },
            command,
            timestamp: Date.now(),
        });
    });
}

/**
 * Generate a unique ID for pending command approvals.
 */
let approvalIdCounter = 0;
function generateApprovalId() {
    return `cmd-${Date.now()}-${++approvalIdCounter}`;
}
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
    '.code_intel_backups/',
    '.synthi/',
    '.turbo/',
];

// Filenames that should never be sent as AI context (token waste).
const IGNORE_FILENAMES = new Set([
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'composer.lock',
    'Gemfile.lock',
    'Cargo.lock',
    'poetry.lock',
]);

// Code Intelligence Backend
const CODE_INTEL_BASE = process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

const DEFAULT_GEMINI_MODEL = process.env.SYNTHI_AI_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash';
const UPSTREAM_TIMEOUT_MS = 45_000;

/**
 * Maps model name prefixes to their maximum output token limit.
 * Ordered most-specific first so e.g. "gemini-3.1-flash-lite-preview" matches before "gemini".
 * Values sourced from each provider's official model documentation.
 */
const MODEL_MAX_OUTPUT_TOKENS = [
    // Gemini family
    ['gemini-3.1-pro',       65_536],
    ['gemini-3.1-flash-lite', 65_536],
    ['gemini-3-flash',       65_536],
    ['gemini-2.5-pro',       65_536],
    ['gemini-2.5-flash',     65_536],
    ['gemini-2.0-flash',      8_192],
    ['gemini-1.5-pro',        8_192],
    ['gemini-1.5-flash',      8_192],
    ['gemini',                8_192],
    // OpenAI family
    ['gpt-4.1',             32_768],
    ['gpt-4o',              16_384],
    ['gpt-4-turbo',          4_096],
    ['gpt-4',                8_192],
    ['gpt-3.5-turbo',        4_096],
    ['o3',                  100_000],
    ['o4-mini',             100_000],
    // Claude family
    ['claude-3.5-sonnet',    8_192],
    ['claude-3-opus',        4_096],
    ['claude-3-sonnet',      4_096],
    ['claude-3-haiku',       4_096],
    ['claude',               4_096],
    // DeepSeek
    ['deepseek',             8_192],
];

/**
 * Look up the maximum output tokens for a given model name.
 * Falls back to 8192 for unknown models.
 */
function getMaxOutputTokens(modelName) {
    if (!modelName || typeof modelName !== 'string') return 8_192;
    const lower = modelName.toLowerCase();
    for (const [prefix, tokens] of MODEL_MAX_OUTPUT_TOKENS) {
        if (lower.startsWith(prefix)) return tokens;
    }
    return 8_192;
}

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
// NOTE: SEARCH/REPLACE markers are built via concatenation so that formatters/git
// hooks do not strip them as merge-conflict markers.
const SR_OPEN  = '<'.repeat(7) + ' SEARCH';
const SR_SEP   = '='.repeat(7);
const SR_CLOSE = '>'.repeat(7) + ' REPLACE';
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

COMPLETENESS RULES (CRITICAL — prevents shallow/incomplete changes):
13. DELIVER EVERYTHING YOU DESCRIBE. If you say "I'll update the color palette, typography, and animations", you MUST include SEARCH/REPLACE blocks for ALL of those. Never describe changes you don't implement.
14. For broad requests ("make it modern", "redesign the UI", "improve the styling"), make COMPREHENSIVE changes across ALL relevant sections. A single CSS property change is NOT "making it modern" — update colors, fonts, spacing, shadows, borders, animations, hover states, etc.
15. Prefer MANY SEARCH/REPLACE blocks that cover all the areas you described, rather than a brief summary + one tiny change.
16. If you run out of space, prioritize CODE CHANGES over text descriptions. The user wants working code, not essays about what could be changed.

BUG-FIX THOROUGHNESS RULES (CRITICAL — prevents shallow/incomplete fixes):
17. When the user asks you to FIX a bug, TRACE THE FULL EXECUTION PATH: event listener → handler function → state update → DOM/UI update. Do NOT stop at the first line that looks wrong.
18. READ ALL RELATED FUNCTIONS: If a click handler calls updateDisplay(), and updateDisplay() has a bug, fix updateDisplay() — not just the handler.
19. VERIFY YOUR FIX WORKS: After writing SEARCH/REPLACE blocks, mentally step through the code with your fix applied. Ask: "Does clicking X now produce Y?" If not, your fix is incomplete.
20. NEVER produce a trivial +1/-0 diff unless you are 100% certain that single line is the complete fix. If the fix seems too simple, look deeper — the real bug is likely in a called function, a CSS selector, a missing return value, or a logic error elsewhere.
21. CHECK THE ENTIRE DATA FLOW: Variables being set → functions that read them → DOM elements being updated. If any link in the chain is broken, fix ALL broken links, not just one.
22. When fixing "X doesn't work when I click it" bugs, check: (a) Is the event listener attached correctly? (b) Does the handler read the right data? (c) Does the handler call the right update function? (d) Does the update function actually modify the DOM/UI? Fix ALL broken parts.

FILE CREATION RULES:
23. When the user explicitly asks you to CREATE NEW FILES (e.g., "create a todo app", "make a new component", "add a new page"), you MUST create them at the requested paths using FILE: blocks - even if those paths don't exist in the context yet.
24. New file paths should respect the workspace structure shown in context. Place files in logical locations (e.g., components in src/components/, pages in src/app/).
25. You are NOT limited to only modifying existing files. If the user's request requires new files, create them.
26. CRITICAL: "Create new" means CREATE files that DO NOT YET EXIST. Choose NEW file names/paths. Do NOT modify or overwrite files that already exist in the workspace context. If the context shows files like page1.html and page2.html already exist, create page3.html, page4.html, etc. — NEVER send SEARCH/REPLACE blocks for existing files when the user asked to create NEW files.
27. When the user asks you to create new files AND also commit them, first emit all the FILE: blocks for the new files, then after the code blocks, tell the user you will commit them. Use run_command ONLY for git operations, not for creating source files.

FORMAT RULES FOR CODE CHANGES (CRITICAL - violation = rejection):

RULE 1 — MODIFYING EXISTING FILES: Use SEARCH/REPLACE blocks with explicit markers.
Show ONLY the changed sections, not the entire file. Each change MUST use this EXACT format:

FILE: path/to/file.js
\`\`\`
${SR_OPEN}
exact lines from the current file to find (include 2-3 lines context before/after)
${SR_SEP}
replacement lines (the fixed/updated version)
${SR_CLOSE}
\`\`\`

You may include MULTIPLE SEARCH/REPLACE blocks within a single FILE: block.
The SEARCH section MUST match the existing file EXACTLY (same whitespace, indentation, symbols).
Include 2-3 unchanged lines before and after the changed lines for safe anchoring.
NEVER return raw file content without ${SR_OPEN} / ${SR_SEP} / ${SR_CLOSE} markers for existing files.

RULE 2 — CREATING NEW FILES: Use full file content (NO SEARCH/REPLACE markers).
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
- For existing files, ALWAYS use ${SR_OPEN} / ${SR_SEP} / ${SR_CLOSE} markers. Never return raw/full file content.
- Do NOT use diff markers (---, +++, @@, +/- line prefixes).
- Do NOT mix HTML into JavaScript files or vice versa — match content to extension.
- Close all code fences with \`\`\` on their own line.

EXAMPLES OF CORRECT FORMAT:

✓ Modifying an existing file (fixing a bug in a function):
FILE: main.js
\`\`\`
${SR_OPEN}
function updateCounter() {
    document.getElementById('count').innerText = count;
}
${SR_SEP}
function updateCounter() {
    const el = document.getElementById('count');
    if (el) el.innerText = count;
    updateDisplay();
}
${SR_CLOSE}
\`\`\`

✓ Multiple SEARCH/REPLACE changes in one file:
FILE: src/App.js
\`\`\`
${SR_OPEN}
import React from 'react';
${SR_SEP}
import React from 'react';
import { Shop } from './Shop';
${SR_CLOSE}

${SR_OPEN}
  return <div>Hello</div>;
${SR_SEP}
  return <div>Hello<Shop /></div>;
${SR_CLOSE}
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
✗ Returning raw file content for an existing file WITHOUT ${SR_OPEN} / ${SR_SEP} / ${SR_CLOSE} markers (CAUSES DATA LOSS)
✗ Returning just the replacement code without the SEARCH section showing what to find
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
- create_file(path, content): Create a new file in the workspace. The file will be presented to the user for review with Apply/Reject buttons before being written to disk. Always use this tool when creating new files — it is the preferred way to create files.
- create_directory(path): Create a directory in the workspace. Parent directories are created automatically. Use this instead of mkdir via the terminal.
- run_command(command): Execute a shell command in the user's live terminal (they can see it running). Use this ONLY for: git operations, installing packages, running builds/tests/linting, and other CLI tasks. Do NOT use this for creating or writing files. The user must approve command execution before it runs. IMPORTANT: Each call opens a new terminal tab, so chain related commands with && (e.g. "git add . && git commit -m 'msg' && git push"). Only use separate calls when you need output from one command to decide the next.
- web_search(query, num_results?): Search the internet and return real, up-to-date results with titles, URLs, and snippets.

IMPORTANT TOOL GUIDELINES:
- FILE CREATION: When the user asks you to create NEW files (pages, components, modules, scripts, stylesheets, configs), ALWAYS use the create_file tool. Call create_file(path, content) for EACH new file with its full content. The system will present the files to the user for review with Apply/Reject buttons. Do NOT use echo, touch, cat, printf, or run_command to create files. Do NOT generate FILE: blocks in your text — use the create_file tool instead.
- ORDERING: When the user asks you to create files AND THEN commit/push/run commands: call create_file for each file, then call run_command for git operations. Git write commands (add/commit/push) are automatically deferred — they are presented to the user only AFTER they review and apply the files. So call them freely; the system handles the ordering.
- DIRECTORY CREATION: Use create_directory instead of mkdir via run_command.
- When the user asks to run a command, check a status, install, commit, push, or perform any terminal/git task — use the run_command tool. Do NOT tell the user to do it themselves. Do NOT suggest code changes instead.
- When the user asks to "check" something (e.g., "check git status", "check if X is installed"), use run_command. Do NOT return code changes.
- When you need to understand the codebase, use read_file and search_workspace to gather context before answering.
- You CAN and SHOULD use multiple tools in sequence. Call a tool, read the result, then decide what to do next.
- After running commands, report the actual output clearly to the user. Do NOT invent file changes based on command output.
- If a command fails, report the error and suggest fixes.
- When the user's request only involves running commands (not editing code), respond with the command output only — do NOT generate FILE: blocks or code changes.
- CRITICAL: When the user asks you to commit, push, deploy, delete, install, or execute any potentially destructive or irreversible command, you MUST describe what commands you plan to run and ask the user for confirmation BEFORE executing them. Only proceed to call run_command after the user confirms. For safe read-only commands (git status, git log, ls, cat, etc.), you may execute immediately without asking.
- TERMINAL TAB EFFICIENCY: Each run_command call opens a new terminal tab in the user's IDE. To avoid cluttering the terminal bar, ALWAYS chain related commands into a single run_command call using && (e.g. "mkdir project && cd project && npm init -y", or "git add . && git commit -m 'msg' && git push"). Only use separate run_command calls when you genuinely need the output of one command to decide the next command.
- FILE CREATION REMINDER: When the user asks you to create files with specific content, ALWAYS use the create_file tool with the full file content. Do NOT use run_command with echo/touch/cat. Do NOT generate FILE: blocks in your text response — the create_file tool handles presenting files for user review.
- NEW vs EXISTING: When the user says "create new files/pages/components", use create_file for NEW paths that do not already exist. Do NOT modify existing files from the context to serve as the "new" files. Choose unique, descriptive names. Existing files in context are only for reference (e.g., to match the project style or to add navigation links).
- BEFORE EDITING: When you need to MODIFY an EXISTING file using SEARCH/REPLACE blocks in your text response, you MUST first call read_file(path) to read its current contents. The SEARCH section must EXACTLY match lines from the file you just read. NEVER generate SEARCH blocks from memory or guesswork — always base them on the actual file content you just retrieved via read_file.

WEB SEARCH GUIDELINES:
- ONLY use web_search when: (1) the user explicitly asks you to search, find, or look up something online, (2) the user needs a real, valid URL such as an image link, CDN link, API endpoint, or documentation page, or (3) you genuinely cannot answer without current information from the internet (e.g., latest package versions, current API docs, real resource URLs).
- Do NOT use web_search for general coding questions, syntax help, or concepts you already know from your training.
- When the user asks to add an image, icon, font, or any external resource from the web, use web_search to find a real, working URL. NEVER guess or fabricate URLs.
- After searching, use the actual URLs from the results — do NOT modify or make up URLs.
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
async function fetchCodeIntelContext({ workspacePath, query, maxTokens = 30000, conversationHistory = [], userId }) {
    if (!workspacePath) {
        return { context: '', sufficiency: 'UNKNOWN', sources: [], refusal: null };
    }
    
    try {
        // When userId is available, pass slug/userId so code-intel resolves
        // to the correct per-user repo directory (repos/{slug}/{userId}/).
        const effectivePath = userId ? `${workspacePath}/${userId}` : workspacePath;
        const response = await fetch(`${CODE_INTEL_BASE}/code-intel/context`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                workspace_path: effectivePath,
                query: query,
                max_tokens: maxTokens,
                conversation_history: conversationHistory,
            }),
            // RAG micro-navigation needs ~2-3s; give 6s to avoid dropping context
            signal: AbortSignal.timeout(6000),
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

const fetchCollabFileContent = async (slug, filePath, signal, userId) => {
    if (!slug || !filePath) return null;
    try {
        const safePath = encodeFilePath(filePath);
        const url = `${COLLAB_BASE}/file-content/${encodeURIComponent(slug)}/${safePath}`;
        const headers = {};
        if (userId) headers['x-user-id'] = userId;
        const res = await fetch(url, { method: 'GET', signal, headers });
        if (!res.ok) return null;
        return await res.text();
    } catch (e) {
        return null;
    }
};

const shouldIgnorePath = (path = '') => {
    const normalized = String(path || '').replace(/\\/g, '/');
    if (DEFAULT_IGNORE.some((prefix) => normalized.startsWith(prefix))) return true;
    const basename = normalized.split('/').pop() || '';
    return IGNORE_FILENAMES.has(basename);
};

const fetchRepoFileList = async (slug, signal, userId) => {
    if (!slug) return [];
    try {
        const url = `${COLLAB_BASE}/git/${encodeURIComponent(slug)}/files-meta`;
        const headers = {};
        if (userId) headers['x-user-id'] = userId;
        const res = await fetch(url, { method: 'GET', signal, headers });
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data?.files) ? data.files : [];
    } catch (e) {
        return [];
    }
};

const hydrateFullRepoFiles = async ({ workspacePath, existingFiles, signal, userId }) => {
    const fileMeta = await fetchRepoFileList(workspacePath, signal, userId);
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

        const content = await fetchCollabFileContent(workspacePath, relPath, signal, userId);
        if (typeof content !== 'string' || !content) continue;

        const trimmed = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content;
        totalChars += trimmed.length;
        hydrated.push({ path: relPath, content: trimmed });
    }

    return hydrated;
};

const hydrateFromCollab = async ({ workspacePath, focusPath, code, files, signal, fullRepoContext = false, userId }) => {
    if (!workspacePath) return { code, files };

    let hydratedCode = code;
    if (focusPath) {
        const serverCode = await fetchCollabFileContent(workspacePath, focusPath, signal, userId);
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
        const serverContent = await fetchCollabFileContent(workspacePath, path, signal, userId);
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
            userId,
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
 *  3. For run_command: emit commandPending event, wait for user approval
 *  4. Once Gemini returns only text → stream the final text to the client
 *
 * Events are streamed in real-time (not collected) so the frontend sees
 * command approval requests as they happen.
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
    const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(targetModel)}:generateContent?key=${key}`;
    const streamEndpoint = `${GEMINI_BASE}/models/${encodeURIComponent(targetModel)}:streamGenerateContent?alt=sse&key=${key}`;

    const systemInstruction = { parts: [{ text: AGENTIC_SYSTEM_PROMPT }] };
    const generationConfig = { maxOutputTokens: getMaxOutputTokens(targetModel), temperature: 0.2 };
    const tools = [{ functionDeclarations: TOOL_DECLARATIONS }];

    // Build contents array
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

    // Use a TransformStream so we can push events in real-time  
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const writeEvent = async (obj) => {
        try {
            await writer.write(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch (e) {
            // Stream may have been cancelled
        }
    };

    // Run the tool loop asynchronously, pushing events as they happen
    (async () => {
        try {
            let round = 0;
            const deferredCommands = [];  // git write commands deferred until after FILE: blocks
            const collectedFiles = [];    // create_file calls intercepted → emit as FILE: blocks

            while (round < MAX_TOOL_ROUNDS) {
                let data;
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

                const fnCalls = parts.filter((p) => p.functionCall);
                if (fnCalls.length === 0) {
                    // No tool calls — model produced final text. Stream it out.
                    const finalText = parts.map((p) => p.text || '').join('');
                    const CHUNK_SIZE = 120;
                    for (let i = 0; i < finalText.length; i += CHUNK_SIZE) {
                        await writeEvent({ delta: finalText.slice(i, i + CHUNK_SIZE) });
                    }
                    // Emit collected files as structured event — reliable delivery
                    // independent of text delta stream / progressive parsing
                    if (collectedFiles.length > 0) {
                        await writeEvent({ fileBlocks: collectedFiles.map(f => ({ path: f.path, content: f.content })) });
                    }
                    // Also emit as synthetic FILE: blocks in the text stream for
                    // backwards compatibility / text bubble display
                    if (collectedFiles.length > 0) {
                        let syntheticBlocks = '\n\n';
                        for (const cf of collectedFiles) {
                            syntheticBlocks += `FILE: ${cf.path}\n\`\`\`\n${cf.content}\n\`\`\`\n\n`;
                        }
                        await writeEvent({ delta: syntheticBlocks });
                    }
                    // Attach collected files to deferred command map entries so
                    // approve-command can write them to disk before running git
                    if (collectedFiles.length > 0) {
                        for (const dc of deferredCommands) {
                            const entry = deferredCommandsMap.get(dc.id);
                            if (entry) entry.files = collectedFiles.map(f => ({ ...f }));
                        }
                    }
                    // Emit deferred git commands AFTER the file content so the user sees FILE: blocks first
                    for (const dc of deferredCommands) {
                        await writeEvent({
                            commandPending: {
                                id: dc.id,
                                command: dc.command,
                                tool: 'run_command',
                                args: dc.args,
                                deferred: true,
                                filesCount: collectedFiles.length,
                            },
                        });
                    }
                    await writeEvent({ done: true });
                    await writer.close();
                    return;
                }

                // Append model's function-call turn to contents
                contents.push({ role: 'model', parts });

                // Execute tool calls — with approval gating for run_command
                const fnResponses = [];
                for (const part of fnCalls) {
                    const { name, args } = part.functionCall;

                    if (name === 'run_command') {
                        const command = (args?.command || '').trim();

                        // ── Detect git write commands → DEFER them ──
                        // Git add/commit/push must wait until the user reviews
                        // and applies FILE: block suggestions. We tell Gemini
                        // the command is deferred and continue generating.
                        if (GIT_WRITE_CMD_RE.test(command)) {
                            const approvalId = generateApprovalId();
                            deferredCommands.push({ id: approvalId, command, args });
                            // Store for the approve-command endpoint to execute later
                            deferredCommandsMap.set(approvalId, { command, workspacePath });
                            // Tell Gemini the command is deferred — don't retry
                            fnResponses.push({
                                functionResponse: {
                                    name,
                                    response: {
                                        deferred: true,
                                        message: `Command "${command}" has been deferred. It will be presented to the user for approval AFTER they review and apply the file changes you generate. Do NOT retry or re-call this command. Instead, continue by generating the FILE: blocks for any files you need to create, then mention the deferred command in your response text.`,
                                    },
                                },
                            });
                            continue;
                        }

                        // ── Non-git commands: Command Approval Gate ──
                        const approvalId = generateApprovalId();

                        // Emit commandPending event to the frontend
                        await writeEvent({
                            commandPending: {
                                id: approvalId,
                                command,
                                tool: name,
                                args,
                            },
                        });

                        // Wait for user approval (blocks until approved/rejected/timeout)
                        const approved = await waitForCommandApproval(approvalId, command);

                        if (approved) {
                            // User approved — execute the command
                            await writeEvent({ toolCall: { tool: name, args, status: 'running' } });
                            const result = await executeTool(name, args, workspacePath, signal, { apiKey: key });
                            const evt = { tool: name, args, status: 'done' };
                            if (result?.sessionId) evt.sessionId = result.sessionId;
                            await writeEvent({ toolCall: evt });
                            fnResponses.push({ functionResponse: { name, response: result } });
                        } else {
                            // User rejected — tell Gemini the command was declined
                            await writeEvent({
                                toolCall: { tool: name, args, status: 'declined' },
                            });
                            fnResponses.push({
                                functionResponse: {
                                    name,
                                    response: {
                                        error: 'User declined command execution. Do not retry this command. Continue without it or ask the user for guidance.',
                                        declined: true,
                                    },
                                },
                            });
                        }
                    } else if (name === 'create_file') {
                        // ── Intercept create_file → collect for FILE: blocks ──
                        // Instead of writing to disk, we collect the file content
                        // and emit it as synthetic FILE: blocks AFTER the text streams.
                        // This gives the user Apply/Reject buttons for review.
                        const filePath = (args?.path || '').trim();
                        const content = args?.content ?? '';
                        if (filePath) {
                            collectedFiles.push({ path: filePath, content });
                            await writeEvent({ toolCall: { tool: name, args: { path: filePath }, status: 'collected' } });
                        }
                        // Tell Gemini the file was accepted — so it doesn't retry
                        fnResponses.push({
                            functionResponse: {
                                name,
                                response: {
                                    success: true,
                                    path: filePath,
                                    bytesWritten: content.length,
                                    note: 'File will be presented to the user for review. Do NOT generate FILE: blocks for this file in your text response — it is already handled.',
                                },
                            },
                        });
                    } else {
                        // Non-command tools execute immediately (read_file, search, etc.)
                        await writeEvent({ toolCall: { tool: name, args, status: 'running' } });
                        const result = await executeTool(name, args, workspacePath, signal, { apiKey: key });
                        await writeEvent({ toolCall: { tool: name, args, status: 'done' } });
                        fnResponses.push({ functionResponse: { name, response: result } });
                    }
                }

                contents.push({ role: 'function', parts: fnResponses });
                round++;
            }

            // Exhausted tool rounds — final streaming call WITHOUT tools
            const finalBody = { systemInstruction, contents, generationConfig };
            const finalRes = await fetch(streamEndpoint, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
                body: JSON.stringify(finalBody),
                signal,
            });
            if (!finalRes.ok) throw new Error(`Gemini error ${finalRes.status}`);

            // Stream the final SSE response
            const reader = finalRes.body.getReader();
            const decoder = new TextDecoder();
            let sseBuffer = '';
            let accumulatedText = '';
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                if (!value) continue;
                sseBuffer += decoder.decode(value, { stream: true });
                const lines = sseBuffer.split('\n');
                sseBuffer = lines.pop() || '';
                for (const raw of lines) {
                    const line = raw.replace(/^data:\s*/, '').trim();
                    if (!line || line === '[DONE]') continue;
                    try {
                        const parsed = JSON.parse(line);
                        const textDelta = (parsed?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('');
                        if (textDelta) {
                            accumulatedText += textDelta;
                            await writeEvent({ delta: textDelta });
                        }
                    } catch (e) { /* skip */ }
                }
            }
            // Validate final output
            const validation = validateResponseFormat(accumulatedText);
            if (!validation.isValid && validation.errors.length > 0) {
                await writeEvent({ validationError: validation.errors.join('\n'), validationFailed: true });
            }
            // Emit collected files as structured event — reliable delivery
            if (collectedFiles.length > 0) {
                await writeEvent({ fileBlocks: collectedFiles.map(f => ({ path: f.path, content: f.content })) });
            }
            // Also emit as synthetic FILE: blocks in the text stream
            if (collectedFiles.length > 0) {
                let syntheticBlocks = '\n\n';
                for (const cf of collectedFiles) {
                    syntheticBlocks += `FILE: ${cf.path}\n\`\`\`\n${cf.content}\n\`\`\`\n\n`;
                }
                await writeEvent({ delta: syntheticBlocks });
            }
            // Attach collected files to deferred command map entries so
            // approve-command can write them to disk before running git
            if (collectedFiles.length > 0) {
                for (const dc of deferredCommands) {
                    const entry = deferredCommandsMap.get(dc.id);
                    if (entry) entry.files = collectedFiles.map(f => ({ ...f }));
                }
            }
            // Emit deferred git commands AFTER the file content
            for (const dc of deferredCommands) {
                await writeEvent({
                    commandPending: {
                        id: dc.id,
                        command: dc.command,
                        tool: 'run_command',
                        args: dc.args,
                        deferred: true,
                        filesCount: collectedFiles.length,
                    },
                });
            }
            await writeEvent({ done: true });
            await writer.close();
        } catch (e) {
            try {
                await writeEvent({ error: e.message || 'Tool loop failed' });
                await writeEvent({ done: true });
                await writer.close();
            } catch (_) { }
        }
    })();

    return readable;
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
        generationConfig: { maxOutputTokens: getMaxOutputTokens(targetModel), temperature: 0.2 },
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
        maxContextTokens = 30000,
        conversationHistory = [],
        fullRepoContext = false,
        // Agentic tool-use mode
        useTools = 'auto', // 'auto' | true | false
    } = body || {};

    // ── Resolve userId from server session ──────────────────────────
    // The collab server needs x-user-id to resolve per-user repos at
    // repos/{slug}/{userId}/.  Without this, all file reads fail with
    // ENOENT — the root cause of "No response received" on AI features.
    let userId = null;
    try {
        const session = await getServerSession(authOptions);
        userId = session?.user?.id || session?.user?.email || null;
    } catch (e) {
        console.warn('[Chat] Could not resolve userId from session:', e.message);
    }

    // TTFT optimization: Fetch code intel and hydrate from collab IN PARALLEL
    // This reduces latency by running both operations concurrently
    const codeIntelPromise = (useCodeIntel && workspacePath && prompt)
        ? fetchCodeIntelContext({
            workspacePath,
            query: prompt,
            maxTokens: maxContextTokens,
            conversationHistory,
            userId,
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
        userId,
    });

    // Wait for both in parallel
    const [codeIntelContext, { code: hydratedCode, files: hydratedFiles }] = await Promise.all([
        codeIntelPromise,
        hydratePromise,
    ]);

    // ── RAG-driven file hydration ───────────────────────────────────
    // Extract file paths discovered by the RAG pipeline and hydrate any
    // that weren't already in the frontend's files[] payload.  This
    // ensures the LLM sees full file content for RAG-sourced files,
    // not just the text blob summary.
    let finalFiles = hydratedFiles;
    if (codeIntelContext?.sources?.length && workspacePath) {
        const existingPaths = new Set(
            (hydratedFiles || []).map((f) => f?.path || f?.name).filter(Boolean)
        );
        // Normalise: strip leading slashes so paths match
        const norm = (p) => String(p || '').replace(/^\/+/, '').replace(/\\/g, '/');
        const normExisting = new Set([...existingPaths].map(norm));

        const ragPaths = [...new Set(
            codeIntelContext.sources
                .map((s) => s?.file)
                .filter(Boolean)
                .filter((f) => !NODE_MODULES_PATTERN.test(f))
        )];

        const ragNewPaths = ragPaths.filter((p) => !normExisting.has(norm(p)));
        if (ragNewPaths.length > 0) {
            const ragHydrated = [];
            for (const ragPath of ragNewPaths.slice(0, 8)) {
                try {
                    const content = await fetchCollabFileContent(workspacePath, ragPath, request.signal, userId);
                    if (typeof content === 'string' && content) {
                        const trimmed = content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) : content;
                        ragHydrated.push({
                            path: ragPath,
                            content: `[RAG-sourced: high relevance]\n${trimmed}`,
                            ragSource: true,
                        });
                    }
                } catch (_) { /* skip on error */ }
            }
            if (ragHydrated.length > 0) {
                // Prepend RAG files so they appear first (highest relevance)
                finalFiles = [...ragHydrated, ...hydratedFiles];
                console.log(`[CodeIntel] RAG-hydrated ${ragHydrated.length} additional files:`,
                    ragHydrated.map((f) => f.path));
            }
        }
    }
    
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
        files: finalFiles,
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
