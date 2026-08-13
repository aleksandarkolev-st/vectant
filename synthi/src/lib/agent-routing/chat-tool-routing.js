import { createOrchestrator } from '../../../../packages/atomic-orchestrator/src/index.js';

// This catalog deliberately contains only identifiers and routing metadata.
// Gemini declaration schemas stay in app/api/chat/toolDefinitions.js and are
// attached only after this router selects the narrow execution subset.
export const CHAT_TOOL_METADATA = Object.freeze([
    Object.freeze({ id: 'read_file', group: 'workspace-read' }),
    Object.freeze({ id: 'list_directory', group: 'workspace-read' }),
    Object.freeze({ id: 'search_workspace', group: 'workspace-search' }),
    Object.freeze({ id: 'create_file', group: 'workspace-write' }),
    Object.freeze({ id: 'create_directory', group: 'workspace-write' }),
    Object.freeze({ id: 'run_command', group: 'terminal' }),
    Object.freeze({ id: 'web_search', group: 'web-research' }),
    Object.freeze({ id: 'execute_notebook_cells', group: 'notebook' }),
]);

const CHAT_SKILL_METADATA = Object.freeze([
    Object.freeze({
        id: 'workspace-inspection',
        keywords: ['codebase', 'directory', 'explain', 'file', 'find', 'inspect', 'list', 'read', 'search', 'understand', 'where'],
        toolGroups: ['workspace-read', 'workspace-search'],
    }),
    Object.freeze({
        id: 'workspace-change',
        keywords: ['add', 'build', 'create', 'generate', 'make', 'new', 'scaffold'],
        toolGroups: ['workspace-write'],
    }),
    Object.freeze({
        id: 'workspace-modification',
        keywords: ['change', 'edit', 'fix', 'implement', 'modify', 'refactor', 'remove', 'rename', 'update', 'write'],
        toolGroups: ['workspace-read', 'workspace-write'],
    }),
    Object.freeze({
        id: 'terminal-validation',
        keywords: ['build', 'check', 'command', 'debug', 'error', 'lint', 'run', 'test', 'validate', 'verify'],
        toolGroups: ['terminal'],
    }),
    Object.freeze({
        id: 'web-research',
        keywords: ['current', 'documentation', 'latest', 'online', 'search', 'url', 'web'],
        toolGroups: ['web-research'],
    }),
    Object.freeze({
        id: 'notebook-execution',
        keywords: ['cell', 'jupyter', 'kernel', 'notebook'],
        toolGroups: ['notebook'],
    }),
]);

const CHAT_AGENT_POLICIES = Object.freeze([
    Object.freeze({ id: 'research', role: 'research', cost: 1, skills: ['workspace-inspection', 'web-research'], fallback: true }),
    Object.freeze({ id: 'debugging', role: 'debugging', cost: 2, skills: ['workspace-inspection', 'terminal-validation'] }),
    Object.freeze({ id: 'implementation', role: 'implementation', cost: 3, skills: CHAT_SKILL_METADATA.map((skill) => skill.id) }),
]);

const MAX_ROUTED_CHAT_TOOLS = 6;

/**
 * Produce an execution-only tool selection for a chat request. The input is
 * task text, never repository contents, tool schemas, or skill bodies.
 */
export function routeChatAgentTask({ taskDescription = '' } = {}) {
    const traceEvents = [];
    const orchestrator = createOrchestrator({
        skills: CHAT_SKILL_METADATA,
        agents: CHAT_AGENT_POLICIES,
        tools: CHAT_TOOL_METADATA,
        trace: (event) => traceEvents.push(event),
    });
    const task = {
        id: 'chat-execution',
        description: String(taskDescription || ''),
    };
    const routed = orchestrator.route(task);
    const selectedToolIds = [...new Set(routed.exposed.map((tool) => tool.id))]
        .slice(0, MAX_ROUTED_CHAT_TOOLS);
    const mutatesWorkspace = selectedToolIds.some((toolId) => (
        toolId === 'create_file' || toolId === 'create_directory'
    ));

    return {
        role: routed.role,
        selectedSkillIds: routed.selected.map((skill) => skill.id),
        selectedToolIds,
        validation: mutatesWorkspace ? 'independent' : routed.validation,
        reason: routed.reason,
        trace: {
            role: routed.role,
            skillIds: routed.selected.map((skill) => skill.id),
            toolIds: selectedToolIds,
            events: traceEvents,
        },
    };
}

function usefulTokens(value) {
    return String(value || '').toLowerCase().match(/[a-z0-9_-]{3,}/g) || [];
}

/**
 * Dynamic external tools never enter the generic router with their schemas.
 * They are exposed only when the task explicitly names the tool or a
 * meaningful token from its metadata description.
 */
export function selectExplicitExternalToolNames(taskDescription, externalMetadata = []) {
    const taskText = String(taskDescription || '').toLowerCase();
    if (!taskText) return [];

    return externalMetadata
        .filter((tool) => {
            const name = String(tool?.name || '').toLowerCase();
            if (name && taskText.includes(name)) return true;
            const description = String(tool?.description || '');
            const connectionNames = [...description.matchAll(/\[([^\]]+)\]/g)]
                .flatMap((match) => usefulTokens(match[1]));
            if (connectionNames.some((token) => taskText.includes(token))) return true;

            // A generic verb such as "create" must not expose every external
            // connector. Without an explicit connector name, require two
            // distinct descriptive terms to match.
            const tokens = usefulTokens(`${tool?.name || ''} ${description}`)
                .filter((token) => !['create', 'external', 'from', 'mcp', 'open', 'that', 'tool', 'with']);
            return new Set(tokens.filter((token) => taskText.includes(token))).size >= 2;
        })
        .map((tool) => String(tool.name || ''))
        .filter(Boolean)
        .slice(0, 2);
}
