'use client';

import { ShieldCheck } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function PolicyGateTable({ items = [] }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="policy-gate-table">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck size={15} aria-hidden="true" />
          Policy Gates
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{items.length} gates</span>
      </div>
      {items.length ? (
        <div className="grid gap-2">
          {items.map((item) => (
            <article key={item.gateId} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{item.name}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.gateId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{item.status}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                <Info label="Severity" value={item.severity || 'Not set'} />
                <Info label="Scope" value={item.scope || 'workspace'} />
                <Info label="Owner" value={item.owner || 'Not assigned'} />
                <Info label="Next step" value={item.nextStep || 'None'} />
              </dl>
              {item.blocks?.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.blocks.map((block) => (
                    <span key={`${item.gateId}-${block}`} className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{block}</span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No policy gates are currently reported.</p>
      )}
    </section>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="mt-1 truncate font-medium">{value || 'None'}</dd>
    </div>
  );
}
