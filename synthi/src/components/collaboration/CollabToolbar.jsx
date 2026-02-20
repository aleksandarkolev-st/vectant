"use client";

import React, { useState, useCallback, useEffect } from 'react';
import { usePresence } from '@/hooks/usePresence';
import { useCollabSession } from '@/hooks/useCollabSession';
import collabSessionService from '@/services/collabSessionService';
import getInitials from '@/utils/getInitials';
import ShareModal from './ShareModal';
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
export default function CollabToolbar({ slug }) {
  const users = usePresence(slug);
  const {
    role, session, guests, pendingKnocks, permissions,
    isHost, isGuest, isKnocking, isActive,
    admitGuest, denyKnock, leaveSession,
  } = useCollabSession();

  const [shareModalOpen, setShareModalOpen] = useState(false);

  // ── Listen for global "open popup" requests (from toast actions, etc.) ──
  useEffect(() => {
    const handler = () => setShareModalOpen(true);
    collabSessionService.addEventListener('popup:requestOpen', handler);
    return () => collabSessionService.removeEventListener('popup:requestOpen', handler);
  }, []);

  const openModal = useCallback(() => setShareModalOpen(true), []);

  const knockCount = pendingKnocks?.length || 0;

  return (
    <div className="flex items-center gap-2">
      {/* ── Presence Avatars ────────────────────────────────────────── */}
      <PresenceAvatars users={users} />

      {/* ── Role Badges ──────────────────────────────────────────────── */}
      {role === 'idle' && (
        <ShareButton onClick={openModal} />
      )}

      {isHost && (
        <div className="flex items-center gap-1.5">
          {/* LIVE badge — opens modal */}
          <button onClick={openModal}
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#ff575712] border border-[#ff575730] hover:bg-[#ff575720] transition-all"
            title="Manage session">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#ff5757] opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-[#ff5757]" />
            </span>
            <span className="text-[11px] font-bold text-[#ff5757] tracking-wide">LIVE</span>
            {(guests?.length || 0) > 0 && (
              <span className="text-[10px] text-[#ff5757] opacity-60">·{guests.length}</span>
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
            className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border transition-all ${
              permissions?.canEdit
                ? 'bg-[#3a857412] border-[#3a857430] text-[#3a8574] hover:bg-[#3a857420]'
                : 'bg-[#fbbf2412] border-[#fbbf2430] text-[#fbbf24] hover:bg-[#fbbf2420]'
            }`}
            title="Session details">
            {permissions?.canEdit ? <Edit3 className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            <span className="text-[11px] font-semibold">{session?.hostName || 'Host'}</span>
          </button>

          {/* Leave button */}
          <button onClick={leaveSession}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-[#ff575712] border border-[#ff575730] hover:bg-[#ff575720] text-[#ff5757] transition-all text-[11px] font-medium"
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
