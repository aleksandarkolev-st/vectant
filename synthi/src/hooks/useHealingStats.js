"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { useAnalyzerGateway } from "@/hooks/useAnalyzerGateway";
import sseClient from "@/services/sseClient";

/**
 * Hook to retrieve and display healing statistics and cache metrics.
 *
 * **Architecture (v2 — SSE-driven):**
 * Performs an initial fetch on mount, then listens for 'healing-stats-update'
 * SSE events pushed by the backend. Falls back to a 120s safety-net poll
 * ONLY when SSE is not connected.
 *
 * @param {string} [slug] — Workspace slug (for SSE subscription)
 * @param {number} [fallbackPollMs=120000] — Fallback poll (only active when SSE is down)
 */
export function useHealingStats(slug, fallbackPollMs = 120000) {
  const { healStats, healCacheStats, clientReady } = useAnalyzerGateway();
  const [stats, setStats] = useState(null);
  const [cacheStats, setCacheStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const mountedRef = useRef(true);

  /**
   * Fetch latest stats from the backend.
   */
  const refresh = useCallback(async () => {
    if (!clientReady) return;
    setLoading(true);
    try {
      const [statsResult, cacheResult] = await Promise.allSettled([
        healStats(),
        healCacheStats(),
      ]);

      if (statsResult.status === "fulfilled") {
        setStats(statsResult.value);
      }
      if (cacheResult.status === "fulfilled") {
        setCacheStats(cacheResult.value);
      }
    } catch (err) {
      console.error("[HealingStats] refresh error:", err);
    } finally {
      setLoading(false);
    }
  }, [healStats, healCacheStats, clientReady]);

  // Initial fetch + SSE subscription (replaces 30s polling)
  useEffect(() => {
    if (!clientReady) return;
    mountedRef.current = true;

    refresh();

    // Listen for server-pushed healing stats via SSE
    const unsubSSE = slug
      ? sseClient.on(slug, 'healing-stats-update', (data) => {
          if (!mountedRef.current) return;
          if (data.stats) setStats(data.stats);
          if (data.cacheStats) setCacheStats(data.cacheStats);
        })
      : null;

    // Safety-net: very infrequent fallback poll for SSE gaps
    const interval = setInterval(() => {
      if (!slug || !sseClient.isConnected(slug)) refresh();
    }, fallbackPollMs);

    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      if (unsubSSE) unsubSSE();
    };
  }, [clientReady, fallbackPollMs, refresh, slug]);

  return {
    stats,
    cacheStats,
    loading,
    refresh,
  };
}
