/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConfirmDialog from '../ConfirmDialog';

// Portals to document.body, so query the document rather than the mount container.
function byTestId(id) { return document.querySelector(`[data-testid="${id}"]`); }

describe('ConfirmDialog', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('renders the title + message and fires onConfirm / onCancel', async () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    await act(async () => root.render(
      <ConfirmDialog title="Remove session?" message="This stops and deletes it." confirmLabel="Remove" onConfirm={onConfirm} onCancel={onCancel} />,
    ));
    const dialog = byTestId('confirm-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain('Remove session?');
    expect(dialog.textContent).toContain('This stops and deletes it.');
    expect(dialog.textContent).toContain('Remove');

    await act(async () => byTestId('confirm-accept').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await act(async () => byTestId('confirm-cancel').click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', async () => {
    const onCancel = vi.fn();
    await act(async () => root.render(<ConfirmDialog title="X" onConfirm={() => {}} onCancel={onCancel} />));
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(onCancel).toHaveBeenCalled();
  });
});
