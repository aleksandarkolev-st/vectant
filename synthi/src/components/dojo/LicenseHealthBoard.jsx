'use client';

import { useState } from 'react';
import { ShieldAlert, ShieldOff } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function LicenseHealthBoard({ items = [], onRevoke, busyLicenseId = '' }) {
  const [revocationReasons, setRevocationReasons] = useState({});

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
          {items.map((item) => {
            const licenseKey = item.licenseId || item.skillId;
            const revocationReason = revocationReasons[licenseKey] || '';
            const canRevoke = Boolean(onRevoke)
              && busyLicenseId !== item.licenseId
              && item.status !== 'revoked'
              && revocationReason.trim().length > 0;
            return (
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
              <label className="mt-3 block text-xs" style={{ color: 'var(--text-muted)' }}>
                Reason
                <input
                  type="text"
                  className="mt-1 h-8 w-full rounded-md border px-2 text-xs outline-none"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-app)', color: 'var(--text-primary)' }}
                  value={revocationReason}
                  onChange={(event) => setRevocationReasons((current) => ({
                    ...current,
                    [licenseKey]: event.target.value,
                  }))}
                  placeholder="Required for audit"
                  data-testid={`license-${item.licenseId}-revoke-reason`}
                  disabled={!onRevoke || item.status === 'revoked'}
                />
              </label>
              <div className="mt-3">
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs disabled:cursor-not-allowed disabled:opacity-45"
                  style={panelStyle}
                  disabled={!canRevoke}
                  data-testid={`license-${item.licenseId}-revoke`}
                  onClick={() => onRevoke?.({ ...item, revocationReason: revocationReason.trim() })}
                  title={!onRevoke ? 'Action handler unavailable' : 'Revoke license'}
                >
                  <ShieldOff size={13} aria-hidden="true" />
                  Revoke license
                </button>
              </div>
            </article>
            );
          })}
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
