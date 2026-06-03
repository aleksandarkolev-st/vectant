import { afterEach, describe, expect, it } from 'vitest';
import reducer, { openTab, floatTabAction } from '../layout-slice';
import { registerPanel, unregisterPanel } from '../panel-registry-core';

const PROGRAM_SESSION_PANEL = 'program-session-test';
const INTEGRATIONS_PANEL = 'integrations-test';

function registerTestPanel(panelType, allowMultiple) {
  registerPanel({
    panelType,
    displayName: panelType,
    component: () => null,
    allowMultiple,
    defaultLocation: 'center',
    closable: true,
  });
}

function singleGroupLayout(tab) {
  return {
    version: 4,
    rootId: 'g1',
    nodes: {
      g1: { id: 'g1', type: 'tabgroup', tabs: [tab.id], activeTabId: tab.id, parentId: null },
    },
    tabs: {
      [tab.id]: tab,
    },
    floating: {},
    popouts: {},
    maximizedNodeId: null,
    focusedTabGroupId: 'g1',
    dragSourceTabId: null,
  };
}

afterEach(() => {
  unregisterPanel(PROGRAM_SESSION_PANEL);
  unregisterPanel(INTEGRATIONS_PANEL);
});

describe('layout-slice panel multiplicity', () => {
  it('opens multiple docked tabs for allowMultiple panels', () => {
    registerTestPanel(PROGRAM_SESSION_PANEL, true);

    const state = singleGroupLayout({
      id: 't1',
      panelType: PROGRAM_SESSION_PANEL,
      title: 'Session 1',
      closable: true,
      data: { programSessionId: 'ps-1' },
    });

    const next = reducer(state, openTab({
      panelType: PROGRAM_SESSION_PANEL,
      title: 'Session 2',
      data: { programSessionId: 'ps-2' },
      targetTabGroupId: 'g1',
    }));

    expect(next.nodes.g1.tabs).toHaveLength(2);
    expect(next.nodes.g1.activeTabId).not.toBe('t1');
    expect(Object.values(next.tabs).map((tab) => tab.data?.programSessionId)).toEqual(
      expect.arrayContaining(['ps-1', 'ps-2'])
    );
  });

  it('keeps singleton panels deduped even when data differs', () => {
    registerTestPanel(INTEGRATIONS_PANEL, false);

    const state = singleGroupLayout({
      id: 't1',
      panelType: INTEGRATIONS_PANEL,
      title: 'Connected Tools',
      closable: true,
      data: { scope: 'personal' },
    });

    const next = reducer(state, openTab({
      panelType: INTEGRATIONS_PANEL,
      title: 'Connected Tools',
      data: { scope: 'workspace' },
      targetTabGroupId: 'g1',
    }));

    expect(next.nodes.g1.tabs).toEqual(['t1']);
    expect(next.focusedTabGroupId).toBe('g1');
  });

  it('floats multiple windows for allowMultiple panels', () => {
    registerTestPanel(PROGRAM_SESSION_PANEL, true);

    const state = {
      version: 4,
      rootId: 'g1',
      nodes: {
        g1: { id: 'g1', type: 'tabgroup', tabs: ['t1', 't2'], activeTabId: 't2', parentId: null },
      },
      tabs: {
        t1: {
          id: 't1',
          panelType: PROGRAM_SESSION_PANEL,
          title: 'Session 1',
          closable: true,
          data: { programSessionId: 'ps-1' },
        },
        t2: {
          id: 't2',
          panelType: PROGRAM_SESSION_PANEL,
          title: 'Session 2',
          closable: true,
          data: { programSessionId: 'ps-2' },
        },
      },
      floating: {
        'float-t1': {
          id: 'float-t1',
          tabId: 't1',
          sourceGroupId: 'g1',
          x: 20,
          y: 20,
          width: 480,
          height: 320,
          zIndex: 1,
        },
      },
      popouts: {},
      maximizedNodeId: null,
      focusedTabGroupId: 'g1',
      dragSourceTabId: null,
    };

    const next = reducer(state, floatTabAction({
      tabId: 't2',
      x: 40,
      y: 40,
      width: 500,
      height: 340,
    }));

    expect(Object.keys(next.floating)).toEqual(expect.arrayContaining(['float-t1', 'float-t2']));
    expect(next.floating['float-t2']?.tabId).toBe('t2');
  });

  it('reuses an existing floating window for singleton panels', () => {
    registerTestPanel(INTEGRATIONS_PANEL, false);

    const state = {
      version: 4,
      rootId: 'g1',
      nodes: {
        g1: { id: 'g1', type: 'tabgroup', tabs: ['t1', 't2'], activeTabId: 't2', parentId: null },
      },
      tabs: {
        t1: {
          id: 't1',
          panelType: INTEGRATIONS_PANEL,
          title: 'Connected Tools',
          closable: true,
          data: { scope: 'personal' },
        },
        t2: {
          id: 't2',
          panelType: INTEGRATIONS_PANEL,
          title: 'Connected Tools',
          closable: true,
          data: { scope: 'workspace' },
        },
      },
      floating: {
        'float-t1': {
          id: 'float-t1',
          tabId: 't1',
          sourceGroupId: 'g1',
          x: 20,
          y: 20,
          width: 480,
          height: 320,
          zIndex: 1,
        },
      },
      popouts: {},
      maximizedNodeId: null,
      focusedTabGroupId: 'g1',
      dragSourceTabId: null,
    };

    const next = reducer(state, floatTabAction({
      tabId: 't2',
      x: 40,
      y: 40,
      width: 500,
      height: 340,
    }));

    expect(Object.keys(next.floating)).toEqual(['float-t1']);
    expect(next.floating['float-t1']?.zIndex).toBeGreaterThan(state.floating['float-t1'].zIndex);
  });
});