'use client';

/**
 * @fileoverview Hook to bridge the ActivityBar with the docking system.
 *
 * Maps ActivityBar button clicks (Explorer, Search, Git, Extensions, etc.)
 * to docking operations: toggle panel visibility, open new tabs,
 * or focus existing ones.
 */

import { useCallback, useMemo } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  openTab,
  closeTabAction,
  setFocusedTabGroup,
  selectAllTabGroups,
  selectTabs,
  selectNodes,
} from '../state/layout-slice';
import { createTab } from '../utils/layout-node';
import { IDE_PANEL } from '../panels/ide-panels';

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
 * Hook that returns action handlers for ActivityBar sidebar buttons.
 *
 * Each handler toggles the corresponding panel: if a tab of that
 * type already exists, it either focuses it or closes it. Otherwise
 * it opens a new tab in the first available tab group.
 *
 * @returns {Object} handlers keyed by panel type
 */
export function useActivityBarDocking() {
  const dispatch = useDispatch();
  const nodes = useSelector(selectNodes);
  const tabs = useSelector(selectTabs);

  /**
   * Toggle a sidebar panel.
   * - If it exists and is focused → close it
   * - If it exists → focus it
   * - If it doesn't exist → open it in the first tab group
   */
  const togglePanel = useCallback(
    (panelType, title) => {
      const existing = findExistingTab(nodes, tabs, panelType);

      if (existing) {
        // Focus the group containing this tab
        dispatch(setFocusedTabGroup(existing.groupId));
        // Activate the tab
        dispatch({
          type: 'layout/activateTab',
          payload: { tabId: existing.tabId },
        });
        return;
      }

      // Open new tab — find the first tab group (preferably a sidebar one)
      const groups = Object.entries(nodes).filter(([, n]) => n.type === 'tabgroup');
      if (groups.length > 0) {
        // Prefer the first group (usually sidebar in classic layout)
        const [targetGroupId] = groups[0];
        const newTab = createTab({ panelType, title });
        dispatch(openTab({
          tabGroupId: targetGroupId,
          tab: newTab,
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
