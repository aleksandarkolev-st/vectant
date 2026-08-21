import { isFastPath, taskMetadata, toolMetadata } from './task-planning.js';

function cheapestValidator(agents) {
  return agents
    .filter((agent) => agent.role === 'validation')
    .sort((left, right) => (left.cost ?? Number.POSITIVE_INFINITY) - (right.cost ?? Number.POSITIVE_INFINITY)
      || String(left.id || '').localeCompare(String(right.id || '')))[0]
    || { id: 'independent-validator', role: 'validation', model: 'local', cost: 0 };
}

function message(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function isSuccessful(status) {
  return status === 'completed' || status === 'recovered';
}

function compactRoute(routing) {
  return {
    role: routing.role,
    skills: [...routing.skills],
    validation: routing.validation,
    reason: routing.reason,
    suggested_tools: [...routing.suggested_tools],
  };
}

function instructionList(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.instructions) ? value.instructions : [];
}

async function executeTask({ task, routing, fastPath, executors, loadSkills, emit }) {
  const executor = fastPath
    ? executors.fastPath || executors[routing.agent.id] || executors[routing.role] || executors.default
    : executors[routing.agent.id] || executors[routing.role] || executors.default;
  if (!executor) throw new Error(`No executor for ${routing.role}`);

  const loaded = await loadSkills(routing.selected.map((skill) => skill.id), {
    task: taskMetadata(task),
    route: compactRoute(routing),
  });
  const skillInstructions = instructionList(loaded);
  emit('execution_started', {
    task: taskMetadata(task),
    executionAgent: { id: routing.agent.id, role: routing.role, model: routing.agent.model || null },
    skills: routing.selected.map((skill) => skill.id),
    tools: routing.exposed.map((tool) => tool.id),
    loadedSkillIds: skillInstructions.map((skill) => skill.id).filter(Boolean),
    fastPath,
  });
  const output = await executor({
    task: taskMetadata(task),
    skills: routing.selected.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      categories: [...(skill.categories || [])],
      keywords: [...(skill.keywords || [])],
      toolGroups: [...(skill.toolGroups || [])],
    })),
    skillInstructions,
    tools: routing.exposed.map(toolMetadata),
    route: compactRoute(routing),
  });
  emit('executed', { task: taskMetadata(task), executionAgent: routing.agent.id, fastPath, recovered: false });
  return output;
}

async function validateTask({ task, routing, output, validators, validatorAgents, emit }) {
  if (routing.validation === 'none') return null;
  const validatorAgent = cheapestValidator(validatorAgents);
  const validator = validators[validatorAgent.id]
    || validators[routing.validation]
    || validators.default;
  if (!validator) {
    const validation = { ok: false, reason: 'Independent validator unavailable.' };
    emit('validation_failed', { task: taskMetadata(task), validator: validatorAgent.id, validation });
    return validation;
  }

  emit('validation_started', {
    task: taskMetadata(task),
    validator: { id: validatorAgent.id, model: validatorAgent.model || null },
  });
  try {
    const validation = await validator({ task: taskMetadata(task), output, route: compactRoute(routing) });
    emit('validated', { task: taskMetadata(task), validator: validatorAgent.id, validation });
    return validation;
  } catch (error) {
    const validation = { ok: false, error: message(error) };
    emit('validation_failed', { task: taskMetadata(task), validator: validatorAgent.id, validation });
    return validation;
  }
}

/** Executes already-decomposed tasks, preserving dependency and failure state. */
export async function runAtomicTasks({
  request,
  planner,
  executors = {},
  validators = {},
  validatorAgents = [],
  recoveries = {},
  loadSkills = async () => [],
} = {}) {
  const tasks = planner.order(planner.decompose(request));
  const results = new Map();

  for (const task of tasks) {
    const blockedBy = task.dependencies.filter((id) => !isSuccessful(results.get(id)?.status));
    if (blockedBy.length > 0) {
      const result = { task, status: 'blocked', blockedBy };
      results.set(task.id, result);
      planner.emit('dependency_blocked', { task: taskMetadata(task), blockedBy });
      continue;
    }

    const fastPath = isFastPath(task);
    const routing = fastPath ? planner.fastRoute(task) : await planner.routeWithRouter(task);
    if (fastPath) planner.emit('fast_path', { task: taskMetadata(task) });

    let output;
    let recovered = false;
    try {
      output = await executeTask({ task, routing, fastPath, executors, loadSkills, emit: planner.emit });
    } catch (error) {
      const initialError = message(error);
      planner.emit('execution_failed', { task: taskMetadata(task), error: initialError, executionAgent: routing.agent.id });
      const recovery = recoveries[routing.agent.id] || recoveries[routing.role] || recoveries.default;
      if (!recovery) {
        results.set(task.id, { task, status: 'failed', route: routing, error: initialError });
        continue;
      }
      planner.emit('recovery_started', { task: taskMetadata(task), error: initialError, executionAgent: routing.agent.id });
      try {
        output = await recovery({
          task: taskMetadata(task),
          route: compactRoute(routing),
          error: initialError,
          tools: routing.exposed.map(toolMetadata),
        });
        recovered = true;
        planner.emit('recovered', { task: taskMetadata(task), executionAgent: routing.agent.id });
      } catch (recoveryError) {
        const result = { task, status: 'failed', route: routing, error: initialError, recoveryError: message(recoveryError) };
        results.set(task.id, result);
        planner.emit('recovery_failed', { task: taskMetadata(task), error: result.recoveryError, executionAgent: routing.agent.id });
        continue;
      }
    }

    const validation = await validateTask({ task, routing, output, validators, validatorAgents, emit: planner.emit });
    results.set(task.id, {
      task,
      status: validation?.ok === false ? 'invalid' : recovered ? 'recovered' : 'completed',
      route: routing,
      output,
      validation,
      fastPath,
    });
  }

  return tasks.map((task) => results.get(task.id));
}
