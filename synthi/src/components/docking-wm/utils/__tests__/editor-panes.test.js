import { describe, it, expect } from 'vitest';
import {
  PANE_PALETTE,
  getPaneColor,
  getEditorPaneIds,
  getEditorPanes,
  getPanesForFile,
} from '../editor-panes';

// Minimal layout: a row split with two editor tabgroups.
function twoPaneLayout() {
  return {
    rootId: 'split1',
    nodes: {
      split1: { id: 'split1', type: 'split', direction: 'row', children: ['g1', 'g2'], sizes: [0.5, 0.5], parentId: null },
      g1: { id: 'g1', type: 'tabgroup', tabs: ['t1'], activeTabId: 't1', parentId: 'split1' },
      g2: { id: 'g2', type: 'tabgroup', tabs: ['t2'], activeTabId: 't2', parentId: 'split1' },
    },
    tabs: {
      t1: { id: 't1', panelType: 'editor', data: { filePath: 'a.java' } },
      t2: { id: 't2', panelType: 'editor', data: { filePath: 'b.java' } },
    },
  };
}

describe('editor-panes', () => {
  it('orders editor panes by tree DFS (left→right)', () => {
    expect(getEditorPaneIds(twoPaneLayout())).toEqual(['g1', 'g2']);
  });

  it('assigns 1-based numbers and palette colors by order', () => {
    const panes = getEditorPanes(twoPaneLayout());
    expect(panes).toEqual([
      { paneId: 'g1', number: 1, filePath: 'a.java', color: getPaneColor(0) },
      { paneId: 'g2', number: 2, filePath: 'b.java', color: getPaneColor(1) },
    ]);
  });

  it('attributes a file to every pane displaying it, in order', () => {
    const layout = twoPaneLayout();
    layout.tabs.t2.data.filePath = 'a.java'; // both panes show a.java
    expect(getPanesForFile(layout, 'a.java')).toEqual([
      { paneId: 'g1', number: 1, color: getPaneColor(0) },
      { paneId: 'g2', number: 2, color: getPaneColor(1) },
    ]);
    expect(getPanesForFile(layout, 'missing.java')).toEqual([]);
  });

  it('palette cycles past its length and pane 1 is the gray token', () => {
    expect(PANE_PALETTE.length).toBeGreaterThanOrEqual(4);
    expect(getPaneColor(0)).toBe(PANE_PALETTE[0]);
    expect(getPaneColor(PANE_PALETTE.length)).toBe(PANE_PALETTE[0]);
  });
});
