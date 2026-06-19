'use client';

import { ScrollText } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function SkillRegistryTable({ items = [] }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="skill-registry-table">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ScrollText size={15} aria-hidden="true" />
          Skill Registry
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{items.length} skills</span>
      </div>
      {items.length ? (
        <div className="grid gap-2">
          {items.map((item) => (
            <article key={item.skillId || item.title} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{item.title || item.skillId}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.skillId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{item.status}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                <Info label="License" value={item.licenseStatus || 'draft'} />
                <Info label="Entrustment" value={item.entrustmentLevel} />
                <Info label="SRL" value={String(item.readinessLevel ?? 0)} />
                <Info label="Owner" value={item.owner || 'Not assigned'} />
                <Info label="Tool" value={item.publishedToolName || 'Not published'} />
                <Info label="Updated" value={item.updatedAt ? String(item.updatedAt).slice(0, 10) : 'Not recorded'} />
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No skills are registered for this workspace.</p>
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
