import { session } from "../session.js";
import { eventLog } from "../events/index.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_request_human — ultraplan §Escape hatch wire.
 *
 * Phase 1: accept input shape, record intent in the event log, return
 * `escape_hatch_backend_not_implemented` so agents have a stable failure
 * mode to branch on. Phase 3 lands the real routing into the Synthi
 * frontend's operator UI.
 */

interface RawArgs {
  question?: unknown;
  screenshot?: unknown;
  timeoutMs?: unknown;
}

export async function requestHumanTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (typeof a.question !== "string" || a.question.length === 0) {
    return errorResponse("invalid_args", { field: "question", expected: "non-empty string" });
  }
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  eventLog.push({
    kind: "console",
    level: "info",
    message: `[escape_hatch] request_human question=${a.question.slice(0, 120)}`,
    source: "mcp_internal",
  });
  return errorResponse("escape_hatch_backend_not_implemented", {
    tool: "synthi_request_human",
    question: a.question,
    hint: "Operator-UI routing lands in phase 3. For now, surface the question to the human operating the agent out-of-band.",
    available_capabilities: [],
  });
}
