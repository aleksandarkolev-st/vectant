"use client";

import React, { useState, useCallback, useEffect } from 'react';
import { useCollabSession } from '@/hooks/useCollabSession';
import WorkspaceUsersPanel from './WorkspaceUsersPanel';
import {
  X, Share2, Link2, Copy, Check, Users, Radio, Shield,
  Terminal, GitBranch, FileEdit, FolderEdit, RefreshCw,
  CircleOff
} from 'lucide-react';

// ── Theme ─────────────────────────────────────────────────────────────────────
const T = {
  bg:       '#0c0d12',
  card:     '#0d0e14',
  surface:  '#101118',
  border:   '#1c1d26',
  borderHi: '#2a2b38',
  text:     '#e0e4ec',
  textSec:  '#7c80a0',
  textMuted:'#5a6178',
  teal:     '#4aba9a',
  tealDim:  '#3a8574',
  blue:     '#7cb8f8',
  amber:    '#fbbf24',
  red:      '#ff5757',
  live:     '#ff5757',
};

/**
 * ShareModal — Collaboration dialog.
 *
 * Shows the workspace users panel and, when hosting, the invite link
 * in a compact header section. No more separate "Share Session" tab.
 */
export default function ShareModal({ slug, open, onClose }) {
  const {
    isHost, isGuest, session,
    regenerateInvite, terminateSession,
    error, clearError,
  } = useCollabSession();

  const [copied, setCopied] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setCopied(false);
      if (error) clearError();
    }
  }, [open]);

  // Copy invite link
  const handleCopy = useCallback(async () => {
    if (!session?.inviteLink) return;
    try {
      await navigator.clipboard.writeText(session.inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
  }, [session?.inviteLink]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="relative w-[480px] max-h-[80vh] rounded-xl border shadow-2xl flex flex-col overflow-hidden"
        style={{ backgroundColor: T.card, borderColor: T.border }}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: T.border }}>
          <div className="flex items-center gap-2.5">
            <Users className="w-4.5 h-4.5" style={{ color: T.teal }} />
            <h2 className="text-sm font-semibold" style={{ color: T.text }}>Collaboration</h2>
            {isHost && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold"
                style={{ backgroundColor: 'rgba(255,87,87,0.10)', color: T.live }}>
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: T.live }} />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ backgroundColor: T.live }} />
                </span>
                LIVE
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#1a1b24] transition-colors">
            <X className="w-4 h-4" style={{ color: T.textMuted }} />
          </button>
        </div>

        {/* ── Host: Invite Link strip ─────────────────────────────── */}
        {isHost && session && (
          <div className="px-4 py-2.5 border-b flex items-center gap-2" style={{ borderColor: T.border, backgroundColor: 'rgba(74,186,154,0.03)' }}>
            <Link2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: T.tealDim }} />
            <input
              readOnly
              value={session.inviteLink || ''}
              className="flex-1 rounded-md px-2.5 py-1 text-[11px] font-mono truncate border focus:outline-none"
              style={{ backgroundColor: T.surface, borderColor: T.border, color: T.textSec }}
            />
            <button onClick={handleCopy}
              className="p-1.5 rounded-md border transition-colors"
              style={{ backgroundColor: T.surface, borderColor: copied ? 'rgba(74,186,154,0.4)' : T.border }}
              title="Copy invite link">
              {copied
                ? <Check className="w-3 h-3" style={{ color: T.teal }} />
                : <Copy className="w-3 h-3" style={{ color: T.textMuted }} />
              }
            </button>
            <button onClick={regenerateInvite}
              className="p-1.5 rounded-md border transition-colors"
              style={{ backgroundColor: T.surface, borderColor: T.border }}
              title="Regenerate link">
              <RefreshCw className="w-3 h-3" style={{ color: T.textMuted }} />
            </button>
          </div>
        )}

        {/* ── Content: Users panel ────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4" style={{ maxHeight: '60vh' }}>
          <WorkspaceUsersPanel slug={slug} />
        </div>

        {/* ── Footer: Stop sharing (host only) ────────────────────── */}
        {isHost && (
          <div className="px-4 py-3 border-t" style={{ borderColor: T.border }}>
            <button onClick={terminateSession}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all border"
              style={{ backgroundColor: 'rgba(255,87,87,0.08)', borderColor: 'rgba(255,87,87,0.25)', color: T.red }}>
              <CircleOff className="w-3.5 h-3.5" />
              Stop Sharing
            </button>
          </div>
        )}

        {/* ── Error ───────────────────────────────────────────────── */}
        {error && (
          <div className="px-4 py-2 border-t flex items-center justify-between"
            style={{ borderColor: T.border, backgroundColor: 'rgba(255,87,87,0.06)', color: T.red }}>
            <span className="text-[11px]">{error}</span>
            <button onClick={clearError} className="p-0.5 rounded hover:bg-[#ff575720]">
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
