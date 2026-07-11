'use client';

const panelStyle = {
  borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)',
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-panel) 88%, var(--text-primary) 3%), color-mix(in srgb, var(--bg-app) 54%, transparent))',
  borderRadius: 'var(--radius-panel)',
  boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-primary) 4%, transparent)',
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
