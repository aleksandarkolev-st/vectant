"use client";

import React, { useState, useCallback } from 'react';
import { useCollabSession } from '@/hooks/useCollabSession';
import {
  Users, Link2, Copy, Check, X, Shield, ShieldOff,
  Terminal, GitBranch, FileEdit, FolderEdit, UserX,
  Radio, RadioOff, ChevronDown, ChevronUp, Bell,
  RefreshCw
} from 'lucide-react';

/**
 * Permission toggle labels and icons.
 */
const PERM_CONFIG = [
  { key: 'canEdit',     label: 'Edit Code',     icon: FileEdit,   risk: 'low',    desc: 'Allow editing files via Yjs' },
  { key: 'canFileOps',  label: 'File Ops',       icon: FolderEdit, risk: 'medium', desc: 'Create, delete, rename files' },
  { key: 'canTerminal', label: 'Terminal',        icon: Terminal,   risk: 'high',   desc: 'Run commands in the terminal' },
  { key: 'canGit',      label: 'Git Control',     icon: GitBranch,  risk: 'high',   desc: 'Commit, push, pull, checkout' },
];

const RISK_COLORS = {
  low:    'text-[#4ade80]',
  medium: 'text-[#fbbf24]',
  high:   'text-[#ff5757]',
};

/**
 * SessionControlPanel — Host's floating widget for managing a live session.
 *
 * Shows:
 *   - Live indicator with guest count
 *   - Invite link (copy to clipboard)
 *   - Pending knock requests (accept / deny)
 *   - Connected guests with per-user permission toggles
 *   - Terminate Session button
 */
export default function SessionControlPanel({ slug }) {
  const {
    role, session, guests, pendingKnocks, isHost,
    createSession, admitGuest, denyKnock, updatePermissions,
    kickGuest, terminateSession, regenerateInvite, error,
  } = useCollabSession();

  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // ── Create session ─────────────────────────────────────────────────────

  const handleCreate = useCallback(async (defaultPerms) => {
    // TODO: get userId from auth context
    const userId = typeof window !== 'undefined' ? localStorage.getItem('synthi-user-id') || 'host' : 'host';
    const userName = typeof window !== 'undefined' ? localStorage.getItem('synthi-user-name') || 'Host' : 'Host';
    await createSession({
      hostId: userId,
      hostName: userName,
      slug,
      defaultPerms,
    });
    setShowCreate(false);
    setExpanded(true);
  }, [createSession, slug]);

  // ── Copy invite link ──────────────────────────────────────────────────

  const handleCopyLink = useCallback(async () => {
    if (!session?.inviteLink) return;
    try {
      await navigator.clipboard.writeText(session.inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
  }, [session?.inviteLink]);

  // ── Not hosting: show "Share Session" button ──────────────────────────

  if (role === 'idle' && !showCreate) {
    return (
      <button
        onClick={() => setShowCreate(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#101118] border border-[#1a1b24] hover:border-[#3a8574] hover:bg-[#3a857410] text-[#9ba2b8] hover:text-[#e0e4ec] transition-all text-sm font-medium"
      >
        <Users className="w-4 h-4" />
        Share Session
      </button>
    );
  }

  // ── Create session modal ──────────────────────────────────────────────

  if (showCreate && !isHost) {
    return <CreateSessionModal onClose={() => setShowCreate(false)} onCreate={handleCreate} />;
  }

  // ── Active session panel ──────────────────────────────────────────────

  if (!isHost) return null;

  return (
    <div className="flex flex-col bg-[#0d0e14] border border-[#ff575780] rounded-xl shadow-2xl shadow-red-500/5 overflow-hidden min-w-[320px] max-w-[380px]">
      {/* ── Header: Live indicator ──────────────────────────────────── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center justify-between px-4 py-3 bg-[#0d0e14] hover:bg-[#101118] transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="relative">
            <Radio className="w-4 h-4 text-[#ff5757]" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-[#ff5757] rounded-full animate-pulse" />
          </div>
          <span className="text-[#ff5757] font-semibold text-sm">
            LIVE
          </span>
          <span className="text-[#5a6178] text-sm">
            {guests.length} Guest{guests.length !== 1 ? 's' : ''}
          </span>
          {pendingKnocks.length > 0 && (
            <span className="flex items-center gap-1 px-2 py-0.5 bg-[#fbbf2420] rounded-full text-[#fbbf24] text-xs font-medium animate-pulse">
              <Bell className="w-3 h-3" />
              {pendingKnocks.length}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-[#5a6178]" />
        ) : (
          <ChevronDown className="w-4 h-4 text-[#5a6178]" />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col divide-y divide-[#1a1b24]">
          {/* ── Invite Link ──────────────────────────────────────────── */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Link2 className="w-4 h-4 text-[#3a8574]" />
              <span className="text-xs text-[#5a6178] font-medium uppercase tracking-wider">Invite Link</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={session?.inviteLink || ''}
                className="flex-1 bg-[#101118] border border-[#1a1b24] rounded-md px-3 py-1.5 text-xs text-[#9ba2b8] font-mono truncate focus:outline-none"
              />
              <button
                onClick={handleCopyLink}
                className="p-1.5 rounded-md bg-[#101118] border border-[#1a1b24] hover:border-[#3a8574] transition-colors"
                title="Copy invite link"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-[#4ade80]" />
                ) : (
                  <Copy className="w-4 h-4 text-[#5a6178]" />
                )}
              </button>
              <button
                onClick={regenerateInvite}
                className="p-1.5 rounded-md bg-[#101118] border border-[#1a1b24] hover:border-[#fbbf24] transition-colors"
                title="Regenerate invite link"
              >
                <RefreshCw className="w-4 h-4 text-[#5a6178]" />
              </button>
            </div>
          </div>

          {/* ── Pending Knocks ───────────────────────────────────────── */}
          {pendingKnocks.length > 0 && (
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Bell className="w-4 h-4 text-[#fbbf24]" />
                <span className="text-xs text-[#fbbf24] font-medium uppercase tracking-wider">Requesting Access</span>
              </div>
              <div className="space-y-2">
                {pendingKnocks.map((knock) => (
                  <div key={knock.guestId} className="flex items-center justify-between p-2 bg-[#fbbf2408] border border-[#fbbf2420] rounded-lg">
                    <div className="flex items-center gap-2">
                      {knock.avatarUrl ? (
                        <img src={knock.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-[#fbbf24] flex items-center justify-center text-[#0d0e14] text-xs font-bold">
                          {knock.displayName?.[0]?.toUpperCase() || '?'}
                        </div>
                      )}
                      <span className="text-sm text-[#e0e4ec] font-medium">{knock.displayName}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => admitGuest(knock.guestId)}
                        className="p-1 rounded bg-[#4ade8020] hover:bg-[#4ade8030] transition-colors"
                        title="Allow"
                      >
                        <Check className="w-4 h-4 text-[#4ade80]" />
                      </button>
                      <button
                        onClick={() => denyKnock(knock.guestId)}
                        className="p-1 rounded bg-[#ff575720] hover:bg-[#ff575730] transition-colors"
                        title="Deny"
                      >
                        <X className="w-4 h-4 text-[#ff5757]" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Connected Guests ─────────────────────────────────────── */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-4 h-4 text-[#3a8574]" />
              <span className="text-xs text-[#5a6178] font-medium uppercase tracking-wider">Connected Guests</span>
            </div>
            {guests.length === 0 ? (
              <p className="text-xs text-[#5a6178] italic py-2">No guests connected yet</p>
            ) : (
              <div className="space-y-3">
                {guests.map((guest) => (
                  <GuestCard
                    key={guest.guestId}
                    guest={guest}
                    onUpdatePermissions={(perms) => updatePermissions(guest.guestId, perms)}
                    onKick={() => kickGuest(guest.guestId)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ── Terminate Button ──────────────────────────────────────── */}
          <div className="px-4 py-3">
            <button
              onClick={terminateSession}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-[#ff575715] hover:bg-[#ff575725] border border-[#ff575740] rounded-lg text-[#ff5757] font-semibold text-sm transition-all"
            >
              <RadioOff className="w-4 h-4" />
              Stop Sharing
            </button>
          </div>

          {/* ── Error display ─────────────────────────────────────────── */}
          {error && (
            <div className="px-4 py-2 bg-[#ff575710] text-[#ff5757] text-xs">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Guest Card with permission toggles ──────────────────────────────────────

function GuestCard({ guest, onUpdatePermissions, onKick }) {
  const [showPerms, setShowPerms] = useState(false);

  const handleToggle = (key) => {
    onUpdatePermissions({ [key]: !guest.permissions[key] });
  };

  return (
    <div className="bg-[#101118] border border-[#1a1b24] rounded-lg overflow-hidden">
      {/* Guest header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          {guest.avatarUrl ? (
            <img src={guest.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-[#3a8574] flex items-center justify-center text-[#0d0e14] text-xs font-bold">
              {guest.displayName?.[0]?.toUpperCase() || '?'}
            </div>
          )}
          <span className="text-sm text-[#e0e4ec] font-medium">{guest.displayName}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowPerms(!showPerms)}
            className="p-1 rounded hover:bg-[#1a1b24] transition-colors"
            title="Permissions"
          >
            {showPerms ? (
              <Shield className="w-4 h-4 text-[#3a8574]" />
            ) : (
              <ShieldOff className="w-4 h-4 text-[#5a6178]" />
            )}
          </button>
          <button
            onClick={onKick}
            className="p-1 rounded hover:bg-[#ff575720] transition-colors"
            title="Remove guest"
          >
            <UserX className="w-4 h-4 text-[#5a6178] hover:text-[#ff5757]" />
          </button>
        </div>
      </div>

      {/* Permission toggles (expandable) */}
      {showPerms && (
        <div className="px-3 pb-3 space-y-2 border-t border-[#1a1b24] pt-2">
          {PERM_CONFIG.map(({ key, label, icon: Icon, risk, desc }) => {
            const enabled = guest.permissions[key];
            return (
              <button
                key={key}
                onClick={() => handleToggle(key)}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-md transition-all ${
                  enabled
                    ? 'bg-[#3a857415] border border-[#3a857430]'
                    : 'bg-[#08090d] border border-[#1a1b24] hover:border-[#2a2b38]'
                }`}
                title={desc}
              >
                <div className="flex items-center gap-2">
                  <Icon className={`w-3.5 h-3.5 ${enabled ? 'text-[#3a8574]' : 'text-[#5a6178]'}`} />
                  <span className={`text-xs font-medium ${enabled ? 'text-[#e0e4ec]' : 'text-[#5a6178]'}`}>
                    {label}
                  </span>
                  <span className={`text-[10px] ${RISK_COLORS[risk]}`}>
                    {risk === 'high' && '⚠'}
                  </span>
                </div>
                <div className={`w-8 h-4 rounded-full relative transition-colors ${
                  enabled ? 'bg-[#3a8574]' : 'bg-[#2a2b38]'
                }`}>
                  <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
                    enabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Create Session Modal ────────────────────────────────────────────────────

function CreateSessionModal({ onClose, onCreate }) {
  const [perms, setPerms] = useState({
    canEdit: true,
    canTerminal: false,
    canGit: false,
    canFileOps: false,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#0d0e14] border border-[#1a1b24] rounded-2xl shadow-2xl p-6 w-[400px]">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-[#e0e4ec] flex items-center gap-2">
            <Users className="w-5 h-5 text-[#3a8574]" />
            Share Session
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#1a1b24]">
            <X className="w-5 h-5 text-[#5a6178]" />
          </button>
        </div>

        <p className="text-sm text-[#5a6178] mb-4">
          Set default permissions for guests who join your session.
          You can change these per-user after they connect.
        </p>

        <div className="space-y-2 mb-6">
          {PERM_CONFIG.map(({ key, label, icon: Icon, risk, desc }) => (
            <button
              key={key}
              onClick={() => setPerms(p => ({ ...p, [key]: !p[key] }))}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-all ${
                perms[key]
                  ? 'bg-[#3a857415] border border-[#3a857430]'
                  : 'bg-[#101118] border border-[#1a1b24] hover:border-[#2a2b38]'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`w-4 h-4 ${perms[key] ? 'text-[#3a8574]' : 'text-[#5a6178]'}`} />
                <div className="text-left">
                  <span className={`text-sm font-medium ${perms[key] ? 'text-[#e0e4ec]' : 'text-[#5a6178]'}`}>
                    {label}
                  </span>
                  <p className="text-xs text-[#5a6178]">{desc}</p>
                </div>
                {risk === 'high' && (
                  <span className="text-xs text-[#ff5757] bg-[#ff575710] px-1.5 py-0.5 rounded">High Risk</span>
                )}
              </div>
              <div className={`w-9 h-5 rounded-full relative transition-colors ${
                perms[key] ? 'bg-[#3a8574]' : 'bg-[#2a2b38]'
              }`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  perms[key] ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={() => onCreate(perms)}
          className="w-full py-2.5 bg-[#3a8574] hover:bg-[#327464] text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
        >
          <Radio className="w-4 h-4" />
          Start Sharing
        </button>
      </div>
    </div>
  );
}
