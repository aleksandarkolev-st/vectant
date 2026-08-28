import { describe, expect, it } from 'vitest';
import {
  EXPERTISE_SIGNAL_WEIGHTS,
  buildExpertiseIndex,
  normalizeExpertiseQuery,
  rankExperts,
  suggestExpertsForReferences,
  transactionExpertiseRefs,
} from '../agentExpertise';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const RECENT = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
const OLD = new Date(NOW.getTime() - 120 * 24 * 60 * 60 * 1000).toISOString();

const sessions = [
  { id: 'agent-alice', displayCallsign: 'CODEX-01', ownerUserId: 'alice', agentProvider: 'codex', status: 'attached' },
  { id: 'agent-ben', displayCallsign: 'CLAUDE-02', ownerUserId: 'ben', agentProvider: 'claude', status: 'detached' },
  { id: 'agent-cara', displayCallsign: 'GEMINI-03', ownerUserId: 'cara', agentProvider: 'gemini', status: 'attached' },
  { id: 'agent-ended', displayCallsign: 'GONE-04', ownerUserId: 'dan', agentProvider: 'codex', status: 'detached', endedAt: new Date() },
];

function plan(overrides = {}) {
  return {
    id: 'plan-1',
    agentSessionId: 'agent-alice',
    status: 'active',
    routeJson: JSON.stringify(['src/rotation/**']),
    filedAt: RECENT,
    ...overrides,
  };
}

function transaction(overrides = {}) {
  return {
    id: 'txn-1',
    agentSessionId: 'agent-ben',
    status: 'open',
    readSetJson: JSON.stringify(['src/door/DoorState.cpp']),
    observedReadSetJson: '[]',
    writeSetJson: JSON.stringify(['src/door/DoorState.cpp']),
    observedWriteSetJson: '[]',
    semanticDependencyRefsJson: JSON.stringify(['contract:rotation.completed@v2']),
    openedAt: RECENT,
    ...overrides,
  };
}

function knowledge(overrides = {}) {
  return {
    id: 'knw-1',
    kind: 'discovery',
    status: 'verified',
    createdByAgentSessionId: 'agent-alice',
    scopeJson: JSON.stringify({
      references: {
        paths: ['src/CharacterController.cpp'],
        symbols: ['CharacterController::Turn'],
        contracts: ['rotation.completed@v1'],
      },
    }),
    updatedAt: RECENT,
    ...overrides,
  };
}

function index(overrides = {}) {
  return buildExpertiseIndex({ executionPlans: [], transactions: [], knowledgeItems: [], now: NOW, ...overrides });
}

describe('expertise query normalization', () => {
  it('requires at least one reference and clamps the limit', () => {
    expect(() => normalizeExpertiseQuery({})).toThrow();
    const normalized = normalizeExpertiseQuery({ paths: ['Src/A/**'], symbols: ['Turn'], limit: 999 });
    expect(normalized).toEqual({
      paths: ['Src/A/**'],
      symbols: ['Turn'],
      contracts: [],
      limit: 10,
    });
  });

  it('rejects oversized queries instead of truncating silently', () => {
    const many = Array.from({ length: 33 }, (_, i) => `p${i}`);
    expect(() => normalizeExpertiseQuery({ paths: many })).toThrow();
  });
});

describe('transaction expertise refs', () => {
  it('parses read/write sets and typed semantic refs from json columns', () => {
    const refs = transactionExpertiseRefs(transaction());
    expect(refs.write).toContain('src/door/DoorState.cpp');
    expect(refs.read).toContain('src/door/DoorState.cpp');
    expect(refs.contracts).toContain('rotation.completed@v2');
    expect(refs.symbols).toEqual([]);
  });

  it('accepts object-form semantic refs from live API payloads', () => {
    const refs = transactionExpertiseRefs(transaction({
      semanticDependencyRefsJson: '[]',
      semanticDependencyRefs: [{ type: 'symbol', key: 'CharacterController::Turn' }],
    }));
    expect(refs.symbols).toEqual(['CharacterController::Turn']);
  });
});

describe('expertise ranking', () => {
  it('ranks a writer above a reader for the same path and never returns the asker', () => {
    const built = index({
      transactions: [
        transaction({ id: 'txn-writer', agentSessionId: 'agent-alice', status: 'open' }),
        transaction({ id: 'txn-reader', agentSessionId: 'agent-cara', writeSetJson: '[]', status: 'open' }),
      ],
    });
    const ranked = rankExperts(built, { paths: ['src/door/DoorState.cpp'], symbols: [], contracts: [], limit: 5 }, {
      sessions,
      excludeSessionId: 'agent-ben',
    });
    expect(ranked[0].agentSessionId).toBe('agent-alice');
    expect(ranked.map((entry) => entry.agentSessionId)).not.toContain('agent-ben');
    expect(ranked.map((entry) => entry.agentSessionId)).not.toContain('agent-ended');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[0].evidence.some((ref) => ref.startsWith('transaction_write:'))).toBe(true);
  });

  it('matches contract and symbol queries against transaction semantics', () => {
    const built = index({
      transactions: [transaction()],
    });
    const byContract = rankExperts(built, { paths: [], symbols: [], contracts: ['rotation.completed@v2'] }, { sessions });
    expect(byContract.map((e) => e.agentSessionId)).toEqual(['agent-ben']);
    const bySymbol = rankExperts(
      built,
      { paths: [], symbols: ['CharacterController::Turn'], contracts: [] },
      { sessions },
    );
    expect(bySymbol).toEqual([]);
  });

  it('derives expertise from knowledge authorship and referenced sessions', () => {
    const built = index({
      knowledgeItems: [
        knowledge(),
        knowledge({
          id: 'knw-2',
          createdByAgentSessionId: null,
          scopeJson: JSON.stringify({
            references: { agentSessionIds: ['agent-cara'], paths: ['src/CharacterController.cpp'] },
          }),
        }),
      ],
    });
    const ranked = rankExperts(
      built,
      { paths: ['src/CharacterController.cpp'], symbols: [], contracts: [] },
      { sessions },
    );
    expect(ranked.map((e) => e.agentSessionId)).toContain('agent-alice');
    expect(ranked.map((e) => e.agentSessionId)).toContain('agent-cara');
    const alice = ranked.find((e) => e.agentSessionId === 'agent-alice');
    expect(alice.evidence).toContain('knowledge_authorship:knw-1');
  });

  it('uses only policy-eligible knowledge and credits answered questions to the responder', () => {
    const built = index({
      knowledgeItems: [
        knowledge({
          id: 'knw-rejected',
          status: 'rejected',
          scopeJson: JSON.stringify({ references: { paths: ['src/rejected.ts'] } }),
        }),
        {
          id: 'question-open',
          kind: 'agent_question',
          status: 'open',
          createdByAgentSessionId: 'agent-alice',
          payloadJson: JSON.stringify({ answeredByAgentSessionId: 'agent-cara' }),
          scopeJson: JSON.stringify({ references: { paths: ['src/question.ts'] } }),
          updatedAt: RECENT,
        },
        {
          id: 'question-answered',
          kind: 'agent_question',
          status: 'answered',
          createdByAgentSessionId: 'agent-alice',
          payloadJson: JSON.stringify({ answeredByAgentSessionId: 'agent-cara' }),
          scopeJson: JSON.stringify({ references: { paths: ['src/question.ts'] } }),
          updatedAt: RECENT,
        },
      ],
    });

    const rejectedExperts = rankExperts(
      built,
      { paths: ['src/rejected.ts'], symbols: [], contracts: [] },
      { sessions },
    );
    const questionExperts = rankExperts(
      built,
      { paths: ['src/question.ts'], symbols: [], contracts: [] },
      { sessions },
    );

    expect(rejectedExperts).toEqual([]);
    expect(questionExperts.map((entry) => entry.agentSessionId)).toEqual(['agent-cara']);
    expect(questionExperts[0].evidence).toContain('knowledge_answer:question-answered');
  });

  it('uses the latest answer feedback to reward useful answers and penalize corrections', () => {
    const answeredQuestion = {
      id: 'question-feedback',
      kind: 'agent_question',
      status: 'answered',
      createdByAgentSessionId: 'agent-alice',
      payloadJson: JSON.stringify({ answeredByAgentSessionId: 'agent-cara' }),
      scopeJson: JSON.stringify({ references: { paths: ['src/question.ts'] } }),
      updatedAt: RECENT,
    };
    const base = index({
      transactions: [transaction({ agentSessionId: 'agent-cara', writeSetJson: JSON.stringify(['src/question.ts']) })],
      knowledgeItems: [answeredQuestion],
    });
    const useful = index({
      transactions: [transaction({ agentSessionId: 'agent-cara', writeSetJson: JSON.stringify(['src/question.ts']) })],
      knowledgeItems: [answeredQuestion],
      feedbackEvents: [{
        id: 'feedback-useful',
        eventType: 'agent_question_feedback_submitted',
        actorType: 'human',
        actorId: 'reviewer-1',
        detailsJson: JSON.stringify({ knowledgeItemId: 'question-feedback', verdict: 'useful' }),
        createdAt: RECENT,
      }],
    });
    const correction = index({
      transactions: [transaction({ agentSessionId: 'agent-cara', writeSetJson: JSON.stringify(['src/question.ts']) })],
      knowledgeItems: [answeredQuestion],
      feedbackEvents: [{
        id: 'feedback-correction',
        eventType: 'agent_question_feedback_submitted',
        actorType: 'human',
        actorId: 'reviewer-1',
        detailsJson: JSON.stringify({ knowledgeItemId: 'question-feedback', verdict: 'needs_correction' }),
        createdAt: RECENT,
      }],
    });
    const query = { paths: ['src/question.ts'], symbols: [], contracts: [] };
    const baseScore = rankExperts(base, query, { sessions }).find((entry) => entry.agentSessionId === 'agent-cara').score;
    const usefulScore = rankExperts(useful, query, { sessions }).find((entry) => entry.agentSessionId === 'agent-cara').score;
    const correctionScore = rankExperts(correction, query, { sessions }).find((entry) => entry.agentSessionId === 'agent-cara').score;

    expect(usefulScore).toBeGreaterThan(baseScore);
    expect(correctionScore).toBeLessThan(baseScore);
    expect(rankExperts(useful, query, { sessions })[0].evidence).toContain('knowledge_feedback:useful:feedback-useful');
  });

  it('uses only the newest feedback from the same reviewer for a question', () => {
    const question = {
      id: 'question-latest-feedback',
      kind: 'agent_question',
      status: 'answered',
      payloadJson: JSON.stringify({ answeredByAgentSessionId: 'agent-cara' }),
      scopeJson: JSON.stringify({ references: { paths: ['src/question.ts'] } }),
      updatedAt: RECENT,
    };
    const built = index({
      knowledgeItems: [question],
      feedbackEvents: [
        {
          id: 'feedback-old',
          eventType: 'agent_question_feedback_submitted',
          actorType: 'human',
          actorId: 'reviewer-1',
          detailsJson: JSON.stringify({ knowledgeItemId: question.id, verdict: 'needs_correction' }),
          createdAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000),
        },
        {
          id: 'feedback-new',
          eventType: 'agent_question_feedback_submitted',
          actorType: 'human',
          actorId: 'reviewer-1',
          detailsJson: JSON.stringify({ knowledgeItemId: question.id, verdict: 'useful' }),
          createdAt: RECENT,
        },
      ],
    });
    const ranked = rankExperts(
      built,
      { paths: ['src/question.ts'], symbols: [], contracts: [] },
      { sessions },
    );
    expect(ranked[0].evidence).toContain('knowledge_feedback:useful:feedback-new');
    expect(ranked[0].evidence).not.toContain('knowledge_feedback:needs_correction:feedback-old');
  });

  it('combines plan routes with knowledge signals and applies recency decay', () => {
    const fresh = index({
      executionPlans: [plan({ agentSessionId: 'agent-cara' })],
      knowledgeItems: [knowledge()],
    });
    const stale = index({
      executionPlans: [plan({ agentSessionId: 'agent-cara', filedAt: OLD })],
      knowledgeItems: [knowledge()],
    });
    const query = { paths: ['src/rotation/spin.cpp'], symbols: [], contracts: [] };
    const freshScore = rankExperts(fresh, query, { sessions }).find((e) => e.agentSessionId === 'agent-cara').score;
    const staleScore = rankExperts(stale, query, { sessions }).find((e) => e.agentSessionId === 'agent-cara').score;
    expect(freshScore).toBeGreaterThan(staleScore);
    expect(staleScore).toBeGreaterThan(0);
  });

  it('weights signals in the documented order', () => {
    expect(EXPERTISE_SIGNAL_WEIGHTS.transaction_write)
      .toBeGreaterThan(EXPERTISE_SIGNAL_WEIGHTS.transaction_read);
    expect(EXPERTISE_SIGNAL_WEIGHTS.transaction_read)
      .toBeGreaterThanOrEqual(EXPERTISE_SIGNAL_WEIGHTS.knowledge_reference);
    expect(EXPERTISE_SIGNAL_WEIGHTS.plan_route)
      .toBeGreaterThan(EXPERTISE_SIGNAL_WEIGHTS.knowledge_authorship);
  });

  it('is deterministic across runs with identical inputs', () => {
    const input = {
      transactions: [transaction()],
      knowledgeItems: [knowledge()],
      executionPlans: [plan(), plan({ id: 'plan-2', agentSessionId: 'agent-cara' })],
    };
    const first = rankExperts(index(input), { paths: ['src/**'], symbols: [], contracts: [] }, { sessions });
    const second = rankExperts(index(input), { paths: ['src/**'], symbols: [], contracts: [] }, { sessions });
    expect(first).toEqual(second);
  });

  it('returns empty instead of guessing when nothing intersects the query', () => {
    const built = index({ transactions: [transaction()] });
    expect(rankExperts(built, { paths: ['docs/prose.md'], symbols: [], contracts: [] }, { sessions })).toEqual([]);
  });

  it('suggests expert recipients for knowledge references without hardcoding', () => {
    const suggested = suggestExpertsForReferences(
      { paths: ['src/door/DoorState.cpp'] },
      {
        sessions,
        executionPlans: [plan({ agentSessionId: 'agent-alice', routeJson: JSON.stringify(['src/door/**']) })],
        transactions: [transaction()],
        excludeSessionId: 'agent-ben',
        now: NOW,
      },
    );
    expect(suggested.map((e) => e.agentSessionId)).toEqual(['agent-alice']);
  });

  it('can rank suggestions from a materialized index without rescanning source rows', () => {
    const materialized = index({
      executionPlans: [plan({ routeJson: JSON.stringify(['src/materialized/**']) })],
    });
    const suggested = suggestExpertsForReferences(
      { paths: ['src/materialized/file.ts'] },
      {
        sessions,
        index: materialized,
        executionPlans: [],
        transactions: [],
        knowledgeItems: [],
        now: NOW,
      },
    );
    expect(suggested.map((e) => e.agentSessionId)).toEqual(['agent-alice']);
  });
});
