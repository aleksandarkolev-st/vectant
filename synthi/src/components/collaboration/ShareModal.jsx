"use client";

import React, { useState, useCallback, useEffect } from 'react';
import { useCollabSession } from '@/hooks/useCollabSession';
import { useWorkspacePresence } from '@/hooks/useWorkspacePresence';
import WorkspaceUsersPanel from './WorkspaceUsersPanel';
import {
  X, Share2, Link2, Copy, Check, Users, Radio, Shield,
  Terminal, GitBranch, FileEdit, FolderEdit, QrCode, RefreshCw
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

const PERM_CONFIG = [
  { key: 'canEdit',     label: 'Edit Code',   icon: FileEdit,   risk: 'low',    desc: 'Allow editing files via Yjs' },
  { key: 'canFileOps',  label: 'File Ops',     icon: FolderEdit, risk: 'medium', desc: 'Create, delete, rename files' },
  { key: 'canTerminal', label: 'Terminal',      icon: Terminal,   risk: 'high',   desc: 'Run commands in the terminal' },
  { key: 'canGit',      label: 'Git Control',   icon: GitBranch,  risk: 'high',   desc: 'Commit, push, pull, checkout' },
];

/**
 * ShareModal — Full-featured sharing dialog.
 *
 * Tabs:
 *   1. People — active users panel (WorkspaceUsersPanel)
 *   2. Share — create session + invite link
 */
export default function ShareModal({ slug, open, onClose }) {
  const [tab, setTab] = useState('people'); // 'people' | 'share'
  const {
    isHost, isGuest, isKnocking, session,
    createSession, regenerateInvite, terminateSession,
    error, clearError,
  } = useCollabSession();

  const [copied, setCopied] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [perms, setPerms] = useState({
    canEdit: true,
    canTerminal: false,
    canGit: false,
    canFileOps: false,
  });

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setShowCreate(false);
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

  // Create session
  const handleCreate = useCallback(async () => {
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
      defaultPerms: perms,
    });
    setShowCreate(false);
  }, [createSession, slug, perms]);

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
            <Share2 className="w-4.5 h-4.5" style={{ color: T.teal }} />
            <h2 className="text-sm font-semibold" style={{ color: T.text }}>Sharing & Collaboration</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#1a1b24] transition-colors">
            <X className="w-4 h-4" style={{ color: T.textMuted }} />
          </button>
        </div>

        {/* ── Tab bar ─────────────────────────────────────────────── */}
        <div className="flex border-b" style={{ borderColor: T.border }}>
          <TabButton active={tab === 'people'} onClick={() => setTab('people')} icon={Users} label="People" />
          <TabButton active={tab === 'share'} onClick={() => setTab('share')} icon={Link2} label="Share Session" />
        </div>

        {/* ── Content ─────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-4" style={{ maxHeight: '60vh' }}>
          {tab === 'people' && (
            <WorkspaceUsersPanel slug={slug} />
          )}

          {tab === 'share' && (
            <ShareTab
              slug={slug}
              isHost={isHost}
              isGuest={isGuest}
              session={session}
              showCreate={showCreate}
              setShowCreate={setShowCreate}
              perms={perms}
              setPerms={setPerms}
              copied={copied}
              onCopy={handleCopy}
              onCreate={handleCreate}
              onRegenerate={regenerateInvite}
              onTerminate={terminateSession}
              error={error}
              clearError={clearError}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Tab Button ────────────────────────────────────────────────────────────────

function TabButton({ active, onClick, icon: Icon, label }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-all relative"
      style={{ color: active ? T.teal : T.textMuted }}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
      {active && (
        <span className="absolute bottom-0 left-1/4 right-1/4 h-[2px] rounded-full" style={{ backgroundColor: T.teal }} />
      )}
    </button>
  );
}

// ── Share Tab ─────────────────────────────────────────────────────────────────

function ShareTab({
  slug, isHost, isGuest, session,
  showCreate, setShowCreate, perms, setPerms,
  copied, onCopy, onCreate, onRegenerate, onTerminate,
  error, clearError,
}) {
  // Active session — show invite link and management
  if (isHost && session) {
    return (
      <div className="space-y-4">
        {/* Invite link */}
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 mb-2"
            style={{ color: T.textMuted }}>
            <Link2 className="w-3 h-3" />
            Invite Link
          </label>
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              value={session.inviteLink || ''}
              className="flex-1 rounded-md px-3 py-2 text-[11px] font-mono truncate border focus:outline-none"
              style={{ backgroundColor: T.surface, borderColor: T.border, color: T.textSec }}
            />
            <button onClick={onCopy}
              className="p-2 rounded-md border transition-colors"
              style={{ backgroundColor: T.surface, borderColor: copied ? 'rgba(74,186,154,0.4)' : T.border }}
              title="Copy">
              {copied
                ? <Check className="w-3.5 h-3.5" style={{ color: T.teal }} />
                : <Copy className="w-3.5 h-3.5" style={{ color: T.textMuted }} />
              }
            </button>
            <button onClick={onRegenerate}
              className="p-2 rounded-md border transition-colors"
              style={{ backgroundColor: T.surface, borderColor: T.border }}
              title="Regenerate link">
              <RefreshCw className="w-3.5 h-3.5" style={{ color: T.textMuted }} />
            </button>
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg border"
          style={{ backgroundColor: 'rgba(255,87,87,0.05)', borderColor: 'rgba(255,87,87,0.2)' }}>
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: T.live }} />
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: T.live }} />
          </span>
          <span className="text-xs font-semibold" style={{ color: T.live }}>Session is LIVE</span>
        </div>

        {/* Stop sharing */}
        <button onClick={onTerminate}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-semibold transition-all border"
          style={{ backgroundColor: 'rgba(255,87,87,0.08)', borderColor: 'rgba(255,87,87,0.25)', color: T.red }}>
          <Radio className="w-3.5 h-3.5" />
          Stop Sharing
        </button>

        {error && <ErrorBanner error={error} onDismiss={clearError} />}
      </div>
    );
  }

  // Guest view
  if (isGuest) {
    return (
      <div className="text-center py-6">
        <Shield className="w-8 h-8 mx-auto mb-2" style={{ color: T.teal }} />
        <p className="text-sm font-medium" style={{ color: T.text }}>
          You're currently in a session
        </p>
        <p className="text-xs mt-1" style={{ color: T.textMuted }}>
          Leave the current session to start your own.
        </p>
      </div>
    );
  }

  // Create session form
  if (showCreate) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold mb-1" style={{ color: T.text }}>Default Guest Permissions</h3>
          <p className="text-[10px] mb-3" style={{ color: T.textMuted }}>
            Set what guests can do by default. You can change per-user later.
          </p>
          <div className="space-y-1.5">
            {PERM_CONFIG.map(({ key, label, icon: Icon, risk, desc }) => (
              <button
                key={key}
                onClick={() => setPerms(p => ({ ...p, [key]: !p[key] }))}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-all text-left border"
                style={{
                  backgroundColor: perms[key] ? 'rgba(74,186,154,0.06)' : T.surface,
                  borderColor: perms[key] ? 'rgba(74,186,154,0.25)' : T.border,
                }}
                title={desc}
              >
                <div className="flex items-center gap-2.5">
                  <Icon className="w-3.5 h-3.5" style={{ color: perms[key] ? T.teal : T.textMuted }} />
                  <span className="text-xs font-medium" style={{ color: perms[key] ? T.text : T.textMuted }}>
                    {label}
                  </span>
                  {risk === 'high' && <span className="text-[10px]" style={{ color: T.red }}>⚠</span>}
                </div>
                <MiniToggle enabled={perms[key]} />
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <button onClick={() => setShowCreate(false)}
            className="flex-1 py-2.5 rounded-lg text-xs font-medium border transition-colors"
            style={{ borderColor: T.border, color: T.textSec, backgroundColor: T.surface }}>
            Cancel
          </button>
          <button onClick={onCreate}
            className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2"
            style={{ backgroundColor: T.tealDim }}>
            <Radio className="w-3.5 h-3.5" />
            Start Sharing
          </button>
        </div>

        {error && <ErrorBanner error={error} onDismiss={clearError} />}
      </div>
    );
  }

  // Idle — show start sharing CTA
  return (
    <div className="space-y-4">
      <div className="text-center py-4">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'rgba(74,186,154,0.08)', border: `1px solid rgba(74,186,154,0.2)` }}>
          <Share2 className="w-5 h-5" style={{ color: T.teal }} />
        </div>
        <h3 className="text-sm font-semibold" style={{ color: T.text }}>Share your workspace</h3>
        <p className="text-xs mt-1 max-w-[300px] mx-auto" style={{ color: T.textMuted }}>
          Start a live session so others can view or edit your code in real-time.
        </p>
      </div>

      <button onClick={() => setShowCreate(true)}
        className="w-full py-2.5 rounded-lg text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2"
        style={{ backgroundColor: T.tealDim }}>
        <Radio className="w-4 h-4" />
        Start Sharing
      </button>
    </div>
  );
}

// ── Shared ────────────────────────────────────────────────────────────────────

function MiniToggle({ enabled }) {
  return (
    <div className="w-7 h-3.5 rounded-full relative transition-colors flex-shrink-0"
      style={{ backgroundColor: enabled ? T.tealDim : '#2a2b38' }}>
      <div className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-white shadow transition-transform ${
        enabled ? 'translate-x-3.5' : 'translate-x-0.5'
      }`} />
    </div>
  );
}

function ErrorBanner({ error, onDismiss }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 rounded-lg border"
      style={{ backgroundColor: 'rgba(255,87,87,0.06)', borderColor: 'rgba(255,87,87,0.2)', color: T.red }}>
      <span className="text-[11px]">{error}</span>
      <button onClick={onDismiss} className="p-0.5 rounded hover:bg-[#ff575720]">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
