/* @vitest-environment jsdom */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive the redux selectors from a mutable hoisted state object (no real store).
const h = vi.hoisted(() => ({
  state: { ports: { containerPorts: [], runtimePorts: [], runtimeScope: null }, workspace: { slug: '' } },
}));

vi.mock('@/redux/hooks', () => ({
  useAppSelector: (selector) => selector(h.state),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Use the REAL getProgramSessionAppUrl so the asserted URL is the production path.
import PortsPanel from '../PortsPanel';

async function flush() {
  await act(async () => { await Promise.resolve(); });
}

describe('PortsPanel', () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.open = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders Sysbox runtime-pod ports and opens them via /runtime/<scope>/port/<n>/', async () => {
    h.state = { ports: { containerPorts: [], runtimePorts: [8080], runtimeScope: 'ws-a:u1' }, workspace: { slug: 'my-repo' } };
    await act(async () => { root.render(React.createElement(PortsPanel)); });
    await flush();

    expect(container.querySelector('[data-testid="port-row-8080"]')).toBeTruthy();
    const openBtn = container.querySelector('[data-testid="open-port-8080"]');
    expect(openBtn).toBeTruthy();
    await act(async () => { openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.open).toHaveBeenCalledWith(
      'http://localhost:1234/runtime/ws-a%3Au1/port/8080/',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('falls back to the container (/wsport/<slug>/<n>/) path when no runtime ports', async () => {
    h.state = { ports: { containerPorts: [3000], runtimePorts: [], runtimeScope: null }, workspace: { slug: 'my-repo' } };
    await act(async () => { root.render(React.createElement(PortsPanel)); });
    await flush();

    expect(container.querySelector('[data-testid="port-row-3000"]')).toBeTruthy();
    const openBtn = container.querySelector('[data-testid="open-port-3000"]');
    await act(async () => { openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.open).toHaveBeenCalledWith(
      'http://localhost:1234/wsport/my-repo/3000/',
      '_blank',
      'noopener,noreferrer',
    );
  });
});
