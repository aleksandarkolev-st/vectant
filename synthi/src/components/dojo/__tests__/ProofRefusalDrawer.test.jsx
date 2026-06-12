import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import ProofCapsuleDrawer from '../ProofCapsuleDrawer';
import RefusalExplainerDrawer from '../RefusalExplainerDrawer';
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

function render(ui) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return container;
}

function proofFixture() {
  return {
    capsuleId: 'capsule-001',
    status: 'used',
    requestedAction: 'submit_invoice',
    replayState: 'used',
    expiresAt: '2026-06-11T23:59:00.000Z',
    substrate: 'mcp',
    keyId: 'dojo-dev-key',
    evidenceClaims: [
      { claim: 'workspace_verified', status: 'satisfied', satisfied: true, evidenceRecordIds: ['ev-001'] },
      { claim: 'checkride_passed', status: 'satisfied', satisfied: true, evidenceRecordIds: ['ev-002'] },
    ],
    validationTimeline: [
      { label: 'Issued', status: 'allowed', at: '2026-06-11T22:00:00.000Z' },
      { label: 'Consumed', status: 'used', at: '2026-06-11T22:01:00.000Z' },
    ],
  };
}

function refusalFixture() {
  return {
    status: 'blocked',
    requestedAction: 'submit_invoice',
    refusal: 'Submit invoice is blocked until the workspace and client identity are verified.',
    rule: 'Require stable ID before invoice submission.',
    blockedBy: ['proof_capsule_missing', 'client_id_verified == true'],
    errorCodes: ['proof_capsule_missing'],
    evidenceRefs: ['ev-case-001'],
    caseLawRefs: [{ id: 'CASE-001', title: 'Duplicate client guardrail', status: 'approved', rule: 'Require stable ID before invoice submission.', evidenceRefs: ['ev-case-001'] }],
    requiredSteps: ['Issue a fresh proof capsule', 'Ask a reviewer to resolve duplicate client identity'],
  };
}

describe('Proof and refusal drawers', () => {
  it('renders proof capsule claims and replay state', () => {
    const view = render(<ProofCapsuleDrawer proof={proofFixture()} requirements={['workspace_verified']} />);
    const text = view.querySelector('[data-testid="proof-capsule-drawer"]')?.textContent || '';
    expect(text).toContain('capsule-001');
    expect(text).toContain('submit_invoice');
    expect(text).toContain('used');
    expect(text).toContain('workspace_verified');
    expect(text).toContain('ev-001');
    expect(text).toContain('Consumed');
  });

  it('renders refusal rule, case law, and next steps', () => {
    const view = render(<RefusalExplainerDrawer refusal={refusalFixture()} />);
    const text = view.querySelector('[data-testid="refusal-explainer-drawer"]')?.textContent || '';
    expect(text).toContain('Submit invoice is blocked');
    expect(text).toContain('proof_capsule_missing');
    expect(text).toContain('Require stable ID before invoice submission.');
    expect(text).toContain('CASE-001');
    expect(text).toContain('ev-case-001');
    expect(text).toContain('Issue a fresh proof capsule');
  });

  it('renders normalized proof and refusal data inside the passport route component', () => {
    const summary = normalizeDojoWorkspaceSummary({
      runtime: { status: 'ready' },
      dojo: {
        skillId: 'skill-save-invoice',
        label: 'Save invoice',
        status: 'licensed',
        proofRequired: true,
        license: {
          allowedActions: ['Create draft invoice'],
          requiredProofClaims: ['workspace_verified'],
        },
        proof: {
          capsule_id: 'capsule-001',
          status: 'used',
          requested_action: 'submit_invoice',
          evidence_claims: [{ claim: 'workspace_verified', satisfied: true, evidence_record_ids: ['ev-001'] }],
          validation_timeline: [{ label: 'Consumed', status: 'used' }],
        },
        blockExplanation: {
          status: 'blocked',
          requestedAction: 'submit_invoice',
          refusal: 'Submit invoice is blocked until the workspace is verified.',
          refusal_explanation: {
            blocked_action: 'submit_invoice',
            blocked_by: ['proof_capsule_missing'],
            rule: 'Provide a valid proof capsule.',
            smallest_allowed_next_step: 'Issue proof before submit_invoice.',
            evidence_refs: ['ev-proof-001'],
            case_law_citations: [
              {
                case_id: 'CASE-001',
                title: 'Duplicate client guardrail',
                rule_created: 'Require stable ID before mutation.',
                evidence_refs: ['ev-case-001'],
              },
            ],
          },
          validation: { blocked_by: ['proof_capsule_missing'], error_codes: ['proof_capsule_missing'] },
          relevant_case_law: [{ case_id: 'CASE-001', title: 'Duplicate client guardrail' }],
        },
        permissionUpgrade: {
          requiredSteps: ['Issue a fresh proof capsule'],
        },
      },
    }, 'workspace-a');

    const view = render(
      <SkillPassport
        autoLoad={false}
        workspaceSlug="workspace-a"
        skillId="skill-save-invoice"
        initialSummary={summary}
      />,
    );

    expect(view.textContent).toContain('capsule-001');
    expect(view.textContent).toContain('workspace_verified');
    expect(view.textContent).toContain('Submit invoice is blocked');
    expect(view.textContent).toContain('CASE-001');
    expect(view.textContent).toContain('Provide a valid proof capsule.');
    expect(view.textContent).toContain('ev-proof-001');
    expect(view.textContent).toContain('Issue proof before submit_invoice.');
  });
});
