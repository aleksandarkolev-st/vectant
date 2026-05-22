/**
 * Pure decisions linking the global workspace file model to the docking
 * editor panes. Kept dependency-free so it is unit-testable in isolation.
 */
import { getEditorPaneIds, getEditorPanes } from '@/components/docking-wm/utils/editor-panes';

/** Which editor pane should receive a newly opened file (the focused one). */
export function resolveOpenTarget(layout) {
  const ids = getEditorPaneIds(layout);
  const focused = layout?.focusedTabGroupId;
  return focused && ids.includes(focused) ? focused : (ids[0] ?? null);
}

/** The file path the global activeFile should mirror (focused pane's file). */
export function resolveMirrorFile(layout) {
  const target = resolveOpenTarget(layout);
  if (!target) return null;
  return getEditorPanes(layout).find((p) => p.paneId === target)?.filePath ?? null;
}
