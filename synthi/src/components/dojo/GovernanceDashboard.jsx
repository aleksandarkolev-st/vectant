'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Landmark } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import ApprovalQueue from './ApprovalQueue';
import GovernanceOverview from './GovernanceOverview';
import LicenseHealthBoard from './LicenseHealthBoard';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function GovernanceDashboard({
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
        setError(err?.message || 'dojo_governance_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const governance = summary.governance || createEmptyDojoSummary(workspaceSlug).governance;
  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="governance-dashboard"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Governance</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <Landmark size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : `${governance.metrics.pendingApprovalCount} approvals`}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        <GovernanceOverview metrics={governance.metrics} />

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
          <LicenseHealthBoard items={governance.licenseHealth} />
          <ApprovalQueue items={governance.approvalQueue} />
        </section>

        <section className="rounded-md border p-4" style={panelStyle} data-testid="case-law-review-queue">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Case-Law Review</h2>
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{governance.caseLawReviewQueue.length} proposed</span>
          </div>
          {governance.caseLawReviewQueue.length ? (
            <div className="grid gap-2">
              {governance.caseLawReviewQueue.map((item) => (
                <article key={item.caseId || item.title} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold">{item.title || item.caseId}</h3>
                      <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.caseId}</p>
                    </div>
                    <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{item.status}</span>
                  </div>
                  <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{item.finding || item.ruleCreated}</p>
                </article>
              ))}
            </div>
          ) : (
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No proposed case law requires review.</p>
          )}
        </section>
      </div>
    </main>
  );
}
