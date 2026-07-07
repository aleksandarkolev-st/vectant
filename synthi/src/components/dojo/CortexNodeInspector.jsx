'use client';

import { useMemo, useState } from 'react';
import { Braces, CheckCircle2, CircleDot, GitBranch, ShieldCheck, Waypoints } from 'lucide-react';

const panelStyle = {
  borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)',
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-panel) 88%, var(--text-primary) 3%), color-mix(in srgb, var(--bg-app) 54%, transparent))',
  borderRadius: 'var(--radius-panel)',
  boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-primary) 4%, transparent)',
};

export default function CortexNodeInspector({ node, graph }) {
  const [activeTab, setActiveTab] = useState('graph');
  const nodesById = useMemo(() => {
    return new Map((graph?.nodes || []).map((candidate) => [candidate.id, candidate]));
  }, [graph?.nodes]);
  const incoming = useMemo(() => (
    node ? graph?.edges?.filter((edge) => edge.to === node.id) || [] : []
  ), [graph?.edges, node]);
  const outgoing = useMemo(() => (
    node ? graph?.edges?.filter((edge) => edge.from === node.id) || [] : []
  ), [graph?.edges, node]);
  const incomingProofRequired = incoming.some((edge) => nodesById.get(edge.from)?.kind === 'Proof');
  const proofRequired = Boolean(node?.proofRequired || incomingProofRequired);
  const risk = String(node?.risk || 'safe').toLowerCase();
  const evidenceCounts = useMemo(() => buildEvidenceCounts(node), [node]);

  if (!node) {
    return (
      <aside className="rounded-lg border p-4" style={panelStyle} data-testid="cortex-node-inspector-empty">
        <h2 className="text-sm font-semibold">Node Inspector</h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>Select a graph node to inspect its operational memory.</p>
      </aside>
    );
  }

  return (
    <aside className="rounded-lg border p-3 md:p-4" style={panelStyle} data-testid="cortex-node-inspector">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px]" style={panelStyle}>
            <Waypoints size={12} aria-hidden="true" />
            Runtime node
          </div>
          <h2 className="truncate text-base font-semibold">{node.label}</h2>
          <p className="mt-1 truncate font-mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{node.id}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs font-semibold" style={riskBadgeStyle(risk)}>{node.kind}</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2" data-testid="cortex-node-metrics">
        <MetricBadge icon={ShieldCheck} label="Proof" value={proofRequired ? 'Required' : 'Optional'} active={proofRequired} />
        <MetricBadge icon={GitBranch} label="Edges" value={`${incoming.length} in / ${outgoing.length} out`} active={incoming.length + outgoing.length > 0} />
        <MetricBadge icon={Braces} label="Signals" value={String(evidenceCounts.total)} active={evidenceCounts.total > 0} />
        <MetricBadge icon={risk === 'dangerous' ? CircleDot : CheckCircle2} label="Risk" value={risk} active={risk !== 'safe'} tone={risk} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-1 rounded-md border p-1" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)', background: 'color-mix(in srgb, var(--bg-app) 42%, transparent)' }} role="tablist" aria-label="Cortex inspector views">
        <InspectorTabButton label="Graph" active={activeTab === 'graph'} onClick={() => setActiveTab('graph')} />
        <InspectorTabButton label="Trace" active={activeTab === 'trace'} onClick={() => setActiveTab('trace')} />
        <InspectorTabButton label="Evidence" active={activeTab === 'evidence'} onClick={() => setActiveTab('evidence')} />
      </div>

      <div className={activeTab === 'graph' ? 'block' : 'hidden'} data-testid="cortex-node-graph-pane">
        <dl className="mt-4 grid gap-2 text-xs">
          <InfoRow label="Risk" value={risk} />
          <InfoRow label="Substrate" value={node.substrate || node.metadata?.substrate || 'runtime'} />
          <InfoRow label="Action" value={node.action || node.metadata?.action_kind || 'none'} />
          <InfoRow label="Proof" value={proofRequired ? 'Required' : 'Not required'} />
          <InfoRow label="Graph" value={graph?.graphId || graph?.schemaVersion || 'runtime'} />
        </dl>
        <TraceLedger title="Upstream" edges={incoming} direction="incoming" nodesById={nodesById} />
        <TraceLedger title="Downstream" edges={outgoing} direction="outgoing" nodesById={nodesById} />
      </div>

      <div className={activeTab === 'trace' ? 'block' : 'hidden'} data-testid="cortex-node-trace-pane">
        <section className="mt-4 rounded-md border p-3" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }}>
          <h3 className="text-xs font-semibold">Execution Ledger</h3>
          <div className="mt-3 grid gap-2">
            <TraceStep index={1} label="Context" value={node.substrate || node.metadata?.substrate || 'runtime'} />
            <TraceStep index={2} label="Guard" value={proofRequired ? 'proof gate enforced' : 'standard runtime checks'} />
            <TraceStep index={3} label="Effect" value={firstValue(node.outputs) || node.action || node.label} />
            <TraceStep index={4} label="Review" value={firstValue(node.assertions) || firstValue(node.caseRefs) || 'no exception recorded'} />
          </div>
        </section>
        <TraceLedger title="Inputs from graph" edges={incoming} direction="incoming" nodesById={nodesById} />
        <TraceLedger title="Outputs to graph" edges={outgoing} direction="outgoing" nodesById={nodesById} />
      </div>

      <div className={activeTab === 'evidence' ? 'block' : 'hidden'} data-testid="cortex-node-evidence-pane">
        <InspectorSection title="Inputs" items={node.inputs} />
        <InspectorSection title="Outputs" items={node.outputs} />
        <InspectorSection title="Guardrails" items={node.guardrailRefs} />
        <InspectorSection title="Proof Claims" items={node.proofClaims} />
        <InspectorSection title="Assertions" items={node.assertions} />
        <InspectorSection title="Case Law" items={node.caseRefs} />
        <InspectorSection title="Expiry Triggers" items={node.expiryTriggers} />
        <InspectorSection title="Evidence Policy" items={node.evidencePolicy} />
      </div>

      {node.memory && Object.keys(node.memory).length ? (
        <>
          <details className="mt-3 rounded-md border px-3 py-2" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }}>
            <summary className="cursor-pointer text-xs font-semibold">Memory</summary>
            <pre className="mt-3 max-h-40 overflow-auto rounded-md border p-3 text-[11px]" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }}>
              {JSON.stringify(node.memory, null, 2)}
            </pre>
          </details>
        </>
      ) : null}
    </aside>
  );
}

function MetricBadge({ icon: Icon, label, value, active = false, tone = 'neutral' }) {
  return (
    <div className="rounded-md border px-2.5 py-2" style={active ? riskBadgeStyle(tone) : panelStyle}>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-normal" style={{ color: 'var(--text-muted)' }}>
        <Icon size={12} aria-hidden="true" />
        {label}
      </div>
      <div className="mt-1 truncate text-xs font-semibold">{value}</div>
    </div>
  );
}

function InspectorTabButton({ label, active, onClick }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className="th-focus-ring h-8 rounded-[var(--radius-control)] px-2 text-xs font-semibold transition hover:-translate-y-px"
      style={{
        background: active ? 'color-mix(in srgb, var(--primary) 12%, var(--bg-panel))' : 'transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-muted)',
        border: active ? '1px solid color-mix(in srgb, var(--primary) 34%, var(--border-subtle))' : '1px solid transparent',
      }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-3 rounded-md border px-3 py-2" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 70%, transparent)' }}>
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{value}</dd>
    </div>
  );
}

function TraceLedger({ title, edges, direction, nodesById }) {
  return (
    <section className="mt-3 rounded-md border p-3" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }} data-testid="cortex-trace-ledger">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold">{title}</h3>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{edges.length}</span>
      </div>
      {edges.length ? (
        <ul className="mt-3 grid gap-2">
          {edges.map((edge) => {
            const adjacent = nodesById.get(direction === 'incoming' ? edge.from : edge.to);
            return (
              <li key={`${title}-${edge.from}-${edge.to}-${edge.label || edge.kind || ''}`} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 72%, transparent)' }}>
                <GitBranch size={13} aria-hidden="true" style={{ color: 'var(--text-muted)' }} />
                <div className="min-w-0">
                  <div className="truncate font-semibold">{adjacent?.label || adjacent?.id || 'External node'}</div>
                  <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {edgeLabel(edge)} / {adjacent?.kind || 'edge'}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>No graph edge recorded.</p>
      )}
    </section>
  );
}

function TraceStep({ index, label, value }) {
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 rounded-md border px-2.5 py-2 text-xs" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 72%, transparent)' }}>
      <span className="grid h-5 w-5 place-items-center rounded border font-mono text-[10px]" style={panelStyle}>{index}</span>
      <div className="min-w-0">
        <div className="font-semibold">{label}</div>
        <div className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>{value}</div>
      </div>
    </div>
  );
}

function InspectorSection({ title, items = [] }) {
  const normalized = normalizeItems(items);
  const content = normalized.length ? (
    <ul className="grid gap-2 text-xs">
      {normalized.map((item) => (
        <li key={`${title}-${item}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 82%, transparent)' }}>
          {formatItem(item)}
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>None recorded</p>
  );

  return (
    <section className="mt-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold">{title}</h3>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>{normalized.length}</span>
      </div>
      {content}
    </section>
  );
}

function buildEvidenceCounts(node) {
  if (!node) return { total: 0 };
  const total = [
    node.inputs,
    node.outputs,
    node.guardrailRefs,
    node.proofClaims,
    node.assertions,
    node.caseRefs,
    node.expiryTriggers,
    node.evidencePolicy,
  ].reduce((sum, items) => sum + normalizeItems(items).length, 0);
  return { total };
}

function normalizeItems(items) {
  if (!items) return [];
  if (Array.isArray(items)) return items.filter((item) => item !== null && item !== undefined);
  return [items];
}

function firstValue(items) {
  const [first] = normalizeItems(items);
  return first ? formatItem(first) : '';
}

function formatItem(item) {
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (item && typeof item === 'object') {
    return item.label || item.title || item.id || item.name || JSON.stringify(item);
  }
  return '';
}

function edgeLabel(edge) {
  return edge?.label || edge?.kind || edge?.type || edge?.relationship || 'dependency';
}

function riskBadgeStyle(risk = 'neutral') {
  if (risk === 'dangerous' || risk === 'high') {
    return {
      borderColor: 'color-mix(in srgb, var(--accent-danger) 38%, var(--border-subtle))',
      background: 'color-mix(in srgb, var(--accent-danger) 12%, transparent)',
      color: 'var(--text-primary)',
    };
  }
  if (risk === 'safe' || risk === 'ok') {
    return {
      borderColor: 'color-mix(in srgb, var(--accent-success) 34%, var(--border-subtle))',
      background: 'color-mix(in srgb, var(--accent-success) 11%, transparent)',
      color: 'var(--text-primary)',
    };
  }
  return {
    borderColor: 'color-mix(in srgb, var(--primary) 30%, var(--border-subtle))',
    background: 'color-mix(in srgb, var(--primary) 9%, transparent)',
    color: 'var(--text-primary)',
  };
}
