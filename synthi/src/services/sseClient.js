/**
 * sseClient.js — Frontend SSE (Server-Sent Events) client for Synthi IDE
 *
 * Establishes a single persistent EventSource connection per workspace slug
 * that receives push notifications from the backend. This replaces ALL
 * HTTP polling intervals for:
 *   - git-status-changed    (was: 30s setInterval in GitStatus.jsx)
 *   - file-tree-changed     (was: WS → poll roundtrip)
 *   - file-saved            (was: WS notification)
 *   - file-reverted         (was: WS notification)
 *   - workspace-presence    (was: 5s HTTP poll in useWorkspacePresence)
 *   - healing-stats-update  (was: 30s HTTP poll in useHealingStats)
 *   - code-intel-metrics    (was: 10s HTTP poll in useCodeIntelMetrics)
 *   - build-completed       (was: not previously pushed)
 *
 * Architecture:
 *   - Singleton per slug (calling connect() twice with the same slug is a no-op)
 *   - Automatic reconnection via EventSource spec (browser handles retry)
 *   - Typed event listeners with cleanup support
 *   - Falls back gracefully if SSE endpoint is unavailable
 */

const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';

/** @type {Map<string, EventSource>} slug → EventSource */
const connections = new Map();

/** @type {Map<string, Map<string, Set<Function>>>} slug → eventType → Set<listener> */
const listeners = new Map();

/** @type {Map<string, string>} slug → connection status */
const connectionStatus = new Map();

// ── Internal Helpers ─────────────────────────────────────────────────────────

function getOrCreateListenerMap(slug) {
  if (!listeners.has(slug)) {
    listeners.set(slug, new Map());
  }
  return listeners.get(slug);
}

function emit(slug, eventType, data) {
  const listenerMap = listeners.get(slug);
  if (!listenerMap) return;

  const handlers = listenerMap.get(eventType);
  if (!handlers) return;

  for (const fn of handlers) {
    try {
      fn(data);
    } catch (err) {
      console.error(`[SSE] Error in listener for "${eventType}":`, err);
    }
  }

  // Also emit to wildcard listeners
  const wildcardHandlers = listenerMap.get('*');
  if (wildcardHandlers) {
    for (const fn of wildcardHandlers) {
      try {
        fn({ type: eventType, ...data });
      } catch (err) {
        console.error(`[SSE] Error in wildcard listener:`, err);
      }
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Connect to the SSE endpoint for a workspace.
 * Idempotent — calling with the same slug returns the existing connection.
 *
 * @param {string} slug — Workspace slug
 * @param {object} [opts]
 * @param {string} [opts.userId] — Authenticated user ID
 * @returns {EventSource}
 */
function connect(slug, { userId = null } = {}) {
  if (connections.has(slug)) {
    return connections.get(slug);
  }

  const params = new URLSearchParams();
  if (userId) params.set('userId', userId);

  const url = `${COLLAB_SERVER_URL}/sse/${encodeURIComponent(slug)}${params.toString() ? `?${params}` : ''}`;

  let es;
  try {
    es = new EventSource(url);
  } catch (err) {
    console.warn('[SSE] EventSource not available or URL invalid:', err);
    connectionStatus.set(slug, 'error');
    return null;
  }

  connections.set(slug, es);
  connectionStatus.set(slug, 'connecting');

  // ── Wire up standard event types ────────────────────────────────────────
  const eventTypes = [
    'connected',
    'git-status-changed',
    'file-tree-changed',
    'file-saved',
    'file-reverted',
    'build-completed',
    'workspace-presence',
    'healing-stats-update',
    'code-intel-metrics',
  ];

  for (const type of eventTypes) {
    es.addEventListener(type, (event) => {
      try {
        const data = JSON.parse(event.data);
        if (type === 'connected') {
          connectionStatus.set(slug, 'connected');
          console.log(`[SSE] Connected to workspace "${slug}"`);
        }
        emit(slug, type, data);
      } catch (err) {
        console.warn(`[SSE] Failed to parse event "${type}":`, err);
      }
    });
  }

  es.onerror = () => {
    const status = connectionStatus.get(slug);
    if (status !== 'disconnected') {
      connectionStatus.set(slug, 'reconnecting');
      console.warn(`[SSE] Connection error for slug="${slug}", browser will auto-retry`);
    }
  };

  return es;
}

/**
 * Disconnect the SSE connection for a workspace.
 * @param {string} slug
 */
function disconnect(slug) {
  const es = connections.get(slug);
  if (es) {
    connectionStatus.set(slug, 'disconnected');
    es.close();
    connections.delete(slug);
    listeners.delete(slug);
    console.log(`[SSE] Disconnected from workspace "${slug}"`);
  }
}

/**
 * Subscribe to a specific SSE event type for a workspace.
 *
 * @param {string} slug — Workspace slug
 * @param {string} eventType — Event type (e.g. 'git-status-changed') or '*' for all
 * @param {Function} callback — Handler receiving the parsed event data
 * @returns {Function} Unsubscribe function
 */
function on(slug, eventType, callback) {
  const listenerMap = getOrCreateListenerMap(slug);

  if (!listenerMap.has(eventType)) {
    listenerMap.set(eventType, new Set());
  }
  listenerMap.get(eventType).add(callback);

  return () => {
    const handlers = listenerMap.get(eventType);
    if (handlers) {
      handlers.delete(callback);
      if (handlers.size === 0) listenerMap.delete(eventType);
    }
  };
}

/**
 * Subscribe to an event type, automatically unsubscribing after the first call.
 *
 * @param {string} slug
 * @param {string} eventType
 * @param {Function} callback
 * @returns {Function} Unsubscribe (in case you want to cancel before it fires)
 */
function once(slug, eventType, callback) {
  const unsub = on(slug, eventType, (data) => {
    unsub();
    callback(data);
  });
  return unsub;
}

/**
 * Get the current SSE connection status for a workspace.
 * @param {string} slug
 * @returns {'disconnected'|'connecting'|'connected'|'reconnecting'|'error'}
 */
function getStatus(slug) {
  return connectionStatus.get(slug) || 'disconnected';
}

/**
 * Check if SSE is connected and active for a workspace.
 * @param {string} slug
 * @returns {boolean}
 */
function isConnected(slug) {
  return connectionStatus.get(slug) === 'connected';
}

export const sseClient = {
  connect,
  disconnect,
  on,
  once,
  getStatus,
  isConnected,
};

export default sseClient;
