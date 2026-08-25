'use strict';

// Covers the lookup that backs GET /session/workspace-access/:userId?slug=
// (server.js) — the fix that lets a collab guest get real, permission-scoped
// workspace access without a Prisma WorkspaceMembership row. See
// synthi/src/lib/collabGuestAccess.js for the caller and
// synthi/src/lib/workspaceAccess.js for how the result gates file routes.
//
// The HTTP handler itself is a thin wrapper (internal-token check, already
// covered by collabGatewayAuth.test.js's hasTrustedInternalToken coverage +
// existing origin-check usage in server.js) around
// SessionManager.getSessionsForSlug(), which is what's exercised here.
//
// SessionManager only exports a process-wide singleton (no class), so every
// test below uses its own unique slug/hostId/guestId to avoid cross-test
// state collisions ("one active session per host" is enforced globally).

const test = require('node:test');
const assert = require('node:assert/strict');
const sessionManager = require('../SessionManager');

/**
 * Mirrors the matching loop in the 'workspace-access' case handler
 * (server.js) so the test exercises the exact same lookup semantics
 * without booting the real HTTP server.
 */
function resolveWorkspaceAccess(slug, userId) {
  for (const session of sessionManager.getSessionsForSlug(slug)) {
    if (session.hostId === userId) {
      return { role: 'host', permissions: { canEdit: true, canFileOps: true, canTerminal: true, canGit: true } };
    }
    const guest = (session.guests || []).find((g) => g.guestId === userId);
    if (guest) {
      return { role: 'guest', permissions: { ...guest.permissions } };
    }
  }
  return null;
}

test('workspace-access: recognizes the session host', () => {
  sessionManager.createSession({ hostId: 'wa-host-1', hostName: 'Host', slug: 'wa-workspace-1' });

  const access = resolveWorkspaceAccess('wa-workspace-1', 'wa-host-1');
  assert.deepEqual(access, {
    role: 'host',
    permissions: { canEdit: true, canFileOps: true, canTerminal: true, canGit: true },
  });
});

test('workspace-access: recognizes an admitted guest with their actual permissions', () => {
  const session = sessionManager.createSession({
    hostId: 'wa-host-2',
    hostName: 'Host',
    slug: 'wa-workspace-2',
    defaultPerms: { canEdit: true, canFileOps: false, canTerminal: false, canGit: false },
  });
  sessionManager.admitGuest(session.id, { guestId: 'wa-guest-2', socketId: 'wa-s2', displayName: 'Guest' });

  const access = resolveWorkspaceAccess('wa-workspace-2', 'wa-guest-2');
  assert.equal(access.role, 'guest');
  assert.equal(access.permissions.canEdit, true);
  assert.equal(access.permissions.canFileOps, false);
});

test('workspace-access: reflects live permission updates (host toggles canFileOps on)', () => {
  const session = sessionManager.createSession({
    hostId: 'wa-host-3',
    hostName: 'Host',
    slug: 'wa-workspace-3',
    defaultPerms: { canEdit: true, canFileOps: false, canTerminal: false, canGit: false },
  });
  sessionManager.admitGuest(session.id, { guestId: 'wa-guest-3', socketId: 'wa-s3', displayName: 'Guest' });
  sessionManager.updatePermissions(session.id, 'wa-guest-3', { canFileOps: true });

  const access = resolveWorkspaceAccess('wa-workspace-3', 'wa-guest-3');
  assert.equal(access.permissions.canFileOps, true);
});

test('workspace-access: a stranger (never knocked/admitted) has no access', () => {
  sessionManager.createSession({ hostId: 'wa-host-4', hostName: 'Host', slug: 'wa-workspace-4' });

  assert.equal(resolveWorkspaceAccess('wa-workspace-4', 'wa-nobody-4'), null);
});

test('workspace-access: a kicked guest immediately loses access', () => {
  const session = sessionManager.createSession({ hostId: 'wa-host-5', hostName: 'Host', slug: 'wa-workspace-5' });
  sessionManager.admitGuest(session.id, { guestId: 'wa-guest-5', socketId: 'wa-s5', displayName: 'Guest' });
  assert.notEqual(resolveWorkspaceAccess('wa-workspace-5', 'wa-guest-5'), null);

  sessionManager.removeGuest(session.id, 'wa-guest-5', 'kicked');
  assert.equal(resolveWorkspaceAccess('wa-workspace-5', 'wa-guest-5'), null);
});

test('workspace-access: a terminated session grants no access to host or guests', () => {
  const session = sessionManager.createSession({ hostId: 'wa-host-6', hostName: 'Host', slug: 'wa-workspace-6' });
  sessionManager.admitGuest(session.id, { guestId: 'wa-guest-6', socketId: 'wa-s6', displayName: 'Guest' });
  sessionManager.terminateSession(session.id);

  assert.equal(resolveWorkspaceAccess('wa-workspace-6', 'wa-host-6'), null);
  assert.equal(resolveWorkspaceAccess('wa-workspace-6', 'wa-guest-6'), null);
});

test('workspace-access: a user in one workspace has no access to a different slug', () => {
  const session = sessionManager.createSession({ hostId: 'wa-host-7', hostName: 'Host', slug: 'wa-workspace-7a' });
  sessionManager.admitGuest(session.id, { guestId: 'wa-guest-7', socketId: 'wa-s7', displayName: 'Guest' });

  assert.equal(resolveWorkspaceAccess('wa-workspace-7b', 'wa-guest-7'), null);
  assert.equal(resolveWorkspaceAccess('wa-workspace-7b', 'wa-host-7'), null);
});
