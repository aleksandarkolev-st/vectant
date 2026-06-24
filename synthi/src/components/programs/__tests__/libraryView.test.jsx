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
  onLaunchInstall: noop, onScaffold: noop, onLaunchDetected: noop, onRemove: noop, scaffoldableIds: [],
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

describe('LibraryView — running/stopped/crashed separation + named cards', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const multiInstalls = [
    { id: 'inst-d', packageId: '@vectant/dbeaver', version: '1.0.0', status: 'installed' },
    { id: 'inst-p', packageId: '@vectant/postman', version: '1.0.0', status: 'installed' },
  ];
  const multiSessions = [
    { id: 'run-1234abcd', state: 'running', runtimeType: 'web', webGui: true, webPort: 6080, installId: 'inst-d', updatedAt: '2026-06-01T13:00:00.000Z' },
    { id: 'stp-5678ef01', state: 'stopped', runtimeType: 'web', installId: 'inst-d', updatedAt: '2026-06-01T12:00:00.000Z' },
    { id: 'crs-9012abcd', state: 'crashed', runtimeType: 'container', installId: 'inst-p', updatedAt: '2026-06-01T11:00:00.000Z' },
  ];
  const multiProps = { ...baseProps, sessions: multiSessions, installs: multiInstalls };
  async function render(props = {}) { await act(async () => root.render(<LibraryView {...multiProps} {...props} />)); }

  it('renders Running, Stopped, and Crashed sections', async () => {
    await render();
    expect(container.textContent).toContain('Running');
    expect(container.textContent).toContain('Stopped');
    expect(container.textContent).toContain('Crashed');
  });

  it('shows the program name as the card title and the session as the subtitle', async () => {
    await render();
    const card = byTestId(container, 'session-card-run-1234abcd');
    expect(card.textContent).toContain('Dbeaver');         // resolved from @vectant/dbeaver
    expect(card.textContent).toContain('Session run-1234'); // id-prefix subtitle
  });

  it('a running session card has Open + a live thumbnail', async () => {
    await render();
    expect(byTestId(container, 'running-open-run-1234abcd')).not.toBeNull();
    expect(byTestId(container, 'thumb-run-1234abcd')).not.toBeNull();
  });

  it('a stopped session card has no Open and no thumbnail, but offers Restart', async () => {
    await render();
    expect(byTestId(container, 'running-open-stp-5678ef01')).toBeNull();
    expect(byTestId(container, 'thumb-stp-5678ef01')).toBeNull();
    expect(byTestId(container, 'running-restart-stp-5678ef01')).not.toBeNull();
  });

  it('a crashed session card offers Restart and shows its program name', async () => {
    await render();
    const card = byTestId(container, 'session-card-crs-9012abcd');
    expect(byTestId(container, 'running-restart-crs-9012abcd')).not.toBeNull();
    expect(card.textContent).toContain('Postman');
  });

  it('every session card has an X to remove it', async () => {
    await render();
    expect(byTestId(container, 'session-remove-run-1234abcd')).not.toBeNull();
    expect(byTestId(container, 'session-remove-stp-5678ef01')).not.toBeNull();
    expect(byTestId(container, 'session-remove-crs-9012abcd')).not.toBeNull();
  });

  it('clicking the X calls onRemove with the session', async () => {
    const onRemove = vi.fn();
    await render({ onRemove });
    await act(async () => byTestId(container, 'session-remove-stp-5678ef01').click());
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: 'stp-5678ef01' }));
  });
});
