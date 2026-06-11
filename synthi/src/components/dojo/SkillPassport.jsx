'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BadgeCheck, ShieldCheck, Timer, Wrench } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function SkillPassport({
  workspaceSlug = '',
  skillId = '',
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
        setError(err?.message || 'dojo_passport_load_failed');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [autoLoad, loadSummary, workspaceSlug]);

  const decodedSkillId = useMemo(() => decodeURIComponent(skillId || ''), [skillId]);
  const skill = useMemo(() => {
    const allSkills = summary.skills || [];
    return allSkills.find((candidate) => candidate.skillId === decodedSkillId) || summary.selectedSkill;
  }, [decodedSkillId, summary.selectedSkill, summary.skills]);

  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="skill-passport"
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a
              href={backHref}
              className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs"
              style={panelStyle}
            >
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Skill Passport</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <BadgeCheck size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : skill?.licenseStatus || 'No license'}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        {skill ? (
          <>
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="rounded-md border p-4" style={panelStyle}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-xl font-semibold">{skill.title}</h2>
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {skill.skillId}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Badge icon={ShieldCheck} label={skill.entrustmentLevel || 'E0'} />
                    <Badge label={`SRL ${skill.readinessLevel ?? 0}`} />
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <Metric label="Coverage" value={`${Math.round(Number(skill.coverageScore || 0) * 100)}%`} />
                  <Metric label="License" value={skill.licenseStatus || 'draft'} />
                  <Metric label="Proof" value={skill.proofRequired ? 'Required' : 'Optional'} />
                </div>
              </div>

              <ExpiryPanel skill={skill} />
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <ScopePanel title="Allowed Alone" items={skill.allowedActions} empty="Practice only" />
              <ScopePanel title="Ask Before" items={skill.gatedActions} empty="No approval gates recorded" />
              <ScopePanel title="Will Not Do" items={skill.blockedActions} empty="No blocked actions recorded" />
              <ScopePanel title="Blocked Contexts" items={skill.blockedContexts} empty="No blocked contexts recorded" />
            </section>

            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <ProofPanel skill={skill} />
              <ToolsPanel tools={skill.publishedTools} />
            </section>

            <section className="grid gap-4 lg:grid-cols-2">
              <TimelinePanel entries={skill.entrustmentTimeline} />
              <ScopePanel title="Case Law References" items={skill.caseLawRefs} empty="No case-law references recorded" />
            </section>
          </>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="skill-passport-empty">
            <h2 className="text-base font-semibold">Passport unavailable</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              No Dojo skill is currently available for this workspace.
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
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
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

function ExpiryPanel({ skill }) {
  const expiry = skill.licenseExpiresAt ? String(skill.licenseExpiresAt).slice(0, 10) : 'Not set';
  const days = typeof skill.daysUntilExpiry === 'number' ? `${skill.daysUntilExpiry} days` : 'Not calculated';
  return (
    <aside className="rounded-md border p-4" style={panelStyle} aria-label="Expiry">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Timer size={15} aria-hidden="true" />
        Expiry
      </h2>
      <dl className="grid gap-2 text-xs">
        <InfoRow label="License ID" value={skill.licenseId || 'Not recorded'} />
        <InfoRow label="Expires" value={expiry} />
        <InfoRow label="Remaining" value={days} />
        <InfoRow label="Policy" value={skill.expiryPolicy || 'Default'} />
      </dl>
    </aside>
  );
}

function ScopePanel({ title, items = [], empty }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {items.length ? (
        <ul className="grid gap-2 text-sm">
          {items.map((item) => (
            <li key={`${title}-${item}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{empty}</p>
      )}
    </section>
  );
}

function ProofPanel({ skill }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle}>
      <h2 className="mb-3 text-sm font-semibold">Proof Requirements</h2>
      <div className="mb-3 grid gap-2 text-xs">
        <InfoRow label="Proof" value={skill.proofRequired ? 'Required' : 'Optional'} />
        <InfoRow label="License" value={skill.licenseStatus || 'draft'} />
      </div>
      {skill.proofRequirements?.length ? (
        <ul className="grid gap-2 text-sm">
          {skill.proofRequirements.map((requirement) => (
            <li key={requirement} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
              {requirement}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No explicit proof claims recorded</p>
      )}
    </section>
  );
}

function ToolsPanel({ tools = [] }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle}>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Wrench size={15} aria-hidden="true" />
        Published Tools
      </h2>
      {tools.length ? (
        <div className="grid gap-2 text-xs">
          {tools.map((tool) => (
            <div key={`${tool.name}-${tool.version || 'current'}`} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="truncate font-semibold">{tool.name}</div>
              <div className="mt-1 flex justify-between gap-3" style={{ color: 'var(--text-muted)' }}>
                <span>{tool.version || 'current'}</span>
                <span>{tool.status || 'published'}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No published MCP tools recorded</p>
      )}
    </section>
  );
}

function TimelinePanel({ entries = [] }) {
  return (
    <section className="rounded-md border p-4" style={panelStyle}>
      <h2 className="mb-3 text-sm font-semibold">Entrustment Timeline</h2>
      {entries.length ? (
        <ol className="grid gap-2 text-sm">
          {entries.map((entry, index) => (
            <li key={`${entry.label}-${entry.at}-${index}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="font-semibold">{entry.level || entry.label}</div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                {[entry.label, entry.at ? String(entry.at).slice(0, 10) : ''].filter(Boolean).join(' / ')}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No entrustment changes recorded</p>
      )}
    </section>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="min-w-0 truncate text-right font-medium">{value}</span>
    </div>
  );
}
