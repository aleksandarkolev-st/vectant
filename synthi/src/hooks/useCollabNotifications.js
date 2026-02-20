"use client";

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import collabSessionService from '@/services/collabSessionService';

/** Helper — returns a toast action that opens the collab popup */
const openPopupAction = {
  label: 'Open',
  onClick: () => collabSessionService.requestOpenPopup(),
};

/**
 * useCollabNotifications — Listens to collaboration events and shows
 * toast notifications for key lifecycle events.
 *
 * Drop this hook into any component that's always mounted (e.g. layout or page).
 */
export function useCollabNotifications() {
  const mountedRef = useRef(false);

  useEffect(() => {
    // Prevent double-fire from StrictMode
    if (mountedRef.current) return;
    mountedRef.current = true;

    const unsubs = [
      // ── Host receives a knock ────────────────────────────────────
      collabSessionService.on('knock:received', (detail) => {        // Only show the notification to the Host.
        // This is a defense-in-depth check — the backend should already
        // route knocks exclusively to the host, but we guard here too.
        if (collabSessionService.role !== 'hosting') return;        const name = detail?.displayName || 'Someone';
        toast.info(`${name} wants to join your session`, {
          description: 'Click to review pending requests.',
          duration: 8000,
          icon: '🔔',
          action: openPopupAction,
        });
      }),

      // ── Guest joins the session ──────────────────────────────────
      collabSessionService.on('guest:joined', (detail) => {
        const name = detail?.displayName || detail?.guest?.displayName || 'A guest';
        const wasAutoAdmitted = detail?.autoAdmitted;
        toast.success(`${name} joined the session`, {
          description: wasAutoAdmitted
            ? 'Auto-admitted via your invitation.'
            : undefined,
          duration: 4000,
          icon: wasAutoAdmitted ? '✅' : '👋',
          action: openPopupAction,
        });
      }),

      // ── Guest was removed ────────────────────────────────────────
      collabSessionService.on('guest:removed', (detail) => {
        const name = detail?.displayName || 'A guest';
        toast(`${name} left the session`, {
          duration: 4000,
          icon: '🚪',
        });
      }),

      // ── Current user got kicked ──────────────────────────────────
      collabSessionService.on('session:kicked', () => {
        toast.error('You were removed from the session', {
          description: 'The host has removed you.',
          duration: 8000,
          icon: '🚫',
        });
      }),

      // ── Session terminated ───────────────────────────────────────
      collabSessionService.on('session:terminated', () => {
        // Only toast for non-hosts (they initiated it)
        if (!collabSessionService.isHost) {
          toast.warning('The session has ended', {
            description: 'The host stopped sharing.',
            duration: 6000,
            icon: '📡',
          });
        }
      }),

      // ── Knock denied ─────────────────────────────────────────────
      collabSessionService.on('knock:denied', () => {
        toast.error('Your request to join was denied', {
          duration: 6000,
          icon: '🚫',
        });
      }),

      // ── Permissions changed ──────────────────────────────────────
      collabSessionService.on('permissions:changed', (perms) => {
        const permsStr = Object.entries(perms || {})
          .filter(([, v]) => v)
          .map(([k]) => k.replace('can', ''))
          .join(', ');
        toast.info('Your permissions were updated', {
          description: permsStr ? `Granted: ${permsStr}` : 'All permissions revoked.',
          duration: 5000,
          icon: '🛡️',
          action: openPopupAction,
        });
      }),

      // ── Session created (host confirmation) ──────────────────────
      collabSessionService.on('session:created', (detail) => {
        const code = detail?.roomCode || collabSessionService.session?.roomCode;
        toast.success('Session is live!', {
          description: code
            ? `Room code: ${code} — share it to collaborate.`
            : 'Share your invite link to collaborate.',
          duration: 6000,
          icon: '📡',
          action: openPopupAction,
        });
      }),
      // ── Incoming collaboration invite ────────────────────────
      collabSessionService.on('collab-invite', (detail) => {
        const name = detail?.hostName || 'Someone';
        toast.info(`${name} invited you to collaborate`, {
          description: 'Click to accept or decline.',
          duration: 10000,
          icon: '📨',
          action: openPopupAction,
        });
      }),
      // ── Joined a session (guest confirmation) ────────────────────
      collabSessionService.on('session:joined', (detail) => {
        toast.success('You joined the session!', {
          description: 'You now have access to the workspace.',
          duration: 4000,
          icon: '✅',
          action: openPopupAction,
        });
      }),

      // ── Action denied by permission system ───────────────────────
      collabSessionService.on('action:denied', (detail) => {
        const action = detail?.action || 'This action';
        toast.warning(`${action} is not permitted`, {
          description: 'Ask the host to update your permissions.',
          duration: 5000,
          icon: '🔒',
        });
      }),
    ];

    return () => {
      mountedRef.current = false;
      unsubs.forEach(fn => fn());
    };
  }, []);
}
