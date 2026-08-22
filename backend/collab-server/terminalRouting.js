'use strict';

/**
 * Decide whether a terminal session should run inside the per-workspace rootless
 * Docker runtime container. Requires the flag, a constructed runtime manager,
 * and a slug. Pure for testability.
 */
function shouldUseContainerTerminal({ enableContainerRuntime, workspaceRuntime, workspaceSlug } = {}) {
  return Boolean(enableContainerRuntime && workspaceRuntime && workspaceSlug);
}

function codeSiteTerminalLaunchMode({
  codeSiteContext,
  usesRuntimePodTerminal = false,
  enableContainerRuntime = false,
  workspaceRuntime = null,
  workspaceSlug = '',
} = {}) {
  if (!codeSiteContext?.active) return 'normal';
  const hasQuarantineRuntime = shouldUseContainerTerminal({ enableContainerRuntime, workspaceRuntime, workspaceSlug });
  if (hasQuarantineRuntime) return 'overlay-runtime';
  if (usesRuntimePodTerminal) return 'block-runtime';
  return 'block-host';
}

function codeSiteTerminalReattachDecision({ codeSiteContext, existingSession } = {}) {
  if (!codeSiteContext?.active) return { ok: true };
  const existingContext = existingSession?.codesiteContext;
  if (!existingContext?.active) {
    return {
      ok: false,
      code: 'codesite_terminal_reattach_denied',
      reason: 'existing_session_unmanaged',
      message: 'CodeSite terminal blocked: active transactions cannot reattach to an unmanaged terminal session.',
    };
  }
  if (!codeSiteContext.transactionId || !existingContext.transactionId || codeSiteContext.transactionId !== existingContext.transactionId) {
    return {
      ok: false,
      code: 'codesite_terminal_reattach_denied',
      reason: 'transaction_mismatch',
      message: 'CodeSite terminal blocked: requested transaction does not match the existing terminal session.',
    };
  }
  if (codeSiteContext.mutationLeaseId && existingContext.mutationLeaseId && codeSiteContext.mutationLeaseId !== existingContext.mutationLeaseId) {
    return {
      ok: false,
      code: 'codesite_terminal_reattach_denied',
      reason: 'lease_mismatch',
      message: 'CodeSite terminal blocked: requested lease does not match the existing terminal session.',
    };
  }
  if (codeSiteContext.agentSessionId && existingContext.agentSessionId && codeSiteContext.agentSessionId !== existingContext.agentSessionId) {
    return {
      ok: false,
      code: 'codesite_terminal_reattach_denied',
      reason: 'agent_session_mismatch',
      message: 'CodeSite terminal blocked: requested agent session does not match the existing terminal session.',
    };
  }
  if (codeSiteContext.workspaceSlug && existingContext.workspaceSlug && codeSiteContext.workspaceSlug !== existingContext.workspaceSlug) {
    return {
      ok: false,
      code: 'codesite_terminal_reattach_denied',
      reason: 'workspace_mismatch',
      message: 'CodeSite terminal blocked: requested workspace does not match the existing terminal session.',
    };
  }
  const hasOverlay = Boolean(
    existingSession?.runtimeOptions?.codeSiteOverlayId ||
    existingSession?.codesiteQuarantine?.overlayId ||
    existingSession?.codesiteQuarantine?.mountMode === 'docker-overlay',
  );
  if (!hasOverlay) {
    return {
      ok: false,
      code: 'codesite_terminal_reattach_denied',
      reason: 'overlay_missing',
      message: 'CodeSite terminal blocked: existing terminal session is not backed by a Docker overlay runtime.',
    };
  }
  return { ok: true };
}

const AGENT_REATTACH_REQUIRED_IDENTITIES = Object.freeze([
  'workspaceSlug',
  'collaborationSessionId',
  'ownerUserId',
  'collaborationUserId',
  'effectiveWorkspaceUserId',
  'projectId',
  'agentSessionId',
  'displayCallsign',
  'agentProvider',
  'providerSessionRef',
  'runtimeScope',
]);

const AGENT_REATTACH_OPTIONAL_RUNTIME_IDENTITIES = Object.freeze([
  'terminalSessionId',
  'runtimeSessionId',
]);

const AGENT_REATTACH_TRANSACTION_IDENTITIES = Object.freeze([
  'activeMutationLeaseId',
  'activeTransactionId',
]);

function agentSessionReattachDenied(reason) {
  return {
    ok: false,
    code: 'codesite_agent_reattach_denied',
    reason,
    message: 'CodeSite agent reattach blocked: the requested identity does not exactly match the retained terminal session.',
  };
}

/**
 * Fail-closed identity check for resuming an attached CodeSite agent on a
 * retained terminal. The caller must compare server-derived bindings only.
 */
function agentSessionReattachDecision({ requestedBinding, existingSession } = {}) {
  const existingBinding = existingSession?.codeSiteAgentBinding || null;
  if (!requestedBinding && !existingBinding) return { ok: true };
  if (!requestedBinding || !existingBinding) {
    return agentSessionReattachDenied('attachment_state_mismatch');
  }

  for (const field of AGENT_REATTACH_REQUIRED_IDENTITIES) {
    if (
      typeof requestedBinding[field] !== 'string' ||
      !requestedBinding[field].trim() ||
      typeof existingBinding[field] !== 'string' ||
      !existingBinding[field].trim()
    ) {
      return agentSessionReattachDenied('identity_incomplete');
    }
  }

  const requestedHasRuntimeIdentity = AGENT_REATTACH_OPTIONAL_RUNTIME_IDENTITIES.some(
    (field) => typeof requestedBinding[field] === 'string' && Boolean(requestedBinding[field].trim()),
  );
  const existingHasRuntimeIdentity = AGENT_REATTACH_OPTIONAL_RUNTIME_IDENTITIES.some(
    (field) => typeof existingBinding[field] === 'string' && Boolean(existingBinding[field].trim()),
  );
  if (!requestedHasRuntimeIdentity || !existingHasRuntimeIdentity) {
    return agentSessionReattachDenied('runtime_identity_incomplete');
  }

  for (const field of AGENT_REATTACH_TRANSACTION_IDENTITIES) {
    if (
      !Object.prototype.hasOwnProperty.call(requestedBinding, field) ||
      !Object.prototype.hasOwnProperty.call(existingBinding, field)
    ) {
      return agentSessionReattachDenied('transaction_identity_incomplete');
    }
  }

  for (const field of [
    ...AGENT_REATTACH_REQUIRED_IDENTITIES,
    ...AGENT_REATTACH_OPTIONAL_RUNTIME_IDENTITIES,
    ...AGENT_REATTACH_TRANSACTION_IDENTITIES,
  ]) {
    if (requestedBinding[field] !== existingBinding[field]) {
      return agentSessionReattachDenied(`${field}_mismatch`);
    }
  }

  return { ok: true };
}

module.exports = {
  shouldUseContainerTerminal,
  codeSiteTerminalLaunchMode,
  codeSiteTerminalReattachDecision,
  agentSessionReattachDecision,
};
