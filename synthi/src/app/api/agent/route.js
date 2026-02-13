import { NextResponse } from 'next/server';

/**
 * Agent API Route — executes a single agent step on the backend.
 *
 * Each agent type has specific tools it can invoke. The agent receives:
 * - agentType: which sub-agent to run
 * - instruction: what the agent should do
 * - context: accumulated context from prior agent steps
 * - tools: allowed tool names
 * - workspacePath: workspace slug for file operations
 * - activeFilePath: currently focused file
 * - activeFileContent: content of focused file
 *
 * The agent calls the AI engine backend or performs local operations
 * and returns structured results.
 */

const COLLAB_BASE =
    (process.env.COLLAB_SERVER_URL || process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234').replace(/\/$/, '');

const CODE_INTEL_BASE = process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000';

const GEMINI_BASE =
    (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');

const DEFAULT_GEMINI_MODEL = process.env.SYNTHI_AI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// ── File Operations ─────────────────────────────────────────────────

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

// ── Agent Tool Executors ────────────────────────────────────────────

/**
 * Execute the "read_file" tool — fetch file content from collab server.
 */
async function toolReadFile({ workspacePath, filePath, signal }) {
    if (!workspacePath || !filePath) {
        return { success: false, error: 'Missing workspace path or file path' };
    }
    const content = await fetchCollabFileContent(workspacePath, filePath, signal);
    if (typeof content !== 'string') {
        return { success: false, error: `File not found: ${filePath}` };
    }
    // Truncate very large files
    const truncated = content.length > 12000 ? content.slice(0, 12000) + '\n... [truncated]' : content;
    return { success: true, content: truncated, path: filePath, size: content.length };
}

/**
 * Execute the "list_directory" tool — list files in the workspace.
 */
async function toolListDirectory({ workspacePath, directory = '', signal }) {
    const allFiles = await fetchRepoFileList(workspacePath, signal);
    const prefix = directory ? directory.replace(/\/$/, '') + '/' : '';
    const matching = allFiles
        .map((f) => f?.path || '')
        .filter((p) => p && (prefix ? p.startsWith(prefix) : true))
        .filter((p) => !p.includes('node_modules/') && !p.includes('.git/'))
        .slice(0, 50);
    return { success: true, files: matching, count: matching.length, directory: directory || '/' };
}

/**
 * Execute the "grep_search" tool — search for patterns via code intel.
 */
async function toolGrepSearch({ workspacePath, query, signal }) {
    try {
        const response = await fetch(`${CODE_INTEL_BASE}/code-intel/context`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(5000),
            body: JSON.stringify({
                workspace_path: workspacePath,
                query: query,
                max_tokens: 4000,
            }),
        });
        if (!response.ok) {
            return { success: false, error: `Search failed (${response.status})` };
        }
        const data = await response.json();
        return {
            success: true,
            results: data.context || '',
            sources: data.sources || [],
            count: data.sources?.length || 0,
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * Execute the "get_diagnostics" tool — fetch analysis from ai-engine.
 */
async function toolGetDiagnostics({ workspacePath, filePath, fileContent, signal }) {
    try {
        const response = await fetch(`${CODE_INTEL_BASE}/analyze/static`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal: AbortSignal.timeout(5000),
            body: JSON.stringify({
                code: fileContent || '',
                language: detectLanguage(filePath),
                filename: filePath,
            }),
        });
        if (!response.ok) {
            return { success: false, error: `Analysis failed (${response.status})` };
        }
        const data = await response.json();
        return {
            success: true,
            diagnostics: data.diagnostics || data.issues || [],
            summary: data.summary || '',
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

function detectLanguage(filePath = '') {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const map = {
        js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
        py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
        css: 'css', scss: 'scss', html: 'html', json: 'json', md: 'markdown',
    };
    return map[ext] || 'plaintext';
}

// ── Agent Execution ─────────────────────────────────────────────────

/**
 * Execute a single agent step by running its tools and optionally
 * calling the LLM for synthesis.
 */
async function executeAgent({ agentType, instruction, context, tools, workspacePath, activeFilePath, activeFileContent, signal }) {
    const toolResults = [];
    let output = '';

    // Execute tools based on agent type
    switch (agentType) {
        case 'reader': {
            // Extract file paths from instruction
            const pathMatches = instruction.match(/\b([\w/.-]+\.\w{1,6})\b/g) || [];
            for (const path of pathMatches.slice(0, 5)) {
                const result = await toolReadFile({ workspacePath, filePath: path, signal });
                toolResults.push({ tool: 'read_file', args: { path }, ...result });
                if (result.success) {
                    output += `\nFILE: ${path}\n\`\`\`\n${result.content}\n\`\`\`\n`;
                }
            }
            if (!toolResults.some((r) => r.success)) {
                // Try listing directory instead
                const dirResult = await toolListDirectory({ workspacePath, signal });
                toolResults.push({ tool: 'list_directory', ...dirResult });
                output = `Available files:\n${dirResult.files.join('\n')}`;
            }
            break;
        }

        case 'searcher': {
            const searchResult = await toolGrepSearch({ workspacePath, query: instruction, signal });
            toolResults.push({ tool: 'grep_search', args: { query: instruction }, ...searchResult });

            if (searchResult.success && searchResult.results) {
                output = searchResult.results;
                // Also read the top source files
                const topSources = (searchResult.sources || []).slice(0, 3);
                for (const source of topSources) {
                    if (source.file) {
                        const fileResult = await toolReadFile({
                            workspacePath,
                            filePath: source.file,
                            signal,
                        });
                        if (fileResult.success) {
                            output += `\n\nFILE: ${source.file}\n\`\`\`\n${fileResult.content}\n\`\`\``;
                            toolResults.push({ tool: 'read_file', args: { path: source.file }, ...fileResult });
                        }
                    }
                }
            } else {
                output = 'No search results found.';
            }
            break;
        }

        case 'analyzer': {
            // Analyze the active file or a specified file
            const targetPath = activeFilePath;
            const targetContent = activeFileContent || '';

            if (targetContent) {
                const diagResult = await toolGetDiagnostics({
                    workspacePath,
                    filePath: targetPath,
                    fileContent: targetContent,
                    signal,
                });
                toolResults.push({ tool: 'get_diagnostics', args: { file: targetPath }, ...diagResult });

                if (diagResult.success) {
                    const diags = diagResult.diagnostics;
                    output = `Diagnostics for ${targetPath}:\n`;
                    if (Array.isArray(diags) && diags.length > 0) {
                        output += diags
                            .slice(0, 10)
                            .map((d) => `  Line ${d.line || '?'}: [${d.severity || 'info'}] ${d.message || d}`)
                            .join('\n');
                    } else {
                        output += 'No diagnostics found.';
                    }
                    if (diagResult.summary) {
                        output += `\n\nSummary: ${diagResult.summary}`;
                    }
                }
            } else {
                output = 'No file content available for analysis.';
            }
            break;
        }

        case 'planner': {
            // List workspace structure for planning
            const dirResult = await toolListDirectory({ workspacePath, signal });
            toolResults.push({ tool: 'list_directory', ...dirResult });

            // Use LLM to create a plan
            output = `Workspace structure (${dirResult.count} files):\n${dirResult.files.slice(0, 30).join('\n')}`;
            output += `\n\nPlanning instruction: ${instruction}`;
            if (context) {
                output += `\n\nPrior context:\n${context.slice(0, 3000)}`;
            }
            break;
        }

        case 'executor': {
            // The executor gathers all context and passes it through
            output = `Execution context:\n`;
            if (activeFilePath && activeFileContent) {
                output += `Active file: ${activeFilePath}\n`;
            }
            if (context) {
                output += `\nGathered context:\n${context.slice(0, 6000)}`;
            }
            output += `\n\nInstruction: ${instruction}`;
            break;
        }

        default:
            output = `Unknown agent type: ${agentType}`;
    }

    return {
        output,
        toolCalls: toolResults,
        tokensUsed: Math.ceil(output.length / 4),
    };
}

// ── Route Handler ───────────────────────────────────────────────────

export async function POST(request) {
    let body;
    try {
        body = await request.json();
    } catch (e) {
        return NextResponse.json({ error: 'Bad request' }, { status: 400 });
    }

    const {
        agentType = '',
        instruction = '',
        context = '',
        tools = [],
        workspacePath = '',
        activeFilePath = '',
        activeFileContent = '',
    } = body || {};

    if (!agentType || !instruction) {
        return NextResponse.json(
            { error: 'Missing agentType or instruction' },
            { status: 400 }
        );
    }

    try {
        const result = await executeAgent({
            agentType,
            instruction,
            context,
            tools,
            workspacePath,
            activeFilePath,
            activeFileContent,
            signal: request.signal,
        });

        return NextResponse.json(result);
    } catch (e) {
        console.error(`[Agent API] Error executing ${agentType}:`, e.message);
        return NextResponse.json(
            { error: e.message || 'Agent execution failed' },
            { status: 500 }
        );
    }
}
