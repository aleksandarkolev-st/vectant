import crypto from 'crypto';

export const KNOWLEDGE_KINDS = Object.freeze([
  'discovery',
  'lead',
  'shared_skill',
  'impact_notice',
  'handoff',
  'agent_question',
]);

export const KNOWLEDGE_REFERENCE_LIMITS = Object.freeze({
  perType: 32,
  total: 96,
  pathLength: 512,
  semanticLength: 256,
  idLength: 128,
});

const KIND_ALIASES = new Map([
  ['discovery', 'discovery'],
  ['lead', 'lead'],
  ['skill', 'shared_skill'],
  ['shared_skill', 'shared_skill'],
  ['sharedskill', 'shared_skill'],
  ['impact', 'impact_notice'],
  ['impact_notice', 'impact_notice'],
  ['impactnotice', 'impact_notice'],
  ['handoff', 'handoff'],
  ['agent_question', 'agent_question'],
  ['question', 'agent_question'],
]);

const KNOWLEDGE_STATUSES = Object.freeze({
  discovery: Object.freeze(['draft', 'verified', 'rejected', 'invalidated', 'archived']),
  lead: Object.freeze(['open', 'claimed', 'escalated', 'resolved', 'dismissed', 'archived']),
  shared_skill: Object.freeze(['draft', 'pending_review', 'published', 'rejected', 'deprecated', 'revoked']),
  impact_notice: Object.freeze(['pending', 'acknowledged', 'rebasing', 'resolved', 'irrelevant', 'aborted', 'expired']),
  handoff: Object.freeze(['draft', 'ready', 'acknowledged', 'reopened', 'completed', 'declined', 'cancelled', 'expired']),
  agent_question: Object.freeze(['open', 'answered', 'stale', 'archived']),
});

const DEFAULT_STATUS = Object.freeze({
  discovery: 'draft',
  lead: 'open',
  shared_skill: 'draft',
  impact_notice: 'pending',
  handoff: 'draft',
  agent_question: 'open',
});

const STATUS_TRANSITIONS = Object.freeze({
  discovery: Object.freeze({
    draft: Object.freeze(['verified', 'rejected', 'archived']),
    verified: Object.freeze(['invalidated', 'archived']),
    rejected: Object.freeze(['archived']),
    invalidated: Object.freeze(['verified', 'archived']),
    archived: Object.freeze([]),
  }),
  lead: Object.freeze({
    open: Object.freeze(['claimed', 'escalated', 'resolved', 'dismissed', 'archived']),
    claimed: Object.freeze(['open', 'escalated', 'resolved', 'dismissed']),
    escalated: Object.freeze(['claimed', 'resolved', 'dismissed']),
    resolved: Object.freeze(['archived']),
    dismissed: Object.freeze(['archived']),
    archived: Object.freeze([]),
  }),
  shared_skill: Object.freeze({
    draft: Object.freeze(['pending_review', 'published', 'rejected']),
    pending_review: Object.freeze(['published', 'rejected']),
    published: Object.freeze(['deprecated', 'revoked']),
    rejected: Object.freeze(['draft']),
    deprecated: Object.freeze(['revoked']),
    revoked: Object.freeze([]),
  }),
  impact_notice: Object.freeze({
    pending: Object.freeze(['acknowledged', 'irrelevant', 'expired']),
    acknowledged: Object.freeze(['rebasing', 'resolved', 'aborted']),
    rebasing: Object.freeze(['resolved', 'aborted']),
    resolved: Object.freeze([]),
    irrelevant: Object.freeze([]),
    aborted: Object.freeze([]),
    expired: Object.freeze([]),
  }),
  handoff: Object.freeze({
    draft: Object.freeze(['ready', 'cancelled']),
    ready: Object.freeze(['acknowledged', 'declined', 'expired', 'cancelled']),
    acknowledged: Object.freeze(['completed', 'reopened']),
    reopened: Object.freeze(['ready', 'cancelled']),
    completed: Object.freeze([]),
    declined: Object.freeze([]),
    cancelled: Object.freeze([]),
    expired: Object.freeze([]),
  }),
  agent_question: Object.freeze({
    open: Object.freeze(['answered', 'stale', 'archived']),
    answered: Object.freeze(['stale', 'archived']),
    stale: Object.freeze(['archived']),
    archived: Object.freeze([]),
  }),
});

const VISIBILITIES = new Set(['project', 'restricted', 'owner_private']);
const REDACTION_CLASSES = new Set(['project_fact', 'project_notice', 'owner_private']);
const SOURCE_ACTOR_TYPES = new Set(['human', 'agent', 'runtime', 'adapter', 'system']);
const LEAD_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
const DISCOVERY_VERIFICATIONS = new Set(['unverified', 'verified', 'rejected']);
const SKILL_ACTION_CLASSES = new Set(['read_only', 'workspace_mutation', 'destructive', 'external_side_effect']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PRIVATE_KEY_PATTERN = /(?:^|_)(?:raw_?)?(?:prompt|chain_?of_?thought|transcript|terminal_?history|credential|secret|token|cookie|private_?key|provider_?session_?ref|environment_?values?|env_?values?)(?:$|_)/i;
const PRIVATE_KEY_EXACT = new Set(['env', 'environment', 'credentials', 'tokens', 'cookies', 'secrets']);
const ENV_ASSIGNMENT_PATTERNS = [
  /(?:^|[;&|]\s*|\s)(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^=]/,
  /(?:^|[;&|]\s*|\s)set\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/i,
  /\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/i,
];
const ENV_VALUE_DISCLOSURE_PATTERNS = [
  /(?:--?(?:token|secret|password|passwd|api[-_]?key|credential))(?:=|\s+)\S+/i,
  /(?:authorization|x-api-key)\s*:\s*\S+/i,
  /(?:https?|ssh):\/\/[^\s/@:]+:[^\s/@]+@/i,
];
const ENV_DUMP_PATTERN = /(?:^|\s)(?:printenv|set|env)(?:\s|$)|Get-ChildItem\s+Env:|(?:cat|type|Get-Content)\s+[^\r\n;&|]*\.env(?:\s|$)/i;
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /(?:^|[;&|]\s*|\s)(?:rm|rmdir|del|erase|Remove-Item)(?:\s|$)/i,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[^\s]*[fdx])/i,
  /\b(?:DROP|TRUNCATE)\s+(?:DATABASE|SCHEMA|TABLE)\b/i,
  /\bterraform\s+destroy\b/i,
  /\bkubectl\s+delete\b/i,
  /\bdocker\s+(?:system|volume|image|container)\s+prune\b/i,
];
const EXTERNAL_COMMAND_PATTERNS = [
  /(?:^|[;&|]\s*|\s)(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|ssh|scp|sftp)(?:\s|$)/i,
  /\bgit\s+push\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
  /\bdocker\s+push\b/i,
  /\bgh\s+(?:pr|issue|release|api)\s+(?:create|edit|close|merge|comment|upload)\b/i,
  /\b(?:aws|gcloud|az)\s+\S+/i,
  /\bkubectl\s+(?:apply|create|delete|patch|replace|scale|rollout|set)\b/i,
];

function policyError(code, detail = {}) {
  const error = new Error(code);
  error.code = code;
  error.status = 422;
  error.detail = detail;
  return error;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function requiredText(value, field, maxLength, { singleLine = false } = {}) {
  if (typeof value !== 'string') throw policyError(`knowledge_${field}_required`);
  const normalized = singleLine ? value.trim().replace(/\s+/g, ' ') : value.trim();
  if (!normalized) throw policyError(`knowledge_${field}_required`);
  if (normalized.length > maxLength) {
    throw policyError(`knowledge_${field}_too_long`, { maxLength });
  }
  if (normalized.includes('\u0000')) throw policyError(`knowledge_${field}_nul_forbidden`);
  return normalized;
}

function optionalText(value, field, maxLength, options = {}) {
  if (value == null || value === '') return null;
  return requiredText(value, field, maxLength, options);
}

function normalizeId(value, field, { required = true } = {}) {
  if (value == null || value === '') {
    if (!required) return null;
    throw policyError(`knowledge_${field}_required`);
  }
  const normalized = requiredText(String(value), field, KNOWLEDGE_REFERENCE_LIMITS.idLength, { singleLine: true });
  if (!ID_PATTERN.test(normalized)) throw policyError(`knowledge_${field}_invalid`);
  return normalized;
}

function normalizeKind(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  const kind = KIND_ALIASES.get(key);
  if (!kind) throw policyError('knowledge_kind_invalid', { allowedKinds: KNOWLEDGE_KINDS });
  return kind;
}

function normalizeStatus(kind, value) {
  const status = String(value || DEFAULT_STATUS[kind]).trim().toLowerCase().replace(/[ -]+/g, '_');
  if (!KNOWLEDGE_STATUSES[kind].includes(status)) {
    throw policyError('knowledge_status_invalid', { kind, allowedStatuses: KNOWLEDGE_STATUSES[kind] });
  }
  return status;
}

function normalizeConfidence(value, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw policyError('knowledge_confidence_required');
    return null;
  }
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw policyError('knowledge_confidence_invalid', { minimum: 0, maximum: 1 });
  }
  return confidence;
}

function normalizeIsoTimestamp(value, field) {
  if (value == null || value === '') return null;
  const input = requiredText(String(value), field, 64, { singleLine: true });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) {
    throw policyError(`knowledge_${field}_invalid`);
  }
  const timestamp = new Date(input);
  if (!Number.isFinite(timestamp.getTime())) throw policyError(`knowledge_${field}_invalid`);
  return timestamp.toISOString();
}

function uniqueNormalized(values, field, maxLength, normalizeValue) {
  const input = toArray(values);
  if (input.length > KNOWLEDGE_REFERENCE_LIMITS.perType) {
    throw policyError(`knowledge_${field}_limit_exceeded`, { limit: KNOWLEDGE_REFERENCE_LIMITS.perType });
  }
  const seen = new Set();
  const result = [];
  for (const value of input) {
    const normalized = normalizeValue(value, field, maxLength);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizePathReference(value, field, maxLength) {
  const raw = requiredText(String(value), field, maxLength, { singleLine: true });
  if (raw.includes('\u0000')) throw policyError('knowledge_reference_nul_forbidden', { field });
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\\\')) {
    throw policyError('knowledge_path_absolute_forbidden', { field });
  }
  const segments = raw.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw policyError('knowledge_path_traversal_forbidden', { field });
  }
  return segments.join('/');
}

function normalizeSemanticReference(value, field, maxLength) {
  const normalized = requiredText(String(value), field, maxLength, { singleLine: true });
  if (/\p{Cc}/u.test(normalized)) throw policyError('knowledge_reference_control_character_forbidden', { field });
  return normalized;
}

function normalizeOpaqueReference(value, field, maxLength) {
  const normalized = requiredText(String(value), field, maxLength, { singleLine: true });
  if (!ID_PATTERN.test(normalized)) throw policyError('knowledge_reference_id_invalid', { field });
  return normalized;
}

function referenceValue(references, input, canonicalKey, aliases) {
  for (const key of [canonicalKey, ...aliases]) {
    if (references?.[key] != null) return references[key];
  }
  for (const key of aliases) {
    if (input?.[key] != null) return input[key];
  }
  return [];
}

export function normalizeKnowledgeReferences(input = {}) {
  const references = input.references && typeof input.references === 'object' && !Array.isArray(input.references)
    ? input.references
    : {};
  const normalized = {
    paths: uniqueNormalized(
      referenceValue(references, input, 'paths', ['pathRefs', 'path_refs']),
      'path_references',
      KNOWLEDGE_REFERENCE_LIMITS.pathLength,
      normalizePathReference,
    ),
    symbols: uniqueNormalized(
      referenceValue(references, input, 'symbols', ['symbolRefs', 'symbol_refs']),
      'symbol_references',
      KNOWLEDGE_REFERENCE_LIMITS.semanticLength,
      normalizeSemanticReference,
    ),
    contracts: uniqueNormalized(
      referenceValue(references, input, 'contracts', ['contractRefs', 'contract_refs']),
      'contract_references',
      KNOWLEDGE_REFERENCE_LIMITS.semanticLength,
      normalizeSemanticReference,
    ),
    runtimeSessionIds: uniqueNormalized(
      referenceValue(references, input, 'runtimeSessionIds', ['runtimeIds', 'runtimeRefs', 'runtime_session_ids']),
      'runtime_session_references',
      KNOWLEDGE_REFERENCE_LIMITS.idLength,
      normalizeOpaqueReference,
    ),
    agentSessionIds: uniqueNormalized(
      referenceValue(references, input, 'agentSessionIds', ['sessionIds', 'sessionRefs', 'agent_session_ids']),
      'agent_session_references',
      KNOWLEDGE_REFERENCE_LIMITS.idLength,
      normalizeOpaqueReference,
    ),
    workstreamIds: uniqueNormalized(
      referenceValue(references, input, 'workstreamIds', ['workstreams', 'workstreamRefs', 'workstream_ids']),
      'workstream_references',
      KNOWLEDGE_REFERENCE_LIMITS.idLength,
      normalizeOpaqueReference,
    ),
    transactionIds: uniqueNormalized(
      referenceValue(references, input, 'transactionIds', ['transactions', 'transactionRefs', 'transaction_ids']),
      'transaction_references',
      KNOWLEDGE_REFERENCE_LIMITS.idLength,
      normalizeOpaqueReference,
    ),
  };
  const total = Object.values(normalized).reduce((sum, values) => sum + values.length, 0);
  if (total > KNOWLEDGE_REFERENCE_LIMITS.total) {
    throw policyError('knowledge_reference_total_limit_exceeded', { limit: KNOWLEDGE_REFERENCE_LIMITS.total });
  }
  return normalized;
}

function normalizedTextList(value, field, { limit = 32, maxLength = 256, allowEmpty = true } = {}) {
  const input = toArray(value);
  if (input.length > limit) throw policyError(`knowledge_${field}_limit_exceeded`, { limit });
  const result = [];
  const seen = new Set();
  for (const entry of input) {
    const normalized = requiredText(String(entry), field, maxLength, { singleLine: true });
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  if (!allowEmpty && result.length === 0) throw policyError(`knowledge_${field}_required`);
  return result;
}

function assertNoPrivateMaterial(value, path = 'item', seen = new Set()) {
  if (value == null || typeof value !== 'object') return;
  if (seen.has(value)) throw policyError('knowledge_cyclic_input_forbidden', { path });
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (PRIVATE_KEY_EXACT.has(normalizedKey) || PRIVATE_KEY_PATTERN.test(normalizedKey)) {
      throw policyError('knowledge_private_material_forbidden', { path: `${path}.${key}` });
    }
    assertNoPrivateMaterial(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function normalizeSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw policyError('knowledge_source_required');
  const actorType = String(value.actorType || value.actor_type || '').trim().toLowerCase();
  if (!SOURCE_ACTOR_TYPES.has(actorType)) {
    throw policyError('knowledge_source_actor_type_invalid', { allowedActorTypes: [...SOURCE_ACTOR_TYPES] });
  }
  return {
    actorType,
    actorId: normalizeId(value.actorId || value.actor_id, 'source_actor_id'),
    agentSessionId: normalizeId(value.agentSessionId || value.agent_session_id, 'source_agent_session_id', { required: false }),
    terminalSessionId: normalizeId(value.terminalSessionId || value.terminal_session_id, 'source_terminal_session_id', { required: false }),
  };
}

function referenceCount(references) {
  return Object.values(references).reduce((sum, values) => sum + values.length, 0);
}

function normalizeApprovals(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw policyError('knowledge_skill_approvals_invalid');
  const humanApproved = value.humanApproved === true || value.human_approved === true;
  const destructiveActions = value.destructiveActions === true || value.destructive_actions === true;
  const externalActions = value.externalActions === true || value.external_actions === true;
  const approvedByUserId = normalizeId(value.approvedByUserId || value.approved_by_user_id, 'skill_approved_by_user_id', { required: false });
  if ((destructiveActions || externalActions) && (!humanApproved || !approvedByUserId)) {
    throw policyError('knowledge_skill_human_approval_identity_required');
  }
  return { humanApproved, destructiveActions, externalActions, approvedByUserId };
}

function commandPolicy(command) {
  const withoutEnvironmentReferences = command.replace(
    /["']?(?:\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*|\$env:[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%)["']?/gi,
    '',
  );
  if (ENV_ASSIGNMENT_PATTERNS.some((pattern) => pattern.test(command))
    || ENV_VALUE_DISCLOSURE_PATTERNS.some((pattern) => pattern.test(withoutEnvironmentReferences))
    || ENV_DUMP_PATTERN.test(command)) {
    throw policyError('knowledge_skill_recipe_env_values_forbidden');
  }
  return {
    destructive: DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command)),
    external: EXTERNAL_COMMAND_PATTERNS.some((pattern) => pattern.test(command)),
  };
}

export function validateSharedSkillRecipe(recipe, { approvals = {} } = {}) {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) throw policyError('knowledge_skill_recipe_required');
  assertNoPrivateMaterial(recipe, 'recipe');
  if ((!Object.prototype.hasOwnProperty.call(recipe, 'requiredPermissions')
      && !Object.prototype.hasOwnProperty.call(recipe, 'required_permissions'))
    || (recipe.requiredPermissions == null && recipe.required_permissions == null)) {
    throw policyError('knowledge_skill_required_permissions_unknown');
  }
  const commands = normalizedTextList(recipe.commands, 'skill_commands', {
    limit: 32,
    maxLength: 1024,
    allowEmpty: false,
  });
  const requiredPermissions = normalizedTextList(
    recipe.requiredPermissions || recipe.required_permissions || [],
    'skill_required_permissions',
    { limit: 32, maxLength: 128 },
  );
  const requiredTools = normalizedTextList(recipe.requiredTools || recipe.required_tools || [], 'skill_required_tools', {
    limit: 32,
    maxLength: 128,
  });
  const requiredEnvironmentKeys = normalizedTextList(
    recipe.requiredEnvironmentKeys || recipe.required_environment_keys || [],
    'skill_required_environment_keys',
    { limit: 32, maxLength: 128 },
  );
  if (requiredEnvironmentKeys.some((key) => !ENVIRONMENT_KEY_PATTERN.test(key))) {
    throw policyError('knowledge_skill_environment_key_invalid');
  }
  const usageConditions = normalizedTextList(recipe.usageConditions || recipe.usage_conditions, 'skill_usage_conditions', {
    limit: 32,
    maxLength: 512,
    allowEmpty: false,
  });
  const workingDirectory = optionalText(
    recipe.workingDirectory || recipe.working_directory,
    'skill_working_directory',
    KNOWLEDGE_REFERENCE_LIMITS.pathLength,
    { singleLine: true },
  );
  const normalizedWorkingDirectory = workingDirectory
    ? normalizePathReference(workingDirectory, 'skill_working_directory', KNOWLEDGE_REFERENCE_LIMITS.pathLength)
    : null;
  const declaredActionClass = String(recipe.actionClass || recipe.action_class || 'read_only').trim().toLowerCase();
  if (!SKILL_ACTION_CLASSES.has(declaredActionClass)) {
    throw policyError('knowledge_skill_action_class_invalid', { allowedActionClasses: [...SKILL_ACTION_CLASSES] });
  }
  const classifications = commands.map(commandPolicy);
  const destructive = declaredActionClass === 'destructive' || classifications.some((entry) => entry.destructive);
  const external = declaredActionClass === 'external_side_effect' || classifications.some((entry) => entry.external);
  const normalizedApprovals = normalizeApprovals(approvals);
  if (destructive && !(normalizedApprovals.humanApproved && normalizedApprovals.destructiveActions)) {
    throw policyError('knowledge_skill_destructive_action_requires_human_approval');
  }
  if (external && !(normalizedApprovals.humanApproved && normalizedApprovals.externalActions)) {
    throw policyError('knowledge_skill_external_action_requires_human_approval');
  }
  return {
    commands,
    requiredPermissions,
    requiredTools,
    requiredEnvironmentKeys,
    usageConditions,
    workingDirectory: normalizedWorkingDirectory,
    actionClass: destructive ? 'destructive' : external ? 'external_side_effect' : declaredActionClass,
    destructive,
    external,
    approvals: normalizedApprovals,
  };
}

function normalizeCommon(input, kind) {
  const visibility = String(input.visibility || 'project').trim().toLowerCase();
  if (!VISIBILITIES.has(visibility)) throw policyError('knowledge_visibility_invalid');
  const defaultRedactionClass = visibility === 'owner_private' ? 'owner_private' : kind === 'impact_notice' ? 'project_notice' : 'project_fact';
  const redactionClass = String(input.redactionClass || input.redaction_class || defaultRedactionClass).trim().toLowerCase();
  if (!REDACTION_CLASSES.has(redactionClass)) throw policyError('knowledge_redaction_class_invalid');
  if (visibility === 'owner_private' && redactionClass !== 'owner_private') {
    throw policyError('knowledge_private_visibility_redaction_mismatch');
  }
  const references = normalizeKnowledgeReferences(input);
  if (referenceCount(references) === 0) throw policyError('knowledge_references_required');
  return {
    id: normalizeId(input.id, 'id', { required: false }),
    kind,
    projectId: normalizeId(input.projectId || input.project_id, 'project_id'),
    title: requiredText(input.title, 'title', 160, { singleLine: true }),
    summary: requiredText(input.summary || input.statement || input.description, 'summary', 4096),
    status: normalizeStatus(kind, input.status),
    visibility,
    redactionClass,
    source: normalizeSource(input.source),
    references,
    evidenceRefs: normalizedTextList(input.evidenceRefs || input.evidence_refs || [], 'evidence_references', {
      limit: 64,
      maxLength: 512,
    }),
    tags: normalizedTextList(input.tags || [], 'tags', { limit: 32, maxLength: 64 }),
    confidence: normalizeConfidence(input.confidence, { required: kind === 'discovery' || kind === 'lead' }),
    createdAt: normalizeIsoTimestamp(input.createdAt || input.created_at, 'created_at'),
    updatedAt: normalizeIsoTimestamp(input.updatedAt || input.updated_at, 'updated_at'),
    expiresAt: normalizeIsoTimestamp(input.expiresAt || input.expires_at, 'expires_at'),
  };
}

function normalizeDiscovery(input, common) {
  if (common.evidenceRefs.length === 0) throw policyError('knowledge_discovery_evidence_required');
  const verification = String(input.verification || (common.status === 'verified' ? 'verified' : 'unverified')).trim().toLowerCase();
  if (!DISCOVERY_VERIFICATIONS.has(verification)) throw policyError('knowledge_discovery_verification_invalid');
  return {
    ...common,
    verification,
  };
}

function normalizeLead(input, common) {
  const priority = String(input.priority || 'medium').trim().toLowerCase();
  if (!LEAD_PRIORITIES.has(priority)) throw policyError('knowledge_lead_priority_invalid');
  return {
    ...common,
    priority,
    ownerUserId: normalizeId(input.ownerUserId || input.owner_user_id, 'lead_owner_user_id', { required: false }),
    ownerAgentSessionId: normalizeId(input.ownerAgentSessionId || input.owner_agent_session_id, 'lead_owner_agent_session_id', { required: false }),
  };
}

function normalizeSharedSkill(input, common) {
  if (common.evidenceRefs.length === 0) throw policyError('knowledge_skill_evidence_required');
  const skillKey = normalizeId(input.skillKey || input.skill_key || input.name, 'skill_key');
  const recipe = validateSharedSkillRecipe(input.recipe, { approvals: input.approvals || {} });
  if (common.status === 'published' && common.visibility !== 'project' && common.visibility !== 'restricted') {
    throw policyError('knowledge_skill_published_visibility_invalid');
  }
  return { ...common, skillKey, recipe };
}

function normalizeImpactNotice(input, common) {
  const recipientAgentSessionIds = normalizedTextList(
    input.recipientAgentSessionIds || input.recipient_agent_session_ids,
    'impact_recipient_agent_session_ids',
    { limit: 64, maxLength: KNOWLEDGE_REFERENCE_LIMITS.idLength, allowEmpty: false },
  ).map((value) => normalizeId(value, 'impact_recipient_agent_session_id'));
  return {
    ...common,
    sourceKnowledgeId: normalizeId(input.sourceKnowledgeId || input.source_knowledge_id, 'impact_source_knowledge_id'),
    recipientAgentSessionIds,
    requiresResponse: input.requiresResponse !== false && input.requires_response !== false,
    responseAction: optionalText(input.responseAction || input.response_action, 'impact_response_action', 512),
  };
}

function normalizeHandoff(input, common) {
  if (common.evidenceRefs.length === 0) throw policyError('knowledge_handoff_evidence_required');
  return {
    ...common,
    fromAgentSessionId: normalizeId(input.fromAgentSessionId || input.from_agent_session_id, 'handoff_from_agent_session_id'),
    toAgentSessionId: normalizeId(input.toAgentSessionId || input.to_agent_session_id, 'handoff_to_agent_session_id'),
    unresolvedRisks: normalizedTextList(input.unresolvedRisks || input.unresolved_risks || [], 'handoff_unresolved_risks', {
      limit: 32,
      maxLength: 512,
    }),
    requiredActions: normalizedTextList(input.requiredActions || input.required_actions || [], 'handoff_required_actions', {
      limit: 32,
      maxLength: 512,
    }),
  };
}

const QUESTION_URGENCIES = new Set(['low', 'normal', 'high']);

function normalizeAgentQuestion(input, common) {
  const urgency = String(input.urgency || 'normal').trim().toLowerCase();
  if (!QUESTION_URGENCIES.has(urgency)) throw policyError('knowledge_question_urgency_invalid', { allowedUrgencies: [...QUESTION_URGENCIES] });
  const suggested = (input.suggestedExpertAgentSessionIds || input.suggested_expert_agent_session_ids) == null
    ? []
    : normalizedTextList(
      input.suggestedExpertAgentSessionIds || input.suggested_expert_agent_session_ids,
      'question_suggested_expert_agent_session_ids',
      { limit: 8, maxLength: KNOWLEDGE_REFERENCE_LIMITS.idLength, allowEmpty: true },
    ).map((value) => normalizeId(value, 'question_suggested_expert_agent_session_id'));
  if (!suggested.length && !input.skipSuggestionValidation && input.allowUnrouted !== true) {
    // A question with no suggested expert and no explicit unrouted flag is a
    // broadcast in disguise; refuse it rather than spamming every peer.
    throw policyError('knowledge_question_experts_or_unrouted_required');
  }
  return {
    ...common,
    questionUrgency: urgency,
    suggestedExpertAgentSessionIds: [...new Set(suggested)],
    // Stored rows carry answerText/answeredByAgentSessionId once answered;
    // preserve them through projection re-validation instead of resetting.
    answerText: optionalText(input.answerText || input.answer_text, 'question_answer_text', 4096),
    answeredByAgentSessionId: normalizeId(
      input.answeredByAgentSessionId || input.answered_by_agent_session_id,
      'question_answered_by_agent_session_id',
      { required: false },
    ),
  };
}

export function validateKnowledgeItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw policyError('knowledge_item_invalid');
  assertNoPrivateMaterial(input);
  const kind = normalizeKind(input.kind || input.type);
  const common = normalizeCommon(input, kind);
  if (kind === 'discovery') return normalizeDiscovery(input, common);
  if (kind === 'lead') return normalizeLead(input, common);
  if (kind === 'shared_skill') return normalizeSharedSkill(input, common);
  if (kind === 'impact_notice') return normalizeImpactNotice(input, common);
  if (kind === 'agent_question') return normalizeAgentQuestion(input, common);
  return normalizeHandoff(input, common);
}

export function allowedKnowledgeTransitions(kindInput, statusInput) {
  const kind = normalizeKind(kindInput);
  const status = normalizeStatus(kind, statusInput);
  return [...STATUS_TRANSITIONS[kind][status]];
}

export function transitionKnowledgeItem(input, nextStatusInput, context = {}) {
  const item = validateKnowledgeItem(input);
  const nextStatus = normalizeStatus(item.kind, nextStatusInput);
  if (nextStatus === item.status) return item;
  const allowed = STATUS_TRANSITIONS[item.kind][item.status];
  if (!allowed.includes(nextStatus)) {
    throw policyError('knowledge_status_transition_forbidden', {
      kind: item.kind,
      from: item.status,
      to: nextStatus,
      allowed,
    });
  }
  const actorId = normalizeId(context.actorId || context.actor_id, 'transition_actor_id');
  const reason = requiredText(context.reason, 'transition_reason', 1024);
  const evidenceRefs = normalizedTextList(context.evidenceRefs || context.evidence_refs || [], 'transition_evidence_references', {
    limit: 32,
    maxLength: 512,
  });
  const at = normalizeIsoTimestamp(context.at, 'transition_at');
  return {
    ...item,
    status: nextStatus,
    updatedAt: at || item.updatedAt,
    transition: {
      from: item.status,
      to: nextStatus,
      actorId,
      reason,
      evidenceRefs,
      at,
    },
  };
}

function safeSource(source) {
  return {
    actorType: source.actorType,
    actorId: source.actorId,
    agentSessionId: source.agentSessionId,
    terminalSessionId: source.terminalSessionId,
  };
}

export function safeKnowledgeProjection(input) {
  const item = validateKnowledgeItem(input);
  const base = {
    id: item.id,
    kind: item.kind,
    projectId: item.projectId,
    title: item.title,
    summary: item.summary,
    status: item.status,
    visibility: item.visibility,
    redactionClass: item.redactionClass,
    source: safeSource(item.source),
    references: item.references,
    evidenceRefs: item.evidenceRefs,
    tags: item.tags,
    confidence: item.confidence,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt,
  };
  if (item.kind === 'discovery') return { ...base, verification: item.verification };
  if (item.kind === 'lead') {
    return {
      ...base,
      priority: item.priority,
      ownerUserId: item.ownerUserId,
      ownerAgentSessionId: item.ownerAgentSessionId,
    };
  }
  if (item.kind === 'shared_skill') return { ...base, skillKey: item.skillKey, recipe: item.recipe };
  if (item.kind === 'impact_notice') {
    return {
      ...base,
      sourceKnowledgeId: item.sourceKnowledgeId,
      recipientAgentSessionIds: item.recipientAgentSessionIds,
      requiresResponse: item.requiresResponse,
      responseAction: item.responseAction,
    };
  }
  if (item.kind === 'agent_question') {
    return {
      ...base,
      questionUrgency: item.questionUrgency,
      suggestedExpertAgentSessionIds: item.suggestedExpertAgentSessionIds,
      fromAgentSessionId: item.source?.agentSessionId || null,
      answerText: item.answerText,
      answeredByAgentSessionId: item.answeredByAgentSessionId,
    };
  }
  return {
    ...base,
    fromAgentSessionId: item.fromAgentSessionId,
    toAgentSessionId: item.toAgentSessionId,
    unresolvedRisks: item.unresolvedRisks,
    requiredActions: item.requiredActions,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function knowledgeDedupeKey(input) {
  const item = safeKnowledgeProjection(input);
  const identity = {
    kind: item.kind,
    projectId: item.projectId,
    title: item.title.toLowerCase(),
    summary: item.summary,
    references: item.references,
  };
  if (item.kind === 'shared_skill') {
    identity.skillKey = item.skillKey;
    identity.commands = Object.fromEntries(item.recipe.commands.map((command, index) => [String(index), command]));
  } else if (item.kind === 'impact_notice') {
    identity.sourceKnowledgeId = item.sourceKnowledgeId;
    identity.recipientAgentSessionIds = item.recipientAgentSessionIds;
  } else if (item.kind === 'handoff') {
    identity.fromAgentSessionId = item.fromAgentSessionId;
    identity.toAgentSessionId = item.toAgentSessionId;
  } else if (item.kind === 'agent_question') {
    // Questions dedupe on asker + references so a re-ask of the identical
    // question (even after an answer) returns the existing thread instead of
    // spawning duplicate notifications.
    identity.fromAgentSessionId = item.source?.agentSessionId || null;
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex');
  return `knowledge:${item.kind}:${digest}`;
}
