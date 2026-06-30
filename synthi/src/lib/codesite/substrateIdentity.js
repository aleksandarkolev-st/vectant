const DEFAULT_REF_MAX_LENGTH = 255;
const DEFAULT_EVIDENCE_REF_LIMIT = 32;

export function normalizeCodeSiteRef(value, maxLength = DEFAULT_REF_MAX_LENGTH) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

export function firstCodeSiteRef(...values) {
  for (const value of values) {
    const ref = normalizeCodeSiteRef(value);
    if (ref) return ref;
  }
  return null;
}

export function normalizeCodeSiteEvidenceRefs(value, options = {}) {
  const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
    ? options.maxItems
    : DEFAULT_EVIDENCE_REF_LIMIT;
  const maxLength = Number.isInteger(options.maxLength) && options.maxLength > 0
    ? options.maxLength
    : DEFAULT_REF_MAX_LENGTH;
  if (!Array.isArray(value)) return [];
  const refs = [];
  const seen = new Set();
  for (const item of value) {
    const ref = normalizeCodeSiteRef(item, maxLength);
    if (!ref || seen.has(ref)) continue;
    refs.push(ref);
    seen.add(ref);
    if (refs.length >= maxItems) break;
  }
  return refs;
}

export function codeSiteEvidenceRefsJson(value, options = {}) {
  return JSON.stringify(normalizeCodeSiteEvidenceRefs(value, options));
}

export function normalizeCodeSiteContext(value) {
  const context = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    projectId: firstCodeSiteRef(context.codeSiteProjectId, context.projectId),
    transactionId: firstCodeSiteRef(context.codeSiteTransactionId, context.transactionId),
    mutationLeaseId: firstCodeSiteRef(context.codeSiteMutationLeaseId, context.mutationLeaseId, context.leaseId),
    agentSessionId: firstCodeSiteRef(context.codeSiteAgentSessionId, context.agentSessionId),
    evidenceRefs: normalizeCodeSiteEvidenceRefs(context.codeSiteEvidenceRefs || context.evidenceRefs),
  };
}

export function emptyCodeSiteIdentityFields({ evidenceJson = null } = {}) {
  return {
    codeSiteProjectId: null,
    codeSiteTransactionId: null,
    codeSiteMutationLeaseId: null,
    codeSiteAgentSessionId: null,
    codeSiteEvidenceRefsJson: evidenceJson,
  };
}
