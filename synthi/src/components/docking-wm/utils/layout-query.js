/**
 * @fileoverview Layout tree traversal, query, and validation utilities.
 * Operates on the normalized flat-map LayoutState.
 */

import { NODE_TYPE } from '../types';

/**
 * Get a node by ID, or null.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {import('../types').LayoutNode|null}
 */
export function getNode(state, nodeId) {
  return state.nodes[nodeId] || null;
}

/**
 * Get the parent node of a given node.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {import('../types').LayoutNode|null}
 */
export function getParent(state, nodeId) {
  const node = state.nodes[nodeId];
  if (!node || !node.parentId) return null;
  return state.nodes[node.parentId] || null;
}

/**
 * Get the index of a child within its parent's children array.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {number} -1 if not found or no parent
 */
export function getChildIndex(state, nodeId) {
  const parent = getParent(state, nodeId);
  if (!parent || parent.type !== NODE_TYPE.SPLIT) return -1;
  return parent.children.indexOf(nodeId);
}

/**
 * Get all tab group nodes in the layout.
 * @param {import('../types').LayoutState} state
 * @returns {import('../types').TabGroupNode[]}
 */
export function getAllTabGroups(state) {
  return Object.values(state.nodes).filter(
    (n) => n.type === NODE_TYPE.TAB_GROUP
  );
}

/**
 * Get all split nodes in the layout.
 * @param {import('../types').LayoutState} state
 * @returns {import('../types').SplitNode[]}
 */
export function getAllSplitNodes(state) {
  return Object.values(state.nodes).filter(
    (n) => n.type === NODE_TYPE.SPLIT
  );
}

/**
 * Find the tab group that contains a specific tab.
 * @param {import('../types').LayoutState} state
 * @param {string} tabId
 * @returns {import('../types').TabGroupNode|null}
 */
export function findTabGroup(state, tabId) {
  return (
    getAllTabGroups(state).find((g) => g.tabs.includes(tabId)) || null
  );
}

/**
 * Check if a node is an ancestor of another.
 * @param {import('../types').LayoutState} state
 * @param {string} ancestorId
 * @param {string} descendantId
 * @returns {boolean}
 */
export function isAncestor(state, ancestorId, descendantId) {
  let current = state.nodes[descendantId];
  while (current) {
    if (current.parentId === ancestorId) return true;
    current = state.nodes[current.parentId];
  }
  return false;
}

/**
 * Get the path from root to a node (array of node IDs).
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {string[]}
 */
export function getPathFromRoot(state, nodeId) {
  const path = [];
  let current = state.nodes[nodeId];
  while (current) {
    path.unshift(current.id);
    current = current.parentId ? state.nodes[current.parentId] : null;
  }
  return path;
}

/**
 * Get the depth of a node in the tree.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {number}
 */
export function getDepth(state, nodeId) {
  return getPathFromRoot(state, nodeId).length - 1;
}

/**
 * Walk the layout tree in depth-first order.
 * @param {import('../types').LayoutState} state
 * @param {string} startId - node to start from
 * @param {function(import('../types').LayoutNode, number): boolean|void} callback
 *   Return false to stop traversal.
 */
export function walkTree(state, startId, callback) {
  function visit(nodeId, depth) {
    const node = state.nodes[nodeId];
    if (!node) return;
    const result = callback(node, depth);
    if (result === false) return;
    if (node.type === NODE_TYPE.SPLIT) {
      for (const childId of node.children) {
        visit(childId, depth + 1);
      }
    }
  }
  visit(startId, 0);
}

/**
 * Collect all descendant node IDs (including the start node).
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {string[]}
 */
export function collectDescendants(state, nodeId) {
  const ids = [];
  walkTree(state, nodeId, (node) => {
    ids.push(node.id);
  });
  return ids;
}

/**
 * Get all tab IDs contained within a subtree.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {string[]}
 */
export function collectTabIds(state, nodeId) {
  const tabIds = [];
  walkTree(state, nodeId, (node) => {
    if (node.type === NODE_TYPE.TAB_GROUP) {
      tabIds.push(...node.tabs);
    }
  });
  return tabIds;
}

/**
 * Find the first tab group node under a subtree.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {import('../types').TabGroupNode|null}
 */
export function findFirstTabGroup(state, nodeId) {
  let found = null;
  walkTree(state, nodeId, (node) => {
    if (node.type === NODE_TYPE.TAB_GROUP && !found) {
      found = node;
      return false; // stop
    }
  });
  return found;
}

/**
 * Count the total number of tab groups in the layout.
 * @param {import('../types').LayoutState} state
 * @returns {number}
 */
export function countTabGroups(state) {
  return getAllTabGroups(state).length;
}

/**
 * Get the sibling node IDs of a given node.
 * @param {import('../types').LayoutState} state
 * @param {string} nodeId
 * @returns {string[]}
 */
export function getSiblings(state, nodeId) {
  const parent = getParent(state, nodeId);
  if (!parent || parent.type !== NODE_TYPE.SPLIT) return [];
  return parent.children.filter((id) => id !== nodeId);
}

/**
 * Validate layout state integrity.
 * @param {import('../types').LayoutState} state
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateLayout(state) {
  const errors = [];

  if (!state.rootId) {
    errors.push('Missing rootId');
    return { valid: false, errors };
  }

  if (!state.nodes[state.rootId]) {
    errors.push(`Root node '${state.rootId}' not found in nodes`);
    return { valid: false, errors };
  }

  // Check parent references
  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.id !== id) {
      errors.push(`Node key '${id}' does not match node.id '${node.id}'`);
    }

    if (node.parentId && !state.nodes[node.parentId]) {
      errors.push(`Node '${id}' references missing parent '${node.parentId}'`);
    }

    if (node.type === NODE_TYPE.SPLIT) {
      // Validate children exist
      for (const childId of node.children) {
        if (!state.nodes[childId]) {
          errors.push(`Split '${id}' references missing child '${childId}'`);
        }
      }
      // Validate sizes
      if (node.sizes.length !== node.children.length) {
        errors.push(`Split '${id}' has ${node.sizes.length} sizes but ${node.children.length} children`);
      }
      // Split must have >= 2 children
      if (node.children.length < 2) {
        errors.push(`Split '${id}' has fewer than 2 children`);
      }
    }

    if (node.type === NODE_TYPE.TAB_GROUP) {
      // Validate tabs exist
      for (const tid of node.tabs) {
        if (!state.tabs[tid]) {
          errors.push(`TabGroup '${id}' references missing tab '${tid}'`);
        }
      }
      // Active tab should be in tabs array
      if (node.activeTabId && !node.tabs.includes(node.activeTabId)) {
        errors.push(`TabGroup '${id}' activeTabId '${node.activeTabId}' not in tabs`);
      }
    }
  }

  // Root should have no parent
  const root = state.nodes[state.rootId];
  if (root && root.parentId) {
    errors.push(`Root node has a parentId: '${root.parentId}'`);
  }

  return { valid: errors.length === 0, errors };
}
