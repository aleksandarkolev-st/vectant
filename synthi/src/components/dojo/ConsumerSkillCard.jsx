'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, BadgeCheck, CircleGauge, FileBadge, GitBranch, KeyRound, ShieldCheck } from 'lucide-react';

function compactList(items = [], limit = 3) {
  return Array.isArray(items) ? items.filter(Boolean).slice(0, limit) : [];
}

function percent(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric * 100)));
}

export default function ConsumerSkillCard({ skill, workspaceSlug = '', index = 0 }) {
  const prefersReducedMotion = useReducedMotion();

  if (!skill) return null;

  const encodedWorkspace = encodeURIComponent(workspaceSlug || 'current');
  const encodedSkill = encodeURIComponent(skill.skillId || 'skill');
  const passportHref = `/workspace/${encodedWorkspace}/dojo/skills/${encodedSkill}/passport`;
  const cortexHref = `/workspace/${encodedWorkspace}/dojo/skills/${encodedSkill}/cortex`;
  const coverage = percent(skill.coverageScore);
  const allowed = compactList(skill.allowedActions);
  const askBefore = compactList(skill.gatedActions);
  const blocked = compactList(skill.blockedActions);
  const safeMode = Boolean(skill.proofRequired || askBefore.length || blocked.length);

  return (
    <motion.article
      className="vt-command-item grid gap-3 rounded-none px-4 py-4 lg:grid-cols-[minmax(0,1.35fr)_110px_116px_140px_minmax(180px,1fr)_120px] lg:items-center"
      data-testid="consumer-skill-card"
      initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
      animate={prefersReducedMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index * 0.035, 0.18), ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-sm font-semibold">{skill.title || 'Dojo skill'}</h2>
          <span className="vt-state-pill h-5 shrink-0">
            <BadgeCheck size={12} aria-hidden="true" />
            {skill.licenseStatus || skill.status || 'draft'}
          </span>
        </div>
        <p className="mt-1 truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{skill.skillId}</p>
        <div className="mt-2 flex min-w-0 items-center gap-2 text-[11px]" style={{ color: safeMode ? 'var(--accent-success)' : 'var(--text-muted)' }}>
          <CircleGauge size={13} aria-hidden="true" />
          <span className="truncate">{safeMode ? 'Safe Mode constrained' : 'Practice mode'}</span>
          <span className="text-[var(--text-muted)]">{skill.scenarioCount || 0} scenarios</span>
        </div>
      </div>

      <div className="min-w-0">
        <div className="mb-1 flex items-center justify-between text-[11px] lg:hidden" style={{ color: 'var(--text-muted)' }}>
          <span>Coverage</span>
          <span className="font-mono">{coverage}%</span>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="h-2 flex-1 overflow-hidden rounded-full"
            style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}
            aria-label={`Coverage ${coverage}%`}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${coverage}%`,
                background: 'linear-gradient(90deg, var(--attention-purple), var(--accent-secondary))',
              }}
            />
          </div>
          <span className="font-mono text-xs font-semibold">{coverage}%</span>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-xs lg:block">
        <InfoRow label="Entrustment" value={skill.entrustmentLevel || 'E0'} />
        <InfoRow label="Readiness" value={`SRL ${skill.readinessLevel ?? 0}`} />
      </dl>

      <div className="flex flex-wrap gap-1.5">
        <span className="vt-workflow-chip" style={{ '--chip-color': 'var(--accent-success)' }}>
          <ShieldCheck size={12} aria-hidden="true" />
          {skill.proofRequired ? 'Proof Required' : 'Proof Optional'}
        </span>
        <span className="vt-workflow-chip">
          {skill.publishedToolName || skill.publishedTools?.[0]?.name || 'Not published'}
        </span>
      </div>

      <div className="grid min-w-0 gap-1.5">
        <ScopeLine icon={ShieldCheck} title="Can Do Alone" items={allowed} empty="Practice only" />
        <ScopeLine icon={KeyRound} title="Ask Before" items={askBefore} empty="No approval gates recorded" />
        <ScopeLine icon={AlertTriangle} title="Will Not Do" items={blocked} empty="No blocked actions recorded" />
      </div>

      <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
        <a href={passportHref} className="th-focus-ring th-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-2.5 text-xs">
          <FileBadge size={14} aria-hidden="true" />
          Passport
        </a>
        <a href={cortexHref} className="th-focus-ring th-btn-ghost inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border-subtle)] px-2.5 text-xs">
          <GitBranch size={14} aria-hidden="true" />
          Cortex
        </a>
      </div>
    </motion.article>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 lg:grid-cols-1 lg:gap-0">
      <dt className="text-[10px] uppercase tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate font-semibold">{value}</dd>
    </div>
  );
}

function ScopeLine({ icon: Icon, title, items, empty }) {
  return (
    <section className="grid min-w-0 grid-cols-[92px_minmax(0,1fr)] items-start gap-2 text-[11px]">
      <h3 className="flex min-w-0 items-center gap-1.5 font-semibold" style={{ color: 'var(--text-muted)' }}>
        <Icon size={12} aria-hidden="true" />
        <span className="truncate">{title}</span>
      </h3>
      {items.length ? (
        <ul className="flex min-w-0 flex-wrap gap-1" style={{ color: 'var(--text-secondary)' }}>
          {items.map((item) => (
            <li key={`${title}-${item}`} className="vt-workflow-chip max-w-full truncate">{item}</li>
          ))}
        </ul>
      ) : (
        <p className="min-w-0 truncate" style={{ color: 'var(--text-muted)' }}>{empty}</p>
      )}
    </section>
  );
}
