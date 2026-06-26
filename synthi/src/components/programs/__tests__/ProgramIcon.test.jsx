/* @vitest-environment jsdom */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ProgramIcon from '../ProgramIcon';

function byTestId(c, id) { return c.querySelector(`[data-testid="${id}"]`); }

describe('ProgramIcon', () => {
  let container; let root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  async function render(props) { await act(async () => root.render(<ProgramIcon {...props} />)); }

  it('renders the brand logo for a known built-in program', async () => {
    await render({ packageId: '@vectant/postman' });
    expect(byTestId(container, 'program-logo-postman')).not.toBeNull();
    expect(container.querySelector('svg path')).not.toBeNull();
  });

  it('renders the right logo per program (keyed by the @vectant slug)', async () => {
    await render({ packageId: '@vectant/dbeaver' });
    expect(byTestId(container, 'program-logo-dbeaver')).not.toBeNull();
  });

  it('falls back to a first-letter monogram for an unknown program', async () => {
    await render({ packageId: '@acme/whatever' });
    const m = byTestId(container, 'program-logo-monogram');
    expect(m).not.toBeNull();
    expect(m.textContent).toBe('W');
  });
});
