'use client';

// EscapeHatchClient — thin HTTP + SSE client for the MCP's operator
// bridge (mcp/synthi-mcp/src/operator_bridge/server.ts). The bridge runs
// inside the MCP subprocess on an opt-in port (SYNTHI_OPERATOR_BRIDGE_PORT);
// it exposes the pending escape-hatch queue so this UI can list questions
// an agent has asked and let the operator answer them.
//
// We talk to it directly from the browser because the signaling-server
// has no visibility into the queue — the queue is MCP-process-local state
// by design.
//
// Config:
//   NEXT_PUBLIC_SYNTHI_OPERATOR_BRIDGE_URL — default http://127.0.0.1:9465
//   Optional bearer-style header X-Synthi-Operator-Token is supplied
//   via the `token` option (pulled from localStorage by the panel).

const DEFAULT_URL = 'http://127.0.0.1:9465';

export function resolveBridgeUrl() {
  if (typeof window === 'undefined') return DEFAULT_URL;
  const fromStorage = window.localStorage?.getItem('synthi.operatorBridgeUrl');
  if (fromStorage) return fromStorage;
  const fromEnv =
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_SYNTHI_OPERATOR_BRIDGE_URL) || '';
  return fromEnv || DEFAULT_URL;
}

export function resolveBridgeToken() {
  if (typeof window === 'undefined') return '';
  return window.localStorage?.getItem('synthi.operatorBridgeToken') || '';
}

function authHeaders(token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['X-Synthi-Operator-Token'] = token;
  return h;
}

export async function listPending({ url, token }) {
  const res = await fetch(`${url}/escape-hatch/queue`, {
    headers: token ? { 'X-Synthi-Operator-Token': token } : {},
  });
  if (!res.ok) {
    throw new Error(`list_failed_${res.status}`);
  }
  return res.json();
}

export async function getPending({ url, token, pendingId }) {
  const res = await fetch(`${url}/escape-hatch/queue/${encodeURIComponent(pendingId)}`, {
    headers: token ? { 'X-Synthi-Operator-Token': token } : {},
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get_failed_${res.status}`);
  const body = await res.json();
  return body.entry;
}

export async function sendAnswer({ url, token, pendingId, answer, operatorId }) {
  const res = await fetch(`${url}/escape-hatch/answer`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      pending_id: pendingId,
      answer,
      ...(operatorId ? { operator_id: operatorId } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `answer_failed_${res.status}`);
  }
  return res.json();
}

export async function cancelPending({ url, token, pendingId, reason }) {
  const res = await fetch(`${url}/escape-hatch/answer`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      pending_id: pendingId,
      cancel: true,
      ...(reason ? { cancel_reason: reason } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `cancel_failed_${res.status}`);
  }
  return res.json();
}

/**
 * Subscribe to the bridge's SSE stream. onEvent is called with
 * `{type, data}` for each `event:` received. Returns an unsubscribe fn.
 * Falls back to silent-disconnect if EventSource is unavailable (SSR).
 *
 * EventSource can't attach custom headers, so if the bridge is token-
 * gated consumers should fall back to polling instead.
 */
export function subscribeSse({ url, onEvent, onError }) {
  if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
    return () => {};
  }
  const es = new window.EventSource(`${url}/escape-hatch/events`);
  const handler = (type) => (evt) => {
    try {
      const data = evt.data ? JSON.parse(evt.data) : null;
      onEvent({ type, data });
    } catch (err) {
      onError?.(err);
    }
  };
  ['hello', 'snapshot', 'pending', 'resolved'].forEach((t) => {
    es.addEventListener(t, handler(t));
  });
  es.onerror = (err) => onError?.(err);
  return () => {
    es.close();
  };
}
