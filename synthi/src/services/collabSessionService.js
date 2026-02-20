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
  canEdit: true,
  canTerminal: false,
  canGit: false,
  canFileOps: true,
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

    /**
     * Pending session created on-demand by the server when a guest
     * requested to join before the host started sharing. The host
     * must explicitly accept the first knock before the session activates.
     * @type {{ sessionId: string, inviteToken: string, slug: string }|null}
     */
    this._pendingSession = null;

    /** @type {object|null} Most recent incoming collab-invite (persists across modal open/close) */
    this._pendingInvite = null;

    /** @type {'disconnected'|'connecting'|'connected'} WS connection status */
    this._wsStatus = 'disconnected';
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
  get wsStatus() { return this._wsStatus; }
  get pendingKnocks() { return [...this._pendingKnocks]; }
  get pendingSession() { return this._pendingSession; }

  /** Most recent pending invite — survives UI mount/unmount cycles */
  get pendingInvite() { return this._pendingInvite; }
  clearPendingInvite() {
    this._pendingInvite = null;
    this._emit('invite:cleared', {});
  }

  /**
   * Request the UI to open the collaboration popup.
   * Consumed by CollabToolbar to toggle the ShareModal.
   */
  requestOpenPopup() {
    this._emit('popup:requestOpen', {});
  }

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
    this._session = {
      id: data.sessionId,
      inviteLink: data.inviteLink,
      inviteToken: data.inviteToken,
      roomCode: data.roomCode || null,
      createdAt: data.createdAt || new Date().toISOString(),
    };
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
   * If a pending session exists (auto-created by the server), it is
   * activated first so the host adopts the hosting role.
   */
  async admitGuest(guestId, { displayName, avatarUrl = '', socketId = '', permsOverride = {} }) {
    // Activate pending session on first admit
    if (this._pendingSession && !this.isHost) {
      this.acceptPendingSession();
    }
    if (!this.isHost) throw new Error('Only the host can admit guests');

    const res = await fetch(`${COLLAB_URL}/session/admit/${this._sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, displayName, avatarUrl, socketId, permsOverride, requesterId: this._userId }),
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
   * If the session is still pending and all knocks are denied, the
   * pending session is discarded (the server session will time out).
   */
  async denyKnock(guestId) {
    // For pending sessions, we need to activate briefly to issue the deny
    const wasPending = !this.isHost && !!this._pendingSession;
    if (wasPending) {
      this.acceptPendingSession();
    }
    if (!this.isHost) throw new Error('Only the host can deny guests');

    await fetch(`${COLLAB_URL}/session/deny/${this._sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, requesterId: this._userId }),
    });

    this._pendingKnocks = this._pendingKnocks.filter(k => k.guestId !== guestId);
    this._emit('knock:resolved', { guestId });

    // If we activated a pending session just to deny and there are no more
    // knocks, terminate the session and go back to idle.
    if (wasPending && this._pendingKnocks.length === 0) {
      try { await this.terminateSession(); } catch (_) {}
    }
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
   * Guest requests a specific permission from the host.
   * @param {string} permKey - e.g. 'canGit', 'canTerminal'
   */
  requestPermission(permKey) {
    if (this._role !== 'guest') return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify({
        type: 'permission:request',
        permKey,
        displayName: this._displayName || 'Guest',
      }));
      this._emit('permission:request-sent', { permKey });
    } catch (_) {}
  }

  /**
   * Host denies a permission request from a guest.
   * @param {string} guestId
   * @param {string} permKey
   */
  denyPermissionRequest(guestId, permKey) {
    if (!this.isHost) return;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify({
        type: 'permission:request-deny',
        guestId,
        permKey,
      }));
    } catch (_) {}
  }

  /**
   * Host kicks a guest.
   */
  async kickGuest(guestId) {
    if (!this.isHost) throw new Error('Only the host can kick guests');

    await fetch(`${COLLAB_URL}/session/kick/${this._sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guestId, requesterId: this._userId }),
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
      if (data.roomCode) this._session.roomCode = data.roomCode;
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
    const userId = this._userId || (typeof window !== 'undefined' ? localStorage.getItem('synthi-user-id') : null);
    let url = `${COLLAB_URL}/workspace-presence/${encodeURIComponent(slug)}`;
    if (userId) url += `?userId=${encodeURIComponent(userId)}`;
    const res = await fetch(url);
    if (!res.ok) return { activeUsers: [], sessions: [] };
    return res.json();
  }

  // ── User Blocking ──────────────────────────────────────────────────────

  /**
   * Block a user. Blocked users are hidden from presence and cannot
   * invite/join you.
   */
  async blockUser(blockedUserId) {
    const userId = this._userId || (typeof window !== 'undefined' ? localStorage.getItem('synthi-user-id') : null);
    if (!userId) throw new Error('No userId available');
    const res = await fetch(`${COLLAB_URL}/user/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, blockedUserId }),
    });
    if (!res.ok) throw new Error('Failed to block user');
    this._emit('block:changed', { userId, blockedUserId, action: 'block' });
    return res.json();
  }

  /**
   * Unblock a user.
   */
  async unblockUser(blockedUserId) {
    const userId = this._userId || (typeof window !== 'undefined' ? localStorage.getItem('synthi-user-id') : null);
    if (!userId) throw new Error('No userId available');
    const res = await fetch(`${COLLAB_URL}/user/unblock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, blockedUserId }),
    });
    if (!res.ok) throw new Error('Failed to unblock user');
    this._emit('block:changed', { userId, blockedUserId, action: 'unblock' });
    return res.json();
  }

  /**
   * Get the list of blocked user IDs for the current user.
   */
  async getBlockedList() {
    const userId = this._userId || (typeof window !== 'undefined' ? localStorage.getItem('synthi-user-id') : null);
    if (!userId) return [];
    const res = await fetch(`${COLLAB_URL}/user/blocked-list?userId=${encodeURIComponent(userId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.blockedUsers || [];
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

    const data = await res.json();

    // If auto-admitted (invited user), transition directly to guest
    if (data.autoAdmitted && data.guest) {
      this._role = 'guest';
      this._permissions = { ...data.guest.permissions };
      this._hostId = data.hostId || null;
      this._sessionSlug = data.slug || null;
      this._session = {
        ...this._session,
        id: sessionId,
        hostId: data.hostId || null,
        hostName: data.hostName || null,
        slug: data.slug || null,
      };
      this._connectWs();
      this._emit('session:joined', { ...data.guest, hostId: this._hostId, slug: this._sessionSlug });
      return;
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

    // If auto-admitted (invited user), transition directly to guest
    if (data.autoAdmitted && data.guest) {
      this._role = 'guest';
      this._permissions = { ...data.guest.permissions };
      this._hostId = data.hostId || null;
      this._sessionSlug = data.slug || null;
      this._session = {
        ...this._session,
        id: data.sessionId,
        hostId: data.hostId || null,
        hostName: data.hostName || null,
        slug: data.slug || null,
      };
      this._connectWs();
      this._emit('session:joined', { ...data.guest, hostId: this._hostId, slug: this._sessionSlug });
      return data;
    }

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
      this._session = {
        id: data.sessionId,
        inviteLink: data.inviteLink,
        inviteToken: data.inviteToken,
        roomCode: data.roomCode || null,
      };
      this._pendingKnocks = [];
      this._connectWs();
      this._emit('session:created', data);
    }
    return data;
  }

  /**
   * Join a session using a short room code.
   *
   * @param {{ code: string, guestId: string, displayName: string, avatarUrl?: string }} opts
   */
  async joinByCode({ code, guestId, displayName, avatarUrl = '' }) {
    this._role = 'knocking';
    this._userId = guestId;

    const res = await fetch(`${COLLAB_URL}/session/join-by-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, guestId, displayName, avatarUrl }),
    });

    if (!res.ok) {
      this._role = 'idle';
      const err = await res.json().catch(() => ({}));
      const msg = err.error || 'Invalid room code';
      // Map server errors to user-friendly messages
      const friendly = msg.includes('not found') ? 'No session found with that code. It may have expired.'
        : msg.includes('blocked') ? 'You are blocked from joining this session.'
        : msg.includes('already') ? 'You are already in this session.'
        : msg;
      throw new Error(friendly);
    }

    const data = await res.json();
    this._sessionId = data.sessionId;

    // If the server auto-admitted us (invited user), transition directly to guest
    if (data.autoAdmitted && data.guest) {
      this._role = 'guest';
      this._permissions = { ...data.guest.permissions };
      this._hostId = data.hostId || null;
      this._sessionSlug = data.slug || null;
      this._session = {
        ...this._session,
        id: data.sessionId,
        hostId: data.hostId || null,
        hostName: data.hostName || null,
        slug: data.slug || null,
      };
      this._connectWs();
      this._emit('session:joined', { ...data.guest, hostId: this._hostId, slug: this._sessionSlug });
      return data;
    }

    this._connectWs();
    this._emit('knock:sent', { sessionId: data.sessionId });
    return data;
  }

  /**
   * Handle the server auto-creating a session for us (someone asked to
   * join our workspace and we didn't have an active session).
   *
   * Instead of immediately adopting the hosting role, we store the
   * session as "pending" so the host can decide whether to start sharing.
   * The host UI will show the incoming knock — upon acceptance the session
   * is activated via `acceptPendingSession()`.
   */
  _handleAutoSessionCreated({ sessionId, inviteToken, slug }) {
    if (this.isHost || this.isGuest) return; // Already in a session
    this._pendingSession = { sessionId, inviteToken, slug };
    this._emit('session:requested', { sessionId, slug });
  }

  /**
   * Activate a pending session that was auto-created for us.
   * Called when the host accepts the first incoming knock.
   */
  acceptPendingSession() {
    if (!this._pendingSession) return;
    const { sessionId, inviteToken, slug } = this._pendingSession;
    this._role = 'hosting';
    this._sessionId = sessionId;
    this._sessionSlug = slug;
    this._permissions = { ...HOST_PERMISSIONS };
    this._session = { id: sessionId, inviteToken };
    this._pendingSession = null;
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

    this._wsStatus = 'connecting';
    this._emit('ws:status', { status: 'connecting' });
    this._ws = new WebSocket(url);

    this._ws.onopen = () => {
      // Reset backoff on successful connection
      this._reconnectDelay = 300;
      this._wsStatus = 'connected';
      this._emit('ws:status', { status: 'connected' });
      // Send identity message so server can re-associate this socket
      try {
        this._ws.send(JSON.stringify({
          type: 'identify',
          userId: this._userId,
          sessionId: this._sessionId,
          role: this._role,
        }));
      } catch (_) {}
    };

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleWsMessage(msg);
      } catch (err) { console.warn('[CollabSession] WS parse:', err?.message); }
    };

    this._ws.onclose = () => {
      this._wsStatus = 'disconnected';
      this._emit('ws:status', { status: 'disconnected' });
      // Reconnect with exponential backoff if still active
      if (this.isActive || this._role === 'knocking') {
        const delay = this._reconnectDelay || 300;
        this._reconnectDelay = Math.min(delay * 1.5, 10000); // cap at 10s
        console.warn(`[CollabSession] WS closed, reconnecting in ${delay}ms`);
        setTimeout(() => this._connectWs(), delay);
      }
    };

    this._ws.onerror = (e) => console.warn('[CollabSession] WS error:', e?.message || 'connection error');
  }

  _handleWsMessage(msg) {
    switch (msg.type) {
      case 'knock':
        // Process knock events if we are the host OR if we have a pending
        // session that was auto-created for us (waiting for host acceptance).
        {
          const isPendingHost = this._pendingSession &&
            (!msg.sessionId || this._pendingSession.sessionId === msg.sessionId);
          if (this._role !== 'hosting' && !isPendingHost) {
            console.warn('[CollabSession] Ignoring knock event — not hosting (role=' + this._role + ')');
            break;
          }
          // Also ignore knock events for our own userId (self-knock)
          if (msg.guestId === this._userId) {
            console.warn('[CollabSession] Ignoring knock event — self-knock detected');
            break;
          }
          // Deduplicate: don't add if already in pending list
          if (this._pendingKnocks.some(k => k.guestId === msg.guestId)) {
            break;
          }
          this._pendingKnocks.push({
            guestId: msg.guestId,
            displayName: msg.displayName,
            avatarUrl: msg.avatarUrl || '',
          });
          this._emit('knock:received', msg);
        }
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

      case 'session-knock':
        // Fallback knock delivery via notification WS channel.
        // Only process if we are the host.
        if (this._role !== 'hosting') break;
        if (msg.guestId === this._userId) break;
        if (this._pendingKnocks.some(k => k.guestId === msg.guestId)) break;
        this._pendingKnocks.push({
          guestId: msg.guestId,
          displayName: msg.displayName,
          avatarUrl: msg.avatarUrl || '',
        });
        this._emit('knock:received', msg);
        break;

      case 'permission:denied':
        // Action was denied by the backend
        this._emit('action:denied', msg);
        break;

      case 'permission:requested':
        // Host receives a permission request from a guest
        if (this._role === 'hosting') {
          this._emit('permission:requested', msg);
        }
        break;

      case 'permission:request-denied':
        // Guest's permission request was denied by the host
        this._emit('permission:request-denied', msg);
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
    this._pendingSession = null;
    this._pendingInvite = null;
    this._reconnectDelay = 1000;
  }

  _emit(type, detail) {
    // Persist collab-invite so it survives UI unmount/remount cycles
    if (type === 'collab-invite') {
      this._pendingInvite = detail;
    }
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
