'use client';

import { ScrollText } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function CaseLawRegistry({ records = [] }) {
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="case-law-registry">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ScrollText size={15} aria-hidden="true" />
          Case-Law Registry
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{records.length} cases</span>
      </div>
      {records.length ? (
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {records.map((record) => (
            <article key={record.caseId} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{record.title}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{record.caseId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{record.status}</span>
              </div>
              <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{record.finding || record.ruleCreated}</p>
              <dl className="mt-3 grid gap-2 text-xs md:grid-cols-2">
                <Info label="Impact" value={record.impact || 'Not recorded'} />
                <Info label="Rule" value={record.ruleCreated || 'Not recorded'} />
                <Info label="Scope" value={record.bindingScope || 'Not recorded'} />
                <Info label="Evidence" value={record.evidenceRefs.join(', ') || 'Not recorded'} />
              </dl>
              {record.appliesTo.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {record.appliesTo.map((target) => (
                    <span key={`${record.caseId}-${target}`} className="rounded-md border px-2 py-1 text-[11px]" style={panelStyle}>{target}</span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No case-law records are reported.</div>
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
