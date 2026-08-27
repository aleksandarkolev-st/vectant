import { parseJson, stableJson } from './json';
import {
  knowledgeDedupeKey,
  safeKnowledgeProjection,
  validateKnowledgeItem,
} from './knowledgePolicy';

const REFERENCE_TYPES = Object.freeze({
  paths: 'path',
  symbols: 'symbol',
  contracts: 'contract',
  runtimeSessionIds: 'runtime_session',
  agentSessionIds: 'agent_session',
  workstreamIds: 'workstream',
  transactionIds: 'transaction',
});

function learningScopeForVisibility(visibility) {
  if (visibility === 'workspace') return 'workspace';
  if (visibility === 'learning_network') return 'learning_network';
  return 'project';
}

function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isoOrNull(value) {
  const date = dateOrNull(value);
  return date ? date.toISOString() : null;
}

function kindPayload(item) {
  if (item.kind === 'discovery') return { verification: item.verification };
  if (item.kind === 'lead') return { priority: item.priority };
  if (item.kind === 'shared_skill') return { skillKey: item.skillKey, recipe: item.recipe };
  if (item.kind === 'impact_notice') {
    return {
      sourceKnowledgeId: item.sourceKnowledgeId,
      recipientAgentSessionIds: item.recipientAgentSessionIds,
      requiresResponse: item.requiresResponse,
      responseAction: item.responseAction,
    };
  }
  if (item.kind === 'agent_question') {
    return {
      questionUrgency: item.questionUrgency,
      suggestedExpertAgentSessionIds: item.suggestedExpertAgentSessionIds,
      fromAgentSessionId: item.source?.agentSessionId || null,
      answerText: item.answerText || null,
      answeredByAgentSessionId: item.answeredByAgentSessionId || null,
    };
  }
  return {
    fromAgentSessionId: item.fromAgentSessionId,
    toAgentSessionId: item.toAgentSessionId,
    unresolvedRisks: item.unresolvedRisks,
    requiredActions: item.requiredActions,
  };
}

export function buildKnowledgeRecord(input, authority = {}) {
  const item = validateKnowledgeItem(input);
  const sourceAgentSessionId = item.source.agentSessionId || authority.agentSessionId || null;
  if (authority.projectId && item.projectId !== authority.projectId) {
    throw Object.assign(new Error('knowledge_project_mismatch'), { code: 'knowledge_project_mismatch', status: 403 });
  }
  if (authority.agentSessionId && sourceAgentSessionId !== authority.agentSessionId) {
    throw Object.assign(new Error('knowledge_source_agent_mismatch'), { code: 'knowledge_source_agent_mismatch', status: 403 });
  }
  const payload = {
    source: item.source,
    tags: item.tags,
    ...kindPayload(item),
  };
  return {
    normalized: item,
    data: {
      projectId: item.projectId,
      kind: item.kind,
      status: item.status,
      title: item.title,
      summary: item.summary,
      payloadJson: stableJson(payload),
      scopeJson: stableJson({
        visibility: item.visibility,
        references: item.references,
        tags: item.tags,
      }),
      learningScope: learningScopeForVisibility(item.visibility),
      redactionClass: item.redactionClass,
      confidence: item.confidence,
      verificationStatus: item.verification || (item.status === 'verified' ? 'verified' : 'unverified'),
      createdByUserId: authority.userId || null,
      createdByAgentSessionId: sourceAgentSessionId,
      ownerUserId: item.ownerUserId || authority.ownerUserId || null,
      ownerAgentSessionId: item.ownerAgentSessionId || null,
      sourceKnowledgeItemId: item.sourceKnowledgeId || null,
      targetTransactionId: item.references.transactionIds[0] || null,
      dedupeKey: knowledgeDedupeKey(item),
      evidenceRefsJson: stableJson(item.evidenceRefs),
      expiresAt: dateOrNull(item.expiresAt),
    },
  };
}

export function buildKnowledgeReferenceRecords(itemInput, knowledgeId) {
  const item = validateKnowledgeItem(itemInput);
  const records = [];
  for (const [key, refType] of Object.entries(REFERENCE_TYPES)) {
    for (const refKey of item.references[key]) {
      records.push({
        projectId: item.projectId,
        knowledgeId,
        refType,
        refKey,
        relation: item.kind === 'impact_notice' ? 'affected' : 'source',
        metadataJson: '{}',
      });
    }
  }
  return records;
}

function referencesFromRows(rows = []) {
  const references = Object.fromEntries(Object.keys(REFERENCE_TYPES).map((key) => [key, []]));
  const keyByType = Object.fromEntries(Object.entries(REFERENCE_TYPES).map(([key, value]) => [value, key]));
  for (const row of rows) {
    const key = keyByType[row.refType];
    if (key && !references[key].includes(row.refKey)) references[key].push(row.refKey);
  }
  return references;
}

export function projectKnowledgeRecord(row) {
  if (!row?.id || !row?.projectId) return null;
  const payload = parseJson(row.payloadJson, {});
  const scope = parseJson(row.scopeJson, {});
  const references = row.references?.length
    ? referencesFromRows(row.references)
    : (scope.references || {});
  return safeKnowledgeProjection({
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    summary: row.summary,
    visibility: scope.visibility || 'project',
    redactionClass: row.redactionClass,
    source: payload.source,
    references,
    evidenceRefs: parseJson(row.evidenceRefsJson, []),
    tags: payload.tags || scope.tags || [],
    confidence: row.confidence,
    createdAt: isoOrNull(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
    expiresAt: isoOrNull(row.expiresAt),
    verification: payload.verification || row.verificationStatus,
    priority: payload.priority,
    ownerUserId: row.ownerUserId,
    ownerAgentSessionId: row.ownerAgentSessionId,
    skillKey: payload.skillKey,
    recipe: payload.recipe,
    sourceKnowledgeId: payload.sourceKnowledgeId || row.sourceKnowledgeItemId,
    recipientAgentSessionIds: payload.recipientAgentSessionIds,
    requiresResponse: payload.requiresResponse,
    responseAction: payload.responseAction,
    questionUrgency: payload.questionUrgency,
    suggestedExpertAgentSessionIds: payload.suggestedExpertAgentSessionIds || [],
    answerText: payload.answerText,
    answeredByAgentSessionId: payload.answeredByAgentSessionId,
    fromAgentSessionId: payload.fromAgentSessionId,
    toAgentSessionId: payload.toAgentSessionId,
    unresolvedRisks: payload.unresolvedRisks,
    requiredActions: payload.requiredActions,
  });
}
