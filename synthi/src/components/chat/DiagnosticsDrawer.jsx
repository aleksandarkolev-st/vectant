'use client';

import { useState } from 'react';
import { Activity, ChevronDown, RotateCw } from 'lucide-react';
import ShadowCostPanel from './ShadowCostPanel';
import RegressionFindingsCard from './RegressionFindingsCard';

/**
 * DiagnosticsDrawer — consolidates the power-user panels that used to crowd
 * the top of the chat (Code Intel metrics, Shadow verify spend, Regression
 * findings) behind a single discreet, collapsible affordance. Default closed,
 * so the chat reads clean and a failing metrics fetch never leaks into the
 * empty state.
 */
export default function DiagnosticsDrawer({
  metrics,
  metricsError,
  isMetricsLoading,
  onRefresh,
  workspaceSlug,
  onPrefill,
}) {
  const [open, setOpen] = useState(false);

  // Health dot: red on error, amber while syncing, green otherwise.
  const dotColor = metricsError
    ? 'var(--accent-danger)'
    : isMetricsLoading
      ? 'var(--accent-warning)'
      : 'var(--accent-success)';

  return (
    <div className="mx-3 mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg transition-colors th-focus-ring"
        style={{ border: '1px solid var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-panel) 80%, transparent)' }}
        aria-expanded={open}
        title="Workspace diagnostics"
      >
        <Activity className="w-3 h-3" style={{ color: 'var(--text-muted)' }} strokeWidth={2} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: 'var(--text-muted)' }}>
          Diagnostics
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: dotColor, boxShadow: `0 0 6px color-mix(in srgb, ${dotColor} 50%, transparent)` }}
          title={metricsError ? 'Code Intel error' : isMetricsLoading ? 'Syncing' : 'Healthy'}
        />
        <ChevronDown
          className="w-3.5 h-3.5 ml-auto transition-transform duration-300"
          style={{ color: 'var(--text-dim)', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
          strokeWidth={2}
        />
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5">
          {/* ── Code Intel ── */}
          <div
            className="rounded-lg px-2.5 py-2 text-[10px]"
            style={{ border: '1px solid var(--border-subtle)', background: 'color-mix(in srgb, var(--bg-panel) 80%, transparent)', color: 'var(--text-secondary)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold uppercase tracking-[0.12em] text-[9px]" style={{ color: 'var(--text-muted)' }}>
                Code Intel
              </span>
              <button
                onClick={onRefresh}
                className="flex items-center gap-1 text-[9px] uppercase tracking-[0.12em] transition-colors"
                style={{ color: 'var(--text-dim)' }}
                title="Refresh metrics"
              >
                <RotateCw className="w-2.5 h-2.5" strokeWidth={2} /> Refresh
              </button>
            </div>
            {metricsError ? (
              <div className="mt-1 text-[10px]" style={{ color: 'color-mix(in srgb, var(--accent-danger) 80%, var(--text-secondary))' }}>
                Metrics unavailable{isMetricsLoading ? ' — retrying…' : ''}
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 text-[9px]">
                <span style={{ color: 'var(--text-muted)' }}>p95:</span>
                {Object.entries(metrics?.latency || {}).map(([stage, vals]) => (
                  <span key={stage} style={{ color: 'var(--text-secondary)' }}>{stage} {Math.round(vals?.p95 || 0)}ms</span>
                ))}
                <span style={{ color: 'var(--text-muted)' }}>counters:</span>
                {Object.entries(metrics?.counters || {}).map(([k, v]) => (
                  <span key={k} style={{ color: 'var(--text-secondary)' }}>{k}:{v}</span>
                ))}
                {metrics?.index_generation && (
                  <span style={{ color: 'var(--text-muted)' }}>gen:{metrics.index_generation}</span>
                )}
                {isMetricsLoading && <span style={{ color: 'var(--text-dim)' }}>syncing…</span>}
              </div>
            )}
          </div>

          {/* ── Shadow verify spend ── */}
          {workspaceSlug ? <ShadowCostPanel workspacePath={workspaceSlug} /> : null}

          {/* ── Continuous-shadow regression findings ── */}
          {workspaceSlug ? (
            <RegressionFindingsCard
              workspacePath={workspaceSlug}
              onLookAt={(finding) => {
                const prompt =
                  `Continuous shadow flagged a regression in \`${finding.file}\` ` +
                  `(${finding.test || 'tests now failing'}). ` +
                  `Investigate the change since the last accepted patch and propose a fix.`;
                onPrefill?.(prompt);
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
