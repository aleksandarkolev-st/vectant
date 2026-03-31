import { useCallback, useEffect, useRef, useState } from 'react';

const CODE_INTEL_URL = process.env.NEXT_PUBLIC_CODE_INTEL_URL
  || (typeof window !== 'undefined' && window.location.hostname !== 'localhost'
    ? window.location.origin
    : 'http://localhost:8000');

export function useCodeIntelMetrics({ workspacePath, enabled = true, pollMs = 10000 } = {}) {
  const [metrics, setMetrics] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const fetchMetrics = useCallback(async () => {
    if (!workspacePath) return;
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`${CODE_INTEL_URL}/code-intel/metrics`, {
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
    fetchMetrics();
    if (pollMs > 0) {
      timerRef.current = setInterval(fetchMetrics, pollMs);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, workspacePath, pollMs, fetchMetrics]);

  return { metrics, isLoading, error, refresh: fetchMetrics };
}

export default useCodeIntelMetrics;
