'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, GitBranch, Layers3, Route, ShieldCheck, Waypoints } from 'lucide-react';
import { createEmptyDojoSummary, getDojoWorkspaceSummary } from '@/services/dojoClient';
import CortexNodeInspector from './CortexNodeInspector';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

const elevatedPanelStyle = {
  borderColor: 'color-mix(in srgb, var(--border-subtle) 72%, var(--accent-primary) 28%)',
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-panel) 96%, transparent), color-mix(in srgb, var(--bg-app) 76%, transparent))',
  boxShadow: '0 18px 48px -30px rgba(0, 0, 0, 0.7)',
};

const FORCE_MIN_WIDTH = 760;
const FORCE_MIN_HEIGHT = 390;
const FORCE_PADDING = 64;
const FORCE_ITERATIONS = 180;
const IMPORTANT_NODE_KINDS = new Set(['Proof', 'Guardrail', 'CaseLaw', 'Adversary', 'Expiry']);

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
      className="min-h-screen px-4 py-5 text-sm md:px-8"
      style={{ background: 'var(--bg-app)', color: 'var(--text-primary)' }}
      data-testid="skill-cortex-view"
    >
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-5" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0">
            <a href={backHref} className="mb-3 inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs transition hover:-translate-y-px" style={panelStyle}>
              <ArrowLeft size={13} aria-hidden="true" />
              Dojo
            </a>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{workspaceSlug || 'workspace'}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal md:text-3xl">Skill Cortex</h1>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs" style={elevatedPanelStyle}>
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
              <div className="rounded-lg border p-5" style={elevatedPanelStyle}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-2 inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px]" style={panelStyle}>
                      <Waypoints size={13} aria-hidden="true" />
                      Runtime graph
                    </div>
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
                <div className="mt-5 grid gap-3 sm:grid-cols-4">
                  <Metric label="Nodes" value={graph.nodes.length} />
                  <Metric label="Edges" value={graph.edges?.length || 0} />
                  <Metric label="Validation" value={graph.validation?.ok === false ? 'Warnings' : 'OK'} />
                  <Metric label="Source" value={graph.derived ? 'Derived' : 'Backend'} />
                </div>
              </div>

              <aside className="rounded-lg border p-4" style={elevatedPanelStyle}>
                <div className="mb-3 flex items-center gap-2">
                  <Layers3 size={15} aria-hidden="true" />
                  <h2 className="text-sm font-semibold">Legend</h2>
                </div>
                <div className="grid gap-2">
                  <Legend label="Proof" tone="proof" />
                  <Legend label="Guardrail / Case Law" tone="guardrail" />
                  <Legend label="Mutation Action" tone="mutation" />
                  <Legend label="Dangerous Action" tone="dangerous" />
                  <Legend label="Expired / Recertify" tone="expired" />
                </div>
              </aside>
            </section>

            <section className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(720px,1fr)_390px]">
              <div className="min-w-0 rounded-lg border p-3" style={elevatedPanelStyle}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Route size={15} aria-hidden="true" />
                    <h2 className="text-sm font-semibold">Graph</h2>
                  </div>
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
  const selectedNode = graph?.nodes?.find((node) => node.id === selectedNodeId);
  const [hoveredNodeId, setHoveredNodeId] = useState('');
  const activeNodeId = hoveredNodeId || selectedNodeId;
  const activeNode = graph?.nodes?.find((node) => node.id === activeNodeId) || selectedNode;
  const activeNeighborIds = useMemo(() => {
    if (!activeNodeId) return new Set();
    const neighbors = new Set([activeNodeId]);
    for (const edge of graph?.edges || []) {
      if (edge.from === activeNodeId) neighbors.add(edge.to);
      if (edge.to === activeNodeId) neighbors.add(edge.from);
    }
    return neighbors;
  }, [activeNodeId, graph?.edges]);

  return (
    <div
      className="max-w-full overflow-auto rounded-lg border"
      style={{
        borderColor: 'var(--border-subtle)',
        background:
          'radial-gradient(circle at 22% 18%, color-mix(in srgb, var(--accent-primary) 13%, transparent), transparent 30%), radial-gradient(circle at 76% 68%, color-mix(in srgb, var(--text-primary) 8%, transparent), transparent 34%), radial-gradient(circle at 50% 48%, rgba(15, 23, 42, 0.18), transparent 52%), color-mix(in srgb, var(--bg-app) 88%, transparent)',
      }}
      data-testid="skill-cortex-graph"
    >
      <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: '100%' }}>
        <svg
          className="absolute inset-0"
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label={`Skill Cortex graph${activeNode?.label ? `, active node ${activeNode.label}` : ''}`}
        >
          <style>{`
            @keyframes cortex-active-path {
              0%, 100% { opacity: 0.36; }
              50% { opacity: 0.86; }
            }
            @keyframes cortex-particle-pulse {
              0%, 100% { transform: scale(1); opacity: 0.82; }
              50% { transform: scale(1.35); opacity: 1; }
            }
            .cortex-active-edge {
              animation: cortex-active-path 2.2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
            }
            .cortex-active-node {
              animation: cortex-particle-pulse 2.4s cubic-bezier(0.16, 1, 0.3, 1) infinite;
              transform-box: fill-box;
              transform-origin: center;
            }
            @media (prefers-reduced-motion: reduce) {
              .cortex-active-edge,
              .cortex-active-node {
                animation: none;
              }
            }
          `}</style>
          <defs>
            <radialGradient id="cortex-field-fade" cx="50%" cy="50%" r="62%">
              <stop offset="0%" stopColor="rgba(148, 163, 184, 0.13)" />
              <stop offset="62%" stopColor="rgba(148, 163, 184, 0.035)" />
              <stop offset="100%" stopColor="rgba(148, 163, 184, 0)" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width={layout.width} height={layout.height} fill="url(#cortex-field-fade)" opacity="0.7" pointerEvents="none" />
          {(graph.edges || []).map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const sourceTone = nodeTone(graph.nodes.find((node) => node.id === edge.from) || {});
            const targetTone = nodeTone(graph.nodes.find((node) => node.id === edge.to) || {});
            const isActive = edge.from === activeNodeId || edge.to === activeNodeId;
            return (
              <line
                key={edge.id}
                className={isActive ? 'cortex-active-edge' : undefined}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={isActive ? targetTone.color : 'rgba(148, 163, 184, 0.52)'}
                strokeWidth={isActive ? 1.15 : 1}
                strokeOpacity={isActive ? 0.72 : 0.22}
                strokeLinecap="round"
                style={{ filter: isActive ? `drop-shadow(0 0 6px ${sourceTone.color})` : 'none' }}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const position = layout.positions.get(node.id);
            if (!position) return null;
            const tone = nodeTone(node);
            const selected = selectedNodeId === node.id;
            const hovered = hoveredNodeId === node.id;
            const connected = activeNeighborIds.has(node.id);
            const radius = nodeRadius(node);
            const depth = nodeDepth(node, graph.nodes);
            const showLabel = selected || hovered || isImportantNode(node);
            const label = node.label || node.id;
            const labelWidth = Math.min(210, Math.max(72, label.length * 6.4 + 28));
            const labelX = Math.min(Math.max(10, position.x + radius + 10), layout.width - labelWidth - 10);
            const labelY = Math.max(14, position.y - 25 - depth * 8);
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`${node.kind}: ${label}`}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId('')}
                onClick={() => onSelectNode(node.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectNode(node.id);
                  }
                }}
              >
                <title>{label}</title>
                <circle
                  cx={position.x + 1.2 * depth}
                  cy={position.y + 1.6 * depth}
                  r={radius + 5 + depth}
                  fill={tone.color}
                  opacity={selected || hovered ? 0.18 : connected ? 0.11 : 0.055}
                  style={{ filter: `blur(${Math.max(3, radius)}px)` }}
                />
                <circle
                  cx={position.x}
                  cy={position.y}
                  r={Math.max(16, radius + 11)}
                  fill="rgba(255,255,255,0.001)"
                  stroke="transparent"
                  style={{ cursor: 'pointer' }}
                  data-testid={`cortex-node-${node.id}`}
                  aria-label={`${node.kind}: ${label}`}
                />
                <circle
                  cx={position.x}
                  cy={position.y}
                  r={radius}
                  fill={tone.color}
                  opacity={connected ? 1 : 0.78}
                  className={selected || hovered ? 'cortex-active-node' : undefined}
                  style={{
                    filter: `drop-shadow(0 0 ${selected || hovered ? 13 : 8}px ${tone.color})`,
                  }}
                />
                {selected || hovered ? (
                  <circle
                    cx={position.x}
                    cy={position.y}
                    r={radius + 6}
                    fill="none"
                    stroke={tone.color}
                    strokeOpacity="0.52"
                    strokeWidth="1"
                  />
                ) : null}
                {showLabel ? (
                  <g pointerEvents="none">
                    <rect
                      x={labelX}
                      y={labelY}
                      width={labelWidth}
                      height="24"
                      rx="12"
                      fill="rgba(7, 10, 18, 0.84)"
                      stroke={tone.color}
                      strokeOpacity={selected || hovered ? 0.64 : 0.28}
                    />
                    <circle cx={labelX + 12} cy={labelY + 12} r="2.3" fill={tone.color} />
                    <text x={labelX + 21} y={labelY + 15.5} fill="rgba(241, 245, 249, 0.92)" fontSize="10.5" fontWeight="600">
                      {truncateLabel(label, selected || hovered ? 28 : 22)}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })}
          {activeNode ? (
            <g pointerEvents="none">
              <text x="18" y={layout.height - 36} fill="rgba(148, 163, 184, 0.78)" fontSize="10">
                Selected node
              </text>
              <text x="18" y={layout.height - 18} fill="rgba(241, 245, 249, 0.94)" fontSize="12" fontWeight="700">
                {truncateLabel(activeNode.label || activeNode.id, 52)}
              </text>
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
}

function computeGraphLayout(graph) {
  const nodes = graph?.nodes || [];
  if (!nodes.length) return { width: FORCE_MIN_WIDTH, height: FORCE_MIN_HEIGHT, positions: new Map() };
  const nodeIds = new Set(nodes.map((node) => node.id));
  const layers = new Map(nodes.map((node) => [node.id, 0]));
  const edges = (graph.edges || []).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const width = Math.max(FORCE_MIN_WIDTH, Math.min(1180, 520 + nodes.length * 78));
  const height = Math.max(FORCE_MIN_HEIGHT, Math.min(640, 330 + Math.ceil(nodes.length / 4) * 64));
  const centerX = width / 2;
  const centerY = height / 2;

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

  const maxLayer = Math.max(1, ...Array.from(grouped.keys()));
  const particles = new Map();
  for (const [layer, list] of grouped.entries()) {
    list.forEach((node, row) => {
      const rowCenter = (list.length - 1) / 2;
      const seed = stableNodeSeed(node.id);
      const layerRatio = maxLayer === 0 ? 0.5 : layer / maxLayer;
      const anchorX = FORCE_PADDING + layerRatio * (width - FORCE_PADDING * 2);
      const anchorY = centerY + (row - rowCenter) * Math.min(92, height / Math.max(4, list.length + 1));
      particles.set(node.id, {
        id: node.id,
        x: clamp(anchorX + Math.sin(seed) * 34, FORCE_PADDING, width - FORCE_PADDING),
        y: clamp(anchorY + Math.cos(seed * 1.7) * 38, FORCE_PADDING, height - FORCE_PADDING),
        vx: 0,
        vy: 0,
        anchorX,
        anchorY: clamp(anchorY, FORCE_PADDING, height - FORCE_PADDING),
      });
    });
  }

  for (let step = 0; step < FORCE_ITERATIONS; step += 1) {
    const particleList = Array.from(particles.values());
    for (let i = 0; i < particleList.length; i += 1) {
      for (let j = i + 1; j < particleList.length; j += 1) {
        const a = particleList[i];
        const b = particleList[j];
        const dx = b.x - a.x || 0.01;
        const dy = b.y - a.y || 0.01;
        const distanceSquared = Math.max(64, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        const force = 1450 / distanceSquared;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    for (const edge of edges) {
      const a = particles.get(edge.from);
      const b = particles.get(edge.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const targetDistance = 118 + Math.min(42, Math.abs((layers.get(edge.to) || 0) - (layers.get(edge.from) || 0)) * 8);
      const force = (distance - targetDistance) * 0.012;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const particle of particles.values()) {
      particle.vx += (particle.anchorX - particle.x) * 0.018;
      particle.vy += (particle.anchorY - particle.y) * 0.018;
      particle.vx += (centerX - particle.x) * 0.0016;
      particle.vy += (centerY - particle.y) * 0.0016;
      particle.vx *= 0.72;
      particle.vy *= 0.72;
      particle.x = clamp(particle.x + particle.vx, FORCE_PADDING, width - FORCE_PADDING);
      particle.y = clamp(particle.y + particle.vy, FORCE_PADDING, height - FORCE_PADDING);
    }
  }

  const positions = new Map();
  for (const particle of particles.values()) {
    positions.set(particle.id, {
      x: Math.round(particle.x * 10) / 10,
      y: Math.round(particle.y * 10) / 10,
    });
  }

  return {
    positions,
    width,
    height,
  };
}

function stableNodeSeed(value = '') {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % 1000003;
  }
  return (hash / 1000003) * Math.PI * 2;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nodeTone(node) {
  if (node.kind === 'Proof') return { color: 'oklch(63% 0.15 248)', text: 'oklch(84% 0.08 248)' };
  if (['Guardrail', 'CaseLaw', 'Adversary'].includes(node.kind)) return { color: 'oklch(62% 0.12 164)', text: 'oklch(84% 0.08 164)' };
  if (node.kind === 'Expiry') return { color: 'oklch(62% 0.035 250)', text: 'oklch(84% 0.025 250)' };
  if (node.risk === 'dangerous') return { color: 'oklch(62% 0.17 25)', text: 'oklch(84% 0.09 25)' };
  if (node.kind === 'Action' || node.risk === 'mutation') return { color: 'oklch(69% 0.14 75)', text: 'oklch(87% 0.09 75)' };
  if (['Permission', 'Assertion', 'Checkride'].includes(node.kind)) return { color: 'oklch(63% 0.12 145)', text: 'oklch(84% 0.08 145)' };
  return { color: 'rgba(148, 163, 184, 0.76)', text: '#cbd5e1' };
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg border px-3 py-3" style={panelStyle}>
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
    proof: 'oklch(58% 0.16 248)',
    guardrail: 'oklch(58% 0.12 178)',
    mutation: 'oklch(66% 0.14 75)',
    dangerous: 'oklch(57% 0.17 25)',
    expired: 'oklch(56% 0.04 250)',
  }[tone] || 'rgba(148, 163, 184, 0.62)';
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs" style={{ background: 'color-mix(in srgb, var(--text-primary) 4%, transparent)' }}>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      <span>{label}</span>
    </div>
  );
}

function arrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function nodeRadius(node) {
  const signalCount = nodeSignalCount(node);
  if (node.risk === 'dangerous') return 8;
  if (node.kind === 'Proof') return 7;
  if (node.kind === 'Action' || node.risk === 'mutation') return 6.5;
  if (IMPORTANT_NODE_KINDS.has(node.kind)) return 6;
  return Math.min(5.8, Math.max(3, 3 + Math.log2(signalCount) * 0.85));
}

function nodeDepth(node, nodes) {
  const index = Math.max(0, nodes.findIndex((candidate) => candidate.id === node.id));
  const semanticWeight = node.risk === 'dangerous' || node.kind === 'Proof' ? 2 : IMPORTANT_NODE_KINDS.has(node.kind) ? 1 : 0;
  return (index % 5) * 0.25 + semanticWeight;
}

function isImportantNode(node) {
  return node.risk === 'dangerous'
    || node.risk === 'mutation'
    || node.kind === 'Action'
    || node.proofRequired
    || arrayCount(node.proofClaims) > 0
    || IMPORTANT_NODE_KINDS.has(node.kind);
}

function truncateLabel(label = '', max = 24) {
  const text = String(label || '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function nodeSignalCount(node) {
  const metadata = node.metadata && typeof node.metadata === 'object' ? node.metadata : {};
  const count = 2
    + arrayCount(node.inputs)
    + arrayCount(node.outputs)
    + arrayCount(node.guardrails)
    + arrayCount(node.guardrailRefs)
    + arrayCount(node.caseLawRefs)
    + arrayCount(node.caseRefs)
    + arrayCount(node.assertions)
    + arrayCount(node.evidencePolicy)
    + arrayCount(node.expiryTriggers)
    + arrayCount(node.proofClaims)
    + arrayCount(node.proof?.requiredClaims)
    + arrayCount(metadata.evidence_claims)
    + arrayCount(metadata.expected_effects);
  return Math.min(8, Math.max(3, count));
}
