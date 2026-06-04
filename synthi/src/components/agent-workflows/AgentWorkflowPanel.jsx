'use client';

import { memo, useMemo, useState } from 'react';
import {
  CheckCircle2,
  CircleDot,
  ClipboardList,
  Eye,
  FileCode2,
  Play,
  ShieldAlert,
  Square,
  Workflow,
} from 'lucide-react';

const FIXTURE_STEPS = [
  {
    id: 'open-preview',
    label: 'Open workspace preview',
    meta: 'Hosted browser session',
    state: 'recorded',
  },
  {
    id: 'fill-token',
    label: 'Fill Test token',
    meta: 'Parameter candidate',
    state: 'parameter',
  },
  {
    id: 'save-state',
    label: 'Click Save workspace state',
    meta: 'Mutation boundary',
    state: 'limited',
  },
  {
    id: 'assert-saved',
    label: 'Assert Saved appears',
    meta: 'Success signal',
    state: 'verified',
  },
];

const STATE_ROWS = [
  { label: 'Draft', value: '4 steps understood', state: 'ok' },
  { label: 'Runnable', value: 'Same-session candidate', state: 'ok' },
  { label: 'Auth', value: 'None required', state: 'ok' },
  { label: 'Source', value: 'Awaiting build tokens', state: 'warn' },
  { label: 'Hardened', value: 'CI environment not set', state: 'warn' },
];

const STATUS_STYLES = {
  ok: {
    color: 'var(--success-foreground, var(--text-primary))',
    background: 'color-mix(in srgb, var(--success, #238636) 14%, transparent)',
    borderColor: 'color-mix(in srgb, var(--success, #238636) 34%, var(--border-subtle))',
  },
  warn: {
    color: 'var(--warning-foreground, var(--text-primary))',
    background: 'color-mix(in srgb, var(--warning, #b7791f) 13%, transparent)',
    borderColor: 'color-mix(in srgb, var(--warning, #b7791f) 34%, var(--border-subtle))',
  },
};

function StepStateIcon({ state }) {
  if (state === 'verified') return <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />;
  if (state === 'limited') return <ShieldAlert className="h-3.5 w-3.5" strokeWidth={2} />;
  return <CircleDot className="h-3.5 w-3.5" strokeWidth={2} />;
}

function StateBadge({ row }) {
  const style = STATUS_STYLES[row.state] || STATUS_STYLES.ok;
  return (
    <div
      className="flex min-h-10 items-center justify-between gap-3 rounded-md border px-3 py-2"
      style={style}
    >
      <span className="text-[11px] font-semibold uppercase tracking-normal">{row.label}</span>
      <span className="min-w-0 truncate text-right text-[11px] font-medium">{row.value}</span>
    </div>
  );
}

export const AgentWorkflowPanel = memo(function AgentWorkflowPanel({ workspaceSlug }) {
  const [isRecording, setRecording] = useState(false);

  const headerState = useMemo(() => {
    if (isRecording) {
      return {
        label: 'Recording',
        detail: 'Streaming inference',
        icon: Square,
        tone: 'warn',
      };
    }
    return {
      label: 'Runnable draft',
      detail: 'Not hardened yet',
      icon: CheckCircle2,
      tone: 'ok',
    };
  }, [isRecording]);

  const HeaderIcon = headerState.icon;
  const headerStyle = STATUS_STYLES[headerState.tone];

  return (
    <section
      data-testid="agent-workflow-panel"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
      style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}
    >
      <header className="border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Workflow className="h-4 w-4 shrink-0" strokeWidth={2} style={{ color: 'var(--accent-tertiary)' }} />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">Workflows</h2>
              <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {workspaceSlug || 'Current workspace'}
              </p>
            </div>
          </div>
          <div
            className="flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold"
            style={headerStyle}
          >
            <HeaderIcon className="h-3.5 w-3.5" strokeWidth={2} />
            {headerState.label}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="grid gap-2">
          {STATE_ROWS.map((row) => (
            <StateBadge key={row.label} row={row} />
          ))}
        </div>

        <div className="mt-4 rounded-md border" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="min-w-0">
              <h3 className="truncate text-xs font-semibold">Save workspace state</h3>
              <p className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{headerState.detail}</p>
            </div>
            <ClipboardList className="h-4 w-4 shrink-0" strokeWidth={2} style={{ color: 'var(--text-muted)' }} />
          </div>

          <ol className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {FIXTURE_STEPS.map((step, index) => (
              <li
                key={step.id}
                className="flex min-h-12 items-center gap-3 px-3 py-2"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-semibold"
                  style={{ background: 'var(--bg-panel)', color: 'var(--text-muted)' }}
                >
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium">{step.label}</div>
                  <div className="truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{step.meta}</div>
                </div>
                <span
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                  style={{ color: step.state === 'limited' ? 'var(--warning, #b7791f)' : 'var(--accent-tertiary)' }}
                  aria-label={step.state}
                >
                  <StepStateIcon state={step.state} />
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <footer className="grid gap-2 border-t p-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-xs font-semibold transition hover:opacity-90 focus:outline-none focus:ring-2"
          style={{ background: 'var(--accent-primary)', color: 'var(--accent-foreground, var(--bg-app))' }}
          onClick={() => setRecording((value) => !value)}
        >
          {isRecording ? <Square className="h-3.5 w-3.5" strokeWidth={2} /> : <Eye className="h-3.5 w-3.5" strokeWidth={2} />}
          {isRecording ? 'Stop teaching' : 'Teach workflow'}
        </button>
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition hover:opacity-90"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)', color: 'var(--text-primary)' }}
          >
            <Play className="h-3.5 w-3.5" strokeWidth={2} />
            Validate
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition hover:opacity-90"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)', color: 'var(--text-primary)' }}
          >
            <FileCode2 className="h-3.5 w-3.5" strokeWidth={2} />
            Export
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-2 text-[11px] font-medium opacity-60"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)', color: 'var(--text-muted)' }}
            disabled
          >
            <Workflow className="h-3.5 w-3.5" strokeWidth={2} />
            Publish
          </button>
        </div>
      </footer>
    </section>
  );
});

export default AgentWorkflowPanel;
