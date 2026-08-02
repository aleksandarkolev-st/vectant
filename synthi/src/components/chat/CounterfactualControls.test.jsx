import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CounterfactualControls } from './CounterfactualControls.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('CounterfactualControls', () => {
  it('renders local retention and permits deleting an inspected lesson', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, retention: { fossil_days: 365, raw_trace_days: 30 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ policy_deltas: [{ id: 'delta-1', after: 'raise runtime primitive priority' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ deleted: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ enabled: true, retention: { fossil_days: 365, raw_trace_days: 30 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ policy_deltas: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => { root.render(<CounterfactualControls workspacePath="C:/workspace" taskClass="fix" />); });
    expect(container.textContent).toContain('Stored locally for this workspace');
    expect(container.textContent).toContain('raise runtime primitive priority');

    await act(async () => { container.querySelector('[aria-label="Delete learned policy delta-1"]').click(); });
    expect(fetchMock.mock.calls[2][0]).toContain('/api/counterfactual/policy-deltas/delta-1');
  });
});
