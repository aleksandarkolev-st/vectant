'use strict';

const configuredActiveTtlMs = Number(process.env.SYNTHI_CODESITE_ACTIVE_TTL_MS || 30 * 60 * 1000);
const DEFAULT_ACTIVE_TTL_MS = Number.isFinite(configuredActiveTtlMs)
  ? Math.max(60_000, configuredActiveTtlMs)
  : 30 * 60 * 1000;

const activeByWorkspace = new Map();

function normalize(value) {
  return String(value || '').trim();
}

function normalizeWorkspaceSlug(input = {}) {
  return normalize(input.workspaceSlug || input.workspace_slug || input.slug);
}

function normalizeTransactionId(input = {}) {
  return normalize(input.transactionId || input.transaction_id || input.id);
}

function isWritableTransactionStatus(status) {
  return ['open', 'running', 'active', 'pending', 'validating', 'blocked'].includes(String(status || 'open').toLowerCase());
}

function transactionKey(transactionId) {
  return normalize(transactionId) || `unknown:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function workspaceRecords(slug) {
  const normalizedSlug = normalize(slug);
  if (!normalizedSlug) return null;
  if (!activeByWorkspace.has(normalizedSlug)) {
    activeByWorkspace.set(normalizedSlug, new Map());
  }
  return activeByWorkspace.get(normalizedSlug);
}

function pruneWorkspace(slug, now = Date.now()) {
  const normalizedSlug = normalize(slug);
  const records = activeByWorkspace.get(normalizedSlug);
  if (!records) return [];
  for (const [key, record] of records) {
    if (record.expiresAt <= now || !isWritableTransactionStatus(record.status)) {
      records.delete(key);
    }
  }
  if (records.size === 0) activeByWorkspace.delete(normalizedSlug);
  return records ? [...records.values()] : [];
}

function markTransactionActive(input = {}, options = {}) {
  const workspaceSlug = normalizeWorkspaceSlug(input);
  const transactionId = normalizeTransactionId(input);
  if (!workspaceSlug || !transactionId) return null;
  const now = Number(options.now || Date.now());
  const requestedTtlMs = Number(input.ttlMs || input.ttl_ms || options.ttlMs || DEFAULT_ACTIVE_TTL_MS);
  const ttlMs = Number.isFinite(requestedTtlMs)
    ? Math.max(1_000, requestedTtlMs)
    : DEFAULT_ACTIVE_TTL_MS;
  const records = workspaceRecords(workspaceSlug);
  const key = transactionKey(transactionId);
  const record = {
    workspaceSlug,
    transactionId,
    mutationLeaseId: normalize(input.mutationLeaseId || input.mutation_lease_id || input.leaseId || input.lease_id) || null,
    agentSessionId: normalize(input.agentSessionId || input.agent_session_id) || null,
    actorUserId: normalize(input.actorUserId || input.actor_user_id || input.userId || input.user_id) || null,
    effectiveUserId: normalize(input.effectiveUserId || input.effective_user_id || input.filesystemUserId || input.filesystem_user_id) || null,
    status: normalize(input.status) || 'open',
    source: normalize(input.source || options.source) || 'codesite',
    createdAt: records.get(key)?.createdAt || now,
    lastSeenAt: now,
    expiresAt: now + ttlMs,
  };
  records.set(key, record);
  return { ...record };
}

function recordCodeSiteContext(context = {}, options = {}) {
  if (!context?.active || !context.transactionId) return null;
  const workspaceSlug = normalizeWorkspaceSlug(context);
  if (!workspaceSlug) return null;
  return markTransactionActive({
    workspaceSlug,
    transactionId: context.transactionId,
    mutationLeaseId: context.mutationLeaseId,
    agentSessionId: context.agentSessionId,
    actorUserId: context.actorUserId,
    effectiveUserId: context.effectiveUserId,
    status: context.authoritativeTransactionStatus || context.status || 'open',
    source: options.source || context.authoritativeSource || 'codesite-context',
    ttlMs: options.ttlMs,
  }, options);
}

function markTransactionClosed(input = {}, options = {}) {
  const workspaceSlug = normalizeWorkspaceSlug(input);
  const transactionId = normalizeTransactionId(input);
  if (!workspaceSlug) return null;
  const records = activeByWorkspace.get(workspaceSlug);
  if (!records) return null;
  if (transactionId) {
    const previous = records.get(transactionId) || null;
    records.delete(transactionId);
    if (records.size === 0) activeByWorkspace.delete(workspaceSlug);
    return previous ? {
      ...previous,
      status: normalize(input.status) || 'closed',
      closedAt: Number(options.now || Date.now()),
      closeSource: normalize(input.source || options.source) || 'codesite',
    } : null;
  }
  const closed = [...records.values()];
  activeByWorkspace.delete(workspaceSlug);
  return closed;
}

function activeTransactionsForWorkspace(slug, options = {}) {
  const now = Number(options.now || Date.now());
  return pruneWorkspace(slug, now).map((record) => ({ ...record }));
}

function isWorkspaceActive(slug, options = {}) {
  return activeTransactionsForWorkspace(slug, options).length > 0;
}

function activeWorkspaceError(slug, reason = 'workspace_mutation') {
  const activeTransactions = activeTransactionsForWorkspace(slug);
  const error = new Error(`CodeSite active transaction blocks ${reason} for workspace ${slug}`);
  error.code = 'CODESITE_WORKSPACE_ACTIVE';
  error.status = 409;
  error.details = {
    reason,
    workspaceSlug: normalize(slug),
    activeTransactions,
  };
  return error;
}

function assertWorkspaceInactive(slug, options = {}) {
  const reason = options.reason || 'workspace_mutation';
  if (isWorkspaceActive(slug, options)) {
    throw activeWorkspaceError(slug, reason);
  }
}

function resetRegistry() {
  activeByWorkspace.clear();
}

module.exports = {
  DEFAULT_ACTIVE_TTL_MS,
  activeTransactionsForWorkspace,
  assertWorkspaceInactive,
  isWorkspaceActive,
  isWritableTransactionStatus,
  markTransactionActive,
  markTransactionClosed,
  recordCodeSiteContext,
  resetRegistry,
};
