/**
 * CollabSessionService — Frontend service for "Remote Control" collaboration.
 *
 * Manages the lifecycle of a collaboration session:
 *   - Creating sessions (Host)
 *   - Validating invite links, knocking, joining (Guest)
 *   - Real-time permission updates via WebSocket
 *   - Session teardown
 *
 * Consumed by React hooks (`useCollabSession`, `useSessionPermissions`).
 */

const COLLAB_URL = (
  process.env.NEXT_PUBLIC_COLLAB_URL ||
  process.env.NEXT_PUBLIC_YJS_URL ||
  'ws://localhost:1234'
).replace(/^ws/, 'http'); // HTTP version of the WS URL for REST calls

// ── Permission defaults ─────────────────────────────────────────────────────

export const DEFAULT_GUEST_PERMISSIONS = Object.freeze({
  canEdit: false,
  canTerminal: false,
  canGit: false,
  canFileOps: false,
});

export const HOST_PERMISSIONS = Object.freeze({
  canEdit: true,
  canTerminal: true,
  canGit: true,
  canFileOps: true,
});

// ── Event target for React hook subscriptions ────────────────────────────────

class CollabSessionService extends EventTarget {
  constructor() {
    super();

    /** @type {'idle'|'hosting'|'guest'|'knocking'} */
    this._role = 'idle';

    /** @type {object|null} Current session info */
    this._session = null;

    /** @type {object} Permissions for current user */
    this._permissions = { ...HOST_PERMISSIONS };

    /** @type {string|null} */
    this._sessionId = null;

    /** @type {string|null} */
    this._userId = null;

    /** @type {string|null} Host's userId — set when guest joins a session */
    this._hostId = null;

    /** @type {string|null} Workspace slug of the active session */
    this._sessionSlug = null;

    /** @type {WebSocket|null} */
    this._ws = null;

    /** @type {Function[]} */
    this._listeners = [];

    /** @type {Array<{guestId: string, displayName: string, avatarUrl: string}>} */
    this._pendingKnocks = [];
  }

  // ── Getters ──────────────────────────────────────────────────────────────

  get role() { return this._role; }
  get session() { return this._session; }
  get permissions() { return { ...this._permissions }; }
  get sessionId() { return this._sessionId; }
  get hostId() { return this._hostId; }
  get sessionSlug() { return this._sessionSlug; }
  /**
   * Returns the userId that should be used for repo/room scoping.
   * For guests in a session, this is the host's userId.
   * For hosts and idle users, this is their own userId.
   */
  get effectiveUserId() {
    if (this._role === 'guest' && this._hostId) return this._hostId;
    return this._userId;
  }
  get isHost() { return this._role === 'hosting'; }
  get isGuest() { return this._role === 'guest'; }
  get isActive() { return this._role === 'hosting' || this._role === 'guest'; }
  get pendingKnocks() { return [...this._pendingKnocks]; }

  // ── Host: Create session ─────────────────────────────────────────────────

  /**
   * Create a new collaboration session. Only the Host calls this.
   *
   * @param {Object} opts
   * @param {string} opts.hostId
   * @param {string} opts.hostName
   * @param {string} [opts.hostAvatar]
   * @param {string} opts.slug
   * @param {Partial<typeof DEFAULT_GUEST_PERMISSIONS>} [opts.defaultPerms]
   * @returns {Promise<{sessionId: string, inviteToken: string, inviteLink: string}>}
   */
  async createSession({ hostId, hostName, hostAvatar = '', slug, defaultPerms = {} }) {
    const res = await fetch(`${COLLAB_URL}/session/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId, hostName, hostAvatar, slug, defaultPerms }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Failed to create session');
    }

    const data = await res.json();

    this._role = 'hosting';
    this._sessionId = data.sessionId;
    this._userId = hostId;
    this._sessionSlug = slug;
    this._permissions = { ...HOST_PERMISSIONS };
    this._session = { id: data.sessionId, inviteLink: data.inviteLink, inviteToken: data.inviteToken };
    this._pendingKnocks = [];

    this._connectWs();
    this._emit('session:created', data);

    return data;
  }

  // ── Guest: Validate token → knock → join ─────────────────────────────────

  /**
   * Validate an invite token before showing the knock UI.
   */
  async validateToken(token) {
    const res = await fetch(`${COLLAB_URL}/session/validate-token?token=${encodeURIComponent(token)}`);
    if (!res.ok) return null;
    return res.json();
  }

  /**
   * Guest knocks on a session (requests to join).
   */
  async knock(sessionId, { guestId, displayName, avatarUrl = '' }) {
    this._role = 'knocking';
    this._sessionId = sessionId;
    this._userId = guestId;

    await fetch(`${COLLAB_URL}/session/knock/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, displayName, avatarUrl }),
    });

    // Connect to the session WS to receive admit/deny events
    this._connectWs();
    this._emit('knock:sent', { sessionId });
  }

  // ── Host: Manage guests ──────────────────────────────────────────────────

  /**
   * Host admits a knocking guest.
   */
  async admitGuest(guestId, { displayName, avatarUrl = '', socketId = '', permsOverride = {} }) {
    if (!this.isHost) throw new Error('Only the host can admit guests');

    const res = await fetch(`${COLLAB_URL}/session/admit/${this._sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, displayName, avatarUrl, socketId, permsOverride }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to admit guest');
    }

    // Remove from pending knocks
    this._pendingKnocks = this._pendingKnocks.filter(k => k.guestId !== guestId);
    this._emit('knock:resolved', { guestId });

    return res.json();
  }

  /**
   * Host denies a knocking guest.
   */
  async denyKnock(guestId) {
    if (!this.isHost) throw new Error('Only the host can deny guests');

    await fetch(`${COLLAB_URL}/session/deny/${this._sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId }),
    });

    this._pendingKnocks = this._pendingKnocks.filter(k => k.guestId !== guestId);
    this._emit('knock:resolved', { guestId });
  }

  /**
   * Host updates a guest's permissions.
   */
  async updatePermissions(guestId, permissions) {
    if (!this.isHost) throw new Error('Only the host can update permissions');

    const res = await fetch(`${COLLAB_URL}/session/permissions/${this._sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, permissions }),
    });

    return res.json();
  }

  /**
   * Host kicks a guest.
   */
  async kickGuest(guestId) {
    if (!this.isHost) throw new Error('Only the host can kick guests');

    await fetch(`${COLLAB_URL}/session/kick/${this._sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId }),
    });
  }

  /**
   * Host terminates the entire session.
   */
  async terminateSession() {
    if (!this.isHost) throw new Error('Only the host can terminate');

    await fetch(`${COLLAB_URL}/session/terminate/${this._sessionId}`, {
      method: 'DELETE',
    });

    this._cleanup();
    this._emit('session:terminated', {});
  }

  /**
   * Guest leaves the session voluntarily.
   * Notifies the server so the host's guest list is updated immediately.
   */
  async leaveSession() {
    const sessionId = this._sessionId;
    const userId = this._userId;
    this._cleanup();
    this._emit('session:left', {});

    // Best-effort server notification — fire and forget
    if (sessionId) {
      try {
        await fetch(`${COLLAB_URL}/session/leave/${sessionId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guestId: userId }),
        });
      } catch (_) { /* non-fatal */ }
    }
  }

  /**
   * Regenerate invite link.
   */
  async regenerateInvite() {
    if (!this.isHost) throw new Error('Only the host can regenerate');

    const res = await fetch(`${COLLAB_URL}/session/regenerate-token/${this._sessionId}`, {
      method: 'POST',
    });

    const data = await res.json();
    if (this._session) {
      this._session.inviteLink = data.inviteLink;
      this._session.inviteToken = data.inviteToken;
    }
    this._emit('invite:regenerated', data);
    return data;
  }

  /**
   * Fetch the latest session info from the server.
   */
  async refreshSession() {
    if (!this._sessionId) return null;

    const res = await fetch(`${COLLAB_URL}/session/info/${this._sessionId}`);
    if (!res.ok) return null;

    const data = await res.json();
    this._session = { ...this._session, ...data };
    this._emit('session:updated', data);
    return data;
  }

  // ── Workspace Presence ────────────────────────────────────────────────────

  /**
   * Fetch all active users and sessions for a workspace.
   *
   * @param {string} slug — Workspace slug
   * @returns {Promise<{ activeUsers: Array, sessions: Array }>}
   */
  async getWorkspacePresence(slug) {
    const res = await fetch(`${COLLAB_URL}/workspace-presence/${encodeURIComponent(slug)}`);
    if (!res.ok) return { activeUsers: [], sessions: [] };
    return res.json();
  }

  /**
   * Request to join another user's active session (knock on their door).
   *
   * @param {string} sessionId — Target session to join
   * @param {{ guestId: string, displayName: string, avatarUrl?: string }} guestInfo
   */
  async requestJoinSession(sessionId, { guestId, displayName, avatarUrl = '' }) {
    this._role = 'knocking';
    this._sessionId = sessionId;
    this._userId = guestId;

    const res = await fetch(`${COLLAB_URL}/session/request-join/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, displayName, avatarUrl }),
    });

    if (!res.ok) {
      this._role = 'idle';
      this._sessionId = null;
      const err = await res.json().catch(() => ({ error: 'Failed to request join' }));
      throw new Error(err.error || 'Failed to request join');
    }

    this._connectWs();
    this._emit('knock:sent', { sessionId });
  }

  // ── Direct Collaboration (no pre-existing session required) ───────────────

  /**
   * Ask to join a specific user's workspace.  If the target user doesn't
   * have an active session, one is created for them on the server side.
   *
   * @param {{ targetUserId: string, targetUserName: string, slug: string, guestId: string, displayName: string, avatarUrl?: string }} opts
   */
  async joinUser({ targetUserId, targetUserName, slug, guestId, displayName, avatarUrl = '' }) {
    this._role = 'knocking';
    this._userId = guestId;

    const res = await fetch(`${COLLAB_URL}/session/join-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUserId, targetUserName, guestId, displayName, avatarUrl, slug }),
    });

    if (!res.ok) {
      this._role = 'idle';
      const err = await res.json().catch(() => ({ error: 'Failed to send join request' }));
      throw new Error(err.error || 'Failed to send join request');
    }

    const data = await res.json();
    this._sessionId = data.sessionId;
    this._connectWs();
    this._emit('knock:sent', { sessionId: data.sessionId });
    return data;
  }

  /**
   * Invite a specific user to join YOUR workspace.  Auto-creates a
   * session for the current user if not already hosting.
   *
   * @param {{ targetUserId: string, hostId: string, hostName: string, hostAvatar?: string, slug: string }} opts
   */
  async inviteUser({ targetUserId, hostId, hostName, hostAvatar = '', slug }) {
    const res = await fetch(`${COLLAB_URL}/session/invite-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostId, hostName, hostAvatar, targetUserId, slug }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Failed to send invite' }));
      throw new Error(err.error || 'Failed to send invite');
    }

    const data = await res.json();
    // Auto-adopt hosting role if not already hosting
    if (!this.isHost) {
      this._role = 'hosting';
      this._sessionId = data.sessionId;
      this._userId = hostId;
      this._sessionSlug = slug;
      this._permissions = { ...HOST_PERMISSIONS };
      this._session = { id: data.sessionId, inviteLink: data.inviteLink, inviteToken: data.inviteToken };
      this._pendingKnocks = [];
      this._connectWs();
      this._emit('session:created', data);
    }
    return data;
  }

  /**
   * Handle the server auto-creating a session for us (someone asked to
   * join our workspace and we didn't have an active session).
   * Called when the notification WS or session WS receives
   * 'auto-session-created'.
   */
  _handleAutoSessionCreated({ sessionId, inviteToken, slug }) {
    if (this.isHost || this.isGuest) return; // Already in a session
    this._role = 'hosting';
    this._sessionId = sessionId;
    this._sessionSlug = slug;
    this._permissions = { ...HOST_PERMISSIONS };
    this._session = { id: sessionId, inviteToken };
    this._pendingKnocks = [];
    this._connectWs();
    this._emit('session:created', { sessionId, inviteToken });
  }

  // ── WebSocket for real-time events ────────────────────────────────────────

  _connectWs() {
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
    }

    const wsUrl = COLLAB_URL.replace(/^http/, 'ws');
    const url = `${wsUrl}/session-events?sessionId=${this._sessionId}&userId=${this._userId}`;

    this._ws = new WebSocket(url);

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleWsMessage(msg);
      } catch (_) {}
    };

    this._ws.onclose = () => {
      // Reconnect if still active
      if (this.isActive || this._role === 'knocking') {
        setTimeout(() => this._connectWs(), 2000);
      }
    };

    this._ws.onerror = () => {};
  }

  _handleWsMessage(msg) {
    switch (msg.type) {
      case 'knock':
        // Host receives knock notification
        this._pendingKnocks.push({
          guestId: msg.guestId,
          displayName: msg.displayName,
          avatarUrl: msg.avatarUrl || '',
        });
        this._emit('knock:received', msg);
        break;

      case 'guest:joined':
        this._emit('guest:joined', msg.guest);
        // If we were knocking and our id matches, we're now a guest
        if (this._role === 'knocking' && msg.guest?.guestId === this._userId) {
          this._role = 'guest';
          this._permissions = { ...msg.guest.permissions };
          // Store host info for direct repo access
          this._hostId = msg.hostId || null;
          this._sessionSlug = msg.slug || null;
          // Pre-populate _session so UI can render host info immediately
          // (before the async refreshSession() fetch completes)
          this._session = {
            ...this._session,
            id: this._sessionId,
            hostId: msg.hostId || null,
            hostName: msg.hostName || null,
            slug: msg.slug || null,
          };
          this._emit('session:joined', { ...msg.guest, hostId: this._hostId, slug: this._sessionSlug });
        }
        break;

      case 'guest:removed':
        // If we are the kicked guest
        if (msg.guestId === this._userId) {
          const reason = msg.reason || 'kicked';
          this._cleanup();
          this._emit('session:kicked', { reason });
        } else {
          this._emit('guest:removed', msg);
        }
        break;

      case 'guest:left':
        // A guest voluntarily left — notify the host so the guest list updates
        this._emit('guest:left', msg);
        break;

      case 'permissions:updated':
        // If it's our permissions that changed
        if (msg.guestId === this._userId) {
          this._permissions = { ...msg.permissions };
          this._emit('permissions:changed', msg.permissions);
        }
        this._emit('permissions:updated', msg);
        break;

      case 'session:terminated':
        if (!this.isHost) {
          this._cleanup();
          this._emit('session:terminated', {});
        }
        break;

      case 'knock:denied':
        if (msg.guestId === this._userId) {
          this._cleanup();
          this._emit('knock:denied', {});
        }
        break;

      case 'knock:cancelled':
        // Guest disconnected while knocking — remove from host's pending list
        if (this.isHost && msg.guestId) {
          this._pendingKnocks = this._pendingKnocks.filter(k => k.guestId !== msg.guestId);
          this._emit('knock:cancelled', msg);
        }
        break;

      case 'permission:denied':
        // Action was denied by the backend
        this._emit('action:denied', msg);
        break;

      default:
        break;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _cleanup() {
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }
    this._role = 'idle';
    this._session = null;
    this._sessionId = null;
    this._hostId = null;
    this._sessionSlug = null;
    this._permissions = { ...HOST_PERMISSIONS };
    this._pendingKnocks = [];
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
    // Also fire a generic 'change' event for React hooks
    this.dispatchEvent(new CustomEvent('change', { detail: { type, ...detail } }));
  }

  /**
   * Subscribe to all session changes. Returns an unsubscribe function.
   */
  onChange(callback) {
    const handler = (e) => callback(e.detail);
    this.addEventListener('change', handler);
    return () => this.removeEventListener('change', handler);
  }

  /**
   * Subscribe to a specific event. Returns an unsubscribe function.
   */
  on(eventType, callback) {
    const handler = (e) => callback(e.detail);
    this.addEventListener(eventType, handler);
    return () => this.removeEventListener(eventType, handler);
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────
const collabSessionService = new CollabSessionService();
export default collabSessionService;
