import { describe, expect, it } from 'vitest';
import { validateKnowledgeFeedback } from '../knowledgeFeedback';

describe('knowledge feedback validation', () => {
  it('normalizes a correction verdict and evidence references', () => {
    expect(validateKnowledgeFeedback({
      verdict: 'needs-correction',
      correction: 'Use the shared route contract.',
      evidence_refs: ['contract:route-v2', 'contract:route-v2'],
    })).toEqual({
      verdict: 'needs_correction',
      correctionText: 'Use the shared route contract.',
      evidenceRefs: ['contract:route-v2'],
    });
  });

  it('requires correction detail only for correction verdicts', () => {
    expect(() => validateKnowledgeFeedback({ verdict: 'needs_correction' }))
      .toThrow('knowledge_feedback_correction_required');
    expect(validateKnowledgeFeedback({ verdict: 'not_useful' }).correctionText).toBeNull();
  });

  it('rejects unknown fields and oversized evidence lists', () => {
    expect(() => validateKnowledgeFeedback({ verdict: 'useful', privatePrompt: 'nope' }))
      .toThrow('knowledge_feedback_field_forbidden');
    expect(() => validateKnowledgeFeedback({
      verdict: 'useful',
      evidenceRefs: Array.from({ length: 33 }, (_, index) => `ref-${index}`),
    })).toThrow('knowledge_feedback_evidence_limit_exceeded');
  });
});
