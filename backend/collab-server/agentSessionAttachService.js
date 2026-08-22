'use strict';

const {
  normalizeAgentBindingClaim,
} = require('./collabGatewayAuth');
const {
  resolveTrustedControlPlaneBaseUrl,
} = require('./codesiteControlPlaneTrust');

const DEFAULT_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_CAPABILITIES = Object.freeze([
  'codesite.context.read',
  'codesite.inbox.read',
  'codesite.events.read',
]);
const DEFAULT_SUBSCRIPTIONS = Object.freeze([
  'project.events',
  'agent.inbox',
]);

function attachError(code, status, message, cause = null) {
  const error = new Error(message || code);
  error.code = code;
  error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function required(value, code, maxLength = 256) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw attachError(code, 400, code);
  }
  return normalized;
}

function optional(value, code, maxLength = 256) {
  if (value == null || value === '') return null;
  return required(value, code, maxLength);
}

function sameAgentBinding(left, right) {
  return Boolean(
    left
    && right
    && left.projectId === right.projectId
    && left.provider === right.provider
    && left.providerSessionRef === right.providerSessionRef
  );
}

function trustedGatewayIdentity(gatewayAuth, workspaceSlug, bindingClaim) {
  if (gatewayAuth?.source !== 'gateway') {
    throw attachError('AGENT_ATTACH_GATEWAY_AUTH_REQUIRED', 403, 'A verified collaboration gateway identity is required.');
  }
  const trustedWorkspaceSlug = required(gatewayAuth.workspaceSlug, 'AGENT_ATTACH_WORKSPACE_REQUIRED');
  if (trustedWorkspaceSlug !== required(workspaceSlug, 'AGENT_ATTACH_WORKSPACE_REQUIRED')) {
    throw attachError('AGENT_ATTACH_WORKSPACE_MISMATCH', 403, 'Agent workspace does not match the gateway identity.');
  }
  const trustedBinding = normalizeAgentBindingClaim(gatewayAuth.agentBinding);
  const requestedBinding = bindingClaim == null ? trustedBinding : normalizeAgentBindingClaim(bindingClaim);
  if (!trustedBinding || !requestedBinding || !sameAgentBinding(trustedBinding, requestedBinding)) {
    throw attachError('AGENT_ATTACH_BINDING_MISMATCH', 403, 'A complete signed agent binding is required.');
  }
  return {
    workspaceSlug: trustedWorkspaceSlug,
    ownerUserId: required(gatewayAuth.actorUserId, 'AGENT_ATTACH_OWNER_REQUIRED'),
    collaborationUserId: required(gatewayAuth.workspaceUserId, 'AGENT_ATTACH_COLLABORATION_USER_REQUIRED'),
    effectiveWorkspaceUserId: required(gatewayAuth.filesystemUserId, 'AGENT_ATTACH_EFFECTIVE_USER_REQUIRED'),
    collaborationSessionId: required(gatewayAuth.collabSessionId, 'AGENT_ATTACH_COLLABORATION_SESSION_REQUIRED'),
    runtimeScope: required(gatewayAuth.runtimeScope, 'AGENT_ATTACH_RUNTIME_SCOPE_REQUIRED'),
    binding: trustedBinding,
  };
}

function buildAgentAttachPayload({
  gatewayAuth,
  workspaceSlug,
  terminalSessionId = null,
  runtimeSessionId = null,
  bindingClaim = null,
  capabilities = DEFAULT_CAPABILITIES,
  subscriptions = DEFAULT_SUBSCRIPTIONS,
} = {}) {
  const identity = trustedGatewayIdentity(gatewayAuth, workspaceSlug, bindingClaim);
  const terminalId = optional(terminalSessionId, 'AGENT_ATTACH_TERMINAL_SESSION_INVALID');
  const runtimeId = optional(runtimeSessionId, 'AGENT_ATTACH_RUNTIME_SESSION_INVALID');
  if (!terminalId && !runtimeId) {
    throw attachError('AGENT_ATTACH_TERMINAL_OR_RUNTIME_REQUIRED', 400, 'A terminal or runtime session is required.');
  }
  return {
    projectId: identity.binding.projectId,
    body: {
      collaborationMembershipVerified: true,
      ownerUserId: identity.ownerUserId,
      collaborationUserId: identity.collaborationUserId,
      effectiveWorkspaceUserId: identity.effectiveWorkspaceUserId,
      collaborationSessionId: identity.collaborationSessionId,
      terminalSessionId: terminalId,
      runtimeSessionId: runtimeId,
      runtimeScope: identity.runtimeScope,
      agentProvider: identity.binding.provider,
      providerSessionRef: identity.binding.providerSessionRef,
      agentRuntime: runtimeId && !terminalId ? 'managed_runtime' : 'terminal',
      capabilities: [...new Set((Array.isArray(capabilities) ? capabilities : []).map(String).filter(Boolean))],
      subscriptions: [...new Set((Array.isArray(subscriptions) ? subscriptions : []).map(String).filter(Boolean))],
      deliveryChannel: { type: 'mcp_poll' },
      executionHost: {
        type: runtimeId && !terminalId ? 'managed_runtime' : 'workspace_terminal',
        hostId: identity.runtimeScope,
        platform: process.platform,
      },
    },
  };
}

function createAgentSessionAttachService({
  fetchImpl = globalThis.fetch,
  resolveBaseUrl = resolveTrustedControlPlaneBaseUrl,
  authToken = process.env.SYNTHI_CODESITE_TOKEN || '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  async function post(workspaceSlug, path, body) {
    const baseUrl = resolveBaseUrl(workspaceSlug);
    if (!baseUrl) {
      throw attachError('AGENT_ATTACH_CONTROL_PLANE_UNCONFIGURED', 503, 'CodeSite control plane is not configured.');
    }
    if (!authToken) {
      throw attachError('AGENT_ATTACH_CONTROL_PLANE_AUTH_UNCONFIGURED', 503, 'CodeSite control-plane authentication is not configured.');
    }
    if (typeof fetchImpl !== 'function') {
      throw attachError('AGENT_ATTACH_FETCH_UNAVAILABLE', 503, 'CodeSite control-plane transport is unavailable.');
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      throw attachError('AGENT_ATTACH_CONTROL_PLANE_UNAVAILABLE', 503, 'CodeSite control plane is unavailable.', error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (!response?.ok) {
      throw attachError(
        'AGENT_ATTACH_CONTROL_PLANE_REJECTED',
        response?.status || 502,
        `CodeSite control plane rejected the lifecycle request (${response?.status || 'unknown'}).`,
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw attachError('AGENT_ATTACH_RESPONSE_TOO_LARGE', 502, 'CodeSite lifecycle response exceeded its size limit.');
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch (error) {
      throw attachError('AGENT_ATTACH_RESPONSE_INVALID', 502, 'CodeSite lifecycle response was not valid JSON.', error);
    }
  }

  async function attach(input = {}) {
    const payload = buildAgentAttachPayload(input);
    const result = await post(
      input.workspaceSlug,
      `/projects/${encodeURIComponent(payload.projectId)}/agent-sessions/attach`,
      payload.body,
    );
    const agentSessionId = String(result?.session?.id || '').trim();
    if (!agentSessionId || agentSessionId.length > 256) {
      throw attachError('AGENT_ATTACH_RESPONSE_SESSION_REQUIRED', 502, 'CodeSite attach response did not include a valid session identity.');
    }
    return {
      ...result,
      binding: Object.freeze({
        agentSessionId,
        projectId: payload.projectId,
        ...payload.body,
      }),
    };
  }

  async function lifecycle(action, input = {}) {
    const agentSessionId = required(input.agentSessionId, 'AGENT_ATTACH_SESSION_REQUIRED');
    const payload = buildAgentAttachPayload(input);
    const body = {
      ...payload.body,
      ...(action === 'detach' ? {
        reason: String(input.reason || 'terminal_detached').slice(0, 120),
        ended: input.ended === true,
      } : {}),
    };
    return post(
      input.workspaceSlug,
      `/agent-sessions/${encodeURIComponent(agentSessionId)}/${action}`,
      body,
    );
  }

  return Object.freeze({
    attach,
    heartbeat: (input) => lifecycle('heartbeat', input),
    detach: (input) => lifecycle('detach', input),
  });
}

module.exports = {
  buildAgentAttachPayload,
  createAgentSessionAttachService,
  normalizeAgentBindingClaim,
};
