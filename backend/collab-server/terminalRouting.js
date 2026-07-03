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
  if (usesRuntimePodTerminal) return 'block-runtime';
  if (shouldUseContainerTerminal({ enableContainerRuntime, workspaceRuntime, workspaceSlug })) return 'overlay-runtime';
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

module.exports = {
  shouldUseContainerTerminal,
  codeSiteTerminalLaunchMode,
  codeSiteTerminalReattachDecision,
};
