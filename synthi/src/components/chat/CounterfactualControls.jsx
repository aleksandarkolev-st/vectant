'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Eye, EyeOff, RotateCcw, Trash2 } from 'lucide-react';
import { CounterfactualInspection } from './CounterfactualInspection';

const query = (workspacePath, taskClass) => new URLSearchParams({
  workspace_path: workspacePath,
  ...(taskClass ? { task_class: taskClass } : {}),
});

/** Workspace-scoped retention and policy controls for counterfactual telemetry. */
export function CounterfactualControls({ workspacePath, taskClass = '' }) {
  const [state, setState] = useState({ loading: Boolean(workspacePath), enabled: true, retention: null, deltas: [], error: null });
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspacePath) return;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const suffix = query(workspacePath, taskClass).toString();
      const [controlsResponse, deltasResponse] = await Promise.all([
        fetch(`/api/counterfactual/controls?${query(workspacePath).toString()}`),
        fetch(`/api/counterfactual/policy-deltas?${suffix}`),
      ]);
      const [controls, deltas] = await Promise.all([controlsResponse.json(), deltasResponse.json()]);
      if (!controlsResponse.ok || !deltasResponse.ok) throw new Error(controls.error || deltas.error || 'Telemetry state is unavailable');
      setState({ loading: false, enabled: controls.enabled, retention: controls.retention, deltas: deltas.policy_deltas || [], error: null });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: String(error?.message || error) }));
    }
  }, [workspacePath, taskClass]);

  useEffect(() => { refresh(); }, [refresh]);

  const update = async (body) => {
    if (!workspacePath) return;
    setSaving(true);
    try {
      const response = await fetch('/api/counterfactual/controls', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_path: workspacePath, ...body }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not update telemetry controls');
      await refresh();
    } catch (error) {
      setState((current) => ({ ...current, error: String(error?.message || error) }));
    } finally {
      setSaving(false);
    }
  };

  const removeDelta = async (id) => {
    if (!workspacePath) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/counterfactual/policy-deltas/${encodeURIComponent(id)}?${query(workspacePath).toString()}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not delete this learned policy');
      await refresh();
    } catch (error) {
      setState((current) => ({ ...current, error: String(error?.message || error) }));
    } finally {
      setSaving(false);
    }
  };

  const deleteAllTelemetry = async () => {
    if (!workspacePath || saving) return;
    if (!window.confirm('Delete all counterfactual telemetry for this workspace? This removes learned policies, fossils, choice scenes, and retained runner artifacts.')) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/counterfactual/telemetry?${query(workspacePath).toString()}`, { method: 'DELETE' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not delete workspace telemetry');
      await refresh();
    } catch (error) {
      setState((current) => ({ ...current, error: String(error?.message || error) }));
    } finally {
      setSaving(false);
    }
  };

  if (!workspacePath) return null;
  const retention = state.retention || { fossil_days: 365, raw_trace_days: 30 };
  return (
    <section className="mt-3 border-t border-[var(--border-subtle)] pt-3" data-testid="counterfactual-controls">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[var(--text-primary)]">Counterfactual telemetry</p>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">Stored locally for this workspace. Source and raw transcripts are not used as policy memory.</p>
        </div>
        <button type="button" className="th-focus-ring text-xs" disabled={saving || state.loading} onClick={() => update({ enabled: !state.enabled })}>
          {state.enabled ? <EyeOff className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />}
          {state.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>
      {state.enabled ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-[var(--text-muted)]">Fossils kept
            <input aria-label="Fossil retention days" className="ml-2 w-16 rounded border border-[var(--border-subtle)] bg-transparent px-1.5 py-1 text-xs text-[var(--text-primary)]" type="number" min="1" max="3650" value={retention.fossil_days} disabled={saving || state.loading} onChange={(event) => update({ fossil_days: Number(event.target.value) })} /> days
          </label>
          <span className="text-[11px] text-[var(--text-muted)]">Raw runner traces: {retention.raw_trace_days} days</span>
          <button type="button" className="th-focus-ring text-[11px] text-[var(--text-muted)]" disabled={saving || state.loading} onClick={refresh}>
            <RotateCcw className="mr-1 inline h-3 w-3" aria-hidden="true" />Refresh
          </button>
        </div>
      ) : <p className="mt-3 text-[11px] text-[var(--text-muted)]">New counterfactual telemetry is disabled. Existing lessons remain visible until deleted.</p>}
      {state.deltas.length ? <ul className="mt-3 space-y-2" aria-label="Learned policy deltas">
        {state.deltas.map((delta) => <li key={delta.id} className="flex items-start justify-between gap-3 text-[11px] text-[var(--text-secondary)]">
          <span>{delta.after}</span>
          <button type="button" aria-label={`Delete learned policy ${delta.id}`} className="th-focus-ring shrink-0 text-[var(--text-muted)] hover:text-[var(--status-danger)]" disabled={saving} onClick={() => removeDelta(delta.id)}><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
        </li>)}
      </ul> : <p className="mt-3 text-[11px] text-[var(--text-muted)]">No active learned policies for this task class.</p>}
      <button type="button" className="th-focus-ring mt-3 text-[11px] text-[var(--status-danger)]" disabled={saving || state.loading} onClick={deleteAllTelemetry}>
        <Trash2 className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />Delete all workspace telemetry
      </button>
      {state.error ? <p role="alert" className="mt-2 text-[11px] text-[var(--status-danger)]">{state.error}</p> : null}
      <CounterfactualInspection workspacePath={workspacePath} taskClass={taskClass} />
    </section>
  );
}

export default CounterfactualControls;
