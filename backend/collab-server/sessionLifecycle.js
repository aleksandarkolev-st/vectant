/**
 * Session lifecycle tracker — uniform view of preview-session state
 * across spawner backends (process / local docker / k8s).
 *
 * Wire states (matches `mcp/synthi-mcp/src/events/types.ts::SessionState`):
 *   warming     — ensurePod started, worker not yet WebRTC-ready
 *   ready       — worker is up + advertised via signaling-server
 *   running     — at least one peer attached
 *   hibernated  — culled or paused (phase 2+)
 *   migrating   — operator-initiated move; mcp sees the flag + awaits ready
 *   crashed     — worker process exited unexpectedly
 *   terminated  — session torn down; handle released
 *
 * This module is in-memory only. The source of truth for "is the
 * container up?" is the spawner; for "is someone attached?" it's the
 * signaling-server. We layer an advisory state on top so the MCP + an
 * operator UI can poll a single endpoint and see everything.
 *
 * Wire: GET /api/session/:id/lifecycle, POST /api/session/:id/warm,
 * POST /api/session/:id/migrate.
 */

const VALID_STATES = Object.freeze([
  "warming",
  "ready",
  "running",
  "hibernated",
  "migrating",
  "crashed",
  "terminated",
  "unknown",
]);

/**
 * sessionId -> {
 *   state: string,
 *   state_ts: number,
 *   warming_progress?: {stage, stage_progress_pct, estimated_ready_at},
 *   migrating_to?: string,
 *   reason?: string,
 *   last_peer_count?: number,
 * }
 */
const sessions = new Map();

function now() {
  return Date.now();
}

function getState(sessionId) {
  return sessions.get(sessionId) ?? null;
}

function setState(sessionId, partial) {
  if (!sessionId) return null;
  const prev = sessions.get(sessionId) ?? {};
  const next = {
    ...prev,
    ...partial,
    state_ts: now(),
  };
  if (partial.state && !VALID_STATES.includes(partial.state)) {
    next.state = "unknown";
    next.raw_state = partial.state;
  }
  sessions.set(sessionId, next);
  return next;
}

function markWarming(sessionId, progress = {}) {
  return setState(sessionId, {
    state: "warming",
    warming_progress: {
      stage: progress.stage ?? "spawn",
      stage_progress_pct: Math.max(0, Math.min(100, Math.floor(progress.stage_progress_pct ?? 0))),
      estimated_ready_at: progress.estimated_ready_at ?? now() + 30_000,
    },
  });
}

function markReady(sessionId) {
  return setState(sessionId, {
    state: "ready",
    warming_progress: undefined,
  });
}

function markRunning(sessionId, peerCount = 1) {
  return setState(sessionId, {
    state: "running",
    last_peer_count: peerCount,
  });
}

function markHibernated(sessionId) {
  return setState(sessionId, { state: "hibernated" });
}

function markMigrating(sessionId, target = null, reason = null) {
  return setState(sessionId, {
    state: "migrating",
    migrating_to: target,
    reason,
  });
}

function markCrashed(sessionId, reason = null) {
  return setState(sessionId, { state: "crashed", reason });
}

function markTerminated(sessionId, reason = null) {
  const next = setState(sessionId, { state: "terminated", reason });
  // Don't drop the entry immediately — a late poller deserves the
  // "terminated" response rather than a 404. Evict after a grace window.
  setTimeout(() => {
    const cur = sessions.get(sessionId);
    if (cur && cur.state === "terminated") sessions.delete(sessionId);
  }, 5 * 60 * 1000).unref?.();
  return next;
}

function snapshot(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) {
    return {
      session_id: sessionId,
      state: "unknown",
      state_ts: now(),
      tracked: false,
    };
  }
  return {
    session_id: sessionId,
    tracked: true,
    ...entry,
  };
}

function allSnapshots() {
  const out = [];
  for (const [sid, entry] of sessions) {
    out.push({ session_id: sid, tracked: true, ...entry });
  }
  return out;
}

module.exports = {
  VALID_STATES,
  getState,
  setState,
  markWarming,
  markReady,
  markRunning,
  markHibernated,
  markMigrating,
  markCrashed,
  markTerminated,
  snapshot,
  allSnapshots,
};
