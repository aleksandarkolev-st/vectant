'use client';

import React, { useCallback, useEffect, useState } from 'react';

function requestUrl(workspacePath, taskClass) {
  const query = new URLSearchParams({ workspace_path: workspacePath, ...(taskClass ? { task_class: taskClass } : {}) });
  return `/api/counterfactual/inspection?${query.toString()}`;
}

/**
 * Read-only, workspace-scoped inspection of durable counterfactual telemetry.
 * The endpoint returns compact summaries only. This component intentionally
 * never asks for source, prompts, or raw runner artifacts.
 */
export function CounterfactualInspection({ workspacePath, taskClass = '' }) {
  const [state, setState] = useState({ loading: Boolean(workspacePath), error: null, inspection: null });
  const refresh = useCallback(async () => {
    if (!workspacePath) return;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetch(requestUrl(workspacePath, taskClass));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Counterfactual inspection is unavailable');
      setState({ loading: false, error: null, inspection: body.inspection || {} });
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: String(error?.message || error) }));
    }
  }, [workspacePath, taskClass]);

  useEffect(() => { refresh(); }, [refresh]);
  if (!workspacePath) return null;
  const inspection = state.inspection || {};
  const scenes = inspection.choice_scenes || [];
  const fossils = inspection.fossils || [];
  const trials = inspection.mutation_trials || [];
  return (
    <details className="mt-3 border-t border-[var(--border-subtle)] pt-3" data-testid="counterfactual-inspection">
      <summary className="cursor-pointer text-xs font-semibold text-[var(--text-primary)]">Inspect recorded evidence</summary>
      <p className="mt-1 text-[11px] text-[var(--text-muted)]">Compact workspace telemetry only. Raw source, prompts, and runner transcripts are excluded.</p>
      {state.loading ? <p className="mt-2 text-[11px] text-[var(--text-muted)]">Loading persisted inspection…</p> : null}
      {scenes.length ? <ul className="mt-2 space-y-1 text-[11px] text-[var(--text-secondary)]" aria-label="Recorded choice scenes">
        {scenes.slice(0, 5).map((scene) => <li key={scene.id}>Choice scene: visible {scene.visible_universe_ids?.join(', ') || 'none'}; selected {scene.selected_universe_id || 'none'}; ambiguity {scene.ambiguity_flags?.join(', ') || 'none'}.</li>)}
      </ul> : <p className="mt-2 text-[11px] text-[var(--text-muted)]">No comparable choice scenes recorded.</p>}
      {fossils.length ? <ul className="mt-2 space-y-1 text-[11px] text-[var(--text-secondary)]" aria-label="Branch fossils">
        {fossils.slice(0, 5).map((fossil) => <li key={fossil.id}>Branch fossil: {fossil.direction_label}; proof {fossil.detector_summary?.every((result) => result.status === 'passed') ? 'passed' : 'recorded'}; counterfactual strength {fossil.counterfactual_strength}.</li>)}
      </ul> : null}
      {trials.length ? <ul className="mt-2 space-y-1 text-[11px] text-[var(--text-secondary)]" aria-label="Quarantined mutation trials">
        {trials.slice(0, 5).map((trial) => <li key={trial.id}>Mutation Trial: {trial.status}; budget cap ${trial.budget_cap_usd}; stricter proof {trial.result || 'pending'}; never auto-applied.</li>)}
      </ul> : null}
      <button type="button" className="th-focus-ring mt-2 text-[11px] text-[var(--text-muted)]" onClick={refresh} disabled={state.loading}>Refresh inspection</button>
      {state.error ? <p role="alert" className="mt-2 text-[11px] text-[var(--status-danger)]">{state.error}</p> : null}
    </details>
  );
}

export default CounterfactualInspection;
