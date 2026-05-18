/**
 * @fileoverview TabGroup — leaf node in the layout tree.
 * Combines TabBar + PanelContentArea + DropOverlay.
 * This is the fundamental unit that users interact with.
 */

'use client';

import React, { useCallback, useMemo, memo } from 'react';
import { X } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import {
  closeTabAction,
  selectNode,
  selectNodes,
  selectTabs,
  selectFocusedTabGroupId,
  selectDragSourceTabId,
  setFocusedTabGroup,
} from '../state/layout-slice';
import { useDropZone } from '../hooks/use-drop-zone';
import { useSidebarAutoCollapse } from '../hooks/use-sidebar-auto-collapse';
import { IDE_PANEL } from '../panels/panel-types';
import { TabBar } from './TabBar';
import { PanelContentArea } from './PanelContainer';
import { DropOverlay } from './DropOverlay';

const SIDEBAR_PANEL_TYPES = new Set([
  IDE_PANEL.EXPLORER,
  IDE_PANEL.SEARCH,
  IDE_PANEL.GIT,
  IDE_PANEL.EXTENSIONS,
  IDE_PANEL.EXTENSION_VIEW,
  IDE_PANEL.CHAT,
  IDE_PANEL.SETTINGS,
  IDE_PANEL.PULL_REQUESTS,
  IDE_PANEL.AI_HEALING,
  IDE_PANEL.THEME_EDITOR,
]);

function resolveDockEdge(nodeId, nodes) {
  let currentId = nodeId;
  let edge = null;

  while (currentId) {
    const node = nodes[currentId];
    const parentId = node?.parentId;
    const parent = parentId ? nodes[parentId] : null;

    if (parent?.type === 'split' && parent.direction === 'row') {
      const childIndex = parent.children?.indexOf(currentId) ?? -1;
      if (childIndex === 0) {
        edge = 'left';
      } else if (childIndex === parent.children.length - 1 && edge == null) {
        edge = 'right';
      }
    }

    currentId = parentId;
  }

  return edge;
}

function findEditorGroupId(nodes, allTabs) {
  for (const [groupId, node] of Object.entries(nodes)) {
    if (node?.type !== 'tabgroup') continue;
    if ((node.tabs || []).some((tabId) => allTabs[tabId]?.panelType === IDE_PANEL.EDITOR)) {
      return groupId;
    }
  }
  return null;
}

/**
 * A tab group — the leaf display unit in the layout tree.
 *
 * @param {Object} props
 * @param {string} props.nodeId - the tab group node ID
 */
export const TabGroup = memo(function TabGroup({ nodeId }) {
  const dispatch = useDispatch();
  const node = useSelector((state) => selectNode(state, nodeId));
  const nodes = useSelector(selectNodes);
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

  const isEditorSurface = useMemo(
    () => tabs.length > 0 && tabs.every((tab) => tab?.panelType === 'editor'),
    [tabs],
  );
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === node?.activeTabId) || tabs[0] || null,
    [tabs, node?.activeTabId],
  );
  const sidebarEdge = useMemo(() => resolveDockEdge(nodeId, nodes), [nodeId, nodes]);
  const editorGroupId = useMemo(() => findEditorGroupId(nodes, allTabs), [nodes, allTabs]);

  // Drop zone
  const { dropProps, hoverZone, isOver } = useDropZone({
    nodeId,
  });

  // Auto-collapse for sidebar groups (Phase B).
  // When the mouse leaves a sidebar TabGroup for the configured delay,
  // the group collapses to a thin rail. Hovering re-expands. Width is
  // CSS-driven; the layout slice is left alone so docked widths are
  // restored on hover-back.
  const { isCollapsed, isSidebar, bind: collapseBind } = useSidebarAutoCollapse({
    tabs,
    isFocused,
    activeTabId: node?.activeTabId,
    sidebarEdge,
  });

  const showSoloPaneClose =
    isSidebar &&
    tabs.length === 1 &&
    activeTab &&
    (sidebarEdge === 'left' || sidebarEdge === 'right');

  const handleCloseSoloPane = useCallback((event) => {
    event.stopPropagation();
    event.preventDefault();
    if (!activeTab) return;
    dispatch(closeTabAction({ tabId: activeTab.id, forceClose: true }));
    if (editorGroupId && editorGroupId !== nodeId) {
      dispatch(setFocusedTabGroup(editorGroupId));
    }
  }, [activeTab, dispatch, editorGroupId, nodeId]);

  if (!node || node.type !== 'tabgroup') {
    return null;
  }

  return (
    <div
      {...dropProps}
      {...collapseBind}
      data-drop-node-id={nodeId}
      data-tabgroup-id={nodeId}
      data-sidebar-edge={sidebarEdge || ''}
      data-sidebar-collapsed={isCollapsed ? 'true' : 'false'}
      className={`dock-tab-group ${isFocused ? 'dock-tab-group--focused' : ''} ${
        isOver ? 'dock-tab-group--drag-over' : ''
      } ${isCollapsed ? 'dock-tab-group--collapsed' : ''}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        outline: isFocused && !isEditorSurface
          ? '1px solid var(--dock-focus-border, rgba(0,122,204,0.3))'
          : 'none',
        outlineOffset: '-1px',
        backgroundColor: 'var(--dock-panel-bg, #1e1e1e)',
      }}
    >
      {showSoloPaneClose && (
        <button
          type="button"
          className="dock-tab-group__solo-close"
          onClick={handleCloseSoloPane}
          aria-label={`Close ${activeTab.title || activeTab.panelType}`}
          title={`Close ${activeTab.title || activeTab.panelType}`}
        >
          <X className="w-3 h-3" strokeWidth={2} />
        </button>
      )}

      {/* Tab bar — Phase C:
          - Editor groups: hidden (their file tabs live in the TopNav strip)
          - Sidebar groups with a single panel: hidden (the activity bar IS
            the switcher; the redundant strip just eats vertical space)
          - Sidebar groups with 2+ docked panels: shown so users can switch
            between docked siblings (Explorer + Search + AI Healing etc.) */}
      {tabs.length > 1 && !isEditorSurface && (
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
