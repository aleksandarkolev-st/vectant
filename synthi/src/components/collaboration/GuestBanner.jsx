"use client";

import React, { useEffect, useState } from 'react';
import { useCollabSession, useSessionPermissions } from '@/hooks/useCollabSession';
import collabSessionService from '@/services/collabSessionService';
import {
  Eye, Edit3, LogOut, Shield, Terminal, GitBranch,
  FileEdit, FolderEdit, X, AlertTriangle
} from 'lucide-react';

/**
 * GuestBanner — Persistent top banner shown when a user is viewing
 * another user's session as a Guest.
 *
 * Visual indicators:
 *   - Orange border around the IDE (applied via parent className)
 *   - "Viewing X's Session" with permission summary
 *   - "Leave Session" button
 *
 * Also handles:
 *   - "Waiting for approval" state (knocking)
 *   - "Kicked from session" notification
 *   - "Session terminated" notification
 */
export default function GuestBanner() {
  const { role, session, permissions, isGuest, isKnocking, leaveSession } = useCollabSession();
  const [kicked, setKicked] = useState(false);
  const [terminated, setTerminated] = useState(false);
  const [denied, setDenied] = useState(false);

  // Listen for kick / termination events
  useEffect(() => {
    const unsubs = [
      collabSessionService.on('session:kicked', () => setKicked(true)),
      collabSessionService.on('session:terminated', () => setTerminated(true)),
      collabSessionService.on('knock:denied', () => setDenied(true)),
    ];
    return () => unsubs.forEach(fn => fn());
  }, []);

  // ── Kicked notification ───────────────────────────────────────────────

  if (kicked) {
    return (
      <div className="flex items-center justify-between px-4 py-2 bg-[#ff575720] border-b-2 border-[#ff5757]">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-[#ff5757]" />
          <span className="text-sm text-[#ff5757] font-semibold">
            You have been removed from the session.
          </span>
        </div>
        <button
          onClick={() => setKicked(false)}
          className="p-1 rounded hover:bg-[#ff575730] transition-colors"
        >
          <X className="w-4 h-4 text-[#ff5757]" />
        </button>
      </div>
    );
  }

  // ── Session terminated notification ────────────────────────────────────

  if (terminated) {
    return (
      <div className="flex items-center justify-between px-4 py-2 bg-[#fbbf2420] border-b-2 border-[#fbbf24]">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-[#fbbf24]" />
          <span className="text-sm text-[#fbbf24] font-semibold">
            The host ended the session.
          </span>
        </div>
        <button
          onClick={() => setTerminated(false)}
          className="p-1 rounded hover:bg-[#fbbf2430] transition-colors"
        >
          <X className="w-4 h-4 text-[#fbbf24]" />
        </button>
      </div>
    );
  }

  // ── Knock denied ──────────────────────────────────────────────────────

  if (denied) {
    return (
      <div className="flex items-center justify-between px-4 py-2 bg-[#ff575715] border-b-2 border-[#ff5757]">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#ff5757]" />
          <span className="text-sm text-[#ff5757] font-medium">
            Your request to join was denied.
          </span>
        </div>
        <button
          onClick={() => setDenied(false)}
          className="p-1 rounded hover:bg-[#ff575720] transition-colors"
        >
          <X className="w-4 h-4 text-[#ff5757]" />
        </button>
      </div>
    );
  }

  // ── Knocking (waiting for approval) ───────────────────────────────────

  if (isKnocking) {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#fbbf2410] border-b-2 border-[#fbbf24] animate-pulse">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-[#fbbf24] border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-[#fbbf24] font-medium">
            Waiting for the host to accept your request…
          </span>
        </div>
        <button
          onClick={leaveSession}
          className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-[#fbbf2415] hover:bg-[#fbbf2425] text-[#fbbf24] text-sm font-medium transition-colors"
        >
          <X className="w-3.5 h-3.5" />
          Cancel
        </button>
      </div>
    );
  }

  // ── Active guest view ─────────────────────────────────────────────────

  if (!isGuest) return null;

  const hostName = session?.hostName || 'Host';
  const hasEditAccess = permissions.canEdit;

  return (
    <div className={`flex items-center justify-between px-4 py-2 border-b-2 ${
      hasEditAccess
        ? 'bg-[#3a857410] border-[#3a8574]'
        : 'bg-[#fbbf2410] border-[#fbbf24]'
    }`}>
      {/* Left: Session info + permission pills */}
      <div className="flex items-center gap-3">
        {hasEditAccess ? (
          <Edit3 className="w-4 h-4 text-[#3a8574]" />
        ) : (
          <Eye className="w-4 h-4 text-[#fbbf24]" />
        )}

        <span className={`text-sm font-semibold ${hasEditAccess ? 'text-[#3a8574]' : 'text-[#fbbf24]'}`}>
          {hasEditAccess ? `Editing ${hostName}'s Session` : `Viewing ${hostName}'s Session (Read-Only)`}
        </span>

        {/* Permission pills */}
        <div className="flex items-center gap-1.5 ml-2">
          <PermPill enabled={permissions.canEdit} icon={FileEdit} label="Edit" />
          <PermPill enabled={permissions.canFileOps} icon={FolderEdit} label="Files" />
          <PermPill enabled={permissions.canTerminal} icon={Terminal} label="Term" />
          <PermPill enabled={permissions.canGit} icon={GitBranch} label="Git" />
        </div>
      </div>

      {/* Right: Leave button */}
      <button
        onClick={leaveSession}
        className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-[#ff575715] hover:bg-[#ff575725] text-[#ff5757] text-sm font-medium transition-colors"
      >
        <LogOut className="w-3.5 h-3.5" />
        Leave
      </button>
    </div>
  );
}

/**
 * Small pill showing an individual permission's granted/denied state.
 */
function PermPill({ enabled, icon: Icon, label }) {
  return (
    <div
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
        enabled
          ? 'bg-[#3a857415] text-[#3a8574]'
          : 'bg-[#ff575710] text-[#5a6178]'
      }`}
      title={enabled ? `${label}: Granted` : `${label}: Denied — Ask host for permission`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </div>
  );
}

/**
 * Wrapper component that adds an orange/green border to the IDE
 * when a guest is connected.
 *
 * Usage:
 *   <GuestSessionBorder>
 *     <YourIDELayout />
 *   </GuestSessionBorder>
 */
export function GuestSessionBorder({ children }) {
  const { isGuest, permissions } = useCollabSession();

  if (!isGuest) return <>{children}</>;

  const borderColor = permissions.canEdit
    ? 'ring-[#3a8574]'
    : 'ring-[#fbbf24]';

  return (
    <div className={`ring-2 ${borderColor} ring-inset rounded-lg overflow-hidden h-full`}>
      {children}
    </div>
  );
}
