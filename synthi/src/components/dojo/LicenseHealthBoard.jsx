'use client';

import { ShieldAlert } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function LicenseHealthBoard({ items = [] }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="license-health-board">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert size={15} aria-hidden="true" />
          License Health
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{items.length} records</span>
      </div>
      {items.length ? (
        <div className="grid gap-2">
          {items.map((item) => (
            <article key={`${item.skillId}-${item.licenseId}`} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{item.skillName || item.skillId}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.licenseId || 'unlicensed'}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={{ ...panelStyle, color: statusColor(item.status) }}>
                  {item.status}
                </span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                <Info label="Entrustment" value={item.entrustmentLevel} />
                <Info label="SRL" value={String(item.readinessLevel ?? 0)} />
                <Info label="Expires" value={item.expiresAt ? String(item.expiresAt).slice(0, 10) : 'Not set'} />
                <Info label="Remaining" value={typeof item.daysUntilExpiry === 'number' ? `${item.daysUntilExpiry} days` : 'Not calculated'} />
                <Info label="Proof" value={item.proofRequired ? 'Required' : 'Optional'} />
                <Info label="Actions" value={`${item.allowedActionCount}/${item.gatedActionCount}/${item.blockedActionCount}`} />
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No license health records available.</p>
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

function statusColor(status) {
  if (status === 'expired' || status === 'revoked') return 'var(--accent-danger, #ef4444)';
  if (status === 'expiring') return 'var(--accent-warning, #f59e0b)';
  return 'var(--accent-success, #22c55e)';
}
