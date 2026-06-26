import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GovernanceDashboard from '../GovernanceDashboard';
import PracticeWorldDashboard from '../PracticeWorldDashboard';
import SkillPassport from '../SkillPassport';
import { normalizeDojoWorkspaceSummary } from '@/services/dojoClient';

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

function render(Component, props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Component autoLoad={false} enableBridgeActions={false} {...props} />);
  });
  return container;
}

describe('Dojo regret signals UI', () => {
  it('shows learned near-misses on the skill passport without personal preference copy', () => {
    const view = render(SkillPassport, {
      workspaceSlug: 'workspace-a',
      skillId: 'skill-save-invoice',
      initialSummary: summaryWithRegret(),
    });
    const panel = view.querySelector('[data-testid="skill-passport-near-misses"]');

    expect(panel?.textContent).toContain('Learned From Near-Misses');
    expect(panel?.textContent).toContain('API-backed execution needs rollback proof before promotion.');
    expect(panel?.textContent).not.toContain('You prefer');
    expect(panel?.textContent).not.toContain('unseen branches were rejected');
  });

  it('renders checkride branch comparisons and near-miss badges in practice world', () => {
    const view = render(PracticeWorldDashboard, {
      workspaceSlug: 'workspace-a',
      initialSummary: summaryWithRegret(),
    });

    expect(view.querySelector('[data-testid="dojo-checkride-regret-report"]')?.textContent).toContain('Checkride Branch Comparison');
    expect(view.querySelector('[data-testid="dojo-checkride-regret-report"]')?.textContent).toContain('source_api_substrate');
    expect(view.querySelector('[data-testid="dojo-wind-tunnel-matrix"]')?.textContent).toContain('near-miss:strong');
  });

  it('shows governance reviewer controls for regret policy deltas', async () => {
    const promote = vi.fn().mockResolvedValue({ message: 'policy delta promoted in test' });
    const remove = vi.fn().mockResolvedValue({ message: 'policy delta deleted in test' });
    const view = render(GovernanceDashboard, {
      workspaceSlug: 'workspace-a',
      initialSummary: summaryWithRegret(),
      onPromoteRegretPolicyDelta: promote,
      onDeleteRegretPolicyDelta: remove,
    });

    expect(view.querySelector('[data-testid="regret-policy-delta-queue"]')?.textContent).toContain('Regret Policy Deltas');
    expect(view.querySelector('[data-testid="regret-policy-delta-queue"]')?.textContent).toContain('prefer_substrate');

    const promoteButton = view.querySelector('[data-testid="regret-policy-delta-api-promote"]');
    expect(promoteButton).toBeTruthy();
    expect(promoteButton.disabled).toBe(false);
    await act(async () => {
      promoteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(promote).toHaveBeenCalledWith(expect.objectContaining({
      policyDeltaId: 'delta-api',
      kind: 'prefer_substrate',
    }));
    expect(view.querySelector('[data-testid="governance-action-status"]')?.textContent).toContain('policy delta promoted in test');
  });
});

function summaryWithRegret() {
  return normalizeDojoWorkspaceSummary({
    runtime: { status: 'ready' },
    dojo: {
      skillId: 'skill-save-invoice',
      label: 'Save invoice',
      status: 'licensed',
      published: true,
      entrustmentLevel: 'E3',
      readinessLevel: 7,
      proofRequired: true,
      license: {
        licenseId: 'license-001',
        allowedActions: ['Create draft invoice'],
        gatedActions: ['Send invoice'],
        blockedActions: ['Delete customer records'],
      },
      scenarios: [{
        scenario_id: 'scenario-rollback-proof',
        title: 'Rollback proof check',
        mutation_kind: 'rollback_oracle',
        expected_behavior: 'require_rollback_evidence',
      }],
      windTunnel: {
        runs: [{
          run_id: 'wind-run-api',
          scenario_id: 'scenario-rollback-proof',
          status: 'blocked',
          mutation_kind: 'rollback_oracle',
          branch_kind: 'source_api_substrate',
          counterfactual_strength: 'strong',
          evidence_refs: ['ledger://wind/api'],
        }],
      },
    },
    governanceService: {
      metrics: { pending_approval_count: 0 },
      policy_deltas: [{
        policy_delta_id: 'delta-api',
        delta_kind: 'prefer_substrate',
        status: 'hypothesis',
        confidence: 'high',
        task_class: 'invoice_submit',
        rationale: 'API-backed execution needs rollback proof before promotion.',
        source_branch_id: 'branch-api',
        evidence_ids: ['ledger://choice/scene', 'ledger://oracle/rollback'],
      }],
    },
    regretMemory: {
      policy_deltas: [{
        policy_delta_id: 'delta-api',
        delta_kind: 'prefer_substrate',
        status: 'hypothesis',
        confidence: 'high',
        task_class: 'invoice_submit',
        rationale: 'API-backed execution needs rollback proof before promotion.',
        source_branch_id: 'branch-api',
        evidence_ids: ['ledger://choice/scene', 'ledger://oracle/rollback'],
      }],
      branch_fossils: [{
        fossil_id: 'fossil-api',
        branch_id: 'branch-api',
        exposure_level: 'opened',
        counterfactual_strength: 'strong',
        task_class: 'invoice_submit',
        summary: 'API-backed execution needs rollback proof before promotion.',
        evidence_ids: ['ledger://fossil/api'],
      }],
      branch_traces: [{
        branch_id: 'branch-api',
        branch_kind: 'source_api_substrate',
        status: 'blocked',
        task_class: 'invoice_submit',
        exposure_level: 'opened',
        counterfactual_strength: 'strong',
        summary: 'Rollback oracle was missing.',
        evidence_ids: ['ledger://branch/api'],
      }],
      planning_hints: [{
        hintKind: 'prefer_substrate',
        confidence: 'high',
        taskClass: 'invoice_submit',
        evidenceIds: ['ledger://policy/promoted'],
      }],
    },
  }, 'workspace-a');
}
