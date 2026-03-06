"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import collabSessionService from '@/services/collabSessionService';
import sseClient from '@/services/sseClient';

/**
 * React hook that returns workspace-level presence info:
 *   - activeUsers: all users with open Yjs docs in this workspace
 *   - sessions: all active collaboration sessions for this workspace
 *
 * **Architecture (v2 — SSE-driven):**
 * Initial fetch on mount, then listens for 'workspace-presence' SSE events
 * pushed by the backend. Falls back to a 60s safety-net poll ONLY if SSE
 * is not connected (e.g. during reconnection gaps).
 *
 * @param {string} slug — Workspace slug
 * @param {number} [fallbackPollMs=60000] — Fallback poll interval (only active when SSE is down)
 * @returns {{ activeUsers: Array, sessions: Array, refresh: () => void, loading: boolean }}
 */
export function useWorkspacePresence(slug, fallbackPollMs = 60000) {
  const [activeUsers, setActiveUsers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!slug) {
      setActiveUsers([]);
      setSessions([]);
      setLoading(false);
      return;
    }

    try {
      const data = await collabSessionService.getWorkspacePresence(slug);
      if (!mountedRef.current) return;
      setActiveUsers(data.activeUsers || []);
      setSessions(data.sessions || []);
    } catch (err) {
      console.warn('[useWorkspacePresence] fetch error:', err?.message);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [slug]);

  // Initial fetch + SSE subscription (replaces 5s polling)
  useEffect(() => {
    mountedRef.current = true;
    refresh();

    // Listen for server-pushed presence updates via SSE
    const unsubSSE = slug
      ? sseClient.on(slug, 'workspace-presence', (data) => {
          if (!mountedRef.current) return;
          setActiveUsers(data.activeUsers || []);
          setSessions(data.sessions || []);
          setLoading(false);
        })
      : null;

    // Safety-net: very infrequent fallback poll in case SSE drops
    const timer = setInterval(() => {
      if (!sseClient.isConnected(slug)) refresh();
    }, fallbackPollMs);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      if (unsubSSE) unsubSSE();
    };
  }, [refresh, fallbackPollMs, slug]);

  // Refresh when session events happen (join, leave, create, terminate)
  useEffect(() => {
    const unsub = collabSessionService.onChange((detail) => {
      const eventType = detail?.type;
      if (
        eventType === 'session:created' ||
        eventType === 'session:terminated' ||
        eventType === 'guest:joined' ||
        eventType === 'guest:removed' ||
        eventType === 'session:joined' ||
        eventType === 'session:left'
      ) {
        // Small delay to let server state settle
        setTimeout(refresh, 300);
      }
    });
    return unsub;
  }, [refresh]);

  return { activeUsers, sessions, refresh, loading };
}
