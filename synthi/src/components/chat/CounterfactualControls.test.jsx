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
    const fetchMock = vi.fn((url, options = {}) => {
      const target = String(url);
      if (options.method === 'DELETE') return Promise.resolve({ ok: true, json: async () => ({ deleted: true }) });
      if (target.includes('/inspection')) return Promise.resolve({ ok: true, json: async () => ({ inspection: {} }) });
      if (target.includes('/policy-deltas')) return Promise.resolve({ ok: true, json: async () => ({ policy_deltas: [{ id: 'delta-1', after: 'raise runtime primitive priority' }] }) });
      return Promise.resolve({ ok: true, json: async () => ({ enabled: true, retention: { fossil_days: 365, raw_trace_days: 30 } }) });
    });
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => { root.render(<CounterfactualControls workspacePath="C:/workspace" taskClass="fix" />); });
    expect(container.textContent).toContain('Stored locally for this workspace');
    expect(container.textContent).toContain('raise runtime primitive priority');

    await act(async () => { container.querySelector('[aria-label="Delete learned policy delta-1"]').click(); });
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes('/api/counterfactual/policy-deltas/delta-1') && options?.method === 'DELETE')).toBe(true);
  });

  it('requires confirmation before deleting all workspace telemetry', async () => {
    const fetchMock = vi.fn((url) => Promise.resolve({ ok: true, json: async () => (
      String(url).includes('/policy-deltas') ? { policy_deltas: [] } : String(url).includes('/inspection') ? { inspection: {} } : { enabled: true, retention: { fossil_days: 365, raw_trace_days: 30 } }
    ) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('confirm', vi.fn(() => true));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root.render(<CounterfactualControls workspacePath="C:/workspace" taskClass="fix" />); });
    await act(async () => { container.querySelector('button[type="button"][class*="status-danger"]').click(); });
    expect(globalThis.confirm).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes('/api/counterfactual/telemetry') && options?.method === 'DELETE')).toBe(true);
  });

  it('lets an operator contradict an active policy with an explicit reason', async () => {
    const fetchMock = vi.fn((url) => Promise.resolve({ ok: true, json: async () => (
      String(url).includes('/inspection') ? { inspection: {} } : String(url).includes('/policy-deltas') && !String(url).includes('/contradict') ? { policy_deltas: [{ id: 'delta-2', after: 'prefer a runtime primitive' }] } : { enabled: true, retention: { fossil_days: 365, raw_trace_days: 30 } }
    ) }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('prompt', vi.fn(() => 'Later evidence contradicted this policy.'));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root.render(<CounterfactualControls workspacePath="C:/workspace" taskClass="fix" />); });
    await act(async () => { container.querySelector('[aria-label="Mark learned policy delta-2 contradicted"]').click(); });
    expect(fetchMock.mock.calls.some(([url, options]) => String(url).includes('/policy-deltas/delta-2/contradict') && options?.method === 'POST')).toBe(true);
  });
});
