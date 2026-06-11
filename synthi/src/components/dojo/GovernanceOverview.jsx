'use client';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function GovernanceOverview({ metrics = {} }) {
  const cards = [
    ['Skills', metrics.skillCount ?? 0],
    ['Active Licenses', metrics.activeLicenseCount ?? 0],
    ['Expired / Revoked', metrics.expiredLicenseCount ?? 0],
    ['Pending Approvals', metrics.pendingApprovalCount ?? 0],
    ['Case Reviews', metrics.caseLawReviewCount ?? 0],
  ];
  return (
    <section className="grid gap-3 md:grid-cols-5" data-testid="governance-overview">
      {cards.map(([label, value]) => (
        <div key={label} className="rounded-md border px-3 py-3" style={panelStyle}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
          <div className="mt-1 truncate text-xl font-semibold">{value}</div>
        </div>
      ))}
    </section>
  );
}
