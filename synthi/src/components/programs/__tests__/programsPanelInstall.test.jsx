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
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
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
}));
vi.mock('@/components/docking-wm/state/layout-slice', () => ({
  selectNodes: (s) => s.nodes,
  selectTabs: (s) => s.tabs,
  openTab: (p) => ({ type: 'openTab', payload: p }),
  activateTabAction: (p) => ({ type: 'activate', payload: p }),
  setFocusedTabGroup: (p) => ({ type: 'focus', payload: p }),
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

describe('ProgramsPanel install / launch-from-install', () => {
  let container;
  let root;

  beforeEach(() => {
    vi.clearAllMocks();
    h.state = {
      workspace: { slug: 'team', role: 'owner' },
      nodes: { g1: { type: 'tabgroup', tabs: ['t1'] } },
      tabs: { t1: { panelType: IDE_PANEL.EDITOR } },
    };
    h.fetchProgramSessions.mockResolvedValue([]);
    h.fetchInstalledPrograms.mockResolvedValue([]);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function render() {
    await act(async () => {
      root.render(React.createElement(ProgramsPanel));
    });
    await flush();
  }

  it('shows a consent prompt listing the requested scopes when install needs consent', async () => {
    h.installWorkspaceProgram.mockRejectedValueOnce({ status: 409, body: { requested: ['program.launch', 'network.outbound'] } });
    await render();

    await act(async () => {
      byTestId(container, 'install-from-manifest').click();
    });
    await flush();

    const prompt = byTestId(container, 'consent-prompt');
    expect(prompt).not.toBeNull();
    expect(prompt.textContent).toContain('program.launch');
    expect(prompt.textContent).toContain('network.outbound');
  });

  it('re-submits with grantScopes when consent is approved', async () => {
    h.installWorkspaceProgram
      .mockRejectedValueOnce({ status: 409, body: { requested: ['program.launch'] } })
      .mockResolvedValueOnce({ install: { id: 'inst1', packageId: 'local:team:web', version: '1.0.0', status: 'installed' } });
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst1', packageId: 'local:team:web', version: '1.0.0', status: 'installed' }]);
    await render();

    await act(async () => {
      byTestId(container, 'install-from-manifest').click();
    });
    await flush();
    await act(async () => {
      byTestId(container, 'approve-consent').click();
    });
    await flush();

    expect(h.installWorkspaceProgram).toHaveBeenCalledTimes(2);
    expect(h.installWorkspaceProgram).toHaveBeenLastCalledWith('team', { grantScopes: ['program.launch'] });
  });

  it('launches an installed program and opens its session tab', async () => {
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst1', packageId: 'local:team:web', version: '1.0.0', status: 'installed' }]);
    h.launchInstalledProgram.mockResolvedValue({ session: { id: 'ps1', state: 'running', runtimeType: 'web' } });
    await render();

    await act(async () => {
      byTestId(container, 'launch-install-inst1').click();
    });
    await flush();

    expect(h.launchInstalledProgram).toHaveBeenCalledWith('team', 'inst1');
    expect(h.dispatch).toHaveBeenCalled();
  });

  it('surfaces the manifest_invalid message from a 422 install response', async () => {
    h.installWorkspaceProgram.mockRejectedValueOnce({ status: 422, body: { error: 'manifest_invalid', message: 'Invalid packageId' } });
    await render();

    await act(async () => {
      byTestId(container, 'install-from-manifest').click();
    });
    await flush();

    expect(h.toastError).toHaveBeenCalledWith('Invalid packageId');
    expect(byTestId(container, 'consent-prompt')).toBeNull();
  });

  it('hides install / launch controls for a plain member', async () => {
    h.state.workspace.role = 'member';
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst1', packageId: 'local:team:web', version: '1.0.0', status: 'installed' }]);
    await render();

    expect(byTestId(container, 'install-from-manifest')).toBeNull();
    expect(byTestId(container, 'launch-install-inst1')).toBeNull();
  });
});
