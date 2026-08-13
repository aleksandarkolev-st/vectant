import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/auth';
import { withInternalAiAuth } from '@/lib/internalAiAuth';
import { requireRuntimeWorkspaceAccess } from '@/lib/workspaceAccess';
import {
    isSupportedAgentType,
    narrowAuthoritativeIds,
} from '@/lib/agent-routing/agent-execution-policy';
import { loadSelectedSkillInstructions } from '@/lib/agent-routing/selective-skill-loader';
import { routePipelineAgentTask } from '@/lib/agent-routing/agent-pipeline-routing';
import { validateIndependentAgentResult } from '@/lib/agent-routing/independent-agent-validator';

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

const DEFAULT_GEMINI_MODEL = process.env.SYNTHI_AI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

async function requireAgentSession() {
    try {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id || session?.user?.email || null;
        if (!userId) {
            return { ok: false, status: 401, error: 'Authentication required' };
        }
        return { ok: true, session, userId };
    } catch (error) {
        console.error('[Agent API] Session check failed:', error?.message || error);
        return { ok: false, status: 401, error: 'Authentication required' };
    }
}

async function authorizeAgentWorkspace(workspacePath) {
    const slug = String(workspacePath || '').trim();
    if (!slug) {
        return { ok: true, workspacePath: '' };
    }

    const access = await requireRuntimeWorkspaceAccess(slug);
    if (!access.ok) {
        return { ok: false, status: access.status || 403, error: access.error || 'Workspace access denied' };
    }

    return {
        ok: true,
        workspacePath: access.workspace?.slug || slug,
    };
}

function requestedIds(values) {
    const list = Array.isArray(values) ? values : [];
    return list.map((value) => typeof value === 'string' ? value : value?.id);
}

function narrowAuthoritativeSkills(authoritativeSkills, selectedSkills, { requestProvided = false } = {}) {
    const selection = narrowAuthoritativeIds(
        authoritativeSkills.map((skill) => skill.id),
        requestedIds(selectedSkills),
        { requestProvided },
    );
    const selectedIds = new Set(selection.selectedIds);
    return {
        ...selection,
        selectedSkills: authoritativeSkills.filter((skill) => selectedIds.has(skill.id)),
    };
}

function compactValidationResult(value, { unavailable = false } = {}) {
    const rejectedToolIds = [...new Set((Array.isArray(value?.rejectedToolIds) ? value.rejectedToolIds : [])
        .map((id) => String(id || '').trim().toLowerCase())
        .filter(Boolean))]
        .slice(0, 16);
    const reason = String(value?.reason || (unavailable
        ? 'Independent validator unavailable.'
        : 'Independent validation rejected the result.'))
        .slice(0, 240);

    return {
        ok: value?.ok === true && !unavailable,
        status: unavailable ? 'unavailable' : (value?.status === 'validated' ? 'validated' : 'rejected'),
        validator: 'independent',
        reason,
        toolCallCount: Number.isFinite(value?.toolCallCount)
            ? Math.max(0, Math.floor(value.toolCallCount))
            : 0,
        rejectedToolIds,
    };
}

async function runIndependentValidation({ result, routing }) {
    try {
        const value = await validateIndependentAgentResult({ result, routing });
        return compactValidationResult(value);
    } catch (error) {
        console.error('[Agent API] Independent validator unavailable:', error?.message || error);
        return compactValidationResult({
            reason: 'Independent validator unavailable.',
            toolCallCount: Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0,
        }, { unavailable: true });
    }
}

function traceAgentRouting({ atomicTask, routerRole, skills, tools, validator, loadedSkillIds = [], validation }) {
    console.info('[Agent API] routed atomic task', {
        atomicTask: { ...atomicTask, description: atomicTask.description.slice(0, 500) },
        routerRole,
        skills: skills.map((skill) => skill.id),
        tools,
        validator,
        loadedSkillIds,
        validation,
    });
}

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
        const res = await fetch(url, { method: 'GET', headers: withInternalAiAuth(), signal });
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
        const res = await fetch(url, { method: 'GET', headers: withInternalAiAuth(), signal });
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
            headers: withInternalAiAuth({ 'content-type': 'application/json' }),
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
            headers: withInternalAiAuth({ 'content-type': 'application/json' }),
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
    const permittedTools = new Set(tools || []);
    const canUse = (toolId) => permittedTools.has(toolId);

    // Execute tools based on agent type
    switch (agentType) {
        case 'reader': {
            // Extract file paths from instruction
            const pathMatches = instruction.match(/\b([\w/.-]+\.\w{1,6})\b/g) || [];
            if (canUse('read_file')) {
                for (const path of pathMatches.slice(0, 5)) {
                    const result = await toolReadFile({ workspacePath, filePath: path, signal });
                    toolResults.push({ tool: 'read_file', args: { path }, ...result });
                    if (result.success) {
                        output += `\nFILE: ${path}\n\`\`\`\n${result.content}\n\`\`\`\n`;
                    }
                }
            }

            // If no files were found from regex, read the active file + list workspace
            if (!toolResults.some((r) => r.success)) {
                // Always include the active file if available
                if (canUse('read_file') && activeFilePath && activeFileContent) {
                    const truncContent = activeFileContent.length > 12000
                        ? activeFileContent.slice(0, 12000) + '\n... [truncated]'
                        : activeFileContent;
                    output += `\nFILE: ${activeFilePath} (active file)\n\`\`\`\n${truncContent}\n\`\`\`\n`;
                    toolResults.push({ tool: 'read_file', args: { path: activeFilePath }, success: true, size: activeFileContent.length });
                } else if (canUse('read_file') && activeFilePath) {
                    // Try fetching active file from collab server
                    const activeResult = await toolReadFile({ workspacePath, filePath: activeFilePath, signal });
                    toolResults.push({ tool: 'read_file', args: { path: activeFilePath }, ...activeResult });
                    if (activeResult.success) {
                        output += `\nFILE: ${activeFilePath} (active file)\n\`\`\`\n${activeResult.content}\n\`\`\`\n`;
                    }
                }

                // List workspace to find sibling/related files
                const dirResult = canUse('list_directory')
                    ? await toolListDirectory({ workspacePath, signal })
                    : { success: false, files: [], count: 0 };
                if (canUse('list_directory')) {
                    toolResults.push({ tool: 'list_directory', ...dirResult });
                }

                // Try to read sibling files in the same directory as active file
                if (canUse('read_file') && activeFilePath) {
                    const activeDir = activeFilePath.includes('/') ? activeFilePath.split('/').slice(0, -1).join('/') : '';
                    const siblings = dirResult.files
                        .filter((f) => {
                            if (!activeDir) return !f.includes('/');
                            return f.startsWith(activeDir + '/') && f !== activeFilePath;
                        })
                        .slice(0, 4);
                    for (const sibPath of siblings) {
                        const sibResult = await toolReadFile({ workspacePath, filePath: sibPath, signal });
                        if (sibResult.success) {
                            output += `\nFILE: ${sibPath}\n\`\`\`\n${sibResult.content}\n\`\`\`\n`;
                            toolResults.push({ tool: 'read_file', args: { path: sibPath }, ...sibResult });
                        }
                    }
                }

                if (!output.trim() && canUse('list_directory')) {
                    output = `Available files:\n${dirResult.files.join('\n')}`;
                } else if (!output.trim()) {
                    output = 'No permitted reader tools were selected.';
                }
            }
            break;
        }

        case 'searcher': {
            if (!canUse('grep_search')) {
                output = 'The requested search tool is not permitted.';
                break;
            }
            const searchResult = await toolGrepSearch({ workspacePath, query: instruction, signal });
            toolResults.push({ tool: 'grep_search', args: { query: instruction }, ...searchResult });

            if (searchResult.success && searchResult.results) {
                output = searchResult.results;
                // Also read the top source files
                const topSources = (searchResult.sources || []).slice(0, 3);
                for (const source of topSources) {
                    if (canUse('read_file') && source.file) {
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
            if (!canUse('get_diagnostics')) {
                output = 'The requested diagnostics tool is not permitted.';
                break;
            }
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
            const dirResult = canUse('list_directory')
                ? await toolListDirectory({ workspacePath, signal })
                : { success: false, files: [], count: 0 };
            if (canUse('list_directory')) {
                toolResults.push({ tool: 'list_directory', ...dirResult });
                output = `Workspace structure (${dirResult.count} files):\n${dirResult.files.slice(0, 30).join('\n')}`;
            } else {
                output = 'Workspace listing is not permitted.';
            }

            // Include active file content so the planner can see actual code
            if (canUse('read_file') && activeFilePath && activeFileContent) {
                const planTrunc = activeFileContent.length > 8000
                    ? activeFileContent.slice(0, 8000) + '\n... [truncated]'
                    : activeFileContent;
                output += `\n\nActive file (${activeFilePath}):\n\`\`\`\n${planTrunc}\n\`\`\``;
                toolResults.push({ tool: 'read_file', args: { path: activeFilePath }, success: true });
            }

            output += `\n\nPlanning instruction: ${instruction}`;
            if (context) {
                output += `\n\nPrior context from other agents:\n${context.slice(0, 4000)}`;
            }
            break;
        }

        case 'executor': {
            // The executor gathers all prior agent context + active file for final synthesis
            output = `Execution context:\n`;
            if (activeFilePath && activeFileContent) {
                const execTrunc = activeFileContent.length > 8000
                    ? activeFileContent.slice(0, 8000) + '\n... [truncated]'
                    : activeFileContent;
                output += `\nActive file (${activeFilePath}):\n\`\`\`\n${execTrunc}\n\`\`\`\n`;
            }
            if (context) {
                output += `\nGathered context from prior agents:\n${context.slice(0, 8000)}`;
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
    const sessionAccess = await requireAgentSession();
    if (!sessionAccess.ok) {
        return NextResponse.json({ error: sessionAccess.error }, { status: sessionAccess.status });
    }

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
        tools,
        selectedTools,
        selectedSkills,
        atomicTask,
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

    if (!isSupportedAgentType(agentType)) {
        return NextResponse.json({ error: 'Unsupported agent type' }, { status: 400 });
    }

    // The browser may describe a previous routing pass, but server-side
    // routing is the only authority. Client selections can only narrow the
    // freshly routed IDs; omitted fields retain the routed result, never the
    // broad static per-agent policy.
    const authoritativeRoute = routePipelineAgentTask({
        id: atomicTask?.id,
        agentType,
        instruction,
    });
    const skillSelection = narrowAuthoritativeSkills(
        authoritativeRoute.selectedSkills,
        selectedSkills,
        { requestProvided: Array.isArray(selectedSkills) },
    );
    const requestedTools = Array.isArray(selectedTools) ? selectedTools : tools;
    const toolSelection = narrowAuthoritativeIds(
        authoritativeRoute.selectedToolIds,
        requestedTools,
        { requestProvided: Array.isArray(selectedTools) || Array.isArray(tools) },
    );
    const routing = {
        atomicTask: authoritativeRoute.atomicTask,
        routerRole: authoritativeRoute.routerRole,
        skills: skillSelection.selectedSkills,
        tools: toolSelection.selectedIds,
        validator: authoritativeRoute.validator,
        trace: {
            ...authoritativeRoute.trace,
            skills: skillSelection.selectedSkills.map((skill) => skill.id),
            tools: toolSelection.selectedIds,
            clientNarrowing: {
                rejectedSkillIds: skillSelection.rejectedIds,
                rejectedToolIds: toolSelection.rejectedIds,
            },
        },
    };
    try {
        const workspaceAccess = await authorizeAgentWorkspace(workspacePath);
        if (!workspaceAccess.ok) {
            return NextResponse.json({ error: workspaceAccess.error }, { status: workspaceAccess.status });
        }

        // Skill bodies remain server-only and are loaded only after the
        // metadata router selected known IDs. They are intentionally not sent
        // back to the browser or used as a replacement for tool policy.
        const loadedSkills = await loadSelectedSkillInstructions(
            routing.skills.map((skill) => skill.id),
        );

        const result = await executeAgent({
            agentType,
            instruction,
            context,
            tools: routing.tools,
            workspacePath: workspaceAccess.workspacePath,
            activeFilePath,
            activeFileContent,
            signal: request.signal,
        });

        const validation = routing.validator === 'independent'
            ? await runIndependentValidation({ result, routing })
            : null;
        routing.trace.validation = validation;
        traceAgentRouting({
            ...routing,
            loadedSkillIds: loadedSkills.instructions.map((skill) => skill.id),
            validation,
        });

        if (validation && !validation.ok) {
            const status = validation.status === 'unavailable' ? 503 : 422;
            return NextResponse.json({
                error: validation.reason,
                validation,
                routing,
            }, { status });
        }

        return NextResponse.json({ ...result, routing, validation });
    } catch (e) {
        console.error(`[Agent API] Error executing ${agentType}:`, e.message);
        return NextResponse.json(
            { error: e.message || 'Agent execution failed' },
            { status: 500 }
        );
    }
}
