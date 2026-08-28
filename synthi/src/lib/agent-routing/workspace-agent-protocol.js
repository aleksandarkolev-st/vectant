// This is an immutable server-owned baseline. Passive workspace instruction
// projections provide matching context to terminal-launched coding agents, but
// workspace text is never trusted to weaken routing, authorization, or
// independent validation requirements.

export const ATOMIC_AGENT_PROTOCOL = [
    'For every non-trivial workspace task or change:',
    '1. Decompose larger requests into the smallest independently solvable atomic changes.',
    '2. For each atomic change, use the cheapest capable routing sub-agent.',
    '3. The routing sub-agent must not solve the task. It inspects only skill and tool metadata, then returns the execution role, minimum relevant skills, whether independent validation is required, and a very short reason.',
    '4. Only after routing, use the smallest appropriate execution sub-agent.',
    '5. Give that execution agent only the atomic task, minimal relevant repository context, selected skills, and the tools associated with those skills.',
    '6. Do not expose the full tool catalog or all skill contents to routing or execution agents.',
    '7. When routing requires validation, run the smallest appropriate independent validation agent after execution.',
    'Use synthi_route_atomic_task before non-trivial Vectant MCP work.',
].join('\n');
