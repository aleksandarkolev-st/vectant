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
    convergence: null, // { downgrading_to, cohort? }
    policyHints: [],
    directionForecast: [],
    learnedLines: [],
    policyDeltas: [],
    reviewedUniverseIds: [],
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
            body: JSON.stringify({
                universeId,
                openedDiffUniverseIds: state.reviewedUniverseIds || [],
            }),
        });
        const data = await res.json().catch(() => ({}));
        setState((s) => applySelectionResult(s, data));
        return data;
    };

    const markUniverseReviewed = (universeId) => {
        setState((s) => ({
            ...s,
            reviewedUniverseIds: mergeUnique(s.reviewedUniverseIds, [universeId]),
        }));
    };

    const cancel = async () => {
        if (!jobId) return null;
        const res = await fetch(`/api/shadow/${encodeURIComponent(jobId)}/cancel`, {
            method: 'POST',
        });
        const data = await res.json().catch(() => ({}));
        setState((s) => ({ ...s, cancelled: true }));
        return data;
    };

    const askWhy = async (question) => {
        if (!jobId) return null;
        const res = await fetch(`/api/shadow/${encodeURIComponent(jobId)}/why`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question: String(question || '') }),
        });
        const data = await res.json().catch(() => ({}));
        if (data?.verdict) {
            setState((s) => ({ ...s, arbiter: { ...data.verdict, type: 'arbiter_verdict' } }));
        }
        return data;
    };

    return { ...state, apply, cancel, askWhy, markUniverseReviewed };
}

export function reduce(s, evt) {
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
        case 'convergence_detected':
            return {
                ...s,
                convergence: {
                    downgrading_to: evt.downgrading_to ?? 1,
                    cohort: evt.cohort || Object.keys(s.universes || {}),
                },
            };
        case 'counterfactual_policy':
            return {
                ...s,
                policyHints: evt.policy_hints || [],
                directionForecast: evt.direction_forecast || [],
            };
        case 'counterfactual_learned':
            return {
                ...s,
                learnedLines: mergeUnique(s.learnedLines, learnedLinesFromPayload(evt)),
                policyDeltas: [...(s.policyDeltas || []), ...(evt.policy_deltas || [])],
            };
        case 'universe_reviewed':
            return {
                ...s,
                reviewedUniverseIds: mergeUnique(s.reviewedUniverseIds, [evt.id]),
            };
        case 'all_done':
            return { ...s, finished: true, winner: evt.winner || null };
        case 'error':
            return {
                ...s,
                cancelled: evt.stage === 'cancel' ? true : s.cancelled,
                error: `${evt.stage}: ${evt.msg}`,
            };
        default:
            return s;
    }
}

export function applySelectionResult(s, data) {
    if (!data || typeof data !== 'object') return s;
    return {
        ...s,
        learnedLines: mergeUnique(s.learnedLines, learnedLinesFromPayload(data)),
        policyDeltas: [...(s.policyDeltas || []), ...(data.policy_deltas || [])],
    };
}

export function learnedLinesFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return [];
    const lines = [];
    const listFields = [
        payload.learned_lines,
        payload.learnedLines,
    ];
    for (const value of listFields) {
        if (Array.isArray(value)) lines.push(...value);
        else if (typeof value === 'string') lines.push(value);
    }
    for (const value of [payload.learned_from_this_run, payload.learnedFromThisRun]) {
        if (typeof value === 'string') lines.push(value);
    }
    return lines;
}

function mergeUnique(existing, incoming) {
    const values = [...(existing || []), ...(incoming || [])].filter(Boolean);
    return Array.from(new Set(values));
}
