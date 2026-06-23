/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RunningCard from '../library/RunningCard';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('RunningCard', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const base = { id: 'ps1', state: 'running', runtimeType: 'container', webGui: true, webPort: 6901, activePorts: [6901], workspaceSlug: 'team' };

  it('renders ports, a thumbnail for webGui, and fires onStop', async () => {
    const onStop = vi.fn();
    await act(async () => root.render(<RunningCard session={base} slug="team" onOpen={() => {}} onStop={onStop} onRestart={() => {}} />));
    expect(container.querySelector('img')).not.toBeNull();
    expect(container.textContent).toContain(':6901');
    await act(async () => byTestId(container, 'running-stop-ps1').click());
    expect(onStop).toHaveBeenCalledWith(base);
  });

  it('omits the thumbnail for a non-webGui session', async () => {
    await act(async () => root.render(<RunningCard session={{ ...base, webGui: false }} slug="team" onOpen={() => {}} onStop={() => {}} onRestart={() => {}} />));
    expect(container.querySelector('img')).toBeNull();
  });
});
