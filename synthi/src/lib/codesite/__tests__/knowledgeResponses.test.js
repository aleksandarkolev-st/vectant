import { describe, expect, it } from 'vitest';
import {
  allowedKnowledgeResponseActions,
  validateKnowledgeResponse,
} from '../knowledgeResponses.js';

describe('shared knowledge responses', () => {
  it('publishes the exact per-kind action contract', () => {
    expect(allowedKnowledgeResponseActions('discovery')).toEqual(['acknowledge', 'mark_irrelevant']);
    expect(allowedKnowledgeResponseActions('lead')).toEqual(['claim', 'dismiss', 'resolve', 'escalate']);
    expect(allowedKnowledgeResponseActions('shared_skill')).toEqual(['adopt', 'dismiss']);
    expect(allowedKnowledgeResponseActions('handoff')).toEqual(['accept', 'acknowledge', 'request_changes']);
    expect(allowedKnowledgeResponseActions('impact_notice')).toEqual([
      'acknowledge', 'refresh', 'rebase_requested', 'abort', 'dismiss',
    ]);
  });

  it('maps transaction-affecting notice responses to durable states', () => {
    expect(validateKnowledgeResponse('impact_notice', {
      action: 'rebase_requested',
      reason: 'Producer contract advanced',
      evidenceRefs: ['event:contract-change'],
    })).toMatchObject({ action: 'rebase_requested', targetStatus: 'rebasing' });
    expect(validateKnowledgeResponse('impact_notice', {
      action: 'abort',
      reason: 'The stale transaction cannot be salvaged',
      evidenceRefs: ['transaction:txn-1'],
    }).targetStatus).toBe('aborted');
  });

  it('requires reason and evidence for dismissals, requested changes, and transaction actions', () => {
    expect(() => validateKnowledgeResponse('impact_notice', { action: 'dismiss' }))
      .toThrow('knowledge_response_reason_required');
    expect(() => validateKnowledgeResponse('handoff', { action: 'request_changes', reason: 'Missing tests' }))
      .toThrow('knowledge_response_evidence_required');
    expect(() => validateKnowledgeResponse('lead', { action: 'resolve', reason: 'Fixed' }))
      .toThrow('knowledge_response_evidence_required');
  });

  it('does not let acknowledgement masquerade as a transaction rebase', () => {
    const response = validateKnowledgeResponse('impact_notice', { action: 'acknowledge' });
    expect(response.targetStatus).toBe('acknowledged');
    expect(response).not.toHaveProperty('transactionStatus');
  });

  it('rejects actions belonging to a different knowledge kind', () => {
    expect(() => validateKnowledgeResponse('discovery', { action: 'claim' }))
      .toThrow('knowledge_response_action_invalid');
    expect(() => validateKnowledgeResponse('lead', { action: 'adopt' }))
      .toThrow('knowledge_response_action_invalid');
  });

  it('rejects identity, authorization, provider, and private memory fields', () => {
    for (const field of ['agentSessionId', 'projectId', 'authToken', 'cookie', 'providerSessionRef', 'rawPrompt']) {
      expect(() => validateKnowledgeResponse('impact_notice', { action: 'acknowledge', [field]: 'forged' }))
        .toThrow('knowledge_response_field_forbidden');
    }
    expect(() => validateKnowledgeResponse('impact_notice', {
      action: 'acknowledge',
      metadata: { transcript: 'private' },
    })).toThrow('knowledge_response_private_material_forbidden');
  });

  it('normalizes bounded evidence and safe metadata', () => {
    expect(validateKnowledgeResponse('lead', {
      action: 'claim',
      evidence_refs: ['lead:1', 'lead:1'],
      metadata: { queue: 'backend', retry: 1 },
    })).toMatchObject({
      action: 'claim',
      evidenceRefs: ['lead:1'],
      metadata: { queue: 'backend', retry: 1 },
      targetStatus: 'claimed',
    });
  });
});
