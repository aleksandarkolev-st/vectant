import { asArray, parseJson } from './json';
import { knowledgePathsOverlap } from './knowledgeRouting';

// Derived, evidence-weighted expertise. Nothing here is provider-aware and
// nothing is hand-authored: every signal comes from control-plane records the
// agents themselves produced (transactions, flight plans, shared knowledge).
export const EXPERTISE_CONTEXT_VERSION = 'synthi.codesite.expertise.v1';

export const EXPERTISE_SIGNAL_WEIGHTS = Object.freeze({
  transaction_write: 3,
  transaction_read: 2,
  knowledge_reference: 2,
  plan_route: 1.5,
  knowledge_authorship: 1,
});

export const EXPERTISE_RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

export const EXPERTISE_DEFAULT_LIMIT = 5;
export const EXPERTISE_MAX_LIMIT = 10;

const ELIGIBLE_SESSION_STATUSES = new Set(['attached', 'detached']);
const ACTIVE_PLAN_STATUSES = new Set(['filed', 'active', 'holding', 'blocked']);
const ACTIVE_TRANSACTION_STATUSES = new Set(['open', 'prepared', 'blocked', 'validated']);
const SIGNAL_KNOWLEDGE_KINDS = new Set(['discovery', 'lead', 'shared_skill', 'handoff', 'agent_question']);

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

export function normalizeExpertiseQuery(query = {}) {
  const splitQueryValues = (value) => asArray(value).flatMap((entry) => (
    typeof entry === 'string' ? entry.split(',') : [entry]
  ));
  const rawPaths = splitQueryValues(query.paths ?? query.path);
  const rawSymbols = splitQueryValues(query.symbols ?? query.symbol);
  const rawContracts = splitQueryValues(query.contracts ?? query.contract);
  if (rawPaths.length > 32 || rawSymbols.length > 32 || rawContracts.length > 32) {
    throw Object.assign(new Error('expertise_query_limit_exceeded'), { code: 'expertise_query_limit_exceeded', status: 422 });
  }
  const paths = unique(rawPaths.map((value) => String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').trim()).filter(Boolean));
  const symbols = unique(rawSymbols.map((value) => String(value || '').trim()).filter(Boolean));
  const contracts = unique(rawContracts.map((value) => String(value || '').trim()).filter(Boolean));
  if (paths.length > 32 || symbols.length > 32 || contracts.length > 32) {
    throw Object.assign(new Error('expertise_query_limit_exceeded'), { code: 'expertise_query_limit_exceeded', status: 422 });
  }
  const limitValue = Number(query.limit ?? EXPERTISE_DEFAULT_LIMIT);
  const limit = Number.isFinite(limitValue)
    ? Math.min(Math.max(Math.floor(limitValue), 1), EXPERTISE_MAX_LIMIT)
    : EXPERTISE_DEFAULT_LIMIT;
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
  now = new Date(),
} = {}) {
  const nowMs = timestampMs(now) ?? Date.now();
  const signalsBySession = new Map();

  const addSignal = (sessionId, signal) => {
    if (!signalsBySession.has(sessionId)) signalsBySession.set(sessionId, []);
    signalsBySession.get(sessionId).push({ ...signal, ageMs: Math.max(nowMs - (signal.atMs ?? nowMs), 0) });
  };

  for (const plan of executionPlans) {
    if (!ACTIVE_PLAN_STATUSES.has(String(plan.status || ''))) continue;
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
    if (!ACTIVE_TRANSACTION_STATUSES.has(String(transaction.status || ''))) continue;
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
    if (!SIGNAL_KNOWLEDGE_KINDS.has(kind)) continue;
    const references = itemRow.references || parseJson(itemRow.scopeJson, {})?.references || {};
    const paths = unique(asArray(references.paths));
    const symbols = unique(asArray(references.symbols));
    const contracts = unique(asArray(references.contracts));
    if (!paths.length && !symbols.length && !contracts.length) continue;
    const atMs = timestampMs(itemRow.updatedAt) ?? nowMs;
    if (itemRow.createdByAgentSessionId) {
      addSignal(itemRow.createdByAgentSessionId, {
        type: 'knowledge_authorship',
        weightSource: 'knowledge_authorship',
        paths,
        symbols,
        contracts,
        ref: itemRow.id,
        atMs,
      });
    }
    for (const sessionId of unique(asArray(references.agentSessionIds))) {
      if (sessionId === itemRow.createdByAgentSessionId) continue;
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

  return { nowMs, signalsBySession };
}

/**
 * Rank eligible peer sessions against a normalized query using the index.
 * Deterministic: score desc, then session id asc. The requesting session and
 * ended/inactive peers are never returned.
 */
export function rankExperts(index, query, {
  sessions = [],
  excludeSessionId = null,
  limit = EXPERTISE_DEFAULT_LIMIT,
} = {}) {
  const normalizedLimit = Number.isFinite(Number(limit))
    ? Math.min(Math.max(Math.floor(Number(limit)), 1), EXPERTISE_MAX_LIMIT)
    : EXPERTISE_DEFAULT_LIMIT;
  const results = [];

  for (const session of sessions) {
    if (!session || session.endedAt) continue;
    if (!ELIGIBLE_SESSION_STATUSES.has(String(session.status || '').toLowerCase())) continue;
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
      const weight = EXPERTISE_SIGNAL_WEIGHTS[signal.weightSource] ?? 1;
      const recency = recencyMultiplier(signal.ageMs);
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
      evidence: unique(evidence).sort().slice(0, 16),
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
  excludeSessionId = null,
  limit = 3,
  now = new Date(),
} = {}) {
  const query = normalizeExpertiseQuery({
    paths: asArray(references?.paths),
    symbols: asArray(references?.symbols),
    contracts: asArray(references?.contracts),
    limit,
  });
  const index = buildExpertiseIndex({ executionPlans, transactions, knowledgeItems, now });
  return rankExperts(index, query, { sessions, excludeSessionId, limit: query.limit });
}

export function emptyExpertiseReferences() {
  return emptyReferences();
}
