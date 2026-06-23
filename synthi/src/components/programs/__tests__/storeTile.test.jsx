/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StoreTile from '../store/StoreTile';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('StoreTile', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('shows a verified badge for verified items and installs on click', async () => {
    const onInstall = vi.fn();
    const item = { packageId: '@vectant/dbeaver', displayName: 'DBeaver', verified: true, installCount: 1200, latestVersion: '1.0.0' };
    await act(async () => root.render(<StoreTile item={item} canManage onInstall={onInstall} onOpenDetail={() => {}} />));
    expect(byTestId(container, 'verified-badge-@vectant/dbeaver')).not.toBeNull();
    await act(async () => byTestId(container, 'install-published-@vectant/dbeaver').click());
    expect(onInstall).toHaveBeenCalledWith(item);
  });

  it('omits the verified badge for community items', async () => {
    const item = { packageId: '@other/pgadmin', displayName: 'pgAdmin', verified: false, installCount: 5, latestVersion: '1.0.0' };
    await act(async () => root.render(<StoreTile item={item} canManage onInstall={() => {}} onOpenDetail={() => {}} />));
    expect(byTestId(container, 'verified-badge-@other/pgadmin')).toBeNull();
    expect(byTestId(container, 'marketplace-item-@other/pgadmin').textContent).toContain('community');
  });
});
