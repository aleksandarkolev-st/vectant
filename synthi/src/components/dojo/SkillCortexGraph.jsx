'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, GitBranch, Layers3, Route, ShieldCheck, Sparkles, Waypoints } from 'lucide-react';
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

const NODE_WIDTH = 204;
const NODE_HEIGHT = 94;
const NODE_HUB_SIZE = 46;
const NODE_SIGNAL_DOT_SIZE = 6;
const LAYER_GAP = 260;
const ROW_GAP = 138;

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
  return (
    <div
      className="max-w-full overflow-auto rounded-lg border"
      style={{
        borderColor: 'var(--border-subtle)',
        background:
          'radial-gradient(circle at 18% 22%, color-mix(in srgb, var(--accent-primary) 13%, transparent), transparent 28%), radial-gradient(circle at 84% 72%, color-mix(in srgb, var(--text-primary) 7%, transparent), transparent 34%), linear-gradient(90deg, color-mix(in srgb, var(--text-primary) 4%, transparent) 1px, transparent 1px), linear-gradient(180deg, color-mix(in srgb, var(--text-primary) 4%, transparent) 1px, transparent 1px), color-mix(in srgb, var(--bg-app) 84%, transparent)',
        backgroundSize: 'auto, auto, 36px 36px, 36px 36px, auto',
      }}
      data-testid="skill-cortex-graph"
    >
      <div className="sticky left-0 top-0 z-[1] flex min-w-full items-center justify-between gap-3 border-b px-4 py-3 backdrop-blur-sm" style={panelStyle}>
        <div className="min-w-0">
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Selected node</div>
          <div className="truncate text-xs font-semibold">{selectedNode?.label || 'None'}</div>
        </div>
        <div className="hidden items-center gap-2 text-[11px] md:flex" style={{ color: 'var(--text-muted)' }}>
          <Sparkles size={13} aria-hidden="true" />
          Proof, guardrail, assertion, and expiry path
        </div>
      </div>
      <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: '100%' }}>
        <svg className="absolute inset-0" width={layout.width} height={layout.height} aria-hidden="true">
          <style>{`
            @keyframes cortex-signal-dash {
              to { stroke-dashoffset: -44; }
            }
            @keyframes cortex-node-breathe {
              0%, 100% { transform: scale(1); opacity: 0.68; }
              50% { transform: scale(1.18); opacity: 1; }
            }
            .cortex-signal-path {
              animation: cortex-signal-dash 2.8s linear infinite;
            }
            .cortex-neuron-pulse {
              animation: cortex-node-breathe 2.6s cubic-bezier(0.16, 1, 0.3, 1) infinite;
              transform-origin: center;
            }
            @media (prefers-reduced-motion: reduce) {
              .cortex-signal-path,
              .cortex-neuron-pulse {
                animation: none;
              }
            }
          `}</style>
          <defs>
            <marker id="cortex-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" fill="rgba(148, 163, 184, 0.74)" />
            </marker>
          </defs>
          {(graph.edges || []).map((edge) => {
            const from = layout.positions.get(edge.from);
            const to = layout.positions.get(edge.to);
            if (!from || !to) return null;
            const source = nodeCenter(from);
            const target = nodeCenter(to);
            const x1 = source.x + NODE_HUB_SIZE / 2;
            const y1 = source.y;
            const x2 = target.x - NODE_HUB_SIZE / 2;
            const y2 = target.y;
            const mid = x1 + Math.max(40, (x2 - x1) / 2);
            return (
              <g key={edge.id}>
                <path
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="rgba(148, 163, 184, 0.28)"
                  strokeWidth="5"
                  strokeLinecap="round"
                />
                <path
                  className="cortex-signal-path"
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="rgba(148, 163, 184, 0.78)"
                  strokeWidth="1.6"
                  strokeDasharray="7 15"
                  strokeLinecap="round"
                  markerEnd="url(#cortex-arrow)"
                />
                <circle cx={x1} cy={y1} r="2.5" fill="rgba(148, 163, 184, 0.9)" />
                <circle cx={x2} cy={y2} r="2.5" fill="rgba(148, 163, 184, 0.9)" />
                {edge.condition ? (
                  <text x={mid} y={Math.min(y1, y2) - 12} textAnchor="middle" fill="rgba(148, 163, 184, 0.82)" fontSize="10">
                    {compactCondition(edge.condition)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {graph.nodes.map((node) => {
          const position = layout.positions.get(node.id);
          if (!position) return null;
          const tone = nodeTone(node);
          const signalDots = signalDotsForNode(node);
          const selected = selectedNodeId === node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelectNode(node.id)}
              className="group absolute rounded-xl text-left transition duration-200 ease-out hover:-translate-y-0.5 active:scale-[0.99]"
              style={{
                left: position.x,
                top: position.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                color: 'var(--text-primary)',
              }}
              data-testid={`cortex-node-${node.id}`}
            >
              <span
                className="absolute left-1/2 top-[35px] rounded-full"
                style={{
                  width: NODE_HUB_SIZE + 28,
                  height: NODE_HUB_SIZE + 28,
                  transform: 'translate(-50%, -50%)',
                  background: selected
                    ? `radial-gradient(circle, ${tone.aura} 0%, transparent 66%)`
                    : `radial-gradient(circle, ${tone.aura} 0%, transparent 62%)`,
                  opacity: selected ? 0.95 : 0.56,
                }}
                aria-hidden="true"
              />
              <span
                className="absolute left-1/2 top-[35px] rounded-full border transition duration-200 group-hover:scale-105"
                style={{
                  width: NODE_HUB_SIZE,
                  height: NODE_HUB_SIZE,
                  transform: 'translate(-50%, -50%)',
                  borderColor: selected ? 'var(--accent-primary)' : tone.border,
                  background: tone.background,
                  boxShadow: selected
                    ? `0 0 0 1px color-mix(in srgb, var(--accent-primary) 68%, transparent), 0 18px 36px -26px ${tone.shadow}, inset 0 1px 0 rgba(255,255,255,0.22)`
                    : `0 16px 30px -28px ${tone.shadow}, inset 0 1px 0 rgba(255,255,255,0.16)`,
                }}
                aria-hidden="true"
              >
                <span
                  className="cortex-neuron-pulse absolute left-1/2 top-1/2 block rounded-full"
                  style={{
                    width: 10,
                    height: 10,
                    transform: 'translate(-50%, -50%)',
                    background: tone.border,
                    boxShadow: `0 0 0 4px ${tone.aura}`,
                  }}
                />
              </span>
              {signalDots.map((dot) => (
                <span
                  key={dot.key}
                  className="absolute rounded-full transition duration-200 group-hover:scale-125"
                  style={{
                    width: NODE_SIGNAL_DOT_SIZE,
                    height: NODE_SIGNAL_DOT_SIZE,
                    left: `calc(50% + ${dot.x}px)`,
                    top: `${35 + dot.y}px`,
                    transform: 'translate(-50%, -50%)',
                    background: dot.primary ? tone.border : 'rgba(148, 163, 184, 0.62)',
                    opacity: dot.opacity,
                    boxShadow: dot.primary ? `0 0 0 3px ${tone.aura}` : 'none',
                  }}
                  aria-hidden="true"
                />
              ))}
              <span className="absolute inset-x-0 bottom-0 rounded-lg border px-3 py-2" style={{
                borderColor: selected ? 'var(--accent-primary)' : 'color-mix(in srgb, var(--border-subtle) 78%, transparent)',
                background: 'color-mix(in srgb, var(--bg-panel) 82%, transparent)',
                boxShadow: selected ? `0 12px 26px -24px ${tone.shadow}` : 'none',
              }}>
                <span className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-normal" style={{ color: tone.text }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: tone.border }} />
                    {node.kind}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {node.risk || 'safe'}
                  </span>
                </span>
                <span className="mt-1 line-clamp-1 block text-xs font-semibold leading-5">{node.label}</span>
                {node.proofRequired || node.proofClaims?.length ? (
                  <span className="mt-0.5 block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>Proof bound</span>
                ) : null}
              </span>
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
  if (node.kind === 'Proof') return { border: 'oklch(58% 0.16 248)', text: 'oklch(82% 0.08 248)', shadow: 'oklch(58% 0.16 248 / 0.55)', aura: 'oklch(58% 0.16 248 / 0.18)', background: 'linear-gradient(180deg, oklch(58% 0.16 248 / 0.22), oklch(21% 0.035 248 / 0.68))' };
  if (['Guardrail', 'CaseLaw', 'Adversary'].includes(node.kind)) return { border: 'oklch(58% 0.12 178)', text: 'oklch(83% 0.08 178)', shadow: 'oklch(58% 0.12 178 / 0.50)', aura: 'oklch(58% 0.12 178 / 0.18)', background: 'linear-gradient(180deg, oklch(58% 0.12 178 / 0.22), oklch(21% 0.03 190 / 0.68))' };
  if (node.kind === 'Expiry') return { border: 'oklch(56% 0.04 250)', text: 'oklch(83% 0.025 250)', shadow: 'oklch(56% 0.04 250 / 0.48)', aura: 'oklch(56% 0.04 250 / 0.16)', background: 'linear-gradient(180deg, oklch(28% 0.035 250 / 0.86), oklch(17% 0.028 250 / 0.76))' };
  if (node.risk === 'dangerous') return { border: 'oklch(57% 0.17 25)', text: 'oklch(82% 0.09 25)', shadow: 'oklch(57% 0.17 25 / 0.50)', aura: 'oklch(57% 0.17 25 / 0.18)', background: 'linear-gradient(180deg, oklch(57% 0.17 25 / 0.22), oklch(21% 0.035 25 / 0.70))' };
  if (node.kind === 'Action' || node.risk === 'mutation') return { border: 'oklch(66% 0.14 75)', text: 'oklch(86% 0.09 75)', shadow: 'oklch(66% 0.14 75 / 0.50)', aura: 'oklch(66% 0.14 75 / 0.18)', background: 'linear-gradient(180deg, oklch(66% 0.14 75 / 0.22), oklch(23% 0.035 75 / 0.68))' };
  if (['Permission', 'Assertion', 'Checkride'].includes(node.kind)) return { border: 'oklch(60% 0.13 145)', text: 'oklch(84% 0.08 145)', shadow: 'oklch(60% 0.13 145 / 0.45)', aura: 'oklch(60% 0.13 145 / 0.16)', background: 'linear-gradient(180deg, oklch(60% 0.13 145 / 0.20), oklch(21% 0.035 145 / 0.64))' };
  return { border: 'rgba(148, 163, 184, 0.66)', text: '#cbd5e1', shadow: 'rgba(148, 163, 184, 0.42)', aura: 'rgba(148, 163, 184, 0.16)', background: 'linear-gradient(180deg, rgba(30, 41, 59, 0.66), rgba(15, 23, 42, 0.46))' };
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

function compactCondition(condition = '') {
  const text = String(condition || '');
  if (text.length <= 24) return text;
  return `${text.slice(0, 21)}...`;
}

function nodeCenter(position) {
  return {
    x: position.x + NODE_WIDTH / 2,
    y: position.y + NODE_HEIGHT / 2 - 12,
  };
}

function arrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
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

function signalDotsForNode(node) {
  const total = nodeSignalCount(node);
  const radius = 34;
  return Array.from({ length: total }, (_, index) => {
    const angle = (-90 + (360 / total) * index) * (Math.PI / 180);
    return {
      key: `${node.id}-signal-${index}`,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      primary: index < Math.max(1, Math.ceil(total / 3)),
      opacity: 0.56 + (index / Math.max(1, total - 1)) * 0.28,
    };
  });
}
