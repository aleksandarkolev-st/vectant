'use strict';

const codeSiteActivityRegistry = require('./codesiteActivityRegistry');

function normalize(value) {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function activeTransactionSummary(record = {}) {
  return {
    workspaceSlug: record.workspaceSlug,
    transactionId: record.transactionId,
    mutationLeaseId: record.mutationLeaseId || null,
    agentSessionId: record.agentSessionId || null,
    actorUserId: record.actorUserId || null,
    effectiveUserId: record.effectiveUserId || null,
    controlPlaneUrl: record.controlPlaneUrl || null,
    status: record.status || null,
    source: record.source || null,
    authoritative: Boolean(record.authoritative),
    lastSeenAt: record.lastSeenAt || null,
    expiresAt: record.expiresAt || null,
  };
}

function recordCanAuthorizeWrite(record = {}) {
  return String(record.status || '').toLowerCase() === 'open';
}

function contextMatchesActiveTransaction(context = {}, record = {}) {
  if (!recordCanAuthorizeWrite(record)) return false;
  if (!record.authoritative) return false;
  const transactionId = normalize(context.transactionId);
  if (!transactionId || transactionId !== normalize(record.transactionId)) return false;
  const requiredFields = [
    ['mutationLeaseId', ['mutationLeaseId', 'leaseId']],
    ['agentSessionId', ['agentSessionId', 'agent_session_id']],
    ['actorUserId', ['actorUserId', 'actor_user_id', 'userId', 'user_id']],
    ['effectiveUserId', ['effectiveUserId', 'effective_user_id', 'filesystemUserId', 'filesystem_user_id']],
  ];
  for (const [recordField, contextFields] of requiredFields) {
    const recordValue = normalize(record[recordField]);
    if (!recordValue) return false;
    const contextValue = normalize(contextFields.map((field) => context[field]).find((value) => normalize(value)));
    if (!contextValue || contextValue !== recordValue) return false;
  }
  return true;
}

function operationAttempts(operation = {}) {
  if (Array.isArray(operation.attempts)) return operation.attempts;
  if (operation.path) return [operation];
  return [];
}

function activeWorkspaceDeniedError(workspaceSlug, context = {}, operation = {}, options = {}) {
  const activeTransactions = asArray(options.activeTransactions).map(activeTransactionSummary);
  const firstAttempt = operationAttempts(operation)[0] || operation || {};
  const tool = firstAttempt.tool || operation.tool || options.tool || 'workspace_mutation';
  const path = firstAttempt.path || operation.path || '**';
  const operationName = options.surface || operation.operation || operation.kind || 'workspace_mutation';
  const contextTransactionId = normalize(context?.transactionId) || null;
  const reason = context?.active && contextTransactionId
    ? 'codesite_active_workspace_context_mismatch'
    : 'codesite_active_workspace_context_required';
  const error = new Error(
    `CodeSite active transaction blocks ${operationName} on workspace ${workspaceSlug}; attach the matching CodeSite transaction context before mutating the real workspace.`,
  );
  error.code = 'CODESITE_WRITE_DENIED';
  error.status = 403;
  error.event = {
    type: 'write_denied',
    path,
    tool,
    transaction_id: contextTransactionId,
    lease_id: normalize(context?.mutationLeaseId || context?.leaseId) || null,
    details: {
      reason,
      reason_codes: [reason],
      operation: operationName,
      workspace_slug: workspaceSlug,
      active_transactions: activeTransactions,
    },
  };
  return error;
}

function activeWorkspaceAuthorityUnavailableError(workspaceSlug, context = {}, operation = {}, cause = null) {
  const firstAttempt = operationAttempts(operation)[0] || operation || {};
  const tool = firstAttempt.tool || operation.tool || 'workspace_mutation';
  const path = firstAttempt.path || operation.path || '**';
  const operationName = operation.operation || operation.kind || 'workspace_mutation';
  const contextTransactionId = normalize(context?.transactionId) || null;
  const error = new Error(
    `CodeSite active transaction authority is unavailable for ${operationName} on workspace ${workspaceSlug}; refusing to mutate the real workspace.`,
  );
  error.code = 'CODESITE_WRITE_DENIED';
  error.status = 503;
  if (cause) error.cause = cause;
  error.event = {
    type: 'write_denied',
    path,
    tool,
    transaction_id: contextTransactionId,
    lease_id: normalize(context?.mutationLeaseId || context?.leaseId) || null,
    details: {
      reason: 'codesite_active_workspace_authority_unavailable',
      reason_codes: ['codesite_active_workspace_authority_unavailable'],
      operation: operationName,
      workspace_slug: workspaceSlug,
      authority_error: cause?.code || cause?.message || null,
    },
  };
  return error;
}

function assertCodeSiteWorkspaceMutationAllowed(workspaceSlug, context = {}, operation = {}, options = {}) {
  const slug = normalize(workspaceSlug || context?.workspaceSlug || options.workspaceSlug || options.slug);
  if (!slug) return [];
  const activeTransactions = codeSiteActivityRegistry.activeTransactionsForWorkspace(slug);
  if (!activeTransactions.length) return activeTransactions;
  const matchesActive = context?.active
    && activeTransactions.some((record) => contextMatchesActiveTransaction(context, record));
  if (matchesActive) return activeTransactions;
  throw activeWorkspaceDeniedError(slug, context, operation, {
    ...options,
    activeTransactions,
  });
}

async function assertCodeSiteWorkspaceMutationAllowedAsync(workspaceSlug, context = {}, operation = {}, options = {}) {
  const slug = normalize(workspaceSlug || context?.workspaceSlug || options.workspaceSlug || options.slug);
  if (!slug) return [];
  try {
    await codeSiteActivityRegistry.refreshWorkspaceFromControlPlane(slug, {
      controlPlaneUrl: options.controlPlaneUrl || context?.controlPlaneUrl,
      controlPlaneTrusted: options.controlPlaneTrusted || context?.controlPlaneTrusted,
      fetch: options.fetch || options.codesiteFetch || options.codeSiteFetch,
      authToken: options.authToken || context?.authToken,
      cookie: options.cookie || context?.cookie,
      timeoutMs: options.timeoutMs,
      requireAuthority: true,
    });
  } catch (error) {
    throw activeWorkspaceAuthorityUnavailableError(slug, context, operation, error);
  }
  return assertCodeSiteWorkspaceMutationAllowed(slug, context, operation, options);
}

module.exports = {
  assertCodeSiteWorkspaceMutationAllowed,
  assertCodeSiteWorkspaceMutationAllowedAsync,
  contextMatchesActiveTransaction,
  recordCanAuthorizeWrite,
};
