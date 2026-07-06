"use client";

import React, { useState, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useCollabSession } from '@/hooks/useCollabSession';
import {
  Users, Link2, Copy, Check, X, Shield, ShieldOff,
  Terminal, GitBranch, FileEdit, FolderEdit, UserX,
  Radio, ChevronDown, ChevronUp, Bell,
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
  low:    'text-[var(--accent-success)]',
  medium: 'text-[var(--accent-warning)]',
  high:   'text-[var(--accent-danger)]',
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
  const { data: authSession } = useSession();
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
      defaultPerms,
    });
    setShowCreate(false);
    setExpanded(true);
  }, [createSession, slug, authSession]);

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
        className="th-focus-ring th-btn-ghost flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-3 py-1.5 text-sm font-medium"
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

  // CRITICAL: This panel is ONLY for the session Host.
  // A non-host must NEVER see the approval / management UI.
  if (!isHost || role !== 'hosting') return null;

  return (
    <div className="vt-dialog-surface flex min-w-[320px] max-w-[380px] flex-col overflow-hidden">
      {/* ── Header: Live indicator ──────────────────────────────────── */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="vt-command-item flex items-center justify-between rounded-none px-4 py-3"
      >
        <div className="flex items-center gap-3">
          <div className="relative">
            <Radio className="w-4 h-4 text-[var(--accent-danger)]" />
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-[var(--accent-danger)]" />
          </div>
          <span className="text-sm font-semibold text-[var(--accent-danger)]">
            LIVE
          </span>
          <span className="text-sm text-[var(--text-muted)]">
            {guests.length} Guest{guests.length !== 1 ? 's' : ''}
          </span>
          {pendingKnocks.length > 0 && (
            <span className="vt-workflow-chip animate-pulse text-xs" style={{ '--chip-color': 'var(--accent-warning)' }}>
              <Bell className="w-3 h-3" />
              {pendingKnocks.length}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-[var(--text-muted)]" />
        ) : (
          <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col divide-y divide-[var(--border-subtle)]">
          {/* ── Invite Link ──────────────────────────────────────────── */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 mb-2">
              <Link2 className="w-4 h-4 text-[var(--accent-secondary)]" />
              <span className="vt-panel-kicker">Invite Link</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={session?.inviteLink || ''}
                className="th-input flex-1 truncate rounded-[var(--radius-control)] border px-3 py-1.5 font-mono text-xs focus:outline-none"
              />
              <button
                onClick={handleCopyLink}
                className={`vt-icon-button th-focus-ring h-8 min-w-8 ${copied ? 'th-btn-active' : ''}`}
                title="Copy invite link"
              >
                {copied ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
              <button
                onClick={regenerateInvite}
                className="vt-icon-button th-focus-ring h-8 min-w-8"
                title="Regenerate invite link"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* ── Pending Knocks ───────────────────────────────────────── */}
          {pendingKnocks.length > 0 && (
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <Bell className="w-4 h-4 text-[var(--accent-warning)]" />
                <span className="vt-panel-kicker text-[var(--accent-warning)]">Requesting Access</span>
              </div>
              <div className="space-y-2">
                {pendingKnocks.map((knock) => (
                  <div key={knock.guestId} className="vt-workflow-alert flex items-center justify-between p-2">
                    <div className="flex items-center gap-2">
                      {knock.avatarUrl ? (
                        <img src={knock.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                      ) : (
                        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent-warning)] text-xs font-bold text-[var(--bg-app)]">
                          {knock.displayName?.[0]?.toUpperCase() || '?'}
                        </div>
                      )}
                      <span className="text-sm font-medium text-[var(--text-primary)]">{knock.displayName}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => admitGuest(knock.guestId)}
                        className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-success)]"
                        title="Allow"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => denyKnock(knock.guestId)}
                        className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-danger)]"
                        title="Deny"
                      >
                        <X className="w-4 h-4" />
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
              <Users className="w-4 h-4 text-[var(--accent-secondary)]" />
              <span className="vt-panel-kicker">Connected Guests</span>
            </div>
            {guests.length === 0 ? (
              <p className="py-2 text-xs italic text-[var(--text-muted)]">No guests connected yet</p>
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
              className="th-focus-ring th-btn-ghost flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] border px-4 py-2 text-sm font-semibold text-[var(--accent-danger)]"
              style={{ borderColor: 'color-mix(in srgb, var(--accent-danger) 32%, transparent)' }}
            >
              <X className="w-4 h-4" />
              Stop Sharing
            </button>
          </div>

          {/* ── Error display ─────────────────────────────────────────── */}
          {error && (
            <div className="vt-workflow-alert vt-workflow-alert--danger rounded-none border-x-0 border-b-0 px-4 py-2 text-xs text-[var(--accent-danger)]">
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
    <div className="vt-workflow-card overflow-hidden">
      {/* Guest header */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          {guest.avatarUrl ? (
            <img src={guest.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
          ) : (
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent-secondary)] text-xs font-bold text-[var(--bg-app)]">
              {guest.displayName?.[0]?.toUpperCase() || '?'}
            </div>
          )}
          <span className="text-sm font-medium text-[var(--text-primary)]">{guest.displayName}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowPerms(!showPerms)}
            className={`vt-icon-button th-focus-ring h-7 min-w-7 ${showPerms ? 'th-btn-active' : ''}`}
            title="Permissions"
          >
            {showPerms ? (
              <Shield className="w-4 h-4" />
            ) : (
              <ShieldOff className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={onKick}
            className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-danger)]"
            title="Remove guest"
          >
            <UserX className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Permission toggles (expandable) */}
      {showPerms && (
        <div className="space-y-2 border-t border-[var(--border-subtle)] px-3 pb-3 pt-2">
          {PERM_CONFIG.map(({ key, label, icon: Icon, risk, desc }) => {
            const enabled = guest.permissions[key];
            return (
              <button
                key={key}
                onClick={() => handleToggle(key)}
                className={`th-focus-ring flex w-full items-center justify-between rounded-[var(--radius-control)] border px-2.5 py-1.5 transition-all ${enabled ? 'th-btn-active' : 'th-btn-ghost border-[var(--border-subtle)]'}`}
                title={desc}
              >
                <div className="flex items-center gap-2">
                  <Icon className="w-3.5 h-3.5" />
                  <span className="text-xs font-medium">
                    {label}
                  </span>
                  <span className={`text-[10px] ${RISK_COLORS[risk]}`}>
                    {risk === 'high' && '⚠'}
                  </span>
                </div>
                <div className={`relative h-4 w-8 rounded-full transition-colors ${enabled ? 'th-toggle-on' : 'th-toggle-off'}`}>
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
    canFileOps: true,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,black_68%,transparent)] backdrop-blur-sm">
      <div className="vt-dialog-surface w-[400px] p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text-primary)]">
            <Users className="w-5 h-5 text-[var(--attention-purple)]" />
            Share Session
          </h2>
          <button onClick={onClose} className="vt-icon-button th-focus-ring h-8 min-w-8">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="mb-4 text-sm text-[var(--text-muted)]">
          Set default permissions for guests who join your session.
          You can change these per-user after they connect.
        </p>

        <div className="space-y-2 mb-6">
          {PERM_CONFIG.map(({ key, label, icon: Icon, risk, desc }) => (
            <button
              key={key}
              onClick={() => setPerms(p => ({ ...p, [key]: !p[key] }))}
              className={`th-focus-ring flex w-full items-center justify-between rounded-[var(--radius-control)] border px-3 py-2.5 transition-all ${perms[key] ? 'th-btn-active' : 'th-btn-ghost border-[var(--border-subtle)]'}`}
            >
              <div className="flex items-center gap-3">
                <Icon className="w-4 h-4" />
                <div className="text-left">
                  <span className="text-sm font-medium">
                    {label}
                  </span>
                  <p className="text-xs text-[var(--text-muted)]">{desc}</p>
                </div>
                {risk === 'high' && (
                  <span className="vt-workflow-chip text-xs" style={{ '--chip-color': 'var(--accent-danger)' }}>High Risk</span>
                )}
              </div>
              <div className={`relative h-5 w-9 rounded-full transition-colors ${perms[key] ? 'th-toggle-on' : 'th-toggle-off'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                  perms[key] ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </div>
            </button>
          ))}
        </div>

        <button
          onClick={() => onCreate(perms)}
          className="th-focus-ring th-btn-primary flex w-full items-center justify-center gap-2 py-2.5 font-semibold"
        >
          <Radio className="w-4 h-4" />
          Start Sharing
        </button>
      </div>
    </div>
  );
}
