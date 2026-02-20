'use client';

/**
 * @fileoverview Pre-built workspace layout presets.
 *
 * Each preset returns a full normalised layout tree that can be
 * passed directly to `setLayout()` or stored as a workspace profile.
 *
 * Presets use the IDE_PANEL constants so panel types stay consistent
 * across the codebase.
 */

import {
  createSplitNode,
  createTabGroupNode,
  createTab,
  createEmptyLayout,
  normalizeSizes,
  generateId,
  nodeId,
} from '../utils';

import { IDE_PANEL } from './ide-panels';

// ────────────────────────────────────────────────────────
//  Helper: build a layout from a simple DSL
// ────────────────────────────────────────────────────────

/**
 * Insert a node into a flat nodes map and return it.
 */
function addNode(layout, node) {
  layout.nodes[node.id] = node;
  return node;
}

function addTab(layout, tab) {
  layout.tabs[tab.id] = tab;
  return tab;
}

// ────────────────────────────────────────────────────────
//  1. Classic IDE Layout
//  ┌──────┬──────────────────────┐
//  │      │                      │
//  │ Side │       Editor         │
//  │ bar  │                      │
//  │      ├──────────────────────┤
//  │      │  Terminal / Problems │
//  └──────┴──────────────────────┘
// ────────────────────────────────────────────────────────

export function createClassicLayout() {
  const layout = createEmptyLayout();

  // Create tabs
  const explorerTab = addTab(layout, createTab({ panelType: IDE_PANEL.EXPLORER, title: 'Explorer' }));
  const searchTab = addTab(layout, createTab({ panelType: IDE_PANEL.SEARCH, title: 'Search' }));
  const gitTab = addTab(layout, createTab({ panelType: IDE_PANEL.GIT, title: 'Source Control' }));
  const extensionsTab = addTab(layout, createTab({ panelType: IDE_PANEL.EXTENSIONS, title: 'Extensions' }));
  const welcomeTab = addTab(layout, createTab({ panelType: IDE_PANEL.EDITOR, title: 'Editor' }));
  const terminalTab = addTab(layout, createTab({ panelType: IDE_PANEL.TERMINAL, title: 'Terminal' }));

  // Sidebar tab group
  const sidebarGroup = addNode(layout, createTabGroupNode({
    tabs: [explorerTab.id, searchTab.id, gitTab.id, extensionsTab.id],
    activeTabId: explorerTab.id,
  }));

  // Editor tab group
  const editorGroup = addNode(layout, createTabGroupNode({
    tabs: [welcomeTab.id],
    activeTabId: welcomeTab.id,
  }));

  // Bottom panel tab group (terminal only — Problems is a separate dockable panel)
  const bottomGroup = addNode(layout, createTabGroupNode({
    tabs: [terminalTab.id],
    activeTabId: terminalTab.id,
  }));

  // Right column: editor on top, bottom panel below
  const rightCol = addNode(layout, createSplitNode({
    direction: 'column',
    children: [editorGroup.id, bottomGroup.id],
    sizes: normalizeSizes([0.72, 0.28]),
  }));
  editorGroup.parentId = rightCol.id;
  bottomGroup.parentId = rightCol.id;

  // Root: sidebar left, right column
  const root = addNode(layout, createSplitNode({
    direction: 'row',
    children: [sidebarGroup.id, rightCol.id],
    sizes: normalizeSizes([0.20, 0.80]),
  }));
  sidebarGroup.parentId = root.id;
  rightCol.parentId = root.id;

  layout.rootId = root.id;
  layout.focusedTabGroupId = editorGroup.id;

  return layout;
}

// ────────────────────────────────────────────────────────
//  2. Focus Mode Layout
//  ┌────────────────────────────┐
//  │                            │
//  │          Editor            │
//  │                            │
//  └────────────────────────────┘
// ────────────────────────────────────────────────────────

export function createFocusLayout() {
  const layout = createEmptyLayout();

  const editorTab = addTab(layout, createTab({ panelType: IDE_PANEL.EDITOR, title: 'Editor' }));
  const editorGroup = addNode(layout, createTabGroupNode({
    tabs: [editorTab.id],
    activeTabId: editorTab.id,
  }));

  layout.rootId = editorGroup.id;
  layout.focusedTabGroupId = editorGroup.id;
  editorGroup.parentId = null;

  return layout;
}

// ────────────────────────────────────────────────────────
//  3. Side-by-Side Editors
//  ┌──────┬──────────┬──────────┐
//  │      │ Editor 1 │ Editor 2 │
//  │ Side │          │          │
//  │ bar  ├──────────┴──────────┤
//  │      │      Terminal       │
//  └──────┴─────────────────────┘
// ────────────────────────────────────────────────────────

export function createSideBySideLayout() {
  const layout = createEmptyLayout();

  const explorerTab = addTab(layout, createTab({ panelType: IDE_PANEL.EXPLORER, title: 'Explorer' }));
  const editor1Tab = addTab(layout, createTab({ panelType: IDE_PANEL.EDITOR, title: 'File 1' }));
  const editor2Tab = addTab(layout, createTab({ panelType: IDE_PANEL.EDITOR, title: 'File 2' }));
  const terminalTab = addTab(layout, createTab({ panelType: IDE_PANEL.TERMINAL, title: 'Terminal' }));

  const sidebarGroup = addNode(layout, createTabGroupNode({
    tabs: [explorerTab.id],
    activeTabId: explorerTab.id,
  }));

  const leftEditor = addNode(layout, createTabGroupNode({
    tabs: [editor1Tab.id],
    activeTabId: editor1Tab.id,
  }));

  const rightEditor = addNode(layout, createTabGroupNode({
    tabs: [editor2Tab.id],
    activeTabId: editor2Tab.id,
  }));

  const bottomGroup = addNode(layout, createTabGroupNode({
    tabs: [terminalTab.id],
    activeTabId: terminalTab.id,
  }));

  // Editors side by side
  const editorRow = addNode(layout, createSplitNode({
    direction: 'row',
    children: [leftEditor.id, rightEditor.id],
    sizes: normalizeSizes([0.50, 0.50]),
  }));
  leftEditor.parentId = editorRow.id;
  rightEditor.parentId = editorRow.id;

  // Right column: editors + bottom
  const rightCol = addNode(layout, createSplitNode({
    direction: 'column',
    children: [editorRow.id, bottomGroup.id],
    sizes: normalizeSizes([0.75, 0.25]),
  }));
  editorRow.parentId = rightCol.id;
  bottomGroup.parentId = rightCol.id;

  // Root
  const root = addNode(layout, createSplitNode({
    direction: 'row',
    children: [sidebarGroup.id, rightCol.id],
    sizes: normalizeSizes([0.18, 0.82]),
  }));
  sidebarGroup.parentId = root.id;
  rightCol.parentId = root.id;

  layout.rootId = root.id;
  layout.focusedTabGroupId = leftEditor.id;

  return layout;
}

// ────────────────────────────────────────────────────────
//  4. AI-Assisted Layout (editor + chat side by side)
//  ┌──────┬──────────┬──────────┐
//  │      │          │          │
//  │ Side │  Editor  │ AI Chat  │
//  │ bar  │          │          │
//  │      ├──────────┴──────────┤
//  │      │  Terminal / Probs   │
//  └──────┴─────────────────────┘
// ────────────────────────────────────────────────────────

export function createAIAssistedLayout() {
  const layout = createEmptyLayout();

  const explorerTab = addTab(layout, createTab({ panelType: IDE_PANEL.EXPLORER, title: 'Explorer' }));
  const editorTab = addTab(layout, createTab({ panelType: IDE_PANEL.EDITOR, title: 'Editor' }));
  const chatTab = addTab(layout, createTab({ panelType: IDE_PANEL.CHAT, title: 'AI Chat' }));
  const terminalTab = addTab(layout, createTab({ panelType: IDE_PANEL.TERMINAL, title: 'Terminal' }));

  const sidebarGroup = addNode(layout, createTabGroupNode({
    tabs: [explorerTab.id],
    activeTabId: explorerTab.id,
  }));

  const editorGroup = addNode(layout, createTabGroupNode({
    tabs: [editorTab.id],
    activeTabId: editorTab.id,
  }));

  const chatGroup = addNode(layout, createTabGroupNode({
    tabs: [chatTab.id],
    activeTabId: chatTab.id,
  }));

  const bottomGroup = addNode(layout, createTabGroupNode({
    tabs: [terminalTab.id],
    activeTabId: terminalTab.id,
  }));

  // Editor + Chat side by side
  const editorChatRow = addNode(layout, createSplitNode({
    direction: 'row',
    children: [editorGroup.id, chatGroup.id],
    sizes: normalizeSizes([0.65, 0.35]),
  }));
  editorGroup.parentId = editorChatRow.id;
  chatGroup.parentId = editorChatRow.id;

  // Right column
  const rightCol = addNode(layout, createSplitNode({
    direction: 'column',
    children: [editorChatRow.id, bottomGroup.id],
    sizes: normalizeSizes([0.72, 0.28]),
  }));
  editorChatRow.parentId = rightCol.id;
  bottomGroup.parentId = rightCol.id;

  // Root
  const root = addNode(layout, createSplitNode({
    direction: 'row',
    children: [sidebarGroup.id, rightCol.id],
    sizes: normalizeSizes([0.18, 0.82]),
  }));
  sidebarGroup.parentId = root.id;
  rightCol.parentId = root.id;

  layout.rootId = root.id;
  layout.focusedTabGroupId = editorGroup.id;

  return layout;
}

// ────────────────────────────────────────────────────────
//  5. Three-Column Layout (sidebar + editor + secondary)
//  ┌──────┬──────────┬──────────┐
//  │      │          │          │
//  │ Side │  Editor  │ Secon-   │
//  │ bar  │          │ dary     │
//  │      │          │          │
//  └──────┴──────────┴──────────┘
// ────────────────────────────────────────────────────────

export function createThreeColumnLayout() {
  const layout = createEmptyLayout();

  const explorerTab = addTab(layout, createTab({ panelType: IDE_PANEL.EXPLORER, title: 'Explorer' }));
  const gitTab = addTab(layout, createTab({ panelType: IDE_PANEL.GIT, title: 'Source Control' }));
  const editorTab = addTab(layout, createTab({ panelType: IDE_PANEL.EDITOR, title: 'Editor' }));
  const chatTab = addTab(layout, createTab({ panelType: IDE_PANEL.CHAT, title: 'AI Chat' }));

  const sidebarGroup = addNode(layout, createTabGroupNode({
    tabs: [explorerTab.id, gitTab.id],
    activeTabId: explorerTab.id,
  }));

  const editorGroup = addNode(layout, createTabGroupNode({
    tabs: [editorTab.id],
    activeTabId: editorTab.id,
  }));

  const secondaryGroup = addNode(layout, createTabGroupNode({
    tabs: [chatTab.id],
    activeTabId: chatTab.id,
  }));

  const root = addNode(layout, createSplitNode({
    direction: 'row',
    children: [sidebarGroup.id, editorGroup.id, secondaryGroup.id],
    sizes: normalizeSizes([0.18, 0.52, 0.30]),
  }));
  sidebarGroup.parentId = root.id;
  editorGroup.parentId = root.id;
  secondaryGroup.parentId = root.id;

  layout.rootId = root.id;
  layout.focusedTabGroupId = editorGroup.id;

  return layout;
}

// ────────────────────────────────────────────────────────
//  Preset registry
// ────────────────────────────────────────────────────────

/**
 * @typedef {Object} LayoutPreset
 * @property {string}   id          - Unique key
 * @property {string}   name        - Display name
 * @property {string}   description - Short description
 * @property {string}   icon        - Icon identifier
 * @property {Function} create      - Factory returning a normalised layout
 */

/** @type {LayoutPreset[]} */
export const LAYOUT_PRESETS = [
  {
    id: 'classic',
    name: 'Classic IDE',
    description: 'Sidebar + Editor + Bottom Panel',
    icon: 'layout',
    create: createClassicLayout,
  },
  {
    id: 'focus',
    name: 'Focus Mode',
    description: 'Full-screen editor, no distractions',
    icon: 'maximize',
    create: createFocusLayout,
  },
  {
    id: 'side-by-side',
    name: 'Side-by-Side Editors',
    description: 'Two editors with sidebar & terminal',
    icon: 'columns',
    create: createSideBySideLayout,
  },
  {
    id: 'ai-assisted',
    name: 'AI-Assisted',
    description: 'Editor + AI Chat with bottom panel',
    icon: 'sparkles',
    create: createAIAssistedLayout,
  },
  {
    id: 'three-column',
    name: 'Three Column',
    description: 'Sidebar + Editor + Secondary panel',
    icon: 'layout-grid',
    create: createThreeColumnLayout,
  },
];

/**
 * Get a preset by its ID.
 * @param {string} id - Preset ID
 * @returns {LayoutPreset | undefined}
 */
export function getPreset(id) {
  return LAYOUT_PRESETS.find(p => p.id === id);
}

/**
 * Create a layout from a preset ID.
 * Falls back to classic if the preset is not found.
 * @param {string} id - Preset ID
 * @returns {import('../types').NormalisedLayout}
 */
export function createLayoutFromPreset(id) {
  const preset = getPreset(id);
  return preset ? preset.create() : createClassicLayout();
}
