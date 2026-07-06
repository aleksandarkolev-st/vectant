"use client";

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { usePresence } from '@/hooks/usePresence';
import { useCollabSession } from '@/hooks/useCollabSession';
import collabSessionService from '@/services/collabSessionService';
import getInitials from '@/utils/getInitials';
import { getCurrentUser } from '@/services/userIdentity';
import ShareModal from './ShareModal';
import MissedEventsTray from './MissedEventsTray';
import FileVersionsPanel from './FileVersionsPanel';
import {
  Users, Check, X, Bell, Share2, LogOut, Eye, Edit3
} from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

// ── Main CollabToolbar ────────────────────────────────────────────────────────

/**
 * CollabToolbar — Top-bar collaboration widget.
 *
 * Compact indicators + the unified ShareModal. The toolbar shows:
 *   - Presence avatars
 *   - Role-specific badge (LIVE, host badge, knocking spinner)
 *   - Quick knock accept/deny popover
 *   - A single button that opens the unified ShareModal
 *
 * All session management (invite link, permissions, guests, etc.)
 * lives inside ShareModal.
 */
export default function CollabToolbar({ slug, filePath }) {
  const users = usePresence(slug);
  const {
    role, session, guests, pendingKnocks, permissions,
    isHost, isGuest, isKnocking, isActive,
    admitGuest, denyKnock, leaveSession,
  } = useCollabSession();

  // Merge awareness-based users with session participants so ALL members
  // always appear in the toolbar, even if they're not actively typing.
  const allUsers = useMemo(() => {
    const merged = new Map();

    // 1. Start with awareness users (have real-time presence data)
    for (const entry of users) {
      const id = entry.user?.id;
      if (id) merged.set(id, entry);
    }

    // 2. Add session participants that aren't already in awareness
    if (session && (isHost || isGuest)) {
      const currentUser = getCurrentUser();
      // Add host
      if (session.hostId && !merged.has(session.hostId)) {
        merged.set(session.hostId, {
          clientId: `session-host-${session.hostId}`,
          user: {
            id: session.hostId,
            name: session.hostName || 'Host',
            color: 'var(--accent-danger)',
            image: session.hostAvatar || null,
          },
        });
      }
      // Add guests
      if (guests && guests.length > 0) {
        for (const g of guests) {
          if (g.guestId && !merged.has(g.guestId)) {
            merged.set(g.guestId, {
              clientId: `session-guest-${g.guestId}`,
              user: {
                id: g.guestId,
                name: g.displayName || 'Guest',
                color: 'var(--accent-secondary)',
                image: g.avatarUrl || null,
              },
            });
          }
        }
      }
    }

    return Array.from(merged.values());
  }, [users, session, guests, isHost, isGuest]);

  const [shareModalOpen, setShareModalOpen] = useState(false);

  // ── Listen for global "open popup" requests (from toast actions, etc.) ──
  useEffect(() => {
    const handler = () => setShareModalOpen(true);
    collabSessionService.addEventListener('popup:requestOpen', handler);
    return () => collabSessionService.removeEventListener('popup:requestOpen', handler);
  }, []);

  // ── Keyboard shortcut: Ctrl+Shift+K to toggle ShareModal ──
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'K') {
        e.preventDefault();
        setShareModalOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const openModal = useCallback(() => setShareModalOpen(true), []);

  const knockCount = pendingKnocks?.length || 0;

  return (
    <div className="flex items-center gap-2">

      {/* ── Missed-while-offline tray ────────────────────────────────── */}
      <MissedEventsTray />

      {/* ── Per-file version history + restore ──────────────────────── */}
      <FileVersionsPanel slug={slug} filePath={filePath} />

      {/* ── Presence Avatars ────────────────────────────────────────── */}
      <PresenceAvatars users={allUsers} />
      
      {/* ── Role Badges ──────────────────────────────────────────────── */}
      {role === 'idle' && (
        <ShareButton onClick={openModal} />
      )}

      {isHost && (
        <div className="flex items-center gap-1.5">
          {/* LIVE badge — opens modal */}
          <button onClick={openModal}
            className="vt-workflow-chip th-focus-ring"
            style={{ '--chip-color': 'var(--accent-danger)' }}
            title="Manage session (Ctrl+Shift+K)">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent-danger)] opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent-danger)]" />
            </span>
            <span className="text-[11px] font-bold tracking-wide">LIVE</span>
            {(guests?.length || 0) > 0 && (
              <span className="text-[10px] opacity-70">·{guests.length}</span>
            )}
          </button>

          {/* Pending knocks — quick accept/deny popover */}
          {knockCount > 0 && (
            <KnockBadge knocks={pendingKnocks} onAdmit={admitGuest} onDeny={denyKnock} />
          )}
        </div>
      )}

      {isGuest && (
        <div className="flex items-center gap-1.5">
          {/* Guest badge — opens modal */}
          <button onClick={openModal}
            className="vt-workflow-chip th-focus-ring"
            style={{ '--chip-color': permissions?.canEdit ? 'var(--accent-secondary)' : 'var(--accent-warning)' }}
            title="Session details">
            {permissions?.canEdit ? <Edit3 className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            <span className="text-[11px] font-semibold">{session?.hostName || 'Host'}</span>
          </button>

          {/* Leave button */}
          <button onClick={leaveSession}
            className="vt-workflow-chip th-focus-ring text-[11px]"
            style={{ '--chip-color': 'var(--accent-danger)' }}
            title="Leave session">
            <LogOut className="w-3 h-3" />
            Leave
          </button>
        </div>
      )}

      {isKnocking && (
        <KnockingIndicator onCancel={leaveSession} />
      )}

      {/* ── Share Modal (unified popup) ──────────────────────────────── */}
      <ShareModal
        slug={slug}
        open={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
      />
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
      <span className="text-[11px] px-2.5 py-1 rounded-full border" style={{ color: 'var(--text-muted)', background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}>
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
                     text-[10px] font-semibold
                     border-2 ml-0.5 select-none z-10"
          style={{ color: 'var(--text-secondary)', background: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
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
        className={`${dim} rounded-full flex items-center justify-center border-2 overflow-hidden`}
        style={{ borderColor: color || 'var(--accent-secondary)', background: 'var(--bg-panel)' }}
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
            style={{ color: color || 'var(--accent-secondary)' }}
          >
            {initials}
          </span>
        )}
      </div>
      {/* Tooltip */}
      <div
        className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2
                   mb-2 px-2 py-1 rounded text-[10px] font-medium whitespace-nowrap
                   border opacity-0 group-hover:opacity-100 transition-opacity z-50
                   shadow-lg"
        style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', borderColor: 'var(--border-medium)' }}
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
      className="th-focus-ring th-btn-ghost flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-2.5 py-1 text-[11px] font-medium"
      title="Start a collaboration session (Ctrl+Shift+K)"
    >
      <Share2 className="w-3.5 h-3.5" />
      Share
    </button>
  );
}

// ── Knock Badge (quick accept/deny from top bar) ─────────────────────────────

function KnockBadge({ knocks, onAdmit, onDeny }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="vt-workflow-chip th-focus-ring relative"
          style={{ '--chip-color': 'var(--accent-warning)' }}
          title={`${knocks.length} request${knocks.length > 1 ? 's' : ''} to join`}
        >
          <Bell className="w-3.5 h-3.5" />
          <span className="text-[11px] font-bold">{knocks.length}</span>
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--accent-warning)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="vt-command-popover w-[280px] p-3"
        align="end"
      >
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-warning)]">
          <Bell className="w-3.5 h-3.5" />
          Requesting Access
        </div>
        <div className="space-y-2">
          {knocks.map((knock) => (
            <div
              key={knock.guestId}
              className="vt-workflow-card flex items-center justify-between p-2"
            >
              <div className="flex items-center gap-2">
                {knock.avatarUrl ? (
                  <img src={knock.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                ) : (
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--accent-warning)] text-[10px] font-bold text-[var(--bg-app)]">
                    {knock.displayName?.[0]?.toUpperCase() || '?'}
                  </div>
                )}
                <span className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>{knock.displayName}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onAdmit(knock.guestId)}
                  className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-success)]"
                  aria-label={`Admit ${knock.displayName}`}
                  title="Accept"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onDeny(knock.guestId)}
                  className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--accent-danger)]"
                  aria-label={`Deny ${knock.displayName}`}
                  title="Deny"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── Knocking Indicator ───────────────────────────────────────────────────────

function KnockingIndicator({ onCancel }) {
  return (
    <div className="vt-workflow-chip flex items-center gap-2" style={{ '--chip-color': 'var(--accent-warning)' }}>
      <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent-warning)] border-t-transparent" />
      <span className="text-[11px] font-medium">Waiting…</span>
      <button
        onClick={onCancel}
        className="vt-icon-button th-focus-ring h-6 min-w-6"
        aria-label="Cancel knock"
        title="Cancel"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
