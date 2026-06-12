'use client';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function HumanVsAgentActionDiff({ observedLabel = '', plannedLabel = '', observedAction = {}, plannedAction = {} }) {
  const matches = observedLabel && plannedLabel && observedLabel === plannedLabel;
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="human-agent-action-diff">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Human vs Agent Action</h3>
        <span className="rounded-md border px-2 py-1 text-xs" style={{ ...panelStyle, color: matches ? 'var(--accent-success)' : 'var(--accent-warning)' }}>
          {matches ? 'matched' : 'mismatch'}
        </span>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <ActionBlock title="Human" label={observedLabel || 'Not recorded'} action={observedAction} />
        <ActionBlock title="Agent" label={plannedLabel || 'Not recorded'} action={plannedAction} />
      </div>
    </section>
  );
}

function ActionBlock({ title, label, action }) {
  return (
    <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{title}</div>
      <div className="mt-1 truncate text-sm font-semibold">{label}</div>
      <dl className="mt-3 grid gap-2 text-xs">
        <Info label="Kind" value={action?.kind || action?.action || 'Not recorded'} />
        <Info label="Target" value={action?.selector || action?.target || action?.name || 'Not recorded'} />
      </dl>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
