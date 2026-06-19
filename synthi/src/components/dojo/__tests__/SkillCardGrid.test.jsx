import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SkillCardGrid from '../SkillCardGrid';
import { createEmptyDojoSummary } from '@/services/dojoClient';

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

function renderGrid(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<SkillCardGrid autoLoad={false} {...props} />);
  });
  return container;
}

function buildCatalogSummary() {
  const summary = createEmptyDojoSummary('workspace-a');
  const saveInvoice = {
    skillId: 'skill-save-invoice',
    title: 'Save invoice',
    status: 'licensed',
    licenseStatus: 'licensed',
    entrustmentLevel: 'E3',
    readinessLevel: 7,
    coverageScore: 0.84,
    scenarioCount: 18,
    proofRequired: true,
    publishedToolName: 'synthi_app_save_invoice',
    allowedActions: ['Create draft invoice'],
    gatedActions: ['Send invoice'],
    blockedActions: ['Delete customer records'],
  };
  const updateVendor = {
    skillId: 'skill-update-vendor',
    title: 'Update vendor',
    status: 'draft',
    licenseStatus: 'practice',
    entrustmentLevel: 'E1',
    readinessLevel: 2,
    coverageScore: 0.32,
    scenarioCount: 4,
    proofRequired: false,
    publishedTools: [{ name: 'synthi_app_update_vendor', status: 'draft' }],
    allowedActions: ['Collect vendor evidence'],
    gatedActions: [],
    blockedActions: ['Submit payment details'],
  };
  return {
    ...summary,
    selectedSkill: saveInvoice,
    skills: [saveInvoice, updateVendor],
    metrics: {
      ...summary.metrics,
      skillCount: 2,
      licensedCount: 1,
    },
  };
}

describe('SkillCardGrid', () => {
  it('renders the empty catalog state', () => {
    const view = renderGrid({
      workspaceSlug: 'workspace-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="skill-card-grid"]')?.textContent).toContain('Skill Cards');
    expect(view.querySelector('[data-testid="skill-card-empty"]')?.textContent).toContain('No skill cards yet');
  });

  it('renders consumer skill cards with scope, proof, and navigation', () => {
    const view = renderGrid({
      workspaceSlug: 'workspace-a',
      initialSummary: buildCatalogSummary(),
    });

    expect(view.querySelectorAll('[data-testid="consumer-skill-card"]')).toHaveLength(2);
    expect(view.textContent).toContain('Save invoice');
    expect(view.textContent).toContain('Update vendor');
    expect(view.textContent).toContain('84%');
    expect(view.textContent).toContain('SRL 7');
    expect(view.textContent).toContain('Proof Required');
    expect(view.textContent).toContain('Create draft invoice');
    expect(view.textContent).toContain('Send invoice');
    expect(view.textContent).toContain('Delete customer records');
    expect(view.textContent).toContain('Safe Mode constrained');
    expect(view.querySelector('a[href="/workspace/workspace-a/dojo/skills/skill-save-invoice/passport"]')?.textContent).toContain('Passport');
    expect(view.querySelector('a[href="/workspace/workspace-a/dojo/skills/skill-save-invoice/cortex"]')?.textContent).toContain('Cortex');
  });

  it('loads catalog summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(buildCatalogSummary());

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<SkillCardGrid workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('Save invoice');
    expect(container.textContent).toContain('2 skills');
  });
});
