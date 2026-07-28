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
      <div className="vt-workflow-alert vt-workflow-alert--danger flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 py-1.5" role="alert">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-[var(--accent-danger)]" />
          <span className="text-xs font-semibold text-[var(--accent-danger)]">You have been removed from the session.</span>
        </div>
        <button onClick={() => setKicked(false)} className="vt-icon-button th-focus-ring h-6 min-w-6 text-[var(--accent-danger)]" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // ── Session terminated notification ────────────────────────────────────

  if (terminated) {
    return (
      <div className="vt-workflow-alert flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 py-1.5" role="alert">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-[var(--accent-warning)]" />
          <span className="text-xs font-semibold text-[var(--accent-warning)]">The host ended the session.</span>
        </div>
        <button onClick={() => setTerminated(false)} className="vt-icon-button th-focus-ring h-6 min-w-6 text-[var(--accent-warning)]" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // ── Knock denied ──────────────────────────────────────────────────────

  if (denied) {
    return (
      <div className="vt-workflow-alert vt-workflow-alert--danger flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 py-1.5" role="alert">
        <div className="flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-[var(--accent-danger)]" />
          <span className="text-xs font-medium text-[var(--accent-danger)]">Your request to join was denied.</span>
        </div>
        <button onClick={() => setDenied(false)} className="vt-icon-button th-focus-ring h-6 min-w-6 text-[var(--accent-danger)]" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  // ── Knocking (waiting) — thin bar ─────────────────────────────────────

  if (isKnocking) {
    return (
      <div className="vt-workflow-alert flex items-center justify-between rounded-none border-x-0 border-t-0 px-4 py-1.5">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--accent-warning)] border-t-transparent" />
          <span className="text-xs font-medium text-[var(--accent-warning)]">Waiting for the host to accept…</span>
        </div>
        <button onClick={leaveSession}
          className="th-focus-ring th-btn-ghost rounded-[var(--radius-control)] px-2 py-0.5 text-[10px] font-medium text-[var(--accent-warning)]">
          Cancel
        </button>
      </div>
    );
  }

  // ── Active guest — thin status bar (click to open ShareModal) ─────────

  if (!isGuest) return null;

  const hostName = session?.hostName || 'Host';
  const hasEdit = permissions.canEdit;
  const color = hasEdit ? 'var(--accent-secondary)' : 'var(--accent-warning)';

  return (
    <button
      onClick={() => collabSessionService.requestOpenPopup()}
      className="vt-workflow-alert flex w-full cursor-pointer items-center gap-2.5 rounded-none border-x-0 border-t-0 px-4 py-1 transition-all hover:brightness-110"
      style={{
        '--workflow-alert-color': color,
      }}
    >
      <div className="vt-workflow-chip text-[9px]" style={{ '--chip-color': color }}>
        {hasEdit ? <Edit3 className="w-2.5 h-2.5" /> : <Eye className="w-2.5 h-2.5" />}
        {hasEdit ? 'EDIT' : 'VIEW'}
      </div>
      <span className="text-[11px] font-medium" style={{ color }}>
        {hostName}&apos;s Session
      </span>
      <span className="ml-auto text-[10px] text-[var(--text-muted)]">
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

  const borderColor = permissions.canEdit ? 'var(--accent-secondary)' : 'var(--accent-warning)';

  return (
    <div className="ring-2 ring-inset rounded-lg overflow-hidden h-full"
      style={{ '--tw-ring-color': borderColor }}>
      {children}
    </div>
  );
}
