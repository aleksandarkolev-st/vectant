/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MyAppsView from '../myapps/MyAppsView';

describe('MyAppsView', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async (props) => { await act(async () => root.render(<MyAppsView {...props} />)); };

  const subs = [
    { versionId: 'v1', packageId: '@team/tool', reviewState: 'published', scanSummary: { decisiveCves: [] }, aiSummary: { riskScore: 0.1, flags: [] } },
    { versionId: 'v2', packageId: '@team/wip', reviewState: 'rejected', scanSummary: null, aiSummary: { riskScore: 0.9, flags: ['malware'] } },
    { versionId: 'v3', packageId: '@team/q', reviewState: 'submitted', scanSummary: null, aiSummary: null },
  ];

  it('renders a status badge + package for each submission', async () => {
    await render({ submissions: subs, onSubmitUpdate: () => {}, onUnpublish: () => {}, onRefresh: () => {} });
    expect(container.textContent).toMatch(/@team\/tool/);
    expect(container.textContent).toMatch(/live/i);
    expect(container.textContent).toMatch(/rejected/i);
    expect(container.textContent).toMatch(/queued/i);
  });

  it('shows Unpublish only for a published app and calls back with its packageId', async () => {
    const onUnpublish = vi.fn();
    await render({ submissions: subs, onSubmitUpdate: () => {}, onUnpublish, onRefresh: () => {} });
    const btns = [...container.querySelectorAll('button')].filter((b) => /unpublish/i.test(b.textContent));
    expect(btns).toHaveLength(1);
    await act(async () => { btns[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onUnpublish).toHaveBeenCalledWith('@team/tool');
  });

  it('calls onSubmitUpdate from a card', async () => {
    const onSubmitUpdate = vi.fn();
    await render({ submissions: subs, onSubmitUpdate, onUnpublish: () => {}, onRefresh: () => {} });
    const btn = [...container.querySelectorAll('button')].find((b) => /submit update/i.test(b.textContent));
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSubmitUpdate).toHaveBeenCalled();
  });

  it('renders an empty state when there are no submissions', async () => {
    await render({ submissions: [], onSubmitUpdate: () => {}, onUnpublish: () => {}, onRefresh: () => {} });
    expect(container.textContent).toMatch(/haven.t published|no apps/i);
  });
});
