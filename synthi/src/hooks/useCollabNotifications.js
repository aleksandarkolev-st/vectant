"use client";

import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import collabSessionService from '@/services/collabSessionService';

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
      collabSessionService.on('knock:received', (detail) => {
        const name = detail?.displayName || 'Someone';
        toast.info(`${name} wants to join your session`, {
          description: 'Check pending requests to accept or deny.',
          duration: 8000,
          icon: '🔔',
        });
      }),

      // ── Guest joins the session ──────────────────────────────────
      collabSessionService.on('guest:joined', (detail) => {
        const name = detail?.displayName || detail?.guest?.displayName || 'A guest';
        toast.success(`${name} joined the session`, {
          duration: 4000,
          icon: '👋',
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
        });
      }),

      // ── Session created (host confirmation) ──────────────────────
      collabSessionService.on('session:created', () => {
        toast.success('Session is live!', {
          description: 'Share your invite link to collaborate.',
          duration: 4000,
          icon: '📡',
        });
      }),

      // ── Joined a session (guest confirmation) ────────────────────
      collabSessionService.on('session:joined', (detail) => {
        toast.success('You joined the session!', {
          description: 'You now have access to the workspace.',
          duration: 4000,
          icon: '✅',
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
