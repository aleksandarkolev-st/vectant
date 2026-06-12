'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Landmark } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import AntibodyRegistry from './AntibodyRegistry';
import CaseLawRegistry from './CaseLawRegistry';
import GuardrailProvenance from './GuardrailProvenance';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function CaseLawDashboard({
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
        setError(err?.message || 'dojo_case_law_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const caseLaw = summary.selectedSkill?.caseLaw || summary.caseLaw || createEmptyDojoSummary(workspaceSlug).caseLaw;
  const metrics = caseLaw.metrics;
  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const hasCaseLaw = metrics.recordCount > 0 || metrics.guardrailCount > 0 || metrics.antibodyCount > 0;

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="dojo-case-law-dashboard"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Case Law</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <Landmark size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : `${metrics.bindingCount} binding`}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        {hasCaseLaw ? (
          <>
            <section className="grid gap-3 md:grid-cols-6" aria-label="Case law metrics">
              <Metric label="Cases" value={metrics.recordCount} />
              <Metric label="Binding" value={metrics.bindingCount} />
              <Metric label="Proposed" value={metrics.proposedCount} />
              <Metric label="Deprecated" value={metrics.deprecatedCount} />
              <Metric label="Guardrails" value={metrics.guardrailCount} />
              <Metric label="Antibodies" value={metrics.antibodyCount} />
            </section>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              <CaseLawRegistry records={caseLaw.records} />
              <div className="grid gap-4">
                <GuardrailProvenance guardrails={caseLaw.guardrails} />
                <AntibodyRegistry antibodies={caseLaw.antibodies} />
              </div>
            </section>
          </>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="dojo-case-law-empty">
            <h2 className="text-base font-semibold">No case law yet</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              No case-law records, guardrail provenance, or antibody transfers are linked to this workspace.
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
