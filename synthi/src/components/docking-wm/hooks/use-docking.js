/**
 * @fileoverview Core docking context hook.
 * Provides a unified interface to the docking system's state and actions.
 */

'use client';

import { useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectLayout,
  selectRootId,
  selectNodes,
  selectTabs,
  selectFloating,
  selectPopouts,
  selectMaximizedNodeId,
  selectFocusedTabGroupId,
  selectDragSourceTabId,
  selectAllTabGroups,
  selectFloatingWindows,
  selectIsDragging,
  setLayout,
  resetLayout,
  openTab,
  closeTabAction,
  activateTabAction,
  moveTabAction,
  updateTabData,
  splitNodeAction,
  resizeSplitAction,
  toggleMaximizeAction,
  floatTabAction,
  dockFloatAction,
  updateFloatAction,
  bringFloatToFrontAction,
  popoutTabAction,
  dockPopoutAction,
  setDragSource,
  handleDropAction,
  setFocusedTabGroup,
  cleanupLayout,
} from '../state/layout-slice';
import { usePanelRegistry } from '../state/panel-registry';

/**
 * Main docking hook — provides the complete docking API.
 *
 * @returns {Object} Docking API
 */
export function useDocking() {
  const dispatch = useDispatch();
  const layout = useSelector(selectLayout);
  const rootId = useSelector(selectRootId);
  const nodes = useSelector(selectNodes);
  const tabs = useSelector(selectTabs);
  const floating = useSelector(selectFloating);
  const popouts = useSelector(selectPopouts);
  const maximizedNodeId = useSelector(selectMaximizedNodeId);
  const focusedTabGroupId = useSelector(selectFocusedTabGroupId);
  const dragSourceTabId = useSelector(selectDragSourceTabId);
  const allTabGroups = useSelector(selectAllTabGroups);
  const floatingWindows = useSelector(selectFloatingWindows);
  const isDragging = useSelector(selectIsDragging);
  const registry = usePanelRegistry();

  // ── Actions ────────────────────────────────────────

  const actions = useMemo(
    () => ({
      setLayout: (layoutState) => dispatch(setLayout(layoutState)),
      resetLayout: () => dispatch(resetLayout()),

      openTab: (opts) => dispatch(openTab(opts)),
      closeTab: (tabId, removeDefinition) =>
        dispatch(closeTabAction({ tabId, removeDefinition })),
      activateTab: (tabGroupId, tabId) =>
        dispatch(activateTabAction({ tabGroupId, tabId })),
      moveTab: (tabId, targetTabGroupId, targetIndex) =>
        dispatch(moveTabAction({ tabId, targetTabGroupId, targetIndex })),
      updateTab: (tabId, updates) =>
        dispatch(updateTabData({ tabId, updates })),

      splitNode: (targetNodeId, tabId, zone, ratio) =>
        dispatch(splitNodeAction({ targetNodeId, tabId, zone, ratio })),
      resizeSplit: (splitNodeId, splitterIndex, delta) =>
        dispatch(resizeSplitAction({ splitNodeId, splitterIndex, delta })),

      toggleMaximize: (nodeId) =>
        dispatch(toggleMaximizeAction({ nodeId })),

      floatTab: (tabId, rect) =>
        dispatch(floatTabAction({ tabId, ...rect })),
      dockFloat: (floatId, targetTabGroupId, insertIndex) =>
        dispatch(dockFloatAction({ floatId, targetTabGroupId, insertIndex })),
      updateFloat: (floatId, updates) =>
        dispatch(updateFloatAction({ floatId, ...updates })),
      bringFloatToFront: (floatId) =>
        dispatch(bringFloatToFrontAction({ floatId })),

      popoutTab: (tabId, windowName, opts) =>
        dispatch(popoutTabAction({ tabId, windowName, ...opts })),
      dockPopout: (popoutId, targetTabGroupId) =>
        dispatch(dockPopoutAction({ popoutId, targetTabGroupId })),

      setDragSource: (tabId) =>
        dispatch(setDragSource(tabId ? { tabId } : null)),
      handleDrop: (drag, target) =>
        dispatch(handleDropAction({ drag, target })),

      setFocusedTabGroup: (tabGroupId) =>
        dispatch(setFocusedTabGroup({ tabGroupId })),
      cleanup: () => dispatch(cleanupLayout()),
    }),
    [dispatch]
  );

  // ── Queries ────────────────────────────────────────

  const getNode = useCallback((nodeId) => nodes[nodeId], [nodes]);
  const getTab = useCallback((tabId) => tabs[tabId], [tabs]);
  const getTabComponent = useCallback(
    (panelType) => registry.get(panelType)?.component,
    [registry]
  );

  return {
    // State
    layout,
    rootId,
    nodes,
    tabs,
    floating,
    popouts,
    maximizedNodeId,
    focusedTabGroupId,
    dragSourceTabId,
    allTabGroups,
    floatingWindows,
    isDragging,

    // Queries
    getNode,
    getTab,
    getTabComponent,

    // Actions
    ...actions,

    // Registry
    registry,
  };
}

export default useDocking;
