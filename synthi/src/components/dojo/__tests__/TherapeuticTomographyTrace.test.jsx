import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TherapeuticTomographyTrace from '../TherapeuticTomographyTrace';
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

function renderTrace(props = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<TherapeuticTomographyTrace autoLoad={false} {...props} />);
  });
  return container;
}

describe('TherapeuticTomographyTrace', () => {
  it('renders an empty trace state', () => {
    const view = renderTrace({
      workspaceSlug: 'workspace-a',
      initialSummary: createEmptyDojoSummary('workspace-a'),
    });

    expect(view.querySelector('[data-testid="therapeutic-tomography-trace"]')?.textContent).toContain('Therapeutic Tomography');
    expect(view.querySelector('[data-testid="tomography-empty"]')?.textContent).toContain('No tomography trace yet');
  });

  it('renders blocked overreach, probes, proof claim categories, avoided access, and diagnosis', () => {
    const summary = normalizeDojoWorkspaceSummary({
      runtime: { status: 'ready' },
      dojo: {
        skillId: 'skill-quality-drop',
        label: 'Quality drop diagnosis',
        status: 'licensed',
        therapeuticTomography: traceFixture(),
      },
    }, 'workspace-a');

    const view = renderTrace({ workspaceSlug: 'workspace-a', initialSummary: summary });
    const text = view.textContent;

    expect(text).toContain('Diagnose why a production AI model dropped 9% in quality.');
    expect(text).toContain('raw_prod_logs');
    expect(text).toContain('eval_slice_compare');
    expect(text).toContain('feature_drift_summary');
    expect(text).toContain('Strict Proof Gate approved');
    expect(text).toContain('Machine-verifiable claims');
    expect(text).toContain('Human-reviewed claims');
    expect(text).toContain('Narrative claims');
    expect(text).toContain('feature:customer_plan');
    expect(text).toContain('train_serve_skew in customer_plan transformation');
    expect(text).toContain('model_weights');
    expect(view.querySelector('[data-testid="tomography-proof-capsule"]')?.textContent).toContain('proof_001');
    expect(view.querySelector('[data-testid="tomography-avoided-access"]')?.textContent).toContain('admin_privileges');
  });

  it('loads tomography summary through the provided client', async () => {
    const loadSummary = vi.fn().mockResolvedValue(normalizeDojoWorkspaceSummary({
      runtime: { status: 'ready' },
      dojo: {
        skillId: 'skill-quality-drop',
        label: 'Quality drop diagnosis',
        status: 'licensed',
        therapeuticTomography: traceFixture(),
      },
    }, 'workspace-a'));

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<TherapeuticTomographyTrace workspaceSlug="workspace-a" loadSummary={loadSummary} />);
    });

    expect(loadSummary).toHaveBeenCalledWith(expect.objectContaining({ workspaceSlug: 'workspace-a' }));
    expect(container.textContent).toContain('Therapeutic Tomography');
    expect(container.textContent).toContain('customer_plan');
  });
});

function traceFixture() {
  return {
    schema_version: 'synthi.dojo.therapeuticTrace.v1',
    task_id: 'quality_drop_demo_001',
    task_class: 'ml_quality_drop',
    user_goal: 'Diagnose why a production AI model dropped 9% in quality.',
    current_authority_dose: 5,
    uncertainties: [{
      id: 'quality_drop_cause',
      description: 'Which segment and feature caused the quality drop?',
      current_confidence: 0.2,
      possible_causes: ['data_drift', 'train_serve_skew'],
      useful_probes: ['eval_slice_compare', 'feature_drift_summary'],
      blocking_status: 'open',
      severity: 'high',
    }],
    authority_doses: [{
      id: 'dose_lineage_customer_plan_001',
      level: 5,
      scope: 'feature:customer_plan',
      decision: 'approved',
      mutation_allowed: false,
      permitted_tools: ['feature_lineage_hash'],
      permitted_data_classes: ['feature_lineage_hash'],
      forbidden_data_classes: ['raw_prod_logs', 'model_weights'],
      expiration_condition: 'end_of_task',
      revoke_plan: 'revoke temporary lineage grant when trace closes',
      measured_effect: 'training_transform_hash != serving_transform_hash',
    }],
    projection_probes: [
      {
        id: 'probe_eval_slice_001',
        name: 'eval_slice_compare',
        status: 'completed',
        target_uncertainty: 'quality_drop_cause',
        required_authority_dose: 2,
        actual_information_gain: 7,
        confidence: 0.84,
        allowed_output_shape_valid: true,
        result_summary: { affected_segment: 'enterprise_users' },
      },
      {
        id: 'probe_feature_drift_001',
        name: 'feature_drift_summary',
        status: 'completed',
        target_uncertainty: 'quality_drop_cause',
        required_authority_dose: 4,
        actual_information_gain: 8,
        confidence: 0.88,
        allowed_output_shape_valid: true,
        result_summary: { top_feature: 'customer_plan' },
      },
    ],
    proof_capsules: [{
      id: 'proof_001',
      approved: true,
      risk_score: 5,
      minimality_score: 1,
      failed_claims: [],
      requested_access: {
        id: 'access_lineage_customer_plan_001',
        authority_dose: 5,
        scope: 'feature:customer_plan',
        mode: 'read_only',
        data_classes: ['feature_lineage_hash'],
        tools: ['feature_lineage_hash'],
        expiration: 'end_of_task',
        revocable: true,
      },
      machine_verifiable_claims: [
        { claim: 'eval_slice_compare_attempted', result: 'pass', evidence: 'trace.projection_probes.eval_slice_compare.status', critical: true },
        { claim: 'feature_drift_summary_attempted', result: 'pass', evidence: 'trace.projection_probes.feature_drift_summary.status', critical: true },
        { claim: 'request_is_read_only', result: 'pass', evidence: 'access_request.mode', critical: true },
      ],
      human_reviewed_claims: [
        { claim: 'lineage_access_is_reasonable_next_step', status: 'approved', reviewer_role: 'ml_engineer', rationale: 'customer_plan drift is strongest lead.' },
      ],
      unverifiable_narrative_claims: [
        { claim: 'Agent believes lineage will confirm train/serve skew.', status: 'context_only' },
      ],
      evidence_links: ['trace.projection_probes.eval_slice_compare.status'],
    }],
    blocked_overreach_attempts: [{
      requested_access: {
        id: 'access_raw_logs_001',
        authority_dose: 8,
        scope: 'production',
        mode: 'read_only',
        data_classes: ['raw_prod_logs'],
        tools: ['log_query'],
        expiration: 'end_of_task',
        revocable: true,
      },
      decision: 'denied',
      reason: ['forbidden_data_requested', 'lower_risk_probe_available', 'no_probe_attempted'],
      suggested_alternative: ['eval_slice_compare'],
    }],
    final_outcome: 'diagnosed',
    diagnosis: 'train_serve_skew in customer_plan transformation',
    remediation_plan: 'Prepare a separate remediation proof before write access.',
    avoided_access: ['raw_prod_logs', 'full_database', 'model_weights', 'admin_privileges', 'write_access'],
    learned_policy_delta: ['Prefer aggregate probes before lineage.'],
  };
}
