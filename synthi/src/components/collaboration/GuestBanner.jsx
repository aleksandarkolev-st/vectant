"use client";

import React, { useEffect, useState } from 'react';
import { useCollabSession } from '@/hooks/useCollabSession';
import collabSessionService from '@/services/collabSessionService';
import {
  Eye, Edit3, Shield, X, AlertTriangle
} from 'lucide-react';

/**
 * GuestBanner — Thin persistent top bar shown for guests / knocking users.
 *
 * Simplified: session management now lives in the unified ShareModal.
 * This banner only shows:
 *   - Dismissable alerts (kicked, terminated, denied)
 *   - Thin status bar for knocking or active guest
 * Clicking the bar opens the ShareModal via collabSessionService.requestOpenPopup().
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
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#ff575718] border-b border-[#ff575740]" role="alert">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-[#ff5757]" />
          <span className="text-xs text-[#ff5757] font-semibold">You have been removed from the session.</span>
        </div>
        <button onClick={() => setKicked(false)} className="p-0.5 rounded hover:bg-[#ff575730] transition-colors" aria-label="Dismiss">
          <X className="w-3.5 h-3.5 text-[#ff5757]" />
        </button>
      </div>
    );
  }

  // ── Session terminated notification ────────────────────────────────────

  if (terminated) {
    return (
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#fbbf2418] border-b border-[#fbbf2440]" role="alert">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-[#fbbf24]" />
          <span className="text-xs text-[#fbbf24] font-semibold">The host ended the session.</span>
        </div>
        <button onClick={() => setTerminated(false)} className="p-0.5 rounded hover:bg-[#fbbf2430] transition-colors" aria-label="Dismiss">
          <X className="w-3.5 h-3.5 text-[#fbbf24]" />
        </button>
      </div>
    );
  }

  // ── Knock denied ──────────────────────────────────────────────────────

  if (denied) {
    return (
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#ff575712] border-b border-[#ff575730]" role="alert">
        <div className="flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-[#ff5757]" />
          <span className="text-xs text-[#ff5757] font-medium">Your request to join was denied.</span>
        </div>
        <button onClick={() => setDenied(false)} className="p-0.5 rounded hover:bg-[#ff575720] transition-colors" aria-label="Dismiss">
          <X className="w-3.5 h-3.5 text-[#ff5757]" />
        </button>
      </div>
    );
  }

  // ── Knocking (waiting) — thin bar ─────────────────────────────────────

  if (isKnocking) {
    return (
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#fbbf240a] border-b border-[#fbbf2430]">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-[#fbbf24] border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-[#fbbf24] font-medium">Waiting for the host to accept…</span>
        </div>
        <button onClick={leaveSession}
          className="text-[10px] text-[#fbbf24] hover:text-[#fbbf24cc] font-medium transition-colors">
          Cancel
        </button>
      </div>
    );
  }

  // ── Active guest — thin status bar (click to open ShareModal) ─────────

  if (!isGuest) return null;

  const hostName = session?.hostName || 'Host';
  const hasEdit = permissions.canEdit;
  const color = hasEdit ? '#4aba9a' : '#fbbf24';

  return (
    <button
      onClick={() => collabSessionService.requestOpenPopup()}
      className="w-full flex items-center gap-2.5 px-4 py-1 border-b cursor-pointer hover:brightness-110 transition-all"
      style={{
        backgroundColor: hasEdit ? 'rgba(74,186,154,0.04)' : 'rgba(251,191,36,0.04)',
        borderColor: `${color}40`,
      }}
    >
      <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
        style={{ backgroundColor: `${color}18`, color }}>
        {hasEdit ? <Edit3 className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
        {hasEdit ? 'EDIT' : 'VIEW'}
      </div>
      <span className="text-[11px] font-medium" style={{ color }}>
        {hostName}&apos;s Session
      </span>
      <span className="text-[10px] ml-auto" style={{ color: `${color}80` }}>
        Click for details
      </span>
    </button>
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
