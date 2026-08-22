'use strict';

const {
  resolveTrustedControlPlaneBaseUrl,
} = require('./codesiteControlPlaneTrust');

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const AGENT_TOKEN_PATTERN = /^csa_[A-Za-z0-9_-]{32,128}$/;

function lifecycleError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, code, maxLength = 256) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) throw lifecycleError(code);
  return normalized;
}

function nullableIdentity(value, code) {
  if (value == null || value === '') return null;
  return requiredString(value, code);
}

function exact(value, expected, code) {
  if (value !== expected) throw lifecycleError(code);
  return value;
}

function normalizeTerminalAgentBinding({ result, gatewayAuth, workspaceSlug, terminalSessionId }) {
  const serviceBinding = result?.binding;
  const session = result?.session;
  const claim = gatewayAuth?.agentBinding;
  if (!serviceBinding || !session || !claim) {
    throw lifecycleError('AGENT_TERMINAL_ATTACH_RESPONSE_INCOMPLETE');
  }

  const binding = {
    workspaceSlug: requiredString(workspaceSlug, 'AGENT_TERMINAL_WORKSPACE_REQUIRED'),
    collaborationSessionId: requiredString(serviceBinding.collaborationSessionId, 'AGENT_TERMINAL_COLLABORATION_SESSION_REQUIRED'),
    ownerUserId: requiredString(serviceBinding.ownerUserId, 'AGENT_TERMINAL_OWNER_REQUIRED'),
    collaborationUserId: requiredString(serviceBinding.collaborationUserId, 'AGENT_TERMINAL_COLLABORATION_USER_REQUIRED'),
    effectiveWorkspaceUserId: requiredString(serviceBinding.effectiveWorkspaceUserId, 'AGENT_TERMINAL_EFFECTIVE_USER_REQUIRED'),
    projectId: requiredString(serviceBinding.projectId, 'AGENT_TERMINAL_PROJECT_REQUIRED'),
    agentSessionId: requiredString(serviceBinding.agentSessionId, 'AGENT_TERMINAL_SESSION_REQUIRED'),
    displayCallsign: requiredString(session.displayCallsign, 'AGENT_TERMINAL_CALLSIGN_REQUIRED'),
    agentProvider: requiredString(serviceBinding.agentProvider, 'AGENT_TERMINAL_PROVIDER_REQUIRED'),
    providerSessionRef: requiredString(serviceBinding.providerSessionRef, 'AGENT_TERMINAL_PROVIDER_SESSION_REQUIRED'),
    runtimeScope: requiredString(serviceBinding.runtimeScope, 'AGENT_TERMINAL_RUNTIME_SCOPE_REQUIRED'),
    terminalSessionId: nullableIdentity(serviceBinding.terminalSessionId, 'AGENT_TERMINAL_TERMINAL_SESSION_INVALID'),
    runtimeSessionId: nullableIdentity(serviceBinding.runtimeSessionId, 'AGENT_TERMINAL_RUNTIME_SESSION_INVALID'),
    activeMutationLeaseId: nullableIdentity(
      session.activeMutationLeaseId ?? serviceBinding.activeMutationLeaseId,
      'AGENT_TERMINAL_LEASE_INVALID',
    ),
    activeTransactionId: nullableIdentity(
      session.activeTransactionId ?? serviceBinding.activeTransactionId,
      'AGENT_TERMINAL_TRANSACTION_INVALID',
    ),
  };

  exact(binding.workspaceSlug, requiredString(gatewayAuth.workspaceSlug, 'AGENT_TERMINAL_GATEWAY_WORKSPACE_REQUIRED'), 'AGENT_TERMINAL_WORKSPACE_MISMATCH');
  exact(binding.collaborationSessionId, requiredString(gatewayAuth.collabSessionId, 'AGENT_TERMINAL_GATEWAY_SESSION_REQUIRED'), 'AGENT_TERMINAL_COLLABORATION_SESSION_MISMATCH');
  exact(binding.ownerUserId, requiredString(gatewayAuth.actorUserId, 'AGENT_TERMINAL_GATEWAY_OWNER_REQUIRED'), 'AGENT_TERMINAL_OWNER_MISMATCH');
  exact(binding.collaborationUserId, requiredString(gatewayAuth.workspaceUserId, 'AGENT_TERMINAL_GATEWAY_USER_REQUIRED'), 'AGENT_TERMINAL_COLLABORATION_USER_MISMATCH');
  exact(binding.effectiveWorkspaceUserId, requiredString(gatewayAuth.filesystemUserId, 'AGENT_TERMINAL_GATEWAY_EFFECTIVE_USER_REQUIRED'), 'AGENT_TERMINAL_EFFECTIVE_USER_MISMATCH');
  exact(binding.projectId, requiredString(claim.projectId, 'AGENT_TERMINAL_CLAIM_PROJECT_REQUIRED'), 'AGENT_TERMINAL_PROJECT_MISMATCH');
  exact(binding.agentProvider, requiredString(claim.provider, 'AGENT_TERMINAL_CLAIM_PROVIDER_REQUIRED'), 'AGENT_TERMINAL_PROVIDER_MISMATCH');
  exact(binding.providerSessionRef, requiredString(claim.providerSessionRef, 'AGENT_TERMINAL_CLAIM_PROVIDER_SESSION_REQUIRED'), 'AGENT_TERMINAL_PROVIDER_SESSION_MISMATCH');
  exact(binding.runtimeScope, requiredString(gatewayAuth.runtimeScope, 'AGENT_TERMINAL_GATEWAY_RUNTIME_SCOPE_REQUIRED'), 'AGENT_TERMINAL_RUNTIME_SCOPE_MISMATCH');
  exact(binding.terminalSessionId, requiredString(terminalSessionId, 'AGENT_TERMINAL_TERMINAL_SESSION_REQUIRED'), 'AGENT_TERMINAL_TERMINAL_SESSION_MISMATCH');

  return Object.freeze(binding);
}

function lifecycleInput(state) {
  return {
    gatewayAuth: state.gatewayAuth,
    workspaceSlug: state.workspaceSlug,
    terminalSessionId: state.terminalSessionId,
    agentSessionId: state.binding.agentSessionId,
  };
}

function agentReattachBindingFromGateway({
  gatewayAuth,
  existingBinding,
  workspaceSlug,
  terminalSessionId,
  activeMutationLeaseId = null,
  activeTransactionId = null,
} = {}) {
  if (!gatewayAuth?.agentBinding) return null;
  return Object.freeze({
    workspaceSlug: requiredString(workspaceSlug, 'AGENT_TERMINAL_WORKSPACE_REQUIRED'),
    collaborationSessionId: requiredString(gatewayAuth.collabSessionId, 'AGENT_TERMINAL_GATEWAY_SESSION_REQUIRED'),
    ownerUserId: requiredString(gatewayAuth.actorUserId, 'AGENT_TERMINAL_GATEWAY_OWNER_REQUIRED'),
    collaborationUserId: requiredString(gatewayAuth.workspaceUserId, 'AGENT_TERMINAL_GATEWAY_USER_REQUIRED'),
    effectiveWorkspaceUserId: requiredString(gatewayAuth.filesystemUserId, 'AGENT_TERMINAL_GATEWAY_EFFECTIVE_USER_REQUIRED'),
    projectId: requiredString(gatewayAuth.agentBinding.projectId, 'AGENT_TERMINAL_CLAIM_PROJECT_REQUIRED'),
    agentSessionId: requiredString(existingBinding?.agentSessionId, 'AGENT_TERMINAL_SESSION_REQUIRED'),
    displayCallsign: requiredString(existingBinding?.displayCallsign, 'AGENT_TERMINAL_CALLSIGN_REQUIRED'),
    agentProvider: requiredString(gatewayAuth.agentBinding.provider, 'AGENT_TERMINAL_CLAIM_PROVIDER_REQUIRED'),
    providerSessionRef: requiredString(gatewayAuth.agentBinding.providerSessionRef, 'AGENT_TERMINAL_CLAIM_PROVIDER_SESSION_REQUIRED'),
    runtimeScope: requiredString(gatewayAuth.runtimeScope, 'AGENT_TERMINAL_GATEWAY_RUNTIME_SCOPE_REQUIRED'),
    terminalSessionId: requiredString(terminalSessionId, 'AGENT_TERMINAL_TERMINAL_SESSION_REQUIRED'),
    runtimeSessionId: existingBinding?.runtimeSessionId ?? null,
    activeMutationLeaseId: nullableIdentity(activeMutationLeaseId, 'AGENT_TERMINAL_LEASE_INVALID'),
    activeTransactionId: nullableIdentity(activeTransactionId, 'AGENT_TERMINAL_TRANSACTION_INVALID'),
  });
}

async function attachTerminalAgent({
  service,
  gatewayAuth,
  workspaceSlug,
  terminalSessionId,
  requireAccessToken = true,
  resolveBaseUrl = resolveTrustedControlPlaneBaseUrl,
} = {}) {
  if (!gatewayAuth?.agentBinding) return null;
  if (!service || typeof service.attach !== 'function') {
    throw lifecycleError('AGENT_TERMINAL_ATTACH_SERVICE_REQUIRED');
  }
  const result = await service.attach({
    gatewayAuth,
    workspaceSlug,
    terminalSessionId,
    rotateAgentAccessToken: requireAccessToken,
  });
  const binding = normalizeTerminalAgentBinding({ result, gatewayAuth, workspaceSlug, terminalSessionId });
  const accessToken = result?.agentAccessToken == null ? null : String(result.agentAccessToken).trim();
  if ((requireAccessToken && !accessToken) || (accessToken && !AGENT_TOKEN_PATTERN.test(accessToken))) {
    throw lifecycleError('AGENT_TERMINAL_ACCESS_TOKEN_REQUIRED');
  }
  const apiBaseUrl = resolveBaseUrl(workspaceSlug);
  if (!apiBaseUrl) throw lifecycleError('AGENT_TERMINAL_CONTROL_PLANE_REQUIRED');

  const state = {
    service,
    gatewayAuth,
    workspaceSlug: binding.workspaceSlug,
    terminalSessionId: binding.terminalSessionId,
    binding,
    heartbeatTimer: null,
    finalDetachPromise: null,
  };
  const scopedEnv = accessToken ? Object.freeze({
    SYNTHI_CODESITE_AGENT_SESSION_ID: binding.agentSessionId,
    SYNTHI_CODESITE_AGENT_TOKEN: accessToken,
    SYNTHI_CODESITE_WORKSPACE: binding.workspaceSlug,
    SYNTHI_WORKSPACE_SLUG: binding.workspaceSlug,
    SYNTHI_CODESITE_PROJECT_ID: binding.projectId,
    SYNTHI_CODESITE_API_BASE_URL: apiBaseUrl,
  }) : Object.freeze({});
  return { binding, scopedEnv, state };
}

function startAgentTerminalHeartbeat(state, {
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  setIntervalFn = setInterval,
  onError = () => {},
} = {}) {
  if (!state || state.heartbeatTimer || state.finalDetachPromise) return state?.heartbeatTimer || null;
  const delay = Math.max(5_000, Number(intervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS);
  state.heartbeatTimer = setIntervalFn(() => {
    Promise.resolve(state.service.heartbeat(lifecycleInput(state))).catch(onError);
  }, delay);
  state.heartbeatTimer?.unref?.();
  return state.heartbeatTimer;
}

function stopAgentTerminalHeartbeat(state, { clearIntervalFn = clearInterval } = {}) {
  if (!state?.heartbeatTimer) return;
  clearIntervalFn(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

function finalizeAgentTerminal(state, reason = 'terminal_disposed', {
  clearIntervalFn = clearInterval,
} = {}) {
  if (!state) return Promise.resolve(null);
  if (state.finalDetachPromise) return state.finalDetachPromise;
  stopAgentTerminalHeartbeat(state, { clearIntervalFn });
  state.finalDetachPromise = Promise.resolve(state.service.detach({
    ...lifecycleInput(state),
    reason: String(reason || 'terminal_disposed').slice(0, 120),
    ended: true,
  }));
  return state.finalDetachPromise;
}

module.exports = {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  agentReattachBindingFromGateway,
  attachTerminalAgent,
  finalizeAgentTerminal,
  normalizeTerminalAgentBinding,
  startAgentTerminalHeartbeat,
  stopAgentTerminalHeartbeat,
};
