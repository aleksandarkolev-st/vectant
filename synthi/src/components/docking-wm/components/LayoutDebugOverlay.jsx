'use client';

/**
 * @fileoverview Development-only layout debug overlay.
 *
 * Shows the current layout tree structure, node IDs, sizes,
 * and active tab info in a semi-transparent floating panel.
 *
 * Toggle with Ctrl+Shift+D (only renders in development).
 */

import { memo, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { selectLayout } from '../state/layout-slice';
import { NODE_TYPE } from '../types';
import { deepValidateLayout } from '../utils/layout-validation';

function NodeTree({ nodeId, nodes, tabs, depth = 0 }) {
  const node = nodes[nodeId];
  if (!node) {
    return (
      <div style={{ paddingLeft: depth * 16, color: '#f44' }}>
        [missing: {nodeId}]
      </div>
    );
  }

  if (node.type === NODE_TYPE.SPLIT) {
    return (
      <div style={{ paddingLeft: depth * 16 }}>
        <div className="flex items-center gap-1">
          <span style={{ color: '#7cb3f5' }}>
            ▾ Split ({node.direction})
          </span>
          <span style={{ color: '#666', fontSize: 10 }}>{nodeId}</span>
          <span style={{ color: '#888', fontSize: 10 }}>
            [{node.sizes?.map(s => (s * 100).toFixed(0) + '%').join(', ')}]
          </span>
        </div>
        {(node.children || []).map((childId) => (
          <NodeTree
            key={childId}
            nodeId={childId}
            nodes={nodes}
            tabs={tabs}
            depth={depth + 1}
          />
        ))}
      </div>
    );
  }

  if (node.type === NODE_TYPE.TAB_GROUP) {
    return (
      <div style={{ paddingLeft: depth * 16 }}>
        <div className="flex items-center gap-1">
          <span style={{ color: '#5ae4c1' }}>◆ TabGroup</span>
          <span style={{ color: '#666', fontSize: 10 }}>{nodeId}</span>
        </div>
        {(node.tabs || []).map((tabId) => {
          const tab = tabs[tabId];
          const isActive = tabId === node.activeTabId;
          return (
            <div
              key={tabId}
              style={{
                paddingLeft: (depth + 1) * 16,
                color: isActive ? '#fff' : '#888',
                fontWeight: isActive ? 600 : 400,
              }}
            >
              {isActive ? '►' : '○'} {tab?.title || tabId}{' '}
              <span style={{ color: '#555', fontSize: 10 }}>
                ({tab?.panelType || '?'})
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ paddingLeft: depth * 16, color: '#f80' }}>
      [unknown: {node.type}] {nodeId}
    </div>
  );
}

export const LayoutDebugOverlay = memo(function LayoutDebugOverlay() {
  const [visible, setVisible] = useState(false);
  const layout = useSelector(selectLayout);

  // Toggle with Ctrl+Shift+D
  useEffect(() => {
    const handle = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', handle, true);
    return () => window.removeEventListener('keydown', handle, true);
  }, []);

  if (!visible || !layout) return null;

  const validation = deepValidateLayout(layout);
  const nodeCount = Object.keys(layout.nodes || {}).length;
  const tabCount = Object.keys(layout.tabs || {}).length;
  const floatCount = Object.keys(layout.floating || {}).length;
  const popoutCount = Object.keys(layout.popouts || {}).length;

  return (
    <div
      style={{
        position: 'fixed',
        top: 40,
        right: 8,
        width: 360,
        maxHeight: 'calc(100vh - 80px)',
        overflow: 'auto',
        background: 'rgba(10, 10, 14, 0.94)',
        border: '1px solid #333',
        borderRadius: 8,
        padding: '12px 14px',
        fontSize: 11,
        fontFamily: 'JetBrains Mono, Consolas, monospace',
        color: '#ccc',
        zIndex: 100000,
        boxShadow: '0 8px 40px rgba(0,0,0,.6)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <span style={{ fontWeight: 700, color: '#5ae4c1' }}>
          Layout Debug
        </span>
        <button
          onClick={() => setVisible(false)}
          style={{
            background: 'none',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          ✕
        </button>
      </div>

      {/* Stats */}
      <div style={{ color: '#888', marginBottom: 8, fontSize: 10 }}>
        Nodes: {nodeCount} | Tabs: {tabCount} | Floating: {floatCount} | Popouts: {popoutCount}
        {layout.maximizedNodeId && (
          <span style={{ color: '#f0c' }}> | Maximized: {layout.maximizedNodeId}</span>
        )}
      </div>

      {/* Validation */}
      <div style={{ marginBottom: 8 }}>
        {validation.valid ? (
          <span style={{ color: '#5ae4c1' }}>✓ Layout valid</span>
        ) : (
          <span style={{ color: '#f44' }}>✗ {validation.errors.length} error(s)</span>
        )}
        {validation.warnings.length > 0 && (
          <span style={{ color: '#f80', marginLeft: 8 }}>
            ⚠ {validation.warnings.length} warning(s)
          </span>
        )}
      </div>

      {/* Errors */}
      {validation.errors.length > 0 && (
        <div style={{ marginBottom: 8, padding: 6, background: 'rgba(255,0,0,.08)', borderRadius: 4 }}>
          {validation.errors.map((err, i) => (
            <div key={i} style={{ color: '#f88', fontSize: 10 }}>• {err}</div>
          ))}
        </div>
      )}

      {/* Tree */}
      <div style={{ borderTop: '1px solid #222', paddingTop: 8 }}>
        {layout.rootId ? (
          <NodeTree
            nodeId={layout.rootId}
            nodes={layout.nodes || {}}
            tabs={layout.tabs || {}}
          />
        ) : (
          <div style={{ color: '#888' }}>No root node</div>
        )}
      </div>

      {/* Floating windows */}
      {floatCount > 0 && (
        <div style={{ borderTop: '1px solid #222', paddingTop: 8, marginTop: 8 }}>
          <div style={{ color: '#7cb3f5', marginBottom: 4 }}>Floating ({floatCount})</div>
          {Object.entries(layout.floating).map(([id, f]) => (
            <div key={id} style={{ color: '#888', fontSize: 10, paddingLeft: 8 }}>
              {id}: {f.tabId} @ ({f.x}, {f.y}) {f.width}×{f.height}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
