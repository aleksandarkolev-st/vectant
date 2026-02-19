"use client";

import React, { useState, useCallback, useEffect } from 'react';
import { useWorkspacePresence } from '@/hooks/useWorkspacePresence';
import { useCollabSession } from '@/hooks/useCollabSession';
import { useBlockedUsers } from '@/hooks/useBlockedUsers';
import collabClient from '@/services/collabClient';
import collabSessionService from '@/services/collabSessionService';
import { getCurrentUser } from '@/services/userIdentity';
import getInitials from '@/utils/getInitials';
import {
  Users, FileEdit, Globe, Loader2, UserPlus, Shield,
  Send, Check, X, Bell, Ban, MoreHorizontal
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
  const [pendingInvite, setPendingInvite] = useState(null); // incoming invite

  const myUserId = getCurrentUser().id;

  // ── Listen for incoming collab-invite notifications ───────────────────
  useEffect(() => {
    const unsub = collabSessionService.on('collab-invite', (detail) => {
      setPendingInvite(detail);
    });
    return unsub;
  }, []);

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

  const handleInviteUser = useCallback(async (userId) => {
    if (isGuest || isKnocking) return;
    setInvitingUserId(userId);
    try {
      await inviteUser(userId, slug);
    } catch (err) { console.warn('[Collab] inviteUser:', err?.message); }
    setInvitingUserId(null);
  }, [isGuest, isKnocking, inviteUser, slug]);

  // ── Accept incoming invite ────────────────────────────────────────────

  const handleAcceptInvite = useCallback(async () => {
    if (!pendingInvite?.sessionId) return;
    setPendingInvite(null);
    await requestJoinSession(pendingInvite.sessionId);
  }, [pendingInvite, requestJoinSession]);

  const handleDeclineInvite = useCallback(() => {
    setPendingInvite(null);
  }, []);

  // ── Block / Unblock ───────────────────────────────────────────────────

  const handleBlockUser = useCallback(async (userId, userName) => {
    const confirmed = window.confirm(
      `Block ${userName || 'this user'}? They won\u2019t be able to see you in the users list or send you requests.`
    );
    if (!confirmed) return;
    try {
      await blockUser(userId);
      refresh(); // re-fetch presence so blocked user disappears
    } catch (err) { console.warn('[Collab] blockUser:', err?.message); }
  }, [blockUser, refresh]);

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
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border"
          style={{ backgroundColor: 'rgba(124,184,248,0.06)', borderColor: 'rgba(124,184,248,0.20)' }}>
          <Bell className="w-3.5 h-3.5 flex-shrink-0" style={{ color: T.blue }} />
          <div className="flex-1 min-w-0">
            <span className="text-[11px] font-medium" style={{ color: T.text }}>
              <span style={{ color: T.blue }}>{pendingInvite.hostName || 'Someone'}</span> invited you to collaborate
            </span>
          </div>
          <button onClick={handleAcceptInvite}
            className="p-1 rounded bg-[#4aba9a20] hover:bg-[#4aba9a30]" title="Accept" aria-label="Accept collaboration invite">
            <Check className="w-3.5 h-3.5" style={{ color: T.teal }} />
          </button>
          <button onClick={handleDeclineInvite}
            className="p-1 rounded bg-[#ff575720] hover:bg-[#ff575730]" title="Decline" aria-label="Decline collaboration invite">
            <X className="w-3.5 h-3.5" style={{ color: T.red }} />
          </button>
        </div>
      )}

      {/* ── Guest connection banner ─────────────────────────────────── */}
      {isGuest && hostId && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border"
          style={{ backgroundColor: 'rgba(74,186,154,0.06)', borderColor: 'rgba(74,186,154,0.20)' }}>
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
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border"
          style={{ backgroundColor: 'rgba(251,191,36,0.06)', borderColor: 'rgba(251,191,36,0.20)' }}>
          <Loader2 className="w-3 h-3 animate-spin" style={{ color: T.amber }} />
          <span className="text-[11px] font-medium" style={{ color: T.amber }}>
            Waiting for host to approve…
          </span>
        </div>
      )}

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
        <div className="text-center py-6">
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
      {error && (
        <div className="px-2 py-1.5 rounded text-[11px] border"
          style={{ backgroundColor: 'rgba(255,87,87,0.06)', borderColor: 'rgba(255,87,87,0.2)', color: T.red }}>
          {error}
        </div>
      )}
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
    <div className="rounded-lg border overflow-hidden"
      style={{ backgroundColor: T.card, borderColor: isMySession ? 'rgba(74,186,154,0.25)' : T.border }}>
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
            <span className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
              style={{ backgroundColor: 'rgba(255,87,87,0.10)', color: T.live }}>
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
          </span>
        </div>
        {/* Join button */}
        {!isMySession && isIdle && !isKnocking && (
          <button
            onClick={() => onRequestJoin(session.id)}
            disabled={isJoiningThis}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-all"
            style={{
              backgroundColor: 'rgba(74,186,154,0.12)',
              border: `1px solid rgba(74,186,154,0.30)`,
              color: T.teal,
              opacity: isJoiningThis ? 0.5 : 1,
            }}
          >
            {isJoiningThis
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : <UserPlus className="w-3 h-3" />
            }
            Ask to Join
          </button>
        )}
        {isMySession && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
            style={{ backgroundColor: 'rgba(74,186,154,0.12)', color: T.teal }}>
            <Shield className="w-2.5 h-2.5 inline mr-0.5" />
            Host
          </span>
        )}
      </div>

      {/* Guest list */}
      {session.guests && session.guests.length > 0 && (
        <div className="border-t px-3 py-1.5 flex items-center gap-1 flex-wrap"
          style={{ borderColor: T.border }}>
          {session.guests.map(g => (
            <span key={g.guestId} className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
              style={{ backgroundColor: 'rgba(124,128,160,0.08)', color: T.textSec }}>
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
 * @param {{ user: object, isIdle: boolean, isHost: boolean, isKnocking: boolean, joiningUserId: string|null, invitingUserId: string|null, onJoinUser: (id: string, name: string) => void, onInviteUser: (id: string) => void, onBlockUser: (id: string, name: string) => void }} props
 */
function UserRow({ user, isIdle, isHost, isKnocking, joiningUserId, invitingUserId, onJoinUser, onInviteUser, onBlockUser }) {
  const isJoining = joiningUserId === user.id;
  const isInviting = invitingUserId === user.id;
  const canAct = (isIdle || isHost) && !isKnocking;
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors hover:bg-[#ffffff04] group relative">
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
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all"
              style={{
                backgroundColor: 'rgba(74,186,154,0.10)',
                border: '1px solid rgba(74,186,154,0.25)',
                color: T.teal,
                opacity: isJoining ? 0.5 : 1,
              }}
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
          <button
            onClick={() => onInviteUser(user.id)}
            disabled={isInviting}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-all"
            style={{
              backgroundColor: 'rgba(124,184,248,0.10)',
              border: '1px solid rgba(124,184,248,0.25)',
              color: T.blue,
              opacity: isInviting ? 0.5 : 1,
            }}
            title="Invite to your workspace"              aria-label={`Invite ${user.name} to your workspace`}          >
            {isInviting
              ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
              : <Send className="w-2.5 h-2.5" />
            }
            Invite
          </button>
          {/* More menu (block) */}
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="p-0.5 rounded hover:bg-[#ffffff08] transition-colors"
              title="More options"
              aria-haspopup="menu"
              aria-expanded={showMenu}
            >
              <MoreHorizontal className="w-3 h-3" style={{ color: T.textMuted }} />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-[50]" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-[51] rounded-lg border shadow-xl py-1 min-w-[140px]"
                  role="menu"
                  onKeyDown={(e) => { if (e.key === 'Escape') setShowMenu(false); }}
                  style={{ backgroundColor: T.bg, borderColor: T.border }}>
                  <button
                    onClick={() => { onBlockUser(user.id, user.name); setShowMenu(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] font-medium transition-colors hover:bg-[#ff575710]"
                    style={{ color: T.red }}
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
