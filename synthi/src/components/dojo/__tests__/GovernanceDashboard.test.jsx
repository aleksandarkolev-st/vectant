import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GovernanceDashboard from '../GovernanceDashboard';
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

function renderDashboard(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<GovernanceDashboard autoLoad={false} {...props} />);
  });
  return container;
}

function buildGovernanceSummary() {
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
    },
    governanceService: {
      metrics: {
        skill_count: 2,
        active_license_count: 1,
        expired_license_count: 1,
        pending_approval_count: 1,
        case_law_review_count: 1,
      },
      license_health: [
        {
          skill_id: 'skill-save-invoice',
          skill_name: 'Save invoice',
          workspace_id: 'workspace-a',
          license_id: 'license-001',
          license_version: '1.0.0',
          status: 'active',
          entrustment_level: 'E3',
          readiness_level: 7,
          autonomy_level: 'submit_limited',
          expires_at: '2026-07-11T00:00:00.000Z',
          days_until_expiry: 30,
          proof_required: true,
          allowed_action_count: 1,
          gated_action_count: 1,
          blocked_action_count: 1,
        },
        {
          skill_id: 'skill-stale',
          skill_name: 'Stale approval skill',
          workspace_id: 'workspace-a',
          license_id: 'license-002',
          status: 'expired',
          entrustment_level: 'EX',
          readiness_level: 5,
          expires_at: '2026-06-01T00:00:00.000Z',
          days_until_expiry: -10,
          proof_required: true,
        },
      ],
      approval_queue: [
        {
          queue_id: 'approval-001',
          skill_id: 'skill-save-invoice',
          workspace_id: 'workspace-a',
          license_id: 'license-001',
          action: 'send_invoice',
          constraints: ['manager_approval'],
          reason: 'Action is licensed only with explicit approval or extra evidence.',
          status: 'pending',
          source: 'license_gated_action',
        },
      ],
      case_law_review_queue: [
        {
          case_id: 'CASE-001',
          title: 'Duplicate client guardrail',
          skill_id: 'skill-save-invoice',
          workspace_id: 'workspace-a',
          finding: 'Duplicate client display name can select the wrong account.',
          rule_created: 'Require stable client ID before submit.',
          status: 'proposed',
        },
      ],
    },
  }, 'workspace-a');
}

describe('GovernanceDashboard', () => {
  it('renders empty governance state', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="governance-dashboard"]')?.textContent).toContain('Governance');
    expect(view.querySelector('[data-testid="approval-queue"]')?.textContent).toContain('No approval work');
    expect(view.querySelector('[data-testid="license-health-board"]')?.textContent).toContain('No license health');
  });

  it('renders overview metrics, approval rows, and stale license rows', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: buildGovernanceSummary(),
    });

    expect(view.querySelector('[data-testid="governance-overview"]')?.textContent).toContain('Pending Approvals1');
    expect(view.querySelector('[data-testid="license-health-board"]')?.textContent).toContain('Save invoice');
    expect(view.querySelector('[data-testid="license-health-board"]')?.textContent).toContain('Stale approval skill');
    expect(view.querySelector('[data-testid="license-health-board"]')?.textContent).toContain('expired');
    expect(view.querySelector('[data-testid="approval-queue"]')?.textContent).toContain('send_invoice');
    expect(view.querySelector('[data-testid="approval-queue"]')?.textContent).toContain('manager_approval');
    expect(view.querySelector('[data-testid="case-law-review-queue"]')?.textContent).toContain('CASE-001');
  });

  it('loads governance summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(buildGovernanceSummary());

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<GovernanceDashboard workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('send_invoice');
    expect(container.textContent).toContain('Duplicate client guardrail');
  });
});
