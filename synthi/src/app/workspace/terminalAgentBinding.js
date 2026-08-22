const AGENT_PROJECT_ID_RE = /^[A-Za-z0-9._:@-]{1,256}$/;
const AGENT_PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const AGENT_PROVIDER_SESSION_RE = /^[\x21-\x7e]{1,256}$/;
const AGENT_COMMAND_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_AGENT_COMMAND_LENGTH = 1024;

function invalidBinding() {
  const error = new Error('invalid_terminal_agent_binding');
  error.code = error.message;
  return error;
}

export function normalizeTerminalAgentBinding(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidBinding();

  const projectId = String(value.projectId || '').trim();
  const provider = String(value.provider || '').trim().toLowerCase();
  const providerSessionRef = String(value.providerSessionRef || '').trim();
  if (
    !AGENT_PROJECT_ID_RE.test(projectId)
    || !AGENT_PROVIDER_RE.test(provider)
    || !AGENT_PROVIDER_SESSION_RE.test(providerSessionRef)
  ) {
    throw invalidBinding();
  }

  return Object.freeze({ projectId, provider, providerSessionRef });
}

export function normalizeAgentLaunchCommand(value) {
  const command = typeof value === 'string' ? value.trim() : '';
  if (
    !command
    || command.length > MAX_AGENT_COMMAND_LENGTH
    || AGENT_COMMAND_CONTROL_RE.test(command)
  ) {
    const error = new Error('invalid_terminal_agent_launch_command');
    error.code = error.message;
    throw error;
  }
  return command;
}

function secureProviderSessionRef() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('secure_agent_session_reference_unavailable');
}

export function createTerminalAgentLaunch({
  projectId,
  provider,
  command,
  createProviderSessionRef = secureProviderSessionRef,
} = {}) {
  const providerSessionRef = createProviderSessionRef();
  return Object.freeze({
    binding: normalizeTerminalAgentBinding({ projectId, provider, providerSessionRef }),
    command: normalizeAgentLaunchCommand(command),
  });
}

export function normalizeTerminalAgentLaunch({ binding = null, command = null } = {}) {
  const hasBinding = binding != null;
  const hasCommand = typeof command === 'string' && Boolean(command.trim());
  if (!hasBinding && !hasCommand) return null;
  if (!hasBinding || !hasCommand) {
    const error = new Error('incomplete_terminal_agent_launch');
    error.code = error.message;
    throw error;
  }
  return Object.freeze({
    binding: normalizeTerminalAgentBinding(binding),
    command: normalizeAgentLaunchCommand(command),
  });
}

export function agentStartupInputForReady(launch, readyFrame, startedSessionIds) {
  if (!launch || readyFrame?.type !== 'ready' || readyFrame.reattached !== false) return null;
  const sessionId = typeof readyFrame.sessionId === 'string' ? readyFrame.sessionId.trim() : '';
  if (!sessionId || startedSessionIds.has(sessionId)) return null;
  startedSessionIds.add(sessionId);
  return `${launch.command}\r`;
}

export function appendTerminalAgentBindingParams(params, value) {
  const binding = normalizeTerminalAgentBinding(value);
  if (!binding) return params;
  params.set('codeSiteProjectId', binding.projectId);
  params.set('agentProvider', binding.provider);
  params.set('providerSessionRef', binding.providerSessionRef);
  return params;
}

export function terminalAgentBindingMatches(left, right) {
  try {
    const normalizedLeft = normalizeTerminalAgentBinding(left);
    const normalizedRight = normalizeTerminalAgentBinding(right);
    if (!normalizedLeft || !normalizedRight) return normalizedLeft === normalizedRight;
    return normalizedLeft.projectId === normalizedRight.projectId
      && normalizedLeft.provider === normalizedRight.provider
      && normalizedLeft.providerSessionRef === normalizedRight.providerSessionRef;
  } catch (_) {
    return false;
  }
}

export function assertGatewayAgentBinding(requested, returned) {
  if (!terminalAgentBindingMatches(requested, returned)) {
    const error = new Error('terminal_gateway_agent_binding_mismatch');
    error.code = error.message;
    throw error;
  }
  return normalizeTerminalAgentBinding(requested);
}

export async function requestTerminalGatewayToken(workspaceSlug, {
  collabSessionId = '',
  agentBinding = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const params = new URLSearchParams({
    workspaceSlug,
    scopes: 'collab:terminal',
  });
  if (collabSessionId) params.set('collabSessionId', collabSessionId);
  appendTerminalAgentBindingParams(params, agentBinding);

  const response = await fetchImpl(`/api/auth/token?${params.toString()}`, {
    method: 'GET',
    credentials: 'same-origin',
  });
  const text = await response.text().catch(() => '');
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = { error: text }; }
  if (!response.ok || !payload.token) {
    throw new Error(payload.error || `terminal_auth_failed_${response.status}`);
  }
  assertGatewayAgentBinding(agentBinding, payload.agentBinding || null);
  return payload;
}
