import { createOrchestrator } from '../../../../packages/atomic-orchestrator/src/index.js';
import { repositorySkillRegistry } from './skill-metadata-registry.js';
import { agentRoleForType, selectServerAllowedTools } from './agent-execution-policy.js';

const MAX_SELECTED_SKILLS = 3;

// This is an identifier/group catalog, never a collection of tool schemas.
// The API route is still the authority that turns an identifier into a tool.
export const PIPELINE_TOOL_CATALOG = Object.freeze([
  Object.freeze({ id: 'read_file', group: 'filesystem' }),
  Object.freeze({ id: 'list_directory', group: 'filesystem' }),
  Object.freeze({ id: 'grep_search', group: 'filesystem' }),
  Object.freeze({ id: 'get_diagnostics', group: 'service-runtime' }),
]);

function categoryForAgentType(agentType) {
  return agentType === 'analyzer' ? 'debugging' : 'integration';
}

function validationForAgentType(agentType, routedValidation) {
  // Code-writing steps are the boundary at which the pipeline can return a
  // change to a caller.  They therefore always receive an independent
  // validation pass, regardless of browser-provided metadata.
  return agentType === 'executor' ? 'independent' : routedValidation;
}

function compactSkillMetadata(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    categories: [...skill.categories],
    keywords: [...skill.keywords],
    path: skill.path,
    toolGroups: [...skill.toolGroups],
  };
}

function selectCandidateSkills(registry, task) {
  // The generic core deliberately has a very small matcher.  Use the existing
  // metadata index to bound its input first, without ever loading SKILL.md.
  return registry.search(task.description, {
    limit: MAX_SELECTED_SKILLS,
  });
}

/**
 * Routes a legacy chat-agent step through the reusable atomic core.  The
 * adapter exists solely to bridge old UI names to reusable reasoning roles;
 * it does not reimplement the core's matching, fallback, or tool routing.
 */
export function routePipelineAgentTask({
  id,
  agentType,
  instruction,
  registry = repositorySkillRegistry,
  toolCatalog = PIPELINE_TOOL_CATALOG,
} = {}) {
  const role = agentRoleForType(agentType);
  if (!role) {
    throw new TypeError(`Unsupported chat agent type: ${agentType || '<unknown>'}`);
  }

  const atomicTask = {
    id: String(id || `agent-${Date.now()}`),
    description: String(instruction || ''),
    category: categoryForAgentType(agentType),
  };
  const candidateSkills = selectCandidateSkills(registry, atomicTask);
  const agent = {
    id: `${role}-pipeline-agent`,
    role,
    skills: candidateSkills.map((skill) => skill.id),
    cost: 1,
    fallback: true,
  };
  const traceEvents = [];
  const orchestrator = createOrchestrator({
    skills: candidateSkills,
    agents: [agent],
    tools: toolCatalog,
    trace: (event) => traceEvents.push(event),
  });
  const routed = orchestrator.route(atomicTask);
  const toolPolicy = selectServerAllowedTools(agentType, routed.exposed.map((tool) => tool.id), {
    requestProvided: true,
  });
  const selectedSkills = routed.selected.map(compactSkillMetadata);
  const selectedToolIds = toolPolicy.selectedToolIds;
  const validator = validationForAgentType(agentType, routed.validation);

  return {
    atomicTask,
    routerRole: routed.role,
    selectedSkills,
    selectedToolIds,
    validator,
    trace: {
      atomicTask,
      routerRole: routed.role,
      skills: selectedSkills.map((skill) => skill.id),
      tools: selectedToolIds,
      validator,
      events: traceEvents,
    },
  };
}
