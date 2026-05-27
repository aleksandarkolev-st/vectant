import { describe, it, expect } from 'vitest';
import reducer, {
  splitEditorPanel,
  setPaneFile,
  selectEditorPanes,
  selectFocusedEditorPaneId,
} from '../layout-slice';
import { getEditorPaneIds } from '../../utils/editor-panes';

// One editor pane showing a.java, focused.
function onePane() {
  return {
    version: 4,
    rootId: 'g1',
    nodes: { g1: { id: 'g1', type: 'tabgroup', tabs: ['t1'], activeTabId: 't1', parentId: null } },
    tabs: { t1: { id: 't1', panelType: 'editor', title: '', closable: false, data: { filePath: 'a.java' } } },
    floating: {}, popouts: {}, maximizedNodeId: null, focusedTabGroupId: 'g1', dragSourceTabId: null,
  };
}

describe('layout-slice editor split', () => {
  it('split copies the source pane file into the new pane and focuses it', () => {
    const next = reducer(onePane(), splitEditorPanel({ zone: 'right' }));
    const paneIds = getEditorPaneIds(next);
    expect(paneIds).toHaveLength(2);
    const panes = selectEditorPanes({ layout: next });
    expect(panes.map((p) => p.filePath)).toEqual(['a.java', 'a.java']);
    expect(next.focusedTabGroupId).toBe(paneIds[1]);
  });

  it('splits to N panes (no 2-pane cap)', () => {
    let s = reducer(onePane(), splitEditorPanel({ zone: 'right' }));
    s = reducer(s, splitEditorPanel({ zone: 'right' }));
    expect(getEditorPaneIds(s)).toHaveLength(3);
  });

  it('vertical split produces a column split', () => {
    const next = reducer(onePane(), splitEditorPanel({ zone: 'bottom' }));
    const cols = Object.values(next.nodes).filter((n) => n.type === 'split' && n.direction === 'column');
    expect(cols).toHaveLength(1);
  });

  it('setPaneFile updates only the targeted pane editor tab filePath', () => {
    let s = reducer(onePane(), splitEditorPanel({ zone: 'right' }));
    const [p1, p2] = getEditorPaneIds(s);
    s = reducer(s, setPaneFile({ paneId: p2, filePath: 'b.java' }));
    const panes = selectEditorPanes({ layout: s });
    expect(panes.find((p) => p.paneId === p1).filePath).toBe('a.java');
    expect(panes.find((p) => p.paneId === p2).filePath).toBe('b.java');
  });

  it('selectFocusedEditorPaneId falls back to first pane when focus is non-editor', () => {
    const s = onePane();
    s.focusedTabGroupId = 'nonexistent';
    expect(selectFocusedEditorPaneId({ layout: s })).toBe('g1');
  });
});
