'use client';
import React, { useState, useRef, useCallback } from 'react';
import { GRAPH_COLORS } from './gitUtils';

/**
 * Shared SourceTree-style commit graph column that renders:
 *  • Continuous vertical lane rails (backbone lines)
 *  • Smooth Bézier merge/close curves connecting parent → child
 *  • Commit nodes (solid for regular, hollow ring for merges)
 *  • Fork paths for new branch starts
 *
 * Used by BOTH the Source Control Panel and the Commit History Window.
 *
 * @param {Object}  graphNode   - Node from buildCommitGraph()
 * @param {number}  rowHeight   - Height of one commit row (default 36)
 * @param {number}  totalLanes  - Max lane count across the full graph
 * @param {Object}  [commitData] - Optional commit data for tooltip { message, author_name, date, hash }
 * @param {Object}  [refsMap]   - Optional refs map for branch labels on tooltip
 * @param {Array}   [allGraphNodes] - All graph nodes (for fork detection)
 * @param {number}  [nodeIndex] - Index of this node in allGraphNodes
 */
export default function CommitGraphColumn({
  graphNode,
  rowHeight = 36,
  totalLanes,
  commitData,
  refsMap,
  allGraphNodes,
  nodeIndex,
}) {
  const [tooltip, setTooltip] = useState(null);
  const svgRef = useRef(null);

  if (!graphNode) return <div style={{ width: 20 }} />;

  const cols = Math.max(totalLanes || 1, graphNode.laneCount || 1);
  const colW = 14;
  const width = cols * colW + 6;
  const cx = graphNode.col * colW + colW / 2 + 3;
  const cy = rowHeight / 2;
  const r = graphNode.isMerge ? 5 : 3.5;

  // Resolve lane color: always use the lane's assigned color from buildCommitGraph
  const getLaneColor = (laneIdx) => {
    return graphNode.activeLaneColors?.[laneIdx] || GRAPH_COLORS[laneIdx % GRAPH_COLORS.length];
  };

  // Detect fork paths: if next row's activeLanes has a new lane that starts from this col
  const forkPaths = [];
  if (allGraphNodes && nodeIndex != null && nodeIndex + 1 < allGraphNodes.length) {
    const nextNode = allGraphNodes[nodeIndex + 1];
    if (nextNode) {
      // Check if a lane in the next row is new (not present in current row's activeLanes)
      nextNode.activeLanes.forEach((lane, idx) => {
        if (lane === null) return;
        // If this lane wasn't active in current row, it's a fork
        const currentLane = graphNode.activeLanes[idx];
        if (currentLane === undefined || currentLane === null) {
          // This is a new lane appearing — check if it forks from current commit
          if (nextNode.col !== idx) {
            forkPaths.push({
              fromX: nextNode.col * colW + colW / 2 + 3,
              toX: idx * colW + colW / 2 + 3,
              color: nextNode.activeLaneColors?.[idx] || GRAPH_COLORS[idx % GRAPH_COLORS.length],
            });
          }
        }
      });
    }
  }

  // Build tooltip content
  const buildTooltip = useCallback((e) => {
    if (!commitData) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;

    const refs = refsMap?.[commitData.hash?.substring(0, 7)] || [];
    const branchRefs = refs.filter(r => r.type === 'branch' || r.type === 'head');
    const tagRefs = refs.filter(r => r.type === 'tag');

    let connectionContext = '';
    if (graphNode.isMerge) {
      connectionContext = 'Merge commit';
    } else if (graphNode.closingLanes?.length > 0) {
      connectionContext = 'Branch merge point';
    } else if (graphNode.mergeFromCols?.length > 0) {
      connectionContext = 'Merge from parent branch';
    }
    if (branchRefs.length > 0) {
      const names = branchRefs.map(r => r.name).join(', ');
      if (graphNode.col === 0 && !connectionContext) {
        connectionContext = `Branch: ${names}`;
      } else if (!connectionContext) {
        connectionContext = `Branch '${names}'`;
      }
    }

    setTooltip({
      x: e.clientX,
      y: e.clientY,
      commit: commitData,
      branches: branchRefs,
      tags: tagRefs,
      connection: connectionContext,
    });
  }, [commitData, refsMap, graphNode]);

  const hideTooltip = useCallback(() => setTooltip(null), []);

  return (
    <div className="relative flex-shrink-0" style={{ width, minWidth: width }}>
      <svg
        ref={svgRef}
        width={width}
        height={rowHeight}
        className="flex-shrink-0"
        style={{ minWidth: width }}
        onMouseEnter={buildTooltip}
        onMouseMove={buildTooltip}
        onMouseLeave={hideTooltip}
      >
        {/* Active lane rails — continuous vertical lines through this row */}
        {graphNode.activeLanes.map((lane, idx) => {
          if (lane === null) return null;
          const x = idx * colW + colW / 2 + 3;
          const laneColor = getLaneColor(idx);
          return (
            <line
              key={`lane-${idx}`}
              x1={x} y1={0} x2={x} y2={rowHeight}
              stroke={laneColor}
              strokeWidth={1.5}
              opacity={0.35}
            />
          );
        })}

        {/* Current commit's own vertical rail (above and below node) — continuous backbone */}
        <line
          x1={cx} y1={0} x2={cx} y2={cy - r - 1}
          stroke={graphNode.color}
          strokeWidth={1.5}
          opacity={0.6}
        />
        <line
          x1={cx} y1={cy + r + 1} x2={cx} y2={rowHeight}
          stroke={graphNode.color}
          strokeWidth={1.5}
          opacity={0.6}
        />

        {/* Merge curves — smooth cubic Bézier from parent lane into this commit's node */}
        {graphNode.mergeFromCols.map((mc, i) => {
          const mx = mc * colW + colW / 2 + 3;
          // Continuous Bézier: starts at top of the merge lane, curves smoothly into node
          const d = `M ${mx} 0 C ${mx} ${cy * 0.55}, ${cx} ${cy * 0.45}, ${cx} ${cy}`;
          const mergeColor = getLaneColor(mc);
          return (
            <path
              key={`merge-${i}`}
              d={d}
              fill="none"
              stroke={mergeColor}
              strokeWidth={1.5}
              opacity={0.55}
            />
          );
        })}

        {/* Closing lanes — branches merging back into this commit's lane */}
        {(graphNode.closingLanes || []).map((cl, i) => {
          const clx = cl * colW + colW / 2 + 3;
          const d = `M ${clx} 0 C ${clx} ${cy * 0.55}, ${cx} ${cy * 0.45}, ${cx} ${cy}`;
          const closeColor = getLaneColor(cl);
          return (
            <path
              key={`close-${i}`}
              d={d}
              fill="none"
              stroke={closeColor}
              strokeWidth={1.5}
              opacity={0.45}
            />
          );
        })}

        {/* Fork paths — new branches starting from this node going down into next row's lane */}
        {forkPaths.map((fp, i) => {
          const d = `M ${fp.fromX} ${cy} C ${fp.fromX} ${cy + (rowHeight - cy) * 0.55}, ${fp.toX} ${cy + (rowHeight - cy) * 0.45}, ${fp.toX} ${rowHeight}`;
          return (
            <path
              key={`fork-${i}`}
              d={d}
              fill="none"
              stroke={fp.color}
              strokeWidth={1.5}
              opacity={0.45}
            />
          );
        })}

        {/* Commit node — merge nodes: larger hollow ring; regular: solid dot */}
        {graphNode.isMerge ? (
          <>
            <circle
              cx={cx} cy={cy} r={r + 1}
              fill="#0a0a0b"
              stroke={graphNode.color}
              strokeWidth={2}
            />
            <circle cx={cx} cy={cy} r={2} fill={graphNode.color} />
          </>
        ) : (
          <circle cx={cx} cy={cy} r={r} fill={graphNode.color} />
        )}
      </svg>

      {/* Interactive Tooltip */}
      {tooltip && (
        <div
          className="fixed z-[9999] pointer-events-none"
          style={{ left: tooltip.x + 12, top: tooltip.y - 8 }}
        >
          <div className="bg-[#1c1c1e] border border-[#3f3f46] rounded-lg shadow-xl px-3 py-2 min-w-[200px] max-w-[320px]">
            {/* Branch badges */}
            {tooltip.branches.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {tooltip.branches.map((ref, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded font-semibold inline-flex items-center gap-1"
                    style={{
                      backgroundColor: `${graphNode.color}22`,
                      color: graphNode.color,
                      border: `1px solid ${graphNode.color}44`,
                    }}
                  >
                    ⎇ {ref.name}
                  </span>
                ))}
              </div>
            )}
            {/* Tag badges */}
            {tooltip.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {tooltip.tags.map((ref, i) => (
                  <span
                    key={i}
                    className="text-[10px] px-1.5 py-0.5 rounded font-semibold text-amber-400 border border-amber-500/30 bg-amber-500/10"
                  >
                    🏷 {ref.name}
                  </span>
                ))}
              </div>
            )}
            {/* Commit info */}
            <div className="text-[11px] text-[#e4e4e7] font-medium truncate">
              {tooltip.commit.message}
            </div>
            <div className="flex items-center gap-2 mt-1 text-[10px] text-[#71717a]">
              <span>{tooltip.commit.author_name}</span>
              <span>·</span>
              <span>{tooltip.commit.date ? new Date(tooltip.commit.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}</span>
            </div>
            <code className="text-[9px] text-[#52525b] font-mono block mt-0.5">
              {tooltip.commit.hash?.substring(0, 10)}
            </code>
            {/* Connection context */}
            {tooltip.connection && (
              <div className="text-[10px] text-[#a1a1aa] mt-1 pt-1 border-t border-[#27272a] italic">
                {tooltip.connection}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
