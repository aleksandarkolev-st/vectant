/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LibraryView from '../library/LibraryView';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }
const noop = () => {};
const baseProps = {
  canManage: true, slug: 'team',
  sessions: [{ id: 'ps1', state: 'running', runtimeType: 'container', webGui: true, webPort: 6901, activePorts: [6901] }],
  installs: [{ id: 'inst1', packageId: '@vectant/dbeaver', version: '1.0.0', status: 'installed' }],
  detected: null, loading: false,
  onOpenStore: noop, onRefresh: noop, onOpenSession: noop, onStop: noop, onRestart: noop,
  onLaunchInstall: noop, onScaffold: noop, onLaunchDetected: noop, scaffoldableIds: [],
};

describe('LibraryView', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('renders running cards + installed tiles and exposes a Store entry', async () => {
    await act(async () => root.render(<LibraryView {...baseProps} />));
    expect(byTestId(container, 'running-open-ps1')).not.toBeNull();
    expect(byTestId(container, 'launch-install-inst1')).not.toBeNull();
    expect(byTestId(container, 'open-store')).not.toBeNull();
  });

  it('fires onOpenStore from the header Store button and the Browse tile', async () => {
    const onOpenStore = vi.fn();
    await act(async () => root.render(<LibraryView {...baseProps} onOpenStore={onOpenStore} />));
    await act(async () => byTestId(container, 'open-store').click());
    await act(async () => byTestId(container, 'browse-store-tile').click());
    expect(onOpenStore).toHaveBeenCalledTimes(2);
  });

  it('shows the detected banner only when detected and manageable', async () => {
    await act(async () => root.render(<LibraryView {...baseProps} detected={{ source: 'docker-compose.yml' }} />));
    expect(byTestId(container, 'detected-program').textContent).toContain('docker-compose.yml');
  });
});
