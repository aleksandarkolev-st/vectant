/**
 * Server-owned capabilities for the legacy chat agent types.  The client may
 * ask for a smaller set, but it can never expand this policy.
 */
export const AGENT_ROLE_ALIASES = Object.freeze({
  reader: 'research',
  searcher: 'research',
  analyzer: 'debugging',
  planner: 'implementation',
  executor: 'implementation',
});

export const SERVER_AGENT_TOOL_POLICY = Object.freeze({
  reader: Object.freeze(['read_file', 'list_directory']),
  searcher: Object.freeze(['grep_search', 'read_file']),
  analyzer: Object.freeze(['get_diagnostics']),
  planner: Object.freeze(['list_directory', 'read_file']),
  executor: Object.freeze([]),
});

function normalizeToolIds(values) {
  const list = Array.isArray(values) ? values : [];
  return [...new Set(list
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
}

export function isSupportedAgentType(agentType) {
  return Object.hasOwn(SERVER_AGENT_TOOL_POLICY, String(agentType || '').trim());
}

export function agentRoleForType(agentType) {
  return AGENT_ROLE_ALIASES[String(agentType || '').trim()] || null;
}

export function getServerAllowedToolIds(agentType) {
  const allowed = SERVER_AGENT_TOOL_POLICY[String(agentType || '').trim()] || [];
  return [...allowed];
}

/**
 * Treat requested tools as an optional narrowing request.  Unknown or
 * cross-role tool names are deliberately discarded rather than becoming a
 * capability decision made by the browser.
 */
export function selectServerAllowedTools(agentType, requestedTools, { requestProvided = false } = {}) {
  const allowedToolIds = getServerAllowedToolIds(agentType);
  const requestedToolIds = normalizeToolIds(requestedTools);
  const selectedToolIds = requestProvided
    ? allowedToolIds.filter((toolId) => requestedToolIds.includes(toolId))
    : allowedToolIds;

  return {
    allowedToolIds,
    requestedToolIds,
    selectedToolIds,
    rejectedToolIds: requestedToolIds.filter((toolId) => !allowedToolIds.includes(toolId)),
  };
}

/**
 * A browser may only reduce an already-authoritative selection.  In
 * particular, callers must never be able to turn an empty routed selection
 * back into this module's broader static allowlist by omitting a field.
 */
export function narrowAuthoritativeIds(authoritativeIds, requestedIds, {
  requestProvided = false,
} = {}) {
  const allowedIds = normalizeToolIds(authoritativeIds);
  const requested = normalizeToolIds(requestedIds);
  const selectedIds = requestProvided
    ? allowedIds.filter((id) => requested.includes(id))
    : allowedIds;

  return {
    allowedIds,
    requestedIds: requested,
    selectedIds,
    rejectedIds: requested.filter((id) => !allowedIds.includes(id)),
  };
}
