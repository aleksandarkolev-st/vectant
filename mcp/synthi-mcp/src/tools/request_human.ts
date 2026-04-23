import { session } from "../session.js";
import { eventLog } from "../events/index.js";
import { escapeHatchQueue } from "../escape_hatch/queue.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_request_human — ultraplan §Escape hatch (phase 3).
 *
 * Enqueues the question into the MCP's escape-hatch queue and blocks until
 * an operator answers via `synthi_answer_escape_hatch` (or the
 * `synthi://escape-hatch/queue` resource consumer does), the caller-supplied
 * `timeoutMs` elapses, or the session detaches.
 *
 * Operator-UI routing is the queue consumer — phase-3 wires an operator
 * tool client that subscribes to the queue resource and answers via the
 * new `synthi_answer_escape_hatch` tool.
 */

interface RawArgs {
  question?: unknown;
  screenshot?: unknown;
  timeoutMs?: unknown;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function requestHumanTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (typeof a.question !== "string" || a.question.length === 0) {
    return errorResponse("invalid_args", { field: "question", expected: "non-empty string" });
  }
  if (a.screenshot !== undefined && typeof a.screenshot !== "string") {
    return errorResponse("invalid_args", { field: "screenshot", expected: "base64 PNG string" });
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
    kind: "request_human",
    question: a.question,
    ...(typeof a.screenshot === "string" ? { screenshot_base64: a.screenshot } : {}),
    timeoutMs,
    source_tool: "synthi_request_human",
  });

  if ("error" in enq) {
    return errorResponse(enq.error, { capacity: enq.capacity });
  }

  eventLog.push({
    kind: "console",
    level: "info",
    message: `[escape_hatch] request_human pending_id=${enq.pending_id} timeout_ms=${timeoutMs} question=${a.question.slice(0, 120)}`,
    source: "mcp_internal",
  });

  const outcome = await enq.promise;
  if (outcome.status === "answered") {
    eventLog.push({
      kind: "console",
      level: "info",
      message: `[escape_hatch] request_human answered pending_id=${enq.pending_id}`,
      source: "mcp_internal",
    });
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
      required_tool_call: {
        name: "synthi_request_human",
        suggested_args: { question: a.question, timeoutMs: Math.max(timeoutMs, 180_000) },
        reason: "retry with a longer timeout or escalate out-of-band",
      },
    });
  }
  return errorResponse("escape_hatch_canceled", {
    pending_id: enq.pending_id,
    reason: outcome.reason,
    canceled_at: outcome.canceled_at,
  });
}
