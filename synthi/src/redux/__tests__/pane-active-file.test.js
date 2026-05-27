import { describe, it, expect } from 'vitest';
import { resolveOpenTarget, resolveMirrorFile } from '../paneActiveFile';

const layout = {
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
  focusedTabGroupId: 'g2',
};

describe('paneActiveFile', () => {
  it('routes an open to the focused editor pane', () => {
    expect(resolveOpenTarget(layout)).toBe('g2');
  });

  it('routes to the first pane when focus is not an editor', () => {
    expect(resolveOpenTarget({ ...layout, focusedTabGroupId: null })).toBe('g1');
  });

  it('mirror file = focused pane file', () => {
    expect(resolveMirrorFile(layout)).toBe('b.java');
    expect(resolveMirrorFile({ ...layout, focusedTabGroupId: 'g1' })).toBe('a.java');
  });
});
