/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StoreView from '../store/StoreView';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }
const noop = () => {};
const baseProps = {
  canManage: true,
  marketplace: [
    { packageId: '@vectant/dbeaver', displayName: 'DBeaver', verified: true, installCount: 9, latestVersion: '1.0.0' },
  ],
  query: '', onQueryChange: noop, onBack: noop, onInstallManifest: noop, onPublish: noop,
  onInstallPublished: noop, requestedScopes: [], consentItem: null, busy: false, onApprove: noop,
};

describe('StoreView', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('renders the pinned actions + a tile', async () => {
    await act(async () => root.render(<StoreView {...baseProps} />));
    expect(byTestId(container, 'install-from-manifest')).not.toBeNull();
    expect(byTestId(container, 'publish-program')).not.toBeNull();
    expect(byTestId(container, 'marketplace-item-@vectant/dbeaver')).not.toBeNull();
    expect(byTestId(container, 'filter-chip-community')).not.toBeNull();
  });

  it('install routes through the tile to onInstallPublished', async () => {
    const onInstallPublished = vi.fn();
    await act(async () => root.render(<StoreView {...baseProps} onInstallPublished={onInstallPublished} />));
    await act(async () => byTestId(container, 'install-published-@vectant/dbeaver').click());
    expect(onInstallPublished).toHaveBeenCalled();
  });

  it('back button returns to the Library', async () => {
    const onBack = vi.fn();
    await act(async () => root.render(<StoreView {...baseProps} onBack={onBack} />));
    await act(async () => byTestId(container, 'store-back').click());
    expect(onBack).toHaveBeenCalled();
  });

  it('renders the consent detail when a consentItem with scopes is provided', async () => {
    await act(async () => root.render(
      <StoreView {...baseProps} consentItem={{ packageId: '@x/y', displayName: 'Y', latestVersion: '1.0.0', verified: false }} requestedScopes={['program.launch']} />,
    ));
    expect(byTestId(container, 'consent-prompt').textContent).toContain('program.launch');
  });
});
