const http = require('http');
const WebSocket = require('ws');
// y-websocket exports have changed across versions and some environments do
// not allow accessing internal subpaths via package exports. Try a few
// common locations and fall back with a clear error message.
require('dotenv').config();
let setupWSConnection = null;
try {
  // Try the package export path without extension first (preferred)
  setupWSConnection = require('y-websocket/bin/utils').setupWSConnection;
  if (typeof setupWSConnection === 'function') {
    console.log('[Collab] loaded setupWSConnection from y-websocket/bin/utils');
  } else {
    throw new Error('setupWSConnection not exported at y-websocket/bin/utils');
  }
} catch (errA) {
  try {
    // Some installs put utils under bin/utils.js (legacy)
    setupWSConnection = require('y-websocket/bin/utils.js').setupWSConnection;
    if (typeof setupWSConnection === 'function') {
      console.log('[Collab] loaded setupWSConnection from y-websocket/bin/utils.js');
    } else {
      throw new Error('setupWSConnection not found at y-websocket/bin/utils.js');
    }
  } catch (errB) {
    try {
      // Common fallback for older builds
      setupWSConnection = require('y-websocket/dist/bin/utils.cjs').setupWSConnection;
      if (typeof setupWSConnection === 'function') {
        console.log('[Collab] loaded setupWSConnection from y-websocket/dist/bin/utils.cjs');
      } else {
        throw new Error('setupWSConnection not found at y-websocket/dist/bin/utils.cjs');
      }
    } catch (errC) {
      try {
        // As a last resort try the root package export (may not include server utils)
        const root = require('y-websocket');
        if (root && typeof root.setupWSConnection === 'function') {
          setupWSConnection = root.setupWSConnection;
          console.log('[Collab] loaded setupWSConnection from y-websocket (root export)');
        } else {
          throw new Error('setupWSConnection unavailable on y-websocket root export');
        }
      } catch (errD) {
        console.error('[Collab] Unable to load setupWSConnection from y-websocket.');
        console.error('Tried multiple locations and failed - ensure you have y-websocket installed and that it provides server utils.');
        console.error('Errors (most recent first):', errD?.message || errD, errC?.message || errC, errB?.message || errB, errA?.message || errA);
        process.exit(1);
      }
    }
  }
}
const Y = require('yjs');
const fileIndex = require('./fileIndex');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const crypto = require('crypto');
const gcsSync = require('./gcsSync');
const config = require('./config');
const gitService = require('./gitService');
const repoCache = require('./repoCache');
const sessionManager = require('./SessionManager');
const { extractSessionContext, requireGitActionPermission, wsRequirePermission, wsDenyAction, wsAttachContext } = require('./permissionMiddleware');

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

// LevelDB persistence is optional — some environments (or registries) may not
// provide a compatible `y-leveldb` binary. Try to load it and fall back to
// an in-memory persistence implementation if it's not available.
let LeveldbPersistence = null;
try {
  LeveldbPersistence = require('y-leveldb').LeveldbPersistence;
  console.log('[Collab] y-leveldb persistence available');
} catch (e) {
  console.warn('[Collab] y-leveldb not available, using in-memory persistence fallback');
}

const PORT = config.PORT;

// Track file hashes to detect when actual files change outside of the editor
const fileHashCache = new Map(); // docName -> { hash, timestamp }

// Revert cooldown: after invalidateDocsForSlug, reject stale sync (save)
// requests for a short window.  Key = "slug:filePath", value = timestamp.
const revertCooldowns = new Map();
const REVERT_COOLDOWN_MS = 3000; // 3 seconds

// Periodically garbage-collect expired cooldowns so the map doesn't grow
// unboundedly on long-running servers.
setInterval(() => {
  if (revertCooldowns.size === 0) return;
  const now = Date.now();
  for (const [key, ts] of revertCooldowns) {
    if (now - ts > REVERT_COOLDOWN_MS * 2) revertCooldowns.delete(key);
  }
}, 30_000); // every 30 seconds

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
    await persistence.clearDocument(legacyDoc);
  } catch (_) {}

  try {
    fileHashCache.delete(legacyDoc);
  } catch (_) {}

  try {
    if (yWsDocs && yWsDocs.has(legacyDoc)) {
      const wsDoc = yWsDocs.get(legacyDoc);
      if (wsDoc?.conns?.size > 0) {
        for (const conn of Array.from(wsDoc.conns.keys())) {
          try { conn.close(4001, 'legacy-room-purged'); } catch (_) {}
        }
      }
      try { wsDoc.destroy(); } catch (_) {}
      yWsDocs.delete(legacyDoc);
    }
    activeDocuments.delete(legacyDoc);
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
    // If the connecting user is a guest in a session whose host owns this
    // room, AND the guest has canEdit permission, allow access.
    if (sessionId) {
      const session = sessionManager.getSession(sessionId);
      if (session && session.hostId === parsedDoc.userId && session.slug === parsedDoc.slug) {
        if (sessionManager.checkPermission(sessionId, userId, 'canEdit')) {
          return { ok: true };
        }
        return { ok: false, status: 403, reason: 'edit_permission_required' };
      }
    }
    // Also check if the user is a guest anywhere whose host matches the room
    const hostInfo = sessionManager.getHostForGuest(userId);
    if (hostInfo && hostInfo.hostId === parsedDoc.userId && hostInfo.slug === parsedDoc.slug) {
      const guestSessionId = hostInfo.sessionId;
      if (sessionManager.checkPermission(guestSessionId, userId, 'canEdit')) {
        return { ok: true };
      }
      return { ok: false, status: 403, reason: 'edit_permission_required' };
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

// Use LevelDB persistence when available, otherwise use an in-memory fallback
let basePersistence;
if (LeveldbPersistence) {
  basePersistence = new LeveldbPersistence(config.LEVELDB_DIR);
} else {
  // Simple in-memory persistence that encodes/decodes Yjs state updates
  class InMemoryPersistence {
    constructor() {
      this.store = new Map();
    }

    async bindState(docName, ydoc) {
      const update = this.store.get(docName);
      if (update) {
        try {
          Y.applyUpdate(ydoc, update);
        } catch (e) {
          console.warn('[Collab] failed to apply stored update for', docName, e?.message || e);
        }
      }
    }

    async writeState(docName, ydoc) {
      try {
        const update = Y.encodeStateAsUpdate(ydoc);
        this.store.set(docName, update);
      } catch (e) {
        console.warn('[Collab] failed to encode state for', docName, e?.message || e);
      }
    }
    
    async clearDocument(docName) {
      this.store.delete(docName);
    }
  }

  basePersistence = new InMemoryPersistence();
}

/**
 * Wrapper persistence that validates cached state against actual file content,
 * AND automatically flushes Y.js changes to disk for Container-First architecture.
 * This ensures the compiler/AI always sees the latest content.
 */
class ValidatingPersistence {
  constructor(innerPersistence) {
    this.inner = innerPersistence;
    // Track Y.js document observers for auto-flush
    this.docObservers = new Map(); // docName -> { ydoc, observer, flushTimer }
    // Debounce interval for disk writes (ms)
    this.FLUSH_DEBOUNCE_MS = config.FLUSH_DEBOUNCE_MS;
  }

  /**
   * Set up auto-flush observer for a Y.js document.
   *
   * EDITOR-ONLY MODE: The observer no longer writes to disk or GCS
   * automatically on every keystroke.  Instead it only keeps the
   * in-memory hash cache up to date and marks the document as dirty.
   * Actual disk/GCS writes happen on explicit save (via the 'sync'
   * action which calls gitService.syncFile) or when the document is
   * closed (writeState).
   *
   * This ensures changes stay "editor-only" — visible in the Yjs
   * CRDT for real-time collab but NOT persisted until the user
   * explicitly saves.
   */
  _setupAutoFlush(docName, ydoc) {
    // Only set up for workspace documents
    const parsed = parseDocName(docName);
    if (!parsed) return;

    // Clean up existing observer if any
    this._cleanupAutoFlush(docName);

    const { filePath } = parsed;
    
    // Use the canonical text type
    const targetText = ydoc.getText(YTEXT_TYPE);
    if (!targetText) return;

    // Store the entry reference up-front so the observer closure can update
    // `entry.flushTimer` in-place — _cleanupAutoFlush reads `entry.flushTimer`
    // to cancel pending timers, so the two MUST share the same object.
    const entry = { ydoc, text: targetText, observer: null, flushTimer: null, docLevelObserver: null, dirty: false };

    const observer = () => {
      // Mark as dirty so writeState / explicit-save knows content changed
      entry.dirty = true;
      // Update in-memory hash cache (cheap — no I/O)
      if (entry.flushTimer) clearTimeout(entry.flushTimer);
      entry.flushTimer = setTimeout(() => {
        entry.flushTimer = null;
        try {
          const content = targetText.toString();
          fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });
        } catch (e) {
          console.error(`[Collab AutoFlush] Hash update failed for ${filePath}:`, e.message);
        }
      }, this.FLUSH_DEBOUNCE_MS);
    };

    // Observe changes on the text type
    entry.observer = observer;
    targetText.observe(observer);

    // Also observe at the Y.Doc level as a safety net.  In some race
    // conditions (async bindState vs sync protocol messages) the Y.Text
    // observer can miss the very first remote update.  The doc-level
    // handler re-triggers the same debounced flush so there's no double-write.
    const docLevelObserver = (update, origin) => {
      // Only trigger for remote updates (origin is the WS connection object)
      if (origin !== null && origin !== undefined) {
        observer();
      }
    };
    entry.docLevelObserver = docLevelObserver;
    ydoc.on('update', docLevelObserver);

    // Store for cleanup
    this.docObservers.set(docName, entry);
    
    console.log(`[Collab AutoFlush] Set up auto-flush for ${docName}`);
  }

  /**
   * Clean up auto-flush observer
   */
  _cleanupAutoFlush(docName) {
    const entry = this.docObservers.get(docName);
    if (entry) {
      try {
        if (entry.text && entry.observer) {
          entry.text.unobserve(entry.observer);
        }
        if (entry.ydoc && entry.docLevelObserver) {
          entry.ydoc.off('update', entry.docLevelObserver);
        }
        if (entry.flushTimer) {
          clearTimeout(entry.flushTimer);
        }
      } catch (e) {
        console.warn(`[Collab AutoFlush] Cleanup error for ${docName}:`, e.message);
      }
      this.docObservers.delete(docName);
    }
  }

  /**
   * Explicitly flush the current CRDT content for a document to disk and
   * GCS.  Called from the 'sync' action handler when the user saves.
   *
   * This replaces the old auto-flush behavior — disk/GCS writes now only
   * happen on demand rather than on every keystroke.
   *
   * @param {string} docName  e.g. "workspace:slug:path/to/file.js"
   */
  async flushDocToDisk(docName, options = {}) {
    const parsed = parseDocName(docName);
    if (!parsed) return;

    const { slug, filePath, userId: docUserId, sessionId: docSessionId } = parsed;
    let effectiveUserId = docUserId || null;

    // For shared session docs, writes should target the host's working tree.
    if (docSessionId && !effectiveUserId) {
      const session = sessionManager.getSession(docSessionId);
      if (!session) {
        throw new Error(`Session ${docSessionId} not found for doc ${docName}`);
      }
      effectiveUserId = session.hostId;
    }

    if (!effectiveUserId) {
      throw new Error(`Refusing unscoped flush for doc ${docName}`);
    }

    // Prefer explicit content during save to avoid races where the in-memory
    // Yjs state lags behind the payload currently being persisted.
    let content = typeof options.contentOverride === 'string'
      ? options.contentOverride
      : null;

    // Read content from the in-memory Yjs doc (the observer tracks it)
    const entry = this.docObservers.get(docName);
    if (content == null) {
      if (entry && entry.text) {
        content = entry.text.toString();
      } else {
        // Fallback: look up the Y.Doc directly
        const ydoc = this.inner && typeof this.inner.getYDoc === 'function'
          ? this.inner.getYDoc(docName)
          : null;
        if (!ydoc) return;
        content = ydoc.getText(YTEXT_TYPE).toString();
      }
    }

    if (content == null) return;

    // ── 1. GCS sync (durable store) ──────────────────────────────────
    if (config.GCS_SYNC_ON_FLUSH && gcsSync && typeof gcsSync.isGcsConfigured === 'function' && gcsSync.isGcsConfigured()) {
      try {
        await gcsSync.syncFileToGcs(slug, filePath, content, effectiveUserId);
      } catch (e) {
        console.warn(`[Collab Flush] GCS sync failed for ${filePath}:`, e?.message || e);
      }
    }

    // ── 2. Disk write to the scoped repo only ────────────────────────
    const repoPath = gitService.getEffectiveRepoPath(slug, effectiveUserId);
    if (fs.existsSync(repoPath)) {
      const fullPath = path.join(repoPath, filePath);
      await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
      await fsPromises.writeFile(fullPath, content, 'utf-8');
    }

    // Update hash cache
    fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });

    // Keep live Yjs text aligned with persisted content when save payload
    // was provided explicitly.
    if (typeof options.contentOverride === 'string' && entry?.text) {
      try {
        const current = entry.text.toString();
        if (current !== options.contentOverride) {
          entry.ydoc?.transact(() => {
            entry.text.delete(0, entry.text.length);
            entry.text.insert(0, options.contentOverride);
          });
        }
        entry.dirty = false;
      } catch (_) {}
    }

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

    // Broadcast file-saved so all collaborators can sync their saved state
    broadcastFileSaved(slug, filePath, { userId: effectiveUserId, sessionId: docSessionId || null });

    console.log(`[Collab Flush] Explicit save: ${filePath} -> disk + GCS (${content.length} chars)`);
  }

  async bindState(docName, ydoc) {
    // First, bind the persisted state (if any)
    if (this.inner.bindState) {
      await this.inner.bindState(docName, ydoc);
    }

    // Now validate against actual file
    const parsed = parseDocName(docName);
    if (!parsed) {
      // Not a workspace document, skip validation
      return;
    }

    const { slug, filePath } = parsed;
    
    const effectiveUserId = resolveEffectiveUserForDoc(parsed);
    const actualContent = await getActualFileContent(slug, filePath, effectiveUserId);
    
    if (actualContent === null) {
      // File doesn't exist on disk yet — still set up auto-flush so that
      // when the client starts typing, the content is written to disk.
      // Without this, new files created through the Yjs editor would never
      // be flushed (the old code returned early here, skipping _setupAutoFlush).
      this._setupAutoFlush(docName, ydoc);
      return;
    }

    const persistedContent = getYDocContent(ydoc);
    const actualHash = computeHash(actualContent);
    const persistedHash = computeHash(persistedContent);

    // Condensed logging - only log when relevant
    if (actualHash !== persistedHash) {
      console.log(`[Collab] STALE DATA: ${filePath} | persisted=${persistedHash.substring(0, 8)} | actual=${actualHash.substring(0, 8)} | resetting...`);

      // Clear the persisted state and reset to actual content
      if (this.inner.clearDocument) {
        await this.inner.clearDocument(docName);
      }

      // Reset the canonical text type with actual file content
      // Also clear any ghost content in legacy text type names
      ydoc.transact(() => {
        const canonical = ydoc.getText(YTEXT_TYPE);
        canonical.delete(0, canonical.length);
        canonical.insert(0, actualContent);
        // Clear legacy text types to prevent ghost content from older sessions
        for (const legacy of ['content', 'text', 'codemirror']) {
          const lt = ydoc.getText(legacy);
          if (lt.length > 0) lt.delete(0, lt.length);
        }
      });

      // Update hash cache
      fileHashCache.set(docName, { hash: actualHash, timestamp: Date.now() });

      // SAFEGUARD: After resetting, a reconnecting client may still send
      // stale CRDT state via the sync protocol, which Yjs merges into this
      // doc — causing content duplication.  Install a one-shot update
      // handler that detects unexpected growth and re-resets the doc.
      // Active for 10 seconds after reset, then auto-removed.
      const resetLength = actualContent.length;
      const GROWTH_THRESHOLD = 1.3; // Flag if content grows >30% beyond expected
      let guardRemoved = false;
      let reResetCount = 0;
      const MAX_RE_RESETS = 5; // prevent infinite reset loops
      const staleGuard = () => {
        if (guardRemoved) return;
        try {
          const currentText = ydoc.getText(YTEXT_TYPE).toString();
          if (currentText.length > resetLength * GROWTH_THRESHOLD && resetLength > 0 && reResetCount < MAX_RE_RESETS) {
            reResetCount++;
            console.warn(`[Collab] STALE MERGE detected for ${filePath}: expected ~${resetLength} chars, got ${currentText.length}. Re-resetting (attempt ${reResetCount}).`);
            ydoc.transact(() => {
              const canonical = ydoc.getText(YTEXT_TYPE);
              canonical.delete(0, canonical.length);
              canonical.insert(0, actualContent);
            });
            fileHashCache.set(docName, { hash: actualHash, timestamp: Date.now() });
          }
        } catch (_) {}
      };
      ydoc.on('update', staleGuard);
      setTimeout(() => {
        guardRemoved = true;
        try { ydoc.off('update', staleGuard); } catch (_) {}
      }, 10000);
    } else {
      fileHashCache.set(docName, { hash: actualHash, timestamp: Date.now() });
    }
    
    // Set up auto-flush so all future Y.js changes are written to disk
    // This is critical for Container-First architecture
    this._setupAutoFlush(docName, ydoc);
  }

  async writeState(docName, ydoc) {
    const content = getYDocContent(ydoc);
    
    if (this.inner.writeState) {
      await this.inner.writeState(docName, ydoc);
    }
    
    // Update hash cache when writing
    fileHashCache.set(docName, { hash: computeHash(content), timestamp: Date.now() });

    // Do NOT flush to disk on close in manual-save mode.
    // Persisting unsaved buffers to git worktrees causes unexpected source-control changes.
  }

  async clearDocument(docName) {
    fileHashCache.delete(docName);
    if (this.inner.clearDocument) {
      await this.inner.clearDocument(docName);
    }
  }

  // Proxy other methods to inner persistence
  async flushDocument(docName) {
    if (this.inner.flushDocument) {
      await this.inner.flushDocument(docName);
    }
  }
}

// Wrap the base persistence with validation
const persistence = new ValidatingPersistence(basePersistence);

const workspaceManager = require('./workspaceManager');

// ── Access y-websocket internal docs for invalidation ──
// y-websocket's utils module exports a `docs` Map<docName, WSSharedDoc>.
// We use this to programmatically destroy stale Y.Docs when git operations
// change files on disk (checkout, pull, discard, etc.)
let yWsUtils = null;
try {
  yWsUtils = require('y-websocket/bin/utils');
} catch (_) {
  try { yWsUtils = require('y-websocket/bin/utils.js'); } catch (_2) {
    try { yWsUtils = require('y-websocket/dist/bin/utils.cjs'); } catch (_3) { /* already loaded via root */ }
  }
}
const yWsDocs = (yWsUtils && yWsUtils.docs) ? yWsUtils.docs : null;

// ── CRITICAL: Register our persistence with y-websocket ──────────────────────
// y-websocket uses a module-level `persistence` variable that must be set via
// setPersistence(). Passing `persistence` as an option to setupWSConnection()
// does NOT work — that function only destructures { docName, gc } and silently
// ignores any other keys.  Without this call, bindState / writeState / the
// auto-flush observer are never invoked and Yjs edits are never written to disk.
if (yWsUtils && typeof yWsUtils.setPersistence === 'function') {
  yWsUtils.setPersistence(persistence);
  console.log('[Collab] Registered ValidatingPersistence with y-websocket via setPersistence()');
} else {
  console.error('[Collab] WARNING: Could not register persistence with y-websocket — setPersistence not available. Auto-flush to disk will NOT work.');
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

async function invalidateDocsForSlug(slug, filePaths = null, scope = {}) {
  const prefix = `workspace:${slug}:`;
  const toInvalidate = [];

  // Direct-access model: scope may have both sessionId and userId.
  // Match docs by userId (repo owner) OR sessionId (session-scoped docs).
  const matchesScope = (parsed) => {
    if (!scope.sessionId && !scope.userId) return true; // no scope filter
    const docUserId = resolveEffectiveUserForDoc(parsed);
    // Match if the doc belongs to the scope's user (direct-access)
    if (scope.userId && docUserId === scope.userId) return true;
    // Match session-scoped docs by sessionId (legacy compat)
    if (scope.sessionId && parsed.sessionId === scope.sessionId) return true;
    return false;
  };

  // Collect doc names to invalidate
  if (yWsDocs) {
    for (const docName of yWsDocs.keys()) {
      if (!docName.startsWith(prefix)) continue;
      const parsed = parseDocName(docName);
      if (!parsed) continue;
      if (!matchesScope(parsed)) continue;
      if (filePaths && filePaths.length > 0) {
        const docPath = parsed?.filePath || docName.slice(prefix.length);
        if (!filePaths.includes(docPath)) continue;
      }
      toInvalidate.push(docName);
    }
  }

  // Also scan persistence observer map for docs that may not be in yWsDocs
  for (const docName of persistence.docObservers.keys()) {
    if (!docName.startsWith(prefix)) continue;
    const parsed = parseDocName(docName);
    if (!parsed) continue;
    if (!matchesScope(parsed)) continue;
    if (filePaths && filePaths.length > 0) {
      const docPath = parsed?.filePath || docName.slice(prefix.length);
      if (!filePaths.includes(docPath)) continue;
    }
    if (!toInvalidate.includes(docName)) toInvalidate.push(docName);
  }

  for (const docName of toInvalidate) {
    // 1. Clean up auto-flush observer so it doesn't overwrite git changes
    persistence._cleanupAutoFlush(docName);

    // 2. Clear persisted (LevelDB/in-memory) state
    await persistence.clearDocument(docName);

    // 3. Clear hash cache so next bindState re-reads from disk
    fileHashCache.delete(docName);

    // 4. Close all WebSocket connections for this doc BEFORE destroying it.
    //    y-websocket's WSSharedDoc tracks connections in doc.conns (Map<ws, Set>).
    //    If we only call wsDoc.destroy() without closing these connections,
    //    the clients' WebsocketProviders stay connected and auto-reconnect.
    //    On reconnect y-websocket creates a fresh doc, but the client sends
    //    its stale CRDT state via the sync protocol — the merge of stale
    //    client state + fresh server state causes content duplication.
    //    By closing connections first, the client provider detects the
    //    disconnect and reconnects cleanly — with an empty local doc that
    //    receives fresh content from the server's new bindState.
    if (yWsDocs && yWsDocs.has(docName)) {
      const wsDoc = yWsDocs.get(docName);
      // Close every WebSocket attached to this doc
      if (wsDoc.conns && wsDoc.conns.size > 0) {
        for (const conn of Array.from(wsDoc.conns.keys())) {
          try {
            wsDoc.conns.delete(conn);
            conn.close(4000, 'doc-invalidated');
          } catch (_) {}
        }
      }
      try { wsDoc.destroy(); } catch (_) {}
      yWsDocs.delete(docName);
    }

    activeDocuments.delete(docName);
  }

  if (toInvalidate.length > 0) {
    console.log(`[Collab] Invalidated ${toInvalidate.length} Yjs docs for slug ${slug}`);

    // Set revert cooldown for affected file paths — reject stale sync (save)
    // requests that were in-flight before the invalidation.
    const now = Date.now();
    const affectedPaths = filePaths && filePaths.length > 0
      ? filePaths
      : toInvalidate.map(dn => { const p = parseDocName(dn); return p?.filePath; }).filter(Boolean);
    for (const fp of affectedPaths) {
      revertCooldowns.set(`${slug}:${fp}`, now);
    }
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
}

function broadcastGitStatusChanged(slug, filePath, scope = {}, { immediate = false } = {}) {
  if (!slug || !notifyWss) return;
  const send = () => {
    const message = JSON.stringify({ type: 'git-status-changed', slug, filePath, scope });
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
    send();
    return;
  }
  // Auto-flush / background changes — debounce per-slug (500ms)
  const timerKey = `${slug}|${_makeScopeKey(scope)}`;
  if (_gitStatusBroadcastTimers.has(timerKey)) {
    clearTimeout(_gitStatusBroadcastTimers.get(timerKey));
  }
  _gitStatusBroadcastTimers.set(timerKey, setTimeout(() => {
    _gitStatusBroadcastTimers.delete(timerKey);
    send();
  }, 500));
}

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
}

/**
 * Clear Yjs persistence for a document (used when merge conflicts need fresh file content).
 * @param {string} docName - The document name (room key), e.g., "workspace:slug:filepath"
 */
async function clearDocumentPersistence(docName) {
  try {
    if (persistence.clearDocument && typeof persistence.clearDocument === 'function') {
      await persistence.clearDocument(docName);
      console.log('[Collab] Cleared persistence for document:', docName);
    } else if (persistence.flushDocument && typeof persistence.flushDocument === 'function') {
      await persistence.flushDocument(docName);
      console.log('[Collab] Flushed document from persistence:', docName);
    } else {
      console.warn('[Collab] No clearDocument method available on persistence');
    }
  } catch (e) {
    console.warn('[Collab] Error clearing persistence for', docName, e?.message || e);
  }
}

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-user-id, x-session-id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // Debug endpoint to check collab server state
  if (req.url === '/debug/status' && req.method === 'GET') {
    const status = {
      server: 'running',
      persistence: LeveldbPersistence ? 'LevelDB' : 'In-Memory',
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
        console.log(`[Block] ${userId} blocked ${blockedUserId}`);
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
        console.log(`[Block] ${userId} unblocked ${blockedUserId}`);
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
      // 1) Gather active Yjs awareness users for this slug
      const prefix = `workspace:${slug}:`;
      const seen = new Map();
      // yWsDocs is the y-websocket internal Map<docName, WSSharedDoc>
      const docsMap = yWsDocs || new Map();
      for (const [docName, doc] of docsMap) {
        if (!docName.startsWith(prefix)) continue;
        const awareness = doc.awareness;
        if (!awareness) continue;
        awareness.getStates().forEach((state, clientId) => {
          if (!state || !state.user) return;
          const userId = String(state.user.id || clientId);
          const prev = seen.get(userId);
          const ts = state.lastActive || 0;
          if (!prev || (prev.lastActive || 0) < ts) {
            seen.set(userId, {
              id: userId,
              name: state.user.name || 'Anonymous',
              color: state.user.color || '#888',
              image: state.user.image || null,
              lastActive: ts,
              currentFile: docName.slice(prefix.length).replace(/^user:[^:]+:/, ''),
            });
          }
        });
      }
      let activeUsers = Array.from(seen.values());

      // 2) Get active collaboration sessions for this slug
      const sessions = sessionManager.getSessionsForSlug(slug);

      // 3) Filter out blocked users.
      //    If requesterId is provided, hide users who have blocked them
      //    AND users whom they have blocked.
      const requesterId = urlObj.searchParams.get('userId');
      if (requesterId) {
        const myBlocked = blockedBy.get(requesterId) || new Set(); // users I blocked
        activeUsers = activeUsers.filter(u => {
          if (u.id === requesterId) return true; // always include self
          // Hide users I blocked
          if (myBlocked.has(u.id)) return false;
          // Hide users who blocked me
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

        // Send invite notification to the target user via notification WS
        const inviteMsg = JSON.stringify({
          type: 'collab-invite',
          slug,
          sessionId: session.id,
          hostId,
          hostName: hostName || hostId,
          hostAvatar: hostAvatar || '',
          inviteToken: session.inviteToken,
          roomCode: session.roomCode || null,
        });
        if (notifyWss) {
          notifyWss.clients.forEach((ws) => {
            if (ws.readyState === WebSocket.OPEN && ws._slug === slug && ws._userId === targetUserId) {
              try { ws.send(inviteMsg); } catch (_) {}
            }
          });
        }

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
          // the joining guest's UI, then search Yjs awareness states for
          // the target user's display name, and finally fall back to targetUserId.
          let resolvedHostName = targetUserName || '';
          if (!resolvedHostName) {
            const prefix = `workspace:${slug}:`;
            const docsMap = yWsDocs || new Map();
            for (const [docName, doc] of docsMap) {
              if (!docName.startsWith(prefix)) continue;
              const awareness = doc.awareness;
              if (!awareness) continue;
              for (const [, state] of awareness.getStates()) {
                if (state?.user && String(state.user.id) === targetUserId && state.user.name) {
                  resolvedHostName = state.user.name;
                  break;
                }
              }
              if (resolvedHostName) break;
            }
          }
          session = sessionManager.createSession({
            hostId: targetUserId,
            hostName: resolvedHostName || targetUserId,
            hostAvatar: '',
            slug,
            worktreePath: '',
            defaultPerms: { canEdit: true, canTerminal: false, canGit: false, canFileOps: true },
          });
          console.log(`[Session] Auto-created session ${session.id} for host ${targetUserId} (on demand)`);

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
            } else if (action !== 'status' && action !== 'branches' && action !== 'log'
                        && action !== 'diff' && action !== 'file-content' && action !== 'blame'
                        && action !== 'unpushed' && action !== 'incoming'
                        && action !== 'init' && action !== 'clone') {
              // For mutating actions, require a userId.
              // Read-only actions and init/clone are allowed without a session
              // (for SSR/initial load and workspace creation).
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
              'discard', 'stage', 'stage-lines', 'unstage', 'sync',
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
                    result = await gitService.initRepo(slug, data.remoteUrl, userId);
                    hydratedSlugs.add(hydrationKey(slug, userId));
                    break;
                case 'add-remote':
                    result = await gitService.addRemote(slug, data.name, data.url, effectiveUserId);
                    break;
                case 'remove-remote':
                    result = await gitService.removeRemote(slug, data.name, effectiveUserId);
                    break;
                case 'remotes':
                    result = await gitService.getRemotes(slug, effectiveUserId);
                    break;
                case 'clone':
                  result = await gitService.cloneRepo(slug, data.repoUrl, data.token, userId);
                  hydratedSlugs.add(hydrationKey(slug, userId));
                  // Save metadata locally
                  workspaceManager.addWorkspace(slug, data.repoUrl, data.owner, data.name);

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

                        if (res.ok || res.status === 409) { // 201 created or 409 already exists are acceptable
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
                      // If we could not create the workspace record, fail the request - otherwise the UI will redirect to a workspace that 404s
                      const errMsg = `Failed to notify Synthi app to create workspace '${slug}' after ${maxAttempts} attempts.`;
                      console.error('[Collab]', errMsg);
                      // Throw an error to be handled by the outer catch and return non-200
                      throw new Error(errMsg);
                    }
                  } else {
                    console.warn('[Collab] Fetch not available - skipping workspace creation in main app. Set SYNTHI_APP_URL or install node-fetch.');
                  }

                  broadcastFileTreeChanged(slug, notifyScope);
                  break;
                case 'status':
                    result = await gitService.getStatus(slug, effectiveUserId);
                    break;
                case 'branches':
                    result = await gitService.getBranches(slug, effectiveUserId);
                    break;
                case 'checkout':
                    result = await gitService.checkout(slug, data.branch, data.create, effectiveUserId);
                    // Broadcast BEFORE invalidation so clients destroy stale
                    // Yjs docs before WS close triggers provider reconnect.
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'fetch':
                    result = await gitService.fetch(slug, effectiveUserId);
                    break;
                case 'commit':
                    result = await gitService.commit(slug, data.message, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage':
                    result = await gitService.stageFile(slug, data.filePath, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage-all':
                    result = await gitService.stageAll(slug, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'stage-lines':
                    result = await gitService.stageLines(slug, data.filePath, data.patch, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'unstage':
                    result = await gitService.unstageFile(slug, data.filePath, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'unstage-all':
                    result = await gitService.unstageAll(slug, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'push':
                    result = await gitService.push(slug, effectiveUserId);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
                    break;
                case 'pull':
                    result = await gitService.pull(slug, effectiveUserId);
                    // Broadcast BEFORE invalidation so clients destroy stale
                    // Yjs docs before WS close triggers provider reconnect.
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
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
                    result = await gitService.discardAll(slug, effectiveUserId);
                    // Broadcast BEFORE invalidation so clients destroy stale
                    // Yjs docs before WS close triggers provider reconnect.
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    broadcastGitStatusChanged(slug, undefined, notifyScope, { immediate: true });
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
                case 'conflict-versions':
                    result = await gitService.getConflictVersions(slug, data.filePath, effectiveUserId);
                    break;
                case 'diff':
                    result = await gitService.getDiff(slug, data.filePath, { parsed: data.parsed, userId: effectiveUserId });
                    break;
                case 'file-content':
                    const fileContent = await gitService.getFileContent(slug, data.filePath, data.ref, effectiveUserId);
                    result = { content: fileContent };
                    break;
                case 'log':
                    result = await gitService.getLog(slug, { page: data.page, limit: data.limit, userId: effectiveUserId });
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
                    result = await gitService.stashPush(slug, data.message, effectiveUserId);
                    break;
                case 'stash-pop':
                    result = await gitService.stashPop(slug, data.index, effectiveUserId);
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'stash-apply':
                    result = await gitService.stashApply(slug, data.index, effectiveUserId);
                    broadcastFileReverted(slug, [], notifyScope);
                    await invalidateDocsForSlug(slug, null, notifyScope);
                    broadcastFileTreeChanged(slug, notifyScope);
                    break;
                case 'stash-drop':
                    result = await gitService.stashDrop(slug, data.index, effectiveUserId);
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

                      // 1. Write the content provided by the client to the git working tree.
                      await gitService.syncFile(slug, data.filePath, data.content, effectiveUserId);
                      // 2. Also flush the Yjs CRDT content to disk + GCS.
                      //    This ensures GCS stays up-to-date and all per-user
                      //    repos get the latest content on explicit save.
                      const docKey = buildDocName(slug, data.filePath, notifyScope);
                      await persistence.flushDocToDisk(docKey, { contentOverride: data.content });
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
                  result = fileIndex.search(slug, data.q || data.query || '');
                  break;
                case 'open-lookup':
                  result = fileIndex.fileLookup(slug, data.q || data.query || '');
                  break;
                case 'imports':
                  result = fileIndex.getImports(slug, data.filePath || data.path || '');
                  break;
                case 'file':
                    const content = await gitService.readFile(slug, data.path, effectiveUserId);
                    result = { content };
                    break;
                case 'file-hash':
                    // Get content hash for a file (for VFS validation)
                    try {
                        const hashContent = await gitService.readFile(slug, data.path, effectiveUserId);
                        const hashValue = computeHash(hashContent);
                        result = { hash: hashValue, path: data.path };
                    } catch (e) {
                        result = { hash: null, path: data.path, error: e.message };
                    }
                    break;
                case 'write-file':
                    await gitService.writeFile(slug, data.path, data.content, effectiveUserId);
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

const wss = new WebSocket.Server({ noServer: true });

// Lightweight notification WebSocket server for non-Yjs broadcasts
// (e.g., file-tree-changed). Clients connect to /notifications?slug=<slug>.
const notifyWss = new WebSocket.Server({ noServer: true });

// Session notification WebSocket server for collaboration events.
// Clients connect to /session-events?sessionId=<id>&userId=<id>.
const sessionWss = new WebSocket.Server({ noServer: true });

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
    // Fallback: try the notification WS channel so the host still gets alerted
    if (notifyWss) {
      const fallbackMsg = JSON.stringify({ type: 'session-knock', sessionId, ...payload });
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

// Track active documents and their content for debugging
const activeDocuments = new Map(); // docName -> { ydoc, lastContent, clientCount }

wss.on('connection', (ws, req) => {
  const roomName = req.url ? req.url.slice(1).split('?')[0] : 'unknown';
  const { userId, sessionId } = getWsQueryParams(req.url || '');
  const clientIp = req.socket?.remoteAddress || 'unknown';
  ws._userId = userId;
  ws._sessionId = sessionId;
  
  console.log(`[Collab DEBUG] === WebSocket Connection ===`);
  console.log(`[Collab DEBUG]   Room: ${roomName}`);
  console.log(`[Collab DEBUG]   Client IP: ${clientIp}`);
  console.log(`[Collab DEBUG]   URL: ${req.url}`);
  
  const parsed = parseDocName(roomName);
  const access = validateDocAccess(parsed, { userId, sessionId });
  if (!access.ok) {
    try { ws.close(1008, access.reason); } catch (_) {}
    console.warn(`[Collab] Denied Yjs WS for room=${roomName}: ${access.reason}`);
    return;
  }

  if (parsed && !parsed.isLegacy) {
    purgeLegacyRoomState(parsed.slug, parsed.filePath).catch(() => {});
  }

  // setupWSConnection handles the y-websocket protocol for a Y.Doc room
  setupWSConnection(ws, req, {
    persistence,
    docName: roomName,
  });

  // ── Pin the repo in the cache while this Yjs WS is alive ──────────
  // Without this, a notification WS disconnect (network blip) would
  // un-pin the repo, and the LRU TTL eviction could delete the working
  // tree while the Yjs connection is still active — causing ENOENT.
  if (parsed) {
    const { slug } = parsed;
    const effectiveUserId = resolveEffectiveUserForDoc(parsed, userId);
    repoCache.pin(slug, effectiveUserId || undefined);
    ws._effectiveUserId = effectiveUserId || null;
    console.log(`[Collab] Pinned repo "${slug}" for Yjs WS (user=${effectiveUserId || 'n/a'})`);
  }
  
  // Track this connection
  if (!activeDocuments.has(roomName)) {
    activeDocuments.set(roomName, { clientCount: 0, lastUpdate: Date.now() });
  }
  const docInfo = activeDocuments.get(roomName);
  docInfo.clientCount++;
  console.log(`[Collab DEBUG]   Active clients for ${roomName}: ${docInfo.clientCount}`);
  
  ws.on('message', (data) => {
    // Handle both Buffer and string messages safely
    const byteLen = Buffer.isBuffer(data) ? data.length : (typeof data === 'string' ? Buffer.byteLength(data) : 0);
    if (byteLen > 0) {
      console.log(`[Collab DEBUG] Message received for ${roomName}: ${byteLen} bytes`);
    }
    docInfo.lastUpdate = Date.now();
  });
  
  ws.on('close', () => {
    docInfo.clientCount--;
    console.log(`[Collab DEBUG] Connection closed for ${roomName}. Remaining clients: ${docInfo.clientCount}`);

    // Unpin the repo ONLY if no other Yjs connections remain for the same scope.
    if (parsed) {
      const { slug } = parsed;
      const effectiveUserId = ws._effectiveUserId || resolveEffectiveUserForDoc(parsed, userId);
      const anyActiveForSlug = [...activeDocuments.entries()].some(
        ([key, info]) => {
          if (info.clientCount <= 0) return false;
          const p = parseDocName(key);
          if (!p || p.slug !== slug) return false;
          const pUser = resolveEffectiveUserForDoc(p);
          return (pUser || null) === (effectiveUserId || null);
        }
      );
      if (!anyActiveForSlug) {
        repoCache.unpin(slug, effectiveUserId || undefined);
        console.log(`[Collab] Unpinned repo "${slug}" — no more Yjs clients for user=${effectiveUserId || 'n/a'}`);
      }
    }
  });
  
  ws.on('error', (err) => {
    console.error(`[Collab DEBUG] WebSocket error for ${roomName}:`, err.message);
  });
});

// ── WebSocket heartbeat ──────────────────────────────────────────────────────
// Ping every client every 30s. If a client doesn't respond with pong within
// 10s, terminate the connection. This prevents stale/zombie connections that
// accumulate behind proxies and load-balancers.
const WS_PING_INTERVAL = 30_000;

function startHeartbeat(wsServer, label) {
  return setInterval(() => {
    for (const ws of wsServer.clients) {
      if (ws._isAlive === false) {
        console.log(`[Heartbeat] Terminating unresponsive ${label} client`);
        ws.terminate();
        continue;
      }
      ws._isAlive = false;
      ws.ping();
    }
  }, WS_PING_INTERVAL);
}

// Mark clients alive on connect and pong
for (const wsServer of [wss, notifyWss, sessionWss]) {
  wsServer.on('connection', (ws) => {
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });
  });
}

const hbYjs    = startHeartbeat(wss, 'Yjs');
const hbNotify = startHeartbeat(notifyWss, 'Notify');
const hbSession = startHeartbeat(sessionWss, 'Session');

// Clean up heartbeat timers on server close
server.on('close', () => { clearInterval(hbYjs); clearInterval(hbNotify); clearInterval(hbSession); });

server.on('upgrade', (request, socket, head) => {
  const pathname = request.url ? request.url.split('?')[0] : '';
  
  if (pathname === '/notifications') {
    // Notification channel – lightweight JSON broadcasts
    notifyWss.handleUpgrade(request, socket, head, (ws) => {
      // Extract slug and userId from query string: /notifications?slug=<slug>&userId=<userId>
      const params = new URLSearchParams((request.url || '').split('?')[1] || '');
      ws._slug = params.get('slug') || '';
      ws._userId = params.get('userId') || '';
      ws._sessionId = params.get('sessionId') || '';
      notifyWss.emit('connection', ws, request);
      console.log(`[Collab] Notification client connected for slug: ${ws._slug}, user: ${ws._userId}`);
      ws.on('close', () => {
        console.log(`[Collab] Notification client disconnected for slug: ${ws._slug}, user: ${ws._userId}`);
        // Unpin this user's repo so the LRU cache can evict it when idle.
        // Only unpin if no other notification clients remain for the same
        // (slug, userId) pair (e.g. multiple browser tabs).
        if (ws._slug && ws._userId) {
          const stillActive = [...notifyWss.clients].some(
            c => c !== ws && c.readyState === WebSocket.OPEN && c._slug === ws._slug && c._userId === ws._userId
          );
          if (!stillActive) {
            repoCache.unpin(ws._slug, ws._userId);
          }
        }
      });
    });
  } else if (pathname === '/session-events') {
    // Session collaboration channel — real-time events (knock, perms, kick)
    sessionWss.handleUpgrade(request, socket, head, (ws) => {
      const params = new URLSearchParams((request.url || '').split('?')[1] || '');
      ws._sessionId = params.get('sessionId') || '';
      ws._userId    = params.get('userId')    || '';
      sessionWss.emit('connection', ws, request);

      // Cancel any pending disconnect grace timer for this user
      const pendingTimer = guestDisconnectTimers.get(ws._userId);
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        guestDisconnectTimers.delete(ws._userId);
        console.log(`[Session] Reconnect detected — cancelled disconnect timer for user=${ws._userId}`);
      }

      // Register the host's socket in SessionManager so that resolveSocket
      // and other lookups work for the session WS channel too.
      if (ws._sessionId && ws._userId) {
        const sessionInfo = sessionManager.getSession(ws._sessionId);
        if (sessionInfo && sessionInfo.hostId === ws._userId) {
          try { sessionManager.registerHostSocket(ws._sessionId, ws._userId); } catch (_) {}
          console.log(`[Session] Host socket registered: user=${ws._userId} session=${ws._sessionId}`);
        }
      }

      console.log(`[Session] Client connected: user=${ws._userId} session=${ws._sessionId}`);

      // Handle incoming messages from session-events clients
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'identify') {
            // Client sends identity on (re)connect — update socket mapping
            const { userId, sessionId, role } = msg;
            if (userId && sessionId) {
              ws._userId = userId;
              ws._sessionId = sessionId;
              // Re-register guest socket in SessionManager
              if (role === 'guest') {
                try { sessionManager.updateGuestSocket(sessionId, userId, ws); } catch (_) {}
              }
              console.log(`[Session] Identify: user=${userId} session=${sessionId} role=${role}`);
            }
          } else if (msg.type === 'permission:request') {
            // Guest is requesting a permission from the host
            const { permKey, displayName } = msg;
            const guestId = ws._userId;
            const sessionId = ws._sessionId;
            if (!sessionId || !guestId || !permKey) return;
            // Validate the permission key is legitimate
            const validKeys = ['canEdit', 'canTerminal', 'canGit', 'canFileOps'];
            if (!validKeys.includes(permKey)) return;
            console.log(`[Session] Permission request: guest=${guestId} perm=${permKey} session=${sessionId}`);
            // Forward to the host
            sendToSessionHost(sessionId, 'permission:requested', {
              guestId,
              displayName: displayName || 'Guest',
              permKey,
            });
          } else if (msg.type === 'permission:request-deny') {
            // Host denies a permission request — forward to the requesting guest
            const { guestId, permKey } = msg;
            const sessionId = ws._sessionId;
            if (!sessionId || !guestId || !permKey) return;
            console.log(`[Session] Permission request denied: guest=${guestId} perm=${permKey} session=${sessionId}`);
            sendToSessionUser(sessionId, guestId, 'permission:request-denied', {
              permKey,
            });
          }
        } catch (_) {}
      });

      ws.on('close', () => {
        const userId = ws._userId;
        const sessionId = ws._sessionId;
        console.log(`[Session] Client disconnected: user=${userId} session=${sessionId}`);

        // Check if this user is an admitted guest — if so, use grace period
        const isAdmittedGuest = sessionId && sessionManager.guestIndex?.get(userId) === sessionId;
        if (isAdmittedGuest) {
          console.log(`[Session] Guest ${userId} WS closed — starting ${GUEST_DISCONNECT_GRACE_MS}ms grace period`);
          const timer = setTimeout(() => {
            guestDisconnectTimers.delete(userId);
            // Check if guest reconnected (another WS for same user+session exists)
            let reconnected = false;
            for (const client of sessionWss.clients) {
              if (client.readyState === WebSocket.OPEN && client._userId === userId && client._sessionId === sessionId) {
                reconnected = true;
                break;
              }
            }
            if (!reconnected) {
              console.log(`[Session] Grace period expired — removing guest ${userId} from session ${sessionId}`);
              sessionManager.handleDisconnect(userId);
            } else {
              console.log(`[Session] Grace period expired but guest ${userId} has already reconnected`);
            }
          }, GUEST_DISCONNECT_GRACE_MS);
          guestDisconnectTimers.set(userId, timer);
        } else {
          // Not an admitted guest — handle immediately (e.g. pending knock, host socket)
          sessionManager.handleDisconnect(userId);
        }
      });
    });
  } else {
    // Yjs sync protocol – per-document CRDT connections
    const roomName = pathname.slice(1) || 'unknown';
    console.log(`[Collab DEBUG] Upgrade request for room: ${roomName}`);
    const parsed = parseDocName(roomName);
    const access = validateDocAccess(parsed, getWsQueryParams(request.url || ''));
    if (!access.ok) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      } catch (_) {}
      try { socket.destroy(); } catch (_) {}
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Collaboration server (y-websocket) listening on port ${PORT}`);
  console.log(`[Collab DEBUG] Server started with persistence: ${LeveldbPersistence ? 'LevelDB' : 'In-Memory'}`);
  console.log(`[Config] REPOS_DIR  = ${config.REPOS_DIR}`);
  console.log(`[Config] LEVELDB   = ${config.LEVELDB_DIR}`);
  console.log(`[Config] CODE_INTEL = ${config.CODE_INTEL_URL}`);
  console.log(`[Config] GCS sync  = ${config.GCS_SYNC_ON_FLUSH ? 'ON' : 'OFF'}`);

  // ── Forward SessionManager events to WebSocket clients ──
  sessionManager.on('session:knock', ({ sessionId, hostId, guestId, displayName, avatarUrl }) => {
    // CRITICAL: Send knock ONLY to the Host — never broadcast to guests.
    // Broadcasting to all participants is the root cause of the
    // "Self-Admit Handshake Failure" where the Guest sees the approval
    // UI intended for the Host.
    console.log(`[Session] Knock event: guest=${guestId} (${displayName}) → host-only delivery for session ${sessionId}`);
    sendToSessionHost(sessionId, 'knock', { guestId, displayName, avatarUrl });
  });
  sessionManager.on('session:guestJoined', ({ sessionId, hostId, guest, autoAdmitted }) => {
    const joinedSession = sessionManager.getSession(sessionId);
    broadcastSessionEvent(sessionId, 'guest:joined', {
      guest,
      hostId: hostId || null,
      hostName: joinedSession?.hostName || null,
      slug: joinedSession?.slug || null,
      autoAdmitted: !!autoAdmitted,
    });
  });
  sessionManager.on('session:guestRemoved', ({ sessionId, guestId, reason }) => {
    broadcastSessionEvent(sessionId, 'guest:removed', { guestId, reason });
  });
  sessionManager.on('session:permissionsUpdated', ({ sessionId, guestId, permissions }) => {
    broadcastSessionEvent(sessionId, 'permissions:updated', { guestId, permissions });
  });
  sessionManager.on('session:terminated', ({ sessionId }) => {
    broadcastSessionEvent(sessionId, 'session:terminated', {});
  });
  sessionManager.on('session:knockDenied', ({ sessionId, guestId }) => {
    // Send denial only to the specific guest who was denied
    sendToSessionUser(sessionId, guestId, 'knock:denied', { guestId });
  });
  sessionManager.on('session:knockCancelled', ({ sessionId, guestId }) => {
    // Send cancellation only to the host so they can update their pending list
    sendToSessionHost(sessionId, 'knock:cancelled', { guestId });
  });
  // Warn about legacy workspaces.json if it still exists on disk
  const legacyWsFile = path.join(__dirname, 'workspaces.json');
  if (fs.existsSync(legacyWsFile)) {
    console.warn(
      '[DEPRECATION] workspaces.json still exists on disk — it is no longer read.\n' +
      '  Workspace metadata now lives in-memory via workspaceManager.js and the\n' +
      '  Prisma DB in the main Synthi app. You can safely delete workspaces.json.'
    );
  }
});
