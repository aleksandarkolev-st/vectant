/* @vitest-environment jsdom */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDE_PANEL } from '@/components/docking-wm/panels/panel-types';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {},
  fetchProgramSessions: vi.fn(),
  fetchInstalledPrograms: vi.fn(),
  launchProgramSession: vi.fn(),
  installWorkspaceProgram: vi.fn(),
  launchInstalledProgram: vi.fn(),
  stopProgramSession: vi.fn(),
  restartProgramSession: vi.fn(),
  publishWorkspaceProgram: vi.fn(),
  submitForReview: vi.fn(),
  fetchMySubmissions: vi.fn(),
  unpublishProgram: vi.fn(),
  fetchMarketplace: vi.fn(),
  installPublishedProgram: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  scaffoldProgram: vi.fn(),
  fetchDetectedProgram: vi.fn(),
  launchDetectedProgram: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useDispatch: () => h.dispatch,
  useSelector: (sel) => sel(h.state),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('../programsClient', () => ({
  fetchProgramSessions: h.fetchProgramSessions,
  fetchInstalledPrograms: h.fetchInstalledPrograms,
  launchProgramSession: h.launchProgramSession,
  installWorkspaceProgram: h.installWorkspaceProgram,
  launchInstalledProgram: h.launchInstalledProgram,
  stopProgramSession: h.stopProgramSession,
  restartProgramSession: h.restartProgramSession,
  publishWorkspaceProgram: h.publishWorkspaceProgram,
  submitForReview: h.submitForReview,
  fetchMySubmissions: h.fetchMySubmissions,
  unpublishProgram: h.unpublishProgram,
  fetchMarketplace: h.fetchMarketplace,
  installPublishedProgram: h.installPublishedProgram,
  scaffoldProgram: h.scaffoldProgram,
  fetchDetectedProgram: h.fetchDetectedProgram,
  launchDetectedProgram: h.launchDetectedProgram,
}));
vi.mock('@/components/docking-wm/state/layout-slice', () => ({
  selectNodes: (s) => s.nodes,
  selectTabs: (s) => s.tabs,
  selectFloating: (s) => s.floating,
  openTab: (p) => ({ type: 'openTab', payload: p }),
  activateTabAction: (p) => ({ type: 'activate', payload: p }),
  setFocusedTabGroup: (p) => ({ type: 'focus', payload: p }),
  openFloatingPanel: (p) => ({ type: 'openFloatingPanel', payload: p }),
  bringFloatToFrontAction: (p) => ({ type: 'bringFloatToFront', payload: p }),
}));
vi.mock('@/redux/uiSlice', () => ({
  setShowTerminal: (v) => ({ type: 'ui/setShowTerminal', payload: v }),
}));

import ProgramsPanel from '../ProgramsPanel';

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  });
}
function byTestId(container, id) {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('ProgramsPanel — cli/tui programs route to the integrated terminal', () => {
  let container;
  let root;
  let dispatchEventSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    h.state = {
      workspace: { slug: 'team', role: 'owner' },
      nodes: { g1: { type: 'tabgroup', tabs: ['t1'] } },
      tabs: { t1: { panelType: IDE_PANEL.EDITOR } },
      floating: {},
    };
    h.fetchProgramSessions.mockResolvedValue([]);
    h.fetchInstalledPrograms.mockResolvedValue([]);
    h.fetchMarketplace.mockResolvedValue([]);
    h.fetchDetectedProgram.mockResolvedValue(null);
    h.fetchMySubmissions.mockResolvedValue([]);
    dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    dispatchEventSpy.mockRestore();
  });

  async function render() {
    await act(async () => {
      root.render(React.createElement(ProgramsPanel));
    });
    await flush();
  }

  function terminalEvents() {
    return dispatchEventSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e && e.type === 'terminal-session-open');
  }
  function dispatchedTypes() {
    return h.dispatch.mock.calls.map((c) => c[0]?.type);
  }

  it('launching a tui install opens a terminal tab, not a panel', async () => {
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst1', packageId: '@vectant/lazygit', version: '1.0.0', status: 'installed' }]);
    h.launchInstalledProgram.mockResolvedValue({ session: { id: 'ps-tui', state: 'running', runtimeType: 'tui' } });
    await render();

    await act(async () => { byTestId(container, 'launch-install-inst1').click(); });
    await flush();

    expect(dispatchedTypes()).toContain('ui/setShowTerminal');
    const evts = terminalEvents();
    expect(evts).toHaveLength(1);
    expect(evts[0].detail.sessionId).toBe('ps-tui');
    expect(dispatchedTypes()).not.toContain('openTab');
    expect(dispatchedTypes()).not.toContain('openFloatingPanel');
  });

  it('a web install still opens a docked program-session panel (not the terminal)', async () => {
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst2', packageId: 'local:team:web', version: '1.0.0', status: 'installed' }]);
    h.launchInstalledProgram.mockResolvedValue({ session: { id: 'ps-web', state: 'running', runtimeType: 'web' } });
    await render();

    await act(async () => { byTestId(container, 'launch-install-inst2').click(); });
    await flush();

    expect(terminalEvents()).toHaveLength(0);
    expect(dispatchedTypes()).toContain('openTab');
  });
});
