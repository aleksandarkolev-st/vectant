import { session } from "../session.js";
import { eventLog } from "../events/index.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_annotate_and_ask — ultraplan §Escape hatch wire.
 *
 * Phase 1 wire-only: accepts the input shape, records intent, returns
 * `escape_hatch_backend_not_implemented`. Real routing lands in phase 3
 * alongside the operator-UI overlay.
 */

interface RawArgs {
  screenshot?: unknown;
  question?: unknown;
  timeoutMs?: unknown;
}

export async function annotateAndAskTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (typeof a.question !== "string" || a.question.length === 0) {
    return errorResponse("invalid_args", { field: "question", expected: "non-empty string" });
  }
  if (typeof a.screenshot !== "string" || a.screenshot.length === 0) {
    return errorResponse("invalid_args", {
      field: "screenshot",
      expected: "base64-encoded PNG string (from synthi_screenshot)",
    });
  }
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  eventLog.push({
    kind: "console",
    level: "info",
    message: `[escape_hatch] annotate_and_ask question=${a.question.slice(0, 120)} screenshot_bytes=${a.screenshot.length}`,
    source: "mcp_internal",
  });
  return errorResponse("escape_hatch_backend_not_implemented", {
    tool: "synthi_annotate_and_ask",
    question: a.question,
    hint: "Operator-UI overlay lands in phase 3. For now, surface the screenshot + question to the human out-of-band.",
    available_capabilities: [],
  });
}
