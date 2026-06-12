import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProofCapsuleDrawer from '../ProofCapsuleDrawer';
import RefusalExplainerDrawer from '../RefusalExplainerDrawer';
import SkillPassport from '../SkillPassport';
import { normalizeDojoWorkspaceSummary, revokeDojoProofCapsule } from '@/services/dojoClient';
import { USER_ID_KEY } from '@/services/userIdentity';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;

function typeIntoInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  if (root) {
    act(() => root.unmount());
    root = undefined;
  }
  if (container) {
    container.remove();
    container = undefined;
  }
  localStorage.removeItem(USER_ID_KEY);
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

  it('requires an audit reason before invoking proof capsule revocation', async () => {
    const onRevoke = vi.fn();
    const view = render(<ProofCapsuleDrawer proof={proofFixture()} requirements={['workspace_verified']} onRevoke={onRevoke} />);

    expect(view.querySelector('[data-testid="proof-capsule-revoke"]')?.disabled).toBe(true);

    await act(async () => {
      typeIntoInput(view.querySelector('[data-testid="proof-capsule-revoke-reason"]'), 'manual key rotation');
    });
    expect(view.querySelector('[data-testid="proof-capsule-revoke"]')?.disabled).toBe(false);

    await act(async () => {
      view.querySelector('[data-testid="proof-capsule-revoke"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRevoke).toHaveBeenCalledWith(expect.objectContaining({
      capsuleId: 'capsule-001',
      revocationReason: 'manual key rotation',
    }));
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

  it('invokes passport proof revocation with operator feedback', async () => {
    const revokeProof = vi.fn().mockResolvedValue({ message: 'proof revoked in test' });
    const summary = normalizeDojoWorkspaceSummary({
      runtime: { status: 'ready' },
      dojo: {
        skillId: 'skill-save-invoice',
        label: 'Save invoice',
        status: 'licensed',
        proofRequired: true,
        license: { allowedActions: ['Create draft invoice'], requiredProofClaims: ['workspace_verified'] },
        proof: proofFixture(),
      },
    }, 'workspace-a');

    const view = render(
      <SkillPassport
        autoLoad={false}
        workspaceSlug="workspace-a"
        skillId="skill-save-invoice"
        initialSummary={summary}
        onRevokeProofCapsule={revokeProof}
      />,
    );

    await act(async () => {
      typeIntoInput(view.querySelector('[data-testid="proof-capsule-revoke-reason"]'), 'operator requested proof rotation');
    });
    await act(async () => {
      view.querySelector('[data-testid="proof-capsule-revoke"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(revokeProof).toHaveBeenCalledWith(expect.objectContaining({
      capsuleId: 'capsule-001',
      revocationReason: 'operator requested proof rotation',
    }));
    expect(view.querySelector('[data-testid="skill-passport-action-status"]')?.textContent).toContain('proof revoked in test');
  });

  it('uses the bridge-backed proof revocation action with explicit actor attribution', async () => {
    const originalFetch = global.fetch;
    localStorage.setItem(USER_ID_KEY, 'proof-operator-a');
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        is_error: false,
        result: {
          ok: true,
          proof_record: {
            capsule_id: 'capsule-001',
            requested_action: 'submit_invoice',
            status: 'revoked',
            revoked_reason: 'manual key rotation',
            revoked_by: { actor_id: 'proof-operator-a', actor_type: 'human' },
          },
        },
        state: {
          runtime: { status: 'ready' },
          dojo: {
            skillId: 'skill-save-invoice',
            label: 'Save invoice',
            status: 'licensed',
            proof: {
              capsuleId: 'capsule-001',
              status: 'revoked',
              requestedAction: 'submit_invoice',
              revocationReason: 'manual key rotation',
            },
          },
        },
      }),
    }));

    try {
      const result = await revokeDojoProofCapsule({
        proof: { capsuleId: 'capsule-001', revocationReason: 'manual key rotation' },
        workspaceSlug: 'workspace-a',
      });
      const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(requestBody).toEqual({
        tool: 'synthi_dojo_revoke_proof_capsule',
        arguments: {
          capsule_id: 'capsule-001',
          reason: 'manual key rotation',
          actor_id: 'proof-operator-a',
          actor_type: 'human',
        },
      });
      expect(result.message).toBe('Proof revoked: capsule-001');
      expect(result.summary.selectedSkill.proofCapsule).toEqual(expect.objectContaining({
        capsuleId: 'capsule-001',
        status: 'revoked',
        revocationReason: 'manual key rotation',
      }));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
