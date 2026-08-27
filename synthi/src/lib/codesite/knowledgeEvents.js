const CANONICAL_KNOWLEDGE_EVENT_TYPES = Object.freeze({
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
});

export function canonicalKnowledgeEventType(eventType) {
  return CANONICAL_KNOWLEDGE_EVENT_TYPES[String(eventType || '')] || null;
}

export const KNOWLEDGE_EVENT_TYPES = Object.freeze(Object.keys(CANONICAL_KNOWLEDGE_EVENT_TYPES));
