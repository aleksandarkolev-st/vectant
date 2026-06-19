'use client';

import { Braces } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function ApiCandidateReview({ candidates = [] }) {
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="api-candidate-review">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Braces size={15} aria-hidden="true" />
          API Candidate Review
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{candidates.length} candidates</span>
      </div>
      {candidates.length ? (
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {candidates.map((candidate) => (
            <article key={candidate.candidateId} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{candidate.method} {candidate.path}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{candidate.candidateId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{candidate.reviewStatus}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <Info label="Mutation" value={candidate.mutationClass || 'unknown'} />
                <Info label="Auth" value={candidate.authScope || 'Not reviewed'} />
                <Info label="Idempotency" value={candidate.idempotencyKeyLocation || 'Missing'} />
                <Info label="Rollback" value={candidate.rollbackStrategy || 'Missing'} />
              </dl>
              {candidate.postcondition ? <p className="mt-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{candidate.postcondition}</p> : null}
              {candidate.issues.length ? (
                <ul className="mt-3 grid gap-2 text-xs">
                  {candidate.issues.map((issue) => (
                    <li key={`${candidate.candidateId}-${issue.issueId}-${issue.message}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', color: issue.severity === 'error' ? 'var(--accent-warning)' : 'var(--text-secondary)' }}>
                      {issue.issueId || issue.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No API candidates are reported.</div>
      )}
    </section>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
