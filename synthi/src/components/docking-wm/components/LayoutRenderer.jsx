/**
 * @fileoverview LayoutRenderer — recursive renderer for the layout tree.
 * Dispatches to SplitContainer or TabGroup based on node type.
 */

'use client';

import React, { useCallback, memo } from 'react';
import { useSelector } from 'react-redux';
import { selectNodes, selectMaximizedNodeId } from '../state/layout-slice';
import { NODE_TYPE } from '../types';
import { SplitContainer } from './SplitContainer';
import { TabGroup } from './TabGroup';

/**
 * Recursively renders the layout tree starting from a given node.
 *
 * @param {Object} props
 * @param {string} props.rootId - the node ID to start rendering from
 */
export const LayoutRenderer = memo(function LayoutRenderer({ rootId }) {
  const nodes = useSelector(selectNodes);
  const maximizedNodeId = useSelector(selectMaximizedNodeId);

  /**
   * Recursive render function passed to SplitContainer.
   * @param {string} nodeId
   * @returns {React.ReactElement}
   */
  const renderNode = useCallback(
    (nodeId) => {
      const node = nodes[nodeId];
      if (!node) {
        return (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--dock-tab-fg, #969696)',
              fontSize: '12px',
            }}
          >
            Node not found
          </div>
        );
      }

      switch (node.type) {
        case NODE_TYPE.SPLIT:
          return <SplitContainer nodeId={nodeId} renderNode={renderNode} />;

        case NODE_TYPE.TAB_GROUP:
          return <TabGroup nodeId={nodeId} />;

        default:
          return null;
      }
    },
    [nodes]
  );

  // If a node is maximized, render only that node
  if (maximizedNodeId && nodes[maximizedNodeId]) {
    return (
      <div
        className="dock-layout-maximized"
        style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
          position: 'absolute',
          inset: 0,
          zIndex: 40,
          backgroundColor: 'var(--dock-panel-bg, #1e1e1e)',
        }}
      >
        {renderNode(maximizedNodeId)}
      </div>
    );
  }

  return (
    <div
      className="dock-layout-root"
      style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {renderNode(rootId)}
    </div>
  );
});

export default LayoutRenderer;
