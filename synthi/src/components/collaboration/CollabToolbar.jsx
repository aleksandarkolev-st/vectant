"use client";

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { usePresence } from '@/hooks/usePresence';
import { useCollabSession } from '@/hooks/useCollabSession';
import {
  Users, Link2, Copy, Check, X, Shield, ShieldOff,
  Terminal, GitBranch, FileEdit, FolderEdit, UserX,
  Radio, CircleOff, ChevronDown, Bell, RefreshCw,
  Share2, LogOut, Eye, Edit3, Plus
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

// ── Permission config ─────────────────────────────────────────────────────────

const PERM_CONFIG = [
  { key: 'canEdit',     label: 'Edit Code',   icon: FileEdit,   risk: 'low',    desc: 'Allow editing files via Yjs' },
  { key: 'canFileOps',  label: 'File Ops',     icon: FolderEdit, risk: 'medium', desc: 'Create, delete, rename files' },
  { key: 'canTerminal', label: 'Terminal',      icon: Terminal,   risk: 'high',   desc: 'Run commands in the terminal' },
  { key: 'canGit',      label: 'Git Control',   icon: GitBranch,  risk: 'high',   desc: 'Commit, push, pull, checkout' },
];

// ── Main CollabToolbar ────────────────────────────────────────────────────────

/**
 * CollabToolbar — Top-bar collaboration widget.
 *
 * Combines:
 *   - Presence avatars (or "Solo" pill)
 *   - Session share / management popover
 *   - Pending knock badges + accept/deny
 *   - Guest leave button
 */
export default function CollabToolbar({ slug }) {
  const users = usePresence(slug);
  const {
    role, session, guests, pendingKnocks, permissions,
    isHost, isGuest, isKnocking, isActive,
    createSession, admitGuest, denyKnock, updatePermissions,
    kickGuest, terminateSession, regenerateInvite, leaveSession,
    error, clearError,
  } = useCollabSession();

  const [copied, setCopied] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // ── Copy invite link ──────────────────────────────────────────────────

  const handleCopyLink = useCallback(async () => {
    if (!session?.inviteLink) return;
    try {
      await navigator.clipboard.writeText(session.inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
  }, [session?.inviteLink]);

  // ── Create session ────────────────────────────────────────────────────

  const handleCreate = useCallback(async (defaultPerms) => {
    const userId = typeof window !== 'undefined'
      ? localStorage.getItem('synthi-user-id') || 'host'
      : 'host';
    const userName = typeof window !== 'undefined'
      ? localStorage.getItem('synthi-user-name') || 'Host'
      : 'Host';
    await createSession({
      hostId: userId,
      hostName: userName,
      slug,
      defaultPerms,
    });
    setShowCreate(false);
  }, [createSession, slug]);

  return (
    <div className="flex items-center gap-2">
      {/* ── Presence Avatars ────────────────────────────────────────── */}
      <PresenceAvatars users={users} />

      {/* ── Session Controls (based on role) ─────────────────────────── */}
      {role === 'idle' && !showCreate && (
        <ShareButton onClick={() => setShowCreate(true)} />
      )}

      {showCreate && !isHost && (
        <CreateSessionPopover
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}

      {isHost && (
        <HostControls
          session={session}
          guests={guests}
          pendingKnocks={pendingKnocks}
          copied={copied}
          onCopyLink={handleCopyLink}
          onAdmit={admitGuest}
          onDeny={denyKnock}
          onUpdatePermissions={updatePermissions}
          onKick={kickGuest}
          onTerminate={terminateSession}
          onRegenerate={regenerateInvite}
          error={error}
          clearError={clearError}
        />
      )}

      {isGuest && (
        <GuestControls
          session={session}
          permissions={permissions}
          onLeave={leaveSession}
        />
      )}

      {isKnocking && (
        <KnockingIndicator onCancel={leaveSession} />
      )}
    </div>
  );
}

// ── Presence Avatars ──────────────────────────────────────────────────────────

function PresenceAvatars({ users }) {
  const maxVisible = 5;
  const visible = users.slice(0, maxVisible);
  const overflow = users.length - visible.length;

  if (users.length === 0) {
    return (
      <span className="text-[11px] text-[#6b7089] px-2.5 py-1 rounded-full bg-[#0d0e14] border border-[#1c1d26]">
        Solo
      </span>
    );
  }

  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((entry) => (
        <AvatarCircle key={entry.user.id} user={entry.user} />
      ))}
      {overflow > 0 && (
        <span
          className="flex items-center justify-center w-7 h-7 rounded-full
                     bg-[#0d0e14] text-[10px] font-semibold text-[#9ba2b8]
                     border-2 border-[#1c1d26] ml-0.5 select-none z-10"
          title={`${overflow} more user${overflow > 1 ? 's' : ''}`}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

function AvatarCircle({ user, size = 'sm' }) {
  const { name, color, image } = user;
  const initials = getInitials(name);
  const dim = size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';
  const textSize = size === 'sm' ? 'text-[10px]' : 'text-xs';

  return (
    <div className="relative group flex-shrink-0" title={name}>
      <div
        className={`${dim} rounded-full flex items-center justify-center border-2 overflow-hidden bg-[#0d0e14]`}
        style={{ borderColor: color || '#327464' }}
      >
        {image ? (
          <img
            src={image}
            alt={name}
            className="w-full h-full rounded-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            className={`${textSize} font-bold leading-none select-none`}
            style={{ color: color || '#327464' }}
          >
            {initials}
          </span>
        )}
      </div>
      {/* Tooltip */}
      <div
        className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2
                   mb-2 px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap
                   bg-[#1a1b24] text-[#e0e2ea] border border-[#2a2b38]
                   opacity-0 group-hover:opacity-100 transition-opacity z-50
                   shadow-lg"
      >
        {name}
      </div>
    </div>
  );
}

// ── Share Button (idle state) ─────────────────────────────────────────────────

function ShareButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg
                 bg-[#0d0e14] border border-[#1c1d26]
                 hover:border-[#3a8574] hover:bg-[#3a857410]
                 text-[#9ba2b8] hover:text-[#e0e4ec]
                 transition-all text-[11px] font-medium"
      title="Start a collaboration session"
    >
      <Share2 className="w-3.5 h-3.5" />
      Share
    </button>
  );
}

// ── Create Session Popover ───────────────────────────────────────────────────

function CreateSessionPopover({ onClose, onCreate }) {
  const [perms, setPerms] = useState({
    canEdit: true,
    canTerminal: false,
    canGit: false,
    canFileOps: false,
  });

  return (
    <Popover open onOpenChange={(open) => { if (!open) onClose(); }}>
      <PopoverTrigger asChild>
        <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#3a857420] border border-[#3a857440] text-[#3a8574] text-[11px] font-medium">
          <Share2 className="w-3.5 h-3.5" />
          Share…
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[340px] bg-[#0d0e14] border-[#1c1d26] p-0 shadow-xl rounded-xl"
        style={{ backgroundColor: '#0d0e14' }}
        align="end"
      >
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-[#e0e4ec] flex items-center gap-2">
              <Users className="w-4 h-4 text-[#3a8574]" />
              Share Session
            </h3>
            <button onClick={onClose} className="p-1 rounded hover:bg-[#1a1b24]">
              <X className="w-4 h-4 text-[#5a6178]" />
            </button>
          </div>

          <p className="text-xs text-[#5a6178] mb-3">
            Set default guest permissions. You can change per-user later.
          </p>

          <div className="space-y-1.5 mb-4">
            {PERM_CONFIG.map(({ key, label, icon: Icon, risk, desc }) => (
              <button
                key={key}
                onClick={() => setPerms(p => ({ ...p, [key]: !p[key] }))}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition-all text-left ${
                  perms[key]
                    ? 'bg-[#3a857412] border border-[#3a857430]'
                    : 'bg-[#101118] border border-[#1a1b24] hover:border-[#2a2b38]'
                }`}
                title={desc}
              >
                <div className="flex items-center gap-2">
                  <Icon className={`w-3.5 h-3.5 ${perms[key] ? 'text-[#3a8574]' : 'text-[#5a6178]'}`} />
                  <span className={`text-xs font-medium ${perms[key] ? 'text-[#e0e4ec]' : 'text-[#5a6178]'}`}>
                    {label}
                  </span>
                  {risk === 'high' && (
                    <span className="text-[10px] text-[#ff5757]">⚠</span>
                  )}
                </div>
                <MiniToggle enabled={perms[key]} />
              </button>
            ))}
          </div>

          <button
            onClick={() => onCreate(perms)}
            className="w-full py-2 bg-[#3a8574] hover:bg-[#327464] text-white font-semibold text-sm rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            <Radio className="w-3.5 h-3.5" />
            Start Sharing
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Host Controls ─────────────────────────────────────────────────────────────

function HostControls({
  session, guests, pendingKnocks, copied,
  onCopyLink, onAdmit, onDeny, onUpdatePermissions, onKick,
  onTerminate, onRegenerate, error, clearError,
}) {
  const knockCount = pendingKnocks?.length || 0;

  return (
    <div className="flex items-center gap-1.5">
      {/* LIVE badge */}
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#ff575712] border border-[#ff575730]">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#ff5757] opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-[#ff5757]" />
        </span>
        <span className="text-[11px] font-bold text-[#ff5757] tracking-wide">LIVE</span>
      </div>

      {/* Pending knocks badge */}
      {knockCount > 0 && (
        <KnockBadge
          knocks={pendingKnocks}
          onAdmit={onAdmit}
          onDeny={onDeny}
        />
      )}

      {/* Session management popover */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="flex items-center gap-1 px-2 py-1 rounded-lg
                       bg-[#0d0e14] border border-[#1c1d26]
                       hover:border-[#3a8574] hover:bg-[#3a857410]
                       text-[#9ba2b8] hover:text-[#e0e4ec]
                       transition-all text-[11px] font-medium"
            title="Session settings"
          >
            <Users className="w-3.5 h-3.5" />
            <span>{guests?.length || 0}</span>
            <ChevronDown className="w-3 h-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[340px] bg-[#0d0e14] border-[#1c1d26] p-0 shadow-xl rounded-xl"
          style={{ backgroundColor: '#0d0e14' }}
          align="end"
        >
          <SessionManagePanel
            session={session}
            guests={guests}
            pendingKnocks={pendingKnocks}
            copied={copied}
            onCopyLink={onCopyLink}
            onAdmit={onAdmit}
            onDeny={onDeny}
            onUpdatePermissions={onUpdatePermissions}
            onKick={onKick}
            onTerminate={onTerminate}
            onRegenerate={onRegenerate}
            error={error}
            clearError={clearError}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── Knock Badge (quick accept/deny from top bar) ─────────────────────────────

function KnockBadge({ knocks, onAdmit, onDeny }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="relative flex items-center gap-1 px-2 py-1 rounded-lg
                     bg-[#fbbf2412] border border-[#fbbf2430]
                     hover:bg-[#fbbf2420] transition-all"
          title={`${knocks.length} request${knocks.length > 1 ? 's' : ''} to join`}
        >
          <Bell className="w-3.5 h-3.5 text-[#fbbf24]" />
          <span className="text-[11px] font-bold text-[#fbbf24]">{knocks.length}</span>
          <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-[#fbbf24] rounded-full animate-pulse" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[280px] bg-[#0d0e14] border-[#1c1d26] p-3 shadow-xl rounded-xl"
        style={{ backgroundColor: '#0d0e14' }}
        align="end"
      >
        <div className="text-xs text-[#fbbf24] font-semibold mb-2 flex items-center gap-1.5">
          <Bell className="w-3.5 h-3.5" />
          Requesting Access
        </div>
        <div className="space-y-2">
          {knocks.map((knock) => (
            <div
              key={knock.guestId}
              className="flex items-center justify-between p-2 bg-[#fbbf2408] border border-[#fbbf2420] rounded-lg"
            >
              <div className="flex items-center gap-2">
                {knock.avatarUrl ? (
                  <img src={knock.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-[#fbbf24] flex items-center justify-center text-[#0d0e14] text-[10px] font-bold">
                    {knock.displayName?.[0]?.toUpperCase() || '?'}
                  </div>
                )}
                <span className="text-xs text-[#e0e4ec] font-medium">{knock.displayName}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onAdmit(knock.guestId)}
                  className="p-1 rounded bg-[#4ade8020] hover:bg-[#4ade8030] transition-colors"
                  title="Accept"
                >
                  <Check className="w-3.5 h-3.5 text-[#4ade80]" />
                </button>
                <button
                  onClick={() => onDeny(knock.guestId)}
                  className="p-1 rounded bg-[#ff575720] hover:bg-[#ff575730] transition-colors"
                  title="Deny"
                >
                  <X className="w-3.5 h-3.5 text-[#ff5757]" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Session Manage Panel (inside popover) ────────────────────────────────────

function SessionManagePanel({
  session, guests, pendingKnocks, copied,
  onCopyLink, onAdmit, onDeny, onUpdatePermissions, onKick,
  onTerminate, onRegenerate, error, clearError,
}) {
  return (
    <div className="divide-y divide-[#1a1b24]">
      {/* Invite Link */}
      <div className="p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Link2 className="w-3.5 h-3.5 text-[#3a8574]" />
          <span className="text-[10px] text-[#5a6178] font-semibold uppercase tracking-wider">Invite Link</span>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            readOnly
            value={session?.inviteLink || ''}
            className="flex-1 bg-[#101118] border border-[#1a1b24] rounded-md px-2.5 py-1.5 text-[11px] text-[#9ba2b8] font-mono truncate focus:outline-none"
          />
          <button
            onClick={onCopyLink}
            className="p-1.5 rounded-md bg-[#101118] border border-[#1a1b24] hover:border-[#3a8574] transition-colors"
            title="Copy"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-[#4ade80]" /> : <Copy className="w-3.5 h-3.5 text-[#5a6178]" />}
          </button>
          <button
            onClick={onRegenerate}
            className="p-1.5 rounded-md bg-[#101118] border border-[#1a1b24] hover:border-[#fbbf24] transition-colors"
            title="Regenerate link"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[#5a6178]" />
          </button>
        </div>
      </div>

      {/* Pending Knocks */}
      {pendingKnocks?.length > 0 && (
        <div className="p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Bell className="w-3.5 h-3.5 text-[#fbbf24]" />
            <span className="text-[10px] text-[#fbbf24] font-semibold uppercase tracking-wider">
              Requesting Access ({pendingKnocks.length})
            </span>
          </div>
          <div className="space-y-1.5">
            {pendingKnocks.map((knock) => (
              <div
                key={knock.guestId}
                className="flex items-center justify-between p-2 bg-[#fbbf2408] border border-[#fbbf2420] rounded-lg"
              >
                <div className="flex items-center gap-2">
                  {knock.avatarUrl ? (
                    <img src={knock.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-[#fbbf24] flex items-center justify-center text-[#0d0e14] text-[9px] font-bold">
                      {knock.displayName?.[0]?.toUpperCase() || '?'}
                    </div>
                  )}
                  <span className="text-xs text-[#e0e4ec] font-medium">{knock.displayName}</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => onAdmit(knock.guestId)}
                    className="p-1 rounded bg-[#4ade8020] hover:bg-[#4ade8030] transition-colors"
                    title="Accept"
                  >
                    <Check className="w-3.5 h-3.5 text-[#4ade80]" />
                  </button>
                  <button
                    onClick={() => onDeny(knock.guestId)}
                    className="p-1 rounded bg-[#ff575720] hover:bg-[#ff575730] transition-colors"
                    title="Deny"
                  >
                    <X className="w-3.5 h-3.5 text-[#ff5757]" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Connected Guests */}
      <div className="p-3">
        <div className="flex items-center gap-1.5 mb-2">
          <Users className="w-3.5 h-3.5 text-[#3a8574]" />
          <span className="text-[10px] text-[#5a6178] font-semibold uppercase tracking-wider">
            Connected ({guests?.length || 0})
          </span>
        </div>
        {!guests || guests.length === 0 ? (
          <p className="text-[11px] text-[#5a6178] italic py-1">No guests yet — share your invite link</p>
        ) : (
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
        )}
      </div>

      {/* Terminate */}
      <div className="p-3">
        <button
          onClick={onTerminate}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-[#ff575712] hover:bg-[#ff575720] border border-[#ff575730] rounded-lg text-[#ff5757] font-semibold text-xs transition-all"
        >
          <CircleOff className="w-3.5 h-3.5" />
          Stop Sharing
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 bg-[#ff575710] text-[#ff5757] text-[11px] flex items-center justify-between">
          <span>{error}</span>
          <button onClick={clearError} className="p-0.5 rounded hover:bg-[#ff575720]">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Guest Row (compact) ──────────────────────────────────────────────────────

function GuestRow({ guest, onUpdatePermissions, onKick }) {
  const [showPerms, setShowPerms] = useState(false);

  return (
    <div className="bg-[#101118] border border-[#1a1b24] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <div className="flex items-center gap-2">
          {guest.avatarUrl ? (
            <img src={guest.avatarUrl} alt="" className="w-5 h-5 rounded-full" />
          ) : (
            <div className="w-5 h-5 rounded-full bg-[#3a8574] flex items-center justify-center text-[#0d0e14] text-[9px] font-bold">
              {guest.displayName?.[0]?.toUpperCase() || '?'}
            </div>
          )}
          <span className="text-xs text-[#e0e4ec] font-medium">{guest.displayName}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowPerms(!showPerms)}
            className="p-1 rounded hover:bg-[#1a1b24] transition-colors"
            title="Permissions"
          >
            {showPerms
              ? <Shield className="w-3.5 h-3.5 text-[#3a8574]" />
              : <ShieldOff className="w-3.5 h-3.5 text-[#5a6178]" />
            }
          </button>
          <button
            onClick={onKick}
            className="p-1 rounded hover:bg-[#ff575720] transition-colors"
            title="Remove guest"
          >
            <UserX className="w-3.5 h-3.5 text-[#5a6178] hover:text-[#ff5757]" />
          </button>
        </div>
      </div>
      {showPerms && (
        <div className="px-2.5 pb-2 space-y-1 border-t border-[#1a1b24] pt-1.5">
          {PERM_CONFIG.map(({ key, label, icon: Icon, risk }) => {
            const enabled = guest.permissions?.[key];
            return (
              <button
                key={key}
                onClick={() => onUpdatePermissions({ [key]: !enabled })}
                className={`w-full flex items-center justify-between px-2 py-1 rounded-md transition-all ${
                  enabled
                    ? 'bg-[#3a857412] border border-[#3a857425]'
                    : 'bg-[#08090d] border border-[#1a1b24]'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <Icon className={`w-3 h-3 ${enabled ? 'text-[#3a8574]' : 'text-[#5a6178]'}`} />
                  <span className={`text-[11px] font-medium ${enabled ? 'text-[#e0e4ec]' : 'text-[#5a6178]'}`}>
                    {label}
                  </span>
                  {risk === 'high' && <span className="text-[9px] text-[#ff5757]">⚠</span>}
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

// ── Guest Controls ───────────────────────────────────────────────────────────

function GuestControls({ session, permissions, onLeave }) {
  const hostName = session?.hostName || 'Host';
  const hasEdit = permissions?.canEdit;

  return (
    <div className="flex items-center gap-1.5">
      {/* Guest badge */}
      <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${
        hasEdit
          ? 'bg-[#3a857412] border-[#3a857430] text-[#3a8574]'
          : 'bg-[#fbbf2412] border-[#fbbf2430] text-[#fbbf24]'
      }`}>
        {hasEdit
          ? <Edit3 className="w-3 h-3" />
          : <Eye className="w-3 h-3" />
        }
        <span className="text-[11px] font-semibold">
          {hostName}
        </span>
      </div>

      {/* Permission pills */}
      <div className="hidden sm:flex items-center gap-0.5">
        {PERM_CONFIG.map(({ key, icon: Icon, label }) => (
          <div
            key={key}
            className={`p-1 rounded ${
              permissions?.[key]
                ? 'text-[#3a8574] bg-[#3a857410]'
                : 'text-[#5a617840]'
            }`}
            title={`${label}: ${permissions?.[key] ? 'Granted' : 'Denied'}`}
          >
            <Icon className="w-3 h-3" />
          </div>
        ))}
      </div>

      {/* Leave button */}
      <button
        onClick={onLeave}
        className="flex items-center gap-1 px-2 py-1 rounded-lg
                   bg-[#ff575712] border border-[#ff575730]
                   hover:bg-[#ff575720] text-[#ff5757]
                   transition-all text-[11px] font-medium"
        title="Leave session"
      >
        <LogOut className="w-3 h-3" />
        Leave
      </button>
    </div>
  );
}

// ── Knocking Indicator ───────────────────────────────────────────────────────

function KnockingIndicator({ onCancel }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-[#fbbf2410] border border-[#fbbf2430]">
      <div className="w-3 h-3 border-2 border-[#fbbf24] border-t-transparent rounded-full animate-spin" />
      <span className="text-[11px] text-[#fbbf24] font-medium">Waiting…</span>
      <button
        onClick={onCancel}
        className="p-0.5 rounded hover:bg-[#fbbf2420] transition-colors"
        title="Cancel"
      >
        <X className="w-3 h-3 text-[#fbbf24]" />
      </button>
    </div>
  );
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function MiniToggle({ enabled }) {
  return (
    <div className={`w-7 h-3.5 rounded-full relative transition-colors flex-shrink-0 ${
      enabled ? 'bg-[#3a8574]' : 'bg-[#2a2b38]'
    }`}>
      <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform ${
        enabled ? 'translate-x-3.5' : 'translate-x-0.5'
      }`} />
    </div>
  );
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
