"use client";

import React, { useState, useCallback, useEffect } from 'react';
import { useWorkspacePresence } from '@/hooks/useWorkspacePresence';
import { useCollabSession } from '@/hooks/useCollabSession';
import { useBlockedUsers } from '@/hooks/useBlockedUsers';
import collabClient from '@/services/collabClient';
import collabSessionService from '@/services/collabSessionService';
import { getCurrentUser } from '@/services/userIdentity';
import getInitials from '@/utils/getInitials';
import { useConfirmDialog } from '@/components/ui/useConfirmDialog';
import {
  Users, FileEdit, Globe, Loader2, UserPlus, Shield,
  Send, Check, X, Bell, Ban, MoreHorizontal, Radio, Hash, Mail
} from 'lucide-react';

import T from './collabTheme';

/**
 * WorkspaceUsersPanel — Shows all active users in a workspace
 * and their collaboration sessions. Allows requesting to join sessions.
 *
 * @param {{ slug: string }} props
 */
export default function WorkspaceUsersPanel({ slug }) {
  const { activeUsers, sessions, loading, refresh } = useWorkspacePresence(slug);
  const {
    role, isHost, isGuest, isKnocking,
    requestJoinSession, joinUser, inviteUser,
    error, hostId,
  } = useCollabSession();
  const { blockUser, unblockUser, isBlocked } = useBlockedUsers();
  const [joiningSessionId, setJoiningSessionId] = useState(null);
  const [joiningUserId, setJoiningUserId] = useState(null);
  const [invitingUserId, setInvitingUserId] = useState(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitingEmail, setInvitingEmail] = useState(false);
  const [canManageMembers, setCanManageMembers] = useState(false);
  const [membershipRole, setMembershipRole] = useState(null);
  const [membershipStatus, setMembershipStatus] = useState('loading');
  const [membershipCapabilityError, setMembershipCapabilityError] = useState(null);
  const [membershipError, setMembershipError] = useState(null);
  const [membershipNotice, setMembershipNotice] = useState(null);
  // Seed from service in case an invite arrived while the modal was closed
  const [pendingInvite, setPendingInvite] = useState(() => collabSessionService.pendingInvite);
  const { confirm, confirmDialog } = useConfirmDialog();

  const myUserId = getCurrentUser().id;

  // ── Listen for incoming collab-invite notifications ───────────────────
  useEffect(() => {
    // Re-read from service on mount (may have arrived while unmounted)
    const stored = collabSessionService.pendingInvite;
    if (stored) setPendingInvite(stored);

    const unsub = collabSessionService.on('collab-invite', (detail) => {
      setPendingInvite(detail);
    });
    return unsub;
  }, []);

  // ── Workspace membership capabilities ────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    setCanManageMembers(false);
    setMembershipRole(null);
    setMembershipStatus('loading');
    setMembershipCapabilityError(null);
    setMembershipError(null);
    setMembershipNotice(null);
    if (!slug) return () => { cancelled = true; };

    fetch(`/api/workspace/${encodeURIComponent(slug)}/members`, { method: 'GET', cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body?.error || `Workspace access check failed (${res.status})`);
        }
        return body;
      })
      .then((body) => {
        if (cancelled) return;
        const currentRole = body?.currentMember?.role || 'member';
        setMembershipRole(currentRole);
        setCanManageMembers(['owner', 'admin'].includes(currentRole));
        setMembershipStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[Collab] membership capabilities:', err?.message);
        setMembershipCapabilityError(err?.message || 'Workspace access check failed');
        setMembershipStatus('error');
      });

    return () => { cancelled = true; };
  }, [slug]);

  // ── Request to join an existing session ────────────────────────────────

  const handleRequestJoin = useCallback(async (sessionId) => {
    if (isHost || isGuest || isKnocking) return;
    setJoiningSessionId(sessionId);
    try {
      await requestJoinSession(sessionId);
    } catch (err) { console.warn('[Collab] requestJoinSession:', err?.message); }
    setJoiningSessionId(null);
  }, [isHost, isGuest, isKnocking, requestJoinSession]);

  // ── Ask to join a solo user (direct collab) ───────────────────────────

  const handleJoinUser = useCallback(async (userId, userName) => {
    if (isHost || isGuest || isKnocking) return;
    setJoiningUserId(userId);
    try {
      await joinUser(userId, userName, slug);
    } catch (err) { console.warn('[Collab] joinUser:', err?.message); }
    setJoiningUserId(null);
  }, [isHost, isGuest, isKnocking, joinUser, slug]);

  // ── Invite a solo user (direct collab) ────────────────────────────────

  const addWorkspaceMember = useCallback(async (email) => {
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('Enter a valid email address.');
    }

    const membershipRes = await fetch(`/api/workspace/${encodeURIComponent(slug)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normalizedEmail }),
    });
    if (!membershipRes.ok) {
      const body = await membershipRes.json().catch(() => ({}));
      throw new Error(body?.error || 'Failed to add workspace member');
    }
    return membershipRes.json().catch(() => ({}));
  }, [slug]);

  const handleInviteEmail = useCallback(async (event) => {
    event.preventDefault();
    if (!canManageMembers || invitingEmail) return;
    const invitedEmail = inviteEmail.trim().toLowerCase();
    setInvitingEmail(true);
    setMembershipError(null);
    setMembershipNotice(null);
    try {
      await addWorkspaceMember(invitedEmail);
      setInviteEmail('');
      setMembershipNotice(`${invitedEmail} can now access this workspace.`);
    } catch (err) {
      console.warn('[Collab] inviteEmail:', err?.message);
      setMembershipError(err?.message || 'Failed to invite member');
    } finally {
      setInvitingEmail(false);
    }
  }, [addWorkspaceMember, canManageMembers, inviteEmail, invitingEmail]);

  const handleInviteUser = useCallback(async (user) => {
    if (isGuest || isKnocking || !canManageMembers) return;
    const userId = user?.id;
    const email = user?.email;
    if (!userId) return;
    setInvitingUserId(userId);
    setMembershipError(null);
    setMembershipNotice(null);
    try {
      if (!email) {
        throw new Error('This user cannot be invited yet because their email is unavailable.');
      }
      await addWorkspaceMember(email);
      await inviteUser(userId, slug);
      setMembershipNotice(`${email} can now access this workspace.`);
    } catch (err) {
      console.warn('[Collab] inviteUser:', err?.message);
      setMembershipError(err?.message || 'Failed to invite user');
    }
    setInvitingUserId(null);
  }, [addWorkspaceMember, canManageMembers, isGuest, isKnocking, inviteUser, slug]);

  // ── Accept incoming invite ────────────────────────────────────────────

  const handleAcceptInvite = useCallback(async () => {
    if (!pendingInvite?.sessionId) return;
    setPendingInvite(null);
    collabSessionService.clearPendingInvite();
    await requestJoinSession(pendingInvite.sessionId);
  }, [pendingInvite, requestJoinSession]);

  const handleDeclineInvite = useCallback(() => {
    setPendingInvite(null);
    collabSessionService.clearPendingInvite();
  }, []);

  // ── Block / Unblock ───────────────────────────────────────────────────

  const handleBlockUser = useCallback(async (userId, userName) => {
    // Prevent self-blocking
    if (userId === myUserId) return;
    const confirmed = await confirm({
      title: `Block ${userName || 'this user'}?`,
      message: 'They will disappear from your users list and cannot send collaboration requests.',
      confirmLabel: 'Block user',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await blockUser(userId);
      refresh(); // re-fetch presence so blocked user disappears
    } catch (err) { console.warn('[Collab] blockUser:', err?.message); }
  }, [blockUser, confirm, refresh, myUserId]);

  const handleUnblockUser = useCallback(async (userId) => {
    try {
      await unblockUser(userId);
      refresh();
    } catch (err) { console.warn('[Collab] unblockUser:', err?.message); }
  }, [unblockUser, refresh]);

  // ── Group users: those in sessions vs solo ────────────────────────────

  const sessionHostIds = new Set(sessions.map(s => s.hostId));
  const sessionGuestIds = new Set(sessions.flatMap(s => (s.guests || []).map(g => g.guestId)));
  const soloUsers = activeUsers.filter(u =>
    u.id !== myUserId && !sessionHostIds.has(u.id) && !sessionGuestIds.has(u.id)
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4 gap-2">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: T.teal }} />
        <span className="text-xs" style={{ color: T.textMuted }}>Loading…</span>
      </div>
    );
  }

  const isEmpty = activeUsers.length <= 1 && sessions.length === 0;
  const isIdle = role === 'idle';

  return (
    <div className="space-y-3">
      {/* ── Incoming invite banner ──────────────────────────────────── */}
      {pendingInvite && (
        <div className="vt-workflow-alert flex items-center gap-2 px-3 py-2" style={{ '--workflow-alert-color': 'var(--brand-stop-4)' }}>
          <Bell className="w-3.5 h-3.5 flex-shrink-0" style={{ color: T.blue }} />
          <div className="flex-1 min-w-0">
            <span className="text-[11px] font-medium" style={{ color: T.text }}>
              <span style={{ color: T.blue }}>{pendingInvite.hostName || 'Someone'}</span> invited you to collaborate
            </span>
          </div>
          <button onClick={handleAcceptInvite}
            className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-success)]" title="Accept" aria-label="Accept collaboration invite">
            <Check className="w-3.5 h-3.5" style={{ color: T.teal }} />
          </button>
          <button onClick={handleDeclineInvite}
            className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-danger)]" title="Decline" aria-label="Decline collaboration invite">
            <X className="w-3.5 h-3.5" style={{ color: T.red }} />
          </button>
        </div>
      )}

      {/* ── Guest connection banner ─────────────────────────────────── */}
      {isGuest && hostId && (
        <div className="vt-workflow-alert vt-workflow-alert--success flex items-center gap-2 px-3 py-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: T.teal }} />
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: T.teal }} />
          </span>
          <span className="text-[11px] font-medium" style={{ color: T.teal }}>
            Connected — sharing host&apos;s workspace
          </span>
        </div>
      )}

      {/* ── Knocking banner ─────────────────────────────────────────── */}
      {isKnocking && (
        <div className="vt-workflow-alert flex items-center gap-2 px-3 py-2">
          <Loader2 className="w-3 h-3 animate-spin" style={{ color: T.amber }} />
          <span className="text-[11px] font-medium" style={{ color: T.amber }}>
            Waiting for host to approve…
          </span>
        </div>
      )}

      {/* ── Workspace access / email invite ──────────────────────────── */}
      <div className="vt-workflow-card p-2">
        <div className="flex items-center justify-between gap-2">
          <SectionLabel icon={Mail} color={T.teal} label="Workspace access" />
          {membershipRole && (
            <span className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
              style={{ backgroundColor: 'color-mix(in srgb, var(--accent-secondary) 10%, transparent)', color: T.teal }}>
              {membershipRole}
            </span>
          )}
        </div>

        {membershipStatus === 'loading' && (
          <div className="mt-2 flex items-center gap-2 text-[11px]" style={{ color: T.textMuted }}>
            <Loader2 className="w-3 h-3 animate-spin" style={{ color: T.teal }} />
            Checking workspace access...
          </div>
        )}

        {membershipStatus === 'error' && (
          <div className="vt-workflow-alert vt-workflow-alert--danger mt-2 px-2 py-1.5 text-[11px] text-[var(--accent-danger)]">
            {membershipCapabilityError || 'Workspace access check failed'}
          </div>
        )}

        {membershipStatus === 'ready' && canManageMembers && (
          <form onSubmit={handleInviteEmail}>
            <div className="flex items-center gap-2 mt-2">
              <input
                value={inviteEmail}
                onChange={(event) => setInviteEmail(event.target.value)}
                type="email"
                inputMode="email"
                placeholder="teammate@company.com"
                className="th-input min-w-0 flex-1 rounded-[var(--radius-control)] border px-2.5 py-1.5 text-xs outline-none"
              />
              <button
                type="submit"
                disabled={invitingEmail || !inviteEmail.trim()}
                className="th-focus-ring th-btn-primary flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-50"
              >
                {invitingEmail
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <UserPlus className="w-3 h-3" />
                }
                Invite
              </button>
            </div>
          </form>
        )}

        {membershipStatus === 'ready' && !canManageMembers && (
          <div className="vt-workflow-alert mt-2 px-2 py-1.5 text-[11px] text-[var(--accent-warning)]">
            Only workspace owners and admins can invite members.
          </div>
        )}

        {membershipNotice && (
          <div className="vt-workflow-alert vt-workflow-alert--success mt-2 px-2 py-1.5 text-[11px] text-[var(--accent-secondary)]">
            {membershipNotice}
          </div>
        )}
      </div>

      {/* ── Active Sessions ─────────────────────────────────────────── */}
      {sessions.length > 0 && (
        <div>
          <SectionLabel icon={Radio} color={T.live} label="Live Sessions" />
          <div className="space-y-1.5 mt-1.5">
            {sessions.map(session => (
              <SessionCard
                key={session.id}
                session={session}
                myUserId={myUserId}
                isIdle={isIdle}
                isKnocking={isKnocking}
                joiningSessionId={joiningSessionId}
                onRequestJoin={handleRequestJoin}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Solo Users (not in a session) ───────────────────────────── */}
      {soloUsers.length > 0 && (
        <div>
          <SectionLabel icon={Users} color={T.textMuted} label="Online" count={soloUsers.length} />
          <div className="space-y-0.5 mt-1.5">
            {soloUsers.map(user => (
              <UserRow
                key={user.id}
                user={user}
                isIdle={isIdle}
                isHost={isHost}
                isKnocking={isKnocking}
                joiningUserId={joiningUserId}
                invitingUserId={invitingUserId}
                canManageMembers={canManageMembers}
                onJoinUser={handleJoinUser}
                onInviteUser={handleInviteUser}
                onBlockUser={handleBlockUser}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────── */}
      {isEmpty && (
        <div className="vt-empty-state py-6 text-center">
          <Globe className="w-6 h-6 mx-auto mb-2" style={{ color: T.textMuted }} />
          <p className="text-xs" style={{ color: T.textMuted }}>
            No other users online
          </p>
          <p className="text-[10px] mt-1" style={{ color: T.borderHi }}>
            Share your workspace to collaborate
          </p>
        </div>
      )}

      {/* ── Error ────────────────────────────────────────────────────── */}
      {(error || membershipError) && (
        <div className="vt-workflow-alert vt-workflow-alert--danger px-2 py-1.5 text-[11px] text-[var(--accent-danger)]">
          {error || membershipError}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

// ── Session Card ──────────────────────────────────────────────────────────────

/**
 * SessionCard — Displays a live collaboration session with host info,
 * guest list, and a "Request to Join" button for idle users.
 *
 * @param {{ session: object, myUserId: string, isIdle: boolean, isKnocking: boolean, joiningSessionId: string|null, onRequestJoin: (id: string) => void }} props
 */
function SessionCard({ session, myUserId, isIdle, isKnocking, joiningSessionId, onRequestJoin }) {
  const isMySession = session.hostId === myUserId;
  const guestCount = session.guestCount || session.guests?.length || 0;
  const isJoiningThis = joiningSessionId === session.id;

  return (
    <div className="vt-workflow-card overflow-hidden"
      style={{ borderColor: isMySession ? 'color-mix(in srgb, var(--accent-secondary) 28%, var(--border-subtle))' : undefined }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="relative">
          <UserAvatar name={session.hostName} avatar={session.hostAvatar} color={T.teal} size={28} />
          {/* LIVE dot */}
          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2"
            style={{ backgroundColor: T.live, borderColor: T.card }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold truncate" style={{ color: T.text }}>
              {session.hostName}{isMySession ? ' (You)' : ''}
            </span>
            <span className="vt-workflow-chip text-[9px]" style={{ '--chip-color': 'var(--accent-danger)' }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: T.live }} />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: T.live }} />
              </span>
              LIVE
            </span>
          </div>
          <span className="text-[10px] flex items-center gap-1" style={{ color: T.textMuted }}>
            <Users className="w-2.5 h-2.5" />
            {guestCount} guest{guestCount !== 1 ? 's' : ''}
            {session.roomCode && (
              <>
                <span style={{ color: T.borderHi }}>·</span>
                <Hash className="w-2.5 h-2.5" />
                <span className="font-mono tracking-wider">{session.roomCode}</span>
              </>
            )}
          </span>
        </div>
        {/* Join button */}
        {!isMySession && isIdle && !isKnocking && (
          <button
            onClick={() => onRequestJoin(session.id)}
            disabled={isJoiningThis}
            className="th-focus-ring th-btn-primary flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium disabled:opacity-50"
          >
            {isJoiningThis
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <UserPlus className="w-3 h-3" />
            }
            Ask to Join
          </button>
        )}
        {isMySession && (
          <span className="vt-workflow-chip text-[10px]" style={{ '--chip-color': 'var(--accent-secondary)' }}>
            <Shield className="w-2.5 h-2.5 inline mr-0.5" />
            Host
          </span>
        )}
      </div>

      {/* Guest list */}
      {session.guests && session.guests.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-t border-[var(--border-subtle)] px-3 py-1.5">
          {session.guests.map(g => (
            <span key={g.guestId} className="vt-state-pill text-[10px]">
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: T.teal }} />
              {g.displayName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── User Row ──────────────────────────────────────────────────────────────────

/**
 * UserRow — A single user entry with avatar, name, current file, and
 * hover-visible Join / Invite / Block action buttons.
 *
 * @param {{ user: object, isIdle: boolean, isHost: boolean, isKnocking: boolean, joiningUserId: string|null, invitingUserId: string|null, canManageMembers: boolean, onJoinUser: (id: string, name: string) => void, onInviteUser: (user: object) => void, onBlockUser: (id: string, name: string) => void }} props
 */
function UserRow({ user, isIdle, isHost, isKnocking, joiningUserId, invitingUserId, canManageMembers, onJoinUser, onInviteUser, onBlockUser }) {
  const isJoining = joiningUserId === user.id;
  const isInviting = invitingUserId === user.id;
  const canAct = (isIdle || isHost) && !isKnocking;
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="vt-command-item group relative flex items-center gap-2 px-2 py-1.5">
      <UserAvatar name={user.name} avatar={user.image} color={user.color} size={24} />
      <div className="flex-1 min-w-0">
        <span className="text-xs font-medium truncate block" style={{ color: T.text }}>
          {user.name}
        </span>
        {user.currentFile && (
          <span className="text-[10px] flex items-center gap-1 truncate" style={{ color: T.textMuted }}>
            <FileEdit className="w-2.5 h-2.5 flex-shrink-0" />
            {user.currentFile}
          </span>
        )}
      </div>
      {/* Action buttons — visible on hover or when loading */}
      {canAct && (
        <div className={`flex items-center gap-1 ${isJoining || isInviting ? '' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
          {/* Ask to Join — join the other user's workspace */}
          {isIdle && (
            <button
              onClick={() => onJoinUser(user.id, user.name)}
              disabled={isJoining}
              className="th-focus-ring th-btn-primary flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium disabled:opacity-50"
              title="Ask to join their workspace"
              aria-label={`Ask to join ${user.name}'s workspace`}
            >
              {isJoining
                ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                : <UserPlus className="w-2.5 h-2.5" />
              }
              Join
            </button>
          )}
          {/* Invite — invite to YOUR workspace */}
          {canManageMembers && (
            <button
              onClick={() => onInviteUser(user)}
              disabled={isInviting}
              className="th-focus-ring th-btn-active flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium disabled:opacity-50"
              title="Invite to your workspace"
              aria-label={`Invite ${user.name} to your workspace`}
            >
              {isInviting
                ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
                : <Send className="w-2.5 h-2.5" />
              }
              Invite
            </button>
          )}
          {/* More menu (block) */}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="vt-icon-button th-focus-ring h-6 min-w-6"
              title="More options"
              aria-haspopup="menu"
              aria-expanded={showMenu}
            >
              <MoreHorizontal className="w-3 h-3" style={{ color: T.textMuted }} />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-[50]" onClick={() => setShowMenu(false)} />
                <div className="vt-command-popover absolute right-0 top-full z-[51] mt-1 min-w-[140px] py-1"
                  role="menu"
                  onKeyDown={(e) => { if (e.key === 'Escape') setShowMenu(false); }}
                >
                  <button
                    onClick={() => { onBlockUser(user.id, user.name); setShowMenu(false); }}
                    className="vt-command-item flex w-full items-center gap-2 px-3 py-1.5 text-[11px] font-medium text-[var(--accent-danger)]"
                  >
                    <Ban className="w-3 h-3" />
                    Block {user.name}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {!canAct && (
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: T.teal }} />
      )}
    </div>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────

/**
 * SectionLabel — Small uppercase label with icon, used to separate
 * sections in the users list (e.g. "Active Sessions", "Online Users").
 *
 * @param {{ icon: React.ElementType, color: string, label: string, count?: number }} props
 */
function SectionLabel({ icon: Icon, color, label, count }) {
  return (
    <div className="flex items-center gap-1.5 px-1">
      <Icon className="w-3 h-3" style={{ color }} />
      <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
        {label}
      </span>
      {count != null && (
        <span className="text-[10px]" style={{ color: T.textMuted }}>({count})</span>
      )}
    </div>
  );
}

/**
 * UserAvatar — Circular avatar showing a user image or initials fallback.
 *
 * @param {{ name: string, avatar?: string, color?: string, size?: number }} props
 */
function UserAvatar({ name, avatar, color, size = 24 }) {
  const initials = getInitials(name);

  return (
    <div
      className="rounded-full flex items-center justify-center overflow-hidden flex-shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: T.bg,
        border: `2px solid ${color || T.tealDim}`,
      }}
    >
      {avatar ? (
        <img src={avatar} alt={name} className="w-full h-full rounded-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        <span className="font-bold leading-none select-none"
          style={{ fontSize: Math.max(8, size * 0.35), color: color || T.tealDim }}>
          {initials}
        </span>
      )}
    </div>
  );
}
