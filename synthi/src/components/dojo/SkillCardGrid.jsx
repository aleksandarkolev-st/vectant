'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BadgeCheck, ShieldCheck } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import ConsumerSkillCard from './ConsumerSkillCard';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function SkillCardGrid({
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

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="skill-card-grid"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={baseHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Skill Cards</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <BadgeCheck size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : `${skills.length} skills`}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        <section className="grid gap-3 md:grid-cols-4" aria-label="Skill card metrics">
          <Metric label="Skills" value={skills.length} />
          <Metric label="Licensed" value={licensedCount} />
          <Metric label="Proof Required" value={proofRequiredCount} />
          <Metric label="Ask-Before Rules" value={askBeforeCount} />
        </section>

        {skills.length ? (
          <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3" aria-label="Dojo skill cards">
            {skills.map((skill) => (
              <ConsumerSkillCard key={skill.skillId || skill.title} skill={skill} workspaceSlug={workspaceSlug} />
            ))}
          </section>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="skill-card-empty">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <ShieldCheck size={16} aria-hidden="true" />
              No skill cards yet
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              Teach and license a workflow from the Agent Workflow panel to populate this user-facing skill catalog.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-md border px-3 py-3" style={panelStyle}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 truncate text-xl font-semibold">{value}</div>
    </div>
  );
}
