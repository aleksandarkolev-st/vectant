const ACTIONS = Object.freeze({
  discovery: Object.freeze(['acknowledge', 'mark_irrelevant']),
  lead: Object.freeze(['claim', 'dismiss', 'resolve', 'escalate']),
  shared_skill: Object.freeze(['adopt', 'dismiss']),
  handoff: Object.freeze(['accept', 'acknowledge', 'request_changes']),
  impact_notice: Object.freeze(['acknowledge', 'refresh', 'rebase_requested', 'abort', 'dismiss']),
});

const STATUS_BY_ACTION = Object.freeze({
  lead: Object.freeze({ claim: 'claimed', dismiss: 'dismissed', resolve: 'resolved', escalate: 'escalated' }),
  handoff: Object.freeze({ accept: 'acknowledged', acknowledge: 'acknowledged', request_changes: 'reopened' }),
  impact_notice: Object.freeze({
    acknowledge: 'acknowledged',
    rebase_requested: 'rebasing',
    abort: 'aborted',
    dismiss: 'irrelevant',
  }),
});

const REASON_REQUIRED = new Set([
  'discovery:mark_irrelevant',
  'lead:dismiss',
  'lead:resolve',
  'shared_skill:dismiss',
  'handoff:request_changes',
  'impact_notice:rebase_requested',
  'impact_notice:abort',
  'impact_notice:dismiss',
]);

const EVIDENCE_REQUIRED = new Set([
  'lead:resolve',
  'handoff:request_changes',
  'impact_notice:rebase_requested',
  'impact_notice:abort',
]);

const RESPONSE_KEYS = new Set(['action', 'reason', 'evidenceRefs', 'evidence_refs', 'answer', 'metadata']);
const PRIVATE_KEY = /(?:prompt|chain.?of.?thought|transcript|terminal.?history|credential|secret|token|cookie|private.?key|provider.?session)/i;

function responseError(code, detail = {}) {
  return Object.assign(new Error(code), { code, status: 422, detail });
}

function boundedText(value, field, maxLength, required = false) {
  const text = String(value || '').trim();
  if (required && !text) throw responseError(`knowledge_response_${field}_required`);
  if (text.length > maxLength) throw responseError(`knowledge_response_${field}_too_long`, { maxLength });
  if (text.includes('\u0000')) throw responseError(`knowledge_response_${field}_invalid`);
  return text || null;
}

function evidenceList(value) {
  const input = value == null ? [] : Array.isArray(value) ? value : [value];
  if (input.length > 32) throw responseError('knowledge_response_evidence_limit_exceeded', { limit: 32 });
  return [...new Set(input.map((entry) => boundedText(entry, 'evidence', 512, true)))];
}

function assertSafeMetadata(value, path = 'metadata', depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return boundedText(value, path, 2048);
  if (depth >= 4) throw responseError('knowledge_response_metadata_too_deep');
  if (Array.isArray(value)) {
    if (value.length > 32) throw responseError('knowledge_response_metadata_limit_exceeded');
    return value.map((entry, index) => assertSafeMetadata(entry, `${path}.${index}`, depth + 1));
  }
  if (typeof value !== 'object') throw responseError('knowledge_response_metadata_invalid');
  const entries = Object.entries(value);
  if (entries.length > 32) throw responseError('knowledge_response_metadata_limit_exceeded');
  return Object.fromEntries(entries.map(([key, entry]) => {
    if (PRIVATE_KEY.test(key)) throw responseError('knowledge_response_private_material_forbidden', { path: `${path}.${key}` });
    return [key, assertSafeMetadata(entry, `${path}.${key}`, depth + 1)];
  }));
}

export function allowedKnowledgeResponseActions(kind) {
  return [...(ACTIONS[String(kind || '').toLowerCase()] || [])];
}

export function validateKnowledgeResponse(kindInput, body = {}) {
  const kind = String(kindInput || '').trim().toLowerCase();
  const allowed = ACTIONS[kind];
  if (!allowed) throw responseError('knowledge_response_kind_invalid');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw responseError('knowledge_response_invalid');
  const unknown = Object.keys(body).filter((key) => !RESPONSE_KEYS.has(key));
  if (unknown.length) throw responseError('knowledge_response_field_forbidden', { fields: unknown });
  const action = String(body.action || '').trim().toLowerCase();
  if (!allowed.includes(action)) {
    throw responseError('knowledge_response_action_invalid', { kind, allowedActions: [...allowed] });
  }
  const key = `${kind}:${action}`;
  const reason = boundedText(body.reason, 'reason', 1024, REASON_REQUIRED.has(key));
  const evidenceRefs = evidenceList(body.evidenceRefs || body.evidence_refs);
  if (EVIDENCE_REQUIRED.has(key) && !evidenceRefs.length) {
    throw responseError('knowledge_response_evidence_required');
  }
  const answer = boundedText(body.answer, 'answer', 4096);
  const metadata = assertSafeMetadata(body.metadata || {});
  return {
    action,
    reason,
    evidenceRefs,
    answer,
    metadata,
    targetStatus: STATUS_BY_ACTION[kind]?.[action] || null,
  };
}

