/**
 * @fileoverview Layout tree node creation factories.
 * All operations produce plain objects suitable for Redux state.
 */

import { NODE_TYPE, DIRECTION, DEFAULT_SPLIT_RATIO, LAYOUT_VERSION } from '../types';
import { nodeId, tabId } from './id-generator';

/**
 * Create a new SplitNode.
 * @param {Object} opts
 * @param {string} [opts.id]
 * @param {string} opts.direction - 'row' | 'column'
 * @param {string[]} opts.children - child node IDs
 * @param {number[]} [opts.sizes] - fractional sizes
 * @param {string|null} [opts.parentId]
 * @returns {import('../types').SplitNode}
 */
export function createSplitNode({
  id,
  direction = DIRECTION.ROW,
  children = [],
  sizes,
  parentId = null,
}) {
  const resolvedSizes = sizes || children.map(() => 1 / children.length);
  return {
    id: id || nodeId(),
    type: NODE_TYPE.SPLIT,
    direction,
    children,
    sizes: normalizeSizes(resolvedSizes),
    parentId,
  };
}

/**
 * Create a new TabGroupNode.
 * @param {Object} opts
 * @param {string} [opts.id]
 * @param {string[]} [opts.tabs] - tab IDs
 * @param {string|null} [opts.activeTabId]
 * @param {string|null} [opts.parentId]
 * @param {boolean} [opts.isPlaceholder]
 * @returns {import('../types').TabGroupNode}
 */
export function createTabGroupNode({
  id,
  tabs = [],
  activeTabId = null,
  parentId = null,
  isPlaceholder = false,
} = {}) {
  return {
    id: id || nodeId(),
    type: NODE_TYPE.TAB_GROUP,
    tabs,
    activeTabId: activeTabId || tabs[0] || null,
    parentId,
    isPlaceholder,
  };
}

/**
 * Create a new TabDefinition.
 * @param {Object} opts
 * @param {string} [opts.id]
 * @param {string} opts.panelType
 * @param {string} opts.title
 * @param {string} [opts.icon]
 * @param {boolean} [opts.closable]
 * @param {boolean} [opts.pinned]
 * @param {Object} [opts.data]
 * @returns {import('../types').TabDefinition}
 */
export function createTab({
  id,
  panelType,
  title,
  icon,
  closable = true,
  pinned = false,
  data = {},
}) {
  return {
    id: id || tabId(),
    panelType,
    title,
    icon,
    closable,
    pinned,
    data,
  };
}

/**
 * Create a floating window entry.
 * @param {Object} opts
 * @returns {import('../types').FloatingWindow}
 */
export function createFloatingWindow({
  id,
  tabId: tid,
  x = 100,
  y = 100,
  width = 400,
  height = 300,
  zIndex = 100,
}) {
  return { id, tabId: tid, x, y, width, height, zIndex, isMinimized: false };
}

/**
 * Create a popout window entry.
 * @param {Object} opts
 * @returns {import('../types').PopoutWindow}
 */
export function createPopoutWindow({
  id,
  tabId: tid,
  windowName,
  width = 800,
  height = 600,
  left,
  top,
}) {
  return { id, tabId: tid, windowName, width, height, left, top };
}

/**
 * Normalize sizes array so they sum to 1.
 * @param {number[]} sizes
 * @returns {number[]}
 */
export function normalizeSizes(sizes) {
  const total = sizes.reduce((sum, s) => sum + s, 0);
  if (total === 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / total);
}

/**
 * Create an empty layout state.
 * @returns {import('../types').LayoutState}
 */
export function createEmptyLayout() {
  const rootGroup = createTabGroupNode();
  return {
    version: LAYOUT_VERSION,
    rootId: rootGroup.id,
    nodes: { [rootGroup.id]: rootGroup },
    tabs: {},
    floating: {},
    popouts: {},
    maximizedNodeId: null,
    focusedTabGroupId: rootGroup.id,
    dragSourceTabId: null,
  };
}

/**
 * Create a default IDE layout with sidebar, editor, and bottom panel areas.
 * @param {Object} opts
 * @param {import('../types').TabDefinition[]} [opts.sidebarTabs]
 * @param {import('../types').TabDefinition[]} [opts.editorTabs]
 * @param {import('../types').TabDefinition[]} [opts.bottomTabs]
 * @returns {import('../types').LayoutState}
 */
export function createDefaultIDELayout({
  sidebarTabs = [],
  editorTabs = [],
  bottomTabs = [],
} = {}) {
  // Create tab group nodes
  const sidebarGroup = createTabGroupNode({
    tabs: sidebarTabs.map((t) => t.id),
    activeTabId: sidebarTabs[0]?.id || null,
  });

  const editorGroup = createTabGroupNode({
    tabs: editorTabs.map((t) => t.id),
    activeTabId: editorTabs[0]?.id || null,
  });

  const bottomGroup = createTabGroupNode({
    tabs: bottomTabs.map((t) => t.id),
    activeTabId: bottomTabs[0]?.id || null,
  });

  // Right area: editor (top) + bottom panel, column split
  const rightSplit = createSplitNode({
    direction: DIRECTION.COLUMN,
    children: [editorGroup.id, bottomGroup.id],
    sizes: [0.7, 0.3],
  });

  editorGroup.parentId = rightSplit.id;
  bottomGroup.parentId = rightSplit.id;

  // Root: sidebar (left) + right area, row split
  const root = createSplitNode({
    direction: DIRECTION.ROW,
    children: [sidebarGroup.id, rightSplit.id],
    sizes: [0.22, 0.78],
  });

  sidebarGroup.parentId = root.id;
  rightSplit.parentId = root.id;

  // Build tabs map
  const tabs = {};
  [...sidebarTabs, ...editorTabs, ...bottomTabs].forEach((t) => {
    tabs[t.id] = t;
  });

  return {
    version: LAYOUT_VERSION,
    rootId: root.id,
    nodes: {
      [root.id]: root,
      [sidebarGroup.id]: sidebarGroup,
      [rightSplit.id]: rightSplit,
      [editorGroup.id]: editorGroup,
      [bottomGroup.id]: bottomGroup,
    },
    tabs,
    floating: {},
    popouts: {},
    maximizedNodeId: null,
    focusedTabGroupId: editorGroup.id,
    dragSourceTabId: null,
  };
}
