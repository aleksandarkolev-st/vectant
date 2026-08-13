/** Small, dependency-free orchestration core. Catalogs and executors are injected. */
export function createOrchestrator({ skills = [], agents = [], tools = [], executors = {}, validators = {}, trace = () => {} } = {}) {
  const emit = (event, data) => trace({ event, ...data });
  const atomic = task => ({ id: task.id || `task-${Math.random().toString(36).slice(2)}`, description: String(task.description || task), ...task });
  const decompose = request => Array.isArray(request) ? request.map(atomic) : (request?.atomicTasks || [atomic(request)]);
  const fast = task => task.fastPath === true || /^(rename|format|typo|mechanical)\b/i.test(task.description);
  const route = task => {
    const candidates = skills.filter(s => (s.keywords || []).some(k => task.description.toLowerCase().includes(k.toLowerCase())) || (s.categories || []).includes(task.category));
    const selected = candidates.slice(0, 3);
    const capable = agents.filter(a => selected.length === 0 ? a.fallback !== false : selected.every(s => (a.skills || []).includes(s.id))).sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0));
    const agent = capable[0] || agents.find(a => a.fallback !== false) || { id: 'implementation', role: 'implementation', model: 'default', cost: 0 };
    const exposed = tools.filter(t => selected.some(s => (s.toolGroups || []).includes(t.group) || (s.tools || []).includes(t.id)));
    const validation = task.validation || (task.risk === 'high' || task.category === 'security' ? 'independent' : 'none');
    const result = { role: agent.role || agent.id, skills: selected.map(s => s.id), validation, reason: selected.length ? `Matched ${selected.length} relevant skill${selected.length > 1 ? 's' : ''}.` : 'No skill matched; using fallback implementation role.', suggested_tools: [...new Set(exposed.map(t => t.group || t.id))] };
    emit('routed', { task, route: result, agent: agent.id, tools: exposed.map(t => t.id) });
    return { ...result, agent, selected, exposed };
  };
  async function run(request) {
    const results = [];
    for (const raw of decompose(request)) {
      const task = atomic(raw);
      if (fast(task)) { emit('fast_path', { task }); results.push({ task, status: 'fast-path', route: { role: 'implementation', skills: [], validation: 'none', reason: 'Trivial mechanical operation.', suggested_tools: [] } }); continue; }
      const routing = route(task); const executor = executors[routing.agent.id] || executors[routing.role];
      if (!executor) { const error = new Error(`No executor for ${routing.role}`); emit('execution_failed', { task, error: error.message }); results.push({ task, status: 'failed', route: routing, error }); continue; }
      let output; try { output = await executor({ task, skills: routing.selected, tools: routing.exposed, route: routing }); emit('executed', { task, agent: routing.agent.id }); }
      catch (error) { emit('execution_failed', { task, error: error.message, agent: routing.agent.id }); results.push({ task, status: 'failed', route: routing, error }); continue; }
      let validation = null; if (routing.validation !== 'none') { const validator = validators[routing.validation] || validators.default; try { validation = validator ? await validator({ task, output, route: routing }) : { ok: false, reason: 'validator unavailable' }; emit('validated', { task, validation }); } catch (error) { validation = { ok: false, error: error.message }; emit('validation_failed', { task, error: error.message }); } }
      results.push({ task, status: validation && validation.ok === false ? 'invalid' : 'completed', route: routing, output, validation });
    }
    return results;
  }
  return { decompose, route, run };
}

export function routeJson(orchestrator, task) {
  const r = orchestrator.route(task);
  return JSON.stringify({ role: r.role, skills: r.skills, validation: r.validation, reason: r.reason, suggested_tools: r.suggested_tools });
}
