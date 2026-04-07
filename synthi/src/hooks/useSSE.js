"use client";

import { useEffect, useRef } from 'react';
import sseClient from '@/services/sseClient';

/**
 * useSSE — React hook to subscribe to Server-Sent Events for a workspace.
 *
 * Manages the SSE connection lifecycle:
 *   - Connects on mount (or when slug changes)
 *   - Disconnects on unmount (only if no other subscribers remain)
 *   - Provides a typed listener attachment API
 *
 * @param {string} slug — Workspace slug
 * @param {object} [opts]
 * @param {string} [opts.userId] — Authenticated user ID
 */
export function useSSE(slug, { userId = null } = {}) {
  const refCountKey = `sse-ref:${slug}`;

  useEffect(() => {
    if (!slug) return;

    // Simple reference counter to know when the last component unmounts
    if (typeof window !== 'undefined') {
      const current = parseInt(window[refCountKey] || '0', 10);
      window[refCountKey] = String(current + 1);
    }

    sseClient.connect(slug, { userId });

    return () => {
      if (typeof window !== 'undefined') {
        const current = parseInt(window[refCountKey] || '1', 10);
        const next = current - 1;
        window[refCountKey] = String(next);

        // Only disconnect when the last subscriber unmounts
        if (next <= 0) {
          sseClient.disconnect(slug);
          delete window[refCountKey];
        }
      }
    };
  }, [slug, userId, refCountKey]);
}

/**
 * useSSEEvent — Subscribe to a specific SSE event type with automatic cleanup.
 *
 * @param {string} slug — Workspace slug
 * @param {string} eventType — SSE event type (e.g. 'git-status-changed')
 * @param {Function} handler — Event handler
 * @param {Array} deps — Additional dependencies for the handler
 */
export function useSSEEvent(slug, eventType, handler, deps = []) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!slug || !eventType) return;

    const unsub = sseClient.on(slug, eventType, (data) => {
      handlerRef.current(data);
    });

    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, eventType, ...deps]);
}

export default useSSE;
