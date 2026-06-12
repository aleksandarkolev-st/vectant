'use client';

import { ShieldAlert } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function GuardrailProvenance({ guardrails = [] }) {
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="guardrail-provenance">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert size={15} aria-hidden="true" />
          Guardrail Provenance
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{guardrails.length} guardrails</span>
      </div>
      {guardrails.length ? (
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {guardrails.map((guardrail) => (
            <article key={guardrail.guardrailId} className="px-4 py-3 text-xs">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{guardrail.title}</h3>
                  <p className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{guardrail.guardrailId}</p>
                </div>
                <span className="rounded-md border px-2 py-1" style={panelStyle}>{guardrail.severity || 'severity'}</span>
              </div>
              <dl className="mt-3 grid gap-2">
                <Info label="Rule" value={guardrail.rule || 'Not recorded'} />
                <Info label="Case" value={guardrail.sourceCaseId || 'No case link'} />
                <Info label="Blocks" value={guardrail.blocksActions.join(', ') || 'Not recorded'} />
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No guardrail provenance is reported.</div>
      )}
    </section>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
