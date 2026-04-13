/**
 * sseService.js — Server-Sent Events pipeline for Synthi IDE
 *
 * Provides a unidirectional server→client push channel for low-frequency
 * state-change notifications:
 *   - git-status-changed   (replaces the 30s polling interval in GitStatus.jsx)
 *   - file-tree-changed    (replaces fsWatcher → WS → poll roundtrip)
 *   - file-saved           (external save confirmation)
 *   - build-completed      (CI/preview build result)
 *   - workspace-presence   (replaces the 5s HTTP poll in useWorkspacePresence)
 *   - healing-stats-update (replaces the 30s poll in useHealingStats)
 *   - code-intel-metrics   (replaces the 10s poll in useCodeIntelMetrics)
 *
 * The frontend creates a single EventSource per workspace session.
 * The backend pushes discrete events — the client NEVER polls for these.
 *
 * Transport: HTTP/2-friendly text/event-stream over GET /sse/:slug
 *
 * Architecture:
 *   - One SSE connection per workspace tab (slug-scoped)
 *   - Heartbeat every 15s to keep the connection alive through proxies
 *   - Automatic reconnect via EventSource spec (browser handles retry)
 *   - In-memory client registry with O(1) slug-scoped broadcast
 */

'use strict';

// ── Client Registry ──────────────────────────────────────────────────────────

/** @type {Map<string, Set<import('http').ServerResponse>>} slug → Set<res> */
const clientsBySlug = new Map();

/** @type {Set<import('http').ServerResponse>} all connected clients (for global events) */
const allClients = new Set();

const HEARTBEAT_INTERVAL_MS = 15_000;

// ── SSE Formatting ───────────────────────────────────────────────────────────

/**
 * Format a Server-Sent Event message.
 * @param {string} event — event type (maps to EventSource.addEventListener)
 * @param {object|string} data — payload (will be JSON-stringified if object)
 * @param {string} [id] — optional event ID for Last-Event-ID recovery
 * @returns {string}
 */
function formatSSE(event, data, id) {
  let msg = '';
  if (id) msg += `id: ${id}\n`;
  msg += `event: ${event}\n`;
  msg += `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
  return msg;
}

// ── Connection Handler ───────────────────────────────────────────────────────

/**
 * Handle an incoming SSE connection request.
 * Called from the main HTTP request handler in server.js.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} slug — workspace slug extracted from URL
 * @param {string|null} userId — authenticated user ID from header/query
 */
function handleSSEConnection(req, res, slug, userId) {
  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
  });

  // Send initial connection confirmation
  res.write(formatSSE('connected', { slug, userId, timestamp: Date.now() }));

  // Register client
  res._slug = slug;
  res._userId = userId;

  if (!clientsBySlug.has(slug)) {
    clientsBySlug.set(slug, new Set());
  }
  clientsBySlug.get(slug).add(res);
  allClients.add(res);

  console.log(`[SSE] Client connected — slug=${slug}, userId=${userId}, total=${allClients.size}`);

  // Heartbeat to prevent proxy timeout
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    allClients.delete(res);
    const slugClients = clientsBySlug.get(slug);
    if (slugClients) {
      slugClients.delete(res);
      if (slugClients.size === 0) clientsBySlug.delete(slug);
    }
    console.log(`[SSE] Client disconnected — slug=${slug}, remaining=${allClients.size}`);
  });
}

// ── Broadcasting ─────────────────────────────────────────────────────────────

/**
 * Broadcast an event to all SSE clients watching a specific workspace.
 * @param {string} slug — target workspace
 * @param {string} event — event type
 * @param {object} data — event payload
 */
function broadcastToSlug(slug, event, data) {
  const clients = clientsBySlug.get(slug);
  if (!clients || clients.size === 0) return;

  const message = formatSSE(event, { ...data, slug, timestamp: Date.now() });
  let delivered = 0;

  for (const res of clients) {
    try {
      res.write(message);
      delivered++;
    } catch (_) {
      // Client disconnected — will be cleaned up on 'close' event
    }
  }

  if (delivered > 0) {
    console.log(`[SSE] Broadcast "${event}" to ${delivered} client(s) for slug=${slug}`);
  }
}

/**
 * Broadcast an event to a specific user across all their SSE connections.
 * @param {string} userId — target user
 * @param {string} event — event type
 * @param {object} data — event payload
 */
function broadcastToUser(userId, event, data) {
  const message = formatSSE(event, { ...data, timestamp: Date.now() });
  for (const res of allClients) {
    if (res._userId === userId) {
      try { res.write(message); } catch (_) {}
    }
  }
}

/**
 * Broadcast an event to ALL connected SSE clients (global announcement).
 * @param {string} event — event type
 * @param {object} data — event payload
 */
function broadcastGlobal(event, data) {
  const message = formatSSE(event, { ...data, timestamp: Date.now() });
  for (const res of allClients) {
    try { res.write(message); } catch (_) {}
  }
}

// ── Convenience Emitters (called from server.js/gitService.js) ───────────────

function emitGitStatusChanged(slug, filePath = null) {
  broadcastToSlug(slug, 'git-status-changed', { filePath });
}

function emitFileTreeChanged(slug, events = []) {
  broadcastToSlug(slug, 'file-tree-changed', { events });
}

function emitFileSaved(slug, filePath) {
  broadcastToSlug(slug, 'file-saved', { filePath });
}

function emitFileReverted(slug, filePaths = []) {
  broadcastToSlug(slug, 'file-reverted', { filePaths });
}

function emitBuildCompleted(slug, result) {
  broadcastToSlug(slug, 'build-completed', result);
}

function emitWorkspacePresence(slug, presenceData) {
  broadcastToSlug(slug, 'workspace-presence', presenceData);
}

function emitHealingStats(slug, stats) {
  broadcastToSlug(slug, 'healing-stats-update', stats);
}

function emitCodeIntelMetrics(slug, metrics) {
  broadcastToSlug(slug, 'code-intel-metrics', metrics);
}

// ── Stats ────────────────────────────────────────────────────────────────────

function getStats() {
  const slugBreakdown = {};
  for (const [slug, clients] of clientsBySlug) {
    slugBreakdown[slug] = clients.size;
  }
  return {
    totalConnections: allClients.size,
    slugs: slugBreakdown,
  };
}

module.exports = {
  handleSSEConnection,
  broadcastToSlug,
  broadcastToUser,
  broadcastGlobal,
  emitGitStatusChanged,
  emitFileTreeChanged,
  emitFileSaved,
  emitFileReverted,
  emitBuildCompleted,
  emitWorkspacePresence,
  emitHealingStats,
  emitCodeIntelMetrics,
  getStats,
};
