'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  ArrowUpRight,
  BookOpenCheck,
  Braces,
  DatabaseZap,
  FileCheck2,
  GitBranch,
  History,
  ScanLine,
  Scale,
  ShieldCheck,
  Workflow,
} from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';

export default function DojoShell({
  workspaceSlug = '',
  initialSummary,
  loadSummary = getDojoWorkspaceSummary,
  autoLoad = true,
}) {
  const [summary, setSummary] = useState(initialSummary || createEmptyDojoSummary(workspaceSlug));
  const [loading, setLoading] = useState(autoLoad && !initialSummary);
  const [error, setError] = useState('');
  const [currentNavLabel, setCurrentNavLabel] = useState('Overview');
  const [previewNavLabel, setPreviewNavLabel] = useState('');
  const prefersReducedMotion = useReducedMotion();

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
  const coverage = selectedSkill ? Math.round(selectedSkill.coverageScore * 100) : 0;
  const baseHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const selectedSkillHref = selectedSkill?.skillId ? encodeURIComponent(selectedSkill.skillId) : '';
  const navItems = useMemo(() => [
    { label: 'Overview', href: baseHref, icon: Activity, detail: 'Registry health' },
    { label: 'Skills', href: `${baseHref}/skills`, icon: ShieldCheck, detail: `${metrics.skillCount || 0} licensed paths` },
    { label: 'Passport', href: selectedSkillHref ? `${baseHref}/skills/${selectedSkillHref}/passport` : baseHref, icon: FileCheck2, detail: selectedSkill ? 'Credential scope' : 'Select a skill' },
    { label: 'Cortex', href: selectedSkillHref ? `${baseHref}/skills/${selectedSkillHref}/cortex` : baseHref, icon: GitBranch, detail: selectedSkill ? 'Runtime graph' : 'No graph yet' },
    { label: 'Practice', href: `${baseHref}/practice`, icon: BookOpenCheck, detail: `${metrics.scenarioCount || 0} scenarios` },
    { label: 'Tomography', href: `${baseHref}/therapeutic-trace`, icon: ScanLine, detail: 'Authority trace' },
    { label: 'Source/API', href: `${baseHref}/source`, icon: Braces, detail: 'Affordance bridge' },
    { label: 'Debugger', href: `${baseHref}/debug/time-machine`, icon: History, detail: 'Replay variables' },
    { label: 'Evidence', href: `${baseHref}/evidence`, icon: DatabaseZap, detail: `${metrics.artifactCount || 0} artifacts` },
    { label: 'Case Law', href: `${baseHref}/case-law`, icon: Scale, detail: 'Binding outcomes' },
    { label: 'Governance', href: `${baseHref}/governance`, icon: Workflow, detail: `${metrics.guardrailCount || 0} guardrails` },
  ], [baseHref, metrics.artifactCount, metrics.guardrailCount, metrics.scenarioCount, metrics.skillCount, selectedSkill, selectedSkillHref]);
  const previewNavItem = navItems.find((item) => item.label === previewNavLabel)
    || navItems.find((item) => item.label === currentNavLabel)
    || navItems[0];

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const path = window.location.pathname;
    const match = [...navItems]
      .sort((a, b) => b.href.length - a.href.length)
      .find((item) => path === item.href || path.startsWith(`${item.href}/`));
    if (match) setCurrentNavLabel(match.label);
  }, [navItems]);

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
  const metricItems = [
    ['Skills', metrics.skillCount],
    ['Licensed', metrics.licensedCount],
    ['Guardrails', metrics.guardrailCount],
    ['Scenarios', metrics.scenarioCount],
    ['Artifacts', metrics.artifactCount],
  ];

  return (
    <motion.main
      className="dojo-page min-h-[100dvh] px-5 py-5 text-sm"
      style={{ color: 'var(--text-primary)' }}
      data-testid="dojo-shell"
      initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
      animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <section className="vt-command-surface overflow-hidden" aria-label="Dojo workspace registry">
          <header className="vt-panel-header min-h-[54px] flex-wrap justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-control)] border"
                style={{
                  borderColor: 'color-mix(in srgb, var(--border-medium) 78%, transparent)',
                  background: 'color-mix(in srgb, var(--bg-panel) 82%, transparent)',
                  color: 'var(--text-primary)',
                }}
                aria-hidden="true"
              >
                <Workflow size={16} />
              </div>
              <div className="min-w-0">
                <div className="vt-panel-kicker truncate">Workspace registry / {workspaceSlug || 'workspace'}</div>
                <h1 className="vt-panel-title mt-0.5 text-[15px]">Agent Dojo</h1>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="vt-state-pill">
                <span className="vt-state-dot" aria-hidden="true" />
                {loading ? 'Loading' : error ? 'Bridge unavailable' : summary.bridgeStatus}
              </span>
            </div>
          </header>

          {error ? (
            <section className="vt-workflow-alert mx-4 mt-4 p-3 text-xs" role="status">
              {error}
            </section>
          ) : null}

          <section
            className="grid border-b border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] text-xs sm:grid-cols-5"
            aria-label="Dojo metrics"
          >
            {metricItems.map(([label, value]) => (
              <Metric key={label} label={label} value={value} />
            ))}
          </section>

          <div className="grid min-h-[520px] lg:grid-cols-[224px_minmax(0,1fr)_336px]">
            <nav
              className="border-b border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] p-2 lg:border-b-0 lg:border-r"
              aria-label="Dojo sections"
            >
              <div className="px-2 pb-2 pt-1">
                <div className="vt-panel-kicker">Sections</div>
              </div>
              <div className="grid gap-1">
                <div
                  className="mb-2 rounded-[var(--radius-control)] border px-2.5 py-2"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--border-subtle) 72%, transparent)',
                    background: 'color-mix(in srgb, var(--bg-app) 46%, transparent)',
                  }}
                  data-testid="dojo-nav-preview"
                >
                  <div className="vt-panel-kicker">Focus</div>
                  <div className="mt-1 truncate text-xs font-semibold">{previewNavItem.label}</div>
                  <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {previewNavItem.detail}
                  </div>
                </div>
                {navItems.map(({ label, href, icon: Icon, detail }) => {
                  const active = currentNavLabel === label;
                  return (
                  <motion.a
                    key={label}
                    href={href}
                    className="vt-command-item th-focus-ring flex h-9 items-center gap-2 px-2.5 text-xs"
                    style={{
                      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                      background: active ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : undefined,
                      border: active ? '1px solid color-mix(in srgb, var(--accent-primary) 30%, var(--border-subtle))' : '1px solid transparent',
                    }}
                    aria-current={active ? 'page' : undefined}
                    title={detail}
                    onMouseEnter={() => setPreviewNavLabel(label)}
                    onMouseLeave={() => setPreviewNavLabel('')}
                    onFocus={() => setPreviewNavLabel(label)}
                    onBlur={() => setPreviewNavLabel('')}
                    whileHover={prefersReducedMotion ? undefined : { x: 2 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </motion.a>
                  );
                })}
              </div>
            </nav>

            <section className="min-w-0 p-4">
              {selectedSkill ? (
                <div className="flex h-full flex-col">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="vt-panel-kicker">Selected skill</div>
                      <h2 className="mt-1 truncate text-[22px] font-semibold leading-tight">{selectedSkill.title}</h2>
                      <p className="mt-1 truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {selectedSkill.skillId}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge icon={ShieldCheck} label={selectedSkill.entrustmentLevel} />
                      <Badge label={`SRL ${selectedSkill.readinessLevel}`} />
                      <Badge label={selectedSkill.licenseStatus} />
                    </div>
                  </div>

                  <CapabilityRegistryTable skill={selectedSkill} coverage={coverage} />

                  <div className="mt-4 grid gap-3 text-xs xl:grid-cols-[minmax(0,1fr)_280px]">
                    <section className="rounded-[var(--radius-control)] border border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)]">
                      <div className="flex items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)] px-3 py-2">
                        <div>
                          <div className="vt-panel-kicker">Audit sequence</div>
                          <h3 className="mt-0.5 font-semibold">Promotion controls</h3>
                        </div>
                        <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>3 gates</span>
                      </div>
                      <div className="grid divide-y divide-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)]">
                        <WorkflowStep label="Practice" value={`${selectedSkill.scenarioCount || 0} scenarios`} active />
                        <WorkflowStep label="Review" value={selectedSkill.proofRequired ? 'Proof Required' : 'Proof Optional'} active={selectedSkill.proofRequired} />
                        <WorkflowStep label="Publish" value={selectedSkill.publishedToolName || 'Pending MCP'} active={Boolean(selectedSkill.publishedToolName)} />
                      </div>
                    </section>
                    <section className="rounded-[var(--radius-control)] border border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] px-3 py-3">
                      <div className="vt-panel-kicker">Policy matrix</div>
                      <div className="mt-3 grid gap-2">
                        <MatrixRow label="Can run alone" value={selectedSkill.allowedActions?.length || 0} />
                        <MatrixRow label="Needs approval" value={selectedSkill.gatedActions?.length || 0} />
                        <MatrixRow label="Blocked" value={selectedSkill.blockedActions?.length || 0} tone="danger" />
                      </div>
                    </section>
                  </div>
                </div>
              ) : (
                <section className="vt-empty-state h-full text-left" data-testid="dojo-empty-state">
                  <div className="max-w-xl">
                    <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>No Dojo skill yet</h2>
                    <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
                      Teach and license a workflow from the Agent Workflow panel to populate this workspace registry.
                    </p>
                  </div>
                </section>
              )}
            </section>

            <aside
              className="border-t border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] p-4 lg:border-l lg:border-t-0"
              aria-label="License scope"
            >
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">License Scope</h2>
                <ShieldCheck size={15} aria-hidden="true" style={{ color: 'var(--accent-success)' }} />
              </div>
              {selectedSkill ? (
                <dl className="grid gap-0 overflow-hidden rounded-[var(--radius-control)] border border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] text-xs">
                  {scopeRows.map(([label, value]) => (
                    <div key={label} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-b border-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)] px-3 py-2 last:border-b-0">
                      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
                      <dd className="min-w-0 truncate text-right">{value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-xs leading-5" style={{ color: 'var(--text-muted)' }}>
                  License boundaries appear after a workflow is taught and normalized by the bridge.
                </p>
              )}
            </aside>
          </div>
        </section>
      </div>
    </motion.main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="border-r border-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)] px-4 py-3 last:border-r-0">
      <div className="vt-panel-kicker">{label}</div>
      <div className="mt-1 truncate font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}

function Badge({ label, icon: Icon }) {
  return (
    <span className="vt-state-pill h-7">
      {Icon ? <Icon size={14} aria-hidden="true" /> : null}
      {label}
    </span>
  );
}

function CapabilityRegistryTable({ skill, coverage }) {
  return (
    <section className="mt-6 overflow-hidden rounded-[var(--radius-control)] border border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)]" data-testid="dojo-capability-registry">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)] px-3 py-2">
        <div>
          <div className="vt-panel-kicker">Capability registry</div>
          <h3 className="mt-0.5 text-xs font-semibold">Licensed workflow inventory</h3>
        </div>
        <span className="rounded-md border px-2 py-1 font-mono text-[10px]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
          saved view / active
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[720px] w-full border-collapse text-left text-xs">
          <thead style={{ color: 'var(--text-muted)' }}>
            <tr className="border-b border-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)]">
              <th className="px-3 py-2 font-medium">Skill</th>
              <th className="px-3 py-2 font-medium">License</th>
              <th className="px-3 py-2 font-medium">SRL</th>
              <th className="px-3 py-2 font-medium">Coverage</th>
              <th className="px-3 py-2 font-medium">Proof</th>
              <th className="px-3 py-2 font-medium">MCP tool</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="max-w-[220px] px-3 py-3">
                <div className="truncate font-semibold">{skill.title}</div>
                <div className="mt-1 truncate font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{skill.skillId}</div>
              </td>
              <td className="px-3 py-3">{skill.licenseStatus || 'draft'}</td>
              <td className="px-3 py-3">SRL {skill.readinessLevel ?? 0}</td>
              <td className="px-3 py-3 font-mono">{coverage}%</td>
              <td className="px-3 py-3">{skill.proofRequired ? 'Required' : 'Optional'}</td>
              <td className="max-w-[200px] truncate px-3 py-3 font-mono text-[11px]">{skill.publishedToolName || 'Not published'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WorkflowStep({ label, value, active = false }) {
  return (
    <div
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2"
      style={{
        background: active ? 'color-mix(in srgb, var(--primary) 7%, transparent)' : 'transparent',
      }}
    >
      <div className="min-w-0">
        <div className="truncate font-semibold">{label}</div>
        <div className="mt-1 truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{value}</div>
      </div>
      <span
        className="h-2 w-2 rounded-full"
        style={{
          background: active ? 'var(--primary)' : 'var(--text-dim)',
        }}
        aria-hidden="true"
      />
    </div>
  );
}

function MatrixRow({ label, value, tone = 'neutral' }) {
  const color = tone === 'danger' ? 'var(--accent-danger)' : value > 0 ? 'var(--primary)' : 'var(--text-dim)';
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-2.5 py-2" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 72%, transparent)' }}>
      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span className="font-mono font-semibold" style={{ color }}>{value}</span>
    </div>
  );
}
