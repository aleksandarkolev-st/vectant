import { describe, expect, it } from 'vitest';
import { canonicalKnowledgeEventType, KNOWLEDGE_EVENT_TYPES } from '../knowledgeEvents.js';

describe('shared knowledge event classes', () => {
  it('maps every durable storage event to the architecture event class', () => {
    expect(Object.fromEntries(KNOWLEDGE_EVENT_TYPES.map((type) => [type, canonicalKnowledgeEventType(type)])))
      .toEqual({
        discovery_recorded: 'discovery.recorded',
        lead_opened: 'lead.opened',
        lead_claimed: 'lead.claimed',
        lead_resolved: 'lead.resolved',
        lead_dismissed: 'lead.dismissed',
        shared_skill_published: 'skill.published',
        shared_skill_updated: 'skill.updated',
        impact_notice_created: 'impact_notice.created',
        impact_notice_responded: 'impact_notice.responded',
        handoff_ready: 'handoff.ready',
        handoff_acknowledged: 'handoff.acknowledged',
        agent_question_asked: 'agent_question.asked',
        agent_question_answered: 'agent_question.answered',
        agent_question_feedback_submitted: 'agent_question.feedback_submitted',
      });
  });

  it('does not relabel unrelated event types', () => {
    expect(canonicalKnowledgeEventType('transaction_committed')).toBeNull();
    expect(canonicalKnowledgeEventType('')).toBeNull();
  });
});
