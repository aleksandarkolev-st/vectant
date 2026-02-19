"use client";

import React, { useState, useCallback, useEffect } from 'react';
import { useWorkspacePresence } from '@/hooks/useWorkspacePresence';
import { useCollabSession } from '@/hooks/useCollabSession';
import collabClient from '@/services/collabClient';
import collabSessionService from '@/services/collabSessionService';
import {
  Users, Radio, Eye, FileEdit, Clock, Globe,
  ChevronRight, Loader2, UserPlus, Shield, Send,
  Check, X, Bell
} from 'lucide-react';

// ── Theme ─────────────────────────────────────────────────────────────────────
const T = {
  bg:       '#0d0e14',
  card:     '#101118',
  border:   '#1c1d26',
  borderHi: '#2a2b38',
  text:     '#e0e4ec',
  textSec:  '#7c80a0',
  textMuted:'#5a6178',
  teal:     '#4aba9a',
  tealDim:  '#3a8574',
  blue:     '#7cb8f8',
  amber:    '#fbbf24',
  red:      '#ff5757',
  live:     '#ff5757',
};

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
  const [joiningSessionId, setJoiningSessionId] = useState(null);
  const [joiningUserId, setJoiningUserId] = useState(null);
  const [invitingUserId, setInvitingUserId] = useState(null);
  const [pendingInvite, setPendingInvite] = useState(null); // incoming invite

  const myUserId = typeof window !== 'undefined'
    ? localStorage.getItem('synthi-user-id') || ''
    : '';

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
    } catch (_) { /* error handled by hook */ }
    setJoiningSessionId(null);
  }, [isHost, isGuest, isKnocking, requestJoinSession]);

  // ── Ask to join a solo user (direct collab) ───────────────────────────

  const handleJoinUser = useCallback(async (userId, userName) => {
    if (isHost || isGuest || isKnocking) return;
    setJoiningUserId(userId);
    try {
      await joinUser(userId, userName, slug);
    } catch (_) { /* error handled by hook */ }
    setJoiningUserId(null);
  }, [isHost, isGuest, isKnocking, joinUser, slug]);

  // ── Invite a solo user (direct collab) ────────────────────────────────

  const handleInviteUser = useCallback(async (userId) => {
    if (isGuest || isKnocking) return;
    setInvitingUserId(userId);
    try {
      await inviteUser(userId, slug);
    } catch (_) { /* error handled by hook */ }
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
            className="p-1 rounded bg-[#4aba9a20] hover:bg-[#4aba9a30]" title="Accept">
            <Check className="w-3.5 h-3.5" style={{ color: T.teal }} />
          </button>
          <button onClick={handleDeclineInvite}
            className="p-1 rounded bg-[#ff575720] hover:bg-[#ff575730]" title="Decline">
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

function UserRow({ user, isIdle, isHost, isKnocking, joiningUserId, invitingUserId, onJoinUser, onInviteUser }) {
  const isJoining = joiningUserId === user.id;
  const isInviting = invitingUserId === user.id;
  const canAct = (isIdle || isHost) && !isKnocking;

  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors hover:bg-[#ffffff04] group">
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
            title="Invite to your workspace"
          >
            {isInviting
              ? <Loader2 className="w-2.5 h-2.5 animate-spin" />
              : <Send className="w-2.5 h-2.5" />
            }
            Invite
          </button>
        </div>
      )}
      {!canAct && (
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: T.teal }} />
      )}
    </div>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────

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

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
