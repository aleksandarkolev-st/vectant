'use client';

const panelStyle = {
  borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)',
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-panel) 88%, var(--text-primary) 3%), color-mix(in srgb, var(--bg-app) 54%, transparent))',
  borderRadius: 'var(--radius-panel)',
  boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-primary) 4%, transparent)',
};

export default function CheckrideReportView({ branchTraces = [] }) {
  const traces = Array.isArray(branchTraces) ? branchTraces : [];
  return (
    <section className="min-w-0 rounded-md border" style={panelStyle} data-testid="dojo-checkride-regret-report">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }}>
        <div>
          <h2 className="text-sm font-semibold">Checkride Branch Comparison</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            Selected, blocked, failed, and near-miss branches with evidence references.
          </p>
        </div>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{traces.length} branches</span>
      </div>
      {traces.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full table-fixed text-left text-xs">
            <thead style={{ color: 'var(--text-muted)' }}>
              <tr className="border-b" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }}>
                <th className="w-44 px-4 py-3 font-medium">Branch</th>
                <th className="w-32 px-4 py-3 font-medium">Outcome</th>
                <th className="w-36 px-4 py-3 font-medium">Exposure</th>
                <th className="px-4 py-3 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((trace) => (
                <tr key={trace.branchId} className="border-b last:border-b-0" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }}>
                  <td className="px-4 py-3">
                    <div className="truncate font-medium">{trace.branchKind || trace.branchId}</div>
                    <div className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{trace.branchId}</div>
                  </td>
                  <td className="px-4 py-3"><OutcomeBadge status={trace.status} /></td>
                  <td className="truncate px-4 py-3">{trace.counterfactualStrength || trace.exposureLevel || 'not compared'}</td>
                  <td className="px-4 py-3">
                    <div className="truncate">{trace.evidenceRefs?.slice(0, 2).join(', ') || trace.summary || 'No evidence refs'}</div>
                    {trace.ambiguityFlags?.length ? (
                      <div className="mt-1 truncate" style={{ color: 'var(--accent-warning)' }}>
                        {trace.ambiguityFlags.join(', ')}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="p-4 text-sm" style={{ color: 'var(--text-muted)' }}>
          No counterfactual branch comparisons have been recorded.
        </p>
      )}
    </section>
  );
}

function OutcomeBadge({ status }) {
  const normalized = String(status || 'unknown').toLowerCase();
  const color = normalized === 'passed' || normalized === 'selected'
    ? 'var(--accent-success)'
    : normalized === 'failed'
      ? 'var(--accent-danger)'
      : normalized === 'blocked'
        ? 'var(--accent-warning)'
        : 'var(--text-muted)';
  return (
    <span className="inline-flex h-7 items-center rounded-md border px-2 text-[11px]" style={{ ...panelStyle, color }}>
      {normalized}
    </span>
  );
}
