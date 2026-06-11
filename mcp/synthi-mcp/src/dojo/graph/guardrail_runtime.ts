export interface DojoGuardrailPredicateResult {
  ok: boolean;
  predicate: string;
  actual?: unknown;
  expected?: unknown;
  operator?: string;
  blocked_by: string[];
}

export function evaluateDojoGuardrailPredicate(
  predicate: string,
  context: Record<string, unknown>
): DojoGuardrailPredicateResult {
  const trimmed = predicate.trim();
  if (!trimmed) return failed(predicate, "guardrail_predicate_empty");

  const membership = trimmed.match(/^([a-zA-Z0-9_.-]+)\s+in\s+(\[.*\])$/);
  if (membership?.[1] && membership[2]) {
    const key = membership[1];
    const expected = parseArray(membership[2]);
    const actual = context[key];
    return expected.includes(actual) ? passed(predicate, actual, expected, "in") : failed(predicate, "guardrail_membership_failed", actual, expected, "in");
  }

  const comparison = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
  if (comparison?.[1] && comparison[2] && comparison[3]) {
    const [, key, operator, rawExpected] = comparison;
    if (/^[<>=!]/.test(rawExpected.trim())) return failed(predicate, "guardrail_predicate_unsupported");
    const actual = context[key];
    const expected = parseExpectedValue(rawExpected.trim());
    const ok = compare(actual, expected, operator);
    return ok ? passed(predicate, actual, expected, operator) : failed(predicate, "guardrail_comparison_failed", actual, expected, operator);
  }

  if (/^[a-zA-Z0-9_.-]+$/.test(trimmed)) {
    const actual = context[trimmed];
    return actual === true ? passed(predicate, actual, true, "truthy") : failed(predicate, "guardrail_truthy_failed", actual, true, "truthy");
  }

  return failed(predicate, "guardrail_predicate_unsupported");
}

function compare(actual: unknown, expected: unknown, operator: string): boolean {
  switch (operator) {
    case "==":
      return actual === expected;
    case "!=":
      return actual !== expected;
    case "<":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "<=":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
    case ">":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case ">=":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    default:
      return false;
  }
}

function parseExpectedValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function passed(predicate: string, actual: unknown, expected: unknown, operator: string): DojoGuardrailPredicateResult {
  return { ok: true, predicate, actual, expected, operator, blocked_by: [] };
}

function failed(
  predicate: string,
  reason: string,
  actual?: unknown,
  expected?: unknown,
  operator?: string
): DojoGuardrailPredicateResult {
  return {
    ok: false,
    predicate,
    ...(actual !== undefined ? { actual } : {}),
    ...(expected !== undefined ? { expected } : {}),
    ...(operator ? { operator } : {}),
    blocked_by: [reason],
  };
}
