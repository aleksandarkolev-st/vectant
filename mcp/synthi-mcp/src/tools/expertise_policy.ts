export const EXPERTISE_POLICY_CONFIG_ENV = "SYNTHI_CODESITE_EXPERTISE_POLICY_JSON";

export interface ExpertisePolicyLimits {
  maxReferencesPerType?: number;
  maxLimit?: number;
  pageMaxLimit?: number;
  maxSuggestedExperts?: number;
  maxCorrectionLength?: number;
  maxEvidenceRefs?: number;
  maxEvidenceRefLength?: number;
  verdicts?: readonly string[];
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/**
 * Read only deployment-owned policy limits. If the MCP process does not have
 * the policy document, it deliberately omits maxima and lets the CodeSite
 * HTTP control plane enforce its active versioned policy.
 */
export function loadExpertisePolicyLimits(
  env: Record<string, string | undefined> = process.env,
): ExpertisePolicyLimits {
  const raw = env[EXPERTISE_POLICY_CONFIG_ENV];
  if (!raw?.trim()) return {};

  let policy: unknown;
  try {
    policy = JSON.parse(raw);
  } catch (_) {
    return {};
  }

  const root = objectValue(policy);
  const limits = objectValue(root["limits"]);
  const knowledge = objectValue(root["knowledge"]);
  const feedback = objectValue(root["feedback"]);
  const verdicts = Array.isArray(feedback["verdicts"])
    ? [...new Set(feedback["verdicts"].filter((value): value is string => (
      typeof value === "string" && Boolean(value.trim())
    )).map((value) => value.trim()))]
    : undefined;

  return {
    maxReferencesPerType: positiveInteger(limits["maxReferencesPerType"]),
    maxLimit: positiveInteger(limits["maxLimit"]),
    pageMaxLimit: positiveInteger(knowledge["pageMaxLimit"]),
    maxSuggestedExperts: positiveInteger(limits["maxSuggestedExperts"]),
    maxCorrectionLength: positiveInteger(feedback["maxCorrectionLength"]),
    maxEvidenceRefs: positiveInteger(feedback["maxEvidenceRefs"]),
    maxEvidenceRefLength: positiveInteger(feedback["maxEvidenceRefLength"]),
    ...(verdicts?.length ? { verdicts } : {}),
  };
}

export const EXPERTISE_POLICY_LIMITS = loadExpertisePolicyLimits();

export function optionalSchemaMaximum(maximum: number | undefined): Record<string, number> {
  return maximum ? { maximum } : {};
}

export function optionalSchemaMaxItems(maxItems: number | undefined): Record<string, number> {
  return maxItems ? { maxItems } : {};
}
