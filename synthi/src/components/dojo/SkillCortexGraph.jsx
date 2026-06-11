'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, GitBranch, ShieldCheck } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import CortexNodeInspector from './CortexNodeInspector';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

const NODE_WIDTH = 172;
const NODE_HEIGHT = 78;
const LAYER_GAP = 214;
const ROW_GAP = 120;

export default function SkillCortexGraph({
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
        setError(err?.message || 'dojo_cortex_load_failed');
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
  const graph = skill?.graph;
  const [selectedNodeId, setSelectedNodeId] = useState('');

  useEffect(() => {
    if (!graph?.nodes?.length) {
      setSelectedNodeId('');
      return;
    }
    setSelectedNodeId((current) => (graph.nodes.some((node) => node.id === current) ? current : graph.nodes[0].id));
  }, [graph]);

  const selectedNode = graph?.nodes?.find((node) => node.id === selectedNodeId) || null;
  const layout = useMemo(() => computeGraphLayout(graph), [graph]);
  const backHref = `/workspace/${encodeURIComponent(workspaceSlug || 'current')}/dojo`;

  return (
    <main
      className="min-h-screen px-5 py-5 text-sm"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="skill-cortex-view"
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Skill Cortex</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={panelStyle}>
            <GitBranch size={14} aria-hidden="true" />
            <span>{loading ? 'Loading' : error ? 'Unavailable' : graph?.mode || 'No graph'}</span>
          </div>
        </header>

        {error ? (
          <section className="rounded-md border p-3 text-xs" style={{ ...panelStyle, color: 'var(--accent-warning)' }} role="status">
            {error}
          </section>
        ) : null}

        {skill && graph?.nodes?.length ? (
          <>
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="rounded-md border p-4" style={panelStyle}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-xl font-semibold">{skill.title}</h2>
                    <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                      {graph.graphId || graph.schemaVersion || skill.skillId}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Badge icon={ShieldCheck} label={skill.entrustmentLevel || 'E0'} />
                    <Badge label={`SRL ${skill.readinessLevel ?? 0}`} />
                  </div>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-4">
                  <Metric label="Nodes" value={graph.nodes.length} />
                  <Metric label="Edges" value={graph.edges?.length || 0} />
                  <Metric label="Validation" value={graph.validation?.ok === false ? 'Warnings' : 'OK'} />
                  <Metric label="Source" value={graph.derived ? 'Derived' : 'Backend'} />
                </div>
              </div>

              <aside className="rounded-md border p-4" style={panelStyle}>
                <h2 className="mb-3 text-sm font-semibold">Legend</h2>
                <Legend label="Proof" tone="proof" />
                <Legend label="Guardrail / Case Law" tone="guardrail" />
                <Legend label="Mutation Action" tone="mutation" />
                <Legend label="Dangerous Action" tone="dangerous" />
                <Legend label="Expired / Recertify" tone="expired" />
              </aside>
            </section>

            <section className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 rounded-md border p-3" style={panelStyle}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold">Graph</h2>
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {graph.schemaVersion || 'graph'}
                  </span>
                </div>
                <GraphCanvas
                  graph={graph}
                  layout={layout}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                />
              </div>
              <CortexNodeInspector node={selectedNode} graph={graph} />
            </section>
          </>
        ) : (
          <section className="rounded-md border p-6" style={panelStyle} data-testid="skill-cortex-empty">
            <h2 className="text-base font-semibold">Cortex unavailable</h2>
            <p className="mt-2 max-w-xl text-sm leading-6" style={{ color: 'var(--text-secondary)' }}>
              No Skill Cortex graph is currently available for this workspace.
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

export function GraphCanvas({ graph, layout, selectedNodeId, onSelectNode }) {
  return (
    <div className="max-w-full overflow-auto rounded-md border" style={{ borderColor: 'var(--border-subtle)' }} data-testid="skill-cortex-graph">
      <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: '100%' }}>
        <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            <marker id="cortex-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="rgba(148, 163, 184, 0.72)" />
            </marker>
          </defs>
          {(graph.edges || []).map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_HEIGHT / 2;
            const mid = x1 + Math.max(40, (x2 - x1) / 2);
            return (
              <path
                key={edge.id}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="rgba(148, 163, 184, 0.58)"
                strokeWidth="1.5"
                markerEnd="url(#cortex-arrow)"
              />
            );
          })}
        </svg>
        {graph.nodes.map((node) => {
          const position = layout.positions.get(node.id);
          if (!position) return null;
          const tone = nodeTone(node);
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelectNode(node.id)}
              className="absolute rounded-md border p-3 text-left transition"
              style={{
                left: position.x,
                top: position.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                borderColor: selectedNodeId === node.id ? 'var(--accent-primary)' : tone.border,
                borderLeft: `4px solid ${tone.border}`,
                background: tone.background,
                color: 'var(--text-primary)',
                boxShadow: selectedNodeId === node.id ? '0 0 0 1px var(--accent-primary)' : 'none',
              }}
              data-testid={`cortex-node-${node.id}`}
            >
              <div className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>{node.kind}</div>
              <div className="mt-1 line-clamp-2 text-sm font-semibold">{node.label}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function computeGraphLayout(graph) {
  const nodes = graph?.nodes || [];
  if (!nodes.length) return { width: 640, height: 320, positions: new Map() };
  const nodeIds = new Set(nodes.map((node) => node.id));
  const layers = new Map(nodes.map((node) => [node.id, 0]));
  const edges = (graph.edges || []).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  for (let pass = 0; pass < Math.max(1, nodes.length * 2); pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const nextLayer = Math.max(layers.get(edge.to) || 0, (layers.get(edge.from) || 0) + 1);
      if (nextLayer !== layers.get(edge.to)) {
        layers.set(edge.to, nextLayer);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const grouped = new Map();
  for (const node of nodes) {
    const layer = layers.get(node.id) || 0;
    const list = grouped.get(layer) || [];
    list.push(node);
    grouped.set(layer, list);
  }
  const positions = new Map();
  let maxLayer = 0;
  let maxRows = 1;
  for (const [layer, list] of grouped.entries()) {
    maxLayer = Math.max(maxLayer, layer);
    maxRows = Math.max(maxRows, list.length);
    list.forEach((node, row) => {
      positions.set(node.id, {
        x: 32 + layer * LAYER_GAP,
        y: 32 + row * ROW_GAP,
      });
    });
  }
  return {
    positions,
    width: 64 + (maxLayer + 1) * LAYER_GAP,
    height: 80 + maxRows * ROW_GAP,
  };
}

function nodeTone(node) {
  if (node.kind === 'Proof') return { border: '#2563eb', background: 'rgba(37, 99, 235, 0.10)' };
  if (['Guardrail', 'CaseLaw', 'Adversary'].includes(node.kind)) return { border: '#7c3aed', background: 'rgba(124, 58, 237, 0.10)' };
  if (node.kind === 'Expiry') return { border: '#111827', background: 'rgba(15, 23, 42, 0.72)' };
  if (node.risk === 'dangerous') return { border: '#dc2626', background: 'rgba(220, 38, 38, 0.10)' };
  if (node.kind === 'Action' || node.risk === 'mutation') return { border: '#ca8a04', background: 'rgba(202, 138, 4, 0.10)' };
  if (['Permission', 'Assertion', 'Checkride'].includes(node.kind)) return { border: '#16a34a', background: 'rgba(22, 163, 74, 0.10)' };
  return { border: 'rgba(148, 163, 184, 0.62)', background: 'rgba(15, 23, 42, 0.24)' };
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

function Legend({ label, tone }) {
  const color = {
    proof: '#2563eb',
    guardrail: '#7c3aed',
    mutation: '#ca8a04',
    dangerous: '#dc2626',
    expired: '#111827',
  }[tone] || 'rgba(148, 163, 184, 0.62)';
  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      <span className="h-3 w-3 rounded-sm" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}
