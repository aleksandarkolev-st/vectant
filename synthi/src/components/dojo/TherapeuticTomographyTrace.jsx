'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Ban, CheckCircle2, GitBranch, Microscope, ShieldCheck, UserCheck, XCircle } from 'lucide-react';
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
  const latestCheckride = [...(tomography.checkrideReports || [])].reverse()[0] || null;
  const reviewRequests = tomography.reviewRequests || [];
  const latestRemediationVerification = [...(tomography.remediationVerifications || [])].reverse()[0] || null;
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
              <Metric label="Checkrides" value={tomography.metrics.checkrideCount || 0} />
              <Metric label="Learning" value={tomography.metrics.policyLearningCount || 0} />
              <Metric label="Pending reviews" value={tomography.metrics.pendingReviewCount || 0} />
            </section>

            <OperationalControlPanel trace={trace} proof={proof} blocked={blocked} approvedDose={approvedDose} reviewRequests={reviewRequests} remediationVerification={latestRemediationVerification} />
            <EvaluationPanel report={latestCheckride} learningRecords={tomography.policyLearningRecords || []} proofMetrics={tomography.proofMetrics || {}} />

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

function EvaluationPanel({ report, learningRecords = [], proofMetrics = {} }) {
  const results = report?.results || [];
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="tomography-evaluation">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold" style={{ margin: 0 }}>Dojo/Vivarium Evaluation</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)', marginBottom: 0 }}>
            Checkrides, policy-delta hypotheses, and case-law records
          </p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>
          auto grants: {report?.autoGrantsBroaderFutureAccess ? 'true' : 'false'}
        </span>
      </div>
      {results.length ? (
        <>
          <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))' }}>
            {results.map((result) => (
              <article key={result.checkrideId || result.kind} className="rounded-md border p-3" style={panelStyle}>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold">{formatCheckrideKind(result.kind)}</span>
                  <StatusIcon status={result.status} />
                </div>
                <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>{result.finding}</p>
              </article>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <InfoCard label="Passed" value={report.passedCount || 0} detail="deterministic or guarded checks" />
            <InfoCard label="Blocked" value={report.blockedCount || 0} detail="needs review or recertification" />
            <InfoCard label="Policy/case records" value={`${report.policyDeltaRecords?.length || 0}/${report.caseLawRecords?.length || 0}`} detail="hypotheses / proposed records" />
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm leading-6" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
          No operational checkride report has been recorded for this trace yet.
        </p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <InfoCard label="Proof latency p95" value={`${proofMetrics.proofVerificationLatencyP95 || 0} ms`} detail="runtime proof verification" />
        <InfoCard label="Deterministic" value={`${Math.round(proofMetrics.percentDecisionsDeterministic || 0)}%`} detail="Tier 0/1 without LLM/human" />
        <InfoCard label="Human reviewed" value={`${Math.round(proofMetrics.percentDecisionsHumanReviewed || 0)}%`} detail="Tier 2/3 judgment gates" />
        <InfoCard label="Token cost" value={proofMetrics.averageTokensPerAccessDecision || 0} detail="avg tokens per decision" />
      </div>
      <div className="mt-4 rounded-md border p-3" style={panelStyle}>
        <h3 className="text-xs font-semibold" style={{ margin: 0, color: 'var(--text-muted)' }}>Policy learning</h3>
        {learningRecords.length ? (
          <div className="mt-3 grid gap-2">
            {learningRecords.slice(0, 3).map((record) => (
              <article key={record.learningId || record.recommendation} className="rounded-md border p-3" style={panelStyle}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold">{formatCheckrideKind(record.learningKind)}</span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>confidence {Math.round((record.confidence || 0) * 100)}%</span>
                </div>
                <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>{record.recommendation}</p>
                <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)', marginBottom: 0 }}>
                  broader access auto-grant: {record.autoGrantsBroaderAccess ? 'true' : 'false'}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
            No policy-learning record has been derived from this trace yet.
          </p>
        )}
      </div>
    </section>
  );
}

function StatusIcon({ status }) {
  if (status === 'passed') return <CheckCircle2 size={14} aria-label="passed" />;
  if (status === 'failed') return <XCircle size={14} aria-label="failed" />;
  return <Ban size={14} aria-label={status || 'blocked'} />;
}

function formatCheckrideKind(kind) {
  return String(kind || 'checkride').replaceAll('_', ' ');
}

function OperationalControlPanel({ trace, proof, blocked, approvedDose, reviewRequests = [], remediationVerification = null }) {
  const uncertainty = trace.uncertainties?.[0] || null;
  const requestedAccess = proof?.requestedAccess?.id ? proof.requestedAccess : blocked?.requestedAccess || null;
  const selectedProbe = [...(trace.projectionProbes || [])].reverse().find((probe) => probe.status === 'completed') || trace.projectionProbes?.[0] || null;
  const proofTier = proofRouteTier(requestedAccess);
  const pendingReview = reviewRequests.find((review) => review.status === 'pending');
  const reviewRequired = Boolean(pendingReview);
  const lowerRiskProbes = trace.suggestedLowerRiskAlternatives?.length
    ? trace.suggestedLowerRiskAlternatives
    : uncertainty?.usefulProbes || [];

  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="tomography-operational-controls">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold" style={{ margin: 0 }}>Operational Control Surface</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)', marginBottom: 0 }}>Brokered authority, proof routing, and revocation state</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{proofTier}</span>
      </div>
      <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))' }}>
        <InfoCard label="Live authority dose" value={`Dose ${trace.currentAuthorityDose}`} detail={approvedDose?.scope || 'Task description only'} />
        <InfoCard label="Uncertainty" value={uncertainty?.blockingStatus || 'open'} detail={uncertainty?.description || 'No uncertainty recorded'} />
        <InfoCard label="Requested access" value={requestedAccess?.scope || 'None'} detail={(requestedAccess?.dataClasses || []).join(', ') || 'No protected data requested'} />
        <InfoCard label="Selected probe" value={selectedProbe?.name || 'None'} detail={selectedProbe ? probeResultText(selectedProbe) : 'No probe has run'} />
        <InfoCard label="Claim categories" value={`${proof?.machineClaims?.length || pendingReview?.deterministicClaimResults?.length || 0}/${proof?.humanClaims?.length || pendingReview?.judgmentClaims?.length || 0}/${proof?.narrativeClaims?.length || pendingReview?.narrativeClaims?.length || 0}`} detail="machine / human / narrative" />
        <InfoCard label="Revocation status" value={approvedDose?.expirationCondition || requestedAccess?.expiration || 'Not granted'} detail={approvedDose?.revokePlan || (requestedAccess?.revocable ? 'revocable request' : 'no active grant')} />
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,320px)]">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold" style={{ margin: 0, color: 'var(--text-muted)' }}>Available lower-risk probes</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {lowerRiskProbes.length ? lowerRiskProbes.map((probe) => (
              <span key={probe} className="inline-flex min-h-8 items-center rounded-md border px-3 text-xs" style={panelStyle}>{probe}</span>
            )) : (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>No lower-risk probe recorded</span>
            )}
          </div>
          <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
            Avoided access: {(trace.avoidedAccess || []).join(', ') || 'none recorded'}
          </p>
        </div>
        <div className="rounded-md border p-3" style={panelStyle}>
          <h3 className="text-xs font-semibold" style={{ margin: 0, color: 'var(--text-muted)' }}>Review actions</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={!reviewRequired} className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <UserCheck size={13} aria-hidden="true" />
              Approve
            </button>
            <button type="button" disabled={!reviewRequired} className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <XCircle size={13} aria-hidden="true" />
              Deny
            </button>
          </div>
          <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
            {reviewRequired
              ? `Pending ${pendingReview.decisionMechanism || proofTier} review: ${pendingReview.reviewId || pendingReview.request?.id}`
              : 'No human review pending.'}
          </p>
        </div>
      </div>
      <div className="mt-4 rounded-md border p-3" style={panelStyle}>
        <h3 className="text-xs font-semibold" style={{ margin: 0, color: 'var(--text-muted)' }}>Remediation boundary</h3>
        <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
          {trace.remediationPlan || 'Diagnostic proof never authorizes mutation; write access requires a separate remediation proposal, rollback, postcondition checks, human approval, and revocation.'}
        </p>
        <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)', marginBottom: 0 }}>
          Postcondition status: {remediationVerification?.status || 'not verified'}
        </p>
        {remediationVerification?.postconditionResults?.length ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {remediationVerification.postconditionResults.map((result) => (
              <span key={`${result.check}-${result.status}`} className="inline-flex min-h-8 items-center rounded-md border px-3 text-xs" style={panelStyle}>
                {result.check}: {result.status}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function InfoCard({ label, value, detail }) {
  return (
    <article className="rounded-md border p-3" style={{ ...panelStyle, minWidth: 0 }}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 text-sm font-semibold" style={{ overflowWrap: 'anywhere' }}>{value}</div>
      <p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)', marginBottom: 0, overflowWrap: 'anywhere' }}>{detail}</p>
    </article>
  );
}

function proofRouteTier(access) {
  if (!access?.id && !access?.scope) return 'Tier 0';
  if (access.mode === 'write' || access.authorityDose >= 7) return 'Tier 3';
  if ((access.dataClasses || []).some((item) => ['raw_prod_logs', 'full_database', 'model_weights', 'customer_identifiers', 'admin_privileges'].includes(item))) return 'Tier 3';
  if ((access.tools || []).length > 1 || String(access.scope || '').includes(',')) return 'Tier 2';
  if (access.authorityDose <= 1) return 'Tier 0';
  return 'Tier 1';
}

function probeResultText(probe) {
  const entries = Object.entries(probe.resultSummary || {}).slice(0, 2);
  if (!entries.length) return `confidence ${Math.round((probe.confidence || 0) * 100)}%`;
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(', ');
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
