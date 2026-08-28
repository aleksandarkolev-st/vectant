'use client';

import { FileArchive } from 'lucide-react';

const panelStyle = {
  borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)',
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-panel) 88%, var(--text-primary) 3%), color-mix(in srgb, var(--bg-app) 54%, transparent))',
  borderRadius: 'var(--radius-panel)',
  boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-primary) 4%, transparent)',
};

export default function AuditExportPanel({ items = [] }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="audit-export-panel">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <FileArchive size={15} aria-hidden="true" />
          Audit Exports
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{items.length} exports</span>
      </div>
      {items.length ? (
        <div className="grid gap-2">
          {items.map((item) => (
            <article key={item.exportId} className="rounded-md border p-3" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{item.title}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.exportId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{item.status}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                <Info label="Format" value={item.format || 'metadata'} />
                <Info label="Records" value={String(item.recordCount ?? 0)} />
                <Info label="Generated" value={item.generatedAt ? String(item.generatedAt).slice(0, 10) : 'Not recorded'} />
              </dl>
              {item.digest ? <p className="mt-3 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.digest}</p> : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No audit exports are available.</p>
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
