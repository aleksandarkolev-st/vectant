/**
 * @fileoverview Layout tree mutation operations.
 * All functions take a LayoutState and return a NEW LayoutState (immutable).
 * Designed for Redux reducer composition.
 */

import { NODE_TYPE, DIRECTION, MIN_PANEL_SIZE, DEFAULT_SPLIT_RATIO, DROP_ZONE } from '../types';
import { createSplitNode, createTabGroupNode, normalizeSizes } from './layout-node';
import { getNode, getParent, getChildIndex, findTabGroup, collectDescendants, collectTabIds, getSiblings, findFirstTabGroup } from './layout-query';
import { nodeId } from './id-generator';

// ─── Immutable helpers ──────────────────────────────────

function cloneState(state) {
  return {
    ...state,
    nodes: { ...state.nodes },
    tabs: { ...state.tabs },
    floating: { ...state.floating },
    popouts: { ...state.popouts },
  };
}

function cloneNode(node) {
  if (node.type === NODE_TYPE.SPLIT) {
    return { ...node, children: [...node.children], sizes: [...node.sizes] };
  }
  return { ...node, tabs: [...node.tabs] };
}

// ─── Split Operations ───────────────────────────────────

/**
 * Split a tab group by creating a new split node wrapping the target and a new group.
 * Used when dropping a tab on the left/right/top/bottom zone.
 *
 * @param {import('../types').LayoutState} state
 * @param {string} targetNodeId - the tab group (or split) being split
 * @param {string} tabId - the tab being dropped
 * @param {string} zone - DROP_ZONE value (left, right, top, bottom)
 * @param {number} [ratio] - size ratio for the new panel
 * @returns {import('../types').LayoutState}
 */
export function splitNode(state, targetNodeId, tabId, zone, ratio = DEFAULT_SPLIT_RATIO) {
  let next = cloneState(state);
  const target = cloneNode(next.nodes[targetNodeId]);
  next.nodes[targetNodeId] = target;

  // Determine direction
  const direction =
    zone === DROP_ZONE.LEFT || zone === DROP_ZONE.RIGHT
      ? DIRECTION.ROW
      : DIRECTION.COLUMN;

  // Create new tab group for the dropped tab
  const newGroup = createTabGroupNode({
    tabs: [tabId],
    activeTabId: tabId,
  });

  // Remove tab from its current group (if it's in one)
  next = removeTabFromCurrentGroup(next, tabId);

  // Create new split node
  const isBeforeTarget = zone === DROP_ZONE.LEFT || zone === DROP_ZONE.TOP;
  const children = isBeforeTarget
    ? [newGroup.id, targetNodeId]
    : [targetNodeId, newGroup.id];
  const sizes = isBeforeTarget
    ? [ratio, 1 - ratio]
    : [1 - ratio, ratio];

  const parent = target.parentId ? next.nodes[target.parentId] : null;

  // Check if parent split is same direction — if so, insert inline instead of nesting
  if (parent && parent.type === NODE_TYPE.SPLIT && parent.direction === direction) {
    return insertIntoExistingSplit(next, parent, targetNodeId, newGroup, isBeforeTarget, ratio);
  }

  // Create new wrapping split
  const newSplit = createSplitNode({
    direction,
    children,
    sizes,
    parentId: target.parentId,
  });

  // Re-parent target under new split
  target.parentId = newSplit.id;
  newGroup.parentId = newSplit.id;

  // Replace target in its former parent's children
  if (parent) {
    const clonedParent = cloneNode(parent);
    const idx = clonedParent.children.indexOf(targetNodeId);
    clonedParent.children[idx] = newSplit.id;
    next.nodes[parent.id] = clonedParent;
  } else {
    // target was root
    next.rootId = newSplit.id;
  }

  next.nodes[newSplit.id] = newSplit;
  next.nodes[newGroup.id] = newGroup;
  next.nodes[targetNodeId] = target;
  next.focusedTabGroupId = newGroup.id;

  return cleanupEmptyNodes(next);
}

/**
 * Insert a new tab group into an existing split node (inline, no nesting).
 */
function insertIntoExistingSplit(state, parentSplit, targetNodeId, newGroup, before, ratio) {
  const next = state;
  const clonedParent = cloneNode(parentSplit);
  const idx = clonedParent.children.indexOf(targetNodeId);
  const insertIdx = before ? idx : idx + 1;

  clonedParent.children.splice(insertIdx, 0, newGroup.id);

  // Redistribute sizes: steal from target
  const targetSize = clonedParent.sizes[idx];
  const newSize = targetSize * ratio;
  const remainingSize = targetSize - newSize;
  clonedParent.sizes[idx] = remainingSize;
  clonedParent.sizes.splice(insertIdx, 0, newSize);

  newGroup.parentId = clonedParent.id;

  next.nodes[clonedParent.id] = clonedParent;
  next.nodes[newGroup.id] = newGroup;
  next.focusedTabGroupId = newGroup.id;

  return cleanupEmptyNodes(next);
}

// ─── Tab Operations ─────────────────────────────────────

/**
 * Add a tab to a tab group.
 * @param {import('../types').LayoutState} state
 * @param {string} tabGroupId
 * @param {string} tabId
 * @param {number} [insertIndex] - where to insert, default end
 * @param {boolean} [activate] - whether to set as active tab
 * @returns {import('../types').LayoutState}
 */
export function addTabToGroup(state, tabGroupId, tabId, insertIndex, activate = true) {
  const next = cloneState(state);
  const group = cloneNode(next.nodes[tabGroupId]);
  if (!group || group.type !== NODE_TYPE.TAB_GROUP) return state;

  // Remove from current group first
  const currentGroup = findTabGroup(next, tabId);
  if (currentGroup && currentGroup.id !== tabGroupId) {
    const clonedCurrent = cloneNode(currentGroup);
    clonedCurrent.tabs = clonedCurrent.tabs.filter((t) => t !== tabId);
    if (clonedCurrent.activeTabId === tabId) {
      clonedCurrent.activeTabId = clonedCurrent.tabs[0] || null;
    }
    next.nodes[clonedCurrent.id] = clonedCurrent;
  }

  // Insert tab
  const idx = insertIndex !== undefined ? insertIndex : group.tabs.length;
  group.tabs.splice(idx, 0, tabId);

  if (activate) {
    group.activeTabId = tabId;
  }

  next.nodes[tabGroupId] = group;
  next.focusedTabGroupId = tabGroupId;

  return cleanupEmptyNodes(next);
}

/**
 * Remove a tab from its current tab group.
 * @param {import('../types').LayoutState} state
 * @param {string} tabId
 * @returns {import('../types').LayoutState}
 */
export function removeTabFromCurrentGroup(state, tabId) {
  const next = cloneState(state);
  const group = findTabGroup(next, tabId);
  if (!group) return next;

  const cloned = cloneNode(group);
  const tabIndex = cloned.tabs.indexOf(tabId);
  cloned.tabs = cloned.tabs.filter((t) => t !== tabId);

  if (cloned.activeTabId === tabId) {
    // Activate next tab or previous
    const nextIdx = Math.min(tabIndex, cloned.tabs.length - 1);
    cloned.activeTabId = cloned.tabs[nextIdx] || null;
  }

  next.nodes[cloned.id] = cloned;
  return next;
}

/**
 * Close a tab: remove from layout and optionally from tabs registry.
 * @param {import('../types').LayoutState} state
 * @param {string} tabId
 * @param {boolean} [removeDefinition] - also remove from tabs map
 * @returns {import('../types').LayoutState}
 */
export function closeTab(state, tabId, removeDefinition = true) {
  let next = removeTabFromCurrentGroup(state, tabId);

  if (removeDefinition) {
    next = cloneState(next);
    delete next.tabs[tabId];
  }

  // Also remove from floating/popouts
  for (const [fid, fw] of Object.entries(next.floating)) {
    if (fw.tabId === tabId) {
      next.floating = { ...next.floating };
      delete next.floating[fid];
    }
  }
  for (const [pid, pw] of Object.entries(next.popouts)) {
    if (pw.tabId === tabId) {
      next.popouts = { ...next.popouts };
      delete next.popouts[pid];
    }
  }

  return cleanupEmptyNodes(next);
}

/**
 * Move a tab to a new position (reorder within group or to different group).
 * @param {import('../types').LayoutState} state
 * @param {string} tabId
 * @param {string} targetTabGroupId
 * @param {number} [targetIndex]
 * @returns {import('../types').LayoutState}
 */
export function moveTab(state, tabId, targetTabGroupId, targetIndex) {
  let next = removeTabFromCurrentGroup(state, tabId);
  next = addTabToGroup(next, targetTabGroupId, tabId, targetIndex, true);
  return next;
}

/**
 * Set the active tab in a tab group.
 * @param {import('../types').LayoutState} state
 * @param {string} tabGroupId
 * @param {string} tabId
 * @returns {import('../types').LayoutState}
 */
export function activateTab(state, tabGroupId, tabId) {
  const next = cloneState(state);
  const group = next.nodes[tabGroupId];
  if (!group || group.type !== NODE_TYPE.TAB_GROUP) return state;

  next.nodes[tabGroupId] = { ...group, activeTabId: tabId };
  next.focusedTabGroupId = tabGroupId;
  return next;
}

// ─── Resize Operations ──────────────────────────────────

/**
 * Resize children of a split node by adjusting sizes at a splitter boundary.
 * @param {import('../types').LayoutState} state
 * @param {string} splitNodeId
 * @param {number} splitterIndex - index of the splitter (between children[i] and children[i+1])
 * @param {number} delta - fractional change to apply
 * @returns {import('../types').LayoutState}
 */
export function resizeSplit(state, splitNodeId, splitterIndex, delta) {
  const next = cloneState(state);
  const node = next.nodes[splitNodeId];
  if (!node || node.type !== NODE_TYPE.SPLIT) return state;

  const cloned = cloneNode(node);
  const leftIdx = splitterIndex;
  const rightIdx = splitterIndex + 1;

  if (rightIdx >= cloned.sizes.length) return state;

  let newLeft = cloned.sizes[leftIdx] + delta;
  let newRight = cloned.sizes[rightIdx] - delta;

  // Enforce minimums
  if (newLeft < MIN_PANEL_SIZE) {
    newRight -= MIN_PANEL_SIZE - newLeft;
    newLeft = MIN_PANEL_SIZE;
  }
  if (newRight < MIN_PANEL_SIZE) {
    newLeft -= MIN_PANEL_SIZE - newRight;
    newRight = MIN_PANEL_SIZE;
  }

  cloned.sizes[leftIdx] = Math.max(MIN_PANEL_SIZE, newLeft);
  cloned.sizes[rightIdx] = Math.max(MIN_PANEL_SIZE, newRight);

  next.nodes[splitNodeId] = cloned;
  return next;
}

// ─── Maximize / Restore ─────────────────────────────────

/**
 * Toggle maximized state of a node.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {import('../types').LayoutState}
 */
export function toggleMaximize(state, nodeId) {
  const next = cloneState(state);
  next.maximizedNodeId = state.maximizedNodeId === nodeId ? null : nodeId;
  return next;
}

// ─── Floating Operations ────────────────────────────────

/**
 * Float a tab out of the tree into a floating window.
 * @param {import('../types').LayoutState} state
 * @param {string} tabId
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @returns {import('../types').LayoutState}
 */
export function floatTab(state, tabId, rect) {
  let next = removeTabFromCurrentGroup(state, tabId);
  next = cloneState(next);

  const floatKey = `float-${tabId}`;
  next.floating[floatKey] = {
    id: floatKey,
    tabId,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: getMaxFloatingZIndex(next) + 1,
    isMinimized: false,
  };

  return cleanupEmptyNodes(next);
}

/**
 * Dock a floating tab back into the tree.
 * @param {import('../types').LayoutState} state
 * @param {string} floatId
 * @param {string} targetTabGroupId
 * @param {number} [insertIndex]
 * @returns {import('../types').LayoutState}
 */
export function dockFloat(state, floatId, targetTabGroupId, insertIndex) {
  const fw = state.floating[floatId];
  if (!fw) return state;

  // Resolve null target to the focused group or first available
  const resolvedTarget =
    targetTabGroupId ||
    state.focusedTabGroupId ||
    findFirstTabGroup(state, state.rootId)?.id;

  if (!resolvedTarget) return state;

  let next = addTabToGroup(state, resolvedTarget, fw.tabId, insertIndex, true);
  next = cloneState(next);
  delete next.floating[floatId];

  return next;
}

/**
 * Update floating window position/size.
 * @param {import('../types').LayoutState} state
 * @param {string} floatId
 * @param {Partial<import('../types').FloatingWindow>} updates
 * @returns {import('../types').LayoutState}
 */
export function updateFloat(state, floatId, updates) {
  if (!state.floating[floatId]) return state;
  const next = cloneState(state);
  next.floating[floatId] = { ...next.floating[floatId], ...updates };
  return next;
}

/**
 * Bring a floating window to front.
 * @param {import('../types').LayoutState} state
 * @param {string} floatId
 * @returns {import('../types').LayoutState}
 */
export function bringFloatToFront(state, floatId) {
  return updateFloat(state, floatId, {
    zIndex: getMaxFloatingZIndex(state) + 1,
  });
}

function getMaxFloatingZIndex(state) {
  return Object.values(state.floating).reduce(
    (max, fw) => Math.max(max, fw.zIndex || 0),
    99
  );
}

// ─── Popout Operations ──────────────────────────────────

/**
 * Pop a tab out into a new browser window.
 * @param {import('../types').LayoutState} state
 * @param {string} tabId
 * @param {string} windowName
 * @param {{ width?: number, height?: number }} [opts]
 * @returns {import('../types').LayoutState}
 */
export function popoutTab(state, tabId, windowName, opts = {}) {
  let next = removeTabFromCurrentGroup(state, tabId);
  next = cloneState(next);

  const popKey = `popout-${tabId}`;
  next.popouts[popKey] = {
    id: popKey,
    tabId,
    windowName,
    width: opts.width || 800,
    height: opts.height || 600,
  };

  return cleanupEmptyNodes(next);
}

/**
 * Bring a popped-out tab back into the tree.
 * @param {import('../types').LayoutState} state
 * @param {string} popoutIdVal
 * @param {string} targetTabGroupId
 * @returns {import('../types').LayoutState}
 */
export function dockPopout(state, popoutIdVal, targetTabGroupId) {
  const pw = state.popouts[popoutIdVal];
  if (!pw) return state;

  // Resolve null target to the focused group or first available
  const resolvedTarget =
    targetTabGroupId ||
    state.focusedTabGroupId ||
    findFirstTabGroup(state, state.rootId)?.id;

  if (!resolvedTarget) return state;

  let next = addTabToGroup(state, resolvedTarget, pw.tabId, undefined, true);
  next = cloneState(next);
  delete next.popouts[popoutIdVal];

  return next;
}

// ─── Drop Handler ───────────────────────────────────────

/**
 * Handle a drop of a tab onto a target zone.
 * This is the main entry point for drag-and-drop resolution.
 *
 * @param {import('../types').LayoutState} state
 * @param {import('../types').DragPayload} drag
 * @param {import('../types').DropTarget} target
 * @returns {import('../types').LayoutState}
 */
export function handleDrop(state, drag, target) {
  const { tabId } = drag;
  const { nodeId: targetNodeId, zone, tabIndex } = target;

  switch (zone) {
    case DROP_ZONE.CENTER:
    case DROP_ZONE.TAB_BAR:
      return moveTab(state, tabId, targetNodeId, tabIndex);

    case DROP_ZONE.LEFT:
    case DROP_ZONE.RIGHT:
    case DROP_ZONE.TOP:
    case DROP_ZONE.BOTTOM:
      return splitNode(state, targetNodeId, tabId, zone);

    default:
      return state;
  }
}

// ─── Cleanup ────────────────────────────────────────────

/**
 * Remove empty tab groups and collapse unnecessary single-child splits.
 * Run after any destructive operation.
 *
 * @param {import('../types').LayoutState} state
 * @returns {import('../types').LayoutState}
 */
export function cleanupEmptyNodes(state) {
  let next = cloneState(state);
  let changed = true;

  // Iterate until stable
  while (changed) {
    changed = false;

    for (const [id, node] of Object.entries(next.nodes)) {
      // Remove empty tab groups (unless it's the only node / root)
      if (
        node.type === NODE_TYPE.TAB_GROUP &&
        node.tabs.length === 0 &&
        id !== next.rootId
      ) {
        next = removeNode(next, id);
        changed = true;
        break;
      }

      // Collapse single-child split nodes
      if (
        node.type === NODE_TYPE.SPLIT &&
        node.children.length === 1
      ) {
        const childId = node.children[0];
        const child = next.nodes[childId];
        if (!child) continue;

        // Replace this split with its only child
        const clonedChild = cloneNode(child);
        clonedChild.parentId = node.parentId;

        if (node.parentId) {
          const parent = cloneNode(next.nodes[node.parentId]);
          const idx = parent.children.indexOf(id);
          if (idx !== -1) {
            parent.children[idx] = childId;
          }
          next.nodes[parent.id] = parent;
        } else {
          next.rootId = childId;
        }

        next.nodes[childId] = clonedChild;
        delete next.nodes[id];
        changed = true;
        break;
      }

      // Remove splits with 0 children (shouldn't happen but safety)
      if (
        node.type === NODE_TYPE.SPLIT &&
        node.children.length === 0
      ) {
        if (id === next.rootId) {
          // Replace root with empty tab group
          const emptyGroup = createTabGroupNode({ parentId: null });
          next.nodes[emptyGroup.id] = emptyGroup;
          next.rootId = emptyGroup.id;
        }
        delete next.nodes[id];
        changed = true;
        break;
      }
    }
  }

  // Ensure focused group is valid
  if (next.focusedTabGroupId && !next.nodes[next.focusedTabGroupId]) {
    const firstGroup = findFirstTabGroup(next, next.rootId);
    next.focusedTabGroupId = firstGroup?.id || null;
  }

  return next;
}

/**
 * Remove a node from its parent's children and sizes.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {import('../types').LayoutState}
 */
function removeNode(state, nodeIdToRemove) {
  const next = cloneState(state);
  const node = next.nodes[nodeIdToRemove];
  if (!node) return next;

  if (node.parentId) {
    const parent = cloneNode(next.nodes[node.parentId]);
    const idx = parent.children.indexOf(nodeIdToRemove);
    if (idx !== -1) {
      parent.children.splice(idx, 1);
      parent.sizes.splice(idx, 1);
      parent.sizes = normalizeSizes(parent.sizes);
    }
    next.nodes[parent.id] = parent;
  }

  // Remove the node and all descendants
  const descendants = collectDescendants(next, nodeIdToRemove);
  for (const did of descendants) {
    delete next.nodes[did];
  }

  return next;
}
