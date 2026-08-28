import { runAtomicTasks } from './execution-lifecycle.js';
import { createTaskPlanner } from './task-planning.js';

/**
 * Provider-neutral lifecycle for atomic changes.
 *
 * The planner sees only metadata. Hosts inject their routing worker, skill
 * loader, execution workers, and validator workers, so full instructions and
 * tool schemas cross only the narrow execution boundary.
 */
export function createOrchestrator(options = {}) {
  const planner = createTaskPlanner(options);

  return {
    decompose: planner.decompose,
    route: planner.route,
    run: (request) => runAtomicTasks({
      request,
      planner,
      executors: options.executors,
      validators: options.validators,
      validatorAgents: options.validatorAgents,
      recoveries: options.recoveries,
      loadSkills: options.loadSkills,
    }),
  };
}

export function routeJson(orchestrator, task) {
  const route = orchestrator.route(task);
  return JSON.stringify({
    role: route.role,
    skills: route.skills,
    validation: route.validation,
    reason: route.reason,
    suggested_tools: route.suggested_tools,
  });
}
