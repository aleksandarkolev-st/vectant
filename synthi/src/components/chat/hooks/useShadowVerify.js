'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Synthi Genome — `useShadowVerify(jobId)`
 *
 * Subscribes to /api/shadow/[jobId]/stream and exposes a structured view
 * of the run for `<MultiverseCard />` and `<StalenessBadge />`.
 *
 * Wave 1 of synthi-genome-master-plan.md.
 */

const initial = () => ({
    jobId: null,
    tier: null,
    universesPlanned: 0,
    snapshotFiles: [],
    universes: {}, // id -> { stage, evidence }
    arbiter: null,
    winner: null,
    finished: false,
    cancelled: false,
    staleFiles: [],
    error: null,
});

export function useShadowVerify(jobId) {
    const [state, setState] = useState(initial);
    const ctrlRef = useRef(null);

    useEffect(() => {
        if (!jobId) {
            setState(initial());
            return undefined;
        }

        const controller = new AbortController();
        ctrlRef.current = controller;
        let cancelled = false;

        setState({ ...initial(), jobId });

        (async () => {
            let response;
            try {
                response = await fetch(`/api/shadow/${encodeURIComponent(jobId)}/stream`, {
                    headers: { accept: 'text/event-stream' },
                    signal: controller.signal,
                });
            } catch (e) {
                if (!cancelled) setState((s) => ({ ...s, error: String(e?.message || e) }));
                return;
            }

            if (!response.ok || !response.body) {
                if (!cancelled) setState((s) => ({ ...s, error: `stream HTTP ${response.status}` }));
                return;
            }

            const reader = response.body
                .pipeThrough(new TextDecoderStream())
                .getReader();

            let buf = '';
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += value;
                    let idx;
                    while ((idx = buf.indexOf('\n\n')) !== -1) {
                        const frame = buf.slice(0, idx);
                        buf = buf.slice(idx + 2);
                        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
                        if (!dataLine) continue;
                        let evt;
                        try {
                            evt = JSON.parse(dataLine.slice(6));
                        } catch (_) {
                            continue;
                        }
                        setState((s) => reduce(s, evt));
                    }
                }
            } catch (e) {
                if (!cancelled) setState((s) => ({ ...s, error: String(e?.message || e) }));
            }
        })();

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [jobId]);

    const apply = async (universeId) => {
        if (!jobId) return null;
        const res = await fetch(`/api/shadow/${encodeURIComponent(jobId)}/apply`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ universeId }),
        });
        return res.json().catch(() => ({}));
    };

    const cancel = async () => {
        if (!jobId) return null;
        const res = await fetch(`/api/shadow/${encodeURIComponent(jobId)}/cancel`, {
            method: 'POST',
        });
        return res.json().catch(() => ({}));
    };

    return { ...state, apply, cancel };
}

function reduce(s, evt) {
    switch (evt.type) {
        case 'job_started':
            return { ...s, tier: evt.tier, universesPlanned: evt.universes_planned || 0 };
        case 'snapshot_taken':
            return { ...s, snapshotFiles: evt.files || [] };
        case 'universe_started': {
            const universes = { ...s.universes };
            universes[evt.id] = {
                id: evt.id,
                stage: 'starting',
                modelGen: evt.model_gen,
                modelCritic: evt.model_critic,
                style: evt.style,
                evidence: null,
            };
            return { ...s, universes };
        }
        case 'universe_progress': {
            const u = s.universes[evt.id];
            if (!u) return s;
            return {
                ...s,
                universes: { ...s.universes, [evt.id]: { ...u, stage: evt.stage, detail: evt.detail || null } },
            };
        }
        case 'universe_done': {
            const u = s.universes[evt.id] || { id: evt.id };
            return {
                ...s,
                universes: {
                    ...s.universes,
                    [evt.id]: { ...u, stage: 'done', evidence: evt },
                },
            };
        }
        case 'staleness_detected':
            return { ...s, staleFiles: evt.files || [] };
        case 'arbiter_verdict':
            return { ...s, arbiter: evt };
        case 'all_done':
            return { ...s, finished: true, winner: evt.winner || null };
        case 'error':
            return { ...s, error: `${evt.stage}: ${evt.msg}` };
        default:
            return s;
    }
}
