import { describe, expect, it } from 'vitest';
import { collectDojoAuditEvidenceRefs } from './agentWorkflowDojoAudit';

describe('agent workflow Dojo audit helpers', () => {
  it('derives stable audit evidence refs from current Dojo workflow state', () => {
    expect(collectDojoAuditEvidenceRefs({
      workflowState: {
        workflow: { workflowId: 'wf-open-details' },
        dojo: {
          skillId: 'dojo-open-details',
          license: { licenseId: 'license-open-details' },
          checkride: { checkrideId: 'checkride-open-details' },
          proof: { capsuleId: 'capsule-open-details' },
        },
      },
    })).toEqual([
      'skill:dojo-open-details',
      'workflow:wf-open-details',
      'license:license-open-details',
      'checkride:checkride-open-details',
      'proof:capsule-open-details',
    ]);
  });

  it('keeps nested evidence refs and removes duplicate or blank values', () => {
    expect(collectDojoAuditEvidenceRefs({
      workflowState: {
        dojo: {
          skill_id: 'dojo-save-invoice',
          workflow_id: 'wf-save-invoice',
          governance: {
            evidenceRefs: ['evidence-a', ' ', 'evidence-a'],
            audit: { evidence_record_ids: ['record-b'] },
          },
          caseLawRecord: { evidence_refs: ['case-evidence-c'] },
        },
      },
      extraRefs: ['manual-review-evidence', 'evidence-a'],
    })).toEqual([
      'manual-review-evidence',
      'evidence-a',
      'record-b',
      'case-evidence-c',
      'skill:dojo-save-invoice',
      'workflow:wf-save-invoice',
    ]);
  });
});
