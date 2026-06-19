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

const FORCE_MIN_WIDTH = 940;
const FORCE_MIN_HEIGHT = 560;
const FORCE_PADDING = 58;
const FORCE_ITERATIONS = 220;
const STARFIELD_BASE_COUNT = 220;
const STARFIELD_MAX_COUNT = 620;
const STAR_LINK_LIMIT = 960;
const SEMANTIC_PATH_STAR_COUNT = 4;
const OPERATIONAL_STAR_LIMIT_PER_NODE = 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
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
  const [hoveredOperationalStarId, setHoveredOperationalStarId] = useState('');
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
          'radial-gradient(circle at 12% 14%, rgba(30, 41, 59, 0.2), transparent 26%), radial-gradient(circle at 88% 74%, rgba(15, 23, 42, 0.2), transparent 30%), radial-gradient(circle at 64% 18%, rgba(8, 13, 24, 0.34), transparent 36%), color-mix(in srgb, var(--bg-app) 92%, transparent)',
      }}
      data-testid="skill-cortex-graph"
    >
      <div className="relative" style={{ width: layout.width, height: layout.height, minWidth: '100%' }}>
        <div className="sr-only" data-testid="skill-cortex-node-label-index">
          {[
            ...(graph.nodes || []).map((node) => node.label || node.id),
            ...(layout.operationalStars || []).map((star) => star.label),
          ].join(' ')}
        </div>
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
              0%, 100% { transform: scale(1); opacity: 0.84; }
              50% { transform: scale(1.14); opacity: 0.96; }
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
          <g pointerEvents="none" aria-hidden="true">
            {(layout.starLinks || []).map((link) => (
              <line
                key={link.id}
                x1={link.x1}
                y1={link.y1}
                x2={link.x2}
                y2={link.y2}
                stroke={link.color}
                strokeWidth={link.width}
                strokeOpacity={link.opacity}
                strokeLinecap="round"
              />
            ))}
          </g>
          <g pointerEvents="none" aria-hidden="true">
            {(layout.stars || []).map((star) => (
              <circle
                key={star.id}
                cx={star.x}
                cy={star.y}
                r={star.r}
                fill={star.color}
                opacity={star.opacity}
              />
            ))}
          </g>
          <g pointerEvents="none" aria-hidden="true">
            {(layout.operationalLinks || []).map((link) => {
              const selectedParent = selectedNodeId === link.parentId || hoveredNodeId === link.parentId;
              return (
                <line
                  key={link.id}
                  x1={link.x1}
                  y1={link.y1}
                  x2={link.x2}
                  y2={link.y2}
                  stroke={link.color}
                  strokeWidth={selectedParent ? 0.95 : 0.72}
                  strokeOpacity={selectedParent ? 0.13 : 0.055}
                  strokeLinecap="round"
                />
              );
            })}
          </g>
          {(layout.semanticSegments || []).map((segment) => {
            const isActive = segment.fromNodeId === activeNodeId || segment.toNodeId === activeNodeId;
            return (
              <line
                key={segment.id}
                className={isActive ? 'cortex-active-edge' : undefined}
                x1={segment.x1}
                y1={segment.y1}
                x2={segment.x2}
                y2={segment.y2}
                stroke={isActive ? segment.activeColor : segment.color}
                strokeWidth={isActive ? 0.98 : 0.72}
                strokeOpacity={isActive ? 0.42 : segment.opacity}
                strokeLinecap="round"
                style={{ filter: isActive ? `drop-shadow(0 0 4px ${segment.activeColor})` : 'none' }}
              />
            );
          })}
          {(layout.operationalStars || []).map((star) => {
            const tone = operationalStarTone(star);
            const selectedParent = selectedNodeId === star.parentId || hoveredNodeId === star.parentId;
            const hovered = hoveredOperationalStarId === star.id;
            const labelAnchor = star.x > layout.width - 170 ? 'end' : 'start';
            const labelX = labelAnchor === 'end' ? star.x - star.r - 9 : star.x + star.r + 9;
            const labelY = Math.max(16, star.y - 9);
            return (
              <g
                key={star.id}
                onMouseEnter={() => setHoveredOperationalStarId(star.id)}
                onMouseLeave={() => setHoveredOperationalStarId('')}
                data-testid={`cortex-operational-star-${star.id}`}
              >
                <title>{star.label}</title>
                <circle
                  cx={star.x}
                  cy={star.y}
                  r={star.r + (selectedParent || hovered ? 7 : 4)}
                  fill={tone.color}
                  opacity={selectedParent || hovered ? 0.085 : 0.04}
                  style={{ filter: `blur(${selectedParent || hovered ? 6 : 4}px)` }}
                  pointerEvents="none"
                />
                <circle
                  cx={star.x}
                  cy={star.y}
                  r={Math.max(10, star.r + 7)}
                  fill="rgba(255,255,255,0.001)"
                  stroke="transparent"
                  style={{ cursor: 'default' }}
                />
                <circle
                  cx={star.x}
                  cy={star.y}
                  r={star.r}
                  fill={tone.color}
                  opacity={selectedParent || hovered ? 0.84 : 0.56}
                  style={{ filter: `drop-shadow(0 0 ${selectedParent || hovered ? 7 : 4}px ${tone.color})` }}
                  pointerEvents="none"
                />
                {hovered ? (
                  <g pointerEvents="none">
                    <line
                      x1={star.x + (labelAnchor === 'end' ? -star.r - 4 : star.r + 4)}
                      y1={star.y}
                      x2={labelX + (labelAnchor === 'end' ? 5 : -5)}
                      y2={labelY - 4}
                      stroke={tone.color}
                      strokeOpacity="0.28"
                      strokeWidth="1"
                      strokeLinecap="round"
                    />
                    <text
                      x={labelX}
                      y={labelY}
                      textAnchor={labelAnchor}
                      fill="rgba(226, 232, 240, 0.94)"
                      stroke="rgba(6, 9, 16, 0.92)"
                      strokeWidth="4"
                      paintOrder="stroke"
                      fontSize="10.5"
                      fontWeight="650"
                    >
                      {truncateLabel(star.label, 30)}
                    </text>
                  </g>
                ) : null}
              </g>
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
            const showLabel = selected || hovered;
            const label = node.label || node.id;
            const labelAnchor = position.x > layout.width - 180 ? 'end' : 'start';
            const labelX = labelAnchor === 'end' ? position.x - radius - 13 : position.x + radius + 13;
            const labelY = Math.max(16, position.y - 12 - depth * 5);
            return (
              <g
                key={node.id}
                role="button"
                tabIndex={0}
                aria-label={`${node.kind}: ${label}`}
                style={{ outline: 'none' }}
                onMouseEnter={() => setHoveredNodeId(node.id)}
                onMouseLeave={() => setHoveredNodeId('')}
                onFocus={() => setHoveredNodeId(node.id)}
                onBlur={() => setHoveredNodeId('')}
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
                  opacity={selected || hovered ? 0.12 : connected ? 0.085 : 0.045}
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
                  opacity={selected || hovered ? 0.88 : connected ? 0.92 : 0.74}
                  className={selected || hovered ? 'cortex-active-node' : undefined}
                  style={{
                    filter: `drop-shadow(0 0 ${selected || hovered ? 9 : 6}px ${tone.color})`,
                  }}
                />
                {selected || hovered ? (
                  <>
                    <circle
                      cx={position.x}
                      cy={position.y}
                      r={radius + 10}
                      fill={tone.color}
                      opacity="0.045"
                      style={{ filter: `blur(${radius + 1}px)` }}
                    />
                    <circle
                      cx={position.x}
                      cy={position.y}
                      r={radius + 4}
                      fill="none"
                      stroke={tone.color}
                      strokeOpacity="0.44"
                      strokeWidth="1"
                    />
                  </>
                ) : null}
                {showLabel ? (
                  <g pointerEvents="none" opacity={selected || hovered ? 1 : 0.82}>
                    <line
                      x1={position.x + (labelAnchor === 'end' ? -radius - 4 : radius + 4)}
                      y1={position.y}
                      x2={labelX + (labelAnchor === 'end' ? 6 : -6)}
                      y2={labelY - 4}
                      stroke={tone.color}
                      strokeOpacity="0.32"
                      strokeWidth="1"
                      strokeLinecap="round"
                    />
                    <text
                      x={labelX}
                      y={labelY}
                      textAnchor={labelAnchor}
                      fill="rgba(241, 245, 249, 0.94)"
                      stroke="rgba(6, 9, 16, 0.92)"
                      strokeWidth="4"
                      paintOrder="stroke"
                      fontSize="11"
                      fontWeight="650"
                    >
                      {truncateLabel(label, 30)}
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
  if (!nodes.length) {
    return {
      width: FORCE_MIN_WIDTH,
      height: FORCE_MIN_HEIGHT,
      positions: new Map(),
      stars: [],
      starLinks: [],
      semanticSegments: [],
      operationalStars: [],
      operationalLinks: [],
    };
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const layers = new Map(nodes.map((node) => [node.id, 0]));
  const edges = (graph.edges || []).filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const width = Math.max(FORCE_MIN_WIDTH, Math.min(1320, 700 + nodes.length * 62));
  const height = Math.max(FORCE_MIN_HEIGHT, Math.min(760, 500 + Math.ceil(nodes.length / 5) * 48));
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
  const maxLayer = Math.max(1, ...Array.from(layers.values()));
  const orderedNodes = [...nodes].sort((a, b) => {
    const layerDelta = (layers.get(a.id) || 0) - (layers.get(b.id) || 0);
    if (layerDelta !== 0) return layerDelta;
    return nodes.findIndex((node) => node.id === a.id) - nodes.findIndex((node) => node.id === b.id);
  });
  const particles = new Map();
  const orbitLimit = Math.min(width * 0.38, height * 0.42);
  orderedNodes.forEach((node, index) => {
    const seed = stableNodeSeed(`${graph?.graphId || 'graph'}:${node.id}`);
    const layer = layers.get(node.id) || 0;
    const layerBias = (layer / maxLayer - 0.5) * 0.7;
    const normalizedIndex = (index + 0.72) / Math.max(1, orderedNodes.length);
    const orbitRadius = orbitLimit * (0.24 + Math.sqrt(normalizedIndex) * 0.72);
    const angle = -Math.PI / 2 + index * GOLDEN_ANGLE + seed * 0.28 + layerBias;
    const anchorX = clamp(centerX + Math.cos(angle) * orbitRadius * 1.22, FORCE_PADDING, width - FORCE_PADDING);
    const anchorY = clamp(centerY + Math.sin(angle) * orbitRadius * 0.86, FORCE_PADDING, height - FORCE_PADDING);
    particles.set(node.id, {
      id: node.id,
      x: clamp(anchorX + Math.sin(seed * 1.7) * 20, FORCE_PADDING, width - FORCE_PADDING),
      y: clamp(anchorY + Math.cos(seed * 1.3) * 22, FORCE_PADDING, height - FORCE_PADDING),
      vx: 0,
      vy: 0,
      anchorX,
      anchorY,
    });
  });

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
      const targetDistance = 92 + Math.min(54, Math.abs((layers.get(edge.to) || 0) - (layers.get(edge.from) || 0)) * 11);
      const force = (distance - targetDistance) * 0.01;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const particle of particles.values()) {
      particle.vx += (particle.anchorX - particle.x) * 0.024;
      particle.vy += (particle.anchorY - particle.y) * 0.024;
      particle.vx += (centerX - particle.x) * 0.0012;
      particle.vy += (centerY - particle.y) * 0.0012;
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

  const constellation = buildConstellationField({ graph, nodes, positions, width, height });
  const semanticSegments = buildSemanticPathSegments({ graph, nodes, edges, positions, stars: constellation.stars });
  const operations = buildOperationalStars({ graph, nodes, positions, width, height });
  return {
    positions,
    width,
    height,
    stars: constellation.stars,
    starLinks: constellation.starLinks,
    semanticSegments,
    operationalStars: operations.stars,
    operationalLinks: operations.links,
  };
}

function buildSemanticPathSegments({ graph, nodes, edges, positions, stars }) {
  const segments = [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const random = createSeededRandom(`${graph?.graphId || 'skill-cortex'}::semantic-paths`);

  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const targetTone = nodeTone(nodeById.get(edge.to) || {});
    const sourceTone = nodeTone(nodeById.get(edge.from) || {});
    const waypoints = selectPathStars({ from, to, stars, random });
    const points = [from, ...waypoints, to];
    for (let index = 0; index < points.length - 1; index += 1) {
      const a = points[index];
      const b = points[index + 1];
      segments.push({
        id: `${edge.id || `${edge.from}-${edge.to}`}-segment-${index}`,
        fromNodeId: edge.from,
        toNodeId: edge.to,
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        color: index % 2 === 0 ? sourceTone.color : 'rgba(148, 163, 184, 0.54)',
        activeColor: targetTone.color,
        opacity: Math.max(0.08, 0.2 - pointDistance(a, b) / 620),
      });
    }
  }

  return segments;
}

function selectPathStars({ from, to, stars, random }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = Math.max(1, dx * dx + dy * dy);
  const length = Math.sqrt(lengthSquared);
  const candidates = stars
    .map((star) => {
      const t = ((star.x - from.x) * dx + (star.y - from.y) * dy) / lengthSquared;
      if (t <= 0.08 || t >= 0.92) return null;
      const projected = { x: from.x + dx * t, y: from.y + dy * t };
      const perpendicular = pointDistance(star, projected);
      if (perpendicular > Math.max(72, Math.min(132, length * 0.22))) return null;
      return {
        ...star,
        t,
        score: perpendicular + Math.abs(0.5 - t) * 16 + random() * 12,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);

  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= SEMANTIC_PATH_STAR_COUNT) break;
    if (selected.every((star) => Math.abs(star.t - candidate.t) > 0.12 && pointDistance(star, candidate) > 38)) {
      selected.push(candidate);
    }
  }

  const fallbackTargets = [0.22, 0.4, 0.6, 0.78];
  for (const target of fallbackTargets) {
    if (selected.length >= SEMANTIC_PATH_STAR_COUNT) break;
    const ideal = { x: from.x + dx * target, y: from.y + dy * target };
    const fallback = stars
      .map((star) => ({ ...star, t: target, score: pointDistance(star, ideal) + random() * 8 }))
      .filter((star) => selected.every((existing) => pointDistance(existing, star) > 34))
      .sort((a, b) => a.score - b.score)[0];
    if (fallback) selected.push(fallback);
  }

  return selected
    .sort((a, b) => a.t - b.t)
    .map((star) => ({ x: star.x, y: star.y }));
}

function buildOperationalStars({ graph, nodes, positions, width, height }) {
  const seedText = [
    graph?.graphId || 'skill-cortex',
    'operations',
    nodes.map((node) => `${node.id}:${node.kind}:${node.label || ''}`).join('|'),
  ].join('::');
  const random = createSeededRandom(seedText);
  const stars = [];
  const links = [];

  for (const node of nodes) {
    const parent = positions.get(node.id);
    if (!parent) continue;
    const operations = deriveNodeOperations(node).slice(0, OPERATIONAL_STAR_LIMIT_PER_NODE);
    const semanticWeight = isImportantNode(node) ? 1 : 0;
    operations.forEach((operation, index) => {
      const seed = stableNodeSeed(`${seedText}:${node.id}:${operation.type}:${operation.label}:${index}`);
      const radius = 28 + Math.sqrt(index + 1) * 19 + semanticWeight * 8 + random() * 9;
      const angle = seed + index * GOLDEN_ANGLE + random() * 0.24;
      const star = {
        id: sanitizeId(`${node.id}-${operation.type}-${index}`),
        parentId: node.id,
        type: operation.type,
        label: operation.label,
        x: Math.round(clamp(parent.x + Math.cos(angle) * radius * (0.78 + random() * 0.36), 14, width - 14) * 10) / 10,
        y: Math.round(clamp(parent.y + Math.sin(angle) * radius * (0.66 + random() * 0.42), 14, height - 14) * 10) / 10,
        r: Math.round((operationStarRadius(operation, node) + random() * 0.35) * 100) / 100,
      };
      stars.push(star);
      links.push({
        id: `operation-link-${star.id}`,
        parentId: node.id,
        x1: parent.x,
        y1: parent.y,
        x2: star.x,
        y2: star.y,
        color: operationalStarTone(star).color,
      });
    });
  }

  return { stars, links };
}

function deriveNodeOperations(node) {
  const operations = [];
  const seen = new Set();
  const push = (type, label) => {
    const normalized = String(label || '').trim();
    if (!normalized) return;
    const key = `${type}:${normalized.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    operations.push({ type, label: normalized });
  };

  if (node.kind === 'Action') {
    push(node.risk === 'dangerous' ? 'dangerous_action' : 'action', node.action || node.label || 'action');
  }
  if (node.substrate) push('substrate', node.substrate);
  if (node.proofRequired && !arrayCount(node.proofClaims)) push('proof', 'proof required');
  for (const claim of toGraphArray(node.proofClaims)) push('proof', claim);
  for (const guardrail of toGraphArray(node.guardrailRefs)) push('guardrail', guardrail);
  for (const caseRef of toGraphArray(node.caseRefs)) push('case_law', caseRef);
  for (const assertion of toGraphArray(node.assertions)) push('assertion', assertion);
  for (const evidence of toGraphArray(node.evidencePolicy)) push('evidence', evidence);
  for (const output of toGraphArray(node.outputs)) push('output', output);
  for (const expiry of toGraphArray(node.expiryTriggers)) push('expiry', expiry);

  const metadata = node.metadata && typeof node.metadata === 'object' ? node.metadata : {};
  for (const claim of toGraphArray(metadata.evidence_claims)) push('proof', claim);
  for (const effect of toGraphArray(metadata.expected_effects)) push('assertion', effect);
  for (const blockedContext of toGraphArray(metadata.blocked_contexts)) push('guardrail', blockedContext);
  if (metadata.action_kind && node.kind !== 'Action') push('action', metadata.action_kind);
  if (metadata.substrate && !node.substrate) push('substrate', metadata.substrate);

  return operations;
}

function operationStarRadius(operation, node) {
  if (operation.type === 'dangerous_action') return 3.95;
  if (operation.type === 'action') return 3.65;
  if (operation.type === 'guardrail' || operation.type === 'proof') return 3.35;
  if (operation.type === 'assertion') return 3.05;
  if (operation.type === 'evidence' || operation.type === 'output') return node.kind === 'Action' ? 2.85 : 2.6;
  return 2.45;
}

function buildConstellationField({ graph, nodes, positions, width, height }) {
  const seedText = [
    graph?.graphId || 'skill-cortex',
    nodes.map((node) => `${node.id}:${node.kind}:${node.risk || ''}`).join('|'),
    (graph?.edges || []).map((edge) => `${edge.from}>${edge.to}`).join('|'),
  ].join('::');
  const random = createSeededRandom(seedText);
  const targetCount = Math.round(clamp((width * height) / 1450 + nodes.length * 24, STARFIELD_BASE_COUNT, STARFIELD_MAX_COUNT));
  const stars = [];

  const addStar = ({ x, y, r, opacity, color, clusterId = '' }) => {
    stars.push({
      id: `star-${stars.length}`,
      x: Math.round(clamp(x, 10, width - 10) * 10) / 10,
      y: Math.round(clamp(y, 10, height - 10) * 10) / 10,
      r: Math.round(r * 100) / 100,
      opacity: Math.round(opacity * 100) / 100,
      color,
      clusterId,
    });
  };

  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const seed = stableNodeSeed(`${seedText}:${node.id}:cluster`);
    const important = isImportantNode(node);
    const clusterCount = Math.min(42, Math.max(22, Math.round(targetCount / Math.max(6, nodes.length + 5)) + (important ? 12 : 2)));
    for (let index = 0; index < clusterCount && stars.length < targetCount; index += 1) {
      const angle = seed + index * GOLDEN_ANGLE + random() * 0.58;
      const radius = 14 + Math.pow(random(), 0.58) * (important ? 122 : 92);
      const spreadX = 0.76 + random() * 0.72;
      const spreadY = 0.62 + random() * 0.74;
      addStar({
        x: position.x + Math.cos(angle) * radius * spreadX,
        y: position.y + Math.sin(angle) * radius * spreadY,
        r: 0.48 + Math.pow(random(), 1.8) * (important ? 1.55 : 1.18),
        opacity: 0.24 + random() * (important ? 0.58 : 0.46),
        color: starColor(random),
        clusterId: node.id,
      });
    }
  }

  const edgeClusterCount = Math.min(10, Math.max(5, Math.ceil(nodes.length * 0.9)));
  for (let clusterIndex = 0; clusterIndex < edgeClusterCount && stars.length < targetCount; clusterIndex += 1) {
    const anchor = edgeClusterAnchor(random, width, height, clusterIndex);
    const clusterSize = 14 + Math.floor(random() * 14);
    const clusterSeed = stableNodeSeed(`${seedText}:edge-cluster:${clusterIndex}`);
    for (let index = 0; index < clusterSize && stars.length < targetCount; index += 1) {
      const angle = clusterSeed + index * GOLDEN_ANGLE + random() * 0.44;
      const radius = 6 + Math.pow(random(), 0.62) * (56 + random() * 48);
      addStar({
        x: anchor.x + Math.cos(angle) * radius * (0.78 + random() * 0.58),
        y: anchor.y + Math.sin(angle) * radius * (0.72 + random() * 0.52),
        r: 0.34 + Math.pow(random(), 2.4) * 1.02,
        opacity: 0.14 + random() * 0.38,
        color: starColor(random),
        clusterId: `edge-${clusterIndex}`,
      });
    }
  }

  while (stars.length < targetCount) {
    const band = random();
    const distance = Math.pow(random(), 0.78);
    const angle = random() * Math.PI * 2;
    const driftX = Math.cos(angle) * distance * width * (0.18 + band * 0.16);
    const driftY = Math.sin(angle) * distance * height * (0.16 + band * 0.18);
    const edgeBiased = random() < 0.42;
    addStar({
      x: (edgeBiased ? edgeWeightedRandom(random, width) : centerWeightedRandom(random, width)) + driftX,
      y: (edgeBiased ? edgeWeightedRandom(random, height) : centerWeightedRandom(random, height)) + driftY,
      r: 0.38 + Math.pow(random(), 2.1) * 1.08,
      opacity: 0.18 + random() * 0.48,
      color: starColor(random),
      clusterId: '',
    });
  }

  const starLinks = buildStarLinks({ stars, nodes, positions, random });
  return { stars, starLinks };
}

function buildStarLinks({ stars, nodes, positions, random }) {
  const links = [];
  const seen = new Set();

  for (let index = 0; index < stars.length && links.length < STAR_LINK_LIMIT; index += 1) {
    const star = stars[index];
    const nearest = [];
    for (let otherIndex = index + 1; otherIndex < stars.length; otherIndex += 1) {
      const other = stars[otherIndex];
      const sameCluster = star.clusterId && star.clusterId === other.clusterId;
      const threshold = sameCluster ? 74 : 46;
      const distance = pointDistance(star, other);
      if (distance > threshold) continue;
      nearest.push({ other, distance, sameCluster });
    }
    nearest.sort((a, b) => a.distance - b.distance);
    for (const candidate of nearest.slice(0, star.clusterId ? 3 : 1)) {
      if (links.length >= STAR_LINK_LIMIT) break;
      const key = `${star.id}:${candidate.other.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const opacityBase = candidate.sameCluster ? 0.18 : 0.08;
      links.push({
        id: `link-${links.length}`,
        x1: star.x,
        y1: star.y,
        x2: candidate.other.x,
        y2: candidate.other.y,
        color: candidate.sameCluster ? 'rgba(191, 219, 254, 0.72)' : 'rgba(148, 163, 184, 0.52)',
        opacity: Math.round((opacityBase * (1 - candidate.distance / (candidate.sameCluster ? 84 : 58)) + random() * 0.025) * 100) / 100,
        width: candidate.sameCluster ? 0.7 : 0.55,
      });
    }
  }

  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const tone = nodeTone(node);
    const nearby = stars
      .map((star) => ({ star, distance: pointDistance(star, position) }))
      .filter((candidate) => candidate.distance < (isImportantNode(node) ? 94 : 74))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, isImportantNode(node) ? 20 : 12);
    for (const candidate of nearby) {
      if (links.length >= STAR_LINK_LIMIT) break;
      links.push({
        id: `link-${links.length}`,
        x1: candidate.star.x,
        y1: candidate.star.y,
        x2: position.x,
        y2: position.y,
        color: tone.color,
        opacity: Math.round((0.05 + (1 - candidate.distance / 104) * 0.15) * 100) / 100,
        width: 0.65,
      });
    }
  }

  return links;
}

function centerWeightedRandom(random, size) {
  const first = random();
  const second = random();
  return (first + second) * 0.5 * size;
}

function edgeWeightedRandom(random, size) {
  const edge = random() < 0.5 ? 0 : size;
  const inward = Math.pow(random(), 2.2) * size * 0.34;
  return edge === 0 ? inward : size - inward;
}

function edgeClusterAnchor(random, width, height, index) {
  const side = index % 4;
  const marginX = width * (0.06 + random() * 0.08);
  const marginY = height * (0.06 + random() * 0.08);
  if (side === 0) return { x: marginX, y: height * (0.18 + random() * 0.64) };
  if (side === 1) return { x: width * (0.18 + random() * 0.64), y: marginY };
  if (side === 2) return { x: width - marginX, y: height * (0.18 + random() * 0.64) };
  return { x: width * (0.18 + random() * 0.64), y: height - marginY };
}

function pointDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function createSeededRandom(seedText = '') {
  let state = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    state ^= seedText.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function starColor(random) {
  const value = random();
  if (value < 0.34) return 'rgba(226, 232, 240, 0.86)';
  if (value < 0.58) return 'rgba(191, 219, 254, 0.72)';
  if (value < 0.78) return 'rgba(148, 163, 184, 0.66)';
  if (value < 0.92) return 'rgba(203, 213, 225, 0.54)';
  return 'rgba(219, 234, 254, 0.92)';
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

function operationalStarTone(star) {
  if (star.type === 'dangerous_action') return { color: 'oklch(63% 0.18 25)' };
  if (star.type === 'action') return { color: 'oklch(70% 0.15 75)' };
  if (star.type === 'proof') return { color: 'oklch(66% 0.16 248)' };
  if (star.type === 'guardrail' || star.type === 'case_law') return { color: 'oklch(64% 0.13 158)' };
  if (star.type === 'assertion') return { color: 'oklch(66% 0.11 145)' };
  if (star.type === 'evidence' || star.type === 'output') return { color: 'oklch(72% 0.065 226)' };
  if (star.type === 'expiry') return { color: 'oklch(62% 0.035 250)' };
  if (star.type === 'substrate') return { color: 'oklch(68% 0.11 88)' };
  return { color: 'rgba(203, 213, 225, 0.78)' };
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

function toGraphArray(value) {
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null && item !== '');
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function sanitizeId(value = '') {
  return String(value || 'item').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function nodeRadius(node) {
  const signalCount = nodeSignalCount(node);
  if (node.risk === 'dangerous') return 7.2;
  if (node.kind === 'Proof') return 6.7;
  if (node.kind === 'Action' || node.risk === 'mutation') return 6.1;
  if (IMPORTANT_NODE_KINDS.has(node.kind)) return 5.8;
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
