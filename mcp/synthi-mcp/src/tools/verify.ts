import { VerifyPredicateError, verify } from "../verify/index.js";
import type { VerifyPredicate } from "../verify/index.js";
import {
  errorFromException,
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

export async function verifyTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as { predicate?: unknown };
  if (!a.predicate || typeof a.predicate !== "object") {
    return errorResponse("invalid_args", { field: "predicate", expected: "object" });
  }
  const predicate = a.predicate as VerifyPredicate;
  const start = Date.now();
  try {
    const result = await verify(predicate);
    if (result.matched === null && result.unsupported) {
      return errorResponse(result.unsupported.reason, {
        kind: result.kind,
        evidence: result.evidence,
        ...(result.unsupported.required_tool_call
          ? { required_tool_call: result.unsupported.required_tool_call }
          : {}),
      });
    }
    return jsonResponse({
      ok: true,
      matched: result.matched,
      kind: result.kind,
      evidence: result.evidence,
      elapsedMs: Date.now() - start,
    });
  } catch (err) {
    if (err instanceof VerifyPredicateError) {
      return errorResponse(err.code, err.detail ?? {});
    }
    return errorFromException("verify_failed", err);
  }
}
