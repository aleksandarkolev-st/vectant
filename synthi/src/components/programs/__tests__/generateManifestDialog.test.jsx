/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GenerateManifestDialog from '../GenerateManifestDialog';

const MANIFEST = { packageId: 'web', version: '1.0.0', runtimeType: 'web', launch: 'npm run dev' };

describe('GenerateManifestDialog', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const render = async (props) => { await act(async () => root.render(<GenerateManifestDialog {...props} />)); };

  it('renders nothing when closed', async () => {
    await render({ open: false, manifest: MANIFEST, onSave: () => {}, onCancel: () => {} });
    expect(container.firstChild).toBeNull();
  });

  it('seeds the editor with the pretty-printed manifest', async () => {
    await render({ open: true, manifest: MANIFEST, onSave: () => {}, onCancel: () => {} });
    const ta = container.querySelector('[data-testid="manifest-editor"]');
    expect(ta).not.toBeNull();
    expect(ta.value).toContain('"packageId": "web"');
  });

  it('Save calls onSave with the parsed edited manifest', async () => {
    const onSave = vi.fn();
    await render({ open: true, manifest: MANIFEST, onSave, onCancel: () => {} });
    const ta = container.querySelector('[data-testid="manifest-editor"]');
    // React-controlled textarea: set value via the native setter + dispatch input.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    await act(async () => {
      setter.call(ta, JSON.stringify({ ...MANIFEST, packageId: 'edited' }));
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { container.querySelector('[data-testid="manifest-save"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ packageId: 'edited' }));
  });

  it('disables Save when the edited JSON is invalid', async () => {
    await render({ open: true, manifest: MANIFEST, onSave: () => {}, onCancel: () => {} });
    const ta = container.querySelector('[data-testid="manifest-editor"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    await act(async () => {
      setter.call(ta, '{ not json');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="manifest-save"]').disabled).toBe(true);
  });

  it('Cancel calls onCancel', async () => {
    const onCancel = vi.fn();
    await render({ open: true, manifest: MANIFEST, onSave: () => {}, onCancel });
    await act(async () => { container.querySelector('[data-testid="manifest-cancel"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onCancel).toHaveBeenCalled();
  });
});
