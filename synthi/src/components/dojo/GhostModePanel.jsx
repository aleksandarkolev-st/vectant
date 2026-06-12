'use client';

import { EyeOff, ShieldAlert } from 'lucide-react';
import HumanVsAgentActionDiff from './HumanVsAgentActionDiff';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function GhostModePanel({ ghostRun }) {
  if (!ghostRun) {
    return (
      <section className="rounded-md border p-4" style={panelStyle} data-testid="ghost-mode-empty">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <EyeOff size={15} aria-hidden="true" />
          Ghost Mode
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>No shadow comparison is recorded for this skill.</p>
      </section>
    );
  }

  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="ghost-mode-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <EyeOff size={15} aria-hidden="true" />
            Ghost Mode
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{ghostRun.runId || 'shadow run'}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{ghostRun.status}</span>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <Metric label="Would Execute" value={ghostRun.wouldExecute ? 'Yes' : 'No'} />
        <Metric label="License" value={ghostRun.licenseStatus || 'Unknown'} />
        <Metric label="Guardrails" value={ghostRun.guardrailsTriggered.length} />
      </div>

      {ghostRun.explanation ? (
        <p className="mt-4 rounded-md border p-3 text-sm leading-6" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
          {ghostRun.explanation}
        </p>
      ) : null}

      <div className="mt-4">
        <HumanVsAgentActionDiff
          observedLabel={ghostRun.observedLabel}
          plannedLabel={ghostRun.plannedLabel}
          observedAction={ghostRun.observedAction}
          plannedAction={ghostRun.plannedAction}
        />
      </div>

      {ghostRun.guardrailsTriggered.length ? (
        <section className="mt-4">
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold">
            <ShieldAlert size={13} aria-hidden="true" />
            Guardrails Triggered
          </h3>
          <ul className="grid gap-2 text-xs">
            {ghostRun.guardrailsTriggered.map((guardrail) => (
              <li key={guardrail} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>{guardrail}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-md border px-3 py-3" style={panelStyle}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}
