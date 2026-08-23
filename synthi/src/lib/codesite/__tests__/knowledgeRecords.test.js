import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeRecord,
  buildKnowledgeReferenceRecords,
  projectKnowledgeRecord,
} from '../knowledgeRecords.js';

const discovery = {
  kind: 'discovery',
  projectId: 'project-1',
  title: 'Rotation event contract changed',
  summary: 'The producer now emits a monotonic sequence number.',
  status: 'verified',
  source: { actorType: 'agent', actorId: 'agent-1', agentSessionId: 'agent-1' },
  references: {
    paths: ['contracts/rotation-event.json'],
    contracts: ['rotation-event.v2'],
    transactionIds: ['txn-1'],
  },
  evidenceRefs: ['test:rotation-contract:passed'],
  confidence: 0.98,
  tags: ['contract'],
};

describe('knowledge database records', () => {
  it('encodes safe normalized project knowledge into indexed columns', () => {
    const result = buildKnowledgeRecord(discovery, {
      projectId: 'project-1',
      agentSessionId: 'agent-1',
      userId: 'user-1',
    });
    expect(result.data).toMatchObject({
      projectId: 'project-1',
      kind: 'discovery',
      status: 'verified',
      createdByUserId: 'user-1',
      createdByAgentSessionId: 'agent-1',
      targetTransactionId: 'txn-1',
      verificationStatus: 'verified',
    });
    expect(result.data.dedupeKey).toMatch(/^knowledge:discovery:[a-f0-9]{64}$/);
    expect(JSON.parse(result.data.payloadJson)).toEqual({
      source: { actorType: 'agent', actorId: 'agent-1', agentSessionId: 'agent-1', terminalSessionId: null },
      tags: ['contract'],
      verification: 'verified',
    });
  });

  it('rejects cross-project and forged source identities', () => {
    expect(() => buildKnowledgeRecord(discovery, { projectId: 'project-2' })).toThrow('knowledge_project_mismatch');
    expect(() => buildKnowledgeRecord(discovery, { projectId: 'project-1', agentSessionId: 'agent-2' }))
      .toThrow('knowledge_source_agent_mismatch');
  });

  it('creates one searchable reference row per normalized reference', () => {
    const rows = buildKnowledgeReferenceRecords(discovery, 'knowledge-1');
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ refType: 'path', refKey: 'contracts/rotation-event.json' }),
      expect.objectContaining({ refType: 'contract', refKey: 'rotation-event.v2' }),
      expect.objectContaining({ refType: 'transaction', refKey: 'txn-1' }),
    ]));
    expect(rows).toHaveLength(3);
  });

  it('reconstructs only the safe projection from a persisted row', () => {
    const encoded = buildKnowledgeRecord(discovery, {
      projectId: 'project-1',
      agentSessionId: 'agent-1',
      userId: 'user-1',
    });
    const row = {
      id: 'knowledge-1',
      ...encoded.data,
      createdAt: new Date('2026-08-22T03:00:00.000Z'),
      updatedAt: new Date('2026-08-22T03:01:00.000Z'),
      references: buildKnowledgeReferenceRecords(discovery, 'knowledge-1'),
    };
    const projection = projectKnowledgeRecord(row);
    expect(projection).toMatchObject({
      id: 'knowledge-1',
      kind: 'discovery',
      projectId: 'project-1',
      verification: 'verified',
      references: {
        paths: ['contracts/rotation-event.json'],
        contracts: ['rotation-event.v2'],
        transactionIds: ['txn-1'],
      },
    });
    expect(JSON.stringify(projection)).not.toMatch(/token|providerSessionRef|prompt|transcript/i);
  });

  it('round-trips provider-neutral handoffs without provider fields', () => {
    const handoff = {
      kind: 'handoff',
      projectId: 'project-1',
      title: 'Backend ready for UI integration',
      summary: 'Contract and tests are ready.',
      status: 'ready',
      source: { actorType: 'agent', actorId: 'agent-1', agentSessionId: 'agent-1' },
      references: { agentSessionIds: ['agent-2'], workstreamIds: ['plan-ui'] },
      evidenceRefs: ['commit:abc1234'],
      fromAgentSessionId: 'agent-1',
      toAgentSessionId: 'agent-2',
      unresolvedRisks: ['Visual verification remains'],
      requiredActions: ['Run browser acceptance'],
    };
    const encoded = buildKnowledgeRecord(handoff, { projectId: 'project-1', agentSessionId: 'agent-1' });
    const projection = projectKnowledgeRecord({
      id: 'handoff-1',
      ...encoded.data,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(projection).toMatchObject({
      fromAgentSessionId: 'agent-1',
      toAgentSessionId: 'agent-2',
      requiredActions: ['Run browser acceptance'],
    });
    expect(projection).not.toHaveProperty('provider');
  });
});
