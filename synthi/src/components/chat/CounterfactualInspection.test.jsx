import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CounterfactualInspection } from './CounterfactualInspection.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root;
let container;
afterEach(() => { root?.unmount(); container?.remove(); vi.restoreAllMocks(); });

describe('CounterfactualInspection', () => {
  it('renders persisted compact evidence without source content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ inspection: {
      choice_scenes: [{ id: 'choice-1', visible_universe_ids: ['A', 'B'], selected_universe_id: 'B', ambiguity_flags: [] }],
      fossils: [{ id: 'fossil-1', direction_label: 'runtime primitive', detector_summary: [{ status: 'passed' }], counterfactual_strength: 'strong' }],
      mutation_trials: [{ id: 'trial-1', status: 'passed', budget_cap_usd: 0.1, result: 'stricter proof passed; manual selection remains required' }],
    } }) }));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root.render(<CounterfactualInspection workspacePath="C:/workspace" taskClass="fix" />); });
    expect(container.textContent).toContain('Raw source, prompts, and runner transcripts are excluded');
    expect(container.textContent).toContain('never auto-applied');
    expect(container.textContent).not.toContain('class Generated');
  });
});
