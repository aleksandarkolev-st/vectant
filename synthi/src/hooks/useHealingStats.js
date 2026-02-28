"use client";

import { useCallback, useEffect, useState } from "react";
import { useAnalyzerGateway } from "@/hooks/useAnalyzerGateway";

/**
 * Hook to retrieve and display healing statistics and cache metrics.
 *
 * Polls the backend periodically for updated stats.
 */
export function useHealingStats(pollIntervalMs = 30000) {
  const { gateway } = useAnalyzerGateway();
  const [stats, setStats] = useState(null);
  const [cacheStats, setCacheStats] = useState(null);
  const [loading, setLoading] = useState(false);

  /**
   * Fetch latest stats from the backend.
   */
  const refresh = useCallback(async () => {
    if (!gateway) return;
    setLoading(true);
    try {
      const [statsResult, cacheResult] = await Promise.allSettled([
        gateway.healStats(),
        gateway.healCacheStats(),
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
  }, [gateway]);

  // Auto-poll
  useEffect(() => {
    if (!gateway) return;

    refresh();
    const interval = setInterval(refresh, pollIntervalMs);
    return () => clearInterval(interval);
  }, [gateway, pollIntervalMs, refresh]);

  return {
    stats,
    cacheStats,
    loading,
    refresh,
  };
}
