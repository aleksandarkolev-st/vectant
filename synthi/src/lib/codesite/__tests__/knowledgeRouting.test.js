import { describe, expect, it } from 'vitest';
import { buildKnowledgeDeliveryPlan, knowledgePathsOverlap } from '../knowledgeRouting.js';

function item(overrides = {}) {
  return {
    id: 'knowledge-1',
    kind: 'discovery',
    source: { agentSessionId: 'producer' },
    references: {
      paths: [],
      symbols: [],
      contracts: [],
      runtimeSessionIds: [],
      agentSessionIds: [],
      workstreamIds: [],
      transactionIds: [],
    },
    ...overrides,
  };
}

const sessions = [
  { id: 'producer', ownerUserId: 'alice', status: 'attached', subscriptionsJson: '[]' },
  { id: 'claude-agent', ownerUserId: 'ben', status: 'attached', subscriptionsJson: '[]' },
  { id: 'gemini-agent', ownerUserId: 'cara', status: 'detached', subscriptionsJson: '[]' },
  { id: 'ended-agent', ownerUserId: 'dan', status: 'detached', endedAt: new Date(), subscriptionsJson: '["knowledge.*"]' },
];

describe('knowledge relevance routing', () => {
  it('matches exact, nested, and globbed project paths symmetrically', () => {
    expect(knowledgePathsOverlap('src/contracts/**', 'src/contracts/door.json')).toBe(true);
    expect(knowledgePathsOverlap('src/contracts/door.json', 'src/contracts/**')).toBe(true);
    expect(knowledgePathsOverlap('src/contracts', 'src/contracts/door.json')).toBe(true);
    expect(knowledgePathsOverlap('src/other/**', 'src/contracts/door.json')).toBe(false);
  });

  it('routes a contract discovery to every affected provider without provider branches', () => {
    const result = buildKnowledgeDeliveryPlan({
      item: item({ references: { contracts: ['rotation-event.v2'] } }),
      sessions,
      transactions: [
        { id: 'txn-claude', agentSessionId: 'claude-agent', status: 'open', semanticDependencyRefsJson: '["contract:rotation-event.v2"]' },
        { id: 'txn-gemini', agentSessionId: 'gemini-agent', status: 'prepared', semanticDependencyRefsJson: '[{"type":"contract","key":"rotation-event.v2"}]' },
      ],
    });
    expect(result.map((target) => target.agentSessionId)).toEqual(['claude-agent', 'gemini-agent']);
    expect(result[0].deliveryState).toBe('live_and_durable');
    expect(result[1].deliveryState).toBe('durable_resume');
    expect(result.every((target) => target.reasons.some((reason) => reason.startsWith('transaction_contract:')))).toBe(true);
  });

  it('routes exact handoffs while avoiding unrelated broadcast and ended sessions', () => {
    const result = buildKnowledgeDeliveryPlan({
      item: item({
        kind: 'handoff',
        toAgentSessionId: 'gemini-agent',
        references: { workstreamIds: ['plan-backend'] },
      }),
      sessions,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ agentSessionId: 'gemini-agent', deliveryState: 'durable_resume' });
  });

  it('routes by plans, active transactions, and explicit subscriptions', () => {
    const subscribedSessions = sessions.map((session) => session.id === 'gemini-agent'
      ? { ...session, subscriptionsJson: '["path:src/api/**"]' }
      : session);
    const result = buildKnowledgeDeliveryPlan({
      item: item({ references: { paths: ['src/api/users/route.js'] } }),
      sessions: subscribedSessions,
      executionPlans: [{ id: 'plan-api', agentSessionId: 'claude-agent', routeJson: '["src/api/**"]' }],
    });
    expect(result.map((target) => target.agentSessionId)).toEqual(['claude-agent', 'gemini-agent']);
    expect(result[0].reasons).toContain('route:plan-api');
    expect(result[1].reasons).toContain('subscription:path:src/api/**');
  });

  it('does not notify the producer from incidental overlap', () => {
    const result = buildKnowledgeDeliveryPlan({
      item: item({ references: { paths: ['src/shared.js'] } }),
      sessions,
      executionPlans: [{ id: 'producer-plan', agentSessionId: 'producer', routeJson: '["src/**"]' }],
    });
    expect(result).toEqual([]);
  });

  it('allows an explicit self-reference and produces stable dedupe keys', () => {
    const input = {
      item: item({ references: { agentSessionIds: ['producer'] } }),
      sessions,
    };
    const first = buildKnowledgeDeliveryPlan(input);
    const second = buildKnowledgeDeliveryPlan(input);
    expect(first).toHaveLength(1);
    expect(first[0].dedupeKey).toBe(second[0].dedupeKey);
    expect(first[0].dedupeKey).toMatch(/^impact:[a-f0-9]{64}$/);
  });

  it('routes an agent question only to its explicit recipient', () => {
    const result = buildKnowledgeDeliveryPlan({
      item: item({
        kind: 'agent_question',
        recipientAgentSessionIds: ['claude-agent'],
      }),
      sessions,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      agentSessionId: 'claude-agent',
      reasons: expect.arrayContaining(['explicit_agent_reference']),
    });
  });

  it('rejects incomplete routing inputs instead of falling back to broadcast', () => {
    expect(() => buildKnowledgeDeliveryPlan({ item: { kind: 'lead' } })).toThrow('knowledge_delivery_item_required');
  });
});
