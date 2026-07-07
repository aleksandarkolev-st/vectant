'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, BadgeCheck, Rows3, ShieldCheck } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import ConsumerSkillCard from './ConsumerSkillCard';

export default function SkillCardGrid({
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
        setError(err?.message || 'dojo_skill_cards_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const skills = useMemo(() => {
    const listed = Array.isArray(summary.skills) ? summary.skills.filter(Boolean) : [];
    if (listed.length) return listed;
    return summary.selectedSkill ? [summary.selectedSkill] : [];
  }, [summary.selectedSkill, summary.skills]);

  const licensedCount = skills.filter((skill) => skill.status === 'licensed' || skill.licenseStatus === 'licensed').length;
  const proofRequiredCount = skills.filter((skill) => skill.proofRequired).length;
  const askBeforeCount = skills.reduce((total, skill) => total + (Array.isArray(skill.gatedActions) ? skill.gatedActions.length : 0), 0);
  const baseHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;
  const metricItems = [
    ['Skills', skills.length],
    ['Licensed', licensedCount],
    ['Proof Required', proofRequiredCount],
    ['Ask-Before Rules', askBeforeCount],
  ];

  return (
    <motion.main
      className="dojo-page min-h-[100dvh] px-5 py-5 text-sm"
      style={{ color: 'var(--text-primary)' }}
      data-testid="skill-card-grid"
      initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
      animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <section className="vt-command-surface overflow-hidden">
          <header className="vt-panel-header min-h-[54px] flex-wrap justify-between gap-3 px-4">
            <div className="flex min-w-0 items-center gap-3">
              <a href={baseHref} className="vt-icon-button th-focus-ring h-8 min-w-8" aria-label="Back to Dojo">
                <ArrowLeft size={15} aria-hidden="true" />
              </a>
              <div className="min-w-0">
                <div className="vt-panel-kicker truncate">Skill catalog / {workspaceSlug || 'workspace'}</div>
                <h1 className="vt-panel-title mt-0.5 text-[15px]">Skill Cards</h1>
              </div>
            </div>
            <div className="vt-state-pill h-7">
              <BadgeCheck size={14} aria-hidden="true" />
              <span>{loading ? 'Loading' : error ? 'Unavailable' : `${skills.length} skills`}</span>
            </div>
          </header>

          {error ? (
            <section className="vt-workflow-alert mx-4 mt-4 p-3 text-xs" role="status">
              {error}
            </section>
          ) : null}

          <section
            className="grid border-b border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] text-xs md:grid-cols-4"
            aria-label="Skill card metrics"
          >
            {metricItems.map(([label, value]) => (
              <Metric key={label} label={label} value={value} />
            ))}
          </section>

          {skills.length ? (
            <section aria-label="Dojo skill cards">
              <div className="hidden grid-cols-[minmax(0,1.35fr)_110px_116px_140px_minmax(180px,1fr)_120px] gap-3 border-b border-[color-mix(in_srgb,var(--border-subtle)_82%,transparent)] px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] lg:grid" style={{ color: 'var(--text-muted)' }}>
                <span>Skill</span>
                <span>Coverage</span>
                <span>Entrustment</span>
                <span>License</span>
                <span>Boundaries</span>
                <span className="text-right">Actions</span>
              </div>
              <div className="divide-y divide-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)]">
                {skills.map((skill, index) => (
                  <ConsumerSkillCard
                    key={skill.skillId || skill.title}
                    skill={skill}
                    workspaceSlug={workspaceSlug}
                    index={index}
                  />
                ))}
              </div>
            </section>
          ) : (
            <section className="vt-empty-state m-4 justify-items-start text-left" data-testid="skill-card-empty">
              <div className="max-w-xl">
                <h2 className="flex items-center gap-2 text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                  <ShieldCheck size={16} aria-hidden="true" />
                  No skill cards yet
                </h2>
                <p className="mt-2 text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
                  Teach and license a workflow from the Agent Workflow panel to populate this user-facing skill catalog.
                </p>
              </div>
            </section>
          )}
        </section>
      </div>
    </motion.main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="border-r border-[color-mix(in_srgb,var(--border-subtle)_72%,transparent)] px-4 py-3 last:border-r-0">
      <div className="flex items-center gap-2">
        <Rows3 size={13} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
        <span className="vt-panel-kicker">{label}</span>
      </div>
      <div className="mt-1 truncate font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}
