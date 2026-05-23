'use client';

/**
 * EditorPaneHeader
 *
 * Thin strip shown between the navbar and an editor pane's content when the
 * editor is split (>= 2 panes). Displays the pane's number (in its palette
 * color) and the breadcrumb of the file that pane currently shows, so the
 * user can tell which pane is which. Renders nothing for a single pane.
 */

import { memo } from 'react';
import { useAppSelector } from '@/redux/hooks';
import { selectEditorPanes } from '@/components/docking-wm/state/layout-slice';

export const EditorPaneHeader = memo(function EditorPaneHeader({ paneId, filePath }) {
  const panes = useAppSelector(selectEditorPanes);
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
    </div>
  );
});

export default EditorPaneHeader;
