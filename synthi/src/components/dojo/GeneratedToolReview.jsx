'use client';

import { Wrench } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function GeneratedToolReview({ tools = [] }) {
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="generated-tool-review">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Wrench size={15} aria-hidden="true" />
          Generated Tool Review
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{tools.length} tools</span>
      </div>
      {tools.length ? (
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {tools.map((tool) => (
            <article key={`${tool.toolName}-${tool.toolVersion}`} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{tool.toolName}</h3>
                  <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{tool.candidateId || tool.schemaDigest || 'No candidate link'}</p>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{tool.status}</span>
              </div>
              <dl className="mt-3 grid gap-2 text-xs">
                <Info label="Version" value={tool.toolVersion || 'draft'} />
                <Info label="Proof" value={tool.proofRequired ? 'Required' : 'Not required'} />
                <Info label="Digest" value={tool.schemaDigest || 'Not signed'} />
                <Info label="Blocks" value={tool.blockedBy.join(', ') || 'None'} />
              </dl>
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No generated API tools are reported.</div>
      )}
    </section>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
