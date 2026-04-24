/**
 * persistence.js — Optional Redis-backed persistence for collab state.
 *
 * Keeps the in-memory maps (SessionManager, blockedBy) as the source of
 * truth for hot-path reads.  Mutations are mirrored to Redis in the
 * background; on server boot we reload from Redis so sessions + blocks
 * survive restarts.
 *
 * Additional persistence beyond sessions/blocks:
 *   - File activity log: per-file event stream (saves, reverts, stages),
 *     bounded to the last N entries with a TTL so disk usage is bounded.
 *   - File version history: snapshots of file content at save boundaries
 *     so users can recover from accidental overwrites even after Y-Sweet
 *     / Monaco undo has been cleared.  Content >MAX_VERSION_BYTES is
 *     stored as metadata only (hash + size) to avoid bloating Redis.
 *
 * If REDIS_URL is unset or the `redis` package isn't installed, the
 * adapter degrades to a no-op — behaviour is identical to the previous
 * in-memory-only mode.
 *
 * Dependencies are resolved via a lazy require() so the collab server
 * has no hard dependency on a Redis client; operators opting in run
 * `npm install redis` themselves.
 */

const logger = require('./logger').child({ component: 'persistence' });
const crypto = require('crypto');

const REDIS_URL = process.env.REDIS_URL || null;
const KEY_PREFIX = process.env.COLLAB_REDIS_PREFIX || 'collab:';
const SESSION_KEY = (id) => `${KEY_PREFIX}session:${id}`;
const SESSION_INDEX_KEY = `${KEY_PREFIX}session:index`;
const BLOCK_KEY = (userId) => `${KEY_PREFIX}block:${userId}`;
const BLOCK_INDEX_KEY = `${KEY_PREFIX}block:index`;
// File activity + version keys are keyed by slug + filePath hash so that
// arbitrary path characters don't collide with Redis key syntax.
const FILE_EVENT_KEY = (slug, filePath) => `${KEY_PREFIX}file:${slug}:${hashPath(filePath)}:events`;
const FILE_VERSION_KEY = (slug, filePath) => `${KEY_PREFIX}file:${slug}:${hashPath(filePath)}:versions`;
// Offline event inbox: events destined for a user who was disconnected
// when the event was fired land here; their next WS connect drains + delivers
// them so nothing is silently lost.
const USER_INBOX_KEY = (userId) => `${KEY_PREFIX}user:${userId}:inbox`;

// Sessions never outlive the token TTL, so let Redis expire them even if a
// server crash prevents explicit deletion.
const SESSION_TTL_SEC = Number(process.env.COLLAB_REDIS_SESSION_TTL_SEC) || 86_400;
const BLOCK_TTL_SEC   = Number(process.env.COLLAB_REDIS_BLOCK_TTL_SEC) || 180 * 86_400;
const EVENT_TTL_SEC   = Number(process.env.COLLAB_REDIS_EVENT_TTL_SEC) || 30 * 86_400;
const VERSION_TTL_SEC = Number(process.env.COLLAB_REDIS_VERSION_TTL_SEC) || 7 * 86_400;
const INBOX_TTL_SEC   = Number(process.env.COLLAB_REDIS_INBOX_TTL_SEC) || 14 * 86_400;

// Caps to keep per-file lists bounded.  LTRIM runs after every push so
// lists never exceed these bounds.
const MAX_EVENTS_PER_FILE   = Number(process.env.COLLAB_REDIS_MAX_EVENTS) || 100;
const MAX_VERSIONS_PER_FILE = Number(process.env.COLLAB_REDIS_MAX_VERSIONS) || 10;
const MAX_INBOX_PER_USER    = Number(process.env.COLLAB_REDIS_MAX_INBOX) || 50;
// Per-version content cap.  Larger files save only metadata (hash + size).
const MAX_VERSION_BYTES     = Number(process.env.COLLAB_REDIS_MAX_VERSION_BYTES) || 128 * 1024;

// Retry + queue tunables.  RETRY_ATTEMPTS runs with exponential backoff +
// jitter before the write is either queued (if Redis is down) or dropped
// (if it failed for a non-transient reason while Redis was up).
const RETRY_ATTEMPTS        = 3;
const RETRY_BASE_MS         = 100;
const RETRY_MAX_MS          = 2_000;
const WRITE_QUEUE_MAX_SIZE  = 1_000;

let client = null;
let connecting = false;
let available = false;

// Tasks queued while Redis is unavailable.  Drained in FIFO order once the
// client signals it's reconnected + ready.  Bounded so a long outage
// doesn't balloon memory; overflows drop the oldest pending write.
const writeQueue = [];
let draining = false;

function hashPath(filePath) {
  // SHA1 truncated — not a secret, just a stable, bounded, Redis-safe key
  // segment for arbitrary file paths.
  return crypto.createHash('sha1').update(filePath || '').digest('hex').slice(0, 16);
}

async function connect() {
  if (client || connecting) return client;
  if (!REDIS_URL) {
    logger.info('persistence_disabled', { reason: 'no_REDIS_URL' });
    return null;
  }
  connecting = true;
  try {
    let redis;
    try {
      redis = require('redis');
    } catch (err) {
      logger.warn('persistence_disabled', { reason: 'redis_module_missing' }, err);
      return null;
    }
    const c = redis.createClient({ url: REDIS_URL });
    c.on('error', (err) => logger.error('redis_error', {}, err));
    c.on('end', () => {
      available = false;
      logger.warn('redis_disconnected', { queued: writeQueue.length });
    });
    c.on('reconnecting', () => logger.info('redis_reconnecting'));
    // `ready` fires after the client has completed its handshake + AUTH
    // and is able to accept commands.  Use it rather than `connect` so
    // the drain doesn't race the first command.
    c.on('ready', () => {
      available = true;
      if (writeQueue.length) {
        logger.info('redis_ready_draining', { queued: writeQueue.length });
        drainQueue();
      }
    });
    await c.connect();
    client = c;
    available = true;
    logger.info('redis_connected', { url: sanitizeUrl(REDIS_URL) });
    // In case there were writes queued before connect() was first called.
    if (writeQueue.length) drainQueue();
    return client;
  } catch (err) {
    logger.error('redis_connect_failed', { url: sanitizeUrl(REDIS_URL) }, err);
    return null;
  } finally {
    connecting = false;
  }
}

function sanitizeUrl(url) {
  try { return url.replace(/:[^/@]+@/, ':***@'); }
  catch (_) { return '<redacted>'; }
}

function isAvailable() {
  return available && client !== null;
}

// ── Retry + queue ────────────────────────────────────────────────────────

/**
 * Transient-error detection.  Connection drops, timeouts, and the
 * "client is closed" state are retryable; schema/logic errors (WRONGTYPE,
 * syntax) are not.
 */
function isTransientError(err) {
  if (!err) return false;
  const code = err.code || '';
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return true;
  if (code === 'ENETDOWN' || code === 'ENETUNREACH' || code === 'EPIPE') return true;
  // node-redis v4 surfaces disconnected clients via these classes.
  if (err.name === 'ClientClosedError' || err.name === 'SocketClosedUnexpectedlyError') return true;
  if (err.name === 'ConnectionTimeoutError' || err.name === 'ReconnectStrategyError') return true;
  if (/closed|disconnected|timeout|reconnect/i.test(String(err.message || ''))) return true;
  return false;
}

function jitteredDelay(attempt) {
  const expBase = Math.min(RETRY_BASE_MS * Math.pow(4, attempt - 1), RETRY_MAX_MS);
  // Full-jitter: uniform in [0, expBase] to avoid synchronized retries
  // across a fleet of collab servers all hitting the same Redis.
  return Math.floor(Math.random() * expBase);
}

async function runWithRetry(fn) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === RETRY_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, jitteredDelay(attempt)));
    }
  }
  throw lastErr;
}

function enqueueTask(task) {
  if (writeQueue.length >= WRITE_QUEUE_MAX_SIZE) {
    // Drop the oldest task to make room — better to lose an ancient write
    // than to block the collab server on an unbounded in-memory queue.
    const dropped = writeQueue.shift();
    logger.warn('persistence_queue_overflow', {
      dropped: dropped?.event || 'unknown',
      size: writeQueue.length,
    });
  }
  writeQueue.push(task);
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (writeQueue.length > 0) {
      if (!isAvailable()) break; // Redis went away mid-drain; stop, resume on next ready
      const task = writeQueue.shift();
      try {
        await runWithRetry(task.fn);
      } catch (err) {
        if (isTransientError(err)) {
          // Still not healthy — push back to the head and stop draining.
          writeQueue.unshift(task);
          logger.warn('persistence_drain_paused', { size: writeQueue.length }, err);
          break;
        }
        // Permanent failure — drop the task, log, move on.
        logger.error('persistence_drain_dropped', { event: task.event, ...task.data }, err);
      }
    }
  } finally {
    draining = false;
  }
}

/**
 * Durable-ish write wrapper.
 *   - If Redis is available: retry with backoff; queue only transient failures.
 *   - If Redis is unavailable: queue immediately for drain on reconnect.
 * Never propagates errors — persistence is best-effort from the caller's
 * perspective.
 */
async function safeWrite(fn, event, data = {}) {
  const task = { fn, event, data };
  if (!isAvailable()) {
    enqueueTask(task);
    return;
  }
  try {
    await runWithRetry(fn);
  } catch (err) {
    if (isTransientError(err)) {
      enqueueTask(task);
      logger.warn('persistence_write_queued', { event, ...data }, err);
    } else {
      logger.warn(event, data, err);
    }
  }
}

// ── Session persistence ──────────────────────────────────────────────────

async function saveSession(session) {
  const snapshot = serializeSessionForStorage(session); // capture state NOW
  return safeWrite(async () => {
    const payload = JSON.stringify(snapshot);
    const key = SESSION_KEY(snapshot.id);
    await client
      .multi()
      .set(key, payload, { EX: SESSION_TTL_SEC })
      .sAdd(SESSION_INDEX_KEY, snapshot.id)
      .exec();
  }, 'redis_save_session_failed', { sessionId: snapshot.id });
}

async function deleteSession(sessionId) {
  return safeWrite(async () => {
    await client
      .multi()
      .del(SESSION_KEY(sessionId))
      .sRem(SESSION_INDEX_KEY, sessionId)
      .exec();
  }, 'redis_delete_session_failed', { sessionId });
}

async function loadSessions() {
  if (!isAvailable()) return [];
  try {
    const ids = await runWithRetry(() => client.sMembers(SESSION_INDEX_KEY));
    if (!ids.length) return [];
    const keys = ids.map(SESSION_KEY);
    const raw = await runWithRetry(() => client.mGet(keys));
    const sessions = [];
    const orphans = [];
    for (let i = 0; i < ids.length; i++) {
      const data = raw[i];
      if (!data) { orphans.push(ids[i]); continue; }
      try { sessions.push(JSON.parse(data)); }
      catch (err) { logger.warn('redis_session_parse_failed', { sessionId: ids[i] }, err); orphans.push(ids[i]); }
    }
    if (orphans.length) {
      // Clean up index entries whose payloads have expired.
      await client.sRem(SESSION_INDEX_KEY, orphans).catch(() => {});
    }
    return sessions;
  } catch (err) {
    logger.error('redis_load_sessions_failed', {}, err);
    return [];
  }
}

function serializeSessionForStorage(session) {
  return {
    id: session.id,
    slug: session.slug,
    hostId: session.hostId,
    hostName: session.hostName,
    hostAvatar: session.hostAvatar,
    worktreePath: session.worktreePath,
    inviteToken: session.inviteToken,
    tokenExpiresAt: session.tokenExpiresAt,
    defaultPerms: { ...session.defaultPerms },
    guests: Array.from((session.guests || new Map()).values()),
    pendingKnocks: Array.from(session.pendingKnocks || []),
    invitedUsers: Array.from(session.invitedUsers || []),
    roomCode: session.roomCode || null,
    createdAt: session.createdAt,
    status: session.status,
    hostConfirmed: session.hostConfirmed !== false,
  };
}

// ── Block-list persistence ────────────────────────────────────────────────

async function saveBlock(userId, blockedUserId) {
  return safeWrite(async () => {
    await client
      .multi()
      .sAdd(BLOCK_KEY(userId), blockedUserId)
      .expire(BLOCK_KEY(userId), BLOCK_TTL_SEC)
      .sAdd(BLOCK_INDEX_KEY, userId)
      .exec();
  }, 'redis_save_block_failed', { userId, blockedUserId });
}

async function removeBlock(userId, blockedUserId) {
  return safeWrite(async () => {
    await client.sRem(BLOCK_KEY(userId), blockedUserId);
    const remaining = await client.sCard(BLOCK_KEY(userId));
    if (remaining === 0) {
      await client.sRem(BLOCK_INDEX_KEY, userId);
    }
  }, 'redis_remove_block_failed', { userId, blockedUserId });
}

async function loadBlocks() {
  if (!isAvailable()) return [];
  try {
    const owners = await runWithRetry(() => client.sMembers(BLOCK_INDEX_KEY));
    if (!owners.length) return [];
    const entries = [];
    for (const userId of owners) {
      const blocked = await runWithRetry(() => client.sMembers(BLOCK_KEY(userId)));
      if (blocked && blocked.length) {
        entries.push({ userId, blocked });
      } else {
        await client.sRem(BLOCK_INDEX_KEY, userId).catch(() => {});
      }
    }
    return entries;
  } catch (err) {
    logger.error('redis_load_blocks_failed', {}, err);
    return [];
  }
}

// ── File activity log ────────────────────────────────────────────────────
// Generic event stream for a given (slug, filePath).  Events are stored as
// JSON blobs in a Redis list; new entries are LPUSHed and the list is
// LTRIMmed to MAX_EVENTS_PER_FILE so disk usage stays bounded.
//
// Use this for audit ("who saved this file when?") and for UI history
// panels.  Not a substitute for Y-Sweet — CRDT state still lives there.

/**
 * Record a file event.
 *   kind: 'saved' | 'reverted' | 'staged' | 'discarded' | 'opened' | custom
 *   userId: actor
 *   sessionId: optional — the session this happened inside
 *   hash: optional — content hash at the time of the event
 *   size: optional — content size in bytes
 */
async function logFileEvent(slug, filePath, event) {
  if (!slug || !filePath || !event || !event.kind) return;
  const record = {
    ts: event.ts || Date.now(),
    kind: String(event.kind),
    userId: event.userId || null,
    sessionId: event.sessionId || null,
    hash: event.hash || null,
    size: typeof event.size === 'number' ? event.size : null,
    meta: event.meta || undefined,
  };
  const key = FILE_EVENT_KEY(slug, filePath);
  return safeWrite(async () => {
    await client
      .multi()
      .lPush(key, JSON.stringify(record))
      .lTrim(key, 0, MAX_EVENTS_PER_FILE - 1)
      .expire(key, EVENT_TTL_SEC)
      .exec();
  }, 'redis_log_file_event_failed', { slug, filePath, kind: record.kind });
}

async function getFileHistory(slug, filePath, limit = 50) {
  if (!isAvailable()) return [];
  const n = Math.min(Math.max(1, Number(limit) || 50), MAX_EVENTS_PER_FILE);
  try {
    const raw = await runWithRetry(() =>
      client.lRange(FILE_EVENT_KEY(slug, filePath), 0, n - 1));
    return raw.map((s) => {
      try { return JSON.parse(s); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (err) {
    logger.warn('redis_get_file_history_failed', { slug, filePath }, err);
    return [];
  }
}

// ── File version history (save-point snapshots) ──────────────────────────
// Stores up to MAX_VERSIONS_PER_FILE recent saved versions.  Content
// larger than MAX_VERSION_BYTES is stored as metadata only (hash + size)
// so recovery still knows what was there, even if it can't hand back the
// bytes.  This is a server-side undo for saved states — NOT a CRDT log.

async function saveFileVersion(slug, filePath, version) {
  if (!slug || !filePath || typeof version?.content !== 'string') return;
  const bytes = Buffer.byteLength(version.content, 'utf8');
  const hash = version.hash
    || crypto.createHash('sha256').update(version.content).digest('hex');
  const storeContent = bytes <= MAX_VERSION_BYTES;
  const record = {
    ts: version.ts || Date.now(),
    userId: version.userId || null,
    sessionId: version.sessionId || null,
    hash,
    size: bytes,
    hasContent: storeContent,
    content: storeContent ? version.content : null,
  };
  const key = FILE_VERSION_KEY(slug, filePath);
  return safeWrite(async () => {
    await client
      .multi()
      .lPush(key, JSON.stringify(record))
      .lTrim(key, 0, MAX_VERSIONS_PER_FILE - 1)
      .expire(key, VERSION_TTL_SEC)
      .exec();
  }, 'redis_save_file_version_failed', { slug, filePath, hash, bytes });
}

async function getFileVersions(slug, filePath, { limit = MAX_VERSIONS_PER_FILE, withContent = false } = {}) {
  if (!isAvailable()) return [];
  const n = Math.min(Math.max(1, Number(limit) || MAX_VERSIONS_PER_FILE), MAX_VERSIONS_PER_FILE);
  try {
    const raw = await runWithRetry(() =>
      client.lRange(FILE_VERSION_KEY(slug, filePath), 0, n - 1));
    return raw
      .map((s) => { try { return JSON.parse(s); } catch (_) { return null; } })
      .filter(Boolean)
      .map((v) => withContent ? v : { ...v, content: null });
  } catch (err) {
    logger.warn('redis_get_file_versions_failed', { slug, filePath }, err);
    return [];
  }
}

async function getFileVersion(slug, filePath, index = 0) {
  if (!isAvailable()) return null;
  const i = Math.max(0, Math.min(Number(index) || 0, MAX_VERSIONS_PER_FILE - 1));
  try {
    const raw = await runWithRetry(() =>
      client.lIndex(FILE_VERSION_KEY(slug, filePath), i));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (_) { return null; }
  } catch (err) {
    logger.warn('redis_get_file_version_failed', { slug, filePath, index: i }, err);
    return null;
  }
}

/**
 * Drop the `keepFromIndex` newest versions so that whatever was at
 * `keepFromIndex` becomes the new head of the list.  Used when restoring
 * an older version — the newer snapshots stop representing the live
 * timeline the moment we roll back, so they shouldn't linger in history.
 *
 * No-op when Redis is disabled or `keepFromIndex <= 0`.
 */
async function truncateVersionsAbove(slug, filePath, keepFromIndex) {
  if (!slug || !filePath) return;
  if (!Number.isFinite(keepFromIndex) || keepFromIndex <= 0) return;
  const key = FILE_VERSION_KEY(slug, filePath);
  return safeWrite(async () => {
    await client
      .multi()
      .lTrim(key, keepFromIndex, -1)
      .expire(key, VERSION_TTL_SEC)
      .exec();
  }, 'redis_truncate_versions_failed', { slug, filePath, keepFromIndex });
}

/**
 * Number of versions currently stored for a file.  Cheap O(1) LLEN.
 * Returns 0 when Redis is unavailable.
 */
async function countFileVersions(slug, filePath) {
  if (!isAvailable() || !slug || !filePath) return 0;
  try {
    return await runWithRetry(() => client.lLen(FILE_VERSION_KEY(slug, filePath)));
  } catch (err) {
    logger.warn('redis_count_file_versions_failed', { slug, filePath }, err);
    return 0;
  }
}

// ── Offline user event inbox ─────────────────────────────────────────────
// Events that were fired while the user was offline queue here so their
// next connect can drain and deliver them as missed notifications.  Always
// no-op when Redis is disabled — callers should fall back to in-memory
// delivery only.

async function enqueueUserEvent(userId, event) {
  if (!userId || !event || !event.type) return;
  const record = {
    queuedAt: Date.now(),
    type: String(event.type),
    payload: event.payload && typeof event.payload === 'object' ? event.payload : {},
  };
  const key = USER_INBOX_KEY(userId);
  return safeWrite(async () => {
    await client
      .multi()
      .lPush(key, JSON.stringify(record))
      .lTrim(key, 0, MAX_INBOX_PER_USER - 1)
      .expire(key, INBOX_TTL_SEC)
      .exec();
  }, 'redis_enqueue_user_event_failed', { userId, type: record.type });
}

/**
 * Atomically drain the inbox — returns every queued event (oldest first)
 * and removes them.  Safe to call on every WS connect; returns [] when
 * nothing is pending or persistence is disabled.
 */
async function drainUserInbox(userId) {
  if (!userId || !isAvailable()) return [];
  const key = USER_INBOX_KEY(userId);
  try {
    // LRANGE + DEL in a MULTI so we never lose or duplicate an event even
    // if the user re-connects concurrently from another tab.
    const result = await runWithRetry(() =>
      client.multi().lRange(key, 0, -1).del(key).exec());
    const rawList = (result && result[0]) || [];
    // LPUSH adds newest at head; reverse so callers deliver in fire order.
    return rawList.reverse().map((s) => {
      try { return JSON.parse(s); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (err) {
    logger.warn('redis_drain_inbox_failed', { userId }, err);
    return [];
  }
}

async function peekUserInboxSize(userId) {
  if (!userId || !isAvailable()) return 0;
  try {
    return await runWithRetry(() => client.lLen(USER_INBOX_KEY(userId)));
  } catch (_) {
    return 0;
  }
}

// ── Shutdown ──────────────────────────────────────────────────────────────

async function close() {
  if (!client) return;
  // Final drain attempt so SIGTERM doesn't drop everything still queued.
  if (writeQueue.length && isAvailable()) {
    try { await drainQueue(); } catch (_) {}
  }
  if (writeQueue.length) {
    logger.warn('persistence_close_with_pending', { remaining: writeQueue.length });
  }
  try { await client.quit(); }
  catch (err) { logger.warn('redis_quit_failed', {}, err); }
  client = null;
  available = false;
}

// Exposed for tests + observability.
function _queueSize() { return writeQueue.length; }

module.exports = {
  connect,
  isAvailable,
  saveSession,
  deleteSession,
  loadSessions,
  saveBlock,
  removeBlock,
  loadBlocks,
  logFileEvent,
  getFileHistory,
  saveFileVersion,
  getFileVersions,
  getFileVersion,
  truncateVersionsAbove,
  countFileVersions,
  enqueueUserEvent,
  drainUserInbox,
  peekUserInboxSize,
  close,
  _queueSize,
};
