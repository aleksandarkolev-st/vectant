import { session } from "../session.js";
import { eventLog } from "../events/index.js";
import { escapeHatchQueue } from "../escape_hatch/queue.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_annotate_and_ask — ultraplan §Escape hatch (phase 3).
 *
 * Ship-clicking-point-disambiguation variant of request_human: blocks until
 * the operator drops a `{x,y}` answer (or free-form). Same queue plumbing.
 */

interface RawArgs {
  screenshot?: unknown;
  question?: unknown;
  timeoutMs?: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;

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
  if (a.timeoutMs !== undefined) {
    if (typeof a.timeoutMs !== "number" || a.timeoutMs < 1_000 || a.timeoutMs > 30 * 60_000) {
      return errorResponse("invalid_args", { field: "timeoutMs", expected: "number in [1000, 1800000]" });
    }
  }
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  const timeoutMs = typeof a.timeoutMs === "number" ? a.timeoutMs : DEFAULT_TIMEOUT_MS;
  const enq = escapeHatchQueue.enqueue({
    kind: "annotate_and_ask",
    question: a.question,
    screenshot_base64: a.screenshot,
    timeoutMs,
    source_tool: "synthi_annotate_and_ask",
  });

  if ("error" in enq) {
    return errorResponse(enq.error, { capacity: enq.capacity });
  }

  eventLog.push({
    kind: "console",
    level: "info",
    message: `[escape_hatch] annotate_and_ask pending_id=${enq.pending_id} timeout_ms=${timeoutMs} screenshot_bytes=${a.screenshot.length}`,
    source: "mcp_internal",
  });

  const outcome = await enq.promise;
  if (outcome.status === "answered") {
    return jsonResponse({
      ok: true,
      pending_id: enq.pending_id,
      status: "answered",
      answer: outcome.answer,
      answered_at: outcome.answered_at,
      ...(outcome.operator_id !== undefined ? { operator_id: outcome.operator_id } : {}),
    });
  }
  if (outcome.status === "timeout") {
    return errorResponse("escape_hatch_timeout", {
      pending_id: enq.pending_id,
      timed_out_at: outcome.timed_out_at,
      timeout_ms: timeoutMs,
    });
  }
  return errorResponse("escape_hatch_canceled", {
    pending_id: enq.pending_id,
    reason: outcome.reason,
    canceled_at: outcome.canceled_at,
  });
}
