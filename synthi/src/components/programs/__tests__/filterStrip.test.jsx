/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FilterStrip from '../store/FilterStrip';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('FilterStrip', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const items = [{ id: 'all', label: 'All' }, { id: 'db', label: 'Databases' }, { id: 'api', label: 'API tools' }];

  it('renders chips, marks the active one, and fires onSelect', async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(<FilterStrip items={items} activeId="all" onSelect={onSelect} />));
    expect(byTestId(container, 'filter-chip-db')).not.toBeNull();
    expect(byTestId(container, 'filter-chip-all').getAttribute('aria-pressed')).toBe('true');
    await act(async () => byTestId(container, 'filter-chip-db').click());
    expect(onSelect).toHaveBeenCalledWith('db');
  });

  it('translates vertical wheel into horizontal scroll', async () => {
    await act(async () => root.render(<FilterStrip items={items} activeId="all" onSelect={() => {}} />));
    const scroller = byTestId(container, 'filter-scroller');
    let scrolled = 0;
    Object.defineProperty(scroller, 'scrollLeft', { get: () => scrolled, set: (v) => { scrolled = v; }, configurable: true });
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));
    });
    expect(scrolled).toBe(40);
  });
});
