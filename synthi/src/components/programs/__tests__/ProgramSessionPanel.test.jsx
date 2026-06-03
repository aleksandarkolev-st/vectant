/* @vitest-environment jsdom */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  fetchProgramSession: vi.fn(),
  fetchProgramSessionEvents: vi.fn(),
  stopProgramSessionRuntime: vi.fn(),
  restartProgramSessionRuntime: vi.fn(),
  getProgramSessionAppUrl: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/services/programSessionClient', () => ({
  fetchProgramSession: h.fetchProgramSession,
  fetchProgramSessionEvents: h.fetchProgramSessionEvents,
  stopProgramSessionRuntime: h.stopProgramSessionRuntime,
  restartProgramSessionRuntime: h.restartProgramSessionRuntime,
  getProgramSessionAppUrl: h.getProgramSessionAppUrl,
}));

vi.mock('sonner', () => ({
  toast: {
    success: h.toastSuccess,
    error: h.toastError,
  },
}));

vi.mock('@/app/workspace/TerminalPane.jsx', () => ({
  default: ({ fixedSessionId }) => React.createElement('div', { 'data-testid': 'terminal-pane' }, `terminal:${fixedSessionId}`),
}));

import ProgramSessionPanel from '../ProgramSessionPanel';

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('ProgramSessionPanel', () => {
  let container;
  let root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    h.fetchProgramSession.mockResolvedValue({
      id: 'ps-1',
      state: 'running',
      runtimeType: 'cli',
      startedAt: '2026-06-03T12:00:00.000Z',
      updatedAt: '2026-06-03T12:05:00.000Z',
      activePorts: [3000],
      webPort: 3000,
      lastHealthState: 'ok',
    });
    h.fetchProgramSessionEvents.mockResolvedValue([
      { type: 'launch_ack', createdAt: '2026-06-03T12:01:00.000Z', data: { state: 'running' } },
    ]);
    h.getProgramSessionAppUrl.mockReturnValue('http://localhost:1234/port/3000/');
    h.stopProgramSessionRuntime.mockResolvedValue({ id: 'ps-1', state: 'stopped', runtimeType: 'cli' });
    h.restartProgramSessionRuntime.mockResolvedValue({ id: 'ps-1', state: 'running', runtimeType: 'cli' });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders the app surface first and can switch to logs and terminal tabs', async () => {
    await act(async () => {
      root.render(React.createElement(ProgramSessionPanel, {
        workspaceSlug: 'team',
        sessionId: 'ps-1',
        title: 'App Server',
      }));
    });
    await flush();

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute('src')).toBe('http://localhost:1234/port/3000/');

    const logsButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Logs'));
    await act(async () => {
      logsButton.click();
    });

    expect(container.textContent).toContain('launch_ack');
    expect(container.textContent).toContain('running');

    const terminalButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Terminal'));
    await act(async () => {
      terminalButton.click();
    });

    expect(container.querySelector('[data-testid="terminal-pane"]')?.textContent).toContain('terminal:ps-1');
  });

  it('invokes lifecycle controls from the settings surface', async () => {
    await act(async () => {
      root.render(React.createElement(ProgramSessionPanel, {
        workspaceSlug: 'team',
        sessionId: 'ps-1',
      }));
    });
    await flush();

    const settingsButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent.includes('Settings'));
    await act(async () => {
      settingsButton.click();
    });

    const restartButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === ' Restart' || button.textContent.includes('Restart'));
    const stopButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === ' Stop' || button.textContent.includes('Stop'));

    await act(async () => {
      restartButton.click();
    });
    expect(h.restartProgramSessionRuntime).toHaveBeenCalledWith('team', 'ps-1');

    await act(async () => {
      stopButton.click();
    });
    expect(h.stopProgramSessionRuntime).toHaveBeenCalledWith('team', 'ps-1');
  });
});