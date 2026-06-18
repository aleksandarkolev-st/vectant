'use client';

import { FileArchive } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
  boxSizing: 'border-box',
  overflow: 'hidden',
};

const headerStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  borderBottom: '1px solid var(--border-subtle)',
  padding: '12px 16px',
};

const artifactListStyle = {
  display: 'grid',
  gap: 0,
};

const artifactHeaderStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  minWidth: 0,
};

export default function RedactedEvidenceExportPanel({ exportManifest }) {
  const artifacts = exportManifest?.artifacts || [];
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="redacted-evidence-export">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3" style={headerStyle}>
        <div className="min-w-0" style={{ minWidth: 0 }}>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileArchive size={15} aria-hidden="true" />
            Redacted Export
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)', margin: '4px 0 0', overflowWrap: 'anywhere' }}>{exportManifest?.manifestId || 'no-export-id'}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{artifacts.length} artifacts</span>
      </div>
      {artifacts.length ? (
        <div className="divide-y" style={artifactListStyle}>
          {artifacts.map((artifact, index) => (
            <article
              key={artifact.artifactId}
              className="px-4 py-3 text-xs"
              style={{
                borderBottom: index === artifacts.length - 1 ? '0' : '1px solid var(--border-subtle)',
                boxSizing: 'border-box',
                minWidth: 0,
                padding: '12px 16px',
              }}
            >
              <div className="flex flex-wrap items-start justify-between gap-3" style={artifactHeaderStyle}>
                <div className="min-w-0" style={{ minWidth: 0 }}>
                  <h3 className="truncate text-sm font-semibold" style={{ margin: 0, overflowWrap: 'anywhere' }}>{artifact.artifactId}</h3>
                  <p className="mt-1 truncate" style={{ color: 'var(--text-muted)', margin: '4px 0 0', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{artifact.uri || artifact.kind}</p>
                </div>
                <span className="rounded-md border px-2 py-1" style={{ ...panelStyle, flexShrink: 0 }}>{artifact.redactionCount} redactions</span>
              </div>
              <dl className="mt-3 grid gap-2" style={{ display: 'grid', gap: 8, margin: '12px 0 0' }}>
                <Info label="Kind" value={artifact.kind || 'artifact'} />
                <Info label="Manifest" value={artifact.redactionManifestSha256 || 'Not recorded'} />
                <Info label="Rules" value={artifact.rulesApplied.join(', ') || 'Not recorded'} />
                <Info label="Sources" value={artifact.sourceRefs.join(', ') || 'Not recorded'} />
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No redacted export artifacts are reported.</div>
      )}
      {exportManifest?.excluded?.length ? (
        <div className="border-t px-4 py-3 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
          <span style={{ color: 'var(--text-muted)' }}>Excluded: </span>
          <span style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{exportManifest.excluded.join(', ')}</span>
        </div>
      ) : null}
    </section>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-3" style={{ display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: 12, minWidth: 0 }}>
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right" style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere', textAlign: 'right', wordBreak: 'break-word' }}>{value}</dd>
    </div>
  );
}
