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

  it('points the preview at the /wsport stream for the slug + port', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={6901} />));
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toContain('/wsport/rfxr7ism/6901/');
  });

  it('renders a placeholder (no img) when there is no port', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={null} />));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="thumb-placeholder"]')).not.toBeNull();
  });
});
