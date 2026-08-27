import { EXPERTISE_POLICY, resolveExpertisePolicy } from './expertisePolicy';

export const KNOWLEDGE_FEEDBACK_VERDICTS = EXPERTISE_POLICY.feedback.verdicts;

const FEEDBACK_KEYS = new Set([
  'verdict',
  'correction',
  'correctionText',
  'correction_text',
  'evidenceRefs',
  'evidence_refs',
]);

function feedbackError(code, detail = {}) {
  return Object.assign(new Error(code), { code, status: 422, detail });
}

function boundedText(value, field, maxLength, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw feedbackError(`knowledge_feedback_${field}_required`);
    return null;
  }
  if (typeof value !== 'string') throw feedbackError(`knowledge_feedback_${field}_invalid`);
  const normalized = value.trim();
  if (required && !normalized) throw feedbackError(`knowledge_feedback_${field}_required`);
  if (normalized.length > maxLength) {
    throw feedbackError(`knowledge_feedback_${field}_too_long`, { maxLength });
  }
  if (normalized.includes('\u0000')) throw feedbackError(`knowledge_feedback_${field}_invalid`);
  return normalized || null;
}

function evidenceList(value, policy) {
  const input = value == null ? [] : Array.isArray(value) ? value : [value];
  if (input.length > policy.feedback.maxEvidenceRefs) {
    throw feedbackError('knowledge_feedback_evidence_limit_exceeded', {
      limit: policy.feedback.maxEvidenceRefs,
    });
  }
  const result = [];
  const seen = new Set();
  for (const entry of input) {
    const normalized = boundedText(
      typeof entry === 'string' ? entry : String(entry),
      'evidence_ref',
      policy.feedback.maxEvidenceRefLength,
      { required: true },
    );
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function validateKnowledgeFeedback(body = {}, policy = EXPERTISE_POLICY) {
  const config = resolveExpertisePolicy(policy);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw feedbackError('knowledge_feedback_invalid');
  }
  const unknown = Object.keys(body).filter((key) => !FEEDBACK_KEYS.has(key));
  if (unknown.length) throw feedbackError('knowledge_feedback_field_forbidden', { fields: unknown });

  const verdict = String(body.verdict || '').trim().toLowerCase().replace(/[ -]+/g, '_');
  if (!config.feedback.verdicts.includes(verdict)) {
    throw feedbackError('knowledge_feedback_verdict_invalid', {
      allowedVerdicts: config.feedback.verdicts,
    });
  }

  const correctionText = boundedText(
    body.correctionText ?? body.correction_text ?? body.correction,
    'correction',
    config.feedback.maxCorrectionLength,
    { required: verdict === 'needs_correction' },
  );
  return {
    verdict,
    correctionText,
    evidenceRefs: evidenceList(body.evidenceRefs ?? body.evidence_refs, config),
  };
}
