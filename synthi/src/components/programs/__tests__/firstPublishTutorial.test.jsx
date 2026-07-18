/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FirstPublishTutorial, firstPublishSeenKey } from '../FirstPublishTutorial';

describe('FirstPublishTutorial', () => {
  let container; let root;
  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(props) { await act(async () => root.render(<FirstPublishTutorial {...props} />)); }

  it('renders the guided steps the first time for a user', async () => {
    await render({ userId: 'u1', open: true, onClose: () => {} });
    expect(container.textContent).toMatch(/bring a pullable image/i);
    expect(container.textContent).toMatch(/what we check/i);
  });

  it('does not render once the per-user seen flag is set', async () => {
    window.localStorage.setItem(firstPublishSeenKey('u1'), '1');
    await render({ userId: 'u1', open: true, onClose: () => {} });
    expect(container.firstChild).toBeNull();
  });

  it('sets the seen flag and calls onClose when dismissed via the CTA', async () => {
    const onClose = vi.fn();
    await render({ userId: 'u1', open: true, onClose });
    const btn = container.querySelector('button');
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(window.localStorage.getItem(firstPublishSeenKey('u1'))).toBe('1');
    expect(onClose).toHaveBeenCalled();
  });

  it('keys the flag per user (a different user still sees it)', async () => {
    window.localStorage.setItem(firstPublishSeenKey('u1'), '1');
    await render({ userId: 'u2', open: true, onClose: () => {} });
    expect(container.textContent).toMatch(/bring a pullable image/i);
  });
});
