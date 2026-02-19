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
      // Reset notification states when user joins a new session
      collabSessionService.on('session:joined', () => {
        setKicked(false);
        setTerminated(false);
        setDenied(false);
      }),
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
    <div
      className="flex items-center justify-between px-4 py-2 border-b-2"
      style={{
        backgroundColor: hasEditAccess ? 'rgba(58,133,116,0.06)' : 'rgba(251,191,36,0.06)',
        borderColor: hasEditAccess ? '#4aba9a' : '#fbbf24',
      }}
    >
      {/* Left: Session info + permission pills */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold"
          style={{
            backgroundColor: hasEditAccess ? 'rgba(74,186,154,0.12)' : 'rgba(251,191,36,0.12)',
            color: hasEditAccess ? '#4aba9a' : '#fbbf24',
          }}>
          {hasEditAccess ? <Edit3 className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          {hasEditAccess ? 'EDIT' : 'VIEW'}
        </div>

        <span className="text-sm font-semibold" style={{ color: hasEditAccess ? '#4aba9a' : '#fbbf24' }}>
          {hasEditAccess ? `${hostName}'s Session` : `${hostName}'s Session (Read-Only)`}
        </span>

        {/* Permission pills */}
        <div className="flex items-center gap-1 ml-2">
          <PermPill enabled={permissions.canEdit} icon={FileEdit} label="Edit" />
          <PermPill enabled={permissions.canFileOps} icon={FolderEdit} label="Files" />
          <PermPill enabled={permissions.canTerminal} icon={Terminal} label="Term" />
          <PermPill enabled={permissions.canGit} icon={GitBranch} label="Git" />
        </div>
      </div>

      {/* Right: Leave button */}
      <button
        onClick={leaveSession}
        className="flex items-center gap-1.5 px-3 py-1 rounded-md text-sm font-medium transition-colors"
        style={{ backgroundColor: 'rgba(255,87,87,0.08)', color: '#ff5757' }}
        onMouseEnter={e => e.currentTarget.style.backgroundColor = 'rgba(255,87,87,0.15)'}
        onMouseLeave={e => e.currentTarget.style.backgroundColor = 'rgba(255,87,87,0.08)'}
      >
        <LogOut className="w-3.5 h-3.5" />
        Leave Session
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
      className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium"
      style={{
        backgroundColor: enabled ? 'rgba(74,186,154,0.10)' : 'rgba(90,97,120,0.10)',
        color: enabled ? '#4aba9a' : '#5a6178',
      }}
      title={enabled ? `${label}: Granted` : `${label}: Denied — Ask host for permission`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </div>
  );
}

/**
 * Wrapper component that adds a teal/amber border to the IDE
 * when a guest is connected.
 */
export function GuestSessionBorder({ children }) {
  const { isGuest, permissions } = useCollabSession();

  if (!isGuest) return <>{children}</>;

  const borderColor = permissions.canEdit ? '#4aba9a' : '#fbbf24';

  return (
    <div className="ring-2 ring-inset rounded-lg overflow-hidden h-full"
      style={{ '--tw-ring-color': borderColor }}>
      {children}
    </div>
  );
}
