import { useCallback, useEffect, useRef, useState } from 'react';
import sseClient from '@/services/sseClient';

const CODE_INTEL_API_BASE = '/api/code-intel';

/**
 * Hook for code-intel metrics.
 *
 * **Architecture (v2 — SSE-driven):**
 * Initial fetch on mount, then listens for 'code-intel-metrics' SSE events.
 * Falls back to a 120s safety-net poll ONLY when SSE is not connected.
 *
 * @param {object} opts
 * @param {string} [opts.workspacePath] — Workspace path
 * @param {string} [opts.slug] — Workspace slug (for SSE subscription)
 * @param {boolean} [opts.enabled=true]
 * @param {number} [opts.fallbackPollMs=120000] — Fallback poll interval
 */
export function useCodeIntelMetrics({ workspacePath, slug, enabled = true, fallbackPollMs = 120000 } = {}) {
  const [metrics, setMetrics] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);

  const fetchMetrics = useCallback(async () => {
    if (!workspacePath) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${CODE_INTEL_API_BASE}/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_path: workspacePath, include_all: true }),
      });
      if (!res.ok) throw new Error(`Metrics fetch failed (${res.status})`);
      const data = await res.json();
      setMetrics(data || null);
    } catch (e) {
      setError(e?.message || 'Metrics fetch failed');
    } finally {
      setIsLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    if (!enabled || !workspacePath) return undefined;
    mountedRef.current = true;

    fetchMetrics();

    // Listen for server-pushed metrics via SSE (replaces 10s polling)
    const unsubSSE = slug
      ? sseClient.on(slug, 'code-intel-metrics', (data) => {
          if (!mountedRef.current) return;
          setMetrics(data.metrics || data);
        })
      : null;

    // Safety-net: infrequent fallback poll for SSE gaps
    if (fallbackPollMs > 0) {
      timerRef.current = setInterval(() => {
        if (!slug || !sseClient.isConnected(slug)) fetchMetrics();
      }, fallbackPollMs);
    }

    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      if (unsubSSE) unsubSSE();
    };
  }, [enabled, workspacePath, slug, fallbackPollMs, fetchMetrics]);

  return { metrics, isLoading, error, refresh: fetchMetrics };
}

export default useCodeIntelMetrics;
