/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ProgramThumbnail from '../library/ProgramThumbnail';

describe('ProgramThumbnail', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('renders a static placeholder, not a live <img> (the ?thumb= endpoint 404s)', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={6901} />));
    // The old ?thumb= <img> polled a path the /wsport proxy does not serve → 404 spam.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="thumb-placeholder"]')).not.toBeNull();
  });

  it('renders a placeholder when there is no port either', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={null} />));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="thumb-placeholder"]')).not.toBeNull();
  });
});
