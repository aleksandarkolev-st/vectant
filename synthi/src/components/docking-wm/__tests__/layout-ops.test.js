/**
 * @fileoverview Test suite for docking layout operations.
 *
 * Tests cover:
 * - Node creation (split, tab group, tab)
 * - Tree operations (split, move, close, resize)
 * - Layout validation and repair
 * - Serialization round-trips
 *
 * Run with: npx vitest run --config vitest.config.mjs src/components/docking-wm
 *   or:    node --experimental-vm-modules node_modules/.bin/jest
 */

import { describe, it, expect } from 'vitest';
import {
  createSplitNode,
  createTabGroupNode,
  createTab,
  createEmptyLayout,
  createDefaultIDELayout,
  normalizeSizes,
} from '../utils/layout-node';
import {
  getNode,
  getParent,
  getAllTabGroups,
  findTabGroup,
  walkTree,
  validateLayout,
  collectTabIds,
  countTabGroups,
} from '../utils/layout-query';
import {
  splitNode,
  addTabToGroup,
  closeTab,
  moveTab,
  resizeSplit,
  toggleMaximize,
  cleanupEmptyNodes,
} from '../utils/layout-ops';
import {
  deepValidateLayout,
  repairLayout,
} from '../utils/layout-validation';
import {
  serializeLayout,
  deserializeLayout,
} from '../utils/serialization';
import { NODE_TYPE, DIRECTION } from '../types';

// ────────────────────────────────────────────────────────
//  Fixtures
// ────────────────────────────────────────────────────────

function createTestLayout() {
  const layout = createEmptyLayout();
  layout.nodes = {};
  layout.rootId = null;
  layout.focusedTabGroupId = null;

  const tab1 = createTab({ panelType: 'explorer', title: 'Explorer' });
  const tab2 = createTab({ panelType: 'editor', title: 'File.js' });
  const tab3 = createTab({ panelType: 'terminal', title: 'Terminal' });

  layout.tabs[tab1.id] = tab1;
  layout.tabs[tab2.id] = tab2;
  layout.tabs[tab3.id] = tab3;

  const leftGroup = createTabGroupNode({ tabs: [tab1.id], activeTabId: tab1.id });
  const rightGroup = createTabGroupNode({ tabs: [tab2.id], activeTabId: tab2.id });
  const bottomGroup = createTabGroupNode({ tabs: [tab3.id], activeTabId: tab3.id });

  layout.nodes[leftGroup.id] = leftGroup;
  layout.nodes[rightGroup.id] = rightGroup;
  layout.nodes[bottomGroup.id] = bottomGroup;

  const rightCol = createSplitNode({
    direction: 'column',
    children: [rightGroup.id, bottomGroup.id],
    sizes: [0.7, 0.3],
  });
  rightGroup.parentId = rightCol.id;
  bottomGroup.parentId = rightCol.id;
  layout.nodes[rightCol.id] = rightCol;

  const root = createSplitNode({
    direction: 'row',
    children: [leftGroup.id, rightCol.id],
    sizes: [0.25, 0.75],
  });
  leftGroup.parentId = root.id;
  rightCol.parentId = root.id;
  layout.nodes[root.id] = root;

  layout.rootId = root.id;
  layout.focusedTabGroupId = rightGroup.id;

  return { layout, tab1, tab2, tab3, leftGroup, rightGroup, bottomGroup, rightCol, root };
}

// ────────────────────────────────────────────────────────
//  Node Creation Tests
// ────────────────────────────────────────────────────────

describe('Node Creation', () => {
  it('creates a split node with correct type and direction', () => {
    const node = createSplitNode({ direction: 'row', children: ['a', 'b'], sizes: [0.5, 0.5] });
    expect(node.type).toBe(NODE_TYPE.SPLIT);
    expect(node.direction).toBe(DIRECTION.ROW);
    expect(node.children).toEqual(['a', 'b']);
    expect(node.sizes).toEqual([0.5, 0.5]);
    expect(node.id).toBeTruthy();
  });

  it('creates a tab group node with tabs', () => {
    const node = createTabGroupNode({ tabs: ['t1', 't2'], activeTabId: 't1' });
    expect(node.type).toBe(NODE_TYPE.TAB_GROUP);
    expect(node.tabs).toEqual(['t1', 't2']);
    expect(node.activeTabId).toBe('t1');
  });

  it('creates a tab with panelType and unique id', () => {
    const tab = createTab({ panelType: 'editor', title: 'Test' });
    expect(tab.panelType).toBe('editor');
    expect(tab.title).toBe('Test');
    expect(tab.id).toMatch(/^tab-/);
  });

  it('normalizeSizes sums to 1', () => {
    const sizes = normalizeSizes([1, 2, 3]);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
    expect(sizes[0]).toBeCloseTo(1 / 6);
  });
});

// ────────────────────────────────────────────────────────
//  Tree Query Tests
// ────────────────────────────────────────────────────────

describe('Tree Queries', () => {
  it('getNode returns the correct node', () => {
    const { layout, root } = createTestLayout();
    expect(getNode(layout, root.id).type).toBe(NODE_TYPE.SPLIT);
  });

  it('getParent returns the parent node', () => {
    const { layout, leftGroup, root } = createTestLayout();
    const parent = getParent(layout, leftGroup.id);
    expect(parent.id).toBe(root.id);
  });

  it('getAllTabGroups finds all tab groups', () => {
    const { layout } = createTestLayout();
    const groups = getAllTabGroups(layout);
    expect(groups).toHaveLength(3);
  });

  it('findTabGroup locates a tab by ID', () => {
    const { layout, tab2, rightGroup } = createTestLayout();
    const found = findTabGroup(layout, tab2.id);
    expect(found?.id).toBe(rightGroup.id);
  });

  it('collectTabIds returns all tab IDs', () => {
    const { layout } = createTestLayout();
    const tabIds = collectTabIds(layout, layout.rootId);
    expect(tabIds).toHaveLength(3);
  });

  it('countTabGroups returns correct count', () => {
    const { layout } = createTestLayout();
    expect(countTabGroups(layout)).toBe(3);
  });

  it('walkTree visits all nodes', () => {
    const { layout } = createTestLayout();
    const visited = [];
    walkTree(layout, layout.rootId, (node) => visited.push(node.id));
    // 2 split nodes + 3 tab groups = 5
    expect(visited).toHaveLength(5);
  });
});

// ────────────────────────────────────────────────────────
//  Tree Operation Tests
// ────────────────────────────────────────────────────────

describe('Tree Operations', () => {
  it('splitNode creates a new split with two children', () => {
    const { layout, rightGroup } = createTestLayout();
    const newTab = createTab({ panelType: 'editor', title: 'Split' });
    const result = splitNode(layout, rightGroup.id, 'row', newTab);

    expect(result).toBeTruthy();
    // The original rightGroup should now be a child of a new split node
    const groups = getAllTabGroups(result);
    expect(groups.length).toBeGreaterThanOrEqual(4);
  });

  it('addTabToGroup adds a tab to existing group', () => {
    const { layout, leftGroup } = createTestLayout();
    const newTab = createTab({ panelType: 'search', title: 'Search' });
    layout.tabs[newTab.id] = newTab;
    const result = addTabToGroup(layout, leftGroup.id, newTab.id);

    expect(result.nodes[leftGroup.id].tabs).toContain(newTab.id);
    expect(result.nodes[leftGroup.id].activeTabId).toBe(newTab.id);
  });

  it('closeTab removes a tab and updates activeTabId', () => {
    const { layout, leftGroup, tab1 } = createTestLayout();
    // First add another tab so closing one doesn't empty the group
    const newTab = createTab({ panelType: 'search', title: 'Search' });
    layout.tabs[newTab.id] = newTab;
    layout.nodes[leftGroup.id].tabs.push(newTab.id);

    const result = closeTab(layout, tab1.id);
    expect(result.nodes[leftGroup.id].tabs).not.toContain(tab1.id);
    expect(result.nodes[leftGroup.id].activeTabId).toBe(newTab.id);
  });

  it('resizeSplit updates sizes array', () => {
    const { layout, root } = createTestLayout();
    const result = resizeSplit(layout, root.id, 0, 0.05);
    expect(result.nodes[root.id].sizes[0]).toBeCloseTo(0.30);
    expect(result.nodes[root.id].sizes[1]).toBeCloseTo(0.70);
  });
});

// ────────────────────────────────────────────────────────
//  Validation Tests
// ────────────────────────────────────────────────────────

describe('Layout Validation', () => {
  it('validates a correct layout', () => {
    const { layout } = createTestLayout();
    const result = deepValidateLayout(layout);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects missing root node', () => {
    const layout = createEmptyLayout();
    layout.rootId = 'nonexistent';
    const result = deepValidateLayout(layout);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Root node'))).toBe(true);
  });

  it('detects dangling tab references', () => {
    const { layout, rightGroup } = createTestLayout();
    layout.nodes[rightGroup.id].tabs.push('nonexistent-tab');
    const result = deepValidateLayout(layout);
    expect(result.errors.some(e => e.includes('nonexistent-tab'))).toBe(true);
  });

  it('repairLayout fixes dangling tabs', () => {
    const { layout, rightGroup } = createTestLayout();
    layout.nodes[rightGroup.id].tabs.push('ghost-tab');
    const { layout: repaired, repairs } = repairLayout(layout);
    expect(repairs.length).toBeGreaterThan(0);
    expect(repaired.nodes[rightGroup.id].tabs).not.toContain('ghost-tab');
  });

  it('repairLayout fixes parent pointers', () => {
    const { layout, leftGroup } = createTestLayout();
    layout.nodes[leftGroup.id].parentId = 'wrong-parent';
    const { layout: repaired, repairs } = repairLayout(layout);
    expect(repairs.some(r => r.includes('parentId'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────
//  Serialization Tests
// ────────────────────────────────────────────────────────

describe('Serialization', () => {
  it('round-trips a layout through serialize/deserialize', () => {
    const { layout } = createTestLayout();
    const json = serializeLayout(layout);
    const restored = deserializeLayout(json);
    expect(restored.rootId).toBe(layout.rootId);
    expect(Object.keys(restored.nodes)).toHaveLength(Object.keys(layout.nodes).length);
    expect(Object.keys(restored.tabs)).toHaveLength(Object.keys(layout.tabs).length);
  });
});

// ────────────────────────────────────────────────────────
//  Default IDE Layout
// ────────────────────────────────────────────────────────

describe('Default IDE Layout', () => {
  it('creates a valid layout', () => {
    const layout = createDefaultIDELayout({
      sidebarTabs: [createTab({ panelType: 'explorer', title: 'Explorer' })],
      editorTabs: [createTab({ panelType: 'editor', title: 'Welcome' })],
      bottomTabs: [createTab({ panelType: 'terminal', title: 'Terminal' })],
    });
    const result = deepValidateLayout(layout);
    expect(result.valid).toBe(true);
    expect(countTabGroups(layout)).toBe(3);
  });
});
