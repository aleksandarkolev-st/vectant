'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Ban, CheckCircle2, GitBranch, Microscope, ShieldCheck } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';

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

const innerStyle = {
  width: '100%',
  maxWidth: 1280,
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  minWidth: 0,
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
  gap: 12,
  minWidth: 0,
};

export default function TherapeuticTomographyTrace({
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
        setError(err?.message || 'dojo_tomography_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const tomography = summary.tomography || createEmptyDojoSummary(workspaceSlug).tomography;
  const trace = tomography.trace;
  const proof = trace?.proofCapsules?.[0] || null;
  const blocked = trace?.blockedOverreachAttempts?.[0] || null;
  const approvedDose = trace?.authorityDoses?.find((dose) => dose.decision === 'approved') || trace?.authorityDoses?.[0] || null;
  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const sequence = useMemo(() => buildSequence(trace, blocked, approvedDose), [trace, blocked, approvedDose]);

  return (
    <main className="min-h-screen px-5 py-5 text-sm" style={pageStyle} data-testid="therapeutic-tomography-trace">
      <div className="mx-auto flex max-w-7xl flex-col gap-4" style={innerStyle}>
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)', margin: '12px 0 0', overflowWrap: 'anywhere' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal" style={{ margin: '4px 0 0', overflowWrap: 'anywhere' }}>Therapeutic Tomography</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: 'var(--text-secondary)', margin: '8px 0 0' }}>
              {trace?.userGoal || 'Proof-gated access planning trace.'}
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <ShieldCheck size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : trace?.finalOutcome || 'No trace'}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        {trace ? (
          <>
            <section aria-label="Therapeutic tomography metrics" style={gridStyle}>
              <Metric label="Current dose" value={trace.currentAuthorityDose} />
              <Metric label="Probes" value={tomography.metrics.probeCount} />
              <Metric label="Machine claims" value={tomography.metrics.machineClaimCount} />
              <Metric label="Avoided access" value={tomography.metrics.avoidedAccessCount} />
            </section>

            <section className="rounded-md border p-4" style={panelStyle} data-testid="tomography-sequence">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold" style={{ margin: 0 }}>Authority Sequence</h2>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{trace.taskClass}</span>
              </div>
              <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 160px), 1fr))' }}>
                {sequence.map((step) => (
                  <SequenceStep key={`${step.kind}-${step.label}`} step={step} />
                ))}
              </div>
            </section>

            <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]" style={{ display: 'grid', gap: 16, alignItems: 'start', minWidth: 0 }}>
              <ProofCapsulePanel proof={proof} />
              <TraceDecisionPanel trace={trace} blocked={blocked} approvedDose={approvedDose} />
            </section>

            <section className="rounded-md border p-4" style={panelStyle} data-testid="tomography-avoided-access">
              <h2 className="text-sm font-semibold" style={{ margin: 0 }}>Avoided Access</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {trace.avoidedAccess.map((item) => (
                  <span key={item} className="inline-flex h-8 items-center rounded-md border px-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }}>
                    {item}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-sm leading-6" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
                {trace.diagnosis}
              </p>
            </section>
          </>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="tomography-empty">
            <h2 className="text-base font-semibold">No tomography trace yet</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              Run a proof-gated diagnostic trace to show authority doses, lower-risk probes, proof claims, and avoided access.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

function buildSequence(trace, blocked, approvedDose) {
  if (!trace) return [];
  const sequence = [];
  if (blocked) {
    sequence.push({
      kind: 'Blocked',
      label: blocked.requestedAccess.dataClasses.join(', ') || 'Broad access',
      detail: blocked.reason.join(', '),
      tone: 'danger',
    });
  }
  for (const probe of trace.projectionProbes) {
    sequence.push({
      kind: 'Probe',
      label: probe.name,
      detail: `gain ${probe.actualInformationGain}, confidence ${Math.round(probe.confidence * 100)}%`,
      tone: 'probe',
    });
  }
  if (trace.proofCapsules?.[0]) {
    sequence.push({
      kind: 'Proof',
      label: trace.proofCapsules[0].approved ? 'Strict Proof Gate approved' : 'Strict Proof Gate blocked',
      detail: `${trace.proofCapsules[0].machineClaims.length} machine claims`,
      tone: trace.proofCapsules[0].approved ? 'success' : 'danger',
    });
  }
  if (approvedDose) {
    sequence.push({
      kind: `Dose ${approvedDose.level}`,
      label: approvedDose.scope,
      detail: approvedDose.mutationAllowed ? 'write authority' : 'read-only authority',
      tone: approvedDose.mutationAllowed ? 'danger' : 'success',
    });
  }
  return sequence;
}

function SequenceStep({ step }) {
  const Icon = step.tone === 'danger' ? Ban : step.tone === 'probe' ? Microscope : CheckCircle2;
  return (
    <article className="rounded-md border p-3" style={{ ...panelStyle, minWidth: 0 }}>
      <div className="flex items-center gap-2 text-xs" style={{ color: step.tone === 'danger' ? 'var(--accent-warning)' : 'var(--text-muted)' }}>
        <Icon size={14} aria-hidden="true" />
        <span>{step.kind}</span>
      </div>
      <h3 className="mt-2 text-sm font-semibold" style={{ overflowWrap: 'anywhere' }}>{step.label}</h3>
      <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{step.detail}</p>
    </article>
  );
}

function ProofCapsulePanel({ proof }) {
  if (!proof) return null;
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="tomography-proof-capsule">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold" style={{ margin: 0 }}>Strict Proof Capsule</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere' }}>{proof.id}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={{ ...panelStyle, color: proof.approved ? 'var(--accent-success)' : 'var(--accent-warning)' }}>
          {proof.approved ? 'approved' : 'blocked'}
        </span>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <ClaimColumn title="Machine-verifiable claims" claims={proof.machineClaims} />
        <ClaimColumn title="Human-reviewed claims" claims={proof.humanClaims} />
        <ClaimColumn title="Narrative claims" claims={proof.narrativeClaims} />
      </div>
    </section>
  );
}

function ClaimColumn({ title, claims }) {
  return (
    <div className="min-w-0">
      <h3 className="text-xs font-semibold" style={{ color: 'var(--text-muted)', margin: 0 }}>{title}</h3>
      <div className="mt-2 grid gap-2">
        {claims.map((claim) => (
          <article key={`${title}-${claim.claim}`} className="rounded-md border p-3 text-xs" style={{ ...panelStyle, minWidth: 0 }}>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start' }}>
              <span className="font-semibold" style={{ overflowWrap: 'break-word', wordBreak: 'normal', hyphens: 'none', lineHeight: 1.35 }}>{claim.claim}</span>
              <span className="rounded-md border px-2 py-1" style={{ ...panelStyle, lineHeight: 1 }}>{claim.result || claim.status || 'context_only'}</span>
            </div>
            {claim.evidence ? (
              <p className="mt-2 truncate leading-5" style={{ color: 'var(--text-muted)', overflowWrap: 'anywhere', maxWidth: '100%' }}>{claim.evidence}</p>
            ) : null}
          </article>
        ))}
      </div>
    </div>
  );
}

function TraceDecisionPanel({ trace, blocked, approvedDose }) {
  const uncertainty = trace.uncertainties?.[0];
  return (
    <aside className="grid gap-4" style={{ minWidth: 0 }}>
      <section className="rounded-md border p-4" style={panelStyle} data-testid="tomography-decision">
        <h2 className="flex items-center gap-2 text-sm font-semibold" style={{ margin: 0 }}>
          <GitBranch size={15} aria-hidden="true" />
          Decision
        </h2>
        <dl className="mt-3 grid gap-2 text-xs">
          <Info label="Uncertainty" value={uncertainty?.description || 'Not recorded'} />
          <Info label="Blocked" value={blocked?.requestedAccess.dataClasses.join(', ') || 'None'} />
          <Info label="Approved" value={approvedDose?.scope || 'None'} />
          <Info label="Revocation" value={approvedDose?.revokePlan || 'Not recorded'} />
        </dl>
      </section>
      <section className="rounded-md border p-4" style={panelStyle}>
        <h2 className="text-sm font-semibold" style={{ margin: 0 }}>Remediation Boundary</h2>
        <p className="mt-3 text-sm leading-6" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
          {trace.remediationPlan || 'Diagnosis does not authorize mutation. Request a separate remediation proof before write access.'}
        </p>
      </section>
    </aside>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-md border px-3 py-3" style={{ ...panelStyle, minWidth: 0 }}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 truncate text-xl font-semibold" style={{ overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(86px, 0.4fr) minmax(0, 1fr)', minWidth: 0 }}>
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0" style={{ margin: 0, overflowWrap: 'break-word', wordBreak: 'normal', textAlign: 'right' }}>{value}</dd>
    </div>
  );
}
