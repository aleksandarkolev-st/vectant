import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SkillPassport from '../SkillPassport';
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

function renderPassport(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<SkillPassport autoLoad={false} {...props} />);
  });
  return container;
}

function buildLicensedSummary() {
  return normalizeDojoWorkspaceSummary({
    runtime: { status: 'ready' },
    dojo: {
      skillId: 'skill-save-invoice',
      label: 'Save invoice',
      status: 'licensed',
      published: true,
      entrustmentLevel: 'E3',
      readinessLevel: 7,
      checkride: { coverageScore: 0.84 },
      proofRequired: true,
      publishedTools: [{ name: 'synthi_app_save_invoice', version: '1.0.0', status: 'published' }],
      license: {
        licenseId: 'license-001',
        expiresAt: '2026-07-11T00:00:00.000Z',
        daysUntilExpiry: 30,
        expiryPolicy: 'recertify_on_release_drift',
        allowedActions: ['Create draft invoice'],
        gatedActions: ['Send invoice'],
        blockedActions: ['Delete customer records'],
        blockedContexts: ['duplicate client match'],
        requiredProofClaims: ['workspace_verified', 'checkride_passed'],
      },
      caseLawRefs: ['CASE-001 duplicate client guardrail'],
      entrustmentTimeline: [
        { level: 'E2', label: 'synthetic checkride passed', at: '2026-06-01T00:00:00.000Z' },
        { level: 'E3', label: 'limited production license issued', at: '2026-06-11T00:00:00.000Z' },
      ],
    },
  }, 'workspace-a');
}

describe('SkillPassport', () => {
  it('renders an empty passport state', () => {
    const view = renderPassport({
      workspaceSlug: 'workspace-a',
      skillId: 'skill-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="skill-passport"]')?.textContent).toContain('Skill Passport');
    expect(view.querySelector('[data-testid="skill-passport-empty"]')?.textContent).toContain('Passport unavailable');
  });

  it('renders passport sections from normalized bridge state', () => {
    const view = renderPassport({
      workspaceSlug: 'workspace-a',
      skillId: 'skill-save-invoice',
      initialSummary: buildLicensedSummary(),
    });

    expect(view.textContent).toContain('Save invoice');
    expect(view.textContent).toContain('skill-save-invoice');
    expect(view.textContent).toContain('E3');
    expect(view.textContent).toContain('SRL 7');
    expect(view.textContent).toContain('84%');
    expect(view.textContent).toContain('license-001');
    expect(view.textContent).toContain('2026-07-11');
    expect(view.textContent).toContain('workspace_verified');
    expect(view.textContent).toContain('checkride_passed');
    expect(view.textContent).toContain('synthi_app_save_invoice');
    expect(view.textContent).toContain('CASE-001 duplicate client guardrail');
    expect(view.textContent).toContain('duplicate client match');
  });

  it('loads passport summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(buildLicensedSummary());

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<SkillPassport workspaceSlug="workspace-a" skillId="skill-save-invoice" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('Save invoice');
    expect(container.textContent).toContain('Proof Requirements');
  });
});
