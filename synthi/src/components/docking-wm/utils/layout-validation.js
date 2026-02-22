'use client';

/**
 * @fileoverview Layout validation and error recovery utilities.
 *
 * Provides deep validation of layout trees and automatic repair
 * of common corruption cases (dangling references, orphaned nodes,
 * inconsistent parent pointers, etc.).
 *
 * Used by layout persistence to validate before restoring and
 * by the reducer to optionally validate after each action in dev.
 */

import { NODE_TYPE, LAYOUT_VERSION } from '../types';

// ────────────────────────────────────────────────────────
//  Validation result type
// ────────────────────────────────────────────────────────

/**
 * @typedef {Object} ValidationResult
 * @property {boolean}  valid    - true if layout is structurally sound
 * @property {string[]} errors   - List of error messages
 * @property {string[]} warnings - List of warning messages
 */

// ────────────────────────────────────────────────────────
//  Deep validation
// ────────────────────────────────────────────────────────

/**
 * Deeply validate a layout tree for structural correctness.
 *
 * @param {Object} layout - Normalised layout object
 * @returns {ValidationResult}
 */
export function deepValidateLayout(layout) {
  const errors = [];
  const warnings = [];

  if (!layout) {
    return { valid: false, errors: ['Layout is null or undefined'], warnings };
  }

  // Basic shape checks
  if (!layout.rootId) errors.push('Missing rootId');
  if (!layout.nodes || typeof layout.nodes !== 'object') errors.push('Missing or invalid nodes map');
  if (!layout.tabs || typeof layout.tabs !== 'object') errors.push('Missing or invalid tabs map');

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  const { nodes, tabs, rootId, floating = {}, popouts = {} } = layout;

  // 1. Root node must exist
  if (!nodes[rootId]) {
    errors.push(`Root node "${rootId}" not found in nodes map`);
  }

  // 2. Validate each node
  const reachable = new Set();

  function walkValidate(nodeId, expectedParentId, depth = 0) {
    if (depth > 50) {
      errors.push(`Maximum depth exceeded at node "${nodeId}" — possible cycle`);
      return;
    }

    if (reachable.has(nodeId)) {
      errors.push(`Node "${nodeId}" is referenced multiple times (cycle or duplicate child)`);
      return;
    }
    reachable.add(nodeId);

    const node = nodes[nodeId];
    if (!node) {
      errors.push(`Node "${nodeId}" referenced but not found in nodes map`);
      return;
    }

    // Parent pointer check
    if (node.parentId !== expectedParentId) {
      warnings.push(
        `Node "${nodeId}" parentId is "${node.parentId}" but expected "${expectedParentId}"`,
      );
    }

    if (node.type === NODE_TYPE.SPLIT) {
      // Split nodes must have children and sizes
      if (!Array.isArray(node.children) || node.children.length < 2) {
        errors.push(`Split node "${nodeId}" must have >= 2 children, got ${node.children?.length || 0}`);
      }
      if (!Array.isArray(node.sizes) || node.sizes.length !== node.children?.length) {
        errors.push(`Split node "${nodeId}" sizes length mismatch with children`);
      }
      if (node.sizes) {
        const sum = node.sizes.reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > 0.01) {
          warnings.push(`Split node "${nodeId}" sizes sum to ${sum.toFixed(3)}, expected ~1.0`);
        }
      }

      for (const childId of node.children || []) {
        walkValidate(childId, nodeId, depth + 1);
      }
    } else if (node.type === NODE_TYPE.TAB_GROUP) {
      // Tab group nodes must have a tabs array
      if (!Array.isArray(node.tabs)) {
        errors.push(`TabGroup node "${nodeId}" has no tabs array`);
      } else {
        // Check each tab reference
        for (const tabId of node.tabs) {
          if (!tabs[tabId]) {
            errors.push(`Tab "${tabId}" in TabGroup "${nodeId}" not found in tabs map`);
          }
        }
        // Active tab must be in the tabs array
        if (node.activeTabId && !node.tabs.includes(node.activeTabId)) {
          warnings.push(
            `TabGroup "${nodeId}" activeTabId "${node.activeTabId}" not in tabs array`,
          );
        }
        // Empty tab groups generate warnings
        if (node.tabs.length === 0) {
          warnings.push(`TabGroup "${nodeId}" has no tabs (will be cleaned up)`);
        }
      }
    } else {
      errors.push(`Node "${nodeId}" has unknown type "${node.type}"`);
    }
  }

  if (nodes[rootId]) {
    walkValidate(rootId, null);
  }

  // 3. Check for orphaned nodes (in nodes map but not reachable from root)
  for (const nodeId of Object.keys(nodes)) {
    if (!reachable.has(nodeId)) {
      warnings.push(`Orphaned node "${nodeId}" (not reachable from root)`);
    }
  }

  // 4. Check for orphaned tabs (in tabs map but not referenced by any tab group)
  const referencedTabs = new Set();
  for (const node of Object.values(nodes)) {
    if (node.type === NODE_TYPE.TAB_GROUP && Array.isArray(node.tabs)) {
      for (const tabId of node.tabs) {
        referencedTabs.add(tabId);
      }
    }
  }
  // Also check floating and popouts
  for (const f of Object.values(floating)) {
    if (f.tabId) referencedTabs.add(f.tabId);
  }
  for (const p of Object.values(popouts)) {
    if (p.tabId) referencedTabs.add(p.tabId);
  }
  for (const tabId of Object.keys(tabs)) {
    if (!referencedTabs.has(tabId)) {
      warnings.push(`Orphaned tab "${tabId}" (not referenced by any node)`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ────────────────────────────────────────────────────────
//  Auto-repair
// ────────────────────────────────────────────────────────

/**
 * Attempt to repair common layout issues.
 *
 * @param {Object} layout - Normalised layout (will NOT be mutated)
 * @returns {{ layout: Object, repairs: string[] }} repaired copy + log
 */
export function repairLayout(layout) {
  const repairs = [];
  if (!layout || !layout.nodes || !layout.rootId) {
    repairs.push('Layout is too broken to repair — returning empty layout');
    return {
      layout: {
        version: LAYOUT_VERSION,
        rootId: null,
        nodes: {},
        tabs: {},
        floating: {},
        popouts: {},
        maximizedNodeId: null,
        focusedTabGroupId: null,
        dragSourceTabId: null,
      },
      repairs,
    };
  }

  // Work on a deep copy
  const repaired = JSON.parse(JSON.stringify(layout));

  // 1. Fix parent pointers
  function fixParents(nodeId, expectedParent) {
    const node = repaired.nodes[nodeId];
    if (!node) return;
    if (node.parentId !== expectedParent) {
      repairs.push(`Fixed parentId of "${nodeId}": "${node.parentId}" → "${expectedParent}"`);
      node.parentId = expectedParent;
    }
    if (node.type === NODE_TYPE.SPLIT && Array.isArray(node.children)) {
      for (const childId of node.children) {
        fixParents(childId, nodeId);
      }
    }
  }
  fixParents(repaired.rootId, null);

  // 2. Remove dangling child references
  for (const [nodeId, node] of Object.entries(repaired.nodes)) {
    if (node.type === NODE_TYPE.SPLIT && Array.isArray(node.children)) {
      const validChildren = node.children.filter((cid) => repaired.nodes[cid]);
      if (validChildren.length !== node.children.length) {
        const removed = node.children.filter((cid) => !repaired.nodes[cid]);
        repairs.push(`Removed dangling children from "${nodeId}": ${removed.join(', ')}`);
        node.children = validChildren;
        node.sizes = validChildren.map(() => 1 / validChildren.length);
      }
    }
  }

  // 3. Normalise sizes
  for (const [nodeId, node] of Object.entries(repaired.nodes)) {
    if (node.type === NODE_TYPE.SPLIT && Array.isArray(node.sizes)) {
      const sum = node.sizes.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.01 && sum > 0) {
        repairs.push(`Re-normalised sizes for "${nodeId}" (was ${sum.toFixed(3)})`);
        node.sizes = node.sizes.map((s) => s / sum);
      }
    }
  }

  // 4. Fix empty tab groups — remove orphaned tab refs
  for (const [nodeId, node] of Object.entries(repaired.nodes)) {
    if (node.type === NODE_TYPE.TAB_GROUP && Array.isArray(node.tabs)) {
      const valid = node.tabs.filter((tid) => repaired.tabs[tid]);
      if (valid.length !== node.tabs.length) {
        repairs.push(`Removed dangling tab refs from "${nodeId}"`);
        node.tabs = valid;
      }
      if (node.activeTabId && !valid.includes(node.activeTabId)) {
        node.activeTabId = valid[0] || null;
        repairs.push(`Reset activeTabId for "${nodeId}"`);
      }
    }
  }

  // 5. Remove orphaned nodes
  const reachable = new Set();
  function markReachable(nodeId) {
    if (!nodeId || reachable.has(nodeId)) return;
    reachable.add(nodeId);
    const node = repaired.nodes[nodeId];
    if (node?.type === NODE_TYPE.SPLIT && Array.isArray(node.children)) {
      for (const cid of node.children) markReachable(cid);
    }
  }
  markReachable(repaired.rootId);
  for (const nodeId of Object.keys(repaired.nodes)) {
    if (!reachable.has(nodeId)) {
      repairs.push(`Removed orphaned node "${nodeId}"`);
      delete repaired.nodes[nodeId];
    }
  }

  // 6. Remove orphaned tabs
  const referencedTabs = new Set();
  for (const node of Object.values(repaired.nodes)) {
    if (node.type === NODE_TYPE.TAB_GROUP) {
      for (const tid of node.tabs || []) referencedTabs.add(tid);
    }
  }
  for (const f of Object.values(repaired.floating || {})) {
    if (f.tabId) referencedTabs.add(f.tabId);
  }
  for (const p of Object.values(repaired.popouts || {})) {
    if (p.tabId) referencedTabs.add(p.tabId);
  }
  for (const tabId of Object.keys(repaired.tabs)) {
    if (!referencedTabs.has(tabId)) {
      repairs.push(`Removed orphaned tab "${tabId}"`);
      delete repaired.tabs[tabId];
    }
  }

  return { layout: repaired, repairs };
}
