export const AI_SPLIT_PROVENANCE_SCHEMA_VERSION = 'synthi.ai.split.provenance.v1';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function isAiSplitEvidenceLine(line) {
  const text = String(line ?? '');
  return /\bmode=split\b/i.test(text)
    || /POST\s+\/refactor\/split(?:\/verified|\/gpu)?\b/i.test(text)
    || /Calling API.*\/refactor\/split(?:\/verified|\/gpu)?\b/i.test(text);
}

export function countAiSplitEvidenceLines(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.filter(isAiSplitEvidenceLine).length;
}

export function classifyFreshAiSplitProvenance({
  required = false,
  model = '',
  aiCallCounts = {},
  evidenceLines = [],
} = {}) {
  const splitCountFromCounts = nonNegativeInteger(
    isObject(aiCallCounts) ? aiCallCounts.split : 0,
  );
  const splitEvidenceLines = Array.isArray(evidenceLines)
    ? evidenceLines.filter(isAiSplitEvidenceLine)
    : [];
  const splitCount = Math.max(splitCountFromCounts, splitEvidenceLines.length);
  const observed = splitCount > 0;
  const normalizedModel = typeof model === 'string' ? model.trim() : '';

  return {
    schemaVersion: AI_SPLIT_PROVENANCE_SCHEMA_VERSION,
    required: required === true,
    model: normalizedModel || null,
    splitCallCount: splitCount,
    observed,
    resultState: observed
      ? 'fresh-ai-split-observed'
      : required === true
        ? null
        : 'fresh-ai-split-not-required',
    degradedState: required === true && !observed ? 'fresh-ai-split-unobserved' : null,
    degradedReason: required === true && !observed
      ? 'validation_required_fresh_ai_split_but_no_split_call_was_observed'
      : null,
    evidenceRefs: splitEvidenceLines.map((_, index) => `ai-engine-log:split:${index}`),
    evidenceLineCount: splitEvidenceLines.length,
  };
}
