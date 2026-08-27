import { asArray, parseJson } from './json';
import { EXPERTISE_POLICY, resolveExpertisePolicy } from './expertisePolicy';
import { isKnowledgeExpertiseEligible } from './knowledgePolicy';
import { knowledgePathsOverlap } from './knowledgeRouting';

// Derived, evidence-weighted expertise. Nothing here is provider-aware and
// nothing is hand-authored: every signal comes from control-plane records the
// agents themselves produced (transactions, flight plans, shared knowledge).
export const EXPERTISE_CONTEXT_VERSION = EXPERTISE_POLICY.contextVersion;
export const EXPERTISE_SIGNAL_WEIGHTS = EXPERTISE_POLICY.scoring.signalWeights;
export const EXPERTISE_RECENCY_HALF_LIFE_MS = EXPERTISE_POLICY.scoring.recencyHalfLifeMs;
export const EXPERTISE_DEFAULT_LIMIT = EXPERTISE_POLICY.limits.defaultLimit;
export const EXPERTISE_MAX_LIMIT = EXPERTISE_POLICY.limits.maxLimit;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function emptyReferences() {
  return {
    paths: [],
    symbols: [],
    contracts: [],
    runtimeSessionIds: [],
    agentSessionIds: [],
    workstreamIds: [],
    transactionIds: [],
  };
}

function jsonList(value) {
  return asArray(parseJson(typeof value === 'string' ? value : null, []));
}

function timestampMs(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeExpertiseQuery(query = {}, policy = EXPERTISE_POLICY) {
  const config = resolveExpertisePolicy(policy);
  const maxReferencesPerType = config.limits.maxReferencesPerType;
  const rawPaths = asArray(query.paths ?? query.path);
  const rawSymbols = asArray(query.symbols ?? query.symbol);
  const rawContracts = asArray(query.contracts ?? query.contract);
  if (rawPaths.length > maxReferencesPerType
    || rawSymbols.length > maxReferencesPerType
    || rawContracts.length > maxReferencesPerType) {
    throw Object.assign(new Error('expertise_query_limit_exceeded'), { code: 'expertise_query_limit_exceeded', status: 422 });
  }
  const paths = unique(rawPaths.map((value) => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim()).filter(Boolean));
  const symbols = unique(rawSymbols.map((value) => String(value || '').trim()).filter(Boolean));
  const contracts = unique(rawContracts.map((value) => String(value || '').trim()).filter(Boolean));
  if (paths.length > maxReferencesPerType
    || symbols.length > maxReferencesPerType
    || contracts.length > maxReferencesPerType) {
    throw Object.assign(new Error('expertise_query_limit_exceeded'), { code: 'expertise_query_limit_exceeded', status: 422 });
  }
  const limitValue = Number(query.limit ?? config.limits.defaultLimit);
  const limit = Number.isFinite(limitValue)
    ? Math.min(Math.max(Math.floor(limitValue), 1), config.limits.maxLimit)
    : config.limits.defaultLimit;
  if (!paths.length && !symbols.length && !contracts.length) {
    throw Object.assign(new Error('expertise_query_refs_required'), { code: 'expertise_query_refs_required', status: 422 });
  }
  return { paths, symbols, contracts, limit };
}

export function transactionExpertiseRefs(transaction = {}) {
  const semantic = [];
  for (const entry of [
    ...jsonList(transaction.semanticDependencyRefsJson),
    ...asArray(transaction.semanticDependencyRefs),
  ]) {
    if (typeof entry === 'string') {
      const [type, ...rest] = entry.split(':');
      const value = rest.join(':');
      if (type === 'symbol' && value) semantic.push({ symbol: value });
      else if (value) semantic.push({ contract: type === 'contract' ? value : entry });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const type = String(entry.type || entry.refType || '').toLowerCase();
    const key = String(entry.key || entry.value || entry.refKey || '');
    if (!key) continue;
    if (type === 'symbol') semantic.push({ symbol: key });
    else semantic.push({ contract: key });
  }
  return {
    read: unique([
      ...jsonList(transaction.readSetJson),
      ...jsonList(transaction.observedReadSetJson),
    ]),
    write: unique([
      ...jsonList(transaction.writeSetJson),
      ...jsonList(transaction.observedWriteSetJson),
    ]),
    symbols: unique(semantic.map((ref) => ref.symbol)),
    contracts: unique(semantic.map((ref) => ref.contract)),
  };
}

function pushSignal(signals, signal) {
  if (!signal.sessionId) return;
  signals.push(signal);
}

function recencyMultiplier(ageMs, halfLifeMs = EXPERTISE_RECENCY_HALF_LIFE_MS) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0.5;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

function anyPathOverlap(leftPaths, rightPaths) {
  return leftPaths.some((first) => rightPaths.some((second) => knowledgePathsOverlap(first, second)));
}

/**
 * Derive a per-session expertise signal list from durable control-plane state.
 * Accepts plain rows (Prisma shapes) or pre-parsed objects; JSON string fields
 * and array fields are both handled.
 */
export function buildExpertiseIndex({
  executionPlans = [],
  transactions = [],
  knowledgeItems = [],
  feedbackEvents = [],
  now = new Date(),
  policy = EXPERTISE_POLICY,
} = {}) {
  const config = resolveExpertisePolicy(policy);
  const eligibleSessionStatuses = new Set(config.statuses.eligibleSession);
  const activePlanStatuses = new Set(config.statuses.activePlan);
  const activeTransactionStatuses = new Set(config.statuses.activeTransaction);
  const signalKnowledgeKinds = new Set(config.statuses.signalKnowledgeKinds);
  const nowMs = timestampMs(now) ?? Date.now();
  const signalsBySession = new Map();

  const addSignal = (sessionId, signal) => {
    if (!signalsBySession.has(sessionId)) signalsBySession.set(sessionId, []);
    signalsBySession.get(sessionId).push({ ...signal, ageMs: Math.max(nowMs - (signal.atMs ?? nowMs), 0) });
  };

  for (const plan of executionPlans) {
    if (!activePlanStatuses.has(String(plan.status || ''))) continue;
    const atMs = timestampMs(plan.filedAt) ?? nowMs;
    const routes = (asArray(plan.route || jsonList(plan.routeJson)))
      .map((value) => (typeof value === 'string' ? value : value?.path || value?.pattern))
      .filter(Boolean);
    if (plan.agentSessionId && routes.length) {
      addSignal(plan.agentSessionId, {
        type: 'plan_route',
        weightSource: 'plan_route',
        paths: routes,
        symbols: [],
        contracts: [],
        ref: plan.id,
        atMs,
      });
    }
  }

  for (const transaction of transactions) {
    if (!activeTransactionStatuses.has(String(transaction.status || ''))) continue;
    const refs = transactionExpertiseRefs(transaction);
    const atMs = timestampMs(transaction.openedAt) ?? nowMs;
    if (refs.write.length) {
      addSignal(transaction.agentSessionId, {
        type: 'transaction_write',
        weightSource: 'transaction_write',
        paths: refs.write,
        symbols: [],
        contracts: [],
        ref: transaction.id,
        atMs,
      });
    }
    if (refs.read.length) {
      addSignal(transaction.agentSessionId, {
        type: 'transaction_read',
        weightSource: 'transaction_read',
        paths: refs.read,
        symbols: [],
        contracts: [],
        ref: transaction.id,
        atMs,
      });
    }
    if (refs.symbols.length || refs.contracts.length) {
      addSignal(transaction.agentSessionId, {
        type: 'transaction_semantic',
        weightSource: 'transaction_write',
        paths: [],
        symbols: refs.symbols,
        contracts: refs.contracts,
        ref: transaction.id,
        atMs,
      });
    }
  }

  for (const itemRow of knowledgeItems) {
    const kind = String(itemRow.kind || '');
    if (!signalKnowledgeKinds.has(kind)) continue;
    if (!isKnowledgeExpertiseEligible(itemRow)) continue;
    const references = itemRow.references || parseJson(itemRow.scopeJson, {})?.references || {};
    const paths = unique(asArray(references.paths));
    const symbols = unique(asArray(references.symbols));
    const contracts = unique(asArray(references.contracts));
    if (!paths.length && !symbols.length && !contracts.length) continue;
    const atMs = timestampMs(itemRow.updatedAt) ?? nowMs;
    const payload = parseJson(itemRow.payloadJson, {});
    const knowledgeAgentSessionId = kind === 'agent_question'
      ? (itemRow.answeredByAgentSessionId || payload?.answeredByAgentSessionId)
      : itemRow.createdByAgentSessionId;
    if (knowledgeAgentSessionId) {
      addSignal(knowledgeAgentSessionId, {
        type: kind === 'agent_question' ? 'knowledge_answer' : 'knowledge_authorship',
        weightSource: 'knowledge_authorship',
        paths,
        symbols,
        contracts,
        ref: itemRow.id,
        atMs,
      });
    }
    for (const sessionId of unique(asArray(references.agentSessionIds))) {
      if (sessionId === knowledgeAgentSessionId) continue;
      addSignal(sessionId, {
        type: 'knowledge_reference',
        weightSource: 'knowledge_reference',
        paths,
        symbols,
        contracts,
        ref: itemRow.id,
        atMs,
      });
    }
  }

  // Feedback changes the usefulness signal for an answered question without
  // granting expertise to an asker or to a human reviewer. Feedback is read
  // from the existing event log, so this index does not require a second
  // materialized table. Only an agent who actually answered an eligible
  // question receives the feedback signal.
  const knowledgeById = new Map(knowledgeItems.map((item) => [item.id, item]));
  const latestFeedbackByReviewer = new Map();
  for (const feedbackEvent of feedbackEvents) {
    if (feedbackEvent?.eventType !== 'agent_question_feedback_submitted') continue;
    const details = feedbackEvent.details || parseJson(feedbackEvent.detailsJson, {});
    const questionId = details.knowledgeItemId || details.questionId;
    const reviewerKey = `${feedbackEvent.actorType || 'unknown'}:${feedbackEvent.actorId || 'unknown'}`;
    const latestKey = `${questionId || 'unknown'}:${reviewerKey}`;
    const previous = latestFeedbackByReviewer.get(latestKey);
    const currentMs = timestampMs(feedbackEvent.createdAt) ?? nowMs;
    if (previous && previous.atMs >= currentMs) continue;
    latestFeedbackByReviewer.set(latestKey, {
      event: feedbackEvent,
      details,
      atMs: currentMs,
    });
  }
  for (const { event: feedbackEvent, details, atMs } of latestFeedbackByReviewer.values()) {
    const itemRow = knowledgeById.get(details.knowledgeItemId || details.questionId);
    if (!itemRow || itemRow.kind !== 'agent_question' || !isKnowledgeExpertiseEligible(itemRow)) continue;
    const payload = parseJson(itemRow.payloadJson, {});
    const answererSessionId = itemRow.answeredByAgentSessionId || payload?.answeredByAgentSessionId;
    if (!answererSessionId) continue;
    const verdict = String(details.verdict || '').trim().toLowerCase();
    const weightSource = `knowledge_feedback_${verdict}`;
    if (!Object.prototype.hasOwnProperty.call(config.scoring.signalWeights, weightSource)) continue;
    const references = itemRow.references || parseJson(itemRow.scopeJson, {})?.references || {};
    const paths = unique(asArray(references.paths));
    const symbols = unique(asArray(references.symbols));
    const contracts = unique(asArray(references.contracts));
    if (!paths.length && !symbols.length && !contracts.length) continue;
    addSignal(answererSessionId, {
      type: `knowledge_feedback:${verdict}`,
      weightSource,
      paths,
      symbols,
      contracts,
      ref: feedbackEvent.id,
      atMs,
    });
  }

  return { nowMs, signalsBySession, policy: config };
}

/**
 * Rank eligible peer sessions against a normalized query using the index.
 * Deterministic: score desc, then session id asc. The requesting session and
 * ended/inactive peers are never returned.
 */
export function rankExperts(index, query, {
  sessions = [],
  excludeSessionId = null,
  limit,
  policy = null,
} = {}) {
  const config = resolveExpertisePolicy(policy || index?.policy || EXPERTISE_POLICY);
  const eligibleSessionStatuses = new Set(config.statuses.eligibleSession);
  const normalizedLimit = Number.isFinite(Number(limit))
    ? Math.min(Math.max(Math.floor(Number(limit)), 1), config.limits.maxLimit)
    : config.limits.defaultLimit;
  const results = [];

  for (const session of sessions) {
    if (!session || session.endedAt) continue;
    if (!eligibleSessionStatuses.has(String(session.status || '').toLowerCase())) continue;
    if (session.id === excludeSessionId) continue;

    const signals = index.signalsBySession.get(session.id) || [];
    let score = 0;
    const evidence = [];
    let lastMatchMs = null;

    for (const signal of signals) {
      const pathMatch = query.paths.length && signal.paths.length && anyPathOverlap(query.paths, signal.paths);
      const symbolMatch = query.symbols.length && Boolean(signal.symbols.length && query.symbols.some((symbol) => signal.symbols.includes(symbol)));
      const contractMatch = query.contracts.length && Boolean(signal.contracts.length && query.contracts.some((contract) => signal.contracts.includes(contract)));
      if (!pathMatch && !symbolMatch && !contractMatch) continue;
      const weight = config.scoring.signalWeights[signal.weightSource] ?? config.scoring.defaultSignalWeight;
      const recency = recencyMultiplier(signal.ageMs, config.scoring.recencyHalfLifeMs);
      score += weight * recency;
      evidence.push(`${signal.type}:${signal.ref}`);
      if (signal.atMs != null && (lastMatchMs == null || signal.atMs > lastMatchMs)) lastMatchMs = signal.atMs;
    }

    if (score <= 0 || !evidence.length) continue;
    results.push({
      agentSessionId: session.id,
      displayCallsign: session.displayCallsign || null,
      ownerUserId: session.ownerUserId || null,
      agentProvider: session.agentProvider || null,
      status: session.status,
      score: Math.round(score * 1000) / 1000,
      lastInteractionAt: lastMatchMs != null ? new Date(lastMatchMs).toISOString() : null,
      evidence: unique(evidence).sort().slice(0, config.limits.maxEvidencePerExpert),
    });
  }

  return results
    .sort((left, right) => (right.score - left.score) || left.agentSessionId.localeCompare(right.agentSessionId))
    .slice(0, normalizedLimit);
}

export function suggestExpertsForReferences(references, {
  sessions = [],
  executionPlans = [],
  transactions = [],
  knowledgeItems = [],
  feedbackEvents = [],
  index = null,
  excludeSessionId = null,
  limit,
  now = new Date(),
  policy = EXPERTISE_POLICY,
} = {}) {
  const config = resolveExpertisePolicy(policy);
  const query = normalizeExpertiseQuery({
    paths: asArray(references?.paths),
    symbols: asArray(references?.symbols),
    contracts: asArray(references?.contracts),
    limit: limit ?? config.limits.suggestionLimit,
  }, config);
  const expertiseIndex = index || buildExpertiseIndex({
    executionPlans,
    transactions,
    knowledgeItems,
    feedbackEvents,
    now,
    policy: config,
  });
  return rankExperts(expertiseIndex, query, { sessions, excludeSessionId, limit: query.limit, policy: config });
}

export function emptyExpertiseReferences() {
  return emptyReferences();
}
