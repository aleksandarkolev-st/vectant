import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DojoShell from '../DojoShell';
import { createEmptyDojoSummary, normalizeDojoWorkspaceSummary } from '@/services/dojoClient';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = undefined;
  }
  if (container) {
    container.remove();
    container = undefined;
  }
});

function renderShell(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<DojoShell autoLoad={false} {...props} />);
  });
  return container;
}

describe('DojoShell', () => {
  it('renders an empty workspace state', () => {
    const view = renderShell({
      workspaceSlug: 'workspace-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="dojo-shell"]')?.textContent).toContain('Agent Dojo');
    expect(view.querySelector('[data-testid="dojo-empty-state"]')?.textContent).toContain('No Dojo skill yet');
    expect(view.textContent).toContain('workspace-a');
  });

  it('renders a selected skill summary from normalized bridge state', () => {
    const summary = normalizeDojoWorkspaceSummary({
      runtime: { status: 'ready' },
      dojo: {
        skillId: 'skill-save-invoice',
        label: 'Save invoice',
        status: 'licensed',
        published: true,
        entrustmentLevel: 'E3',
        readinessLevel: 7,
        checkride: { coverageScore: 0.8 },
        scenarioCount: 20,
        guardrails: [{ guardrail_id: 'guard-a' }],
        artifactCount: 12,
        proofRequired: true,
        publishedToolName: 'synthi_app_save_invoice',
        license: {
          allowedActions: ['prepare_invoice'],
          gatedActions: ['submit_invoice'],
          blockedActions: ['delete_invoice'],
        },
      },
    }, 'workspace-a');

    const view = renderShell({ workspaceSlug: 'workspace-a', initialSummary: summary });

    expect(view.textContent).toContain('Save invoice');
    expect(view.textContent).toContain('skill-save-invoice');
    expect(view.textContent).toContain('E3');
    expect(view.textContent).toContain('SRL 7');
    expect(view.textContent).toContain('80%');
    expect(view.textContent).toContain('synthi_app_save_invoice');
  });

  it('loads summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(normalizeDojoWorkspaceSummary({
      runtime: { status: 'ready' },
      dojo: { skillId: 'skill-a', label: 'Skill A', status: 'draft' },
    }, 'workspace-a'));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<DojoShell workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('Skill A');
  });
});
