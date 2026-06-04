'use client';

// AgentWorkflowClient - direct browser client for the MCP browser workflow
// bridge (mcp/synthi-mcp/src/browser_workflow_bridge/server.ts).
//
// Config:
//   NEXT_PUBLIC_SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL - default http://127.0.0.1:9466
//   Optional header X-Synthi-Workflow-Token is supplied via localStorage or
//   explicit options when the bridge is token-gated.

const DEFAULT_URL = 'http://127.0.0.1:9466';

export function resolveAgentWorkflowBridgeUrl() {
  if (typeof window === 'undefined') return DEFAULT_URL;
  const fromStorage = window.localStorage?.getItem('synthi.agentWorkflowBridgeUrl');
  if (fromStorage) return fromStorage;
  const fromEnv =
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL) || '';
  return fromEnv || DEFAULT_URL;
}

export function resolveAgentWorkflowBridgeToken() {
  if (typeof window === 'undefined') return '';
  return window.localStorage?.getItem('synthi.agentWorkflowBridgeToken') || '';
}

function bridgeHeaders(token, includeJson = false) {
  const headers = {};
  if (includeJson) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Synthi-Workflow-Token'] = token;
  return headers;
}

async function readJsonOrEmpty(res) {
  return res.json().catch(() => ({}));
}

function bridgeError(prefix, status, body) {
  const code = body?.error || `${prefix}_${status}`;
  const detail = body?.detail || body?.message || '';
  return new Error(detail ? `${code}: ${detail}` : code);
}

export async function getAgentWorkflowState({ url, token, signal } = {}) {
  const bridgeUrl = url || resolveAgentWorkflowBridgeUrl();
  const bridgeToken = token ?? resolveAgentWorkflowBridgeToken();
  const res = await fetch(`${bridgeUrl}/browser-workflows/state`, {
    headers: bridgeHeaders(bridgeToken),
    signal,
  });
  const body = await readJsonOrEmpty(res);
  if (!res.ok) throw bridgeError('workflow_state_failed', res.status, body);
  return body?.state || body;
}

export async function callAgentWorkflowTool({
  url,
  token,
  tool,
  arguments: args = {},
  signal,
}) {
  const bridgeUrl = url || resolveAgentWorkflowBridgeUrl();
  const bridgeToken = token ?? resolveAgentWorkflowBridgeToken();
  const res = await fetch(`${bridgeUrl}/browser-workflows/tool`, {
    method: 'POST',
    headers: bridgeHeaders(bridgeToken, true),
    body: JSON.stringify({ tool, arguments: args }),
    signal,
  });
  const body = await readJsonOrEmpty(res);
  if (!res.ok) throw bridgeError('workflow_tool_failed', res.status, body);
  return body;
}
