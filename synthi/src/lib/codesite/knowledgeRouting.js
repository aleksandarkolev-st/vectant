import { createHash } from 'crypto';
import { asArray, parseJson, stableJson } from './json';
import { EXPERTISE_POLICY, resolveExpertisePolicy } from './expertisePolicy';
import { matchPathPattern, normalizePath } from './policy';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function referencesFor(item) {
  const references = item?.references || parseJson(item?.scopeJson, {})?.references || {};
  return {
    paths: unique(asArray(references.paths).map(normalizePath).filter(Boolean)),
    symbols: unique(asArray(references.symbols).map(String)),
    contracts: unique(asArray(references.contracts).map(String)),
    runtimeSessionIds: unique(asArray(references.runtimeSessionIds).map(String)),
    agentSessionIds: unique(asArray(references.agentSessionIds).map(String)),
    workstreamIds: unique(asArray(references.workstreamIds).map(String)),
    transactionIds: unique(asArray(references.transactionIds).map(String)),
  };
}

function pathStaticPrefix(value) {
  const normalized = normalizePath(value);
  const wildcardIndex = normalized.search(/[?*[{]/);
  return (wildcardIndex < 0 ? normalized : normalized.slice(0, wildcardIndex))
    .replace(/\/+$/, '');
}

export function knowledgePathsOverlap(first, second) {
  const left = normalizePath(first);
  const right = normalizePath(second);
  if (!left || !right) return false;
  if (matchPathPattern(left, right) || matchPathPattern(right, left)) return true;
  const leftPrefix = pathStaticPrefix(left);
  const rightPrefix = pathStaticPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return leftPrefix === rightPrefix
    || leftPrefix.startsWith(`${rightPrefix}/`)
    || rightPrefix.startsWith(`${leftPrefix}/`);
}

function anyPathOverlap(left, right) {
  return left.some((first) => right.some((second) => knowledgePathsOverlap(first, second)));
}

function anyExactOverlap(left, right) {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function planRoutes(plan) {
  return asArray(plan?.route || parseJson(plan?.routeJson, []))
    .map((value) => typeof value === 'string' ? value : value?.path || value?.pattern)
    .map(normalizePath)
    .filter(Boolean);
}

function transactionPaths(transaction) {
  return unique([
    ...asArray(transaction?.readSet || parseJson(transaction?.readSetJson, [])),
    ...asArray(transaction?.observedReadSet || parseJson(transaction?.observedReadSetJson, [])),
    ...asArray(transaction?.writeSet || parseJson(transaction?.writeSetJson, [])),
    ...asArray(transaction?.observedWriteSet || parseJson(transaction?.observedWriteSetJson, [])),
  ].map(normalizePath).filter(Boolean));
}

function transactionSemanticRefs(transaction) {
  const raw = transaction?.semanticDependencyRefs || parseJson(transaction?.semanticDependencyRefsJson, []);
  const result = { symbols: [], contracts: [] };
  for (const entry of asArray(raw)) {
    if (typeof entry === 'string') {
      const [type, ...rest] = entry.split(':');
      const value = rest.join(':');
      if (type === 'symbol' && value) result.symbols.push(value);
      else if (type === 'contract' && value) result.contracts.push(value);
      else result.contracts.push(entry);
      continue;
    }
    const type = String(entry?.type || entry?.refType || '').toLowerCase();
    const value = String(entry?.key || entry?.value || entry?.refKey || '');
    if (type === 'symbol' && value) result.symbols.push(value);
    if (type === 'contract' && value) result.contracts.push(value);
  }
  return { symbols: unique(result.symbols), contracts: unique(result.contracts) };
}

function subscriptionsFor(session) {
  return asArray(session?.subscriptions || parseJson(session?.subscriptionsJson, []))
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function subscriptionReasons(session, item, refs) {
  const reasons = [];
  for (const subscription of subscriptionsFor(session)) {
    if (subscription === `knowledge.${item.kind}` || subscription === 'knowledge.*') {
      reasons.push(`subscription:${subscription}`);
      continue;
    }
    const separator = subscription.indexOf(':');
    if (separator < 0) continue;
    const type = subscription.slice(0, separator);
    const value = subscription.slice(separator + 1);
    if (type === 'path' && refs.paths.some((path) => knowledgePathsOverlap(path, value))) {
      reasons.push(`subscription:${subscription}`);
    } else if (type === 'contract' && refs.contracts.includes(value)) {
      reasons.push(`subscription:${subscription}`);
    } else if (type === 'symbol' && refs.symbols.includes(value)) {
      reasons.push(`subscription:${subscription}`);
    } else if (type === 'workstream' && refs.workstreamIds.includes(value)) {
      reasons.push(`subscription:${subscription}`);
    } else if (type === 'runtime' && refs.runtimeSessionIds.includes(value)) {
      reasons.push(`subscription:${subscription}`);
    }
  }
  return reasons;
}

function sessionIsEligible(session, eligibleSessionStatuses) {
  return session
    && !session.endedAt
    && eligibleSessionStatuses.has(String(session.status || '').toLowerCase());
}

function impactDedupeKey(sourceKnowledgeId, agentSessionId, transactionId, reasons) {
  const identity = stableJson({
    sourceKnowledgeId,
    agentSessionId,
    transactionId: transactionId || null,
    reasons: [...reasons].sort(),
  });
  return `impact:${createHash('sha256').update(identity).digest('hex')}`;
}

export function buildKnowledgeDeliveryPlan({
  item,
  sessions = [],
  executionPlans = [],
  transactions = [],
  policy = EXPERTISE_POLICY,
} = {}) {
  if (!item?.id || !item?.kind) throw new Error('knowledge_delivery_item_required');
  const config = resolveExpertisePolicy(policy);
  const eligibleSessionStatuses = new Set(config.statuses.eligibleSession.map((status) => String(status).toLowerCase()));
  const activePlanStatuses = new Set(config.statuses.activePlan.map((status) => String(status).toLowerCase()));
  const activeTransactionStatuses = new Set(config.statuses.activeTransaction.map((status) => String(status).toLowerCase()));
  const refs = referencesFor(item);
  const plansBySession = new Map();
  for (const plan of executionPlans) {
    if (plan?.status != null && !activePlanStatuses.has(String(plan.status).toLowerCase())) continue;
    const values = plansBySession.get(plan.agentSessionId) || [];
    values.push(plan);
    plansBySession.set(plan.agentSessionId, values);
  }
  const transactionsBySession = new Map();
  for (const transaction of transactions) {
    const values = transactionsBySession.get(transaction.agentSessionId) || [];
    values.push(transaction);
    transactionsBySession.set(transaction.agentSessionId, values);
  }

  const explicitRecipients = new Set([
    ...refs.agentSessionIds,
    ...asArray(item.recipientAgentSessionIds),
    item.toAgentSessionId,
    item.ownerAgentSessionId,
  ].filter(Boolean));
  const producerSessionId = item.createdByAgentSessionId || item.source?.agentSessionId || null;
  const targets = [];

  for (const session of sessions) {
    if (!sessionIsEligible(session, eligibleSessionStatuses)) continue;
    const reasons = [];
    const impactedTransactions = [];
    if (explicitRecipients.has(session.id)) reasons.push('explicit_agent_reference');
    if (refs.runtimeSessionIds.includes(session.runtimeSessionId)) reasons.push('runtime_session_reference');

    for (const plan of plansBySession.get(session.id) || []) {
      if (refs.workstreamIds.includes(plan.id)) reasons.push(`workstream:${plan.id}`);
      if (refs.paths.length && anyPathOverlap(refs.paths, planRoutes(plan))) reasons.push(`route:${plan.id}`);
    }

    for (const transaction of transactionsBySession.get(session.id) || []) {
      if (transaction?.status != null && !activeTransactionStatuses.has(String(transaction.status).toLowerCase())) continue;
      const semantic = transactionSemanticRefs(transaction);
      const pathImpact = refs.paths.length && anyPathOverlap(refs.paths, transactionPaths(transaction));
      const symbolImpact = refs.symbols.length && anyExactOverlap(refs.symbols, semantic.symbols);
      const contractImpact = refs.contracts.length && anyExactOverlap(refs.contracts, semantic.contracts);
      const exactImpact = refs.transactionIds.includes(transaction.id);
      if (pathImpact || symbolImpact || contractImpact || exactImpact) {
        impactedTransactions.push(transaction.id);
        if (pathImpact) reasons.push(`transaction_path:${transaction.id}`);
        if (symbolImpact) reasons.push(`transaction_symbol:${transaction.id}`);
        if (contractImpact) reasons.push(`transaction_contract:${transaction.id}`);
        if (exactImpact) reasons.push(`transaction_reference:${transaction.id}`);
      }
    }

    reasons.push(...subscriptionReasons(session, item, refs));
    const distinctReasons = unique(reasons).sort();
    if (!distinctReasons.length) continue;
    if (session.id === producerSessionId && !explicitRecipients.has(session.id)) continue;

    const transactionIds = unique(impactedTransactions).sort();
    const primaryTransactionId = transactionIds[0] || null;
    targets.push({
      agentSessionId: session.id,
      recipientUserId: session.ownerUserId,
      transactionIds,
      reasons: distinctReasons,
      dedupeKey: impactDedupeKey(item.id, session.id, primaryTransactionId, distinctReasons),
      deliveryState: session.status === 'attached' ? 'live_and_durable' : 'durable_resume',
    });
  }

  return targets.sort((left, right) => left.agentSessionId.localeCompare(right.agentSessionId));
}
