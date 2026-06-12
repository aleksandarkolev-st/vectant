'use client';

import { TimerReset } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function RecertificationQueue({ items = [] }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="recertification-queue">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <TimerReset size={15} aria-hidden="true" />
          Recertification Queue
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{items.length} queued</span>
      </div>
      {items.length ? (
        <div className="grid gap-2">
          {items.map((item) => (
            <article key={item.queueId} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{item.skillName || item.skillId}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.reason || item.queueId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{item.status}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                <Info label="Due" value={item.dueAt ? String(item.dueAt).slice(0, 10) : 'Not scheduled'} />
                <Info label="Priority" value={item.priority || 'normal'} />
                <Info label="Evidence" value={item.evidenceRefs?.join(', ') || 'Not recorded'} />
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No recertification work is currently queued.</p>
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
