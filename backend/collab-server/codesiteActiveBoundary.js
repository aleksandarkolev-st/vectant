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
    status: record.status || null,
    source: record.source || null,
    lastSeenAt: record.lastSeenAt || null,
    expiresAt: record.expiresAt || null,
  };
}

function contextMatchesActiveTransaction(context = {}, record = {}) {
  const transactionId = normalize(context.transactionId);
  if (!transactionId || transactionId !== normalize(record.transactionId)) return false;
  const contextLease = normalize(context.mutationLeaseId || context.leaseId);
  const recordLease = normalize(record.mutationLeaseId || record.leaseId);
  if (contextLease && recordLease && contextLease !== recordLease) return false;
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

module.exports = {
  assertCodeSiteWorkspaceMutationAllowed,
  contextMatchesActiveTransaction,
};
