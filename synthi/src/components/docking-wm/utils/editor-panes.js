/**
 * @fileoverview Pure helpers for projecting the layout's editor tabgroups
 * into ordered "panes" with stable numbers and colors. Consumed by the
 * shared TopNav tab strip and the per-pane header strips.
 */
import { NODE_TYPE } from '../types';
import { walkTree } from './layout-query';

const EDITOR = 'editor';

/**
 * Pane color palette. Index 0 (pane 1) is the existing muted/gray token so
 * the original editor keeps its current look; subsequent panes get distinct
 * hues. Tokens map to CSS variables defined in globals.css (Task 7).
 */
export const PANE_PALETTE = [
  'var(--pane-color-1)', // gray   (pane 1 — matches today's active underline)
  'var(--pane-color-2)', // blue   (pane 2)
  'var(--pane-color-3)', // teal   (pane 3)
  'var(--pane-color-4)', // amber  (pane 4)
  'var(--pane-color-5)', // purple (pane 5)
];

/** Color token for a 0-based pane index, cycling past the palette length. */
export function getPaneColor(index) {
  if (!Number.isInteger(index) || index < 0) return PANE_PALETTE[0];
  return PANE_PALETTE[index % PANE_PALETTE.length];
}

/** Is this tabgroup an editor pane (its active/any tab is an editor)? */
function isEditorGroup(layout, node) {
  if (!node || node.type !== NODE_TYPE.TAB_GROUP) return false;
  return (node.tabs || []).some((tid) => layout.tabs?.[tid]?.panelType === EDITOR);
}

/** The editor tab object that defines a pane's current file. */
function editorTabOf(layout, node) {
  const tabs = node.tabs || [];
  const active = tabs.find((tid) => tid === node.activeTabId && layout.tabs?.[tid]?.panelType === EDITOR);
  const id = active || tabs.find((tid) => layout.tabs?.[tid]?.panelType === EDITOR);
  return id ? layout.tabs[id] : null;
}

/** Editor pane node IDs in stable DFS (left→right / top→bottom) order. */
export function getEditorPaneIds(layout) {
  if (!layout || !layout.rootId) return [];
  const ids = [];
  walkTree(layout, layout.rootId, (node) => {
    if (isEditorGroup(layout, node)) ids.push(node.id);
  });
  return ids;
}

/** Ordered panes: { paneId, number, filePath, color }. */
export function getEditorPanes(layout) {
  return getEditorPaneIds(layout).map((paneId, i) => ({
    paneId,
    number: i + 1,
    filePath: editorTabOf(layout, layout.nodes[paneId])?.data?.filePath ?? null,
    color: getPaneColor(i),
  }));
}

/** Panes currently displaying a given file path, in order. */
export function getPanesForFile(layout, filePath) {
  if (!filePath) return [];
  return getEditorPanes(layout)
    .filter((p) => p.filePath === filePath)
    .map(({ paneId, number, color }) => ({ paneId, number, color }));
}
