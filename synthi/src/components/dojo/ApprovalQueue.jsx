'use client';

import { ClipboardCheck } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function ApprovalQueue({ items = [] }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="approval-queue">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck size={15} aria-hidden="true" />
          Approval Queue
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{items.length} pending</span>
      </div>
      {items.length ? (
        <div className="grid gap-2">
          {items.map((item) => (
            <article key={item.queueId} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{item.action || 'Approval'}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.skillId || item.licenseId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{item.status || 'pending'}</span>
              </div>
              {item.reason ? <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{item.reason}</p> : null}
              {item.constraints?.length ? (
                <ul className="mt-3 grid gap-2 text-xs">
                  {item.constraints.map((constraint) => (
                    <li key={`${item.queueId}-${constraint}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
                      {constraint}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No approval work is currently queued.</p>
      )}
    </section>
  );
}
