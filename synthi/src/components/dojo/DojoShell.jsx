'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, ExternalLink, ShieldCheck, Workflow } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function DojoShell({
  workspaceSlug = '',
  initialSummary,
  loadSummary = getDojoWorkspaceSummary,
  autoLoad = true,
}) {
  const [summary, setSummary] = useState(initialSummary || createEmptyDojoSummary(workspaceSlug));
  const [loading, setLoading] = useState(autoLoad && !initialSummary);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!autoLoad) return undefined;
    const controller = new AbortController();
    setLoading(true);
    loadSummary({ workspaceSlug, signal: controller.signal })
      .then((next) => {
        setSummary(next);
        setError('');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err?.message || 'dojo_summary_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const selectedSkill = summary.selectedSkill;
  const metrics = summary.metrics || createEmptyDojoSummary(workspaceSlug).metrics;
  const baseHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const selectedSkillHref = selectedSkill?.skillId ? encodeURIComponent(selectedSkill.skillId) : '';
  const navItems = [
    ['Overview', baseHref],
    ['Skills', `${baseHref}/skills`],
    ['Passport', selectedSkillHref ? `${baseHref}/skills/${selectedSkillHref}/passport` : baseHref],
    ['Cortex', selectedSkillHref ? `${baseHref}/skills/${selectedSkillHref}/cortex` : baseHref],
    ['Practice', `${baseHref}/practice`],
    ['Source/API', `${baseHref}/source`],
    ['Debugger', `${baseHref}/debug/time-machine`],
    ['Evidence', `${baseHref}/evidence`],
    ['Case Law', `${baseHref}/case-law`],
    ['Governance', `${baseHref}/governance`],
  ];
  const scopeRows = useMemo(() => {
    if (!selectedSkill) return [];
    return [
      ['Can', selectedSkill.allowedActions?.slice(0, 5).join(', ') || 'Practice only'],
      ['Ask', selectedSkill.gatedActions?.slice(0, 5).join(', ') || 'None'],
      ['Block', selectedSkill.blockedActions?.slice(0, 5).join(', ') || 'None'],
      ['Proof', selectedSkill.proofRequired ? 'Required' : 'Optional'],
      ['MCP', selectedSkill.publishedToolName || 'Not published'],
    ];
  }, [selectedSkill]);

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="dojo-shell"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <Workflow size={14} aria-hidden="true" />
              <span className="truncate">{workspaceSlug || 'workspace'}</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-normal">Agent Dojo</h1>
            <p className="mt-1 max-w-2xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              Skill registry, proof state, practice evidence, and governance entry point.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <Activity size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Bridge unavailable' : summary.bridgeStatus}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        <section className="grid gap-3 md:grid-cols-5" aria-label="Dojo metrics">
          <Metric label="Skills" value={metrics.skillCount} />
          <Metric label="Licensed" value={metrics.licensedCount} />
          <Metric label="Guardrails" value={metrics.guardrailCount} />
          <Metric label="Scenarios" value={metrics.scenarioCount} />
          <Metric label="Artifacts" value={metrics.artifactCount} />
        </section>

        {selectedSkill ? (
          <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="rounded-md border p-4" style={panelStyle}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{selectedSkill.title}</h2>
                  <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {selectedSkill.skillId}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Badge icon={ShieldCheck} label={selectedSkill.entrustmentLevel} />
                  <Badge label={`SRL ${selectedSkill.readinessLevel}`} />
                </div>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Metric label="Coverage" value={`${Math.round(selectedSkill.coverageScore * 100)}%`} compact />
                <Metric label="License" value={selectedSkill.licenseStatus} compact />
                <Metric label="Proof" value={selectedSkill.proofRequired ? 'Required' : 'Optional'} compact />
              </div>
            </div>

            <aside className="rounded-md border p-4" style={panelStyle} aria-label="License scope">
              <h2 className="mb-3 text-sm font-semibold">License Scope</h2>
              <dl className="grid gap-2 text-xs">
                {scopeRows.map(([label, value]) => (
                  <div key={label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
                    <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
                    <dd className="min-w-0 truncate text-right">{value}</dd>
                  </div>
                ))}
              </dl>
            </aside>
          </section>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="dojo-empty-state">
            <h2 className="text-base font-semibold">No Dojo skill yet</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              Teach and license a workflow from the Agent Workflow panel to populate this workspace registry.
            </p>
          </section>
        )}

        <nav className="flex flex-wrap gap-2 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }} aria-label="Dojo sections">
          {navItems.map(([label, href]) => (
            <a
              key={label}
              href={href}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs"
              style={panelStyle}
            >
              {label}
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          ))}
        </nav>
      </div>
    </main>
  );
}

function Metric({ label, value, compact = false }) {
  return (
    <div className="rounded-md border px-3 py-3" style={panelStyle}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className={compact ? 'mt-1 truncate text-sm font-semibold' : 'mt-1 truncate text-xl font-semibold'}>{value}</div>
    </div>
  );
}

function Badge({ label, icon: Icon }) {
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
      {Icon ? <Icon size={14} aria-hidden="true" /> : null}
      {label}
    </span>
  );
}
