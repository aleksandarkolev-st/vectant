/**
 * Permission Middleware — Access Control Layer for the Collab Server
 *
 * Provides two types of middleware:
 *
 * 1. **HTTP middleware** (`requirePermission(perm)`) — wraps Express-style
 *    `(req, res, next)` handlers. Reads `req.sessionId` and `req.userId`
 *    (set by an auth layer upstream) and checks against SessionManager.
 *
 * 2. **WebSocket guard** (`wsRequirePermission(socket, perm)`) — returns
 *    a boolean for inline checks inside WS message handlers.
 *
 * Both return 403-style errors when the user lacks the required permission.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Usage (HTTP):
 *
 *   const { requirePermission, extractSessionContext } = require('./permissionMiddleware');
 *
 *   // Apply context extractor first (reads session/user from headers or query)
 *   router.use(extractSessionContext);
 *
 *   // Protect a route
 *   router.post('/git/:slug/commit', requirePermission('canGit'), handleCommit);
 *
 * Usage (WebSocket):
 *
 *   const { wsRequirePermission, wsDenyAction } = require('./permissionMiddleware');
 *
 *   ws.on('message', (msg) => {
 *     if (msg.type === 'terminal:input') {
 *       if (!wsRequirePermission(ws, 'canTerminal')) {
 *         return wsDenyAction(ws, 'terminal:input', 'canTerminal');
 *       }
 *       // … process terminal input
 *     }
 *   });
 * ──────────────────────────────────────────────────────────────────────
 */

const sessionManager = require('./SessionManager');

// Accept hex session IDs of reasonable length (SessionManager emits 24 chars
// = SESSION_ID_LEN * 2 hex, but future changes shouldn't break this regex).
const SESSION_ID_RE = /^[a-f0-9]{8,64}$/i;
// User IDs are caller-supplied but must be safely short + printable.
const USER_ID_RE = /^[A-Za-z0-9._:@\-]{1,128}$/;

function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}
function isValidUserId(id) {
  return typeof id === 'string' && USER_ID_RE.test(id);
}

// ── HTTP Middleware ──────────────────────────────────────────────────────────

/**
 * Extract session context from incoming HTTP requests.
 *
 * Looks for:
 *   - Header `x-session-id`  (or query param `sessionId`)
 *   - Header `x-user-id`     (or query param `userId`)
 *
 * Attaches `req.collabSession` and `req.collabUserId` for downstream use.
 * If no session headers are present, the request is treated as a
 * "solo user" (no collaboration active) and all permissions are granted.
 */
function extractSessionContext(req, _res, next) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  let sessionId = req.headers['x-session-id'] || url.searchParams.get('sessionId') || null;
  let userId    = req.headers['x-user-id']    || url.searchParams.get('userId')    || null;

  // Reject malformed values so downstream code never sees untrusted input.
  if (sessionId && !isValidSessionId(sessionId)) sessionId = null;
  if (userId && !isValidUserId(userId)) userId = null;

  req.collabSessionId = sessionId;
  req.collabUserId    = userId;

  // Pre-resolve role + permissions for convenience
  if (sessionId && userId) {
    const session = sessionManager.getSession(sessionId);
    if (session) {
      req.collabSession = session;
      req.collabRole = session.hostId === userId ? 'host' : 'guest';

      if (req.collabRole === 'host') {
        req.collabPermissions = { canEdit: true, canTerminal: true, canGit: true, canFileOps: true };
      } else {
        // getSession() returns the serialized form where guests is an Array.
        // Accept the in-memory Map shape too, but treat anything else as a
        // serialization invariant violation — silently coercing to [] would
        // mask the bug and look like a legitimate permission denial.
        let guestsArr;
        if (Array.isArray(session.guests)) {
          guestsArr = session.guests;
        } else if (session.guests instanceof Map) {
          guestsArr = Array.from(session.guests.values());
        } else {
          throw new Error(
            `extractSessionContext: session ${sessionId} has guests in unexpected shape (${typeof session.guests}); ` +
            `expected Array or Map.`
          );
        }
        const guest = guestsArr.find(g => g && g.guestId === userId);
        req.collabPermissions = guest ? { ...guest.permissions } : null;
      }
    }
  }

  next();
}

/**
 * Express-style middleware factory.
 *
 * @param {keyof import('./SessionManager').GuestPermissions} perm
 *   The permission key to check (e.g. `'canGit'`, `'canTerminal'`).
 *
 * @returns {(req, res, next) => void}
 *
 * When no collaboration session is active (solo user), the middleware
 * passes through — the user has full control of their own worktree.
 */
function requirePermission(perm) {
  return (req, res, next) => {
    // No active collaboration session → solo mode → allow everything
    if (!req.collabSessionId) {
      return next();
    }

    // Session context not resolved (possibly invalid session id)
    if (!req.collabPermissions) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'permission_denied',
        message: 'You are not a member of this collaboration session.',
        required: perm,
      }));
    }

    // Host always passes
    if (req.collabRole === 'host') {
      return next();
    }

    // Check the specific permission
    if (!req.collabPermissions[perm]) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'permission_denied',
        message: `This action requires the "${perm}" permission. Ask the Host for access.`,
        required: perm,
        granted: req.collabPermissions,
      }));
    }

    next();
  };
}

/**
 * Convenience: require that the caller IS the host of the session.
 */
function requireHost() {
  return (req, res, next) => {
    if (!req.collabSessionId) return next(); // solo mode
    if (req.collabRole !== 'host') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'host_only',
        message: 'Only the session Host can perform this action.',
      }));
    }
    next();
  };
}

// ── WebSocket Guards ────────────────────────────────────────────────────────

/**
 * Check a WebSocket connection's permission for a specific action.
 *
 * @param {WebSocket & { _sessionId?: string, _userId?: string }} ws
 * @param {keyof import('./SessionManager').GuestPermissions} perm
 * @returns {boolean}
 */
function wsRequirePermission(ws, perm) {
  // No session → solo mode → always allowed
  if (!ws._sessionId) return true;

  return sessionManager.checkPermission(ws._sessionId, ws._userId, perm);
}

/**
 * Send a structured denial message over a WebSocket.
 *
 * @param {WebSocket} ws
 * @param {string} action — The action that was denied (for client display)
 * @param {string} perm   — The permission that was missing
 */
function wsDenyAction(ws, action, perm) {
  try {
    ws.send(JSON.stringify({
      type: 'permission:denied',
      action,
      required: perm,
      message: `Action "${action}" requires "${perm}" permission. Ask the Host for access.`,
    }));
  } catch (_) {
    // Socket may already be closed — swallow
  }
}

/**
 * Attach session context to a WebSocket connection.
 * Call this during the WS `connection` event after parsing query params.
 *
 * @param {WebSocket} ws
 * @param {string|null} sessionId
 * @param {string|null} userId
 */
function wsAttachContext(ws, sessionId, userId) {
  // Only trust values that pass format validation — otherwise ignore so that
  // a malformed query param can't be used to forge session context.
  ws._sessionId = sessionId && isValidSessionId(sessionId) ? sessionId : null;
  ws._userId    = userId    && isValidUserId(userId)    ? userId    : null;
}

// ── Route-level permission mapping ──────────────────────────────────────────

/**
 * Map of git actions → required permission.
 * Actions not listed here are either read-only (always allowed) or
 * require host-only access.
 */
const GIT_ACTION_PERMISSIONS = Object.freeze({
  // Write operations → canGit
  commit:          'canGit',
  stage:           'canGit',
  'stage-all':     'canGit',
  'stage-lines':   'canGit',
  unstage:         'canGit',
  'unstage-all':   'canGit',
  push:            'canGit',
  pull:            'canGit',
  checkout:        'canGit',
  'discard':       'canGit',
  'discard-all':   'canGit',
  'stash-push':    'canGit',
  'stash-pop':     'canGit',
  'stash-apply':   'canGit',
  'stash-drop':    'canGit',
  'add-remote':    'canGit',
  'remove-remote': 'canGit',
  'set-remote-url':'canGit',
  'cherry-pick':   'canGit',
  'revert':        'canGit',
  'resolve-ours':  'canGit',
  'resolve-theirs':'canGit',
  'mark-resolved': 'canGit',
  'abort-merge':   'canGit',

  // File mutations → canFileOps
  'write-file':        'canFileOps',
  'write-files-batch': 'canFileOps',
  'create-directory':  'canFileOps',
  'delete-item':       'canFileOps',
  'rename-item':       'canFileOps',
  'sync':              'canFileOps',

  // Read-only — no permission required (always allowed)
  // status, branches, log, diff, file, files, files-meta, etc.
});

/**
 * Express middleware that checks git action permissions automatically.
 * Place after `extractSessionContext` and before the git handler switch.
 *
 * @param {string} action — The git action from the URL (e.g. 'commit')
 * @returns {(req, res, next) => void}
 */
function requireGitActionPermission(action) {
  const perm = GIT_ACTION_PERMISSIONS[action];
  if (!perm) {
    // No permission mapped → read-only action → allow
    return (_req, _res, next) => next();
  }
  return requirePermission(perm);
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  extractSessionContext,
  requirePermission,
  requireHost,
  requireGitActionPermission,
  wsRequirePermission,
  wsDenyAction,
  wsAttachContext,
  isValidSessionId,
  isValidUserId,
  GIT_ACTION_PERMISSIONS,
};
