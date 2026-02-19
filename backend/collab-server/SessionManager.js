/**
 * SessionManager — Host/Guest "Remote Control" Collaboration
 *
 * Every user gets a **private session** (a worktree under
 * `repos/<slug>/sessions/<userId>/`).  When a Host invites Guests, those
 * Guests are routed to the Host's worktree — they never get their own.
 *
 * Data structures are held in-memory (Map).  This is intentional:
 * sessions are ephemeral and should not survive server restarts.  If
 * persistence is needed later, swap the Maps for Redis hashes.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Terminology
 *   Session    — a live collaboration room owned by exactly one Host.
 *   Host       — the user whose worktree is being shared.
 *   Guest      — any user who has joined the Host's session.
 *   Token      — a short-lived secret embedded in the invite link.
 *   Permission — a JSON object controlling what a Guest can do.
 * ──────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const EventEmitter = require('events');

// ── Permission flags ─────────────────────────────────────────────────────────

/**
 * Default permissions granted to every new Guest.
 * The Host can override these per-guest at invite time or on the fly.
 */
const DEFAULT_GUEST_PERMISSIONS = Object.freeze({
  canEdit:     false,  // Yjs updates (code editing)
  canTerminal: false,  // PTY stdin writes
  canGit:      false,  // Git mutations (commit, push, stage …)
  canFileOps:  false,  // Create / delete / rename files
});

/**
 * Full-control permission set — used for the Host's own entry.
 */
const HOST_PERMISSIONS = Object.freeze({
  canEdit:     true,
  canTerminal: true,
  canGit:      true,
  canFileOps:  true,
});

// ── Data shapes (JSDoc for IDE support) ──────────────────────────────────────

/**
 * @typedef {Object} GuestPermissions
 * @property {boolean} canEdit
 * @property {boolean} canTerminal
 * @property {boolean} canGit
 * @property {boolean} canFileOps
 */

/**
 * @typedef {Object} GuestEntry
 * @property {string}           guestId     — Unique user/socket identifier
 * @property {string}           displayName — Human-readable name
 * @property {string}           avatarUrl   — Avatar image URL (may be empty)
 * @property {GuestPermissions} permissions
 * @property {string}           joinedAt    — ISO timestamp
 * @property {string}           socketId    — Current WS connection id (may rotate on reconnect)
 */

/**
 * @typedef {Object} Session
 * @property {string}                    id          — Unique session id (UUID)
 * @property {string}                    slug        — Workspace slug
 * @property {string}                    hostId      — User id of the Host
 * @property {string}                    hostName    — Display name of the Host
 * @property {string}                    hostAvatar  — Host avatar URL
 * @property {string}                    worktreePath— Absolute path to Host's worktree
 * @property {string}                    inviteToken — Short-lived HMAC token
 * @property {number}                    tokenExpiresAt — epoch ms
 * @property {GuestPermissions}          defaultPerms — Default perms for new guests
 * @property {Map<string, GuestEntry>}   guests
 * @property {Set<string>}              pendingKnocks— guestIds waiting for approval
 * @property {string}                    createdAt   — ISO timestamp
 * @property {'active'|'closed'}         status
 */

// ── Constants ────────────────────────────────────────────────────────────────

const TOKEN_TTL_MS   = 24 * 60 * 60 * 1000;   // 24 hours
const TOKEN_BYTES    = 32;                     // 256-bit random token
const SESSION_ID_LEN = 12;                     // short hex id for URLs

// ── SessionManager ───────────────────────────────────────────────────────────

class SessionManager extends EventEmitter {
  constructor() {
    super();

    /** @type {Map<string, Session>} sessionId → Session */
    this.sessions = new Map();

    /** @type {Map<string, string>} hostId → sessionId (one active session per host) */
    this.hostIndex = new Map();

    /** @type {Map<string, string>} guestId → sessionId (a guest can only be in one session) */
    this.guestIndex = new Map();

    /** @type {Map<string, string>} inviteToken → sessionId */
    this.tokenIndex = new Map();

    /** @type {Map<string, string>} socketId → guestId (for fast lookup on disconnect) */
    this.socketIndex = new Map();
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  /**
   * Create a new collaborative session for a Host.
   *
   * @param {Object}  opts
   * @param {string}  opts.hostId       — Unique user identifier
   * @param {string}  opts.hostName     — Display name
   * @param {string}  [opts.hostAvatar] — Avatar URL
   * @param {string}  opts.slug         — Workspace slug
   * @param {string}  opts.worktreePath — Absolute path to Host's worktree
   * @param {Partial<GuestPermissions>} [opts.defaultPerms] — Override default guest perms
   * @returns {Session}
   */
  createSession({ hostId, hostName, hostAvatar = '', slug, worktreePath, defaultPerms = {} }) {
    // Enforce one active session per host
    if (this.hostIndex.has(hostId)) {
      const existingId = this.hostIndex.get(hostId);
      const existing = this.sessions.get(existingId);
      if (existing && existing.status === 'active') {
        throw new Error(`Host ${hostId} already has an active session: ${existingId}`);
      }
      // Clean up stale reference
      this._destroySession(existingId);
    }

    const id = crypto.randomBytes(SESSION_ID_LEN).toString('hex');
    const inviteToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');

    /** @type {Session} */
    const session = {
      id,
      slug,
      hostId,
      hostName,
      hostAvatar,
      worktreePath,
      inviteToken,
      tokenExpiresAt: Date.now() + TOKEN_TTL_MS,
      defaultPerms: { ...DEFAULT_GUEST_PERMISSIONS, ...defaultPerms },
      guests: new Map(),
      pendingKnocks: new Set(),
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    this.sessions.set(id, session);
    this.hostIndex.set(hostId, id);
    this.tokenIndex.set(inviteToken, id);

    this.emit('session:created', { sessionId: id, hostId, slug });

    return session;
  }

  /**
   * Regenerate the invite token (invalidates old links).
   */
  regenerateToken(sessionId) {
    const session = this._getActiveSession(sessionId);
    // Revoke old token
    this.tokenIndex.delete(session.inviteToken);
    // Issue new one
    session.inviteToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    session.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    this.tokenIndex.set(session.inviteToken, sessionId);

    this.emit('session:tokenRegenerated', { sessionId });
    return session.inviteToken;
  }

  // ── Guest join / knock flow ──────────────────────────────────────────────

  /**
   * Validate an invite token and return the session it maps to.
   * Does NOT admit the guest — the Host must approve via `admitGuest`.
   *
   * @param {string} token — The invite token from the URL
   * @returns {{ sessionId: string, hostName: string, slug: string } | null}
   */
  validateToken(token) {
    const sessionId = this.tokenIndex.get(token);
    if (!sessionId) return null;

    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return null;
    if (Date.now() > session.tokenExpiresAt) {
      // Expired — clean up
      this.tokenIndex.delete(token);
      return null;
    }

    return {
      sessionId: session.id,
      hostName: session.hostName,
      hostAvatar: session.hostAvatar,
      slug: session.slug,
    };
  }

  /**
   * Guest "knocks" on the session door.  The Host receives a notification
   * and can accept or deny.
   *
   * @param {string} sessionId
   * @param {Object} guest
   * @param {string} guest.guestId
   * @param {string} guest.displayName
   * @param {string} [guest.avatarUrl]
   */
  knock(sessionId, { guestId, displayName, avatarUrl = '' }) {
    const session = this._getActiveSession(sessionId);

    // Already a guest? Ignore knock.
    if (session.guests.has(guestId)) return;

    session.pendingKnocks.add(guestId);

    this.emit('session:knock', {
      sessionId,
      hostId: session.hostId,
      guestId,
      displayName,
      avatarUrl,
    });
  }

  /**
   * Host admits a knocking guest.
   *
   * @param {string} sessionId
   * @param {string} guestId
   * @param {string} socketId — WS socket id of the guest
   * @param {string} displayName
   * @param {string} [avatarUrl]
   * @param {Partial<GuestPermissions>} [permsOverride]
   * @returns {GuestEntry}
   */
  admitGuest(sessionId, { guestId, socketId, displayName, avatarUrl = '', permsOverride = {} }) {
    const session = this._getActiveSession(sessionId);

    // Remove from pending if present
    session.pendingKnocks.delete(guestId);

    // If guest is already in another session, remove them first
    if (this.guestIndex.has(guestId)) {
      const prevSessionId = this.guestIndex.get(guestId);
      this.removeGuest(prevSessionId, guestId, 'moved-to-new-session');
    }

    /** @type {GuestEntry} */
    const entry = {
      guestId,
      displayName,
      avatarUrl,
      permissions: { ...session.defaultPerms, ...permsOverride },
      joinedAt: new Date().toISOString(),
      socketId,
    };

    session.guests.set(guestId, entry);
    this.guestIndex.set(guestId, sessionId);
    this.socketIndex.set(socketId, guestId);

    this.emit('session:guestJoined', {
      sessionId,
      hostId: session.hostId,
      guest: this._serializeGuest(entry),
    });

    return entry;
  }

  /**
   * Deny a pending knock.
   */
  denyKnock(sessionId, guestId) {
    const session = this._getActiveSession(sessionId);
    session.pendingKnocks.delete(guestId);
    this.emit('session:knockDenied', { sessionId, guestId });
  }

  // ── Permission management ───────────────────────────────────────────────

  /**
   * Update permissions for a specific guest in a session.
   *
   * @param {string} sessionId
   * @param {string} guestId
   * @param {Partial<GuestPermissions>} perms — Only the keys you want to change
   * @returns {GuestPermissions} — The merged result
   */
  updatePermissions(sessionId, guestId, perms) {
    const session = this._getActiveSession(sessionId);
    const guest = session.guests.get(guestId);
    if (!guest) throw new Error(`Guest ${guestId} not found in session ${sessionId}`);

    guest.permissions = { ...guest.permissions, ...perms };

    this.emit('session:permissionsUpdated', {
      sessionId,
      guestId,
      permissions: { ...guest.permissions },
    });

    return { ...guest.permissions };
  }

  /**
   * Update the default permissions for future guests.
   */
  updateDefaultPermissions(sessionId, perms) {
    const session = this._getActiveSession(sessionId);
    session.defaultPerms = { ...session.defaultPerms, ...perms };
    return { ...session.defaultPerms };
  }

  // ── Guest removal / session teardown ─────────────────────────────────────

  /**
   * Remove (kick) a single guest from a session.
   *
   * @param {string} sessionId
   * @param {string} guestId
   * @param {string} [reason]
   */
  removeGuest(sessionId, guestId, reason = 'kicked') {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const guest = session.guests.get(guestId);
    if (!guest) return;

    // Clean up indexes
    if (guest.socketId) this.socketIndex.delete(guest.socketId);
    this.guestIndex.delete(guestId);
    session.guests.delete(guestId);

    this.emit('session:guestRemoved', { sessionId, guestId, reason });
  }

  /**
   * Terminate the entire session — disconnects all guests.
   */
  terminateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Notify and clean up all guests
    for (const [guestId] of session.guests) {
      this.removeGuest(sessionId, guestId, 'session-terminated');
    }

    session.status = 'closed';

    this.emit('session:terminated', {
      sessionId,
      hostId: session.hostId,
      slug: session.slug,
    });

    this._destroySession(sessionId);
  }

  // ── Querying ─────────────────────────────────────────────────────────────

  /**
   * Get a session by id (public — returns serializable object).
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return this._serializeSession(session);
  }

  /**
   * Get the active session for a host.
   */
  getSessionByHost(hostId) {
    const sessionId = this.hostIndex.get(hostId);
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  /**
   * Get the session a guest is currently in.
   */
  getSessionByGuest(guestId) {
    const sessionId = this.guestIndex.get(guestId);
    if (!sessionId) return null;
    return this.getSession(sessionId);
  }

  /**
   * Given a socket id, determine the user's role and session.
   * Returns null if the socket is not part of any session.
   *
   * @param {string} socketId
   * @returns {{ session: Session, role: 'host'|'guest', userId: string, permissions: GuestPermissions } | null}
   */
  resolveSocket(socketId) {
    const guestId = this.socketIndex.get(socketId);
    if (guestId) {
      const sessionId = this.guestIndex.get(guestId);
      if (!sessionId) return null;
      const session = this.sessions.get(sessionId);
      if (!session) return null;
      const guest = session.guests.get(guestId);
      if (!guest) return null;
      return { session, role: 'guest', userId: guestId, permissions: { ...guest.permissions } };
    }

    // Maybe it's the host? We don't index host sockets, so scan. This is O(n)
    // but session count is small.
    for (const [, session] of this.sessions) {
      if (session._hostSocketId === socketId) {
        return { session, role: 'host', userId: session.hostId, permissions: { ...HOST_PERMISSIONS } };
      }
    }

    return null;
  }

  /**
   * Register the Host's socket id (call when the Host's WS connects).
   */
  registerHostSocket(sessionId, socketId) {
    const session = this._getActiveSession(sessionId);
    session._hostSocketId = socketId;
  }

  /**
   * Handle a socket disconnecting — clean up guest mapping.
   */
  handleDisconnect(identifier) {
    // identifier can be a socketId OR a userId/guestId.
    // Try socketIndex first (backward compat), then guestIndex.
    let guestId = this.socketIndex.get(identifier);

    if (!guestId) {
      // Check if identifier is itself a guestId
      if (this.guestIndex.has(identifier)) {
        guestId = identifier;
      } else {
        // Check if it's a host socket
        for (const [, session] of this.sessions) {
          if (session._hostSocketId === identifier) {
            delete session._hostSocketId;
            return;
          }
        }
        return;
      }
    }

    const sessionId = this.guestIndex.get(guestId);
    if (sessionId) {
      this.removeGuest(sessionId, guestId, 'disconnected');
    }
    this.socketIndex.delete(identifier);
  }

  /**
   * Check if a user (by id) has a specific permission in the given session.
   * The Host always has full permissions.
   *
   * @param {string} sessionId
   * @param {string} userId
   * @param {keyof GuestPermissions} perm
   * @returns {boolean}
   */
  checkPermission(sessionId, userId, perm) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return false;

    // Host has everything
    if (userId === session.hostId) return true;

    const guest = session.guests.get(userId);
    if (!guest) return false;

    return !!guest.permissions[perm];
  }

  /**
   * List all active sessions for a workspace slug.
   */
  getSessionsForSlug(slug) {
    const result = [];
    for (const [, session] of this.sessions) {
      if (session.slug === slug && session.status === 'active') {
        result.push(this._serializeSession(session));
      }
    }
    return result;
  }

  // ── Effective user resolution ────────────────────────────────────────────

  /**
   * Resolve the effective userId for a given user and session context.
   * 
   * When a guest is in an active session, they operate on the HOST's repo
   * and Yjs rooms — so the "effective" user is the hostId, not the guest's
   * own id.  For the host (or when no session is active), returns the
   * original userId.
   *
   * @param {string} userId    — The authenticated user id
   * @param {string} [sessionId] — Optional active session id
   * @returns {string} The effective userId for repo/room resolution
   */
  getEffectiveUserId(userId, sessionId) {
    if (!sessionId) return userId;
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return userId;
    // Host stays as-is
    if (session.hostId === userId) return userId;
    // Guest maps to host
    if (session.guests.has(userId)) return session.hostId;
    return userId;
  }

  /**
   * Get the host's userId for a guest's active session.
   * Returns null if the user is not a guest in any session.
   *
   * @param {string} guestId — The guest's userId
   * @returns {{ hostId: string, sessionId: string, slug: string } | null}
   */
  getHostForGuest(guestId) {
    const sessionId = this.guestIndex.get(guestId);
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return null;
    return { hostId: session.hostId, sessionId: session.id, slug: session.slug };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  _getActiveSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status !== 'active') throw new Error(`Session ${sessionId} is no longer active`);
    return session;
  }

  _destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Clean all indexes
    this.tokenIndex.delete(session.inviteToken);
    this.hostIndex.delete(session.hostId);
    for (const [guestId, guest] of session.guests) {
      this.guestIndex.delete(guestId);
      if (guest.socketId) this.socketIndex.delete(guest.socketId);
    }
    this.sessions.delete(sessionId);
  }

  _serializeSession(session) {
    return {
      id: session.id,
      slug: session.slug,
      hostId: session.hostId,
      hostName: session.hostName,
      hostAvatar: session.hostAvatar,
      status: session.status,
      guestCount: session.guests.size,
      guests: Array.from(session.guests.values()).map(g => this._serializeGuest(g)),
      pendingKnocks: Array.from(session.pendingKnocks),
      defaultPerms: { ...session.defaultPerms },
      createdAt: session.createdAt,
      // Never serialize the inviteToken to non-host consumers
    };
  }

  _serializeGuest(guest) {
    return {
      guestId: guest.guestId,
      displayName: guest.displayName,
      avatarUrl: guest.avatarUrl,
      permissions: { ...guest.permissions },
      joinedAt: guest.joinedAt,
    };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────
const sessionManager = new SessionManager();

module.exports = sessionManager;
module.exports.DEFAULT_GUEST_PERMISSIONS = DEFAULT_GUEST_PERMISSIONS;
module.exports.HOST_PERMISSIONS = HOST_PERMISSIONS;
