"use client";

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { useCollabSession } from '@/hooks/useCollabSession';
import collabSessionService from '@/services/collabSessionService';
import WorkspaceUsersPanel from './WorkspaceUsersPanel';
import {
  X, Link2, Copy, Check, Users, RefreshCw, CircleOff, Loader2,
  Hash, LogOut, Bell, Shield, ShieldOff, UserX, Eye, Edit3,
  Terminal, GitBranch, FileEdit, FolderEdit, ArrowRight, Clock,
} from 'lucide-react';

import T from './collabTheme';

// ── Permission config ─────────────────────────────────────────────────────────

const PERM_CONFIG = [
  { key: 'canEdit',     label: 'Edit Code',   icon: FileEdit,   risk: 'low',    desc: 'Allow editing files via Yjs' },
  { key: 'canFileOps',  label: 'File Ops',     icon: FolderEdit, risk: 'medium', desc: 'Create, delete, rename files' },
  { key: 'canTerminal', label: 'Terminal',      icon: Terminal,   risk: 'high',   desc: 'Run commands in the terminal' },
  { key: 'canGit',      label: 'Git Control',   icon: GitBranch,  risk: 'high',   desc: 'Commit, push, pull, checkout' },
];

/**
 * ShareModal — Unified collaboration dialog.
 *
 * Works for ALL roles (idle, hosting, guest, knocking) with a
 * consistent layout. The same popup handles:
 *   - Starting a session (idle)
 *   - Managing a session (hosting) — room code, invite link, guests, permissions
 *   - Viewing session info (guest) — host info, permissions, leave
 *   - Waiting for approval (knocking)
 *   - Joining by room code (any role)
 *   - Online users list + invite/join actions
 */
export default function ShareModal({ slug, open, onClose }) {
  const { data: authSession } = useSession();
  const {
    role, isHost, isGuest, isKnocking, isActive, session,
    guests, pendingKnocks, pendingSession, hasPendingSession, permissions,
    admitGuest, denyKnock, updatePermissions, kickGuest,
    regenerateInvite, terminateSession, leaveSession,
    createSession, joinByCode, requestPermission,
    error, clearError, isLoading, wsStatus,
  } = useCollabSession();

  const [copied, setCopied] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joiningByCode, setJoiningByCode] = useState(false);
  const modalRef = useRef(null);

  // Reset state when modal opens (clearError is stable via useCallback)
  useEffect(() => {
    if (open) {
      setCopied(false);
      setCopiedCode(false);
      setJoinCode('');
      clearError();
      requestAnimationFrame(() => modalRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // ── Actions ───────────────────────────────────────────────────────────

  const handleCopy = useCallback(async () => {
    if (!session?.inviteLink) return;
    try {
      await navigator.clipboard.writeText(session.inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
  }, [session?.inviteLink]);

  const handleCopyCode = useCallback(async () => {
    const code = session?.roomCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch (_) {}
  }, [session?.roomCode]);

  const handleRegenerate = useCallback(async () => {
    setRegenerating(true);
    try { await regenerateInvite(); }
    catch (_) {}
    finally { setRegenerating(false); }
  }, [regenerateInvite]);

  const handleTerminate = useCallback(async () => {
    setTerminating(true);
    try { await terminateSession(); }
    catch (_) {}
    finally { setTerminating(false); }
  }, [terminateSession]);

  const handleJoinByCode = useCallback(async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code || code.length < 4) return;
    setJoiningByCode(true);
    try {
      await joinByCode(code);
      setJoinCode('');
    } catch (_) {}
    finally { setJoiningByCode(false); }
  }, [joinCode, joinByCode]);

  const handleStartSession = useCallback(async () => {
    const userId = authSession?.user?.id || authSession?.user?.email
      || (typeof window !== 'undefined' ? localStorage.getItem('synthi-user-id') : null)
      || 'host';
    const userName = authSession?.user?.name || authSession?.user?.email
      || (typeof window !== 'undefined' ? localStorage.getItem('synthi-user-name') : null)
      || 'Host';
    await createSession({
      hostId: userId,
      hostName: userName,
      slug,
      defaultPerms: { canEdit: true, canTerminal: false, canGit: false, canFileOps: true },
    });
  }, [createSession, slug, authSession]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
      ref={modalRef}
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div
        className="relative w-[480px] max-h-[85vh] rounded-xl border shadow-2xl flex flex-col overflow-hidden"
        style={{ backgroundColor: T.card, borderColor: T.border }}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: T.border }}>
          <div className="flex items-center gap-2.5">
            <Users className="w-4.5 h-4.5" style={{ color: T.teal }} />
            <h2 id="share-modal-title" className="text-sm font-semibold" style={{ color: T.text }}>
              Collaboration
            </h2>
            {isActive && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                style={{ backgroundColor: 'rgba(255,87,87,0.10)', color: T.live }}>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: T.live }} />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: T.live }} />
                </span>
                LIVE
              </span>
            )}
            {isActive && wsStatus !== 'connected' && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                style={{ backgroundColor: 'rgba(251,191,36,0.10)', color: T.amber }}>
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                {wsStatus === 'connecting' ? 'Reconnecting…' : 'Offline'}
              </span>
            )}
            {isKnocking && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                style={{ backgroundColor: 'rgba(251,191,36,0.10)', color: T.amber }}>
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Connecting…
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#1a1b24] transition-colors" aria-label="Close">
            <X className="w-4 h-4" style={{ color: T.textMuted }} />
          </button>
        </div>

        {/* ── Session Info Bar (host: room code + invite link, guest: host info) ─── */}
        {isHost && session && (
          <SessionInfoHost
            session={session}
            copied={copied}
            copiedCode={copiedCode}
            regenerating={regenerating}
            onCopy={handleCopy}
            onCopyCode={handleCopyCode}
            onRegenerate={handleRegenerate}
          />
        )}

        {isGuest && session && (
          <SessionInfoGuest session={session} permissions={permissions} requestPermission={requestPermission} />
        )}

        {/* ── Pending Knocks (host or pending-session, inline) ──── */}
        {(isHost || hasPendingSession) && pendingKnocks?.length > 0 && (
          <PendingKnocksSection
            knocks={pendingKnocks}
            onAdmit={admitGuest}
            onDeny={denyKnock}
          />
        )}

        {/* ── Connected Guests (host only, inline) ───────────────── */}
        {isHost && (
          <ConnectedGuestsSection
            guests={guests}
            onUpdatePermissions={updatePermissions}
            onKick={kickGuest}
          />
        )}

        {/* ── Content: Users panel ────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4" style={{ maxHeight: '40vh' }}>
          <WorkspaceUsersPanel slug={slug} />
        </div>

        {/* ── Join by Code (for idle/non-active users) ────────────── */}
        {!isActive && !isKnocking && (
          <JoinByCodeSection
            code={joinCode}
            onChange={setJoinCode}
            onJoin={handleJoinByCode}
            loading={joiningByCode}
          />
        )}

        {/* ── Footer Actions ─────────────────────────────────────── */}
        <div className="px-4 py-3 border-t flex items-center gap-2" style={{ borderColor: T.border }}>
          {role === 'idle' && (
            <button onClick={handleStartSession}
              disabled={isLoading}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all border"
              style={{ backgroundColor: 'rgba(74,186,154,0.10)', borderColor: 'rgba(74,186,154,0.30)', color: T.teal }}>
              <Users className="w-3.5 h-3.5" />
              {isLoading ? 'Starting…' : 'Start Sharing'}
            </button>
          )}

          {isHost && (
            <button onClick={handleTerminate}
              disabled={terminating}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all border"
              style={{ backgroundColor: 'rgba(255,87,87,0.08)', borderColor: 'rgba(255,87,87,0.25)', color: T.red, opacity: terminating ? 0.5 : 1 }}>
              {terminating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CircleOff className="w-3.5 h-3.5" />}
              {terminating ? 'Stopping…' : 'Stop Sharing'}
            </button>
          )}

          {isGuest && (
            <button onClick={leaveSession}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all border"
              style={{ backgroundColor: 'rgba(255,87,87,0.08)', borderColor: 'rgba(255,87,87,0.25)', color: T.red }}>
              <LogOut className="w-3.5 h-3.5" />
              Leave Session
            </button>
          )}

          {isKnocking && (
            <button onClick={leaveSession}
              className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all border"
              style={{ backgroundColor: 'rgba(251,191,36,0.08)', borderColor: 'rgba(251,191,36,0.25)', color: T.amber }}>
              <X className="w-3.5 h-3.5" />
              Cancel Request
            </button>
          )}
        </div>

        {/* ── Error ───────────────────────────────────────────────── */}
        {error && (
          <div className="px-4 py-2.5 border-t flex items-center gap-2"
            style={{ borderColor: T.border, backgroundColor: 'rgba(255,87,87,0.06)' }}>
            <CircleOff className="w-3.5 h-3.5 flex-shrink-0" style={{ color: T.red }} />
            <span className="flex-1 text-[11px]" style={{ color: T.red }}>{error}</span>
            {isActive && (
              <button 
                onClick={() => { clearError(); collabSessionService.refreshSession(); }}
                className="px-2 py-0.5 rounded text-[10px] font-medium border transition-colors"
                style={{ borderColor: 'rgba(255,87,87,0.25)', color: T.red }}>
                Retry
              </button>
            )}
            <button onClick={clearError} className="p-0.5 rounded hover:bg-[#ff575720]">
              <X className="w-3 h-3" style={{ color: T.red }} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Session Info — Host ──────────────────────────────────────────────────────

/** Format elapsed time since a given ISO timestamp */
function useSessionDuration(createdAt) {
  const [elapsed, setElapsed] = useState('');
  useEffect(() => {
    if (!createdAt) return;
    const tick = () => {
      const ms = Date.now() - new Date(createdAt).getTime();
      const secs = Math.floor(ms / 1000);
      const mins = Math.floor(secs / 60);
      const hrs = Math.floor(mins / 60);
      if (hrs > 0) setElapsed(`${hrs}h ${mins % 60}m`);
      else if (mins > 0) setElapsed(`${mins}m ${secs % 60}s`);
      else setElapsed(`${secs}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return elapsed;
}

function SessionInfoHost({ session, copied, copiedCode, regenerating, onCopy, onCopyCode, onRegenerate }) {
  const roomCode = session?.roomCode;
  const duration = useSessionDuration(session?.createdAt);

  return (
    <div className="px-4 py-3 border-b space-y-2" style={{ borderColor: T.border, backgroundColor: 'rgba(74,186,154,0.02)' }}>
      {/* Room Code — big and bold */}
      {roomCode && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5" style={{ color: T.teal }} />
            <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: T.textMuted }}>Room Code</span>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <span className="text-lg font-mono font-bold tracking-[0.3em] select-all" style={{ color: T.teal }}>
              {roomCode}
            </span>
            <button onClick={onCopyCode}
              className="p-1 rounded-md border transition-colors"
              style={{ backgroundColor: T.surface, borderColor: copiedCode ? 'rgba(74,186,154,0.4)' : T.border }}
              title="Copy room code">
              {copiedCode
                ? <Check className="w-3 h-3" style={{ color: T.teal }} />
                : <Copy className="w-3 h-3" style={{ color: T.textMuted }} />
              }
            </button>
          </div>
          {duration && (
            <div className="flex items-center gap-1 text-[10px]" style={{ color: T.textMuted }}>
              <Clock className="w-3 h-3" />
              {duration}
            </div>
          )}
        </div>
      )}

      {/* Invite Link — compact */}
      <div className="flex items-center gap-2">
        <Link2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: T.tealDim }} />
        <input
          readOnly
          value={session?.inviteLink || ''}
          aria-label="Invite link"
          className="flex-1 rounded-md px-2.5 py-1 text-[11px] font-mono truncate border focus:outline-none"
          style={{ backgroundColor: T.surface, borderColor: T.border, color: T.textSec }}
        />
        <button onClick={onCopy}
          className="p-1.5 rounded-md border transition-colors"
          style={{ backgroundColor: T.surface, borderColor: copied ? 'rgba(74,186,154,0.4)' : T.border }}
          title="Copy invite link">
          {copied
            ? <Check className="w-3 h-3" style={{ color: T.teal }} />
            : <Copy className="w-3 h-3" style={{ color: T.textMuted }} />
          }
        </button>
        <button onClick={onRegenerate}
          disabled={regenerating}
          className="p-1.5 rounded-md border transition-colors"
          style={{ backgroundColor: T.surface, borderColor: T.border, opacity: regenerating ? 0.5 : 1 }}
          title="Regenerate link">
          {regenerating
            ? <Loader2 className="w-3 h-3 animate-spin" style={{ color: T.textMuted }} />
            : <RefreshCw className="w-3 h-3" style={{ color: T.textMuted }} />
          }
        </button>
      </div>
    </div>
  );
}

// ── Session Info — Guest ─────────────────────────────────────────────────────

function SessionInfoGuest({ session, permissions, requestPermission }) {
  const hostName = session?.hostName || 'Host';
  const hasEdit = permissions?.canEdit;

  return (
    <div className="px-4 py-2.5 border-b flex items-center justify-between"
      style={{ borderColor: T.border, backgroundColor: hasEdit ? 'rgba(74,186,154,0.03)' : 'rgba(251,191,36,0.03)' }}>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold"
          style={{
            backgroundColor: hasEdit ? 'rgba(74,186,154,0.12)' : 'rgba(251,191,36,0.12)',
            color: hasEdit ? T.teal : T.amber,
          }}>
          {hasEdit ? <Edit3 className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          {hasEdit ? 'EDIT' : 'VIEW'}
        </div>
        <span className="text-xs font-medium" style={{ color: T.text }}>
          {hostName}&apos;s Session
        </span>
      </div>
      {/* Permission pills — denied ones are clickable to request */}
      <div className="flex items-center gap-1">
        {PERM_CONFIG.map(({ key, icon: Icon, label }) => {
          const granted = !!permissions?.[key];
          return (
            <button key={key}
              disabled={granted}
              onClick={() => !granted && requestPermission?.(key)}
              className="p-1 rounded transition-colors cursor-pointer disabled:cursor-default"
              style={{
                backgroundColor: granted ? 'rgba(74,186,154,0.10)' : 'transparent',
                color: granted ? T.teal : T.borderHi,
              }}
              title={granted ? `${label}: Granted` : `${label}: Denied — click to request`}>
              <Icon className="w-3 h-3" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Pending Knocks Section ───────────────────────────────────────────────────

function PendingKnocksSection({ knocks, onAdmit, onDeny }) {
  return (
    <div className="px-4 py-2.5 border-b" style={{ borderColor: T.border }}>
      <div className="flex items-center gap-1.5 mb-2">
        <Bell className="w-3.5 h-3.5" style={{ color: T.amber }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: T.amber }}>
          Requesting Access ({knocks.length})
        </span>
      </div>
      <div className="space-y-1.5">
        {knocks.map((knock) => (
          <div key={knock.guestId}
            className="flex items-center justify-between p-2 rounded-lg border"
            style={{ backgroundColor: 'rgba(251,191,36,0.03)', borderColor: 'rgba(251,191,36,0.15)' }}>
            <div className="flex items-center gap-2">
              {knock.avatarUrl ? (
                <img src={knock.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
              ) : (
                <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
                  style={{ backgroundColor: T.amber, color: T.card }}>
                  {knock.displayName?.[0]?.toUpperCase() || '?'}
                </div>
              )}
              <span className="text-xs font-medium" style={{ color: T.text }}>{knock.displayName}</span>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => onAdmit(knock.guestId)}
                className="p-1 rounded transition-colors"
                style={{ backgroundColor: 'rgba(74,222,128,0.12)' }}
                title="Accept">
                <Check className="w-3.5 h-3.5" style={{ color: '#4ade80' }} />
              </button>
              <button onClick={() => onDeny(knock.guestId)}
                className="p-1 rounded transition-colors"
                style={{ backgroundColor: 'rgba(255,87,87,0.12)' }}
                title="Deny">
                <X className="w-3.5 h-3.5" style={{ color: T.red }} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Connected Guests Section ─────────────────────────────────────────────────

function ConnectedGuestsSection({ guests, onUpdatePermissions, onKick }) {
  if (!guests || guests.length === 0) return null;

  return (
    <div className="px-4 py-2.5 border-b" style={{ borderColor: T.border }}>
      <div className="flex items-center gap-1.5 mb-2">
        <Users className="w-3.5 h-3.5" style={{ color: T.teal }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: T.textMuted }}>
          Connected ({guests.length})
        </span>
      </div>
      <div className="space-y-1.5">
        {guests.map((guest) => (
          <GuestRow
            key={guest.guestId}
            guest={guest}
            onUpdatePermissions={(perms) => onUpdatePermissions(guest.guestId, perms)}
            onKick={() => onKick(guest.guestId)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Guest Row (compact with permission toggles) ─────────────────────────────

function GuestRow({ guest, onUpdatePermissions, onKick }) {
  const [showPerms, setShowPerms] = useState(false);

  return (
    <div className="rounded-lg border overflow-hidden" style={{ backgroundColor: T.surface, borderColor: T.border }}>
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <div className="flex items-center gap-2">
          {guest.avatarUrl ? (
            <img src={guest.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
          ) : (
            <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold"
              style={{ backgroundColor: T.teal, color: T.card }}>
              {guest.displayName?.[0]?.toUpperCase() || '?'}
            </div>
          )}
          <span className="text-xs font-medium" style={{ color: T.text }}>{guest.displayName}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={() => setShowPerms(!showPerms)}
            className="p-1 rounded hover:bg-[#1a1b24] transition-colors" title="Permissions">
            {showPerms
              ? <Shield className="w-3.5 h-3.5" style={{ color: T.teal }} />
              : <ShieldOff className="w-3.5 h-3.5" style={{ color: T.textMuted }} />
            }
          </button>
          <button onClick={onKick}
            className="p-1 rounded hover:bg-[#ff575720] transition-colors" title="Remove guest">
            <UserX className="w-3.5 h-3.5" style={{ color: T.textMuted }} />
          </button>
        </div>
      </div>
      {showPerms && (
        <div className="px-2.5 pb-2 space-y-1 border-t pt-1.5" style={{ borderColor: T.border }}>
          {PERM_CONFIG.map(({ key, label, icon: Icon, risk }) => {
            const enabled = guest.permissions?.[key];
            return (
              <button key={key}
                onClick={() => onUpdatePermissions({ [key]: !enabled })}
                className="w-full flex items-center justify-between px-2 py-1 rounded-md transition-all border"
                style={{
                  backgroundColor: enabled ? 'rgba(58,133,116,0.07)' : T.bg,
                  borderColor: enabled ? 'rgba(58,133,116,0.15)' : T.border,
                }}>
                <div className="flex items-center gap-1.5">
                  <Icon className="w-3 h-3" style={{ color: enabled ? T.teal : T.textMuted }} />
                  <span className="text-[11px] font-medium" style={{ color: enabled ? T.text : T.textMuted }}>{label}</span>
                  {risk === 'high' && <span className="text-[9px]" style={{ color: T.red }}>⚠</span>}
                </div>
                <MiniToggle enabled={enabled} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Join by Code Section ─────────────────────────────────────────────────────

function JoinByCodeSection({ code, onChange, onJoin, loading }) {
  return (
    <div className="px-4 py-3 border-t" style={{ borderColor: T.border }}>
      <div className="flex items-center gap-1.5 mb-2">
        <Hash className="w-3.5 h-3.5" style={{ color: T.textMuted }} />
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: T.textMuted }}>
          Join by Room Code
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          value={code}
          onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
          onKeyDown={(e) => {
            e.stopPropagation(); // prevent global shortcuts from intercepting input
            if (e.key === 'Enter') onJoin();
          }}
          placeholder="Enter code…"
          maxLength={8}
          className="flex-1 rounded-md px-3 py-1.5 text-sm font-mono tracking-widest border focus:outline-none focus:border-[#4aba9a60] uppercase"
          style={{ backgroundColor: T.surface, borderColor: T.border, color: T.text }}
          aria-label="Room code"
        />
        <button onClick={onJoin}
          disabled={loading || !code.trim() || code.trim().length < 4}
          className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-semibold transition-all border"
          style={{
            backgroundColor: 'rgba(74,186,154,0.10)',
            borderColor: 'rgba(74,186,154,0.30)',
            color: T.teal,
            opacity: loading || !code.trim() ? 0.5 : 1,
          }}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
          Join
        </button>
      </div>
    </div>
  );
}

// ── Mini Toggle ─────────────────────────────────────────────────────────────

function MiniToggle({ enabled }) {
  return (
    <div className="w-7 h-3.5 rounded-full relative transition-colors flex-shrink-0"
      style={{ backgroundColor: enabled ? T.teal : T.borderHi }}>
      <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform ${
        enabled ? 'translate-x-3.5' : 'translate-x-0.5'
      }`} />
    </div>
  );
}
