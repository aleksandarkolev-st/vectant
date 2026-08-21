import { describe, expect, it } from 'vitest';
import { createOrchestrator, routeJson } from './index.js';

const SKILLS = [
  {
    id: 'database-debugging',
    name: 'Database debugging',
    description: 'Inspect database failures.',
    categories: ['debugging'],
    keywords: ['postgres', 'database'],
    toolGroups: ['database'],
    instructions: 'This body must never reach a router.',
  },
  {
    id: 'log-analysis',
    name: 'Log analysis',
    description: 'Inspect application logs.',
    categories: ['debugging'],
    keywords: ['logs', 'trace'],
    toolGroups: ['observability'],
    instructions: 'This body must never reach a router.',
  },
];

const TOOLS = [
  { id: 'sql', group: 'database', inputSchema: { secret: true } },
  { id: 'tail', group: 'observability', inputSchema: { secret: true } },
  { id: 'secret', group: 'admin', inputSchema: { secret: true } },
];

function createFixture(overrides = {}) {
  return createOrchestrator({
    skills: SKILLS,
    tools: TOOLS,
    agents: [
      { id: 'debug-lite', role: 'debugging', model: 'small', cost: 1, skills: SKILLS.map((skill) => skill.id) },
      { id: 'debug-large', role: 'debugging', model: 'large', cost: 8, skills: SKILLS.map((skill) => skill.id) },
      { id: 'fallback', role: 'implementation', model: 'small', cost: 2, fallback: true },
    ],
    executors: {
      'debug-lite': async ({ task }) => ({ ok: task.description }),
      fallback: async ({ task }) => ({ ok: task.description }),
      fastPath: async ({ task }) => ({ ok: task.description }),
    },
    validators: {
      independent: async () => ({ ok: true }),
    },
    ...overrides,
  });
}

describe('atomic orchestrator', () => {
  it('routes one skill through a machine-readable contract', () => {
    const routed = JSON.parse(routeJson(createFixture(), { description: 'Fix the postgres timeout.' }));

    expect(routed).toEqual({
      role: 'debugging',
      skills: ['database-debugging'],
      validation: 'none',
      reason: 'Matched 1 relevant skill.',
      suggested_tools: ['database'],
    });
  });

  it('routes multiple skills and exposes only their tool subset', () => {
    const routed = createFixture().route({ description: 'Inspect postgres logs.' });

    expect(routed.skills).toEqual(expect.arrayContaining(['database-debugging', 'log-analysis']));
    expect(routed.exposed.map((tool) => tool.id)).toEqual(['sql', 'tail']);
    expect(routed.exposed.map((tool) => tool.id)).not.toContain('secret');
  });

  it('uses a narrow fallback when no skill matches', () => {
    const routed = createFixture().route({ description: 'Handle an unfamiliar proprietary format.' });

    expect(routed.role).toBe('implementation');
    expect(routed.skills).toEqual([]);
    expect(routed.exposed).toEqual([]);
    expect(routed.reason).toContain('No skill matched');
  });

  it('executes trivial work once without spawning a router', async () => {
    const events = [];
    const executions = [];
    const orchestrator = createFixture({
      trace: (event) => events.push(event),
      routingAgents: [{ id: 'router', role: 'routing', capabilities: ['routing'], cost: 1 }],
      routers: { router: async () => { throw new Error('fast paths must not route'); } },
      executors: {
        fastPath: async ({ task }) => {
          executions.push(task.id);
          return { ok: true };
        },
      },
    });

    const [result] = await orchestrator.run({ id: 'mechanical', description: 'format a file' });

    expect(result.status).toBe('completed');
    expect(result.fastPath).toBe(true);
    expect(executions).toEqual(['mechanical']);
    expect(events.map((event) => event.event)).toContain('fast_path');
    expect(events.map((event) => event.event)).not.toContain('routing_started');
  });

  it('uses the cheapest capable routing and execution agents without leaking bodies or schemas', async () => {
    let routerPayload;
    let executionPayload;
    const orchestrator = createFixture({
      routingAgents: [
        { id: 'router-large', role: 'routing', model: 'large', capabilities: ['routing'], cost: 9 },
        { id: 'router-small', role: 'routing', model: 'small', capabilities: ['routing'], cost: 1 },
      ],
      routers: {
        'router-small': async (payload) => {
          routerPayload = payload;
          return {
            role: 'debugging',
            skills: ['database-debugging'],
            validation: 'independent',
            reason: 'Database failure needs a focused debugger.',
          };
        },
      },
      loadSkills: async (ids) => ids.map((id) => ({ id, content: `body for ${id}` })),
      executors: {
        'debug-lite': async (payload) => {
          executionPayload = payload;
          return { fixed: true };
        },
      },
    });

    const [result] = await orchestrator.run({ id: 'db', description: 'Fix postgres.' });

    expect(result.status).toBe('completed');
    expect(result.route.routerAgent.id).toBe('router-small');
    expect(result.route.agent.id).toBe('debug-lite');
    expect(routerPayload.skills).toEqual([expect.objectContaining({ id: 'database-debugging' }), expect.objectContaining({ id: 'log-analysis' })]);
    expect(routerPayload.skills.flatMap((skill) => Object.keys(skill))).not.toContain('instructions');
    expect(routerPayload.tools.flatMap((tool) => Object.keys(tool))).not.toContain('inputSchema');
    expect(executionPayload.skillInstructions).toEqual([{ id: 'database-debugging', content: 'body for database-debugging' }]);
    expect(executionPayload.tools).toEqual([expect.objectContaining({ id: 'sql', group: 'database' })]);
    expect(executionPayload.tools.flatMap((tool) => Object.keys(tool))).not.toContain('inputSchema');
  });

  it('runs an independent validator after execution', async () => {
    const calls = [];
    const orchestrator = createFixture({
      validatorAgents: [
        { id: 'validator-large', role: 'validation', model: 'large', cost: 5 },
        { id: 'validator-small', role: 'validation', model: 'small', cost: 1 },
      ],
      validators: {
        'validator-small': async (payload) => {
          calls.push(payload);
          return { ok: true, checked: true };
        },
      },
    });

    const [result] = await orchestrator.run({ id: 'secure', description: 'Fix postgres security.', category: 'security' });

    expect(result.status).toBe('completed');
    expect(result.validation).toEqual({ ok: true, checked: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].route.skills).toEqual(['database-debugging']);
  });

  it('propagates failure, recovers explicitly, and blocks dependent work when recovery fails', async () => {
    const recovered = createFixture({
      executors: {
        'debug-lite': async () => { throw new Error('transient executor failure'); },
      },
      recoveries: {
        debugging: async ({ error }) => ({ recoveredFrom: error }),
      },
    });
    const [recoveredResult] = await recovered.run({ description: 'Fix postgres.' });
    expect(recoveredResult.status).toBe('recovered');
    expect(recoveredResult.output).toEqual({ recoveredFrom: 'transient executor failure' });

    const failing = createFixture({
      executors: {
        'debug-lite': async () => { throw new Error('permanent failure'); },
      },
    });
    const results = await failing.run({
      atomicTasks: [
        { id: 'first', description: 'Fix postgres.' },
        { id: 'second', description: 'Inspect logs.', dependsOn: ['first'] },
      ],
    });

    expect(results.map((result) => result.status)).toEqual(['failed', 'blocked']);
    expect(results[1].blockedBy).toEqual(['first']);
  });
});
