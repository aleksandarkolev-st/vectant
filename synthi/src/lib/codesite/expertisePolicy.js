const DAY_MS = 24 * 60 * 60 * 1000;

export const EXPERTISE_POLICY_VERSION = 'synthi.codesite.expertise-policy.v1';

export const EXPERTISE_POLICY = Object.freeze({
  version: EXPERTISE_POLICY_VERSION,
  contextVersion: 'synthi.codesite.expertise.v1',
  scoring: Object.freeze({
    recencyHalfLifeMs: 14 * DAY_MS,
    defaultSignalWeight: 1,
    signalWeights: Object.freeze({
      transaction_write: 3,
      transaction_read: 2,
      knowledge_reference: 2,
      plan_route: 1.5,
      knowledge_authorship: 1,
    }),
  }),
  limits: Object.freeze({
    defaultLimit: 5,
    maxLimit: 10,
    maxReferencesPerType: 32,
    maxEvidencePerExpert: 16,
    suggestionLimit: 3,
  }),
  cache: Object.freeze({
    ttlMs: 15 * 1000,
    maxEntries: 64,
  }),
  statuses: Object.freeze({
    eligibleSession: Object.freeze(['attached', 'detached']),
    activePlan: Object.freeze(['filed', 'active', 'holding', 'blocked']),
    activeTransaction: Object.freeze(['open', 'prepared', 'blocked', 'validated']),
    signalKnowledgeKinds: Object.freeze(['discovery', 'lead', 'shared_skill', 'handoff', 'agent_question']),
  }),
});

function finiteNumber(value, fallback, { minimum = Number.NEGATIVE_INFINITY } = {}) {
  return Number.isFinite(Number(value)) && Number(value) >= minimum ? Number(value) : fallback;
}

function boundedInteger(value, fallback, { minimum, maximum }) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, minimum), maximum);
}

function stringList(value, fallback) {
  return Array.isArray(value) && value.length ? [...new Set(value.map(String))] : [...fallback];
}

/**
 * Resolve a trusted, versioned policy without letting partial configuration
 * replace the safety defaults. Runtime callers may provide a deployment-owned
 * override; agent input is never used as policy configuration.
 */
export function resolveExpertisePolicy(input = EXPERTISE_POLICY) {
  if (!input || typeof input !== 'object') return EXPERTISE_POLICY;
  if (input === EXPERTISE_POLICY) return EXPERTISE_POLICY;

  const scoringInput = input.scoring && typeof input.scoring === 'object' ? input.scoring : {};
  const limitsInput = input.limits && typeof input.limits === 'object' ? input.limits : {};
  const cacheInput = input.cache && typeof input.cache === 'object' ? input.cache : {};
  const statusesInput = input.statuses && typeof input.statuses === 'object' ? input.statuses : {};
  const maxLimit = boundedInteger(limitsInput.maxLimit, EXPERTISE_POLICY.limits.maxLimit, { minimum: 1, maximum: 100 });
  const defaultLimit = boundedInteger(
    limitsInput.defaultLimit,
    EXPERTISE_POLICY.limits.defaultLimit,
    { minimum: 1, maximum: maxLimit },
  );
  const maxReferencesPerType = boundedInteger(
    limitsInput.maxReferencesPerType,
    EXPERTISE_POLICY.limits.maxReferencesPerType,
    { minimum: 1, maximum: 256 },
  );
  const maxEvidencePerExpert = boundedInteger(
    limitsInput.maxEvidencePerExpert,
    EXPERTISE_POLICY.limits.maxEvidencePerExpert,
    { minimum: 1, maximum: 128 },
  );
  const suggestionLimit = boundedInteger(
    limitsInput.suggestionLimit,
    EXPERTISE_POLICY.limits.suggestionLimit,
    { minimum: 1, maximum: maxLimit },
  );
  const signalWeightsInput = scoringInput.signalWeights && typeof scoringInput.signalWeights === 'object'
    ? scoringInput.signalWeights
    : {};

  return Object.freeze({
    version: typeof input.version === 'string' && input.version.trim()
      ? input.version.trim()
      : EXPERTISE_POLICY.version,
    contextVersion: typeof input.contextVersion === 'string' && input.contextVersion.trim()
      ? input.contextVersion.trim()
      : EXPERTISE_POLICY.contextVersion,
    scoring: Object.freeze({
      recencyHalfLifeMs: finiteNumber(
        scoringInput.recencyHalfLifeMs,
        EXPERTISE_POLICY.scoring.recencyHalfLifeMs,
        { minimum: 1 },
      ),
      defaultSignalWeight: finiteNumber(
        scoringInput.defaultSignalWeight,
        EXPERTISE_POLICY.scoring.defaultSignalWeight,
        { minimum: 0 },
      ),
      signalWeights: Object.freeze({
        ...EXPERTISE_POLICY.scoring.signalWeights,
        ...Object.fromEntries(
          Object.entries(signalWeightsInput)
            .filter(([, value]) => Number.isFinite(Number(value)))
            .map(([key, value]) => [key, Number(value)]),
        ),
      }),
    }),
    limits: Object.freeze({
      defaultLimit,
      maxLimit,
      maxReferencesPerType,
      maxEvidencePerExpert,
      suggestionLimit,
    }),
    cache: Object.freeze({
      ttlMs: finiteNumber(cacheInput.ttlMs, EXPERTISE_POLICY.cache.ttlMs, { minimum: 1 }),
      maxEntries: boundedInteger(cacheInput.maxEntries, EXPERTISE_POLICY.cache.maxEntries, { minimum: 1, maximum: 1024 }),
    }),
    statuses: Object.freeze({
      eligibleSession: Object.freeze(stringList(statusesInput.eligibleSession, EXPERTISE_POLICY.statuses.eligibleSession)),
      activePlan: Object.freeze(stringList(statusesInput.activePlan, EXPERTISE_POLICY.statuses.activePlan)),
      activeTransaction: Object.freeze(stringList(statusesInput.activeTransaction, EXPERTISE_POLICY.statuses.activeTransaction)),
      signalKnowledgeKinds: Object.freeze(stringList(statusesInput.signalKnowledgeKinds, EXPERTISE_POLICY.statuses.signalKnowledgeKinds)),
    }),
  });
}
