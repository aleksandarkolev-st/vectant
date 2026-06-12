import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GovernanceDashboard from '../GovernanceDashboard';
import { createEmptyDojoSummary, normalizeDojoWorkspaceSummary } from '@/services/dojoClient';
import { USER_ID_KEY } from '@/services/userIdentity';

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
    root.render(<GovernanceDashboard autoLoad={false} enableBridgeActions={false} {...props} />);
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
        policy_gate_count: 2,
        recertification_count: 1,
        compliance_artifact_count: 3,
      },
      skill_registry: [
        {
          skill_id: 'skill-save-invoice',
          title: 'Save invoice',
          workspace_id: 'workspace-a',
          status: 'licensed',
          license_status: 'active',
          entrustment_level: 'E3',
          readiness_level: 7,
          owner: 'finance-ops',
          published_tool_name: 'synthi_app_save_invoice',
          updated_at: '2026-06-11T00:00:00.000Z',
        },
        {
          skill_id: 'skill-stale',
          title: 'Stale approval skill',
          workspace_id: 'workspace-a',
          status: 'expired',
          license_status: 'expired',
          entrustment_level: 'EX',
          readiness_level: 5,
          owner: 'platform-risk',
          updated_at: '2026-06-01T00:00:00.000Z',
        },
      ],
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
      policy_gates: [
        {
          gate_id: 'gate-proof-required',
          name: 'Proof required for invoice submission',
          status: 'enforced',
          severity: 'critical',
          scope: 'workspace',
          owner: 'security',
          blocks: ['send_invoice'],
          evidence_refs: ['evidence-proof-001'],
          next_step: 'Issue verified proof capsule',
        },
        {
          gate_id: 'gate-source-drift',
          name: 'Source drift recertification',
          status: 'watching',
          severity: 'high',
          scope: 'app_release',
          owner: 'release',
          blocks: ['promote_api_substrate'],
        },
      ],
      recertification_queue: [
        {
          queue_id: 'recert-001',
          skill_id: 'skill-stale',
          skill_name: 'Stale approval skill',
          reason: 'source_drift',
          due_at: '2026-06-15T00:00:00.000Z',
          status: 'queued',
          priority: 'high',
          evidence_refs: ['evidence-drift-001'],
        },
      ],
      audit_exports: [
        {
          export_id: 'audit-export-001',
          title: 'License and proof audit',
          status: 'available',
          format: 'jsonl',
          record_count: 42,
          generated_at: '2026-06-11T00:00:00.000Z',
          digest: 'sha256:audit',
        },
      ],
      compliance_evidence_pack: {
        pack_id: 'compliance-pack-001',
        generated_at: '2026-06-11T00:00:00.000Z',
        retention_class: 'regulated',
        artifacts: [
          { artifact_id: 'assurance-case', title: 'Skill Assurance Case', status: 'available', digest: 'sha256:assurance' },
          { artifact_id: 'license-history', title: 'License History', status: 'available', digest: 'sha256:license' },
          { artifact_id: 'evidence-ledger', title: 'Evidence Ledger Manifest', status: 'available', digest: 'sha256:ledger' },
        ],
        missing_artifacts: ['deployed_host_conformance'],
      },
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
    expect(view.querySelector('[data-testid="skill-registry-table"]')?.textContent).toContain('No skills are registered');
    expect(view.querySelector('[data-testid="policy-gate-table"]')?.textContent).toContain('No policy gates');
    expect(view.querySelector('[data-testid="recertification-queue"]')?.textContent).toContain('No recertification work');
  });

  it('renders overview metrics, governance queues, policy gates, and compliance exports', () => {
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: buildGovernanceSummary(),
    });

    expect(view.querySelector('[data-testid="governance-overview"]')?.textContent).toContain('Pending Approvals1');
    expect(view.querySelector('[data-testid="skill-registry-table"]')?.textContent).toContain('finance-ops');
    expect(view.querySelector('[data-testid="skill-registry-table"]')?.textContent).toContain('synthi_app_save_invoice');
    expect(view.querySelector('[data-testid="license-health-board"]')?.textContent).toContain('Save invoice');
    expect(view.querySelector('[data-testid="license-health-board"]')?.textContent).toContain('Stale approval skill');
    expect(view.querySelector('[data-testid="license-health-board"]')?.textContent).toContain('expired');
    expect(view.querySelector('[data-testid="approval-queue"]')?.textContent).toContain('send_invoice');
    expect(view.querySelector('[data-testid="approval-queue"]')?.textContent).toContain('manager_approval');
    expect(view.querySelector('[data-testid="policy-gate-table"]')?.textContent).toContain('Proof required for invoice submission');
    expect(view.querySelector('[data-testid="policy-gate-table"]')?.textContent).toContain('Issue verified proof capsule');
    expect(view.querySelector('[data-testid="recertification-queue"]')?.textContent).toContain('source_drift');
    expect(view.querySelector('[data-testid="compliance-evidence-pack"]')?.textContent).toContain('compliance-pack-001');
    expect(view.querySelector('[data-testid="compliance-evidence-pack"]')?.textContent).toContain('deployed_host_conformance');
    expect(view.querySelector('[data-testid="audit-export-panel"]')?.textContent).toContain('License and proof audit');
    expect(view.querySelector('[data-testid="case-law-review-queue"]')?.textContent).toContain('CASE-001');
    expect(view.querySelector('[data-testid="approval-approval-001-approve"]')?.disabled).toBe(true);
    expect(view.querySelector('[data-testid="license-license-001-revoke"]')?.disabled).toBe(true);
  });

  it('invokes governance approval and revocation actions with operator feedback', async () => {
    const approve = vi.fn().mockResolvedValue({ message: 'approval approved in test' });
    const deny = vi.fn().mockResolvedValue({ message: 'approval denied in test' });
    const revoke = vi.fn().mockResolvedValue({ message: 'license revoked in test' });
    const view = renderDashboard({
      workspaceSlug: 'workspace-a',
      initialSummary: buildGovernanceSummary(),
      onApproveApproval: approve,
      onDenyApproval: deny,
      onRevokeLicense: revoke,
    });

    await act(async () => {
      view.querySelector('[data-testid="approval-approval-001-approve"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      queueId: 'approval-001',
      action: 'send_invoice',
    }));
    expect(view.querySelector('[data-testid="governance-action-status"]')?.textContent).toContain('approval approved in test');

    await act(async () => {
      view.querySelector('[data-testid="approval-approval-001-deny"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(deny).toHaveBeenCalledWith(expect.objectContaining({
      queueId: 'approval-001',
      action: 'send_invoice',
    }));
    expect(view.querySelector('[data-testid="governance-action-status"]')?.textContent).toContain('approval denied in test');

    await act(async () => {
      view.querySelector('[data-testid="license-license-001-revoke"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({
      skillId: 'skill-save-invoice',
      licenseId: 'license-001',
    }));
    expect(view.querySelector('[data-testid="governance-action-status"]')?.textContent).toContain('license revoked in test');
  });

  it('uses bridge-backed default actions for permission upgrade review and license revocation', async () => {
    const originalFetch = global.fetch;
    const summary = buildGovernanceSummary();
    summary.governance.approvalQueue = [{
      ...summary.governance.approvalQueue[0],
      queueId: 'permission-upgrade-001',
      requestId: 'upgrade-001',
      source: 'permission_upgrade_request',
    }];
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        is_error: false,
        result: { ok: true },
        state: {
          runtime: { status: 'ready' },
          dojo: {
            skillId: 'skill-save-invoice',
            label: 'Save invoice',
            status: 'licensed',
          },
          governanceService: {
            metrics: { pending_approval_count: 1 },
            approval_queue: [
              {
                queue_id: 'permission-upgrade-001',
                request_id: 'upgrade-001',
                skill_id: 'skill-save-invoice',
                license_id: 'license-001',
                action: 'send_invoice',
                status: 'pending',
                source: 'permission_upgrade_request',
              },
            ],
            license_health: [
              {
                skill_id: 'skill-save-invoice',
                skill_name: 'Save invoice',
                license_id: 'license-001',
                status: 'active',
              },
            ],
          },
        },
      }),
    }));

    try {
      localStorage.setItem(USER_ID_KEY, 'governance-operator');
      const view = renderDashboard({
        workspaceSlug: 'workspace-a',
        initialSummary: summary,
        enableBridgeActions: true,
      });

      await act(async () => {
        view.querySelector('[data-testid="approval-permission-upgrade-001-approve"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const approveCall = global.fetch.mock.calls.at(-1);
      expect(approveCall?.[0]).toContain('/browser-workflows/tool');
      expect(JSON.parse(approveCall?.[1]?.body || '{}')).toEqual({
        tool: 'synthi_dojo_review_permission_upgrade',
        arguments: {
          request_id: 'upgrade-001',
          decision: 'approved',
          reviewer_actor_id: 'governance-operator',
          reviewer_actor_type: 'human',
          evidence_refs: [],
        },
      });
      expect(view.querySelector('[data-testid="governance-action-status"]')?.textContent).toContain('Permission approved: send_invoice');

      await act(async () => {
        view.querySelector('[data-testid="license-license-001-revoke"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      const revokeCall = global.fetch.mock.calls.at(-1);
      expect(JSON.parse(revokeCall?.[1]?.body || '{}')).toEqual({
        tool: 'synthi_dojo_revoke_license',
        arguments: {
          skill_id: 'skill-save-invoice',
          actor_id: 'governance-operator',
          actor_type: 'human',
          evidence_refs: [],
        },
      });
      expect(view.querySelector('[data-testid="governance-action-status"]')?.textContent).toContain('License revoked: Save invoice');
    } finally {
      localStorage.removeItem(USER_ID_KEY);
      global.fetch = originalFetch;
    }
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
    expect(container.textContent).toContain('Compliance Pack');
  });
});
