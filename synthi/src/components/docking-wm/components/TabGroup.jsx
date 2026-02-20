/**
 * @fileoverview TabGroup — leaf node in the layout tree.
 * Combines TabBar + PanelContentArea + DropOverlay.
 * This is the fundamental unit that users interact with.
 */

'use client';

import React, { useCallback, useMemo, memo } from 'react';
import { useSelector } from 'react-redux';
import { selectNode, selectTabs, selectFocusedTabGroupId, selectDragSourceTabId } from '../state/layout-slice';
import { useDropZone } from '../hooks/use-drop-zone';
import { TabBar } from './TabBar';
import { PanelContentArea } from './PanelContainer';
import { DropOverlay } from './DropOverlay';

/**
 * A tab group — the leaf display unit in the layout tree.
 *
 * @param {Object} props
 * @param {string} props.nodeId - the tab group node ID
 */
export const TabGroup = memo(function TabGroup({ nodeId }) {
  const node = useSelector((state) => selectNode(state, nodeId));
  const allTabs = useSelector(selectTabs);
  const focusedGroupId = useSelector(selectFocusedTabGroupId);
  const dragSourceTabId = useSelector(selectDragSourceTabId);

  const isFocused = focusedGroupId === nodeId;
  const isDraggingFromHere = dragSourceTabId
    ? node?.tabs?.includes(dragSourceTabId)
    : false;

  // Resolve tab objects
  const tabs = useMemo(() => {
    if (!node || !node.tabs) return [];
    return node.tabs.map((tid) => allTabs[tid]).filter(Boolean);
  }, [node, allTabs]);

  // Drop zone
  const { dropProps, hoverZone, isOver } = useDropZone({
    nodeId,
    disabled: false,
  });

  if (!node || node.type !== 'tabgroup') {
    return null;
  }

  return (
    <div
      {...dropProps}
      data-drop-node-id={nodeId}
      data-tab-group-id={nodeId}
      className={`dock-tab-group ${isFocused ? 'dock-tab-group--focused' : ''} ${
        isOver ? 'dock-tab-group--drag-over' : ''
      }`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        outline: isFocused
          ? '1px solid var(--dock-focus-border, rgba(0,122,204,0.3))'
          : 'none',
        outlineOffset: '-1px',
        backgroundColor: 'var(--dock-panel-bg, #1e1e1e)',
      }}
    >
      {/* Tab bar */}
      {tabs.length > 0 && (
        <TabBar
          tabGroupId={nodeId}
          tabs={tabs}
          activeTabId={node.activeTabId}
          isFocused={isFocused}
        />
      )}

      {/* Panel content */}
      <PanelContentArea
        tabs={tabs}
        activeTabId={node.activeTabId}
        tabGroupId={nodeId}
      />

      {/* Empty state */}
      {tabs.length === 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1,
            color: 'var(--dock-tab-fg, #969696)',
            fontSize: '13px',
            opacity: 0.5,
          }}
        >
          Drop a panel here
        </div>
      )}

      {/* Drop overlay */}
      <DropOverlay zone={hoverZone} visible={isOver} />
    </div>
  );
});

export default TabGroup;
