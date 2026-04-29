'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Subscribes to /api/shadow_continuous/state for a workspace and exposes
 * the latest pass→fail regression findings (master plan §14).
 *
 * Polling, not SSE — findings are infrequent (seconds-to-minutes apart)
 * and the existing FastAPI handler already returns the structured state
 * we need.
 *
 * Returns:
 *   { findings, dismiss(file), optOut(value), optedOut, lastRunAt, error }
 */

const POLL_INTERVAL_MS = 12_000;
const FINDING_KEY = (f) => `${f.file}:${f.test || ''}`;

export function useContinuousFindings(workspacePath) {
    const [findings, setFindings] = useState([]);
    const [optedOut, setOptedOut] = useState(false);
    const [lastRunAt, setLastRunAt] = useState(null);
    const [error, setError] = useState(null);
    const dismissedRef = useRef(new Set());

    const fetchState = useCallback(async () => {
        if (!workspacePath) return;
        try {
            const res = await fetch(
                `/api/shadow_continuous/state?workspace_path=${encodeURIComponent(workspacePath)}`
            );
            if (!res.ok) {
                setError(`HTTP ${res.status}`);
                return;
            }
            const data = await res.json();
            setOptedOut(Boolean(data?.opted_out));
            const all = (data?.watcher?.last_findings || []).filter(
                (f) => !dismissedRef.current.has(FINDING_KEY(f))
            );
            setFindings(all);
            setLastRunAt(data?.watcher?.last_run_at || null);
            setError(null);
        } catch (e) {
            setError(String(e?.message || e));
        }
    }, [workspacePath]);

    useEffect(() => {
        if (!workspacePath) {
            setFindings([]);
            return undefined;
        }
        fetchState();
        const id = setInterval(fetchState, POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [fetchState, workspacePath]);

    const dismiss = useCallback((finding) => {
        const key = FINDING_KEY(finding);
        dismissedRef.current.add(key);
        setFindings((current) => current.filter((f) => FINDING_KEY(f) !== key));
    }, []);

    const optOut = useCallback(async (value) => {
        if (!workspacePath) return null;
        try {
            const res = await fetch('/api/shadow_continuous/opt_out', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workspace_path: workspacePath, opted_out: !!value }),
            });
            const data = await res.json();
            if (typeof data?.opted_out === 'boolean') setOptedOut(data.opted_out);
            return data;
        } catch (e) {
            setError(String(e?.message || e));
            return null;
        }
    }, [workspacePath]);

    return { findings, dismiss, optOut, optedOut, lastRunAt, error };
}

export default useContinuousFindings;
