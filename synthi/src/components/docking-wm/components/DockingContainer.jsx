/**
 * @fileoverview DockingContainer — the root visual component of the docking system.
 * Renders the layout tree, floating windows, and handles global drag state.
 */

'use client';

import React, { useCallback, useMemo, memo } from 'react';
import { useSelector } from 'react-redux';
import {
  selectRootId,
  selectFloatingWindows,
  selectDragSourceTabId,
  selectMaximizedNodeId,
} from '../state/layout-slice';
import { LayoutRenderer } from './LayoutRenderer';
import { FloatingWindow } from './FloatingWindow';

/**
 * The root docking container. Place this as the main content area of the IDE.
 *
 * Renders:
 * 1. The recursive layout tree (splits + tab groups)
 * 2. Floating windows as absolute overlays
 * 3. Global drag state indicator
 *
 * @param {Object} props
 * @param {string} [props.className]
 * @param {Object} [props.style]
 */
export const DockingContainer = memo(function DockingContainer({
  className = '',
  style = {},
}) {
  const rootId = useSelector(selectRootId);
  const floatingWindows = useSelector(selectFloatingWindows);
  const dragSourceTabId = useSelector(selectDragSourceTabId);
  const maximizedNodeId = useSelector(selectMaximizedNodeId);

  const isDragging = !!dragSourceTabId;

  return (
    <div
      className={`dock-container ${className} ${isDragging ? 'dock-container--dragging' : ''}`}
      style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        width: '100%',
        ...style,
      }}
    >
      {/* Main layout tree */}
      {rootId && <LayoutRenderer rootId={rootId} />}

      {/* Floating windows layer */}
      {floatingWindows.length > 0 && (
        <div
          className="dock-floating-layer"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 100,
          }}
        >
          {floatingWindows.map((fw) => (
            <div
              key={fw.id}
              style={{ pointerEvents: 'auto' }}
            >
              <FloatingWindow floatingWindow={fw} />
            </div>
          ))}
        </div>
      )}

      {/* Global drag indicator overlay */}
      {isDragging && (
        <div
          className="dock-drag-active-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 99,
            outline: '2px dashed rgba(58, 133, 116, 0.3)',
            outlineOffset: '-2px',
            borderRadius: '2px',
          }}
        />
      )}
    </div>
  );
});

export default DockingContainer;
