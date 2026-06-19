'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, GitCompareArrows, History, Route, ShieldCheck } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import GhostModePanel from './GhostModePanel';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function TimeMachineDebugger({
  workspaceSlug = '',
  initialSummary,
  loadSummary = getDojoWorkspaceSummary,
  autoLoad = true,
}) {
  const [summary, setSummary] = useState(initialSummary || createEmptyDojoSummary(workspaceSlug));
  const [loading, setLoading] = useState(autoLoad && !initialSummary);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!autoLoad) return undefined;
    const controller = new AbortController();
    setLoading(true);
    loadSummary({ workspaceSlug, signal: controller.signal })
      .then((next) => {
        setSummary(next);
        setError('');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err?.message || 'dojo_debug_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const skill = summary.selectedSkill;
  const debug = skill?.debug || summary.debug || createEmptyDojoSummary(workspaceSlug).debug;
  const timeMachine = debug.timeMachine;
  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const replayEvidenceCount = useMemo(
    () => (timeMachine?.replayPlan || []).reduce((total, step) => total + step.expectedEvidence.length, 0),
    [timeMachine],
  );

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="dojo-time-machine"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Time Machine Debugger</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              {skill?.label || 'Selected skill'} debug state with branch outcome, replay evidence, and shadow-run mismatch status.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <History size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : timeMachine?.baseline?.status || 'No debug run'}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        {skill && timeMachine ? (
          <>
            <section className="grid gap-3 md:grid-cols-4" aria-label="Debugger metrics">
              <Metric label="Baseline" value={timeMachine.baseline.status} />
              <Metric label="Counterfactual" value={timeMachine.counterfactual.expectedStatusAfterChange || 'review'} />
              <Metric label="Replay Steps" value={timeMachine.replayPlan.length} />
              <Metric label="Evidence Refs" value={replayEvidenceCount} />
            </section>

            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div className="rounded-md border p-4" style={panelStyle}>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <GitCompareArrows size={15} aria-hidden="true" />
                  Counterfactual Branch
                </div>
                <p className="mt-3 max-w-3xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
                  {timeMachine.question}
                </p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <OutcomePanel title="Baseline" outcome={timeMachine.baseline.status} rows={[
                    ['Scenario', timeMachine.baseline.scenarioId || 'Not recorded'],
                    ['Mutation', timeMachine.baseline.mutationKind || 'Not recorded'],
                    ['Finding', timeMachine.baseline.finding || 'No finding recorded'],
                  ]} />
                  <OutcomePanel title="Counterfactual" outcome={timeMachine.counterfactual.expectedStatusAfterChange || 'review'} rows={[
                    ['Changed', timeMachine.counterfactual.changedVariable || 'Not recorded'],
                    ['Causal finding', timeMachine.counterfactual.causalFinding || 'No causal finding recorded'],
                    ['License impact', timeMachine.counterfactual.licenseImpact || 'No license impact recorded'],
                  ]} />
                </div>
              </div>

              <aside className="rounded-md border p-4" style={panelStyle}>
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck size={15} aria-hidden="true" />
                  Impacted Guardrails
                </h2>
                {timeMachine.guardrails.length ? (
                  <div className="mt-3 grid gap-2">
                    {timeMachine.guardrails.map((guardrail) => (
                      <div key={`${guardrail.id}-${guardrail.title}`} className="rounded-md border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="font-semibold">{guardrail.title || guardrail.id}</div>
                        {guardrail.rule ? <div className="mt-1" style={{ color: 'var(--text-muted)' }}>{guardrail.rule}</div> : null}
                        {guardrail.severity ? <div className="mt-1" style={{ color: 'var(--text-muted)' }}>{guardrail.severity}</div> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>No guardrails were linked to this branch.</p>
                )}
              </aside>
            </section>

            <section className="rounded-md border" style={panelStyle} data-testid="time-machine-replay-plan">
              <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold" style={{ borderColor: 'var(--border-subtle)' }}>
                <Route size={15} aria-hidden="true" />
                Replay Plan
              </div>
              <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
                {timeMachine.replayPlan.map((step) => (
                  <div key={step.step} className="grid gap-3 px-4 py-3 md:grid-cols-[180px_120px_minmax(0,1fr)]">
                    <div className="truncate font-semibold">{step.step}</div>
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Tier {step.simulatorTier}</div>
                    <div className="truncate text-xs">{step.expectedEvidence.join(', ') || 'No evidence refs'}</div>
                  </div>
                ))}
              </div>
            </section>

            <GhostModePanel ghostRun={debug.ghostRun} />
          </>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="time-machine-empty">
            <h2 className="text-base font-semibold">No debug run yet</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              No branch, replay, or shadow evidence is currently linked to this skill.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-md border px-3 py-3" style={panelStyle}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 truncate text-xl font-semibold">{value}</div>
    </div>
  );
}

function OutcomePanel({ title, outcome, rows }) {
  return (
    <section className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{outcome}</span>
      </div>
      <dl className="mt-3 grid gap-2 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
            <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
            <dd className="min-w-0 text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
