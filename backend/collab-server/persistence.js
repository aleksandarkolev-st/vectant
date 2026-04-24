/**
 * persistence.js — Optional Redis-backed persistence for collab state.
 *
 * Keeps the in-memory maps (SessionManager, blockedBy) as the source of
 * truth for hot-path reads.  Mutations are mirrored to Redis in the
 * background; on server boot we reload from Redis so sessions + blocks
 * survive restarts.
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

const REDIS_URL = process.env.REDIS_URL || null;
const KEY_PREFIX = process.env.COLLAB_REDIS_PREFIX || 'collab:';
const SESSION_KEY = (id) => `${KEY_PREFIX}session:${id}`;
const SESSION_INDEX_KEY = `${KEY_PREFIX}session:index`;
const BLOCK_KEY = (userId) => `${KEY_PREFIX}block:${userId}`;
const BLOCK_INDEX_KEY = `${KEY_PREFIX}block:index`;
// Sessions never outlive the token TTL, so let Redis expire them even if a
// server crash prevents explicit deletion.
const SESSION_TTL_SEC = Number(process.env.COLLAB_REDIS_SESSION_TTL_SEC) || 86_400;
const BLOCK_TTL_SEC = Number(process.env.COLLAB_REDIS_BLOCK_TTL_SEC) || 180 * 86_400;

let client = null;
let connecting = false;
let available = false;

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
    c.on('end', () => { available = false; logger.warn('redis_disconnected'); });
    c.on('reconnecting', () => logger.info('redis_reconnecting'));
    await c.connect();
    client = c;
    available = true;
    logger.info('redis_connected', { url: sanitizeUrl(REDIS_URL) });
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

/**
 * Fire-and-forget write wrapper.  Errors are logged but never propagate to
 * the in-memory caller — persistence is best-effort by design.
 */
function safeWrite(fn, event, data) {
  if (!isAvailable()) return Promise.resolve();
  return fn().catch((err) => logger.warn(event, data, err));
}

// ── Session persistence ──────────────────────────────────────────────────

async function saveSession(session) {
  return safeWrite(async () => {
    const payload = JSON.stringify(serializeSessionForStorage(session));
    const key = SESSION_KEY(session.id);
    await client
      .multi()
      .set(key, payload, { EX: SESSION_TTL_SEC })
      .sAdd(SESSION_INDEX_KEY, session.id)
      .exec();
  }, 'redis_save_session_failed', { sessionId: session.id });
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
    const ids = await client.sMembers(SESSION_INDEX_KEY);
    if (!ids.length) return [];
    const keys = ids.map(SESSION_KEY);
    const raw = await client.mGet(keys);
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
    const owners = await client.sMembers(BLOCK_INDEX_KEY);
    if (!owners.length) return [];
    const entries = [];
    for (const userId of owners) {
      const blocked = await client.sMembers(BLOCK_KEY(userId));
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

// ── Shutdown ──────────────────────────────────────────────────────────────

async function close() {
  if (!client) return;
  try { await client.quit(); }
  catch (err) { logger.warn('redis_quit_failed', {}, err); }
  client = null;
  available = false;
}

module.exports = {
  connect,
  isAvailable,
  saveSession,
  deleteSession,
  loadSessions,
  saveBlock,
  removeBlock,
  loadBlocks,
  close,
};
