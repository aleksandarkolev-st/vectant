/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgramTile from '../library/ProgramTile';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('ProgramTile', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const install = { id: 'inst1', packageId: '@vectant/dbeaver', version: '1.0.0', status: 'installed' };

  it('launches on click and shows scaffold when scaffoldable', async () => {
    const onLaunch = vi.fn(); const onScaffold = vi.fn();
    await act(async () => root.render(<ProgramTile install={install} canManage scaffoldable onLaunch={onLaunch} onScaffold={onScaffold} />));
    await act(async () => byTestId(container, 'launch-install-inst1').click());
    expect(onLaunch).toHaveBeenCalledWith(install);
    expect(byTestId(container, 'scaffold-inst1')).not.toBeNull();
  });

  it('hides actions for a read-only member', async () => {
    await act(async () => root.render(<ProgramTile install={install} canManage={false} scaffoldable onLaunch={() => {}} onScaffold={() => {}} />));
    expect(byTestId(container, 'launch-install-inst1')).toBeNull();
  });
});
