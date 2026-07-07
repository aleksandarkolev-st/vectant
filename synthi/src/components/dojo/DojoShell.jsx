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
  const navItems = [
    ['Overview', baseHref, Activity],
    ['Skills', `${baseHref}/skills`, ShieldCheck],
    ['Passport', selectedSkillHref ? `${baseHref}/skills/${selectedSkillHref}/passport` : baseHref, FileCheck2],
    ['Cortex', selectedSkillHref ? `${baseHref}/skills/${selectedSkillHref}/cortex` : baseHref, GitBranch],
    ['Practice', `${baseHref}/practice`, BookOpenCheck],
    ['Source/API', `${baseHref}/source`, Braces],
    ['Debugger', `${baseHref}/debug/time-machine`, History],
    ['Evidence', `${baseHref}/evidence`, DatabaseZap],
    ['Case Law', `${baseHref}/case-law`, Scale],
    ['Governance', `${baseHref}/governance`, Workflow],
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
                  borderColor: 'color-mix(in srgb, var(--attention-purple) 28%, transparent)',
                  background: 'linear-gradient(135deg, color-mix(in srgb, var(--attention-purple) 18%, transparent), color-mix(in srgb, var(--bg-app) 68%, transparent))',
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
                {navItems.map(([label, href, Icon], index) => (
                  <motion.a
                    key={label}
                    href={href}
                    className={`vt-command-item th-focus-ring flex h-9 items-center gap-2 px-2.5 text-xs ${index === 0 ? 'text-[var(--text-primary)]' : ''}`}
                    whileHover={prefersReducedMotion ? undefined : { x: 2 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <ArrowUpRight size={12} aria-hidden="true" />
                  </motion.a>
                ))}
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

                  <div className="mt-6 border-y border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] py-4">
                    <div className="mb-2 flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Coverage</span>
                      <span className="font-mono font-semibold">{coverage}%</span>
                    </div>
                    <div
                      className="h-2 overflow-hidden rounded-full"
                      style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}
                      aria-label={`Coverage ${coverage}%`}
                    >
                      <motion.div
                        className="h-full rounded-full"
                        style={{
                          background: 'linear-gradient(90deg, var(--attention-purple), var(--accent-secondary))',
                          boxShadow: '0 0 18px color-mix(in srgb, var(--attention-purple) 36%, transparent)',
                        }}
                        initial={prefersReducedMotion ? false : { width: 0 }}
                        animate={{ width: `${coverage}%` }}
                        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>
                  </div>

                  <div className="grid flex-1 gap-0 border-b border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] md:grid-cols-3">
                    <DetailCell label="Coverage" value={`${coverage}%`} />
                    <DetailCell label="Proof" value={selectedSkill.proofRequired ? 'Required' : 'Optional'} />
                    <DetailCell label="MCP tool" value={selectedSkill.publishedToolName || 'Not published'} />
                  </div>

                  <div className="mt-4 grid gap-2 text-xs">
                    <div className="vt-panel-kicker">Promotion path</div>
                    <div className="grid gap-2 md:grid-cols-3">
                      <WorkflowStep label="Practice" value={`${selectedSkill.scenarioCount || 0} scenarios`} active />
                      <WorkflowStep label="Review" value={selectedSkill.proofRequired ? 'Proof Required' : 'Proof Optional'} active={selectedSkill.proofRequired} />
                      <WorkflowStep label="Publish" value={selectedSkill.publishedToolName || 'Pending MCP'} active={Boolean(selectedSkill.publishedToolName)} />
                    </div>
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

function DetailCell({ label, value }) {
  return (
    <div className="min-w-0 border-r border-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)] px-3 py-4 last:border-r-0">
      <div className="vt-panel-kicker">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function WorkflowStep({ label, value, active = false }) {
  return (
    <div
      className="min-w-0 rounded-[var(--radius-control)] border px-3 py-2"
      style={{
        borderColor: active ? 'color-mix(in srgb, var(--attention-purple) 28%, var(--border-subtle))' : 'color-mix(in srgb, var(--border-subtle) 80%, transparent)',
        background: active ? 'color-mix(in srgb, var(--attention-purple) 8%, transparent)' : 'color-mix(in srgb, var(--text-primary) 3%, transparent)',
      }}
    >
      <div className="truncate font-semibold">{label}</div>
      <div className="mt-1 truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{value}</div>
    </div>
  );
}
