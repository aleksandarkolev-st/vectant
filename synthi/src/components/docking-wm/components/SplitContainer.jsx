/**
 * @fileoverview SplitContainer — renders a row or column of children with splitters.
 * Corresponds to a SplitNode in the layout tree.
 */

'use client';

import React, { memo } from 'react';
import { useSelector } from 'react-redux';
import { selectNode } from '../state/layout-slice';
import { SplitterHandle } from './SplitterHandle';
import { DIRECTION, SPLITTER_SIZE } from '../types';

/**
 * Split container — renders children side-by-side (row) or stacked (column)
 * with draggable splitters between them.
 *
 * @param {Object} props
 * @param {string} props.nodeId - the split node ID
 * @param {function} props.renderNode - recursive render function
 */
export const SplitContainer = memo(function SplitContainer({ nodeId, renderNode }) {
  const node = useSelector((state) => selectNode(state, nodeId));

  if (!node || node.type !== 'split') {
    return null;
  }

  const { direction, children, sizes } = node;
  const isRow = direction === DIRECTION.ROW;

  // Calculate total splitter space
  const splitterCount = Math.max(0, children.length - 1);
  const totalSplitterSize = splitterCount * SPLITTER_SIZE;

  return (
    <div
      data-split-node-id={nodeId}
      className={`dock-split dock-split--${direction}`}
      style={{
        display: 'flex',
        flexDirection: isRow ? 'row' : 'column',
        flex: 1,
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      {children.map((childId, index) => {
        const size = sizes[index] || 1 / children.length;

        return (
          <React.Fragment key={childId}>
            {/* Child panel with calculated flex size */}
            <div
              data-layout-child={childId}
              style={{
                // Use calc to account for splitter space
                flex: `0 0 calc(${size * 100}% - ${(totalSplitterSize * size)}px)`,
                overflow: 'hidden',
                minWidth: 0,
                minHeight: 0,
                display: 'flex',
              }}
            >
              {renderNode(childId)}
            </div>

            {/* Splitter between children */}
            {index < children.length - 1 && (
              <SplitterHandle
                splitNodeId={nodeId}
                splitterIndex={index}
                direction={direction}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
});

export default SplitContainer;
