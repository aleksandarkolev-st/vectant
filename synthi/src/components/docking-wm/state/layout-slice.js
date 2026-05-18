/**
 * @fileoverview Redux slice for layout state management.
 * This is the core state manager for the entire docking system.
 *
 * Uses Redux Toolkit's createSlice with Immer for immutable updates.
 * All layout tree mutations are delegated to the pure utility functions
 * in layout-ops.js, keeping this slice as a thin wrapper.
 */

import { createSlice, createSelector } from "@reduxjs/toolkit";
import { NODE_TYPE, DIRECTION, DROP_ZONE, LAYOUT_VERSION } from "../types";
import {
  createEmptyLayout,
  createDefaultIDELayout,
  createTab,
  createTabGroupNode,
  createSplitNode,
  createFloatingWindow,
  normalizeSizes,
} from "../utils/layout-node";
import {
  splitNode,
  addTabToGroup,
  removeTabFromCurrentGroup,
  closeTab,
  moveTab,
  activateTab,
  resizeSplit,
  toggleMaximize,
  floatTab,
  dockFloat,
  updateFloat,
  bringFloatToFront,
  popoutTab,
  dockPopout,
  handleDrop,
  cleanupEmptyNodes,
} from "../utils/layout-ops";
import {
  getNode,
  findTabGroup,
  getAllTabGroups,
  findFirstTabGroup,
  validateLayout,
} from "../utils/layout-query";

// ─── Initial State ──────────────────────────────────────

const initialState = createEmptyLayout();

// ─── Slice ──────────────────────────────────────────────

const layoutSlice = createSlice({
  name: "layout",
  initialState,
  reducers: {
    /**
     * Replace the entire layout state (for hydration/loading profiles).
     */
    setLayout(state, action) {
      return action.payload;
    },

    /**
     * Reset layout to empty.
     */
    resetLayout() {
      return createEmptyLayout();
    },

    // ── Tab Actions ────────────────────────────────────

    /**
     * Open a new tab in a target tab group.
     * Payload: { panelType, title, icon?, data?, targetTabGroupId?, insertIndex? }
     */
    openTab(state, action) {
      const {
        panelType,
        title,
        icon,
        data,
        closable = true,
        targetTabGroupId,
        insertIndex,
      } = action.payload;

      // ── Dedup guard: never allow two tabs of the same panelType ──
      // Check docked tabs first
      for (const [nodeId, node] of Object.entries(state.nodes)) {
        if (node.type !== "tabgroup") continue;
        for (const existingTabId of node.tabs || []) {
          const existingTab = state.tabs[existingTabId];
          if (existingTab && existingTab.panelType === panelType) {
            // For extension-view, also match on containerId
            if (panelType === "extension-view") {
              if (existingTab.data?.containerId !== data?.containerId) continue;
            }
            // Tab already exists — focus it instead of creating a duplicate
            let next = { ...state, focusedTabGroupId: nodeId };
            const group = next.nodes[nodeId];
            if (group && group.activeTabId !== existingTabId) {
              next = {
                ...next,
                nodes: {
                  ...next.nodes,
                  [nodeId]: { ...group, activeTabId: existingTabId },
                },
              };
            }
            return next;
          }
        }
      }
      // Check floating windows
      for (const fw of Object.values(state.floating || {})) {
        const floatTab = state.tabs[fw.tabId];
        if (floatTab && floatTab.panelType === panelType) {
          if (panelType === "extension-view") {
            if (floatTab.data?.containerId !== data?.containerId) continue;
          }
          // Already floating — bring to front
          return bringFloatToFront(state, fw.id);
        }
      }

      const tab = createTab({ panelType, title, icon, closable, data });
      const newState = { ...state, tabs: { ...state.tabs, [tab.id]: tab } };

      const groupId =
        targetTabGroupId ||
        state.focusedTabGroupId ||
        getAllTabGroups(state)[0]?.id;

      if (!groupId) return state;

      return addTabToGroup(newState, groupId, tab.id, insertIndex, true);
    },

    /**
     * Close a tab by ID.
     * Payload: { tabId, removeDefinition? }
     */
    closeTabAction(state, action) {
      const { tabId, removeDefinition = true, forceClose = false } = action.payload;
      return closeTab(state, tabId, removeDefinition, forceClose);
    },

    /**
     * Activate (select) a tab.
     * Payload: { tabGroupId?, tabId }
     * If tabGroupId is omitted, finds the group containing the tab.
     */
    activateTabAction(state, action) {
      let { tabGroupId, tabId } = action.payload;
      if (!tabGroupId && tabId) {
        // Find the tab group containing this tab
        for (const [nodeId, node] of Object.entries(state.nodes)) {
          if (node.type === NODE_TYPE.TAB_GROUP && node.tabs?.includes(tabId)) {
            tabGroupId = nodeId;
            break;
          }
        }
      }
      if (!tabGroupId) return state;
      return activateTab(state, tabGroupId, tabId);
    },

    /**
     * Move a tab to a new group/position.
     * Payload: { tabId, targetTabGroupId, targetIndex? }
     */
    moveTabAction(state, action) {
      const { tabId, targetTabGroupId, targetIndex } = action.payload;
      return moveTab(state, tabId, targetTabGroupId, targetIndex);
    },

    /**
     * Update a tab's data.
     * Payload: { tabId, updates: { title?, icon?, data?, pinned? } }
     */
    updateTabData(state, action) {
      const { tabId, updates } = action.payload;
      if (!state.tabs[tabId]) return state;
      return {
        ...state,
        tabs: {
          ...state.tabs,
          [tabId]: { ...state.tabs[tabId], ...updates },
        },
      };
    },

    // ── Split Actions ──────────────────────────────────

    /**
     * Split a node with a tab.
     * Payload: { targetNodeId, tabId, zone, ratio? }
     */
    splitNodeAction(state, action) {
      const { targetNodeId, tabId, zone, ratio } = action.payload;
      return splitNode(state, targetNodeId, tabId, zone, ratio);
    },

    /**
     * Resize a split node's children.
     * Payload: { splitNodeId, splitterIndex, delta }
     */
    resizeSplitAction(state, action) {
      const { splitNodeId, splitterIndex, delta } = action.payload;
      return resizeSplit(state, splitNodeId, splitterIndex, delta);
    },

    // ── Maximize ───────────────────────────────────────

    /**
     * Toggle maximize of a node.
     * Payload: { nodeId }
     */
    toggleMaximizeAction(state, action) {
      return toggleMaximize(state, action.payload.nodeId);
    },

    // ── Float Actions ──────────────────────────────────

    /**
     * Float a tab out of the tree.
     * Payload: { tabId, x, y, width, height }
     */
    floatTabAction(state, action) {
      const { tabId, x, y, width, height } = action.payload;
      return floatTab(state, tabId, { x, y, width, height });
    },

    /**
     * Dock a floating window back into a tab group.
     * Payload: { floatId, targetTabGroupId, insertIndex? }
     */
    dockFloatAction(state, action) {
      const { floatId, targetTabGroupId, insertIndex } = action.payload;
      return dockFloat(state, floatId, targetTabGroupId, insertIndex);
    },

    /**
     * Update floating window position/size.
     * Payload: { floatId, ...updates }
     */
    updateFloatAction(state, action) {
      const { floatId, ...updates } = action.payload;
      return updateFloat(state, floatId, updates);
    },

    /**
     * Bring a floating window to front.
     * Payload: { floatId }
     */
    bringFloatToFrontAction(state, action) {
      return bringFloatToFront(state, action.payload.floatId);
    },

    // ── Popout Actions ─────────────────────────────────

    /**
     * Pop a tab out into a new browser window.
     * Payload: { tabId, windowName, width?, height? }
     */
    popoutTabAction(state, action) {
      const { tabId, windowName, width, height } = action.payload;
      return popoutTab(state, tabId, windowName, { width, height });
    },

    /**
     * Bring a popped-out tab back into the tree.
     * Payload: { popoutId, targetTabGroupId }
     */
    dockPopoutAction(state, action) {
      const { popoutId, targetTabGroupId } = action.payload;
      return dockPopout(state, popoutId, targetTabGroupId);
    },

    // ── Drag & Drop ────────────────────────────────────

    /**
     * Set the currently dragged tab.
     * Payload: { tabId } or null
     */
    setDragSource(state, action) {
      return { ...state, dragSourceTabId: action.payload?.tabId || null };
    },

    /**
     * Handle a completed drop.
     * Payload: { drag: DragPayload, target: DropTarget }
     */
    handleDropAction(state, action) {
      const { drag, target } = action.payload;
      return handleDrop(state, drag, target);
    },

    // ── Focus ──────────────────────────────────────────

    /**
     * Set the focused tab group.
     * Payload: { tabGroupId }
     */
    setFocusedTabGroup(state, action) {
      const id =
        typeof action.payload === "string"
          ? action.payload
          : (action.payload?.tabGroupId ?? null);
      return { ...state, focusedTabGroupId: id };
    },

    // ── Editor Recovery ───────────────────────────────

    /**
     * Restore the editor panel when it has been closed.
     * Creates a new editor tab and splits the first tab group to the RIGHT
     * so the editor appears in its own center panel, matching the default layout.
     */
    restoreEditorPanel(state) {
      // Don't duplicate — if an editor tab already exists, just focus it
      for (const [nid, node] of Object.entries(state.nodes)) {
        if (node.type !== "tabgroup") continue;
        for (const tid of node.tabs || []) {
          const t = state.tabs[tid];
          if (t && t.panelType === "editor") {
            return { ...state, focusedTabGroupId: nid };
          }
        }
      }

      // Create the editor tab — empty title (the file-tab strip below
      // already labels what's open; the meta-container needs no name).
      const tab = createTab({
        panelType: "editor",
        title: "",
        closable: false,
      });
      let next = { ...state, tabs: { ...state.tabs, [tab.id]: tab } };

      // Find the first tab group (typically the sidebar) and split RIGHT
      const firstGroup = getAllTabGroups(next)[0];
      if (!firstGroup) {
        // Fallback: layout is empty — make editor the root
        const group = createTabGroupNode({
          tabs: [tab.id],
          activeTabId: tab.id,
        });
        next.nodes = { ...next.nodes, [group.id]: group };
        next.rootId = group.id;
        next.focusedTabGroupId = group.id;
        return next;
      }

      // splitNode creates a new tab group, splits the target, and places the new tab
      return splitNode(next, firstGroup.id, tab.id, DROP_ZONE.RIGHT, 0.75);
    },

    // ── Batch cleanup ──────────────────────────────────

    /**
     * Run cleanup on the layout (remove empty groups, collapse single-child splits).
     */
    cleanupLayout(state) {
      return cleanupEmptyNodes(state);
    },
  },
});

// ─── Actions ────────────────────────────────────────────

export const {
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
  restoreEditorPanel,
  cleanupLayout,
} = layoutSlice.actions;

// ─── Selectors ──────────────────────────────────────────

/** Select the entire layout state */
export const selectLayout = (state) => state.layout;

/** Select the root node ID */
export const selectRootId = (state) => state.layout.rootId;

/** Select all nodes */
export const selectNodes = (state) => state.layout.nodes;

/** Select all tabs */
export const selectTabs = (state) => state.layout.tabs;

/** Select a specific node */
export const selectNode = (state, nodeId) => state.layout.nodes[nodeId];

/** Select a specific tab */
export const selectTab = (state, tabId) => state.layout.tabs[tabId];

/** Select floating windows */
export const selectFloating = (state) => state.layout.floating;

/** Select popout windows */
export const selectPopouts = (state) => state.layout.popouts;

/** Select maximized node ID */
export const selectMaximizedNodeId = (state) => state.layout.maximizedNodeId;

/** Select focused tab group ID */
export const selectFocusedTabGroupId = (state) =>
  state.layout.focusedTabGroupId;

/** Select drag source tab ID */
export const selectDragSourceTabId = (state) => state.layout.dragSourceTabId;

/** Select all tab groups (memoized) */
export const selectAllTabGroups = createSelector([selectNodes], (nodes) =>
  Object.values(nodes).filter((n) => n.type === NODE_TYPE.TAB_GROUP),
);

/** Select all floating windows as array (memoized) */
export const selectFloatingWindows = createSelector(
  [selectFloating],
  (floating) => Object.values(floating),
);

/** Select all popout windows as array (memoized) */
export const selectPopoutWindows = createSelector([selectPopouts], (popouts) =>
  Object.values(popouts),
);

/** Select whether any tab is being dragged */
export const selectIsDragging = createSelector(
  [selectDragSourceTabId],
  (tabId) => tabId !== null,
);

/** Select the focused tab group node */
export const selectFocusedTabGroup = createSelector(
  [selectNodes, selectFocusedTabGroupId],
  (nodes, focusedId) => (focusedId ? nodes[focusedId] : null),
);

/** Select tabs for a specific tab group (factory selector) */
export const makeSelectTabGroupTabs = (tabGroupId) =>
  createSelector(
    [(state) => selectNode(state, tabGroupId), selectTabs],
    (group, tabs) => {
      if (!group || group.type !== NODE_TYPE.TAB_GROUP) return [];
      return group.tabs.map((tid) => tabs[tid]).filter(Boolean);
    },
  );

// ─── Reducer ────────────────────────────────────────────

export default layoutSlice.reducer;
