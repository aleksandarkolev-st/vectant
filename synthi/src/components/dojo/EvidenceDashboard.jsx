'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, DatabaseZap, ShieldCheck } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import EvidenceLedgerChain from './EvidenceLedgerChain';
import RedactedEvidenceExportPanel from './RedactedEvidenceExportPanel';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
  boxSizing: 'border-box',
};

const pageStyle = {
  minHeight: '100vh',
  padding: 20,
  boxSizing: 'border-box',
  overflowX: 'hidden',
  background: 'var(--bg-app)',
  color: 'var(--text-primary)',
};

const pageInnerStyle = {
  width: '100%',
  maxWidth: 1280,
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  minWidth: 0,
};

const headerStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  borderBottom: '1px solid var(--border-subtle)',
  paddingBottom: 16,
};

const metricGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))',
  gap: 12,
  minWidth: 0,
};

const evidenceGridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))',
  gap: 16,
  alignItems: 'start',
  minWidth: 0,
};

const asideStyle = {
  display: 'grid',
  gap: 16,
  minWidth: 0,
};

export default function EvidenceDashboard({
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
        setError(err?.message || 'dojo_evidence_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const evidence = summary.selectedSkill?.evidence || summary.evidence || createEmptyDojoSummary(workspaceSlug).evidence;
  const metrics = evidence.metrics;
  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const hasEvidence = metrics.recordCount > 0 || metrics.exportArtifactCount > 0 || metrics.claimCount > 0;

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={pageStyle}
      data-testid="dojo-evidence-dashboard"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4" style={pageInnerStyle}>
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={headerStyle}>
          <div className="min-w-0" style={{ minWidth: 0 }}>
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)', margin: '12px 0 0', overflowWrap: 'anywhere' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal" style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}>Evidence Custody</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <DatabaseZap size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : `${metrics.recordCount} records`}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        {hasEvidence ? (
          <>
            <section className="grid gap-3 md:grid-cols-5" aria-label="Evidence metrics" style={metricGridStyle}>
              <Metric label="Records" value={metrics.recordCount} />
              <Metric label="Redacted" value={metrics.redactedCount} />
              <Metric label="Metadata" value={metrics.metadataOnlyCount} />
              <Metric label="Claims" value={metrics.claimCount} />
              <Metric label="Exports" value={metrics.exportArtifactCount} />
            </section>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]" style={evidenceGridStyle}>
              <EvidenceLedgerChain ledger={evidence.ledger} />
              <aside className="grid gap-4" style={asideStyle}>
                <CustodyPolicyPanel ledger={evidence.ledger} />
                <EvidenceClaimsPanel claims={evidence.claims} />
              </aside>
            </section>

            <RedactedEvidenceExportPanel exportManifest={evidence.redactedExport} />
          </>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="dojo-evidence-empty">
            <h2 className="text-base font-semibold">No evidence records yet</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              No ledger records, claim results, or redacted export artifacts are linked to this workspace.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

function CustodyPolicyPanel({ ledger }) {
  const storage = ledger?.storageModel || {};
  const retention = ledger?.retentionPolicy || {};
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="evidence-custody-policy">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck size={15} aria-hidden="true" />
        Custody Policy
      </h2>
      <dl className="mt-3 grid gap-2 text-xs" style={{ display: 'grid', gap: 8 }}>
        <Info label="Store" value={storage.live_state_store || storage.liveStateStore || 'Not recorded'} />
        <Info label="Repo export" value={storage.repo_export_policy || storage.repoExportPolicy || 'Not recorded'} />
        <Info label="Organoid data" value={String(storage.production_data_allowed_in_organoid ?? storage.productionDataAllowedInOrganoid ?? false)} />
        <Info label="Secrets" value={String(storage.secrets_allowed_in_repo ?? storage.secretsAllowedInRepo ?? false)} />
        <Info label="Refs only" value={String(retention.evidence_refs_only ?? retention.evidenceRefsOnly ?? false)} />
        <Info label="Recertify" value={retention.recertify_after_days ?? retention.recertifyAfterDays ?? 'Not recorded'} />
      </dl>
    </section>
  );
}

function EvidenceClaimsPanel({ claims }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="evidence-claims-panel">
      <h2 className="text-sm font-semibold">Evidence Claims</h2>
      {claims.length ? (
        <div className="mt-3 grid gap-2" style={{ display: 'grid', gap: 8, minWidth: 0 }}>
          {claims.map((claim) => (
            <article key={`${claim.claim}-${claim.status}`} className="rounded-md border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)', boxSizing: 'border-box', minWidth: 0, padding: 12 }}>
              <div className="flex flex-wrap items-center justify-between gap-2" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
                <h3 className="font-semibold" style={{ margin: 0, overflowWrap: 'anywhere' }}>{claim.claim}</h3>
                <span className="rounded-md border px-2 py-1" style={panelStyle}>{claim.status}</span>
              </div>
              <p className="mt-2 truncate" style={{ color: 'var(--text-muted)', margin: '8px 0 0', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{claim.evidenceRefs.join(', ') || 'No evidence refs'}</p>
            </article>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>No evidence claims are reported.</p>
      )}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-md border px-3 py-3" style={{ ...panelStyle, minWidth: 0, padding: 12 }}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 truncate text-xl font-semibold" style={{ marginTop: 4, overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3" style={{ display: 'grid', gridTemplateColumns: '88px minmax(0, 1fr)', gap: 12, minWidth: 0 }}>
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right" style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere', textAlign: 'right', wordBreak: 'break-word' }}>{value}</dd>
    </div>
  );
}
