'use client';

import { GitBranch } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function SubstrateLadderView({ nodes = [] }) {
  return (
    <section className="rounded-md border" style={panelStyle} data-testid="substrate-ladder-view">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <GitBranch size={15} aria-hidden="true" />
          Substrate Ladder
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{nodes.length} nodes</span>
      </div>
      {nodes.length ? (
        <>
          <div className="divide-y md:hidden" style={{ borderColor: 'var(--border-subtle)' }}>
            {nodes.map((node) => (
              <article key={`${node.nodeId}-${node.label}`} className="grid gap-2 px-4 py-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{node.label}</h3>
                    <p className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{node.nodeId}</p>
                  </div>
                  <span className="rounded-md border px-2 py-1" style={panelStyle}>{node.substrate}</span>
                </div>
                <Detail label="Kind" value={node.kind || 'Action'} />
                <Detail label="Source" value={node.sourceAnchorId || 'Not linked'} />
                <Detail label="API" value={node.apiCandidateId || 'Not promoted'} />
                <Detail label="Proof" value={node.proofRequired ? 'Required' : 'Not required'} />
              </article>
            ))}
          </div>
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full table-fixed text-left text-xs">
              <thead style={{ color: 'var(--text-muted)' }}>
                <tr className="border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                  <th className="w-48 px-4 py-3 font-medium">Node</th>
                  <th className="w-28 px-4 py-3 font-medium">Kind</th>
                  <th className="w-32 px-4 py-3 font-medium">Substrate</th>
                  <th className="px-4 py-3 font-medium">Source/API</th>
                  <th className="w-24 px-4 py-3 font-medium">Proof</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={`${node.nodeId}-${node.label}`} className="border-b last:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="px-4 py-3">
                      <div className="truncate font-medium">{node.label}</div>
                      <div className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{node.nodeId}</div>
                    </td>
                    <td className="truncate px-4 py-3">{node.kind || 'Action'}</td>
                    <td className="truncate px-4 py-3">{node.substrate}</td>
                    <td className="px-4 py-3">
                      <div className="truncate">{node.sourceAnchorId || 'No source anchor'}</div>
                      <div className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{node.apiCandidateId || 'No API candidate'}</div>
                    </td>
                    <td className="truncate px-4 py-3">{node.proofRequired ? 'Required' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>No substrate nodes are reported.</div>
      )}
    </section>
  );
}

function Detail({ label, value }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
