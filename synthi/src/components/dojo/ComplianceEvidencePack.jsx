'use client';

import { PackageCheck } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function ComplianceEvidencePack({ pack }) {
  const artifacts = pack?.artifacts || [];
  const missing = pack?.missingArtifacts || [];

  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="compliance-evidence-pack">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <PackageCheck size={15} aria-hidden="true" />
            Compliance Pack
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{pack?.packId || 'No pack ID'}</p>
        </div>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{artifacts.length} artifacts</span>
      </div>

      {artifacts.length ? (
        <div className="grid gap-2">
          {artifacts.map((artifact) => (
            <article key={artifact.artifactId || artifact.title} className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{artifact.title}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{artifact.artifactId}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{artifact.status}</span>
              </div>
              {artifact.digest ? <p className="mt-3 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{artifact.digest}</p> : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No compliance artifacts are available.</p>
      )}

      {missing.length ? (
        <div className="mt-3 rounded-md border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)', color: 'var(--accent-warning)' }}>
          Missing: {missing.join(', ')}
        </div>
      ) : null}
    </section>
  );
}
