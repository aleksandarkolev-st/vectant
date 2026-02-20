'use client';

/**
 * @fileoverview Hook to bridge the ActivityBar with the docking system.
 *
 * Maps ActivityBar button clicks (Explorer, Search, Git, Extensions, etc.)
 * to docking operations: toggle panel visibility, open new tabs,
 * or focus existing ones.
 *
 * Panels are placed in the correct region — sidebar panels go to the
 * sidebar tab group, bottom panels go to the bottom tab group, etc.
 */

import { useCallback, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  openTab,
  closeTabAction,
  activateTabAction,
  setFocusedTabGroup,
  selectAllTabGroups,
  selectTabs,
  selectNodes,
} from '../state/layout-slice';
import { IDE_PANEL } from '../panels/ide-panels';

// ── Panel category classification ──
const SIDEBAR_TYPES = new Set([
  IDE_PANEL.EXPLORER,
  IDE_PANEL.SEARCH,
  IDE_PANEL.GIT,
  IDE_PANEL.EXTENSIONS,
  IDE_PANEL.CHAT,
]);

const BOTTOM_TYPES = new Set([
  IDE_PANEL.TERMINAL,
  IDE_PANEL.PROBLEMS,
  IDE_PANEL.OUTPUT,
]);

/**
 * Determine the category of a panel type.
 */
function panelCategory(panelType) {
  if (SIDEBAR_TYPES.has(panelType)) return 'sidebar';
  if (BOTTOM_TYPES.has(panelType)) return 'bottom';
  return 'editor';
}

/**
 * Find the first tab of a given panel type across all tab groups.
 *
 * @param {Object} nodes  - Flat node map
 * @param {Object} tabs   - Flat tab map
 * @param {string} panelType - e.g. 'explorer'
 * @returns {{ tabId: string, groupId: string } | null}
 */
function findExistingTab(nodes, tabs, panelType) {
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.type !== 'tabgroup') continue;
    for (const tabId of node.tabs || []) {
      const tab = tabs[tabId];
      if (tab && tab.panelType === panelType) {
        return { tabId, groupId: nodeId };
      }
    }
  }
  return null;
}

/**
 * Find the best tab group to place a new panel of a given category.
 *
 * Strategy: look for a group that already contains tabs from the same
 * category (sidebar, bottom, editor). If none found, fall back to the
 * first group available.
 *
 * @param {Object} nodes
 * @param {Object} tabs
 * @param {string} category - 'sidebar' | 'bottom' | 'editor'
 * @returns {string|null} groupId
 */
function findGroupForCategory(nodes, tabs, category) {
  const groups = Object.entries(nodes).filter(([, n]) => n.type === 'tabgroup');

  // Look for a group that already has a tab in the same category
  for (const [groupId, group] of groups) {
    for (const tabId of group.tabs || []) {
      const tab = tabs[tabId];
      if (tab && panelCategory(tab.panelType) === category) {
        return groupId;
      }
    }
  }

  // Fallback: for sidebar use the first group, for bottom use the last, else focused
  if (groups.length > 0) {
    if (category === 'sidebar') return groups[0][0];
    if (category === 'bottom') return groups[groups.length - 1][0];
    return groups[0][0];
  }

  return null;
}

/**
 * Hook that returns action handlers for ActivityBar sidebar buttons.
 *
 * Each handler toggles the corresponding panel: if a tab of that
 * type already exists, it focuses it. Otherwise it opens a new tab
 * in the appropriate region (sidebar, bottom, or editor area).
 *
 * @returns {Object} handlers keyed by panel type
 */
export function useActivityBarDocking() {
  const dispatch = useDispatch();
  const nodes = useSelector(selectNodes);
  const tabs = useSelector(selectTabs);

  /**
   * Toggle a panel.
   * - If it already exists → focus it
   * - If it doesn't exist → open it in the correct region
   */
  const togglePanel = useCallback(
    (panelType, title) => {
      const existing = findExistingTab(nodes, tabs, panelType);

      if (existing) {
        // Focus the group containing this tab
        dispatch(setFocusedTabGroup(existing.groupId));
        // Activate the tab
        dispatch(activateTabAction({ tabId: existing.tabId }));
        return;
      }

      // Find the right tab group for this panel's category
      const category = panelCategory(panelType);
      const targetGroupId = findGroupForCategory(nodes, tabs, category);

      if (targetGroupId) {
        // Dispatch openTab with the payload format the reducer expects
        dispatch(openTab({
          panelType,
          title,
          targetTabGroupId: targetGroupId,
        }));
        dispatch(setFocusedTabGroup(targetGroupId));
      }
    },
    [dispatch, nodes, tabs],
  );

  const handlers = useMemo(
    () => ({
      explorer:   () => togglePanel(IDE_PANEL.EXPLORER, 'Explorer'),
      search:     () => togglePanel(IDE_PANEL.SEARCH, 'Search'),
      git:        () => togglePanel(IDE_PANEL.GIT, 'Source Control'),
      extensions: () => togglePanel(IDE_PANEL.EXTENSIONS, 'Extensions'),
      terminal:   () => togglePanel(IDE_PANEL.TERMINAL, 'Terminal'),
      chat:       () => togglePanel(IDE_PANEL.CHAT, 'AI Chat'),
      problems:   () => togglePanel(IDE_PANEL.PROBLEMS, 'Problems'),
      output:     () => togglePanel(IDE_PANEL.OUTPUT, 'Output'),
      preview:    () => togglePanel(IDE_PANEL.PREVIEW, 'Preview'),
    }),
    [togglePanel],
  );

  return handlers;
}
