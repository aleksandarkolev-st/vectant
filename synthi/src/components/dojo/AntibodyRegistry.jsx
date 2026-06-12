'use client';

import { GitPullRequestArrow } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function AntibodyRegistry({ antibodies = [] }) {
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="antibody-registry">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <GitPullRequestArrow size={15} aria-hidden="true" />
          Antibody Registry
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{antibodies.length} antibodies</span>
      </div>
      {antibodies.length ? (
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {antibodies.map((antibody) => (
            <article key={antibody.antibodyId} className="px-4 py-3 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{antibody.trigger || antibody.antibodyId}</h3>
                  <p className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{antibody.antibodyId}</p>
                </div>
                <span className="rounded-md border px-2 py-1" style={panelStyle}>{antibody.bindingScope || 'scope'}</span>
              </div>
              <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{antibody.response}</p>
              <dl className="mt-3 grid gap-2">
                <Info label="Case" value={antibody.caseId || 'Not recorded'} />
                <Info label="Guardrail" value={antibody.guardrailId || 'Not recorded'} />
                <Info label="Evidence" value={antibody.evidenceRefs.join(', ') || 'Not recorded'} />
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No antibodies are reported.</div>
      )}
    </section>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
