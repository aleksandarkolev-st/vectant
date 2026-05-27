'use client';

/**
 * EditorPaneHeader
 *
 * Thin strip shown between the navbar and an editor pane's content when the
 * editor is split (>= 2 panes). Displays the pane's number (in its palette
 * color) and the breadcrumb of the file that pane currently shows, so the
 * user can tell which pane is which. Renders nothing for a single pane.
 */

import { memo, useCallback } from 'react';
import { X } from 'lucide-react';
import { useAppSelector, useAppDispatch } from '@/redux/hooks';
import {
  selectEditorPanes, selectNode, closeTabAction,
} from '@/components/docking-wm/state/layout-slice';

export const EditorPaneHeader = memo(function EditorPaneHeader({ paneId, filePath }) {
  const panes = useAppSelector(selectEditorPanes);
  const group = useAppSelector((s) => selectNode(s, paneId));
  const dispatch = useAppDispatch();

  // Close this split pane: drop its editor tab (forceClose, since editor
  // tabs are non-closable by default) — cleanupEmptyNodes then collapses
  // the now-empty group and merges the freed space back into its sibling.
  const handleClose = useCallback((e) => {
    e.stopPropagation();
    const editorTabId = (group?.tabs || []).find(
      (tid) => tid === group?.activeTabId,
    ) || (group?.tabs || [])[0];
    if (editorTabId) dispatch(closeTabAction({ tabId: editorTabId, forceClose: true }));
  }, [group, dispatch]);

  // Only show once the editor is actually split.
  if (panes.length < 2) return null;
  const pane = panes.find((p) => p.paneId === paneId);
  if (!pane) return null;

  const crumb = (filePath || '').split('/').filter(Boolean);

  return (
    <div
      className="flex items-center gap-1.5 px-2 shrink-0 text-[11px] select-none overflow-hidden"
      style={{
        height: 'var(--editor-pane-header-h)',
        borderBottom: '1px solid var(--border-subtle)',
        color: 'var(--text-muted)',
        background: 'var(--bg-editor)',
      }}
    >
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center text-[9px] leading-none rounded-[3px] px-1 h-3.5 min-w-[14px] shrink-0"
        style={{ color: pane.color, border: `1px solid ${pane.color}` }}
      >
        {pane.number}
      </span>
      <span className="truncate" title={filePath || ''}>
        {crumb.length ? crumb.join(' › ') : 'No file'}
      </span>
      <button
        type="button"
        onClick={handleClose}
        title="Close pane"
        aria-label={`Close pane ${pane.number}`}
        className="ml-auto shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-[3px] th-focus-ring"
        style={{ color: 'var(--text-muted)' }}
      >
        <X className="w-3 h-3" strokeWidth={2} />
      </button>
    </div>
  );
});

export default EditorPaneHeader;
