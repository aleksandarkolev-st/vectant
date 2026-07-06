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
      <div className="absolute inset-0 bg-[color-mix(in_srgb,black_68%,transparent)] backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="vt-dialog-surface relative flex max-h-[85vh] w-[480px] flex-col overflow-hidden">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="vt-panel-header justify-between px-5">
          <div className="flex items-center gap-2.5">
            <Users className="h-4 w-4 text-[var(--attention-purple)]" />
            <h2 id="share-modal-title" className="vt-panel-title">
              Collaboration
            </h2>
            {isActive && (
              <span className="vt-workflow-chip text-[9px]" style={{ '--chip-color': 'var(--accent-danger)' }}>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent-danger)] opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent-danger)]" />
                </span>
                LIVE
              </span>
            )}
            {isActive && wsStatus !== 'connected' && (
              <span className="vt-workflow-chip text-[9px]" style={{ '--chip-color': 'var(--accent-warning)' }}>
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                {wsStatus === 'connecting' ? 'Reconnecting…' : 'Offline'}
              </span>
            )}
            {isKnocking && (
              <span className="vt-workflow-chip text-[9px]" style={{ '--chip-color': 'var(--accent-warning)' }}>
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Connecting…
              </span>
            )}
          </div>
          <button onClick={onClose} className="vt-icon-button th-focus-ring h-7 min-w-7" aria-label="Close">
            <X className="w-4 h-4" />
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
        <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] px-4 py-3">
          {role === 'idle' && (
            <button onClick={handleStartSession}
              disabled={isLoading}
              className="th-focus-ring th-btn-primary flex flex-1 items-center justify-center gap-2 px-3 py-2 text-xs font-semibold disabled:opacity-50">
              <Users className="w-3.5 h-3.5" />
              {isLoading ? 'Starting…' : 'Start Sharing'}
            </button>
          )}

          {isHost && (
            <button onClick={handleTerminate}
              disabled={terminating}
              className="th-focus-ring th-btn-ghost flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-xs font-semibold text-[var(--accent-danger)] disabled:opacity-50"
              style={{ borderColor: 'color-mix(in srgb, var(--accent-danger) 28%, transparent)' }}>
              {terminating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CircleOff className="w-3.5 h-3.5" />}
              {terminating ? 'Stopping…' : 'Stop Sharing'}
            </button>
          )}

          {isGuest && (
            <button onClick={leaveSession}
              className="th-focus-ring th-btn-ghost flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-xs font-semibold text-[var(--accent-danger)]"
              style={{ borderColor: 'color-mix(in srgb, var(--accent-danger) 28%, transparent)' }}>
              <LogOut className="w-3.5 h-3.5" />
              Leave Session
            </button>
          )}

          {isKnocking && (
            <button onClick={leaveSession}
              className="th-focus-ring th-btn-ghost flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-control)] border px-3 py-2 text-xs font-semibold text-[var(--accent-warning)]"
              style={{ borderColor: 'color-mix(in srgb, var(--accent-warning) 28%, transparent)' }}>
              <X className="w-3.5 h-3.5" />
              Cancel Request
            </button>
          )}
        </div>

        {/* ── Error ───────────────────────────────────────────────── */}
        {error && (
          <div className="vt-workflow-alert vt-workflow-alert--danger flex items-center gap-2 rounded-none border-x-0 border-b-0 px-4 py-2.5">
            <CircleOff className="w-3.5 h-3.5 flex-shrink-0 text-[var(--accent-danger)]" />
            <span className="flex-1 text-[11px] text-[var(--accent-danger)]">{error}</span>
            {isActive && (
              <button 
                onClick={() => { clearError(); collabSessionService.refreshSession(); }}
                className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] border px-2 py-0.5 text-[10px] font-medium text-[var(--accent-danger)]"
                style={{ borderColor: 'color-mix(in srgb, var(--accent-danger) 28%, transparent)' }}>
                Retry
              </button>
            )}
            <button onClick={clearError} className="vt-icon-button th-focus-ring h-6 min-w-6">
              <X className="w-3 h-3" />
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
    <div className="space-y-2 border-b border-[var(--border-subtle)] bg-[var(--surface-panel-subtle)] px-4 py-3">
      {/* Room Code — big and bold */}
      {roomCode && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5 text-[var(--attention-purple)]" />
            <span className="vt-panel-kicker">Room Code</span>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <span className="select-all font-mono text-lg font-bold tracking-[0.3em] text-[var(--attention-purple)]">
              {roomCode}
            </span>
            <button onClick={onCopyCode}
              className={`vt-icon-button th-focus-ring h-7 min-w-7 ${copiedCode ? 'th-btn-active' : ''}`}
              title="Copy room code">
              {copiedCode
                ? <Check className="w-3 h-3" />
                : <Copy className="w-3 h-3" />
              }
            </button>
          </div>
          {duration && (
            <div className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
              <Clock className="w-3 h-3" />
              {duration}
            </div>
          )}
        </div>
      )}

      {/* Invite Link — compact */}
      <div className="flex items-center gap-2">
        <Link2 className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-muted)]" />
        <input
          readOnly
          value={session?.inviteLink || ''}
          aria-label="Invite link"
          className="th-input flex-1 truncate rounded-[var(--radius-control)] border px-2.5 py-1 font-mono text-[11px] focus:outline-none"
        />
        <button onClick={onCopy}
          className={`vt-icon-button th-focus-ring h-7 min-w-7 ${copied ? 'th-btn-active' : ''}`}
          title="Copy invite link">
          {copied
            ? <Check className="w-3 h-3" />
            : <Copy className="w-3 h-3" />
          }
        </button>
        <button onClick={onRegenerate}
          disabled={regenerating}
          className="vt-icon-button th-focus-ring h-7 min-w-7 disabled:opacity-50"
          title="Regenerate link">
          {regenerating
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <RefreshCw className="w-3 h-3" />
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
    <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--surface-panel-subtle)] px-4 py-2.5">
      <div className="flex items-center gap-2">
        <div className="vt-workflow-chip" style={{ '--chip-color': hasEdit ? 'var(--accent-secondary)' : 'var(--accent-warning)' }}>
          {hasEdit ? <Edit3 className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          {hasEdit ? 'EDIT' : 'VIEW'}
        </div>
        <span className="text-xs font-medium text-[var(--text-primary)]">
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
              className={`vt-icon-button th-focus-ring h-7 min-w-7 cursor-pointer disabled:cursor-default ${granted ? 'th-btn-active' : ''}`}
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
    <div className="border-b border-[var(--border-subtle)] px-4 py-2.5">
      <div className="flex items-center gap-1.5 mb-2">
        <Bell className="w-3.5 h-3.5 text-[var(--accent-warning)]" />
        <span className="vt-panel-kicker text-[var(--accent-warning)]">
          Requesting Access ({knocks.length})
        </span>
      </div>
      <div className="space-y-1.5">
        {knocks.map((knock) => (
          <div key={knock.guestId}
            className="vt-workflow-alert flex items-center justify-between p-2">
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
                className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-success)]"
                title="Accept">
                <Check className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => onDeny(knock.guestId)}
                className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-danger)]"
                title="Deny">
                <X className="w-3.5 h-3.5" />
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
    <div className="border-b border-[var(--border-subtle)] px-4 py-2.5">
      <div className="flex items-center gap-1.5 mb-2">
        <Users className="w-3.5 h-3.5 text-[var(--accent-secondary)]" />
        <span className="vt-panel-kicker">
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
    <div className="vt-workflow-card overflow-hidden">
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
            className={`vt-icon-button th-focus-ring h-7 min-w-7 ${showPerms ? 'th-btn-active' : ''}`} title="Permissions">
            {showPerms
              ? <Shield className="w-3.5 h-3.5" />
              : <ShieldOff className="w-3.5 h-3.5" />
            }
          </button>
          <button onClick={onKick}
            className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-danger)]" title="Remove guest">
            <UserX className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {showPerms && (
        <div className="space-y-1 border-t border-[var(--border-subtle)] px-2.5 pb-2 pt-1.5">
          {PERM_CONFIG.map(({ key, label, icon: Icon, risk }) => {
            const enabled = guest.permissions?.[key];
            return (
              <button key={key}
                onClick={() => onUpdatePermissions({ [key]: !enabled })}
                className={`th-focus-ring flex w-full items-center justify-between rounded-[var(--radius-control)] border px-2 py-1 transition-all ${enabled ? 'th-btn-active' : 'th-btn-ghost border-[var(--border-subtle)]'}`}>
                <div className="flex items-center gap-1.5">
                  <Icon className="w-3 h-3" />
                  <span className="text-[11px] font-medium">{label}</span>
                  {risk === 'high' && <span className="text-[9px] text-[var(--accent-danger)]">High</span>}
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
    <div className="border-t border-[var(--border-subtle)] px-4 py-3">
      <div className="flex items-center gap-1.5 mb-2">
        <Hash className="w-3.5 h-3.5 text-[var(--text-muted)]" />
        <span className="vt-panel-kicker">
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
          className="th-input flex-1 rounded-[var(--radius-control)] border px-3 py-1.5 font-mono text-sm uppercase tracking-widest focus:outline-none"
          aria-label="Room code"
        />
        <button onClick={onJoin}
          disabled={loading || !code.trim() || code.trim().length < 4}
          className="th-focus-ring th-btn-primary flex items-center gap-1 px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
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
    <div className={`relative h-3.5 w-7 flex-shrink-0 rounded-full transition-colors ${enabled ? 'th-toggle-on' : 'th-toggle-off'}`}>
      <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform ${
        enabled ? 'translate-x-3.5' : 'translate-x-0.5'
      }`} />
    </div>
  );
}
