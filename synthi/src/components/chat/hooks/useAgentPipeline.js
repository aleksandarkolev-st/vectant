/**
 * useAgentPipeline — Multi-agent orchestration for AI chat.
 *
 * Implements an agent loop where a coordinator agent can spawn sub-agents
 * to perform specialized tasks (read files, search codebase, analyze errors,
 * run commands, plan changes) before synthesizing a final response.
 *
 * Architecture:
 * ┌────────────────────────────────────────────────────────┐
 * │  User Prompt                                           │
 * │     ↓                                                  │
 * │  Coordinator Agent  ←──── Context Window               │
 * │     ↓ (decides sub-agents)                             │
 * │  ┌──────────┬──────────┬──────────┬──────────┐         │
 * │  │ Reader   │ Searcher │ Analyzer │ Planner  │         │
 * │  │ Agent    │ Agent    │ Agent    │ Agent    │         │
 * │  └────┬─────┴────┬─────┴────┬─────┴────┬─────┘         │
 * │       ↓          ↓          ↓          ↓               │
 * │  Sub-Agent Results → merged back into Context Window   │
 * │     ↓                                                  │
 * │  Synthesizer Agent (final response)                    │
 * └────────────────────────────────────────────────────────┘
 *
 * Modes:
 * - "direct"   — No agents, pass-through to LLM (current behavior)
 * - "auto"     — Coordinator decides which sub-agents to invoke
 * - "plan"     — Plan-then-execute with user approval
 * - "research" — Multi-step research with file reads and searches
 */

import { useCallback, useRef, useState } from 'react';

// ── Agent Definitions ───────────────────────────────────────────────

/**
 * Available sub-agent types and their capabilities.
 * Each agent has a name, description, and the tools it can use.
 */
export const AGENT_REGISTRY = {
    reader: {
        name: 'File Reader',
        description: 'Reads file contents from the workspace to gather context',
        icon: '📄',
        tools: ['read_file', 'list_directory'],
        maxSteps: 5,
    },
    searcher: {
        name: 'Code Searcher',
        description: 'Searches across the codebase for relevant symbols, patterns, and references',
        icon: '🔍',
        tools: ['grep_search', 'find_references', 'find_definition'],
        maxSteps: 4,
    },
    analyzer: {
        name: 'Error Analyzer',
        description: 'Analyzes errors, diagnostics, and runtime issues',
        icon: '🐛',
        tools: ['get_diagnostics', 'analyze_error', 'check_types'],
        maxSteps: 3,
    },
    planner: {
        name: 'Change Planner',
        description: 'Plans multi-file changes and determines the order of modifications',
        icon: '📋',
        tools: ['plan_changes', 'dependency_analysis'],
        maxSteps: 2,
    },
    executor: {
        name: 'Code Writer',
        description: 'Generates and applies code changes based on the plan',
        icon: '✏️',
        tools: ['write_code', 'apply_diff'],
        maxSteps: 6,
    },
};

/**
 * Agent pipeline modes.
 */
export const PIPELINE_MODES = {
    DIRECT: 'direct',
    AUTO: 'auto',
    PLAN: 'plan',
    RESEARCH: 'research',
};

// ── Agent Step Status ───────────────────────────────────────────────

const STEP_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    SKIPPED: 'skipped',
};

// ── Pipeline State ──────────────────────────────────────────────────

const createPipelineRun = (id, mode, prompt) => ({
    id,
    mode,
    prompt,
    status: 'planning', // planning | executing | synthesizing | completed | failed | cancelled
    steps: [],
    results: [],
    plan: null,
    startedAt: Date.now(),
    completedAt: null,
    error: null,
});

const createAgentStep = (agentType, instruction, index) => ({
    id: `step-${Date.now()}-${index}`,
    agentType,
    agentName: AGENT_REGISTRY[agentType]?.name || agentType,
    instruction,
    status: STEP_STATUS.PENDING,
    output: null,
    toolCalls: [],
    startedAt: null,
    completedAt: null,
    tokens: 0,
    error: null,
});

// ── Hook ────────────────────────────────────────────────────────────

export const useAgentPipeline = ({
    workspaceSlug,
    activeFile,
    currentCode,
    getBaseContentForPath,
    flattenWorkspaceFiles,
    resolveWorkspacePath,
    onProgress,
}) => {
    const [activePipeline, setActivePipeline] = useState(null);
    const [pipelineHistory, setPipelineHistory] = useState([]);
    const [currentMode, setCurrentMode] = useState(PIPELINE_MODES.DIRECT);
    const abortRef = useRef(null);

    /**
     * Determine which sub-agents to invoke based on the user prompt and context.
     * This is the "coordinator" logic.
     */
    const planAgentPipeline = useCallback(
        async (prompt, context = {}) => {
            const plan = {
                steps: [],
                reasoning: '',
            };

            const promptLower = (prompt || '').toLowerCase();
            const hasFileRef = /\b[\w/.-]+\.\w{1,6}\b/.test(prompt);
            const mentionsSearch =
                /\b(find|search|where|grep|look for|usage|references?|definition)\b/i.test(prompt);
            const mentionsError =
                /\b(error|bug|fix|crash|exception|warning|issue|broken|failing|fail)\b/i.test(prompt);
            const mentionsMultiFile =
                /\b(all files|multiple files|refactor|rename|across|project-wide|codebase)\b/i.test(prompt);
            const mentionsExplain =
                /\b(explain|how does|what does|why|understand|describe|walk through)\b/i.test(prompt);
            const mentionsCreate =
                /\b(create|generate|scaffold|boilerplate|new file|add a|implement|build)\b/i.test(prompt);

            // ── Build the plan ──────────────────────────────────────
            // Phase 1: Research (gather context)
            if (mentionsSearch || mentionsExplain || mentionsMultiFile) {
                plan.steps.push(
                    createAgentStep('searcher', `Search the codebase for: ${prompt}`, plan.steps.length)
                );
                plan.reasoning += 'Query involves searching or understanding code; dispatching searcher. ';
            }

            if (hasFileRef && !context.referencedFilesLoaded) {
                plan.steps.push(
                    createAgentStep('reader', `Read referenced files from: ${prompt}`, plan.steps.length)
                );
                plan.reasoning += 'File references detected; dispatching reader. ';
            }

            if (mentionsError) {
                plan.steps.push(
                    createAgentStep('analyzer', `Analyze errors related to: ${prompt}`, plan.steps.length)
                );
                plan.reasoning += 'Error/bug mentioned; dispatching analyzer. ';
            }

            // Phase 2: Planning (for multi-file changes)
            if (mentionsMultiFile || mentionsCreate) {
                plan.steps.push(
                    createAgentStep('planner', `Plan changes for: ${prompt}`, plan.steps.length)
                );
                plan.reasoning += 'Multi-file or creation task; dispatching planner. ';
            }

            // Phase 3: Execution
            if (
                !mentionsExplain &&
                (mentionsCreate || mentionsMultiFile || mentionsError)
            ) {
                plan.steps.push(
                    createAgentStep(
                        'executor',
                        `Generate code changes for: ${prompt}`,
                        plan.steps.length
                    )
                );
                plan.reasoning += 'Code changes needed; dispatching executor. ';
            }

            // If no agents were planned, fall back to direct mode
            if (plan.steps.length === 0) {
                plan.reasoning = 'Simple query; using direct mode (no sub-agents needed).';
            }

            return plan;
        },
        []
    );

    /**
     * Execute a single agent step.
     * Each agent calls the backend with its specific tools.
     */
    const executeAgentStep = useCallback(
        async (step, accumulatedContext, signal) => {
            const startTime = Date.now();

            try {
                // Call the agent API endpoint
                const response = await fetch('/api/agent', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    signal,
                    body: JSON.stringify({
                        agentType: step.agentType,
                        instruction: step.instruction,
                        context: accumulatedContext,
                        tools: AGENT_REGISTRY[step.agentType]?.tools || [],
                        workspacePath: workspaceSlug || null,
                        activeFilePath: activeFile?.path || null,
                        activeFileContent: step.agentType === 'reader' ? null : currentCode,
                    }),
                });

                if (!response.ok) {
                    throw new Error(`Agent ${step.agentName} failed (${response.status})`);
                }

                const result = await response.json();

                return {
                    ...step,
                    status: STEP_STATUS.COMPLETED,
                    output: result.output || '',
                    toolCalls: result.toolCalls || [],
                    tokens: result.tokensUsed || 0,
                    startedAt: startTime,
                    completedAt: Date.now(),
                };
            } catch (error) {
                if (error.name === 'AbortError') {
                    return { ...step, status: STEP_STATUS.SKIPPED, error: 'Cancelled' };
                }
                return {
                    ...step,
                    status: STEP_STATUS.FAILED,
                    error: error.message || 'Unknown error',
                    startedAt: startTime,
                    completedAt: Date.now(),
                };
            }
        },
        [workspaceSlug, activeFile?.path, currentCode]
    );

    /**
     * Execute a client-side agent step using local workspace data.
     * Used as a fast fallback when the backend agent API isn't available.
     */
    const executeLocalAgentStep = useCallback(
        async (step, accumulatedContext, signal) => {
            const startTime = Date.now();

            try {
                let output = '';
                const toolCalls = [];

                switch (step.agentType) {
                    case 'reader': {
                        // Extract file paths from the instruction
                        const pathMatches = step.instruction.match(
                            /\b([\w/.-]+\.\w{1,6})\b/g
                        ) || [];
                        const contents = [];
                        for (const rawPath of pathMatches.slice(0, 5)) {
                            const resolved = resolveWorkspacePath?.(rawPath);
                            if (resolved && getBaseContentForPath) {
                                const content = await getBaseContentForPath(resolved);
                                if (typeof content === 'string') {
                                    contents.push(
                                        `FILE: ${resolved}\n\`\`\`\n${content.slice(0, 4000)}\n\`\`\``
                                    );
                                    toolCalls.push({
                                        tool: 'read_file',
                                        args: { path: resolved },
                                        result: 'success',
                                    });
                                }
                            }
                        }
                        output = contents.length
                            ? contents.join('\n\n')
                            : 'No matching files found in workspace.';
                        break;
                    }

                    case 'searcher': {
                        // Search the flattened file list for matches
                        const searchTerms = step.instruction
                            .replace(/^.*?:\s*/, '')
                            .split(/\s+/)
                            .filter((t) => t.length > 2)
                            .slice(0, 5);
                        const matchingFiles = (flattenWorkspaceFiles || [])
                            .filter((path) =>
                                searchTerms.some(
                                    (term) =>
                                        path.toLowerCase().includes(term.toLowerCase())
                                )
                            )
                            .slice(0, 10);
                        toolCalls.push({
                            tool: 'grep_search',
                            args: { terms: searchTerms },
                            result: `${matchingFiles.length} files found`,
                        });

                        if (matchingFiles.length === 0) {
                            output = 'No matching files found.';
                        } else {
                            const fileContents = [];
                            for (const path of matchingFiles.slice(0, 3)) {
                                if (getBaseContentForPath) {
                                    const content = await getBaseContentForPath(path);
                                    if (typeof content === 'string') {
                                        fileContents.push(
                                            `FILE: ${path}\n\`\`\`\n${content.slice(0, 2000)}\n\`\`\``
                                        );
                                    }
                                }
                            }
                            output = `Found ${matchingFiles.length} relevant files:\n${matchingFiles.join('\n')}\n\n${fileContents.join('\n\n')}`;
                        }
                        break;
                    }

                    case 'analyzer': {
                        // Provide current file context for error analysis
                        output = currentCode
                            ? `Active file for analysis (${activeFile?.path || 'unknown'}):\n\`\`\`\n${currentCode.slice(0, 6000)}\n\`\`\``
                            : 'No active file content available for analysis.';
                        toolCalls.push({
                            tool: 'analyze_error',
                            args: { file: activeFile?.path },
                            result: 'context provided',
                        });
                        break;
                    }

                    case 'planner': {
                        // Provide workspace structure for planning
                        const relevantFiles = (flattenWorkspaceFiles || [])
                            .filter((p) => !p.includes('node_modules'))
                            .slice(0, 30);
                        output = `Workspace files for planning:\n${relevantFiles.join('\n')}`;
                        toolCalls.push({
                            tool: 'plan_changes',
                            args: {},
                            result: `${relevantFiles.length} files available`,
                        });
                        break;
                    }

                    case 'executor': {
                        // Pass through — the actual code generation happens in the synthesizer
                        output = accumulatedContext
                            ? `Prior context gathered:\n${accumulatedContext.slice(0, 4000)}`
                            : 'No prior context; will generate from scratch.';
                        break;
                    }

                    default:
                        output = `Unknown agent type: ${step.agentType}`;
                }

                return {
                    ...step,
                    status: STEP_STATUS.COMPLETED,
                    output,
                    toolCalls,
                    tokens: Math.ceil(output.length / 4),
                    startedAt: startTime,
                    completedAt: Date.now(),
                };
            } catch (error) {
                if (error.name === 'AbortError') {
                    return { ...step, status: STEP_STATUS.SKIPPED, error: 'Cancelled' };
                }
                return {
                    ...step,
                    status: STEP_STATUS.FAILED,
                    error: error.message || 'Unknown error',
                    startedAt: startTime,
                    completedAt: Date.now(),
                };
            }
        },
        [
            activeFile?.path,
            currentCode,
            flattenWorkspaceFiles,
            getBaseContentForPath,
            resolveWorkspacePath,
        ]
    );

    /**
     * Run the full agent pipeline for a prompt.
     *
     * @param {string} prompt - User's message
     * @param {Object} context - Additional context (messages, files, etc.)
     * @param {Object} options - Pipeline options
     * @returns {Object} - { results, plan, agentContext }
     */
    const runPipeline = useCallback(
        async (prompt, context = {}, options = {}) => {
            const {
                mode = currentMode,
                signal = null,
                onStepStart,
                onStepComplete,
                onPlanReady,
            } = options;

            // Direct mode — no agents, pass-through
            if (mode === PIPELINE_MODES.DIRECT) {
                return {
                    results: [],
                    plan: null,
                    agentContext: '',
                    mode: PIPELINE_MODES.DIRECT,
                };
            }

            const runId = `pipeline-${Date.now()}`;
            const run = createPipelineRun(runId, mode, prompt);

            const abortController = new AbortController();
            abortRef.current = abortController;

            // Merge external signal
            if (signal) {
                signal.addEventListener('abort', () => abortController.abort(), {
                    once: true,
                });
            }

            try {
                // Phase 1: Plan
                onProgress?.('Planning agent pipeline...');
                const plan = await planAgentPipeline(prompt, context);
                run.plan = plan;
                run.steps = plan.steps;
                run.status = 'executing';

                setActivePipeline({ ...run });
                onPlanReady?.(plan);
                onProgress?.(`Plan: ${plan.steps.length} agent steps — ${plan.reasoning}`);

                if (plan.steps.length === 0) {
                    run.status = 'completed';
                    run.completedAt = Date.now();
                    setActivePipeline({ ...run });
                    return {
                        results: [],
                        plan,
                        agentContext: '',
                        mode,
                    };
                }

                // Phase 2: Execute steps sequentially
                let accumulatedContext = '';
                const completedResults = [];

                for (let i = 0; i < plan.steps.length; i++) {
                    if (abortController.signal.aborted) break;

                    const step = plan.steps[i];
                    step.status = STEP_STATUS.RUNNING;
                    step.startedAt = Date.now();

                    run.steps = [...plan.steps];
                    setActivePipeline({ ...run });
                    onStepStart?.(step, i);
                    onProgress?.(
                        `[${i + 1}/${plan.steps.length}] ${AGENT_REGISTRY[step.agentType]?.icon || '⚙️'} ${step.agentName}: ${step.instruction.slice(0, 80)}`
                    );

                    // Try backend agent first, fall back to local
                    let result;
                    try {
                        result = await executeAgentStep(
                            step,
                            accumulatedContext,
                            abortController.signal
                        );
                    } catch (err) {
                        // Backend unavailable → use local agent
                        result = await executeLocalAgentStep(
                            step,
                            accumulatedContext,
                            abortController.signal
                        );
                    }

                    // Update the step in the plan
                    plan.steps[i] = result;
                    completedResults.push(result);

                    if (result.status === STEP_STATUS.COMPLETED && result.output) {
                        accumulatedContext += `\n\n--- ${result.agentName} Result ---\n${result.output}`;
                    }

                    run.steps = [...plan.steps];
                    run.results = [...completedResults];
                    setActivePipeline({ ...run });
                    onStepComplete?.(result, i);

                    if (result.status === STEP_STATUS.FAILED) {
                        onProgress?.(
                            `⚠️ ${result.agentName} failed: ${result.error}. Continuing...`
                        );
                    }
                }

                // Phase 3: Complete
                run.status = 'synthesizing';
                run.completedAt = Date.now();
                setActivePipeline({ ...run });
                onProgress?.('Agent pipeline complete. Synthesizing response...');

                setPipelineHistory((prev) => [...prev.slice(-9), { ...run }]);

                return {
                    results: completedResults,
                    plan,
                    agentContext: accumulatedContext,
                    mode,
                };
            } catch (error) {
                run.status = 'failed';
                run.error = error.message;
                run.completedAt = Date.now();
                setActivePipeline({ ...run });
                onProgress?.(`Pipeline failed: ${error.message}`);

                return {
                    results: run.results || [],
                    plan: run.plan,
                    agentContext: '',
                    mode,
                    error: error.message,
                };
            }
        },
        [
            currentMode,
            planAgentPipeline,
            executeAgentStep,
            executeLocalAgentStep,
            onProgress,
        ]
    );

    /**
     * Cancel the currently running pipeline.
     */
    const cancelPipeline = useCallback(() => {
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        setActivePipeline((prev) =>
            prev ? { ...prev, status: 'cancelled' } : null
        );
    }, []);

    /**
     * Determine if a prompt should use agent mode based on complexity heuristics.
     */
    const shouldUseAgents = useCallback((prompt = '') => {
        if (currentMode === PIPELINE_MODES.DIRECT) return false;
        if (currentMode !== PIPELINE_MODES.AUTO) return true;

        const promptLower = prompt.toLowerCase();
        const complexity =
            (promptLower.split(/\s+/).length > 20 ? 1 : 0) +
            (/\b(and|also|then|after that|additionally)\b/i.test(prompt) ? 1 : 0) +
            (/\b(all files|multiple|project|codebase|refactor|rename across)\b/i.test(prompt) ? 2 : 0) +
            (/\b(find|search|grep|where is|references|usage)\b/i.test(prompt) ? 1 : 0) +
            (/\b(error|bug|fix|debug|crash|failing)\b/i.test(prompt) ? 1 : 0) +
            (/\b(create|scaffold|generate|implement .+ and)\b/i.test(prompt) ? 1 : 0);

        return complexity >= 2;
    }, [currentMode]);

    return {
        // State
        activePipeline,
        pipelineHistory,
        currentMode,

        // Actions
        runPipeline,
        cancelPipeline,
        setCurrentMode,

        // Utilities
        shouldUseAgents,
        planAgentPipeline,

        // Constants
        AGENT_REGISTRY,
        PIPELINE_MODES,
    };
};
