'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Cable, ShieldCheck } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import ApiCandidateReview from './ApiCandidateReview';
import GeneratedToolReview from './GeneratedToolReview';
import SourceAffordancePrPlan from './SourceAffordancePrPlan';
import SubstrateLadderView from './SubstrateLadderView';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function SourceApiDashboard({
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
        setError(err?.message || 'dojo_source_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const source = summary.selectedSkill?.source || summary.source || createEmptyDojoSummary(workspaceSlug).source;
  const metrics = source.metrics;
  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const hasSourceData = metrics.uiActionCount > 0
    || metrics.patchCount > 0
    || metrics.apiCandidateCount > 0
    || metrics.generatedToolCount > 0
    || source.substrateNodes.length > 0;

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="dojo-source-api"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Source/API Graduation</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <Cable size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : source.sourcePrPlan.readiness}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        {hasSourceData ? (
          <>
            <section className="grid gap-3 md:grid-cols-6" aria-label="Source API metrics">
              <Metric label="UI Actions" value={metrics.uiActionCount} />
              <Metric label="Mapped" value={metrics.sourceMappedActionCount} />
              <Metric label="Patches" value={metrics.patchCount} />
              <Metric label="Review" value={metrics.reviewRequiredPatchCount} tone={metrics.reviewRequiredPatchCount ? 'warn' : ''} />
              <Metric label="API" value={metrics.apiCandidateCount} />
              <Metric label="Tools" value={metrics.generatedToolCount} />
            </section>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              <UiContractPanel contract={source.uiContract} />
              <SubstrateLadderView nodes={source.substrateNodes} />
            </section>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
              <SourceAffordancePrPlan plan={source.sourcePrPlan} />
              <div className="grid gap-4">
                <ApiCandidateReview candidates={source.apiCandidates} />
                <GeneratedToolReview tools={source.generatedTools} />
              </div>
            </section>
          </>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="dojo-source-empty">
            <h2 className="text-base font-semibold">No source/API artifacts yet</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              No Agent-Ready UI Contract, source patch plan, API candidate, or generated tool is linked to this skill.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

function UiContractPanel({ contract }) {
  const actions = contract?.actions || [];
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="agent-ready-ui-contract">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck size={15} aria-hidden="true" />
            Agent-Ready UI Contract
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{contract?.contractId || contract?.targetOrigin || 'no-contract-id'}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{actions.length} actions</span>
      </div>
      {actions.length ? (
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {actions.map((action) => (
            <article key={action.actionId} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{action.label}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{action.actionId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{action.allowedSubstrates.join(', ') || 'ui'}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <Detail label="Locator" value={action.stableLocator || action.fallbackLocators[0] || 'Not recorded'} />
                <Detail label="Source" value={action.sourceAnchorId || 'Not linked'} />
                <Detail label="Success" value={action.successCondition || 'Not recorded'} />
                <Detail label="Proof" value={action.proofClaims.join(', ') || 'Not required'} />
              </dl>
              {action.riskTags.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {action.riskTags.map((tag) => (
                    <span key={`${action.actionId}-${tag}`} className="rounded-md border px-2 py-1 text-[11px]" style={panelStyle}>{tag}</span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No UI contract actions are reported.</div>
      )}
    </section>
  );
}

function Metric({ label, value, tone = '' }) {
  const color = tone === 'warn' ? 'var(--accent-warning)' : 'var(--text-primary)';
  return (
    <div className="rounded-md border px-3 py-3" style={panelStyle}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 truncate text-xl font-semibold" style={{ color }}>{value}</div>
    </div>
  );
}

function Detail({ label, value }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
