/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgramThumbnail from '../library/ProgramThumbnail';

// Fake ONLY the timers (keep Date real) so the age-since-start math stays correct.
describe('ProgramThumbnail — single deferred snapshot', () => {
  let container; let root;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('shows a placeholder and makes no request before the ~60-90s window', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={6901} startedAt={new Date().toISOString()} />));
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="thumb-placeholder"]')).not.toBeNull();
  });

  it('takes a single /api/get_screenshot snapshot once the window elapses', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={6901} startedAt={new Date().toISOString()} />));
    await act(async () => { vi.advanceTimersByTime(80_000); });
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toContain('/wsport/rfxr7ism/6901/api/get_screenshot');
  });

  it('captures shortly after mount when the program is already past the window (panel reopened)', async () => {
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={6901} startedAt={old} />));
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('renders a placeholder (never an <img>) when there is no port', async () => {
    await act(async () => root.render(<ProgramThumbnail slug="rfxr7ism" port={null} startedAt={new Date().toISOString()} />));
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-testid="thumb-placeholder"]')).not.toBeNull();
  });
});
