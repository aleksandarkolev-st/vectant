import type { DojoGraphAssertionRequirement } from "./types.js";

export type DojoAssertionRuntimeStatus = "passed" | "failed" | "missing" | "skipped";

export interface DojoAssertionRuntimeResult {
  assertion_id: string;
  required: boolean;
  status: DojoAssertionRuntimeStatus;
  ok: boolean;
  blocked_by: string[];
  observed?: unknown;
}

export function evaluateDojoGraphAssertions(
  assertions: DojoGraphAssertionRequirement[],
  context: Record<string, unknown>
): DojoAssertionRuntimeResult[] {
  return assertions.map((assertion) => evaluateDojoGraphAssertion(assertion, context));
}

export function evaluateDojoGraphAssertion(
  assertion: DojoGraphAssertionRequirement,
  context: Record<string, unknown>
): DojoAssertionRuntimeResult {
  const observed = assertionValueFor(assertion.assertion_id, context);
  if (observed === true) {
    return {
      assertion_id: assertion.assertion_id,
      required: assertion.required,
      status: "passed",
      ok: true,
      blocked_by: [],
      observed,
    };
  }
  if (observed === false) {
    return {
      assertion_id: assertion.assertion_id,
      required: assertion.required,
      status: "failed",
      ok: !assertion.required,
      blocked_by: assertion.required ? [`assertion_failed:${assertion.assertion_id}`] : [],
      observed,
    };
  }
  if (!assertion.required) {
    return {
      assertion_id: assertion.assertion_id,
      required: false,
      status: "skipped",
      ok: true,
      blocked_by: [],
    };
  }
  return {
    assertion_id: assertion.assertion_id,
    required: true,
    status: "missing",
    ok: false,
    blocked_by: [`assertion_missing:${assertion.assertion_id}`],
  };
}

function assertionValueFor(assertionId: string, context: Record<string, unknown>): unknown {
  const assertionResults = context["assertion_results"];
  if (isRecord(assertionResults) && assertionId in assertionResults) {
    return assertionResults[assertionId];
  }
  const namespacedKey = `assertion:${assertionId}`;
  if (namespacedKey in context) return context[namespacedKey];
  return context[assertionId];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
