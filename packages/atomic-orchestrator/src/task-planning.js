const DEFAULT_MAX_SKILLS = 3;

export function normalizedId(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeList(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map(normalizedId).filter(Boolean))];
}

export function taskMetadata(task) {
  return {
    id: task.id,
    description: task.description,
    category: task.category || null,
    risk: task.risk || null,
    dependencies: [...task.dependencies],
  };
}

export function skillMetadata(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    categories: [...(skill.categories || [])],
    keywords: [...(skill.keywords || [])],
    toolGroups: [...(skill.toolGroups || [])],
  };
}

export function toolMetadata(tool) {
  return {
    id: tool.id,
    group: tool.group || null,
    groups: [...(tool.groups || [])],
    keywords: [...(tool.keywords || [])],
  };
}

function normalizeTask(value, index) {
  const source = value && typeof value === 'object' ? value : { description: value };
  const description = String(source.description || '').trim();
  if (!description) throw new TypeError(`Atomic task ${index + 1} requires a description.`);

  return {
    ...source,
    id: normalizedId(source.id) || `task-${index + 1}`,
    description,
    category: normalizedId(source.category),
    dependencies: normalizeList(source.dependencies || source.dependsOn),
  };
}

function normalizeTasks(request) {
  const tasks = Array.isArray(request)
    ? request
    : Array.isArray(request?.atomicTasks)
      ? request.atomicTasks
      : [request];
  const normalized = tasks.map(normalizeTask);
  const ids = new Set();
  for (const task of normalized) {
    if (ids.has(task.id)) throw new TypeError(`Atomic task id ${task.id} is duplicated.`);
    ids.add(task.id);
  }
  return normalized;
}

function orderTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  const visit = (task) => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) throw new TypeError(`Atomic task dependencies contain a cycle at ${task.id}.`);
    visiting.add(task.id);
    for (const dependencyId of task.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) throw new TypeError(`Atomic task ${task.id} depends on unknown task ${dependencyId}.`);
      visit(dependency);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  };

  tasks.forEach(visit);
  return ordered;
}

function taskTerms(task) {
  return new Set(`${task.description} ${task.category || ''}`
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((term) => term.length > 2));
}

function scoreSkill(skill, task) {
  const terms = taskTerms(task);
  const categories = normalizeList(skill.categories);
  const keywords = normalizeList(skill.keywords || skill.capabilities);
  let score = categories.includes(task.category) && task.category ? 20 : 0;
  for (const term of terms) {
    if (normalizedId(skill.id) === term) score += 14;
    if (keywords.includes(term)) score += 10;
    if (categories.includes(term)) score += 6;
    if (String(skill.name || '').toLowerCase().includes(term)) score += 4;
    if (String(skill.description || '').toLowerCase().includes(term)) score += 1;
  }
  return score;
}

function selectSkills(skills, task, maxSkills) {
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, task) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || normalizedId(left.skill.id).localeCompare(normalizedId(right.skill.id)))
    .slice(0, maxSkills)
    .map(({ skill }) => skill);
}

function selectByIds(skills, ids) {
  const byId = new Map(skills.map((skill) => [normalizedId(skill.id), skill]));
  return normalizeList(ids).map((id) => byId.get(id)).filter(Boolean);
}

function canExecute(agent, selectedSkills, requestedRole) {
  if (requestedRole && agent.role !== requestedRole) return false;
  const capabilityIds = normalizeList(agent.skills || agent.capabilities);
  return selectedSkills.length === 0
    ? agent.fallback === true
    : selectedSkills.every((skill) => capabilityIds.includes(normalizedId(skill.id)));
}

function cheapest(agents, predicate) {
  return agents
    .filter(predicate)
    .sort((left, right) => (left.cost ?? Number.POSITIVE_INFINITY) - (right.cost ?? Number.POSITIVE_INFINITY)
      || normalizedId(left.id).localeCompare(normalizedId(right.id)))[0];
}

function validationFor(task, requested) {
  if (requested === 'none' || requested === 'not-required') return 'none';
  if (requested === 'independent' || requested === 'required') return 'independent';
  return task.risk === 'high' || task.risk === 'critical' || task.category === 'security'
    ? 'independent'
    : 'none';
}

export function isFastPath(task) {
  return task.fastPath === true || /^(rename|format|typo|mechanical)\b/i.test(task.description);
}

/**
 * Plans a task with skill/tool metadata only. The host can replace the
 * deterministic decision with a cheap routing worker through `routers`.
 */
export function createTaskPlanner({
  skills = [],
  agents = [],
  tools = [],
  routingAgents = [],
  routers = {},
  trace = () => {},
  maxSkills = DEFAULT_MAX_SKILLS,
} = {}) {
  const boundedMaxSkills = Number.isFinite(maxSkills)
    ? Math.max(1, Math.floor(maxSkills))
    : DEFAULT_MAX_SKILLS;
  const skillCatalog = skills.map(skillMetadata);
  const toolCatalog = tools.map(toolMetadata);
  const emit = (event, data = {}) => trace({ event, ...data });

  const makeRoute = (task, decision = {}) => {
    const requestedSkills = normalizeList(decision.skills || decision.skillIds);
    const selected = requestedSkills.length > 0
      ? selectByIds(skills, requestedSkills).slice(0, boundedMaxSkills)
      : selectSkills(skills, task, boundedMaxSkills);
    const requestedRole = normalizedId(decision.role);
    const capable = agents.filter((agent) => canExecute(agent, selected, requestedRole));
    const agent = cheapest(capable, () => true)
      || cheapest(agents, (candidate) => candidate.fallback === true)
      || { id: 'implementation', role: 'implementation', model: 'default', cost: 0, fallback: true };
    const exposed = tools.filter((tool) => selected.some((skill) => (
      normalizeList(skill.toolGroups).includes(normalizedId(tool.group))
      || normalizeList(skill.tools).includes(normalizedId(tool.id))
    )));
    const validation = validationFor(task, decision.validation || task.validation);
    const fallback = selected.length === 0;
    return {
      role: agent.role || agent.id,
      skills: selected.map((skill) => skill.id),
      validation,
      reason: String(decision.reason || (fallback
        ? 'No skill matched; using the cheapest fallback execution role.'
        : `Matched ${selected.length} relevant skill${selected.length === 1 ? '' : 's'}.`)).slice(0, 240),
      suggested_tools: [...new Set(exposed.map((tool) => tool.group || tool.id))],
      agent,
      selected,
      exposed,
    };
  };

  const emitRoute = (task, result, router) => {
    emit('routed', {
      task: taskMetadata(task),
      router,
      route: { role: result.role, skills: result.skills, validation: result.validation, reason: result.reason },
      executionAgent: { id: result.agent.id, role: result.role, model: result.agent.model || null },
      tools: result.exposed.map((tool) => tool.id),
    });
  };

  const route = (rawTask) => {
    const task = normalizeTask(rawTask, 0);
    const result = makeRoute(task);
    emitRoute(task, result, 'deterministic-metadata-router');
    return result;
  };

  const selectRoutingAgent = () => cheapest(routingAgents, (agent) => (
    normalizeList(agent.capabilities || agent.skills).includes('routing') || agent.role === 'routing'
  )) || { id: 'deterministic-metadata-router', role: 'routing', model: 'local', cost: 0 };

  const routeWithRouter = async (task) => {
    const routerAgent = selectRoutingAgent();
    const router = routers[routerAgent.id] || routers[routerAgent.role] || routers.default;
    const routerIdentity = { id: routerAgent.id, role: routerAgent.role, model: routerAgent.model || null };
    emit('routing_started', {
      task: taskMetadata(task),
      router: routerIdentity,
      catalog: { skills: skillCatalog.length, tools: toolCatalog.length },
    });
    const decision = router
      ? await router({
        task: taskMetadata(task),
        skills: skillCatalog.map((skill) => ({ ...skill })),
        tools: toolCatalog.map((tool) => ({ ...tool })),
      }) || {}
      : {};
    const result = { ...makeRoute(task, decision), routerAgent };
    emitRoute(task, result, routerIdentity);
    return result;
  };

  return {
    decompose: normalizeTasks,
    order: orderTasks,
    route,
    routeWithRouter,
    fastRoute: (task) => makeRoute({ ...task, risk: 'low' }, {
      skills: [],
      validation: 'none',
      reason: 'Trivial mechanical operation.',
    }),
    emit,
  };
}
