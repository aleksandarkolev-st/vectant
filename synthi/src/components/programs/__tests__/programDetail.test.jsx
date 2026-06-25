/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgramDetail from '../store/ProgramDetail';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }
const item = { packageId: '@other/web', displayName: 'Web', description: 'A community app', latestVersion: '1.0.0', verified: false };

describe('ProgramDetail', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('installs on click when no consent is pending', async () => {
    const onInstall = vi.fn();
    await act(async () => root.render(<ProgramDetail item={item} requestedScopes={[]} busy={false} onInstall={onInstall} onApprove={() => {}} onBack={() => {}} />));
    await act(async () => byTestId(container, 'detail-install').click());
    expect(onInstall).toHaveBeenCalledWith(item);
  });

  it('shows the consent prompt with scopes and approves', async () => {
    const onApprove = vi.fn();
    await act(async () => root.render(<ProgramDetail item={item} requestedScopes={['program.launch', 'network.outbound']} busy={false} onInstall={() => {}} onApprove={onApprove} onBack={() => {}} />));
    const prompt = byTestId(container, 'consent-prompt');
    expect(prompt.textContent).toContain('program.launch');
    expect(prompt.textContent).toContain('network.outbound');
    await act(async () => byTestId(container, 'approve-consent').click());
    expect(onApprove).toHaveBeenCalledWith(item, ['program.launch', 'network.outbound']);
  });
});
