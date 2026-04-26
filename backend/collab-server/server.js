const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();
const Y = require('yjs');
const fileIndex = require('./fileIndex');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const crypto = require('crypto');
const gcsSync = require('./gcsSync');
const { createTerminalWSS, activeSessions: terminalSessions, broadcastToAll: terminalBroadcast, getAvailableShells } = require('./terminalService');
const proxyService = require('./proxyService');
const config = require('./config');
const gitService = require('./gitService');
const repoCache = require('./repoCache');
const sessionManager = require('./SessionManager');
const { extractSessionContext, requireGitActionPermission, wsRequirePermission, wsDenyAction, wsAttachContext } = require('./permissionMiddleware');
const { acquireStagingLock, releaseStagingLock, pauseWatcher, resumeWatcher, registerChangeListener } = require('./fsWatcherService');
const { LRUCache } = require('lru-cache');
const ySweetBridge = require('./ySweetBridge');
const { withTelemetry, getMetrics, resetMetrics, getEventLoopBlockCount } = require('./perfTelemetry');
const sseService = require('./sseService');
const persistence = require('./persistence');
const logger = require('./logger').child({ component: 'collab' });

// ── User block list (in-memory) ──────────────────────────────────────────────
// blockedBy: userId → Set<blockedUserId>
// If user A blocks user B, blockedBy.get(A) contains B.
// This means B cannot: see A in presence, invite A, or join A's workspace.
const blockedBy = new Map();

let fetchFunc = null;
if (typeof fetch === 'function') {
  fetchFunc = fetch;
} else {
  try {
    fetchFunc = require('node-fetch');
  } catch (e) {
    fetchFunc = null;
  }
}

const CODE_INTEL_URL = config.CODE_INTEL_URL;

const PORT = config.PORT;

// PERF: Bounded LRU cache replaces unbounded Map to prevent memory leak and
// GC pauses on long-running servers with many files.  1000 entries covers the
// active working set; 5-minute TTL evicts stale entries automatically.
const fileHashCache = new LRUCache({ max: 1000, ttl: 5 * 60 * 1000 }); // docName -> { hash, timestamp }

// Revert cooldown: after invalidateDocsForSlug, reject stale sync (save)
// requests for a short window.  Key = "slug:filePath", value = timestamp.
const revertCooldowns = new Map();
const REVERT_COOLDOWN_MS = 3000; // 3 seconds

// Files whose last GCS backup failed after all retries.  When set, the disk
// write succeeded but the durable off-site backup did not.  We track this so
// the client UI can surface a "backup degraded" indicator and so successive
// save attempts can emit status-change events (degraded → ok) as conditions
// recover.  Key = "slug:filePath", value = { at, error }.
// Bounded to prevent unbounded memory growth in long-running servers; stale
// entries expire after 24h since disk is the source of truth once recovered.
const gcsBackupDegraded = new LRUCache({ max: 10_000, ttl: 24 * 60 * 60 * 1000 });

// Periodically garbage-collect expired cooldowns so the map doesn't grow
// unboundedly on long-running servers.
setInterval(() => {
  if (revertCooldowns.size === 0) return;
  const now = Date.now();
  for (const [key, ts] of revertCooldowns) {
    if (now - ts > REVERT_COOLDOWN_MS * 2) revertCooldowns.delete(key);
  }
}, 30_000); // every 30 seconds

// ── Rate limiting + Origin allowlist ─────────────────────────────────────────
// Lightweight fixed-window token bucket keyed by IP (or IP + user).  Intended
// to stop accidental floods and casual abuse of public session endpoints;
// a real gateway/WAF is expected in production.
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new LRUCache({ max: 20_000, ttl: RATE_WINDOW_MS * 2 });

function checkRateLimit(key, limit) {
  const now = Date.now();
  const slot = Math.floor(now / RATE_WINDOW_MS);
  const bucketKey = `${slot}:${key}`;
  const count = (rateBuckets.get(bucketKey) || 0) + 1;
  rateBuckets.set(bucketKey, count);
  return count <= limit;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Parse comma-separated list once at startup.
const ALLOWED_ORIGINS = String(process.env.COLLAB_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

/**
 * Enforce that non-GET/OPTIONS requests come from a trusted Origin, to block
 * casual CSRF.  If COLLAB_ALLOWED_ORIGINS is unset the server accepts any
 * origin (legacy behaviour) but still rejects cross-site requests that arrive
 * with an Origin header pointing at a different scheme+host than the request.
 *
 * Returns true if the request should proceed; false if the caller should
 * stop processing (the response is already written).
 */
function enforceOrigin(req, res) {
  if (req.method === 'GET' || req.method === 'OPTIONS') return true;
  const origin = req.headers.origin;
  // Same-origin browser requests from fetch() always include an Origin header;
  // server-to-server calls typically do not.  Require Origin for unsafe methods
  // so browser clients can't forge them from another tab.
  if (!origin) {
    // Allow if an explicit cross-service bypass header is configured, to
    // support service-to-service calls in trusted networks.
    const internalToken = req.headers['x-collab-internal-token'];
    if (internalToken && process.env.COLLAB_INTERNAL_TOKEN &&
        internalToken === process.env.COLLAB_INTERNAL_TOKEN) {
      return true;
    }
    // When no allowlist is configured we keep legacy permissive behaviour.
    if (ALLOWED_ORIGINS.length === 0) return true;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'origin_required' }));
    return false;
  }
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'origin_forbidden' }));
    return false;
  }
  return true;
}

/**
 * Rate-limit guard.  If over budget, writes a 429 and returns false.
 * Scope keys help separate sensitive endpoints (knock, invite) from cheap ones.
 */
function rateLimitGuard(req, res, scope, limitPerMin) {
  const key = `${scope}:${clientIp(req)}`;
  if (checkRateLimit(key, limitPerMin)) return true;
  res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '30' });
  res.end(JSON.stringify({ error: 'rate_limited', scope }));
  return false;
}

// Track which slugs have been hydrated from GCS this boot.
// Solves the case where a repo directory exists (e.g. from a prior run or
// background indexer) but its contents are stale/partial.  On first access
// per server lifetime we always call initRepo() which is idempotent (checks
// for .git before re-initialising) and merges GCS contents via downloadGcsToRepo().
// Keyed by "slug" for slug-level hydration and "slug:userId" for per-user repos.
const hydratedSlugs = new Set();
const purgedLegacyRooms = new Set();

/** Build a hydration key — includes userId when present. */
function hydrationKey(slug, userId) {
  return userId ? `${slug}:${userId}` : slug;
}

async function purgeLegacyRoomState(slug, filePath) {
  const legacyDoc = `workspace:${slug}:${filePath}`;
  if (purgedLegacyRooms.has(legacyDoc)) return;
  purgedLegacyRooms.add(legacyDoc);

  try {
    fileHashCache.delete(legacyDoc);
  } catch (_) {}
}

/**
 * Compute MD5 hash of content for change detection
 */
function computeHash(content) {
  return crypto.createHash('md5').update(content || '').digest('hex');
}

/**
 * Build a deterministic Yjs room/doc name.
 * v2 format:
 *   workspace:<slug>:user:<encodedUserId>:<filePath>
 *   workspace:<slug>:session:<sessionId>:<filePath>
 * legacy v1 format (read-only compatibility):
 *   workspace:<slug>:<filePath>
 *
 * Direct-access model: userId takes priority over sessionId because
 * guests now share the host's user-scoped rooms, not session-scoped rooms.
 */
function buildDocName(slug, filePath, { userId = null, sessionId = null } = {}) {
  const safePath = filePath || 'root';
  if (userId) {
    return `workspace:${slug}:user:${encodeURIComponent(String(userId))}:${safePath}`;
  }
  if (sessionId) {
    return `workspace:${slug}:session:${sessionId}:${safePath}`;
  }
  return `workspace:${slug}:${safePath}`;
}

/**
 * Parse a Yjs room/doc name.
 */
function parseDocName(docName) {
  if (!docName || !docName.startsWith('workspace:')) return null;

  const body = docName.slice('workspace:'.length);
  const firstColon = body.indexOf(':');
  if (firstColon <= 0) return null;

  const slug = body.slice(0, firstColon);
  const remainder = body.slice(firstColon + 1);

  if (remainder.startsWith('user:')) {
    const afterTag = remainder.slice('user:'.length);
    const userSep = afterTag.indexOf(':');
    if (userSep <= 0) return null;
    const encodedUserId = afterTag.slice(0, userSep);
    const filePath = afterTag.slice(userSep + 1);
    if (!filePath) return null;
    return {
      slug,
      filePath,
      scopeType: 'user',
      userId: decodeURIComponent(encodedUserId),
      sessionId: null,
      isLegacy: false,
    };
  }

  if (remainder.startsWith('session:')) {
    const afterTag = remainder.slice('session:'.length);
    const sessionSep = afterTag.indexOf(':');
    if (sessionSep <= 0) return null;
    const sessionId = afterTag.slice(0, sessionSep);
    const filePath = afterTag.slice(sessionSep + 1);
    if (!filePath) return null;
    return {
      slug,
      filePath,
      scopeType: 'session',
      sessionId,
      userId: null,
      isLegacy: false,
    };
  }

  // Legacy v1 room (workspace:<slug>:<filePath>)
  return {
    slug,
    filePath: remainder,
    scopeType: 'legacy',
    userId: null,
    sessionId: null,
    isLegacy: true,
  };
}

function resolveEffectiveUserForDoc(parsed, fallbackUserId = null) {
  if (!parsed) return fallbackUserId || null;
  if (parsed.scopeType === 'user') return parsed.userId || fallbackUserId || null;
  if (parsed.scopeType === 'session') {
    const session = parsed.sessionId ? sessionManager.getSession(parsed.sessionId) : null;
    return session?.hostId || fallbackUserId || null;
  }
  return fallbackUserId || null;
}

function getWsQueryParams(reqUrl) {
  try {
    const params = new URLSearchParams((reqUrl || '').split('?')[1] || '');
    return {
      userId: params.get('userId') || null,
      sessionId: params.get('sessionId') || null,
    };
  } catch (_) {
    return { userId: null, sessionId: null };
  }
}

function validateDocAccess(parsedDoc, { userId, sessionId }) {
  if (!parsedDoc) return { ok: false, status: 400, reason: 'invalid_doc_name' };
  if (!userId) return { ok: false, status: 401, reason: 'user_required' };

  if (parsedDoc.scopeType === 'session') {
    if (!sessionId || sessionId !== parsedDoc.sessionId) {
      return { ok: false, status: 403, reason: 'session_mismatch' };
    }
    const session = sessionManager.getSession(sessionId);
    if (!session) return { ok: false, status: 404, reason: 'session_not_found' };
    if (session.slug !== parsedDoc.slug) {
      return { ok: false, status: 403, reason: 'session_slug_mismatch' };
    }
    if (!sessionManager.checkPermission(sessionId, userId, 'canEdit')) {
      return { ok: false, status: 403, reason: 'edit_permission_required' };
    }
    return { ok: true };
  }

  if (parsedDoc.scopeType === 'user') {
    // Owner of this user-scoped room → always allowed
    if (parsedDoc.userId === userId) {
      return { ok: true };
    }
    // Guest accessing the host's user-scoped room (direct-access model):
    // the connecting user must be an actual registered guest of a session
    // owned by parsedDoc.userId, pointing at the same slug, AND hold the
    // canEdit permission.  We explicitly re-verify guest membership rather
    // than relying on checkPermission alone so that an attacker cannot
    // access another host's room by smuggling a sessionId they aren't part
    // of.
    const verify = (session, verifiedSessionId) => {
      if (!session) return null;
      if (session.status && session.status !== 'active') return null;
      if (session.hostId !== parsedDoc.userId) return null;
      if (session.slug !== parsedDoc.slug) return null;
      // Guests can be a Map (internal) or Array (serialized) — support both.
      let isGuest = false;
      if (session.guests instanceof Map) {
        isGuest = session.guests.has(userId);
      } else if (Array.isArray(session.guests)) {
        isGuest = session.guests.some(g => g && g.guestId === userId);
      }
      if (!isGuest) return null;
      if (!sessionManager.checkPermission(verifiedSessionId, userId, 'canEdit')) {
        return { ok: false, status: 403, reason: 'edit_permission_required' };
      }
      return { ok: true };
    };

    if (sessionId) {
      const session = sessionManager.getSession(sessionId);
      const r = verify(session, sessionId);
      if (r) return r;
    }
    // Also check if the user is a guest anywhere whose host matches the room
    const hostInfo = sessionManager.getHostForGuest(userId);
    if (hostInfo && hostInfo.hostId === parsedDoc.userId && hostInfo.slug === parsedDoc.slug) {
      const guestSessionId = hostInfo.sessionId;
      const session = sessionManager.getSession(guestSessionId);
      const r = verify(session, guestSessionId);
      if (r) return r;
    }
    return { ok: false, status: 403, reason: 'user_scope_mismatch' };
  }

  // Legacy rooms are denied in strict per-user mode.
  return { ok: false, status: 410, reason: 'legacy_room_unsupported' };
}

/**
 * Get the actual file content from disk.
 * When userId is provided, reads from the per-user repo; otherwise falls
 * back to the slug-level repo.
 */
async function getActualFileContent(slug, filePath, userId) {
  try {
    const repoPath = gitService.getEffectiveRepoPath(slug, userId);
    const fullPath = path.join(repoPath, filePath);
    const content = await fsPromises.readFile(fullPath, 'utf8');
    return content;
  } catch (e) {
    console.log(`[Collab] Could not read file ${slug}/${filePath}:`, e.code || e.message);
    return null;
  }
}

/**
 * Canonical text type name used by the Monaco client binding.
 * All server-side logic must use this consistently.
 */
const YTEXT_TYPE = 'monaco';

/**
 * Get content from a Yjs document's canonical text type.
 */
function getYDocContent(ydoc) {
  try {
    const text = ydoc.getText(YTEXT_TYPE);
    return text.length > 0 ? text.toString() : '';
  } catch (e) {
    return '';
  }
}

// ─── Y-Sweet handles CRDT relay + persistence ───────────────────────────────
// ValidatingPersistence, y-websocket, and LevelDB have been replaced by
// Y-Sweet (a standalone Yrs/Rust CRDT server). The collab server is now
// stateless: REST API + git + terminal + GCS file sync + sessions.
//
// flushDocToDisk() is retained as a lightweight helper that writes content
// to disk + GCS when the client explicitly saves (the 'sync' REST action
// already passes content in the request body).

/**
 * Write file content to the scoped git working tree + GCS.
 * Called from the 'sync' REST action (explicit save).
 *
 * @param {string} docName – Yjs room name (workspace:slug:user:uid:path)
 * @param {{ contentOverride?: string }} options
 */
async function flushDocToDisk(docName, options = {}) {
  const parsed = parseDocName(docName);
  if (!parsed) return;

  const { slug, filePath, userId: docUserId, sessionId: docSessionId } = parsed;
  let effectiveUserId = docUserId || null;

  if (docSessionId && !effectiveUserId) {
    const session = sessionManager.getSession(docSessionId);
    if (!session) throw new Error(`Session ${docSessionId} not found for doc ${docName}`);
    effectiveUserId = session.hostId;
  }
  if (!effectiveUserId) throw new Error(`Refusing unscoped flush for doc ${docName}`);

  // Content is always provided by the client via the 'sync' REST body.
  // Fallback: read from Y-Sweet if not provided (pre-stage flush).
  let content = typeof options.contentOverride === 'string'
    ? options.contentOverride
    : null;

  if (content == null) {
    content = await ySweetBridge.readDocContent(docName);
  }
  if (content == null) return;

  // 1. GCS sync (durable store)
  if (config.GCS_SYNC_ON_FLUSH && gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
    try {
      await gcsSync.syncFileToGcs(slug, filePath, content, effectiveUserId);
      // Clear any previous degraded-backup marker on success
      if (gcsBackupDegraded.delete(`${slug}:${filePath}`)) {
        broadcastBackupStatus(slug, filePath, 'ok', { userId: effectiveUserId });
      }
    } catch (e) {
      // All retries exhausted — user's local disk write succeeded but the
      // durable GCS backup failed.  Surface this as a structured warning
      // so the client can show a "backup degraded" indicator, and emit
      // telemetry so operators can diagnose systemic outages.
      console.error(`[Collab Flush] GCS sync exhausted retries for ${slug}/${filePath}:`, e?.message || e);
      gcsBackupDegraded.set(`${slug}:${filePath}`, { at: Date.now(), error: e?.message || String(e) });
      broadcastBackupStatus(slug, filePath, 'degraded', {
        userId: effectiveUserId,
        reason: e?.message || 'gcs_sync_failed',
      });
    }
  }

  // 2. Disk write to the scoped repo (atomic via temp+rename, with verification)
  // Seed a pre-edit baseline snapshot the first time we save a file, so the
  // version history always contains the point you can "go back to the
  // original" from.  Without this, the very first saved version IS already
  // the user's edited content, and there's nothing to revert to.
  //
  // ORDER MATTERS: we MUST read the prior disk content BEFORE calling
  // safeWriteFile, otherwise the read sees the freshly-written new content
  // and `prior === content` short-circuits the baseline seed.  An earlier
  // version relied on gitService.syncFile() happening in the caller, which
  // broke this ordering and meant the very first saved version was always
  // the edited content with nothing to revert to.
  const repoPath = gitService.getEffectiveRepoPath(slug, effectiveUserId);
  const fullPath = path.join(repoPath, filePath);
  try {
    const prior = await fsPromises.readFile(fullPath, 'utf8');
    if (prior !== content) {
      const priorHash = computeHash(prior);
      const existingCount = await persistence.countFileVersions(slug, filePath);
      if (existingCount === 0) {
        await persistence.saveFileVersion(slug, filePath, {
          userId: effectiveUserId,
          sessionId: docSessionId || null,
          hash: priorHash,
          content: prior,
          ts: Date.now() - 1,
        });
      }
    }
  } catch (err) {
    // File didn't exist yet (brand new file) or unreadable — nothing to snapshot.
    if (err && err.code !== 'ENOENT') {
      logger.warn('version_baseline_read_failed', { slug, filePath }, err);
    }
  }
  await gitService.safeWriteFile(fullPath, content);

  // Update hash cache
  fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });

  // Optional: code-intel indexing
  if (config.CODE_INTEL_AUTO_INDEX && fetchFunc && CODE_INTEL_URL) {
    try {
      fetchFunc(`${CODE_INTEL_URL}/code-intel/index/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_path: slug, file_path: filePath }),
      }).catch(() => {});
    } catch (_) { /* non-fatal */ }
  }

  broadcastGitStatusChanged(slug, filePath, { userId: effectiveUserId, sessionId: docSessionId || null });
  broadcastFileSaved(slug, filePath, { userId: effectiveUserId, sessionId: docSessionId || null });

  // Record a durable save-point: an append-only activity entry plus a
  // versioned snapshot of the content.  Both land in Redis when available
  // (see persistence.js), so users can see who saved when and recover
  // overwritten content even after Monaco's local undo is gone.
  const contentHash = computeHash(content);
  persistence.logFileEvent(slug, filePath, {
    kind: 'saved',
    userId: effectiveUserId,
    sessionId: docSessionId || null,
    hash: contentHash,
    size: Buffer.byteLength(content, 'utf8'),
  });
  persistence.saveFileVersion(slug, filePath, {
    userId: effectiveUserId,
    sessionId: docSessionId || null,
    hash: contentHash,
    content,
  });

  logger.info('file_saved', {
    slug,
    filePath,
    userId: effectiveUserId,
    sessionId: docSessionId || null,
    size: content.length,
  });
}

const workspaceManager = require('./workspaceManager');
const spawner = require('./spawner');

// ── In-memory userId → displayName cache ──────────────────────────────────
// Populated from Yjs awareness state changes so that REST endpoints can
// resolve human-readable names in O(1) instead of iterating all docs.
const userDisplayNameCache = new Map(); // Map<userId, { name: string, avatar: string }>

/**
 * Update the display name cache from a doc's awareness states.
 * Called whenever a Yjs doc's awareness changes.
 */
function refreshUserNameCache(awareness) {
  if (!awareness) return;
  for (const [, state] of awareness.getStates()) {
    if (state?.user?.id && state.user.name) {
      userDisplayNameCache.set(String(state.user.id), {
        name: state.user.name,
        avatar: state.user.image || '',
      });
    }
  }
}

/**
 * Invalidate all active Yjs documents for a workspace slug.
 * Called after git operations that modify files on disk (checkout, pull, discard).
 * This ensures the next WebSocket connection for each file triggers a fresh
 * bindState with the new disk content.
 *
 * @param {string} slug - Workspace slug
 * @param {string[]} [filePaths] - Specific file paths to invalidate. If empty/null, invalidates ALL docs for the slug.
 */

/**
 * Validate a client-provided file path to prevent path-traversal attacks.
 * Returns the normalized path or throws on invalid input.
 * Rules:
 *  - Must be a non-empty string
 *  - No null bytes
 *  - After normalization, must not start with / or contain ..
 *  - Must not contain backslashes (Windows-style traversal)
 */
function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath is required and must be a non-empty string');
  }
  if (filePath.includes('\0')) {
    throw new Error('filePath must not contain null bytes');
  }
  // Normalize to forward slashes and resolve . / ..
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (normalized.startsWith('/') || normalized.startsWith('..') || normalized.includes('/../')) {
    throw new Error(`filePath traversal rejected: ${filePath}`);
  }
  return normalized;
}

/**
 * Force-flush any in-memory Yjs document content for a specific file to disk.
 * Called before selective staging (git apply) so the patch always matches the
 * actual file on disk, preventing "patch does not apply" errors caused by
 * unflushed editor changes.
 *
 * @param {string} slug - workspace slug
 * @param {string} filePath - file path within the repo
 * @param {object} scope - { userId, sessionId } for doc name matching
 */
async function flushYjsDocForFile(slug, filePath, scope = {}) {
  if (!slug || !filePath) return;

  // Read current CRDT content from Y-Sweet and write to the git worktree.
  // This ensures the on-disk content matches the editor state before git ops.
  const docName = buildDocName(slug, filePath, scope);
  const content = await ySweetBridge.readDocContent(docName);
  if (content == null) return;

  const effectiveUser = scope.userId || null;
  if (!effectiveUser) return;

  const repoPath = gitService.getEffectiveRepoPath(slug, effectiveUser);
  if (!fs.existsSync(repoPath)) return;

  const fullPath = path.join(repoPath, filePath);
  await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
  await fsPromises.writeFile(fullPath, content, 'utf-8');
  fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });
  console.log(`[Collab] Pre-stage flush via Y-Sweet: ${filePath} (${content.length} chars)`);
}

async function invalidateDocsForSlug(slug, filePaths = null, scope = {}) {
  // Y-Sweet owns doc persistence — we no longer hold Yjs docs in-process.
  // Invalidation now means:
  //   1. Clear the hash cache so subsequent reads re-check disk.
  //   2. Broadcast a 'doc-invalidated' notification via notifyWss so
  //      connected frontends destroy their Y.Docs and reconnect to
  //      Y-Sweet with fresh state.
  //   3. Set revert cooldowns to reject stale in-flight save requests.
  const prefix = `workspace:${slug}:`;

  // Clear hash cache entries for affected files
  for (const key of fileHashCache.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (filePaths && filePaths.length > 0) {
      const parsed = parseDocName(key);
      if (parsed && !filePaths.includes(parsed.filePath)) continue;
    }
    fileHashCache.delete(key);
  }

  // Broadcast invalidation to frontends via notification WebSocket.
  // Clients listen for 'doc-invalidated' and destroy + reconnect their Y.Docs.
  if (notifyWss) {
    const message = JSON.stringify({
      type: 'doc-invalidated',
      slug,
      filePaths: filePaths || [],
      scope,
    });
    notifyWss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
        try { ws.send(message); } catch (_) {}
      }
    });
  }

  // Set revert cooldown for affected paths
  const now = Date.now();
  const affectedPaths = filePaths && filePaths.length > 0 ? filePaths : [];
  for (const fp of affectedPaths) {
    revertCooldowns.set(`${slug}:${fp}`, now);
    // Best-effort: log the revert to the file activity stream.  No version
    // snapshot — the disk is the source of truth post-revert and is
    // already captured in the previous 'saved' entry.
    persistence.logFileEvent(slug, fp, {
      kind: 'reverted',
      userId: scope?.userId || null,
      sessionId: scope?.sessionId || null,
    });
  }

  if (filePaths) {
    logger.info('docs_invalidated', { slug, files: filePaths.length, paths: filePaths });
  } else {
    logger.info('docs_invalidated', { slug, files: 'all' });
  }
}

/**
 * Broadcast a file-tree-changed event to notification WebSocket clients
 * for a specific workspace slug. Clients should re-fetch the file tree.
 */
function broadcastFileTreeChanged(slug, scope = {}) {
  if (!slug || !notifyWss) return;
  const message = JSON.stringify({ type: 'file-tree-changed', slug, scope });
  notifyWss.clients.forEach((ws) => {
    // Only send to clients subscribed to this slug
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
      try { ws.send(message); } catch (_) {}
    }
  });
  console.log(`[Collab] Broadcast file-tree-changed for slug ${slug}`);
}

/**
 * Broadcast a git-status-changed event to notification WebSocket clients.
 * Sent after auto-flush writes to disk so frontends can immediately refresh
 * Source Control instead of waiting for the next poll or debounce timer.
 * Debounced per-slug (500ms) to avoid spamming during rapid typing.
 *
 * @param {string} slug - workspace slug
 * @param {string} [filePath] - optional file path that triggered the change
 */
const _gitStatusBroadcastTimers = new Map();
function _makeScopeKey(scope = {}) {
  return `${scope.sessionId || ''}|${scope.userId || ''}`;
}

function _matchesNotifyScope(ws, scope = {}) {
  if (!scope) return true;
  // Direct-access model: match by sessionId OR userId.
  // Both host and guest notification WS clients should receive events.
  if (scope.sessionId && ws._sessionId === scope.sessionId) return true;
  if (scope.userId && ws._userId === scope.userId) return true;

  // If scope has a userId that is a session host, also match guests in that session.
  // This ensures guests receive file-saved / git-status-changed events when the
  // room key is user-scoped (workspace:{slug}:user:{hostId}:{path}) and sessionId is null.
  if (scope.userId && sessionManager) {
    const hostSessionId = sessionManager.hostIndex.get(scope.userId);
    if (hostSessionId) {
      const session = sessionManager.sessions.get(hostSessionId);
      if (session && session.status === 'active') {
        // Match the WS client if they are a guest in this session
        if (session.guests.has(ws._userId)) return true;
      }
    }
  }

  // If scope has no filters, broadcast to all
  if (!scope.sessionId && !scope.userId) return true;
  return false;
}

function _resolveNotifyUserId(scope = {}) {
  if (scope.userId) return scope.userId;
  if (scope.sessionId) {
    const session = sessionManager.getSession(scope.sessionId);
    return session?.hostId || null;
  }
  return null;
}

/**
 * Broadcast a file-saved event to notification WebSocket clients.
 * Sent after flushDocToDisk so all collaborators can sync their
 * saved/unsaved state — the other client's Redux savedContent updates
 * to match currentContent, clearing the unsaved indicator.
 */
function broadcastFileSaved(slug, filePath, scope = {}) {
  if (!slug || !notifyWss) return;
  const message = JSON.stringify({ type: 'file-saved', slug, filePath, scope });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
      try { ws.send(message); } catch (_) {}
    }
  });
  // Also push via SSE so polling-free clients receive the event
  sseService.emitFileSaved(slug, filePath);
}

/**
 * Broadcast a backup-status event when the durable off-site backup (GCS) for
 * a file transitions between healthy and degraded.  Lets the UI show a
 * "backup degraded" warning so users aren't misled into thinking a save
 * succeeded end-to-end when only the local disk write landed.
 *
 * @param {string} slug
 * @param {string} filePath
 * @param {'ok'|'degraded'} status
 * @param {{ userId?: string, sessionId?: string, reason?: string }} [scope]
 */
function broadcastBackupStatus(slug, filePath, status, scope = {}) {
  if (!slug || !notifyWss) return;
  const { reason, ...notifyScope } = scope || {};
  const message = JSON.stringify({
    type: 'backup-status',
    slug,
    filePath,
    status,
    reason: reason || null,
    scope: notifyScope,
  });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, notifyScope)) {
      try { ws.send(message); } catch (_) {}
    }
  });
}

function broadcastGitStatusChanged(slug, filePath, scope = {}, { immediate = false, snapshot = null } = {}) {
  if (!slug || !notifyWss) return;
  const send = async () => {
    let resolvedSnapshot = snapshot;
    if (!resolvedSnapshot) {
      const notifyUserId = _resolveNotifyUserId(scope);
      resolvedSnapshot = await gitService.invalidateStatusCache(slug, notifyUserId, { scheduleRefresh: true });
    }
    const message = JSON.stringify({ type: 'git-status-changed', slug, filePath, scope, snapshot: resolvedSnapshot || null });
    notifyWss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
        try { ws.send(message); } catch (_) {}
      }
    });
  };
  if (immediate) {
    // Explicit user actions (pull, checkout, discard, etc.) — send immediately
    const timerKey = `${slug}|${_makeScopeKey(scope)}`;
    if (_gitStatusBroadcastTimers.has(timerKey)) {
      clearTimeout(_gitStatusBroadcastTimers.get(timerKey));
      _gitStatusBroadcastTimers.delete(timerKey);
    }
    void send();
    // Also push via SSE
    sseService.emitGitStatusChanged(slug, filePath);
    return;
  }
  // Auto-flush / background changes — debounce per-slug (500ms)
  const timerKey = `${slug}|${_makeScopeKey(scope)}`;
  if (_gitStatusBroadcastTimers.has(timerKey)) {
    clearTimeout(_gitStatusBroadcastTimers.get(timerKey));
  }
  _gitStatusBroadcastTimers.set(timerKey, setTimeout(() => {
    _gitStatusBroadcastTimers.delete(timerKey);
    void send();
    sseService.emitGitStatusChanged(slug, filePath);
  }, 500));
}

registerChangeListener(({ slug, rootDir, events }) => {
  gitService.handleFilesystemEvents({ slug, rootDir, events }).then((result) => {
    if (!result?.bundle || !result.slug) return;
    const scope = result.userId ? { userId: result.userId } : {};
    broadcastGitStatusChanged(result.slug, undefined, scope, {
      immediate: true,
      snapshot: result.bundle,
    });
  }).catch((err) => {
    console.warn('[Collab] Git cache refresh from fs watcher failed:', err?.message || err);
  });
});

// ── Out-of-band write detection ────────────────────────────────────────────
// When an AI agent, terminal process, or any non-editor writer modifies a
// file on disk, the Yjs CRDT snapshot held by Y-Sweet becomes stale.  If we
// don't invalidate, the next client to open that file will see the stale
// Yjs content in Monaco while Redux reports the fresh disk content — a
// split-brain where the file appears "unsaved" with the pre-agent content.
//
// Fix: for each fs-watcher event, compare the current disk hash against the
// hash we recorded after the last editor-initiated write.  If they differ,
// invalidate the Yjs doc so connected clients refetch the new content.
//
// Self-initiated saves are skipped automatically: flushDocToDisk() updates
// fileHashCache with the new hash before the fs-watcher event fires, so
// the hashes already match.
registerChangeListener(async ({ slug, rootDir, events }) => {
  if (!slug || !Array.isArray(events) || events.length === 0) return;
  // `bulk` is emitted when too many events fired at once (e.g. npm install).
  // Invalidating every doc for the slug is overkill; skip.
  if (events.length === 1 && events[0]?.path === '/' && events[0]?.kind === 'bulk') return;

  const scope = gitService._inferScopeFromRepoPath
    ? gitService._inferScopeFromRepoPath(rootDir, slug)
    : { slug, userId: null };
  const userId = scope?.userId || null;

  const invalidated = [];
  for (const ev of events) {
    if (!ev || ev.kind === 'dir') continue;
    const filePath = ev.path;
    if (!filePath) continue;
    // Our own atomic writes use a hidden temp file that's immediately
    // renamed into place.  Skip it — the rename event on the real path
    // will fire separately and we'll reconcile via hash-compare there.
    if (/\.synthi-tmp\.[0-9a-f]+$/.test(filePath) || /\/\.[^/]*\.synthi-tmp\./.test('/' + filePath)) continue;
    const docName = buildDocName(slug, filePath, { userId });
    try {
      if (ev.kind === 'deleted') {
        if (fileHashCache.has(docName)) {
          fileHashCache.delete(docName);
          invalidated.push(filePath);
        }
        continue;
      }
      const fullPath = path.join(rootDir, filePath);
      let content;
      try {
        content = await fsPromises.readFile(fullPath, 'utf8');
      } catch (_) {
        // File vanished between event and read — treat as deleted
        fileHashCache.delete(docName);
        invalidated.push(filePath);
        continue;
      }
      const diskHash = computeHash(content);
      const cached = fileHashCache.get(docName);
      if (cached && cached.hash === diskHash) continue; // editor-initiated write — already in sync
      // Update the cache so subsequent fs events don't re-trigger.
      fileHashCache.set(docName, { hash: diskHash, timestamp: Date.now() });
      invalidated.push(filePath);
    } catch (err) {
      console.warn(`[Collab] Out-of-band diff check failed for ${filePath}:`, err?.message || err);
    }
  }

  if (invalidated.length === 0) return;
  console.log(`[Collab] Out-of-band write detected for slug ${slug}:`, invalidated);
  const notifyScope = userId ? { userId } : {};
  try {
    await invalidateDocsForSlug(slug, invalidated, notifyScope);
  } catch (err) {
    console.warn('[Collab] invalidateDocsForSlug failed after out-of-band write:', err?.message || err);
  }
});

/**
 * Broadcast a file-reverted event to all notification clients for a slug.
 * Clients should reset their Monaco editor model for the given file(s)
 * to prevent stale dirty content from being re-flushed into the Yjs doc.
 *
 * @param {string} slug - workspace slug
 * @param {string[]} filePaths - file paths that were reverted (empty = all files)
 */
function broadcastFileReverted(slug, filePaths = [], scope = {}) {
  if (!slug) return; // Guard against falsy slug to avoid mismatched broadcasts
  if (!notifyWss) return; // Server not yet initialized
  const message = JSON.stringify({ type: 'file-reverted', slug, filePaths, scope });
  notifyWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._slug === slug && _matchesNotifyScope(ws, scope)) {
      try { ws.send(message); } catch (_) {}
    }
  });
  console.log(`[Collab] Broadcast file-reverted for slug ${slug}, files:`, filePaths.length ? filePaths : '*');
  // Also push via SSE
  sseService.emitFileReverted(slug, filePaths);
}

/**
 * Clear local cache state for a document.
 * Y-Sweet owns persistence — this just clears the hash cache entry
 * so subsequent reads re-validate against disk.
 *
 * @param {string} docName - The document name (room key)
 */
async function clearDocumentPersistence(docName) {
  fileHashCache.delete(docName);
  console.log('[Collab] Cleared local cache for document:', docName);
}

// ── TURN credential cache (Cloudflare Calls) ────────────────────────────────
// Reuses the same Cloudflare credential until 80% of the TTL has elapsed,
// avoiding an extra HTTP round-trip on most create_peer() calls.
let _turnCache = null; // { iceServers, expiresAt }
const TURN_REFRESH_MARGIN = 0.2; // refresh when 80% of TTL elapsed

async function getTurnCredentials() {
  const { CLOUDFLARE_TURN_TOKEN_ID, CLOUDFLARE_TURN_API_TOKEN, TURN_CREDENTIAL_TTL } = config;

  // Not configured → local TURN if available, else STUN-only fallback.
  if (!CLOUDFLARE_TURN_TOKEN_ID || !CLOUDFLARE_TURN_API_TOKEN) {
    const localUrl = process.env.LOCAL_TURN_URL;
    const localUser = process.env.LOCAL_TURN_USERNAME;
    const localCred = process.env.LOCAL_TURN_CREDENTIAL;
    if (localUrl && localUser && localCred) {
      return [
        { urls: ['stun:stun.l.google.com:19302'] },
        { urls: [localUrl], username: localUser, credential: localCred },
      ];
    }
    return [{ urls: ['stun:stun.l.google.com:19302'] }];
  }

  // Serve from cache when still fresh enough.
  if (_turnCache) {
    const remaining = _turnCache.expiresAt - Date.now();
    if (remaining > TURN_CREDENTIAL_TTL * 1000 * TURN_REFRESH_MARGIN) {
      return _turnCache.iceServers;
    }
  }

  const cfRes = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${CLOUDFLARE_TURN_TOKEN_ID}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CLOUDFLARE_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL }),
    },
  );

  if (!cfRes.ok) {
    const text = await cfRes.text().catch(() => '');
    throw new Error(`Cloudflare TURN API ${cfRes.status}: ${text}`);
  }

  const data = await cfRes.json();
  const cf = data.iceServers;

  const iceServers = [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: Array.isArray(cf.urls) ? cf.urls : [cf.urls],
      username: cf.username,
      credential: cf.credential,
    },
  ];

  _turnCache = { iceServers, expiresAt: Date.now() + TURN_CREDENTIAL_TTL * 1000 };
  return iceServers;
}

const server = http.createServer(async (req, res) => {
  // Strip /collab or /collab/ prefix if passed by ingress
  req.url = req.url.replace(/^\/collab/, '');
  if (!req.url.startsWith('/')) req.url = '/' + req.url;

  // CORS headers — must echo the exact Origin (not '*') when credentials are included
  const requestOrigin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
  if (requestOrigin) res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-id, x-user-name, x-user-email');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Origin check — blocks naive cross-site POSTs for all mutating routes.
  if (!enforceOrigin(req, res)) return;

  // ========================================================================
  // TURN CREDENTIALS — /turn-credentials
  // Internal endpoint for workers (Option B) to fetch short-lived
  // Cloudflare Calls TURN credentials. Cached server-side so we avoid
  // hitting Cloudflare on every create_peer().
  // ========================================================================
  // ========================================================================
  // SPAWNER WEBHOOK — /api/spawner/session-ended
  // Called by the signaling server when all peers disconnect from a session.
  // ========================================================================
  if (req.url === '/api/spawner/session-ended') {
    return spawner.handleSessionEnded(req, res);
  }

  // ========================================================================
  // SESSION LIFECYCLE — /api/session/:sessionId/lifecycle (GET)
  // Uniform view of warming / ready / running / hibernated / migrating /
  // crashed / terminated state. Consumed by the MCP (synthi_attach,
  // synthi_health) + operator UIs. Source of truth is the spawner's own
  // lifecycleSnapshot — advisory state is layered in sessionLifecycle.js.
  // ========================================================================
  const lifecycleGet = req.url.match(/^\/api\/session\/([^/]+)\/lifecycle$/);
  if (lifecycleGet && req.method === 'GET') {
    const sessionId = decodeURIComponent(lifecycleGet[1]);
    try {
      const snapshot = spawner.lifecycleSnapshot
        ? await spawner.lifecycleSnapshot(sessionId)
        : { session_id: sessionId, state: 'unknown', tracked: false };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (e) {
      console.error('[Lifecycle] snapshot failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SESSION LIFECYCLE — /api/session/:sessionId/warm (POST)
  // Pre-warm a hibernated / fresh session. Body: {user_id?}. Returns
  // {state:"warming"|"ready", estimated_ready_at?} immediately; caller
  // polls /lifecycle for progress.
  // ========================================================================
  const warmMatch = req.url.match(/^\/api\/session\/([^/]+)\/warm$/);
  if (warmMatch && req.method === 'POST') {
    if (!spawner.warm) {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'warm_not_supported_for_spawner_mode' }));
      return;
    }
    const sessionId = decodeURIComponent(warmMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    if (body) {
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    }
    try {
      const snapshot = await spawner.warm(sessionId, parsed.user_id || parsed.userId || 'warm_trigger');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot));
    } catch (e) {
      console.error('[Lifecycle] warm failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SESSION LIFECYCLE — /api/session/:sessionId/migrate (POST)
  // Record a migrating-state transition so the MCP can surface it on the
  // next `synthi_attach` / `synthi_health` poll. Body: {target?, reason?}.
  // No actual pod relocation happens here in phase 1 — this is the hook
  // an operator / orchestrator calls to flag the MCP.
  // ========================================================================
  const migrateMatch = req.url.match(/^\/api\/session\/([^/]+)\/migrate$/);
  if (migrateMatch && req.method === 'POST') {
    const sessionId = decodeURIComponent(migrateMatch[1]);
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    if (body) {
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    }
    try {
      const lifecycle = require('./sessionLifecycle');
      const snapshot = lifecycle.markMigrating(
        sessionId,
        parsed.target || null,
        parsed.reason || null
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session_id: sessionId, ...snapshot }));
    } catch (e) {
      console.error('[Lifecycle] migrate failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SPAWNER — /api/spawner/ensure
  // Called by the frontend to ensure a workspace pod exists.
  // Body: { session_id, user_id }
  // ========================================================================
  if (req.url === '/api/spawner/ensure' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    const { session_id, user_id } = parsed;
    if (!session_id || !user_id) { res.writeHead(400); res.end('Missing session_id or user_id'); return; }
    try {
      const result = await spawner.ensurePod(session_id, user_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error('[Spawner] ensurePod failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // SPAWNER — /api/spawner/touch
  // Heartbeat to keep a workspace pod alive. Body: { session_id }
  // ========================================================================
  if (req.url === '/api/spawner/touch' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end('Invalid JSON'); return; }
    if (!parsed.session_id) { res.writeHead(400); res.end('Missing session_id'); return; }
    try {
      await spawner.touch(parsed.session_id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[Spawner] touch failed:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url === '/turn-credentials' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const iceServers = await getTurnCredentials();
      res.writeHead(200);
      res.end(JSON.stringify({ iceServers }));
    } catch (e) {
      console.error('[TURN] Credential fetch failed:', e.message);
      // Degrade to STUN-only so the worker isn't completely blocked.
      res.writeHead(200);
      res.end(JSON.stringify({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        _fallback: true,
        _error: e.message,
      }));
    }
    return;
  }

  // ========================================================================
  // REVERSE PROXY — /port/<N>/... → http://127.0.0.1:<N>/...
  // Enables in-IDE preview of running dev servers (Next.js, Vite, etc.)
  // ========================================================================
  if (req.url.startsWith('/port/')) {
    proxyService.proxyHttpRequest(req, res);
    return;
  }

  // GET /ports — list active dev-server ports
  if (req.url === '/ports' && req.method === 'GET') {
    proxyService.handlePortsStatus(req, res);
    return;
  }

  // Debug endpoint to check collab server state
  if (req.url === '/debug/status' && req.method === 'GET') {
    const status = {
      server: 'running',
      persistence: 'Y-Sweet',
      ySweetUrl: config.YSWEET_URL,
      fileHashCacheSize: fileHashCache.size,
      fileHashes: Object.fromEntries(
        Array.from(fileHashCache.entries()).map(([k, v]) => [k, { 
          hash: v.hash.substring(0, 8), 
          timestamp: new Date(v.timestamp).toISOString() 
        }])
      ),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  // ========================================================================
  // SSE ENDPOINT — /sse/:slug — Server-Sent Events for real-time push
  // Replaces HTTP polling for git-status, file-tree-changed, presence, etc.
  // ========================================================================
  if (req.url.startsWith('/sse/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    const userId = req.headers['x-user-id'] || urlObj.searchParams.get('userId') || null;
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing slug', usage: '/sse/:slug?userId=...' }));
      return;
    }
    sseService.handleSSEConnection(req, res, slug, userId);
    return;
  }

  // ========================================================================
  // TELEMETRY ENDPOINT — /telemetry/metrics — Performance metrics snapshot
  // ========================================================================
  if (req.url === '/telemetry/metrics' && req.method === 'GET') {
    const metrics = getMetrics();
    const elBlocks = getEventLoopBlockCount();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ metrics, eventLoopBlocks: elBlocks, timestamp: Date.now() }, null, 2));
    return;
  }

  // POST /telemetry/reset — Reset performance counters
  if (req.url === '/telemetry/reset' && req.method === 'POST') {
    resetMetrics();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Metrics reset' }));
    return;
  }

  // SSE stats endpoint
  if (req.url === '/sse/stats' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sseService.getStats()));
    return;
  }
  
  // Debug endpoint to validate a specific file
  if (req.url.startsWith('/debug/validate/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // /debug/validate/:slug/:filePath
    const slug = parts[3];
    const filePath = parts.slice(4).join('/');
    
    if (!slug || !filePath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing slug or filePath' }));
      return;
    }
    
    const debugUserId = req.headers['x-user-id'] || urlObj.searchParams.get('userId') || null;
    const debugSessionId = req.headers['x-session-id'] || urlObj.searchParams.get('sessionId') || null;
    const docName = buildDocName(slug, filePath, { userId: debugUserId, sessionId: debugSessionId });
    const actualContent = await getActualFileContent(slug, filePath, debugUserId);
    const cachedHash = fileHashCache.get(docName);
    
    const result = {
      docName,
      actualFile: actualContent !== null ? {
        exists: true,
        length: actualContent.length,
        hash: computeHash(actualContent).substring(0, 8),
        preview: actualContent.substring(0, 200),
      } : { exists: false },
      cachedHash: cachedHash ? {
        hash: cachedHash.hash.substring(0, 8),
        timestamp: new Date(cachedHash.timestamp).toISOString(),
      } : null,
      valid: cachedHash && actualContent !== null 
        ? cachedHash.hash === computeHash(actualContent) 
        : null,
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // ========================================================================
  // FILE CONTENT ENDPOINT - Used by AI backend for Container-First analysis
  // ========================================================================
  // GET /file-content/:slug/:filePath - Returns file content from disk (Source of Truth)
  if (req.url.startsWith('/file-content/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // /file-content/:slug/:filePath (filePath can contain slashes)
    const slug = parts[2];
    const filePath = parts.slice(3).join('/');
    
    if (!slug || !filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing slug or filePath', usage: '/file-content/:slug/:filePath' }));
      return;
    }
    
    console.log(`[Collab] FILE-CONTENT request: slug=${slug}, path=${filePath}`);
    
    // Extract optional userId for per-user repo support
    const userId = req.headers['x-user-id'] || urlObj.searchParams.get('userId') || null;

    try {
      // Ensure repo exists and (when configured) hydrate from GCS before reading.
      // Use hydratedSlugs so we re-hydrate once per boot even if the dir exists.
      const hKey = hydrationKey(slug, userId);
      if (!hydratedSlugs.has(hKey)) {
        try {
          await gitService.initRepo(slug, null, userId);
          hydratedSlugs.add(hKey);
        } catch (e) {
          if (gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
            console.warn('[Collab] FILE-CONTENT auto-init failed for slug:', slug, e?.message || e);
          }
        }
      }

      const content = await getActualFileContent(slug, filePath, userId);
      if (content === null) {
        console.log(`[Collab] FILE-CONTENT: File not found: ${slug}/${filePath}`);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File not found', slug, filePath }));
        return;
      }
      
      console.log(`[Collab] FILE-CONTENT: Returning ${content.length} chars for ${slug}/${filePath}`);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (e) {
      console.error(`[Collab] FILE-CONTENT error:`, e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to read file', detail: e.message }));
    }
    return;
  }

  // ========================================================================
  // AVAILABLE-SHELLS ENDPOINT — List shells available on this system
  // ========================================================================
  // GET /available-shells
  // Returns: { shells: [{ key, label, executable }], default: string }
  if (req.url === '/available-shells' && req.method === 'GET') {
    const shells = getAvailableShells();
    const { getDefaultShell } = require('./terminalService');
    const defaultShell = getDefaultShell();
    // Determine which key matches the default shell
    const defaultKey = shells.find(s => defaultShell.includes(s.executable))?.key || shells[0]?.key || 'powershell';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ shells, default: defaultKey }));
    return;
  }

  // EXEC-TERMINAL ENDPOINT — Execute command in a real PTY terminal
  // ========================================================================
  // POST /exec-terminal/:slug  { command: string, timeout?: number }
  // Creates a real PTY session, executes the command, captures output,
  // and keeps the PTY alive so the frontend can connect and see it.
  // Returns: { sessionId, command, output, exitCode, timedOut }
  if (req.url.startsWith('/exec-terminal/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);

    try {
      const { createHeadlessSession } = require('./terminalService');
      const crypto = require('crypto');
      const sessionId = `ai-${crypto.randomUUID().slice(0, 8)}`;

      // Create a real PTY with a known session ID
      const { ptyProcess, cwd } = await createHeadlessSession(sessionId, slug, parsed.userId || '');

      console.log(`[ExecTerminal] slug=${slug} cwd=${cwd} sessionId=${sessionId} cmd=${command.slice(0, 120)}`);

      // Collect output from the PTY
      let output = '';
      const MAX_OUT = 50000;
      let commandDone = false;
      let commandSent = false;

      const outputCollector = (data) => {
        if (output.length < MAX_OUT) output += data;
      };
      ptyProcess.onData(outputCollector);

      // Write the command after the shell finishes its banner output.
      // We detect the shell is ready by waiting for the first prompt.
      // PowerShell prompt: "PS C:\...>" | Bash prompt: "$" or "#"
      const isWin = require('os').platform() === 'win32';
      const promptPattern = isWin ? /PS [^\r\n]*>/ : /[$#]\s*$/;
      let promptCheckInterval;
      let promptWaitTimeout;

      function sendCommand() {
        if (commandSent) return;
        commandSent = true;
        if (promptCheckInterval) clearInterval(promptCheckInterval);
        if (promptWaitTimeout) clearTimeout(promptWaitTimeout);
        ptyProcess.write(command + '\r');
        // Start stability checking AFTER the command is sent + a grace period
        // for the command to start producing output
        setTimeout(startStabilityCheck, 1500);
      }

      // Check every 100ms if prompt appeared
      promptCheckInterval = setInterval(() => {
        if (promptPattern.test(output)) {
          sendCommand();
        }
      }, 100);

      // Fallback: if prompt never detected, send command anyway after 1s
      promptWaitTimeout = setTimeout(() => {
        if (!commandSent) {
          console.log(`[ExecTerminal] Prompt not detected, sending command anyway`);
          sendCommand();
        }
      }, 1000);

      // Wait for the command to finish by detecting the shell prompt returning
      // AFTER the command output. Also use a stability fallback.
      function startStabilityCheck() {
        let lastOutputLen = output.length;
        let stableCount = 0;
        const STABLE_THRESHOLD = 4; // 4 consecutive checks × 500ms = 2s of silence
        const CHECK_INTERVAL = 500;
        let promptSeenAfterCmd = false;

        const checkDone = setInterval(() => {
          // Primary: detect the shell prompt reappearing after command output
          // This means the command finished and the shell is ready for input
          if (commandSent && output.length > lastOutputLen) {
            // Check if the LATEST output chunk contains the prompt
            const recentOutput = output.slice(lastOutputLen);
            if (promptPattern.test(recentOutput)) {
              promptSeenAfterCmd = true;
            }
          }

          if (output.length === lastOutputLen) {
            stableCount++;
          } else {
            stableCount = 0;
            lastOutputLen = output.length;
          }

          // Done when: prompt returned after command output + output stable for 500ms
          // OR: output stable for 2s (fallback for commands that don't return to prompt)
          if ((promptSeenAfterCmd && stableCount >= 1) || stableCount >= STABLE_THRESHOLD || commandDone) {
            clearInterval(checkDone);
            clearTimeout(hardTimeout);
            respond();
          }
        }, CHECK_INTERVAL);
      }

      const hardTimeout = setTimeout(() => {
        respond();
      }, timeoutMs);

      let responded = false;
      function respond() {
        if (responded) return;
        responded = true;

        // Extract the command output: find the echoed command and take everything after it
        // up to (but not including) the next shell prompt
        let cleanOutput = output;

        // Try to extract just the command output (between echoed command and next prompt)
        const cmdIndex = output.indexOf(command);
        if (cmdIndex !== -1) {
          // Start after the echoed command + newline
          const afterCmd = output.slice(cmdIndex + command.length).replace(/^\r?\n/, '');
          // Try to strip the trailing prompt
          const promptMatch = afterCmd.match(isWin ? /\r?\nPS [^\r\n]*>\s*$/ : /\r?\n[^\r\n]*[$#]\s*$/);
          cleanOutput = promptMatch
            ? afterCmd.slice(0, promptMatch.index).trim()
            : afterCmd.trim();
        }

        // Try to infer exit code from output (PTY doesn't expose it directly).
        // Heuristic: check for common error patterns that indicate failure.
        const looksLikeError = /\b(error|fatal|not recognized|cannot be loaded|is not a valid|denied|failed|abort)\b/i.test(cleanOutput)
          && !/\b(0 error|no error|fixed|resolved|warning)\b/i.test(cleanOutput);
        const inferredExitCode = looksLikeError ? 1 : 0;

        console.log(`[ExecTerminal] Done: sessionId=${sessionId} output=${cleanOutput.length}B exitCode=${inferredExitCode}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sessionId,
          command,
          output: cleanOutput || '(no output)',
          exitCode: inferredExitCode,
          timedOut: false,
        }));
      }

      // If the PTY exits before timeout (e.g., single command), respond immediately
      ptyProcess.onExit(({ exitCode }) => {
        commandDone = true;
      });

    } catch (err) {
      console.error('[ExecTerminal] Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }

    return;
  }

  // ========================================================================
  // EXEC-PTY ENDPOINT — Execute command and mirror it to user's terminal
  // ========================================================================
  // POST /exec-pty/:slug  { command: string, timeout?: number }
  // Uses child_process.spawn for reliable, clean stdout/stderr capture,
  // AND writes the command + output to the user's live PTY so they see it.
  if (req.url.startsWith('/exec-pty/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);
    const { resolveWorkspaceCwd } = require('./terminalService');
    const cwd = resolveWorkspaceCwd(slug);

    console.log(`[ExecPTY] slug=${slug} cwd=${cwd} cmd=${command.slice(0, 120)}`);

    // Find active PTY session for this workspace to mirror output
    let targetSession = null;
    for (const [, session] of terminalSessions) {
      if (session.cwd && session.cwd.endsWith(slug) && session.pty) {
        targetSession = session;
        break;
      }
    }

    // Use child_process.spawn for clean, reliable stdout/stderr capture
    const { spawn } = require('child_process');
    const isWin = require('os').platform() === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const MAX_OUT = 50000;

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    }, timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timer);

      const combinedOutput = stdout + (stderr ? `\n${stderr}` : '');

      // NOTE: Do NOT write output to the PTY via pty.write() — that sends INPUT
      // which PowerShell/bash interprets as commands, causing errors.
      // The AI chat UI already displays the command output to the user.

      console.log(`[ExecPTY] Done: exitCode=${exitCode} timedOut=${timedOut} stdout=${stdout.length}B`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        command,
        exitCode,
        stdout,
        stderr,
        timedOut,
        usedPty: Boolean(targetSession),
      }));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[ExecPTY] Spawn error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    return;
  }

  // ========================================================================
  // EXEC ENDPOINT — One-shot command execution for AI tool-calling pipeline
  // ========================================================================
  // POST /exec/:slug  { command: string, timeout?: number }
  if (req.url.startsWith('/exec/') && req.method === 'POST') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing workspace slug' }));
      return;
    }

    // Read JSON body
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed;
    try { parsed = JSON.parse(body); } catch (_) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const command = (parsed.command || '').trim();
    if (!command) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing command' }));
      return;
    }

    const timeoutMs = Math.min(Number(parsed.timeout) || 30000, 60000);
    const { resolveWorkspaceCwd } = require('./terminalService');
    const cwd = resolveWorkspaceCwd(slug);

    console.log(`[Exec] slug=${slug} cwd=${cwd} cmd=${command.slice(0, 120)}`);

    const { spawn } = require('child_process');
    const isWin = require('os').platform() === 'win32';
    const shell = isWin ? 'powershell.exe' : '/bin/bash';
    const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd,
      timeout: timeoutMs,
      env: { ...process.env, TERM: 'dumb' },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const MAX_OUT = 50000;

    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUT) stdout += d.toString(); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUT) stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch (_) {}
    }, timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      console.log(`[Exec] Done: exitCode=${exitCode} timedOut=${timedOut} stdout=${stdout.length}B stderr=${stderr.length}B`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exitCode, stdout, stderr, timedOut }));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      console.error('[Exec] Spawn error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });

    return;
  }

  if (req.url.startsWith('/workspaces') && req.method === 'GET') {
      try {
          // Parse query params for owner
          const url = new URL(req.url, `http://${req.headers.host}`);
          const owner = url.searchParams.get('owner');
          
          const workspaces = workspaceManager.getWorkspaces(owner);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(workspaces));
      } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
      }
      return;
  }

  // ========================================================================
  // MIGRATION STATUS — Check/trigger lazy migration for a workspace
  // ========================================================================
  if (req.url.startsWith('/migration/') && (req.method === 'GET' || req.method === 'POST')) {
    const urlParts = req.url.split('/');
    const migAction = urlParts[2]; // 'status' or 'trigger'
    const migSlug = urlParts[3];

    if (!migSlug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing slug' }));
      return;
    }

    try {
      if (migAction === 'status' && req.method === 'GET') {
        const isLegacy = gitService.isLegacyRepo(migSlug);
        const isMigrated = gitService.isMigratedRepo(migSlug);
        const marker = gitService._readMigrationMarker(migSlug);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slug: migSlug, isLegacy, isMigrated, marker }));
      } else if (migAction === 'trigger' && req.method === 'POST') {
        console.log(`[Server] Manual migration trigger for: ${migSlug}`);
        const result = await gitService.ensureMigrated(migSlug);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slug: migSlug, ...result }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unknown migration action' }));
      }
    } catch (e) {
      console.error(`[Migration API] Error for ${migSlug}:`, e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, code: e.code || 'MIGRATION_ERROR' }));
    }
    return;
  }

  // ========================================================================
  // USER BLOCK API — Block/unblock other users
  // ========================================================================

  /**
   * POST /user/block  { userId, blockedUserId }
   * Blocks blockedUserId for userId. The blocked user won't see userId in
   * presence, can't invite them, and can't join their workspace.
   */
  if (req.url === '/user/block' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { userId, blockedUserId } = JSON.parse(body);
        if (!userId || !blockedUserId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'userId and blockedUserId are required' }));
          return;
        }
        if (!blockedBy.has(userId)) blockedBy.set(userId, new Set());
        blockedBy.get(userId).add(blockedUserId);
        logger.info('user_blocked', { userId, blockedUserId });
        // Persist asynchronously — never block the request on storage latency.
        persistence.saveBlock(userId, blockedUserId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /**
   * POST /user/unblock  { userId, blockedUserId }
   */
  if (req.url === '/user/unblock' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { userId, blockedUserId } = JSON.parse(body);
        if (!userId || !blockedUserId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'userId and blockedUserId are required' }));
          return;
        }
        if (blockedBy.has(userId)) {
          blockedBy.get(userId).delete(blockedUserId);
          if (blockedBy.get(userId).size === 0) blockedBy.delete(userId);
        }
        logger.info('user_unblocked', { userId, blockedUserId });
        persistence.removeBlock(userId, blockedUserId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /**
   * GET /user/blocked-list?userId=...
   * Returns the list of blocked user IDs for the given user.
   */
  if (req.url.startsWith('/user/blocked-list') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const userId = urlObj.searchParams.get('userId');
    if (!userId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'userId is required' }));
      return;
    }
    const list = blockedBy.has(userId) ? Array.from(blockedBy.get(userId)) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ userId, blockedUsers: list }));
    return;
  }

  // ========================================================================
  // PRESENCE — is a given user currently online?
  //
  //   GET /presence/user/:userId
  //   → { userId, online, inboxPending }
  //
  // Consumers use this to decide whether to show "User is offline, we'll
  // notify them when they return" vs. "Sending invite now...".  inboxPending
  // is how many queued events are waiting for their next connect.
  // ========================================================================
  if (req.url.startsWith('/presence/user/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const userId = decodeURIComponent(urlObj.pathname.split('/')[3] || '');
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'userId is required' }));
        return;
      }
      const online = isUserOnline(userId);
      const inboxPending = online ? 0 : await persistence.peekUserInboxSize(userId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ userId, online, inboxPending }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // FILE HISTORY + VERSIONS — audit log + server-side undo for saves.
  // Backed by Redis (persistence.js).  Returns an empty list when
  // persistence is disabled.
  //
  //   GET /file-history/:slug?filePath=...&limit=50
  //   GET /file-versions/:slug?filePath=...
  //   GET /file-version/:slug?filePath=...&index=N
  // ========================================================================
  if (req.url.startsWith('/file-history/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const slug = decodeURIComponent(urlObj.pathname.split('/')[2] || '');
      const filePath = urlObj.searchParams.get('filePath') || '';
      const limit = parseInt(urlObj.searchParams.get('limit') || '50', 10);
      if (!slug || !filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slug and filePath are required' }));
        return;
      }
      try { validateFilePath(filePath); }
      catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); return; }
      const events = await persistence.getFileHistory(slug, filePath, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, filePath, events }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/file-versions/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const slug = decodeURIComponent(urlObj.pathname.split('/')[2] || '');
      const filePath = urlObj.searchParams.get('filePath') || '';
      if (!slug || !filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slug and filePath are required' }));
        return;
      }
      try { validateFilePath(filePath); }
      catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); return; }
      // Metadata-only listing by default — content retrieval is a separate
      // call so the default response is cheap.
      const versions = await persistence.getFileVersions(slug, filePath, { withContent: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, filePath, versions }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.url.startsWith('/file-version/') && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const slug = decodeURIComponent(urlObj.pathname.split('/')[2] || '');
      const filePath = urlObj.searchParams.get('filePath') || '';
      const index = parseInt(urlObj.searchParams.get('index') || '0', 10);
      if (!slug || !filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slug and filePath are required' }));
        return;
      }
      try { validateFilePath(filePath); }
      catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); return; }
      const version = await persistence.getFileVersion(slug, filePath, index);
      if (!version) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'version_not_found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, filePath, index, version }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // POST /file-version/restore — rewrite a file back to a stored version.
  //
  // Body: { slug, filePath, index, userId, sessionId? }
  //   - slug + filePath: target file (traversal-checked via realpath)
  //   - index: position in the version list (0 = most recent save-point)
  //   - userId: actor performing the restore
  //   - sessionId: optional. When set, the host's repo is the restore target
  //     and the caller must be the host or a guest with canEdit.
  //
  // Effects: disk rewrite, Y-Sweet CRDT content reset (falls back to doc
  // invalidation if the SDK lacks a write path), new save-point logged,
  // broadcasts file-saved + git-status-changed.
  // ========================================================================
  if (req.url === '/file-version/restore' && req.method === 'POST') {
    if (!rateLimitGuard(req, res, 'file-version-restore', 20)) return;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { slug, filePath, userId } = payload;
        const sessionId = payload.sessionId || null;
        const index = Number.isFinite(payload.index) ? payload.index : parseInt(payload.index, 10);
        if (!slug || !filePath || !Number.isFinite(index) || index < 0 || !userId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'slug, filePath, index (>=0), userId are required' }));
          return;
        }
        const { isValidUserId, isValidSessionId } = require('./permissionMiddleware');
        if (!isValidUserId(userId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_userId' }));
          return;
        }
        if (sessionId && !isValidSessionId(sessionId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_sessionId' }));
          return;
        }
        let normalizedPath;
        try { normalizedPath = validateFilePath(filePath); }
        catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
          return;
        }

        // Resolve which user's repo + CRDT room to rewrite.  Session flows
        // always target the host; solo flows target the caller.
        let targetUserId = userId;
        if (sessionId) {
          const session = sessionManager.getSession(sessionId);
          if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'session_not_found' }));
            return;
          }
          if (session.slug !== slug) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'session_slug_mismatch' }));
            return;
          }
          if (session.hostId !== userId &&
              !sessionManager.checkPermission(sessionId, userId, 'canEdit')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'edit_permission_required' }));
            return;
          }
          targetUserId = session.hostId;
        }

        const version = await persistence.getFileVersion(slug, normalizedPath, index);
        if (!version) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'version_not_found' }));
          return;
        }
        if (!version.hasContent || typeof version.content !== 'string') {
          // Oversized versions are stored as metadata only.  Hand the
          // caller the hash so they can show "snapshot exists but was too
          // large to keep" rather than silently failing.
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'version_content_unavailable',
            hash: version.hash || null,
            size: version.size || null,
          }));
          return;
        }

        const content = version.content;
        const docName = buildDocName(slug, normalizedPath, {
          userId: targetUserId,
          sessionId,
        });

        const repoPath = gitService.getEffectiveRepoPath(slug, targetUserId);
        if (!fs.existsSync(repoPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'repo_not_found' }));
          return;
        }
        // Belt-and-braces traversal guard: resolve symlinks inside the
        // repo before writing.  validateFilePath already rejected `..`
        // segments, but a symlink pointing out of the tree is still
        // possible without this check.
        let fullPath;
        try {
          const realRepo = await fsPromises.realpath(repoPath);
          fullPath = path.resolve(realRepo, normalizedPath);
          const rel = path.relative(realRepo, fullPath);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error('path escapes repo root');
          }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_repo_path', detail: e.message }));
          return;
        }

        // 1) Disk is authoritative — rewrite it first.
        await gitService.safeWriteFile(fullPath, content);

        // 2) Pull the CRDT doc onto the restored content so live editors
        // converge without data loss, then ALWAYS hard-invalidate the doc.
        //
        // A successful resetDocContent alone is not sufficient: a client with
        // the file open may have newer local edits in its Y.Doc that would
        // merge with (rather than replace) the restored state, so the editor
        // keeps showing the unrestored text.  broadcastFileReverted triggers
        // the Editor's synthi:file-reverted handler (Editor.jsx:~2395) which
        // clears the Monaco model and re-fetches from disk; the preceding
        // invalidateDocsForSlug destroys the Y.Doc binding so Monaco can't
        // merge stale CRDT state back in on reconnect.
        let crdtReset = false;
        try {
          crdtReset = await ySweetBridge.resetDocContent(docName, content);
        } catch (err) {
          logger.warn('file_version_restore_crdt_reset_failed', { docName }, err);
          crdtReset = false;
        }
        await invalidateDocsForSlug(slug, [normalizedPath], {
          userId: targetUserId,
          sessionId,
        });

        // 3) Truncate any newer versions — after restore they no longer
        // represent the live timeline.  The entry at `index` becomes the
        // new head (index 0), so the list is: [restored-content, ...older].
        // No duplicate saveFileVersion: the restored content is already
        // the new index 0 by virtue of the trim.
        const restoredHash = computeHash(content);
        const size = Buffer.byteLength(content, 'utf8');
        fileHashCache.set(docName, { hash: restoredHash, timestamp: Date.now() });
        await persistence.truncateVersionsAbove(slug, normalizedPath, index);
        persistence.logFileEvent(slug, normalizedPath, {
          kind: 'restored',
          userId,
          sessionId,
          hash: restoredHash,
          size,
          meta: { fromIndex: index, fromHash: version.hash || null, targetUserId },
        });

        broadcastFileSaved(slug, normalizedPath, { userId: targetUserId, sessionId });
        broadcastGitStatusChanged(slug, normalizedPath, { userId: targetUserId, sessionId });
        // Tell the Editor to hard-refresh its model from disk.  This is the
        // event page.jsx's useSSEEvent(…'file-reverted'…) turns into the
        // 'synthi:file-reverted' DOM event the Editor handler waits for.
        broadcastFileReverted(slug, [normalizedPath], { userId: targetUserId, sessionId });

        logger.info('file_version_restored', {
          slug,
          filePath: normalizedPath,
          index,
          actor: userId,
          sessionId,
          targetUserId,
          hash: restoredHash,
          size,
          crdtReset,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          slug,
          filePath: normalizedPath,
          index,
          restoredHash,
          size,
          targetUserId,
          docName,
          crdtReset,
        }));
      } catch (e) {
        logger.error('file_version_restore_failed', {}, e);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ========================================================================
  // Y-SWEET TOKEN API — Issue connection tokens for CRDT document rooms
  // ========================================================================
  if (req.url.startsWith('/ysweet/token') && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { docId } = JSON.parse(body || '{}');
        if (!docId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'docId is required' }));
          return;
        }

        // Defensive: before issuing the token, reconcile the Y-Sweet doc
        // with the authoritative disk content.  If an out-of-band write
        // happened while no one was connected (AI agent on a workspace the
        // user hasn't opened yet; fs-watcher never fired), the fs-watcher
        // invalidation path above won't have run.  Compare hashes and reset
        // the Y-Sweet doc if disk is newer.
        try {
          const parsed = parseDocName(docId);
          if (parsed?.slug && parsed?.filePath) {
            const effectiveUser = resolveEffectiveUserForDoc(parsed, null);
            const diskContent = await getActualFileContent(parsed.slug, parsed.filePath, effectiveUser);
            if (diskContent !== null) {
              const diskHash = computeHash(diskContent);
              const crdtContent = await ySweetBridge.readDocContent(docId);
              const crdtHash = crdtContent == null ? null : computeHash(crdtContent);
              if (crdtHash !== null && crdtHash !== diskHash) {
                console.log(`[Collab Token] Disk/CRDT hash mismatch for ${parsed.filePath} — resetting Y-Sweet doc to disk content`);
                const ok = await ySweetBridge.resetDocContent(docId, diskContent);
                if (!ok) {
                  // Reset unsupported — fall back to broadcast invalidation
                  // so connected clients destroy their Y.Docs.
                  await invalidateDocsForSlug(parsed.slug, [parsed.filePath], effectiveUser ? { userId: effectiveUser } : {});
                }
              }
              fileHashCache.set(docId, { hash: diskHash, timestamp: Date.now() });
            }
          }
        } catch (reconcileErr) {
          console.warn('[Collab Token] Pre-issue reconcile failed:', reconcileErr?.message || reconcileErr);
        }

        const tokenData = await ySweetBridge.getOrCreateToken(docId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tokenData));
      } catch (e) {
        console.error('[Y-Sweet Token] Error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ========================================================================
  // WORKSPACE PRESENCE API — Active users + sessions for a workspace
  // ========================================================================
  if (req.url.startsWith('/workspace-presence/') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const slug = urlObj.pathname.split('/')[2];
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'slug is required' }));
      return;
    }

    try {
      // 1) Gather active users from notification WebSocket connections.
      //    Each notification WS client carries _slug, _userId, _userName,
      //    _userImage metadata set during the connection handshake.
      const seen = new Map();
      if (notifyWss) {
        notifyWss.clients.forEach((ws) => {
          if (ws.readyState !== WebSocket.OPEN || ws._slug !== slug) return;
          const uid = ws._userId;
          if (!uid) return;
          if (!seen.has(uid)) {
            seen.set(uid, {
              id: uid,
              name: ws._userName || userDisplayNameCache.get(uid)?.name || 'Anonymous',
              color: ws._userColor || '#888',
              image: ws._userImage || userDisplayNameCache.get(uid)?.avatar || null,
              lastActive: Date.now(),
              currentFile: null,
            });
          }
        });
      }
      let activeUsers = Array.from(seen.values());

      // 2) Get active collaboration sessions for this slug
      const sessions = sessionManager.getSessionsForSlug(slug);

      // 3) Filter out blocked users
      const requesterId = urlObj.searchParams.get('userId');
      if (requesterId) {
        const myBlocked = blockedBy.get(requesterId) || new Set();
        activeUsers = activeUsers.filter(u => {
          if (u.id === requesterId) return true;
          if (myBlocked.has(u.id)) return false;
          const theirBlocked = blockedBy.get(u.id);
          if (theirBlocked && theirBlocked.has(requesterId)) return false;
          return true;
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ slug, activeUsers, sessions }));
    } catch (e) {
      console.error('[Workspace Presence] Error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ========================================================================
  // DIRECT COLLABORATION — invite / ask-to-join a user (no pre-existing
  // session required). Sessions are auto-created on demand.
  // ========================================================================

  /**
   * POST /session/invite-user
   * Inviter becomes host (auto-creates session if not already hosting).
   * Sends an invite notification to the target user via notification WS.
   * Target can accept by knocking on the auto-created session.
   */
  if (req.url.startsWith('/session/invite-user') && req.method === 'POST') {
    if (!rateLimitGuard(req, res, 'invite-user', 30)) return;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { hostId, hostName, hostAvatar, targetUserId, slug } = data;
        if (!hostId || !targetUserId || !slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'hostId, targetUserId, and slug are required' }));
          return;
        }

        // Block check: if target blocked host or host blocked target, deny
        const targetBlocked = blockedBy.get(targetUserId);
        const hostBlocked = blockedBy.get(hostId);
        if ((targetBlocked && targetBlocked.has(hostId)) || (hostBlocked && hostBlocked.has(targetUserId))) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot invite this user' }));
          return;
        }

        // Auto-create session if needed
        let session = sessionManager.getSessionByHost(hostId);
        if (!session) {
          session = sessionManager.createSession({
            hostId,
            hostName: hostName || hostId,
            hostAvatar: hostAvatar || '',
            slug,
            worktreePath: '', // resolved at git-op time
            defaultPerms: { canEdit: true, canTerminal: false, canGit: false, canFileOps: true },
          });
        }

        // Track this user as invited so they are auto-admitted on knock
        sessionManager.addInvitedUser(session.id, targetUserId);

        // Deliver the collab-invite to the target user.  If they're online
        // on this slug we send over the notify-WS immediately; if they're
        // offline the event lands in their Redis inbox and pops as a
        // "missed while offline" notification next time they connect.
        const invitePayload = {
          slug,
          sessionId: session.id,
          hostId,
          hostName: hostName || hostId,
          hostAvatar: hostAvatar || '',
          inviteToken: session.inviteToken,
          roomCode: session.roomCode || null,
        };
        deliverToUser(targetUserId, 'collab-invite', invitePayload, { slug })
          .then((r) => logger.info('invite_delivery', { targetUserId, slug, delivered: r.delivered, queued: r.queued }))
          .catch((err) => logger.warn('invite_delivery_failed', { targetUserId, slug }, err));

        const appUrl = process.env.SYNTHI_APP_URL || 'http://localhost:3000';
        const inviteLink = `${appUrl}/collab/${session.id}?token=${session.inviteToken}${session.roomCode ? `&code=${session.roomCode}` : ''}`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          sessionId: session.id,
          inviteToken: session.inviteToken,
          inviteLink,
          roomCode: session.roomCode || null,
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /**
   * POST /session/join-user
   * Request to join a specific user's workspace.  If the target user
   * doesn't have an active session yet, one is implicitly created for
   * them by the server.  The guest's knock is then forwarded to that
   * session so the target user can accept/deny.
   */
  if (req.url.startsWith('/session/join-user') && req.method === 'POST') {
    if (!rateLimitGuard(req, res, 'join-user', 30)) return;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { targetUserId, targetUserName, guestId, displayName, avatarUrl, slug } = data;
        if (!targetUserId || !guestId || !slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'targetUserId, guestId, and slug are required' }));
          return;
        }

        // Block check: if target blocked guest or guest blocked target, deny
        const targetBlocked = blockedBy.get(targetUserId);
        const guestBlocked = blockedBy.get(guestId);
        if ((targetBlocked && targetBlocked.has(guestId)) || (guestBlocked && guestBlocked.has(targetUserId))) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot join this user' }));
          return;
        }

        // Find or auto-create a session for the target user
        let session = sessionManager.getSessionByHost(targetUserId);
        if (!session) {
          // Resolve a human-readable host name: prefer the name provided by
          // the joining guest's UI, then check the in-memory display-name
          // cache (populated from Yjs awareness), and finally fall back to
          // targetUserId.
          let resolvedHostName = targetUserName || '';
          if (!resolvedHostName) {
            const cached = userDisplayNameCache.get(targetUserId);
            if (cached?.name) {
              resolvedHostName = cached.name;
            }
          }
          const cachedAvatar = userDisplayNameCache.get(targetUserId)?.avatar || '';
          session = sessionManager.createSession({
            hostId: targetUserId,
            hostName: resolvedHostName || targetUserId,
            hostAvatar: cachedAvatar,
            slug,
            worktreePath: '',
            defaultPerms: { canEdit: true, canTerminal: false, canGit: false, canFileOps: true },
          });
          // Auto-created sessions are unconfirmed until the host explicitly
          // accepts the first guest.  This prevents the session from showing
          // as "LIVE" in workspace-presence before the host is aware of it.
          session.hostConfirmed = false;
          console.log(`[Session] Auto-created session ${session.id} for host ${targetUserId} (on demand, unconfirmed)`);

          // Notify the target user that a session was auto-created for them
          const autoHostMsg = JSON.stringify({
            type: 'auto-session-created',
            slug,
            sessionId: session.id,
            inviteToken: session.inviteToken,
          });
          // Send to session WS and notification WS
          if (sessionWss) {
            sessionWss.clients.forEach((ws) => {
              if (ws.readyState === WebSocket.OPEN && ws._userId === targetUserId) {
                try { ws.send(autoHostMsg); } catch (_) {}
              }
            });
          }
          if (notifyWss) {
            notifyWss.clients.forEach((ws) => {
              if (ws.readyState === WebSocket.OPEN && ws._slug === slug && ws._userId === targetUserId) {
                try { ws.send(autoHostMsg); } catch (_) {}
              }
            });
          }
        }

        // Knock on the session (may auto-admit if invited)
        const knockResult = sessionManager.knock(session.id, {
          guestId,
          displayName: displayName || guestId,
          avatarUrl: avatarUrl || '',
        });

        const response = {
          success: true,
          sessionId: session.id,
          autoAdmitted: knockResult?.autoAdmitted || false,
          message: knockResult?.autoAdmitted ? 'Auto-admitted (invited user)' : 'Join request sent',
        };
        if (knockResult?.autoAdmitted && knockResult?.guest) {
          response.guest = knockResult.guest;
          response.hostId = session.hostId;
          response.hostName = session.hostName;
          response.slug = session.slug;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ========================================================================
  // SESSION INVITE API — Request to join another user's session
  // ========================================================================

  /**
   * POST /session/join-by-code
   * Join a session using a short room code. Triggers the knock flow
   * (or auto-admit if the host previously invited this user).
   */
  if (req.url.startsWith('/session/join-by-code') && req.method === 'POST') {
    // Stricter budget: room codes are a guessable secret so brute-force
    // attempts need to be throttled aggressively.
    if (!rateLimitGuard(req, res, 'join-by-code', 10)) return;
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { code, guestId, displayName, avatarUrl } = data;
        if (!code || !guestId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'code and guestId are required' }));
          return;
        }
        const session = sessionManager.getSessionByRoomCode(code);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired room code' }));
          return;
        }
        // Block check
        const hostBlocked = blockedBy.get(session.hostId);
        const guestBlocked = blockedBy.get(guestId);
        if ((hostBlocked && hostBlocked.has(guestId)) || (guestBlocked && guestBlocked.has(session.hostId))) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot join this session' }));
          return;
        }
        // Knock on the session (may auto-admit if invited)
        const knockResult = sessionManager.knock(session.id, {
          guestId,
          displayName: displayName || guestId,
          avatarUrl: avatarUrl || '',
        });
        const response = {
          success: true,
          sessionId: session.id,
          hostName: session.hostName,
          slug: session.slug,
          autoAdmitted: knockResult?.autoAdmitted || false,
          message: knockResult?.autoAdmitted ? 'Auto-admitted (invited user)' : 'Join request sent',
        };
        if (knockResult?.autoAdmitted && knockResult?.guest) {
          response.guest = knockResult.guest;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/session/request-join/') && req.method === 'POST') {
    if (!rateLimitGuard(req, res, 'request-join', 30)) return;
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const targetSessionId = urlObj.pathname.split('/')[3];
    if (!targetSessionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'sessionId is required' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { guestId, displayName, avatarUrl } = data;
        if (!guestId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'guestId is required' }));
          return;
        }
        // Reuse knock mechanism — "request to join" is semantically the same
        const knockResult = sessionManager.knock(targetSessionId, { guestId, displayName: displayName || guestId, avatarUrl: avatarUrl || '' });
        const response = {
          success: true,
          autoAdmitted: knockResult?.autoAdmitted || false,
          message: knockResult?.autoAdmitted ? 'Auto-admitted (invited user)' : 'Join request sent',
        };
        if (knockResult?.autoAdmitted && knockResult?.guest) {
          response.guest = knockResult.guest;
          const sess = sessionManager.getSession(targetSessionId);
          response.hostId = sess?.hostId || null;
          response.hostName = sess?.hostName || null;
          response.slug = sess?.slug || null;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ========================================================================
  // SESSION API — Host/Guest "Remote Control" collaboration
  // ========================================================================
  if (req.url.startsWith('/session/') && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // /session/:action[/:sessionId]
    const action = parts[2];
    const sessionIdParam = parts[3] || null;

    // Per-action rate budgets.  GETs (info, validate-token) get a generous
    // ceiling; write-heavy ops get tighter ones.
    const RATE_BUDGETS = {
      create: 20,
      'validate-token': 60,
      knock: 30,
      admit: 60,
      deny: 60,
      permissions: 60,
      kick: 30,
      leave: 60,
      terminate: 20,
      info: 120,
      'regenerate-token': 10,
    };
    const budget = RATE_BUDGETS[action];
    if (budget && !rateLimitGuard(req, res, `session:${action}`, budget)) return;

    // sessionId parameter must look like the format emitted by SessionManager
    // (hex, 2*SESSION_ID_LEN chars).  Reject malformed IDs before they reach
    // any manager call — defence-in-depth against injection via URL paths.
    if (sessionIdParam && !/^[a-f0-9]{8,64}$/i.test(sessionIdParam)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_session_id_format' }));
      return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        let result;

        switch (action) {
          case 'create': {
            // POST /session/create — Host creates a new collab session
            const { hostId, hostName, hostAvatar, slug, defaultPerms } = data;
            if (!hostId || !slug) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'hostId and slug are required' }));
              return;
            }
            // Direct-access model: ensure the host's per-user repo exists
            // (guests will share this repo via effectiveUserId mapping).
            // No separate worktree needed — all participants use repos/<slug>/<hostId>/.
            let hostRepoPath = null;
            try {
              const hostRepo = await gitService.ensureUserRepo(slug, hostId);
              hostRepoPath = hostRepo.path;
            } catch (e) {
              console.warn(`[Collab] Could not ensure host repo for session: ${e.message}`);
            }
            const session = sessionManager.createSession({
              hostId, hostName: hostName || hostId, hostAvatar: hostAvatar || '',
              slug, worktreePath: hostRepoPath || '', defaultPerms,
            });
            result = {
              sessionId: session.id,
              inviteToken: session.inviteToken,
              worktreePath: session.worktreePath,
              roomCode: session.roomCode || null,
              createdAt: session.createdAt,
              inviteLink: `${process.env.SYNTHI_APP_URL || 'http://localhost:3000'}/collab/${session.id}?token=${session.inviteToken}${session.roomCode ? `&code=${session.roomCode}` : ''}`,
            };
            break;
          }

          case 'validate-token': {
            // GET /session/validate-token?token=xyz
            const token = urlObj.searchParams.get('token') || data.token;
            result = sessionManager.validateToken(token);
            if (!result) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid or expired invite token' }));
              return;
            }
            break;
          }

          case 'knock': {
            // POST /session/knock/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            sessionManager.knock(sessionIdParam, data);
            result = { success: true };
            break;
          }

          case 'admit': {
            // POST /session/admit/:sessionId — Host admits a guest
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            // Verify the requester is the session host
            const admitCheckSession = sessionManager.getSession(sessionIdParam);
            if (!admitCheckSession) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            if (data.requesterId && data.requesterId !== admitCheckSession.hostId) {
              console.warn(`[Session] Non-host user ${data.requesterId} attempted to admit guest in session ${sessionIdParam}`);
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Only the session host can admit guests' }));
              return;
            }
            const guest = sessionManager.admitGuest(sessionIdParam, data);
            result = { success: true, guest };
            // NOTE: Do NOT broadcastSessionEvent here — admitGuest() emits
            // 'session:guestJoined' which triggers the listener that broadcasts.
            // Calling it here too caused doubled "X joined" toasts.
            break;
          }

          case 'deny': {
            // POST /session/deny/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            // Verify the requester is the session host
            const denyCheckSession = sessionManager.getSession(sessionIdParam);
            if (!denyCheckSession) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            if (data.requesterId && data.requesterId !== denyCheckSession.hostId) {
              console.warn(`[Session] Non-host user ${data.requesterId} attempted to deny guest in session ${sessionIdParam}`);
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Only the session host can deny guests' }));
              return;
            }
            sessionManager.denyKnock(sessionIdParam, data.guestId);
            result = { success: true };
            break;
          }

          case 'permissions': {
            // POST /session/permissions/:sessionId — Update guest perms
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            const perms = sessionManager.updatePermissions(sessionIdParam, data.guestId, data.permissions);
            result = { success: true, permissions: perms };
            // NOTE: Do NOT broadcastSessionEvent here — updatePermissions() emits
            // 'session:permissionsUpdated' which triggers the listener that broadcasts.
            // Calling it here too caused doubled "permissions updated" toasts.
            break;
          }

          case 'kick': {
            // POST /session/kick/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            // Verify the requester is the session host
            const kickCheckSession = sessionManager.getSession(sessionIdParam);
            if (!kickCheckSession) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            if (data.requesterId && data.requesterId !== kickCheckSession.hostId) {
              console.warn(`[Session] Non-host user ${data.requesterId} attempted to kick guest in session ${sessionIdParam}`);
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Only the session host can kick guests' }));
              return;
            }
            sessionManager.removeGuest(sessionIdParam, data.guestId, 'kicked');
            result = { success: true };
            broadcastSessionEvent(sessionIdParam, 'guest:kicked', { guestId: data.guestId });
            break;
          }

          case 'leave': {
            // POST /session/leave/:sessionId  — guest voluntarily leaves
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            const guestId = data.guestId || data.userId;
            if (guestId) {
              sessionManager.removeGuest(sessionIdParam, guestId, 'left');
              broadcastSessionEvent(sessionIdParam, 'guest:left', { guestId });
            }
            result = { success: true };
            break;
          }

          case 'terminate': {
            // DELETE /session/terminate/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            // NOTE: Do NOT broadcastSessionEvent here — terminateSession() emits
            // 'session:terminated' which triggers the listener that broadcasts.
            // Calling it here too caused doubled "session ended" toasts.
            sessionManager.terminateSession(sessionIdParam);
            result = { success: true };
            break;
          }

          case 'info': {
            // GET /session/info/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            result = sessionManager.getSession(sessionIdParam);
            if (!result) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Session not found' }));
              return;
            }
            break;
          }

          case 'regenerate-token': {
            // POST /session/regenerate-token/:sessionId
            if (!sessionIdParam) { res.writeHead(400); res.end('Missing sessionId'); return; }
            const regenResult = sessionManager.regenerateToken(sessionIdParam);
            result = {
              inviteToken: regenResult.inviteToken,
              roomCode: regenResult.roomCode,
              inviteLink: `${process.env.SYNTHI_APP_URL || 'http://localhost:3000'}/collab/${sessionIdParam}?token=${regenResult.inviteToken}${regenResult.roomCode ? `&code=${regenResult.roomCode}` : ''}`,
            };
            break;
          }

          default:
            res.writeHead(404);
            res.end('Unknown session action');
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('[Session API] Error:', e.message);
        res.writeHead(e.message.includes('not found') ? 404 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/git/')) {
    // Parse URL: /git/:slug/:action
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const parts = urlObj.pathname.split('/');
    // parts[0] = '', parts[1] = 'git', parts[2] = slug, parts[3] = action
    const slug = parts[2];
    const action = parts[3];

    if (!slug || !action) {
        res.writeHead(400);
        res.end('Invalid request');
        return;
    }

    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
        try {
            const data = body ? JSON.parse(body) : {};
            // Merge query params into data
            for (const [key, value] of urlObj.searchParams) {
                data[key] = value;
            }

        // Ensure the workspace repo exists for this slug.
        // This avoids REPO_NOT_FOUND for fresh workspaces and allows the server to
        // hydrate from GCS automatically (when configured) without requiring a manual
        // "Initialize Git" click.

            // ── Session permission enforcement ──────────────────────────
            // Extract session context from headers/query and check permissions
            const sessionId = req.headers['x-session-id'] || urlObj.searchParams.get('sessionId');
            const userId    = req.headers['x-user-id']    || urlObj.searchParams.get('userId');

            // ── Direct-access collaboration ─────────────────────────────
            // When a guest is in a session, all their git operations target
            // the HOST's repo.  Resolve the "effective" userId that will be
            // used for repo path resolution and git operations.
            const effectiveUserId = sessionId && userId
              ? sessionManager.getEffectiveUserId(userId, sessionId)
              : userId;

            if (effectiveUserId && effectiveUserId !== userId) {
              console.log(`[Collab] Direct-access: guest=${userId} → host=${effectiveUserId} session=${sessionId} action=${action}`);
            }

            const notifyScope = { userId: effectiveUserId || null, sessionId: sessionId || null };
            const bootstrapUserId = effectiveUserId || userId || null;

            // ── Per-requester token isolation ──────────────────────────
            // Repo path / working tree → effectiveUserId (guest writes
            //   into the host's worktree).
            // Auth tokens → the *real* requesting user, so a guest's PAT
            //   gets stored under their own bucket and doesn't clobber
            //   the host's. If the requester has no token of their own,
            //   we fall back to the host's bucket (keeps today's "guest
            //   borrows host's PAT" behavior working seamlessly).
            const tokenUserId = userId || null;
            const tokenFallbackUserIds = (effectiveUserId && effectiveUserId !== userId)
                ? [effectiveUserId]
                : [];

            // ── Per-requester commit attribution ───────────────────────
            // Headers populated by the frontend from NextAuth. When set,
            // the gitService pins GIT_AUTHOR_*/GIT_COMMITTER_* to these
            // values for the duration of the spawned git process, so a
            // guest's commits land in the host's worktree but show up
            // under the guest's GitHub identity.
            const decodeHeader = (raw) => {
                if (!raw || typeof raw !== 'string') return '';
                // Safe-decode a header value that the frontend
                // base64-encodes (so non-ASCII names don't violate
                // RFC 7230 token chars). Falls back to the raw value
                // if decoding produces nothing useful.
                try {
                    const decoded = Buffer.from(raw, 'base64').toString('utf8');
                    if (decoded && /[\w@.+\- ]/.test(decoded)) return decoded.trim();
                } catch (_) {}
                return raw.trim();
            };
            const reqName  = decodeHeader(req.headers['x-user-name']);
            const reqEmail = decodeHeader(req.headers['x-user-email']);
            const commitIdentity = (reqName || reqEmail)
                ? { name: reqName || null, email: reqEmail || null }
                : null;

            // ── Permission check FIRST ──────────────────────────────────
            // Check permissions BEFORE provisioning repos to prevent
            // unauthorized users from creating per-user repos and corrupting
            // the workspace directory structure.  Even though the frontend
            // redirects unauthorized users away, API calls may fire before
            // the redirect completes, and malicious actors could hit the
            // endpoint directly.
            if (sessionId && userId) {
              const permKey = require('./permissionMiddleware').GIT_ACTION_PERMISSIONS[action];
              if (permKey && !sessionManager.checkPermission(sessionId, userId, permKey)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'permission_denied',
                  message: `Action "${action}" requires "${permKey}" permission. Ask the Host for access.`,
                  required: permKey,
                }));
                return;
              }
            } else if (action !== 'init' && action !== 'clone') {
              // Require userId for ALL actions (except bootstrapping).
              // Without a userId the server falls back to the slug-level
              // directory which may not be a valid git repo (migrated
              // repos only have _upstream.git and per-user directories).
              if (!effectiveUserId) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  error: 'authentication_required',
                  message: 'A valid userId is required for this action.',
                }));
                return;
              }
            }

        // Use hydratedSlugs so we re-hydrate once per boot even when the dir already
        // exists with partial/stale content (e.g. .code_intel artifacts).
        // Now safe to run AFTER permission check.
        const hKey = hydrationKey(slug, effectiveUserId);
        if (action !== 'clone' && !hydratedSlugs.has(hKey)) {
          try {
            // initRepo will mkdir the repo path, init .git, and (when configured)
            // pull the current workspace contents from GCS.
            // Pass effectiveUserId so it also provisions the per-user working tree.
            await gitService.initRepo(slug, null, effectiveUserId);
            hydratedSlugs.add(hKey);
          } catch (e) {
            // If init fails, continue so the normal handler can return a structured error.
            if (gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
              console.warn('[Collab] auto-init repo failed for slug:', slug, e?.message || e);
            }
          }
        }

            // ── Per-user repo provisioning (mandatory) ──────────────────
            // Ensure the per-user working tree exists for EVERY action (incl.
            // init/clone which now also call ensureUserRepo internally).
            // Guests use the host's repo (effectiveUserId = hostId), so they
            // skip provisioning a separate repo.
            if (effectiveUserId) {
              try {
                await gitService.ensureUserRepo(slug, effectiveUserId);
                // Pin the per-user repo in the cache so it won't be evicted
                // while this user is actively interacting with the workspace.
                // Unpinning happens when the notification WS disconnects.
                repoCache.pin(slug, effectiveUserId);
              } catch (e) {
                // For non-clone/init actions this is a real error — the user
                // cannot operate without an isolated repo.
                if (action !== 'clone' && action !== 'init') {
                  console.error(`[Collab] ensureUserRepo FAILED for ${slug}/${effectiveUserId}:`, e.message);
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({
                    error: 'user_repo_error',
                    message: `Failed to provision per-user repo for ${effectiveUserId}: ${e.message}`,
                  }));
                  return;
                }
              }
            }

            let result;

            // Validate file paths before processing any action that accepts one.
            // This prevents path-traversal attacks (e.g. "../../etc/passwd").
            const FILE_PATH_ACTIONS = [
              'discard', 'discard-lines', 'stage', 'stage-lines', 'unstage', 'sync',
              'file-content', 'resolve-ours', 'resolve-theirs',
              'mark-resolved', 'conflict-versions', 'read-file', 'write-file',
            ];
            if (FILE_PATH_ACTIONS.includes(action) && data.filePath) {
              try {
                data.filePath = validateFilePath(data.filePath);
              } catch (pathErr) {
                console.warn(`[Collab] Path validation failed for action=${action}:`, pathErr.message);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_path', message: pathErr.message }));
                return;
              }
            }

            switch (action) {
                case 'init':
                result = await gitService.initRepo(slug, data.remoteUrl, bootstrapUserId, tokenUserId);
                hydratedSlugs.add(hydrationKey(slug, bootstrapUserId));
                    break;
                case 'add-remote':
                    result = await gitService.addRemote(slug, data.name, data.url, effectiveUserId, data.token, tokenUserId);
                    break;
                case 'remove-remote':
                    result = await gitService.removeRemote(slug, data.name, effectiveUserId);
                    break;
                case 'set-remote-url':
                    result = await gitService.setRemoteUrl(slug, data.name, data.url, effectiveUserId, data.token, tokenUserId);
                    break;
                case 'remotes':
                    result = await gitService.getRemotes(slug, effectiveUserId);
                    break;
                case 'clone':
                  result = await gitService.cloneRepo(slug, data.repoUrl, data.token, bootstrapUserId, tokenUserId);
                  hydratedSlugs.add(hydrationKey(slug, bootstrapUserId));
                  // Save metadata locally
                  workspaceManager.addWorkspace(slug, data.repoUrl, data.owner, data.name);
                  let workspaceRegistration = {
                    attempted: false,
                    created: false,
                    pending: false,
                  };

                  // Try to create the workspace in the main Synthi app DB so the web UI finds it.
                  // Use environment var SYNTHI_APP_URL or default to http://localhost:3000
                  const SYNTHI_APP_URL = process.env.SYNTHI_APP_URL || 'http://localhost:3000';

                  // Determine fetch function - prefer global fetch (Node 18+), otherwise require node-fetch
                  let fetchFunc = null;
                  if (typeof fetch === 'function') {
                    fetchFunc = fetch;
                  } else {
                    try {
                      fetchFunc = require('node-fetch');
                    } catch (e) {
                      fetchFunc = null;
                    }
                  }

                  if (fetchFunc) {
                    workspaceRegistration.attempted = true;
                    const payload = {
                      name: data.name || slug,
                      slug: slug,
                      repoUrl: data.repoUrl || null
                    };

                    // Retry mechanism
                    const maxAttempts = 3;
                    let attempt = 0;
                    let created = false;
                    while (attempt < maxAttempts && !created) {
                      attempt += 1;
                      try {
                        const res = await fetchFunc(`${SYNTHI_APP_URL}/api/workspace`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                        });

                        if (res.status === 201 || res.status === 409) { // created or already exists are acceptable
                          created = true;
                          console.log(`[Collab] Notified Synthi app to create workspace '${slug}' (status ${res.status})`);
                          break;
                        } else {
                          const txt = await res.text().catch(() => '');
                          console.warn(`[Collab] Synthi app returned ${res.status} creating workspace '${slug}': ${txt}`);
                        }
                      } catch (err) {
                        console.warn(`[Collab] Attempt ${attempt} failed to call Synthi app for workspace creation:`, err?.message || err);
                      }

                      if (!created && attempt < maxAttempts) {
                        // simple exponential backoff
                        await new Promise(r => setTimeout(r, 1000 * attempt));
                      }
                    }

                    if (!created) {
                      const errMsg = `Failed to notify Synthi app to create workspace '${slug}' after ${maxAttempts} attempts.`;
                      console.warn('[Collab]', errMsg);
                      workspaceRegistration.pending = true;
                    }

                    workspaceRegistration.created = created;
                  } else {
                    console.warn('[Collab] Fetch not available - skipping workspace creation in main app. Set SYNTHI_APP_URL or install node-fetch.');
                    workspaceRegistration.pending = true;
                  }

                  result = {
                    ...result,
                    workspaceRegistration,
                  };
                  broadcastFileTreeChanged(slug, notifyScope);
                  break;
                case 'status':
                    result = await withTelemetry('git:status', () => gitService.getStatus(slug, effectiveUserId));
                    break;
                case 'branches':
                    result = await withTelemetry('git:branches', () => gitService.getBranches(slug, effectiveUserId));
                    break;
                case 'checkout':
                    pauseWatcher(slug);
                    try {
                      result = await gitService.checkout(slug, data.branch, data.create, effectiveUserId, data.mode, tokenUserId, tokenFallbackUserIds);
                      // Broadcast BEFORE invalidation so clients destroy stale
                      // Yjs docs before WS close triggers provider reconnect.
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'fetch':
                    result = await withTelemetry('git:fetch', () => gitService.fetch(slug, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds));
                    break;
                case 'commit':
                    result = await withTelemetry('git:commit', () => gitService.commit(slug, data.message, effectiveUserId, data.amend, commitIdentity));
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage':
                    // Acquire staging lock to suppress FS watcher events during staging
                    acquireStagingLock(slug, data.filePath);
                    // Force-flush Yjs content to disk before staging
                    await flushYjsDocForFile(slug, data.filePath, notifyScope);
                    result = await gitService.stageFile(slug, data.filePath, effectiveUserId);
                    releaseStagingLock(slug, data.filePath);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage-all':
                    result = await gitService.stageAll(slug, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage-lines':
                    // Acquire staging lock to suppress FS watcher events during staging
                    acquireStagingLock(slug, data.filePath);
                    // Force-flush Yjs content to disk before patching so the
                    // working tree matches the editor state exactly.
                    await flushYjsDocForFile(slug, data.filePath, notifyScope);
                    result = await gitService.stageLines(slug, data.filePath, data.patch, effectiveUserId);
                    releaseStagingLock(slug, data.filePath);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'unstage-lines':
                    acquireStagingLock(slug, data.filePath);
                    await flushYjsDocForFile(slug, data.filePath, notifyScope);
                    result = await gitService.unstageLines(slug, data.filePath, data.patch, effectiveUserId);
                    releaseStagingLock(slug, data.filePath);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'discard-lines':
                    acquireStagingLock(slug, data.filePath);
                    await flushYjsDocForFile(slug, data.filePath, notifyScope);
                    result = await gitService.discardLines(slug, data.filePath, data.patch, effectiveUserId);
                    releaseStagingLock(slug, data.filePath);
                    broadcastFileReverted(slug, data.filePath ? [data.filePath] : [], notifyScope);
                    if (data.filePath) {
                      await invalidateDocsForSlug(slug, [data.filePath], notifyScope);
                    }
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'unstage':
                    acquireStagingLock(slug, data.filePath);
                    result = await gitService.unstageFile(slug, data.filePath, effectiveUserId);
                    releaseStagingLock(slug, data.filePath);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'unstage-all':
                    result = await gitService.unstageAll(slug, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'push':
                    pauseWatcher(slug);
                    try {
                      result = await withTelemetry('git:push', () => gitService.push(slug, effectiveUserId, data.token, data.force, tokenUserId, tokenFallbackUserIds));
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'pull':
                    pauseWatcher(slug);
                    try {
                      result = await withTelemetry('git:pull', () => gitService.pull(slug, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds, commitIdentity));
                      // Broadcast BEFORE invalidation so clients destroy stale
                      // Yjs docs before WS close triggers provider reconnect.
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'discard':
                    result = await gitService.discardChange(slug, data.filePath, effectiveUserId);
                    // Broadcast BEFORE invalidation so clients destroy stale
                    // Yjs docs before WS close triggers provider reconnect.
                    broadcastFileReverted(slug, data.filePath ? [data.filePath] : [], notifyScope);
                    if (data.filePath) {
                      await invalidateDocsForSlug(slug, [data.filePath], notifyScope);
                    }
                    broadcastFileTreeChanged(slug, notifyScope);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'discard-all':
                    pauseWatcher(slug);
                    try {
                      result = await gitService.discardAll(slug, effectiveUserId);
                      // Broadcast BEFORE invalidation so clients destroy stale
                      // Yjs docs before WS close triggers provider reconnect.
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                // Merge conflict resolution
                case 'resolve-ours':
                    result = await gitService.resolveConflictOurs(slug, data.filePath, effectiveUserId);
                    if (data.filePath) {
                      broadcastFileReverted(slug, [data.filePath], notifyScope);
                      await invalidateDocsForSlug(slug, [data.filePath], notifyScope);
                    }
                    break;
                case 'resolve-theirs':
                    result = await gitService.resolveConflictTheirs(slug, data.filePath, effectiveUserId);
                    if (data.filePath) {
                      broadcastFileReverted(slug, [data.filePath], notifyScope);
                      await invalidateDocsForSlug(slug, [data.filePath], notifyScope);
                    }
                    break;
                case 'mark-resolved':
                    result = await gitService.markResolved(slug, data.filePath, effectiveUserId);
                    break;
                case 'abort-merge':
                    result = await gitService.abortMerge(slug, effectiveUserId);
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'merge-branch':
                    pauseWatcher(slug);
                    try {
                      result = await gitService.mergeBranch(slug, data.branch, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds, commitIdentity);
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'check-merge-conflicts':
                    // In-memory merge conflict detection using git merge-tree.
                    // No working tree changes — runs in milliseconds.
                    result = await gitService.checkMergeConflicts(
                        slug, data.baseBranch, data.headBranch, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds
                    );
                    break;
                case 'conflict-versions':
                    result = await gitService.getConflictVersions(slug, data.filePath, effectiveUserId);
                    break;
                case 'diff':
                    result = await withTelemetry('git:diff', () => gitService.getDiff(slug, data.filePath, { parsed: data.parsed, userId: effectiveUserId }));
                    break;
                case 'file-content':
                    const fileContent = await withTelemetry('git:file-content', () => gitService.getFileContent(slug, data.filePath, data.ref, effectiveUserId));
                    result = { content: fileContent };
                    break;
                case 'log':
                    result = await withTelemetry('git:log', () => gitService.getLog(slug, { page: data.page, limit: data.limit, userId: effectiveUserId }));
                    break;
                case 'unpushed':
                    const max = data && data.max ? parseInt(data.max, 10) : 50;
                    result = await gitService.getUnpushedCommits(slug, max, effectiveUserId);
                    break;
                case 'incoming':
                    const incomingMax = data && data.max ? parseInt(data.max, 10) : 50;
                    result = await gitService.getIncomingCommits(slug, incomingMax, effectiveUserId);
                    break;
                case 'blame':
                    result = await gitService.getBlame(slug, data.filePath, effectiveUserId);
                    break;
                // Stash operations
                case 'stash-list':
                    result = await gitService.stashList(slug, effectiveUserId);
                    break;
                case 'stash-push':
                    result = await gitService.stashPush(slug, data.message, effectiveUserId, commitIdentity);
                    break;
                case 'stash-pop':
                    pauseWatcher(slug);
                    try {
                      result = await gitService.stashPop(slug, data.index, effectiveUserId, commitIdentity);
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'stash-apply':
                    pauseWatcher(slug);
                    try {
                      result = await gitService.stashApply(slug, data.index, effectiveUserId);
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'stash-drop':
                    result = await gitService.stashDrop(slug, data.index, effectiveUserId);
                    break;
                case 'interactive-rebase':
                    pauseWatcher(slug);
                    try {
                      result = await gitService.interactiveRebase(slug, data.baseCommit, data.operations, effectiveUserId, commitIdentity);
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'rebase-abort':
                    pauseWatcher(slug);
                    try {
                      result = await gitService.rebaseAbort(slug, effectiveUserId);
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'rebase-continue':
                    pauseWatcher(slug);
                    try {
                      result = await gitService.rebaseContinue(slug, effectiveUserId, commitIdentity);
                      broadcastFileReverted(slug, [], notifyScope);
                      await invalidateDocsForSlug(slug, null, notifyScope);
                      broadcastFileTreeChanged(slug, notifyScope);
                      broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    } finally {
                      resumeWatcher(slug);
                    }
                    break;
                case 'cherry-pick':
                    result = await gitService.cherryPick(slug, data.hash, effectiveUserId, commitIdentity);
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'tags':
                    result = await gitService.getTags(slug, effectiveUserId);
                    break;
                case 'create-tag':
                    result = await gitService.createTag(slug, data.name, data.ref || 'HEAD', data.message, effectiveUserId);
                    break;
                case 'delete-tag':
                    result = await gitService.deleteTag(slug, data.name, effectiveUserId);
                    break;
                case 'push-tag':
                    result = await gitService.pushTag(slug, data.name, effectiveUserId, data.token, tokenUserId, tokenFallbackUserIds);
                    break;
                case 'revert':
                    result = await gitService.revertCommit(slug, data.hash, effectiveUserId, commitIdentity);
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'commit-detail':
                    result = await gitService.getCommitDetail(slug, data.hash, effectiveUserId);
                    break;
                case 'sync':
                    // Sync a single file — explicit save action from the client.
                    // Guard: reject stale save requests that were in-flight during
                    // a revert/pull/checkout. The revert cooldown prevents overwriting
                    // freshly reverted disk content with pre-revert editor content.
                    {
                      const cooldownKey = `${slug}:${data.filePath}`;
                      const cooldownTs = revertCooldowns.get(cooldownKey);
                      if (cooldownTs && (Date.now() - cooldownTs) < REVERT_COOLDOWN_MS) {
                        console.log(`[Collab Sync] Rejected stale save for ${data.filePath} — revert cooldown active (${Date.now() - cooldownTs}ms since invalidation)`);
                        result = { success: false, reason: 'revert-cooldown' };
                        break;
                      }
                      // Clean up expired cooldown
                      if (cooldownTs) revertCooldowns.delete(cooldownKey);

                      // Flush CRDT content to disk + GCS in a single pass.  An
                      // earlier version called gitService.syncFile() first,
                      // which wrote the new content to disk before
                      // flushDocToDisk's baseline-snapshot read — that read
                      // then saw the just-written content as the "prior" and
                      // skipped seeding the pre-edit baseline on the first
                      // save.  flushDocToDisk already performs the disk write,
                      // so calling syncFile() here was redundant AND prevented
                      // the very first version from being restorable.
                      const docKey = buildDocName(slug, data.filePath, notifyScope);
                      await flushDocToDisk(docKey, { contentOverride: data.content });
                    }
                    result = { success: true };
                    break;
                case 'files':
                    result = await gitService.listFiles(slug, effectiveUserId);
                    break;
                case 'files-meta':
                  // Metadata only (no content)
                  result = { files: await gitService.listFilesMeta(slug, effectiveUserId) };
                  // Kick off index build in background (non-blocking)
                  try {
                    fileIndex.ensureIndex(slug, gitService.getEffectiveRepoPath(slug, effectiveUserId)).catch(() => {});
                  } catch (_) {}
                  break;
                case 'index-ensure':
                  // Non-blocking ensure; returns immediately with current status
                  try {
                    fileIndex.ensureIndex(slug, gitService.getEffectiveRepoPath(slug, effectiveUserId)).catch(() => {});
                  } catch (_) {}
                  result = fileIndex.getStatus(slug);
                  break;
                case 'index-status':
                  result = fileIndex.getStatus(slug);
                  break;
                case 'search':
                  // Index-first search; never reads disk on request
                  result = await withTelemetry.async('fs:search', async () => {
                    // fileIndex.search is still synchronous, but we can offload it to a worker or setImmediate 
                    // to prevent blocking this specific event loop turn for too long if needed.
                    // For now, wrapping in withTelemetry.async to prepare for future worker offloading.
                    return fileIndex.search(slug, data.q || data.query || '');
                  });
                  break;
                case 'open-lookup':
                  result = fileIndex.fileLookup(slug, data.q || data.query || '');
                  break;
                case 'imports':
                  result = fileIndex.getImports(slug, data.filePath || data.path || '');
                  break;
                case 'file':
                    // Normalize path - convert backslashes and strip leading slashes
                    const filePath_file = (data.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
                    const content = await withTelemetry('fs:read', () => gitService.readFile(slug, filePath_file, effectiveUserId));
                    result = { content };
                    break;
                case 'file-hash':
                    // Get content hash for a file (for VFS validation)
                    try {
                        const hashFilePath = (data.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
                        const hashContent = await gitService.readFile(slug, hashFilePath, effectiveUserId);
                        const hashValue = computeHash(hashContent);
                        result = { hash: hashValue, path: data.path };
                    } catch (e) {
                        result = { hash: null, path: data.path, error: e.message };
                    }
                    break;
                case 'write-file':
                    await withTelemetry('fs:write', () => gitService.writeFile(slug, data.path, data.content, effectiveUserId));
                    result = { success: true };
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'write-files-batch':
                  // Batch write many files (supports base64 for binary).
                  // Payload shape: { files: [{ path, encoding: 'utf8'|'base64', content }] }
                  result = await gitService.writeFilesBatch(slug, data.files, {
                    syncToGcs: data.syncToGcs !== false,
                    userId: effectiveUserId,
                  });
                  break;
                case 'create-directory':
                    await gitService.createDirectory(slug, data.path, effectiveUserId);
                    result = { success: true };
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'delete-item':
                    // Delete a file or folder from the workspace
                    console.log('[Collab] delete-item called for:', slug, data.path);
                    result = await gitService.deleteItem(slug, data.path, effectiveUserId);
                    console.log('[Collab] delete-item result:', result);
                    if (data.path) {
                      await invalidateDocsForSlug(slug, [data.path], notifyScope);
                    }
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'rename-item':
                    // Rename / move a file or directory
                    result = await gitService.renameItem(slug, data.oldPath, data.newPath, effectiveUserId);
                    // Invalidate old path's Yjs doc (the file no longer exists at old path)
                    if (data.oldPath) {
                      await invalidateDocsForSlug(slug, [data.oldPath], notifyScope);
                    }
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'clear-collab':
                    // Clear Yjs persistence for specified files (used after merge conflict resolution)
                    const filesToClear = Array.isArray(data.files) ? data.files : (data.path ? [data.path] : []);
                    for (const filePath of filesToClear) {
                      const docName = buildDocName(slug, filePath, notifyScope);
                        await clearDocumentPersistence(docName);
                    }
                    result = { success: true, cleared: filesToClear.length };
                    break;
                case 'github-info': {
                    // Extract owner/repo from the git remote URL for this workspace.
                    // Used by the PR panel to know which GitHub repo to query.
                    try {
                        const git = await gitService.getGit(slug, effectiveUserId);
                        const remotes = await git.getRemotes(true);
                        const origin = remotes.find(r => r.name === 'origin') || remotes[0];
                        if (!origin || !origin.refs?.fetch) {
                            result = { error: 'no_remote', message: 'No remote configured for this workspace.' };
                            break;
                        }
                        const remoteUrl = origin.refs.fetch;

                        // Parse various remote URL formats:
                        //   https://github.com/owner/repo.git
                        //   git@github.com:owner/repo.git
                        //   https://token@github.com/owner/repo.git
                        let owner = null;
                        let repo = null;
                        let provider = 'unknown';
                        let htmlUrl = null;

                        const cleanUrl = remoteUrl.replace(/^https?:\/\/[^@]+@/, 'https://'); // strip embedded credentials

                        const httpsMatch = cleanUrl.match(/https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/i);
                        const sshMatch = cleanUrl.match(/git@(github\.com|gitlab\.com|bitbucket\.org):([^/]+)\/([^/]+?)(?:\.git)?$/i);

                        if (httpsMatch) {
                            const host = httpsMatch[1].toLowerCase();
                            owner = httpsMatch[2];
                            repo = httpsMatch[3];
                            provider = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : 'bitbucket';
                            htmlUrl = `https://${host}/${owner}/${repo}`;
                        } else if (sshMatch) {
                            const host = sshMatch[1].toLowerCase();
                            owner = sshMatch[2];
                            repo = sshMatch[3];
                            provider = host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : 'bitbucket';
                            htmlUrl = `https://${host}/${owner}/${repo}`;
                        }

                        result = { owner, repo, provider, remoteUrl: cleanUrl, htmlUrl };
                    } catch (e) {
                        result = { error: 'parse_failed', message: e.message };
                    }
                    break;
                }
                default:
                    res.writeHead(404);
                    res.end('Unknown action');
                    return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            // Handle structured GitError responses
            if (e.code && e.toJSON) {
                const statusCode = e.code === 'REPO_NOT_FOUND' || e.code === 'REPO_NOT_INITIALIZED' ? 404 : 
                                   e.code === 'AUTH_FAILED' || e.code === 'NO_REMOTE' ? 400 :
                                   e.code === 'MERGE_CONFLICT' ? 409 :
                                   e.code === 'UNCOMMITTED_CHANGES' ? 422 : 400;
                console.debug('[Collab] Git error:', e.code, e.message);
                res.writeHead(statusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(e.toJSON()));
                return;
            }
            
            // Legacy error handling for unstructured errors
            const msg = e?.message || '';
            if (msg.includes('not initialized') || msg.includes('not found') || msg.includes('no remote configured') || msg.includes('no configured push destination') || msg.includes('authentication failed') || msg.includes('user cancelled') || msg.includes('user cancelled dialog') || msg.includes('repository not found') || msg.includes('remote: repository not found')) {
                console.debug('[Collab] Client error in /git/:', msg);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: msg }));
            } else {
                console.error(e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: msg }));
            }
        }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Synthi collaboration server is running');
});

// PERF: Enable permessage-deflate compression.  Yjs binary sync messages
// and JSON notification payloads are highly compressible (~30% smaller).
const wsPerMessageDeflate = {
  zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 }, // level 3 = fast
  zlibInflateOptions: { chunkSize: 10 * 1024 },
  clientNoContextTakeover: true,   // don't keep deflate state between messages
  serverNoContextTakeover: true,
  serverMaxWindowBits: 10,
  concurrencyLimit: 10,
  threshold: 128,                  // only compress messages > 128 bytes
};

// ── Yjs document WebSocket relay ─────────────────────────────────────────────
// Minimal Yjs sync protocol handler — Y-Sweet 0.9.x serve doesn't expose
// WebSocket, so we host the document relay here on the collab server.
const yjsWss = new WebSocket.Server({ noServer: true });
const yjsWsServer = require('./yjsWsServer');

// Lightweight notification WebSocket server for non-Yjs broadcasts
// (e.g., file-tree-changed). Clients connect to /notifications?slug=<slug>.
const notifyWss = new WebSocket.Server({ noServer: true, perMessageDeflate: wsPerMessageDeflate });

// Session notification WebSocket server for collaboration events.
// Clients connect to /session-events?sessionId=<id>&userId=<id>.
const sessionWss = new WebSocket.Server({ noServer: true, perMessageDeflate: wsPerMessageDeflate });

// Terminal PTY WebSocket server — spawns shell sessions via node-pty.
// Clients connect to /terminal?sessionId=<id>&workspace=<slug>&cols=N&rows=N.
const terminalWss = createTerminalWSS();

// Grace period for guest disconnect → reconnect (prevents phantom kicks)
const GUEST_DISCONNECT_GRACE_MS = 30_000;
/** @type {Map<string, NodeJS.Timeout>} userId → timeout handle */
const guestDisconnectTimers = new Map();

/**
 * Broadcast a session-level event to all participants (host + guests).
 * @param {string} sessionId
 * @param {string} eventType
 * @param {object} payload
 */
function broadcastSessionEvent(sessionId, eventType, payload) {
  const message = JSON.stringify({ type: eventType, sessionId, ...payload });
  sessionWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._sessionId === sessionId) {
      try { ws.send(message); } catch (_) {}
    }
  });
}

/**
 * Send a session-level event ONLY to the session host.
 * Used for events that should never reach guests (e.g. knock requests).
 * Falls back to broadcastSessionEvent if host socket cannot be identified.
 *
 * @param {string} sessionId
 * @param {string} eventType
 * @param {object} payload
 */
function sendToSessionHost(sessionId, eventType, payload) {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    console.warn(`[Session] sendToSessionHost: session ${sessionId} not found`);
    return;
  }
  const hostUserId = session.hostId;
  if (!hostUserId) {
    console.warn(`[Session] sendToSessionHost: no hostId for session ${sessionId}`);
    return;
  }
  const message = JSON.stringify({ type: eventType, sessionId, ...payload });
  let sent = false;
  sessionWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._sessionId === sessionId && ws._userId === hostUserId) {
      try { ws.send(message); sent = true; } catch (_) {}
    }
  });
  if (!sent) {
    console.warn(`[Session] sendToSessionHost: host WS not found for session ${sessionId} (host=${hostUserId}). Attempting notification WS fallback.`);
    // Fallback: try the notification WS channel so the host still gets alerted.
    // Preserve the original event type so that permission:requested, knock:cancelled,
    // etc. are delivered with the correct type — not rewritten to session-knock.
    // Only actual knock events use 'session-knock' as their fallback type.
    if (notifyWss) {
      const fallbackType = eventType === 'knock' ? 'session-knock' : eventType;
      const fallbackMsg = JSON.stringify({ type: fallbackType, sessionId, ...payload });
      notifyWss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN && ws._userId === hostUserId) {
          try { ws.send(fallbackMsg); sent = true; } catch (_) {}
        }
      });
    }
    if (sent) {
      console.log(`[Session] sendToSessionHost: delivered via notification WS fallback`);
    } else {
      console.error(`[Session] sendToSessionHost: FAILED to deliver knock to host ${hostUserId} via any channel`);
    }
  } else {
    console.log(`[Session] sendToSessionHost: delivered '${eventType}' to host ${hostUserId}`);
  }
}

/**
 * Send a session-level event to a SPECIFIC user in the session.
 * Used for targeted events like knock:denied (only the denied guest needs it).
 *
 * @param {string} sessionId
 * @param {string} targetUserId
 * @param {string} eventType
 * @param {object} payload
 */
function sendToSessionUser(sessionId, targetUserId, eventType, payload) {
  const message = JSON.stringify({ type: eventType, sessionId, ...payload });
  sessionWss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN && ws._sessionId === sessionId && ws._userId === targetUserId) {
      try { ws.send(message); } catch (_) {}
    }
  });
}



server.on('upgrade', (request, socket, head) => {
  // Use replace to safely strip the prefix
  request.url = request.url.replace(/^\/collab/, '');
  if (!request.url.startsWith('/')) request.url = '/' + request.url;
  const pathname = request.url ? request.url.slice(1).split('?')[0] : 'unknown';
  console.log(`[Collab DEBUG] Upgrade request for room: ${pathname}`);

  if (pathname === 'notifications') {
    // Route to lightweight notification WebSocket server
    notifyWss.handleUpgrade(request, socket, head, (ws) => {
      notifyWss.emit('connection', ws, request);
    });
  } else if (pathname === 'session-events') {
    // Route to session event WebSocket server
    sessionWss.handleUpgrade(request, socket, head, (ws) => {
      sessionWss.emit('connection', ws, request);
    });
  } else if (pathname === 'terminal') {
    // Route to terminal PTY WebSocket server
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      terminalWss.emit('connection', ws, request);
    });
  } else if (pathname.startsWith('yjs/')) {
    // Route to Yjs document sync WebSocket (y-websocket protocol)
    // Room name = everything after 'yjs/'
    yjsWss.handleUpgrade(request, socket, head, async (ws) => {
      const docName = decodeURIComponent(pathname.slice(4));
      let initialContent = null;
      let slug = null, userId = null;

      try {
        // Parse docName: workspace:${slug}:user:${userId}:${path}
        const parts = docName.split(':');
        if (parts.length >= 5 && parts[0] === 'workspace' && parts[2] === 'user') {
           slug = parts[1];
           userId = decodeURIComponent(parts[3]);
           // Path starts at index 4, rejoin rest
           const rawFilePath = parts.slice(4).join(':');

           // Reject traversal / absolute paths / null bytes up-front.
           // validateFilePath throws on anything dangerous.
           const safeRelative = validateFilePath(rawFilePath);

           // Acquire repo to ensure file exists on disk
           const repoPath = await repoCache.acquire(slug, userId);
           try {
             const fullPath = path.join(repoPath, safeRelative);
             // fs.realpath resolves symlinks; we then verify the resolved path
             // is strictly inside the repo root.  Uses realpath on the repo
             // too so that mount-point symlinks are handled consistently.
             let realFull, realRepo;
             try {
               [realFull, realRepo] = await Promise.all([
                 fsPromises.realpath(fullPath),
                 fsPromises.realpath(repoPath),
               ]);
             } catch (_) {
               // File doesn't exist yet — that's fine; nothing to seed.
               realFull = null;
             }
             if (realFull && realRepo) {
               const rel = path.relative(realRepo, realFull);
               const isInside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
               if (isInside) {
                 const stat = await fsPromises.stat(realFull);
                 if (stat.isFile()) {
                   initialContent = await fsPromises.readFile(realFull, 'utf8');
                 }
               } else {
                 console.warn('[Collab] Rejecting Yjs seed: resolved path escapes repo', { slug, userId, rawFilePath });
               }
             }
           } finally {
             repoCache.release(slug, userId);
           }
        }
      } catch (e) {
        console.warn('[Collab] Failed to seed Yjs doc from disk', docName, e.message);
      }

      yjsWsServer.setupConnection(ws, docName, initialContent);
    });
  } else {
    // Unknown upgrade path — Y-Sweet handles CRDT WebSockets directly.
    console.warn(`[Collab] Rejected unknown WS upgrade: /${pathname}`);
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

// ── Presence + offline delivery helpers ─────────────────────────────
// Online = has at least one open notify-WS OR session-WS.  We prefer the
// notify-WS because it's the long-lived channel every user keeps open on
// the workspace page, but we also look at sessionWss so a user inside an
// active collab session is considered online even if their notify-WS
// hasn't reconnected yet.
function isUserOnline(userId) {
  if (!userId) return false;
  const id = String(userId);
  if (notifyWss) {
    for (const ws of notifyWss.clients) {
      if (ws.readyState === WebSocket.OPEN && ws._userId === id) return true;
    }
  }
  if (sessionWss) {
    for (const ws of sessionWss.clients) {
      if (ws.readyState === WebSocket.OPEN && ws._userId === id) return true;
    }
  }
  return false;
}

/**
 * Deliver an event to a user.  If they're online we send immediately via
 * every open notify-WS for that user; otherwise we queue in Redis so their
 * next connect picks it up.  When a slug is supplied only matching
 * notify-WS connections receive the live delivery — the Redis fallback
 * has no slug filter since inbox drains target the userId only.
 *
 * @param {string} userId
 * @param {string} type  event type (e.g. 'collab-invite', 'knock:denied')
 * @param {object} payload
 * @param {{ slug?: string, forceQueue?: boolean }} [opts]
 * @returns {Promise<{ delivered: boolean, queued: boolean }>}
 */
async function deliverToUser(userId, type, payload, opts = {}) {
  if (!userId || !type) return { delivered: false, queued: false };
  const msg = JSON.stringify({ type, ...payload });
  let delivered = false;
  if (!opts.forceQueue && notifyWss) {
    notifyWss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws._userId !== userId) return;
      if (opts.slug && ws._slug && ws._slug !== opts.slug) return;
      try { ws.send(msg); delivered = true; } catch (_) {}
    });
  }
  if (delivered) return { delivered: true, queued: false };
  // Not online (or no matching slug connection) — queue for next connect.
  await persistence.enqueueUserEvent(userId, { type, payload });
  return { delivered: false, queued: true };
}

/**
 * On WS connect, drain any events that were queued while the user was
 * offline and send them immediately.  Each event carries `queued: true`
 * and `queuedAt` so the client can render it as a popup "missed while
 * offline" notification.  Safe to call even when persistence is off —
 * drainUserInbox returns [] in that case.
 */
async function flushUserInboxToSocket(ws, userId) {
  if (!userId) return;
  const events = await persistence.drainUserInbox(userId);
  if (!events.length) return;
  for (const e of events) {
    if (ws.readyState !== WebSocket.OPEN) break;
    try {
      ws.send(JSON.stringify({
        type: e.type,
        ...(e.payload || {}),
        queued: true,
        queuedAt: e.queuedAt,
      }));
    } catch (_) { /* socket went away mid-flush */ }
  }
  logger.info('inbox_drained', { userId, count: events.length });
}

// ── Notification WS connection handler ──────────────────────────────
notifyWss.on('connection', (ws, req) => {
  const params = new URLSearchParams((req.url || '').split('?')[1] || '');
  ws._slug = params.get('slug') || null;
  ws._userId = params.get('userId') ? decodeURIComponent(params.get('userId')) : null;
  ws._sessionId = params.get('sessionId') || null;
  logger.info('notify_ws_connected', { slug: ws._slug, userId: ws._userId });
  // Flush any offline events for this user as a burst of queued:true
  // messages so the UI can surface them as popups.
  if (ws._userId) {
    flushUserInboxToSocket(ws, ws._userId).catch((err) =>
      logger.warn('inbox_flush_failed', { userId: ws._userId }, err));
  }
  ws.on('close', () => {
    logger.info('notify_ws_disconnected', { slug: ws._slug, userId: ws._userId });
  });
});

// ── Session-events WS connection handler ────────────────────────────
sessionWss.on('connection', (ws, req) => {
  const params = new URLSearchParams((req.url || '').split('?')[1] || '');
  ws._sessionId = params.get('sessionId') || null;
  ws._userId = params.get('userId') ? decodeURIComponent(params.get('userId')) : null;
  logger.info('session_ws_connected', { sessionId: ws._sessionId, userId: ws._userId });
  ws.on('close', () => {
    logger.info('session_ws_disconnected', { sessionId: ws._sessionId, userId: ws._userId });
  });
});

// ── Wire SessionManager events to WebSocket delivery ─────────────────────
// SessionManager is an EventEmitter; these listeners bridge in-process events
// to the connected WebSocket clients (host + guests).

sessionManager.on('session:knock', ({ sessionId, hostId, guestId, displayName, avatarUrl }) => {
  sendToSessionHost(sessionId, 'knock', { guestId, displayName, avatarUrl, hostId });
});

sessionManager.on('session:guestJoined', ({ sessionId, hostId, guest, autoAdmitted }) => {
  const session = sessionManager.getSession(sessionId);
  broadcastSessionEvent(sessionId, 'guest:joined', {
    guest,
    hostId,
    slug: session?.slug,
    autoAdmitted: autoAdmitted || false,
  });
});

sessionManager.on('session:knockDenied', ({ sessionId, guestId }) => {
  sendToSessionUser(sessionId, guestId, 'knock:denied', { guestId });
});

sessionManager.on('session:permissionsUpdated', ({ sessionId, guestId, permissions }) => {
  broadcastSessionEvent(sessionId, 'permissions:updated', { guestId, permissions });
});

sessionManager.on('session:guestRemoved', ({ sessionId, guestId, reason }) => {
  broadcastSessionEvent(sessionId, 'guest:removed', { guestId, reason });
});

sessionManager.on('session:terminated', ({ sessionId }) => {
  broadcastSessionEvent(sessionId, 'session:terminated', {});
});

sessionManager.on('session:knockCancelled', ({ sessionId, guestId }) => {
  sendToSessionHost(sessionId, 'knock:cancelled', { guestId });
});

// ── Persistence bridge ──────────────────────────────────────────────────
// SessionManager emits persist:session / persist:delete for every mutation.
// The bridge forwards to the persistence adapter which is a no-op unless
// REDIS_URL is configured + the redis module is installed.
sessionManager.on('persist:session', (session) => {
  persistence.saveSession(session);
});
sessionManager.on('persist:delete', (sessionId) => {
  persistence.deleteSession(sessionId);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
// Drain WebSockets, stop accepting new connections, flush persistence,
// then let the process exit.  The deadline enforces bounded shutdown time
// so orchestrators don't have to SIGKILL us.
let shuttingDown = false;
const SHUTDOWN_DEADLINE_MS = Number(process.env.COLLAB_SHUTDOWN_DEADLINE_MS) || 15_000;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  // Force-exit watchdog in case a socket refuses to close.
  const watchdog = setTimeout(() => {
    logger.error('shutdown_timeout', { deadlineMs: SHUTDOWN_DEADLINE_MS });
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  if (typeof watchdog.unref === 'function') watchdog.unref();

  // 1. Stop accepting new HTTP/WS connections.
  try { server.close(); } catch (err) { logger.warn('server_close_failed', {}, err); }

  // 2. Tell every connected WebSocket to go away cleanly.  1001 "going
  //    away" is the canonical close code for graceful server shutdown.
  const wsServers = [
    { name: 'notify', s: notifyWss },
    { name: 'session', s: sessionWss },
    { name: 'terminal', s: terminalWss },
    { name: 'yjs', s: yjsWss },
  ];
  for (const { name, s } of wsServers) {
    if (!s || !s.clients) continue;
    const count = s.clients.size;
    logger.info('ws_drain', { channel: name, clients: count });
    s.clients.forEach((ws) => {
      try { ws.close(1001, 'server_shutting_down'); } catch (_) {}
    });
  }

  // 3. Give in-flight work a brief moment to finish (Y-Sweet writes,
  //    file I/O, pending persistence calls).
  await new Promise((r) => setTimeout(r, 1500));

  // 4. Close persistence.  Best-effort — if Redis is down we still exit.
  try { await persistence.close(); }
  catch (err) { logger.warn('persistence_close_failed', {}, err); }

  logger.info('shutdown_complete', { signal });
  clearTimeout(watchdog);
  // Small delay to let last log flush.
  setTimeout(() => process.exit(0), 50).unref?.();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Surface (but don't crash on) unhandled rejections — they're easy to
// miss in production logs and usually indicate a .catch() we forgot.
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled_rejection', { reason: reason?.message || String(reason) },
    reason instanceof Error ? reason : null);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', {}, err);
});

// ── Boot sequence ───────────────────────────────────────────────────────
(async () => {
  // Try to attach persistence up-front.  If REDIS_URL isn't set this is
  // a fast no-op and we continue with pure in-memory behaviour.
  try {
    await persistence.connect();
    if (persistence.isAvailable()) {
      const sessions = await persistence.loadSessions();
      const restored = sessionManager.restoreFromSnapshot(sessions);
      logger.info('sessions_restored', { count: restored });

      const blocks = await persistence.loadBlocks();
      let blockCount = 0;
      for (const { userId, blocked } of blocks) {
        if (!blockedBy.has(userId)) blockedBy.set(userId, new Set());
        for (const b of blocked) { blockedBy.get(userId).add(b); blockCount++; }
      }
      logger.info('blocks_restored', { owners: blocks.length, entries: blockCount });
    }
  } catch (err) {
    logger.error('persistence_bootstrap_failed', {}, err);
  }

  server.listen(PORT, '0.0.0.0', () => {
    logger.info('server_listening', {
      port: PORT,
      ySweetUrl: config.YSWEET_URL,
      persistence: persistence.isAvailable() ? 'redis' : 'memory',
    });

    // Start the idle-workspace culler (only inside K8s).
    if (process.env.KUBERNETES_SERVICE_HOST) {
      spawner.startCuller();
    }
  });
})();

