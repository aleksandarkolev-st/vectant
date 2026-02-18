"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import collabSessionService from '@/services/collabSessionService';

/**
 * React hook that returns workspace-level presence info:
 *   - activeUsers: all users with open Yjs docs in this workspace
 *   - sessions: all active collaboration sessions for this workspace
 *
 * Polls the REST endpoint every `intervalMs` (default 5s).
 *
 * @param {string} slug — Workspace slug
 * @param {number} [intervalMs=5000] — Polling interval
 * @returns {{ activeUsers: Array, sessions: Array, refresh: () => void, loading: boolean }}
 */
export function useWorkspacePresence(slug, intervalMs = 5000) {
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

  // Initial fetch + polling
  useEffect(() => {
    mountedRef.current = true;
    refresh();

    const timer = setInterval(refresh, intervalMs);

    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

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
