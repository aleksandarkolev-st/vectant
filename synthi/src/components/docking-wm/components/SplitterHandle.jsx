/**
 * @fileoverview SplitterHandle — the invisible 4px draggable border between panels.
 * Appears between children of a SplitContainer.
 */

'use client';

import React from 'react';
import { useSplitter, useSplitterKeyboard } from '../hooks/use-splitter';
import { DIRECTION, SPLITTER_SIZE } from '../types';

/**
 * A thin, draggable splitter handle between two panels.
 *
 * Visual states:
 * - Default: 4px transparent hit area, 1px subtle line
 * - Hover: line becomes more visible
 * - Active (dragging): line becomes accent-colored
 *
 * @param {Object} props
 * @param {string} props.splitNodeId
 * @param {number} props.splitterIndex
 * @param {string} props.direction - 'row' | 'column'
 */
export function SplitterHandle({ splitNodeId, splitterIndex, direction }) {
  const { splitterProps, isResizing } = useSplitter({
    splitNodeId,
    splitterIndex,
    direction,
  });

  const { onKeyDown } = useSplitterKeyboard({
    splitNodeId,
    splitterIndex,
    direction,
  });

  const isHorizontal = direction === DIRECTION.ROW;

  return (
    <div
      {...splitterProps}
      onKeyDown={onKeyDown}
      className={`dock-splitter dock-splitter--${isHorizontal ? 'vertical' : 'horizontal'} ${
        isResizing ? 'dock-splitter--active' : ''
      }`}
      style={{
        ...splitterProps.style,
        flexShrink: 0,
        position: 'relative',
        zIndex: 10,
        // Size: 4px in the splitting direction, full in the other
        ...(isHorizontal
          ? { width: `${SPLITTER_SIZE}px`, height: '100%' }
          : { height: `${SPLITTER_SIZE}px`, width: '100%' }),
      }}
    >
      {/* Visible line indicator */}
      <div
        className="dock-splitter__line"
        style={{
          position: 'absolute',
          ...(isHorizontal
            ? {
                left: '50%',
                top: 0,
                bottom: 0,
                width: '1px',
                transform: 'translateX(-50%)',
              }
            : {
                top: '50%',
                left: 0,
                right: 0,
                height: '1px',
                transform: 'translateY(-50%)',
              }),
          backgroundColor: isResizing
            ? 'var(--dock-accent, #007acc)'
            : 'var(--dock-border, #2d2d2d)',
          transition: isResizing ? 'none' : 'background-color 0.15s ease',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

export default SplitterHandle;
