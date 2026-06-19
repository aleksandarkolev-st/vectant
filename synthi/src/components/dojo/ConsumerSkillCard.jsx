'use client';

import { AlertTriangle, BadgeCheck, CircleGauge, FileBadge, GitBranch, KeyRound, ShieldCheck } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

function compactList(items = [], limit = 3) {
  return Array.isArray(items) ? items.filter(Boolean).slice(0, limit) : [];
}

function percent(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, Math.round(numeric * 100)));
}

export default function ConsumerSkillCard({ skill, workspaceSlug = '' }) {
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
    <article className="flex min-h-[360px] flex-col rounded-md border p-4" style={panelStyle} data-testid="consumer-skill-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{skill.title || 'Dojo skill'}</h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{skill.skillId}</p>
        </div>
        <span className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
          <BadgeCheck size={14} aria-hidden="true" />
          {skill.licenseStatus || skill.status || 'draft'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-[82px_minmax(0,1fr)] gap-4">
        <div
          className="grid aspect-square place-items-center rounded-md border"
          style={{
            ...panelStyle,
            background: `conic-gradient(var(--accent-primary) ${coverage}%, color-mix(in srgb, var(--border-subtle) 68%, transparent) 0)`,
          }}
          aria-label={`Coverage ${coverage}%`}
        >
          <div className="grid h-[58px] w-[58px] place-items-center rounded-md" style={{ background: 'var(--bg-app)' }}>
            <span className="text-sm font-semibold">{coverage}%</span>
          </div>
        </div>

        <dl className="grid content-start gap-2 text-xs">
          <InfoRow label="Entrustment" value={skill.entrustmentLevel || 'E0'} />
          <InfoRow label="Readiness" value={`SRL ${skill.readinessLevel ?? 0}`} />
          <InfoRow label="Proof" value={skill.proofRequired ? 'Required' : 'Optional'} />
          <InfoRow label="Tool" value={skill.publishedToolName || skill.publishedTools?.[0]?.name || 'Not published'} />
        </dl>
      </div>

      <div className="mt-4 grid gap-3">
        <ScopeBlock icon={ShieldCheck} title="Can Do Alone" items={allowed} empty="Practice only" />
        <ScopeBlock icon={KeyRound} title="Ask Before" items={askBefore} empty="No approval gates recorded" />
        <ScopeBlock icon={AlertTriangle} title="Will Not Do" items={blocked} empty="No blocked actions recorded" />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
        <span className="inline-flex min-w-0 items-center gap-2" style={{ color: safeMode ? 'var(--accent-success)' : 'var(--text-muted)' }}>
          <CircleGauge size={14} aria-hidden="true" />
          <span className="truncate">{safeMode ? 'Safe Mode constrained' : 'Practice mode'}</span>
        </span>
        <span style={{ color: 'var(--text-muted)' }}>{skill.scenarioCount || 0} scenarios</span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <a href={passportHref} className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
          <FileBadge size={14} aria-hidden="true" />
          Passport
        </a>
        <a href={cortexHref} className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
          <GitBranch size={14} aria-hidden="true" />
          Cortex
        </a>
      </div>
    </article>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-2">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right font-semibold">{value}</dd>
    </div>
  );
}

function ScopeBlock({ icon: Icon, title, items, empty }) {
  return (
    <section className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
      <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold">
        <Icon size={14} aria-hidden="true" />
        {title}
      </h3>
      {items.length ? (
        <ul className="grid gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          {items.map((item) => (
            <li key={`${title}-${item}`} className="truncate">{item}</li>
          ))}
        </ul>
      ) : (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{empty}</p>
      )}
    </section>
  );
}
