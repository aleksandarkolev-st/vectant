'use client';

import React, { useCallback, useEffect, useState } from 'react';

/**
 * Synthi Genome — Cost dashboard for shadow verify (Wave 4).
 *
 * Master plan §17 + §22:
 *  - shows estimated_cost_usd up-front, daily cap, spent today, and
 *    a 30-day mini-history sparkline.
 *  - lets the user adjust the daily cap inline.
 *
 * Drop into the existing usage panel; refreshes itself on a 30s timer
 * plus on demand via the `refresh` callback.
 */

const POLL_INTERVAL_MS = 30_000;

function fmtUsd(n) {
    if (typeof n !== 'number') return '—';
    return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function pctOfCap(spent, cap) {
    if (!cap || cap <= 0) return 0;
    return Math.max(0, Math.min(1, spent / cap));
}

export function ShadowCostPanel({ workspacePath }) {
    const [state, setState] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [editingCap, setEditingCap] = useState(false);
    const [capDraft, setCapDraft] = useState('');

    const refresh = useCallback(async () => {
        if (!workspacePath) return;
        setLoading(true);
        try {
            const res = await fetch(
                `/api/shadow/cost?workspace_path=${encodeURIComponent(workspacePath)}`
            );
            if (!res.ok) {
                setError(`HTTP ${res.status}`);
            } else {
                const data = await res.json();
                setState(data);
                setError(null);
            }
        } catch (e) {
            setError(String(e?.message || e));
        } finally {
            setLoading(false);
        }
    }, [workspacePath]);

    useEffect(() => {
        refresh();
        const id = setInterval(refresh, POLL_INTERVAL_MS);
        return () => clearInterval(id);
    }, [refresh]);

    const onSubmitCap = useCallback(async (event) => {
        event.preventDefault();
        const next = Number(capDraft);
        if (!Number.isFinite(next) || next < 0) {
            setError('Cap must be a non-negative number');
            return;
        }
        try {
            const res = await fetch('/api/shadow/cost', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workspace_path: workspacePath, daily_cap_usd: next }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || `HTTP ${res.status}`);
            }
        } catch (e) {
            setError(String(e?.message || e));
            return;
        }
        setEditingCap(false);
        await refresh();
    }, [capDraft, refresh, workspacePath]);

    if (!workspacePath) return null;

    const spent = state?.spent_today_usd ?? 0;
    const cap = state?.daily_cap_usd ?? 0;
    const pct = pctOfCap(spent, cap);
    const overCap = spent > cap && cap > 0;

    return (
        <div className={`genome-cost-panel ${overCap ? 'genome-cost-panel--over' : ''}`}>
            <header className="genome-cost-panel__head">
                <span aria-hidden="true">$</span>
                <span>Shadow verify spend</span>
                {loading ? <span className="genome-cost-panel__spinner" aria-hidden="true">…</span> : null}
            </header>
            <div className="genome-cost-panel__numbers">
                <div>
                    <div className="genome-cost-panel__label">today</div>
                    <div className="genome-cost-panel__value">{fmtUsd(spent)}</div>
                </div>
                <div>
                    <div className="genome-cost-panel__label">cap</div>
                    {editingCap ? (
                        <form onSubmit={onSubmitCap} className="genome-cost-panel__cap-form">
                            <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={capDraft}
                                onChange={(e) => setCapDraft(e.target.value)}
                                autoFocus
                            />
                            <button type="submit">Save</button>
                            <button type="button" onClick={() => setEditingCap(false)}>Cancel</button>
                        </form>
                    ) : (
                        <div
                            className="genome-cost-panel__value genome-cost-panel__value--editable"
                            role="button"
                            tabIndex={0}
                            onClick={() => { setCapDraft(String(cap)); setEditingCap(true); }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    setCapDraft(String(cap));
                                    setEditingCap(true);
                                }
                            }}
                        >
                            {fmtUsd(cap)}
                        </div>
                    )}
                </div>
                <div>
                    <div className="genome-cost-panel__label">remaining</div>
                    <div className="genome-cost-panel__value">{fmtUsd(state?.remaining_usd ?? 0)}</div>
                </div>
            </div>
            <div
                className="genome-cost-panel__bar"
                role="progressbar"
                aria-valuenow={Math.round(pct * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
            >
                <div
                    className="genome-cost-panel__bar-fill"
                    style={{ width: `${Math.round(pct * 100)}%` }}
                />
            </div>
            {overCap ? (
                <p className="genome-cost-panel__warn">⚠ Today's spend has exceeded your cap.</p>
            ) : null}
            {Array.isArray(state?.history) && state.history.length > 1 ? (
                <Sparkline history={state.history} cap={cap} />
            ) : null}
            {Array.isArray(state?.today_jobs) && state.today_jobs.length > 0 ? (
                <details className="genome-cost-panel__jobs">
                    <summary>{state.today_jobs.length} job(s) today</summary>
                    <ul>
                        {state.today_jobs.slice(-8).reverse().map((j) => (
                            <li key={j.job_id}>
                                <code>{j.tier}</code> · {fmtUsd(j.estimated_usd)}
                                {j.refund_usd ? ` (–${fmtUsd(j.refund_usd)} refund)` : ''}
                                {' · '}
                                {j.outcome || 'running'}
                            </li>
                        ))}
                    </ul>
                </details>
            ) : null}
            {error ? <p className="genome-cost-panel__error">⚠ {error}</p> : null}
        </div>
    );
}

function Sparkline({ history, cap }) {
    // Cheap inline SVG sparkline. We deliberately avoid a chart lib.
    const points = history.slice(-30);
    const max = Math.max(cap || 0.01, ...points.map((p) => p.total_usd ?? 0)) || 1;
    const w = 160;
    const h = 30;
    const stepX = points.length > 1 ? w / (points.length - 1) : 0;
    const path = points
        .map((p, i) => {
            const x = i * stepX;
            const y = h - ((p.total_usd ?? 0) / max) * h;
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(' ');
    return (
        <svg
            className="genome-cost-panel__spark"
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            aria-hidden="true"
        >
            <path d={path} fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
    );
}

export default ShadowCostPanel;
