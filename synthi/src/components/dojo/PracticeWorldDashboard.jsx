'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Beaker, DatabaseZap, Play, ShieldCheck } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function PracticeWorldDashboard({
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
        setError(err?.message || 'dojo_practice_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const practice = summary.practice || createEmptyDojoSummary(workspaceSlug).practice;
  const skill = summary.selectedSkill;
  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const selectedScenario = useMemo(() => practice.scenarios?.[0] || null, [practice.scenarios]);
  const latestRun = practice.latestRun || practice.windTunnel?.runs?.[0] || null;

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="dojo-practice-world"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Practice World</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              Synthetic fixtures, executable scenario runs, Wind Tunnel outcomes, and oracle evidence for the selected skill.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <Beaker size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : `${practice.scenarios.length} scenarios`}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        {skill ? (
          <>
            <section className="grid gap-3 md:grid-cols-5" aria-label="Practice metrics">
              <Metric label="Scenarios" value={practice.scenarios.length || skill.scenarioCount || 0} />
              <Metric label="Wind Runs" value={practice.windTunnel.runCount} />
              <Metric label="Passed" value={practice.windTunnel.passCount} tone="passed" />
              <Metric label="Failed" value={practice.windTunnel.failCount} tone="failed" />
              <Metric label="Blocked" value={practice.windTunnel.blockedCount} tone="blocked" />
            </section>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 rounded-md border" style={panelStyle}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold">Scenario List</h2>
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {skill.title} · {practice.coverage.criticalFailures} critical failures · {Math.round(practice.coverage.score * 100)}% coverage
                    </p>
                  </div>
                  <StatusPill status={practice.organoid.syntheticOnly ? 'synthetic-only' : 'needs-review'} />
                </div>
                <ScenarioList scenarios={practice.scenarios} selectedScenario={selectedScenario} />
              </div>

              <aside className="rounded-md border p-4" style={panelStyle}>
                <h2 className="text-sm font-semibold">Organoid Fixture</h2>
                <dl className="mt-3 grid gap-2 text-xs">
                  <Detail label="Synthetic data" value={practice.organoid.syntheticOnly ? 'Only' : 'Unverified'} />
                  <Detail label="Fixture seed" value={practice.organoid.fixtureSeed || 'Backend generated'} />
                  <Detail label="Tissues" value={practice.organoid.tissueNames.length ? practice.organoid.tissueNames.join(', ') : 'Not reported'} />
                  <Detail label="Stop reason" value={practice.windTunnel.stopReason || 'Budget not exhausted'} />
                </dl>
                <div className="mt-4 rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }} data-testid="dojo-practice-latest-evidence">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                    <DatabaseZap size={14} aria-hidden="true" />
                    Latest Evidence
                  </div>
                  {latestRun ? (
                    <div className="space-y-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      <div className="flex items-center justify-between gap-3">
                        <span className="truncate">{latestRun.scenarioId || latestRun.runId}</span>
                        <StatusPill status={latestRun.status} />
                      </div>
                      <p className="line-clamp-3">{latestRun.finding || latestRun.fixtureHash || 'Observed evidence was recorded for this run.'}</p>
                      <p className="truncate" style={{ color: 'var(--text-muted)' }}>
                        {latestRun.evidenceRefs?.slice(0, 2).join(', ') || 'No evidence refs reported'}
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>
                      Run a scenario or Wind Tunnel suite to populate evidence.
                    </p>
                  )}
                </div>
              </aside>
            </section>

            <section className="rounded-md border" style={panelStyle} data-testid="dojo-wind-tunnel-matrix">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h2 className="text-sm font-semibold">Wind Tunnel Matrix</h2>
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Observed scenario outcomes from runtime or bridge evidence.</p>
                </div>
                <div className="inline-flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <Play size={13} aria-hidden="true" />
                  {practice.windTunnel.runCount} runs
                </div>
              </div>
              <WindTunnelMatrix runs={practice.windTunnel.runs} />
            </section>
          </>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="dojo-practice-empty">
            <h2 className="text-base font-semibold">No practice world yet</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              Publish or select a Dojo skill to inspect synthetic scenarios, fixture reset proof, and Wind Tunnel evidence.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

function ScenarioList({ scenarios, selectedScenario }) {
  if (!scenarios.length) {
    return (
      <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }} data-testid="dojo-scenario-empty">
        No scenario catalog is available.
      </div>
    );
  }
  return (
    <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }} data-testid="dojo-scenario-list">
      {scenarios.map((scenario) => (
        <div
          key={scenario.id}
          className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_140px_140px]"
          style={{ background: scenario.id === selectedScenario?.id ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' : 'transparent' }}
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{scenario.title}</div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <span>{scenario.id}</span>
              {scenario.riskTags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
            </div>
          </div>
          <div className="min-w-0 text-xs">
            <div style={{ color: 'var(--text-muted)' }}>Mutation</div>
            <div className="mt-1 truncate font-medium">{scenario.mutationKind || 'baseline'}</div>
          </div>
          <div className="min-w-0 text-xs">
            <div style={{ color: 'var(--text-muted)' }}>Expected</div>
            <div className="mt-1 truncate font-medium">{scenario.expectedBehavior || 'Oracle defined'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function WindTunnelMatrix({ runs }) {
  if (!runs.length) {
    return (
      <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
        No Wind Tunnel runs have been reported.
      </div>
    );
  }
  return (
    <>
      <div className="divide-y md:hidden" style={{ borderColor: 'var(--border-subtle)' }}>
        {runs.map((run) => (
          <div key={run.runId} className="grid gap-3 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-medium">{run.scenarioId || run.runId}</div>
                <div className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{run.runId}</div>
              </div>
              <StatusPill status={run.status} />
            </div>
            <dl className="grid gap-2 text-xs">
              <Detail label="Mutation" value={run.mutationKind || 'baseline'} />
              <Detail label="Tier" value={run.simulatorTier || 'synthetic'} />
              <Detail label="Evidence" value={run.evidenceRefs?.slice(0, 1).join(', ') || run.finding || 'Recorded'} />
            </dl>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="min-w-full table-fixed text-left text-xs">
          <thead style={{ color: 'var(--text-muted)' }}>
            <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <th className="w-56 px-4 py-3 font-medium">Scenario</th>
              <th className="w-32 px-4 py-3 font-medium">Status</th>
              <th className="w-36 px-4 py-3 font-medium">Mutation</th>
              <th className="w-28 px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.runId} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
                <td className="px-4 py-3">
                  <div className="truncate font-medium">{run.scenarioId || run.runId}</div>
                  <div className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{run.runId}</div>
                </td>
                <td className="px-4 py-3"><StatusPill status={run.status} /></td>
                <td className="truncate px-4 py-3">{run.mutationKind || 'baseline'}</td>
                <td className="truncate px-4 py-3">{run.simulatorTier || 'synthetic'}</td>
                <td className="px-4 py-3">
                  <div className="truncate">{run.evidenceRefs?.slice(0, 2).join(', ') || run.finding || 'Recorded'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Metric({ label, value, tone = '' }) {
  const color = {
    passed: 'var(--accent-success)',
    failed: 'var(--accent-danger)',
    blocked: 'var(--accent-warning)',
  }[tone] || 'var(--text-primary)';
  return (
    <div className="rounded-md border px-3 py-3" style={panelStyle}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 truncate text-xl font-semibold" style={{ color }}>{value}</div>
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}

function StatusPill({ status }) {
  const normalized = String(status || 'unknown').toLowerCase();
  const tone = normalized.includes('pass') || normalized === 'synthetic-only'
    ? 'var(--accent-success)'
    : normalized.includes('fail')
      ? 'var(--accent-danger)'
      : normalized.includes('block')
        ? 'var(--accent-warning)'
        : 'var(--text-muted)';
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-md border px-2 text-[11px]" style={{ ...panelStyle, color: tone }}>
      <ShieldCheck size={12} aria-hidden="true" />
      {normalized || 'unknown'}
    </span>
  );
}
