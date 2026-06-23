import { describe, expect, it } from 'vitest';
import reducer, { openFloatingPanel } from '../layout-slice';

// A minimal layout with one non-empty editor group (so cleanup never prunes the root).
function layoutWithEditor() {
  return {
    version: 4,
    rootId: 'g1',
    nodes: {
      g1: { id: 'g1', type: 'tabgroup', tabs: ['ed1'], activeTabId: 'ed1', parentId: null },
    },
    tabs: {
      ed1: { id: 'ed1', panelType: 'editor', title: 'editor', closable: false, data: {} },
    },
    floating: {},
    popouts: {},
    maximizedNodeId: null,
    focusedTabGroupId: 'g1',
    dragSourceTabId: null,
  };
}

describe('layout-slice openFloatingPanel', () => {
  it('opens a panel as a FLOATING window, not a docked tab', () => {
    const next = reducer(
      layoutWithEditor(),
      openFloatingPanel({
        panelType: 'program-session',
        title: 'DBeaver',
        data: { programSessionId: 's1' },
      }),
    );

    const floats = Object.values(next.floating);
    expect(floats).toHaveLength(1);

    const floatTab = next.tabs[floats[0].tabId];
    expect(floatTab.panelType).toBe('program-session');
    expect(floatTab.data.programSessionId).toBe('s1');

    // It must NOT have been docked into the editor group.
    expect(next.nodes.g1.tabs).toEqual(['ed1']);
  });
});
