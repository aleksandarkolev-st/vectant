'use client';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function CortexNodeInspector({ node, graph }) {
  if (!node) {
    return (
      <aside className="rounded-md border p-4" style={panelStyle} data-testid="cortex-node-inspector-empty">
        <h2 className="text-sm font-semibold">Node Inspector</h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Select a graph node to inspect its operational memory.</p>
      </aside>
    );
  }

  const incoming = graph?.edges?.filter((edge) => edge.to === node.id) || [];
  const outgoing = graph?.edges?.filter((edge) => edge.from === node.id) || [];
  const incomingProofRequired = incoming.some((edge) => graph?.nodes?.find((candidate) => candidate.id === edge.from)?.kind === 'Proof');
  const proofRequired = node.proofRequired || incomingProofRequired;
  return (
    <aside className="rounded-md border p-4" style={panelStyle} data-testid="cortex-node-inspector">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{node.label}</h2>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{node.id}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{node.kind}</span>
      </div>

      <dl className="mt-4 grid gap-2 text-xs">
        <InfoRow label="Risk" value={node.risk || 'safe'} />
        <InfoRow label="Substrate" value={node.substrate || node.metadata?.substrate || 'runtime'} />
        <InfoRow label="Proof" value={proofRequired ? 'Required' : 'Not required'} />
        <InfoRow label="Incoming" value={String(incoming.length)} />
        <InfoRow label="Outgoing" value={String(outgoing.length)} />
      </dl>

      <InspectorSection title="Inputs" items={node.inputs} />
      <InspectorSection title="Outputs" items={node.outputs} />
      <InspectorSection title="Guardrails" items={node.guardrailRefs} />
      <InspectorSection title="Proof Claims" items={node.proofClaims} />
      <InspectorSection title="Assertions" items={node.assertions} />
      <InspectorSection title="Case Law" items={node.caseRefs} />
      <InspectorSection title="Expiry Triggers" items={node.expiryTriggers} />
      <InspectorSection title="Evidence Policy" items={node.evidencePolicy} />

      {node.memory && Object.keys(node.memory).length ? (
        <section className="mt-4">
          <h3 className="mb-2 text-xs font-semibold">Memory</h3>
          <pre className="max-h-40 overflow-auto rounded-md border p-3 text-[11px]" style={{ borderColor: 'var(--border-subtle)' }}>
            {JSON.stringify(node.memory, null, 2)}
          </pre>
        </section>
      ) : null}
    </aside>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{value}</dd>
    </div>
  );
}

function InspectorSection({ title, items = [] }) {
  return (
    <section className="mt-4">
      <h3 className="mb-2 text-xs font-semibold">{title}</h3>
      {items.length ? (
        <ul className="grid gap-2 text-xs">
          {items.map((item) => (
            <li key={`${title}-${item}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>None recorded</p>
      )}
    </section>
  );
}
