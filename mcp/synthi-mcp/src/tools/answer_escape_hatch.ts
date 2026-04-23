/**
 * synthi_answer_escape_hatch — operator-side tool (phase 3).
 *
 * Drains one pending entry from the escape-hatch queue. Used by:
 *   - Operator UI: subscribes to `synthi://escape-hatch/queue`, surfaces
 *     pending entries, operator submits answer → we call this tool.
 *   - Second MCP client in an operator-console workflow.
 *   - Automated test harnesses.
 *
 * Does NOT require a session attach — the queue is MCP-process-local, and
 * the operator flow is "connect a second MCP to answer questions", not
 * "attach to the session". Leaving this attach-independent lets the same
 * MCP subprocess serve both agent + operator traffic, which keeps the
 * phase-3 wiring to a single package.
 */

import { eventLog } from "../events/index.js";
import { escapeHatchQueue } from "../escape_hatch/queue.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  pending_id?: unknown;
  answer?: unknown;
  operator_id?: unknown;
  cancel?: unknown;
  cancel_reason?: unknown;
}

export async function answerEscapeHatchTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  if (typeof a.pending_id !== "string" || a.pending_id.length === 0) {
    return errorResponse("invalid_args", { field: "pending_id", expected: "non-empty string" });
  }
  const operatorId = typeof a.operator_id === "string" ? a.operator_id : undefined;

  if (a.cancel === true) {
    const reason = typeof a.cancel_reason === "string" && a.cancel_reason.length > 0
      ? a.cancel_reason
      : "operator_canceled";
    const ok = escapeHatchQueue.cancel(a.pending_id, reason);
    if (!ok) {
      return errorResponse("escape_hatch_unknown_pending", {
        pending_id: a.pending_id,
        hint: "The pending entry already resolved (answered, timed out, or canceled).",
      });
    }
    eventLog.push({
      kind: "console",
      level: "info",
      message: `[escape_hatch] canceled pending_id=${a.pending_id} reason=${reason}`,
      source: "mcp_internal",
    });
    return jsonResponse({ ok: true, pending_id: a.pending_id, canceled: true, reason });
  }

  if (a.answer === undefined) {
    return errorResponse("invalid_args", { field: "answer", expected: "any (required unless cancel:true)" });
  }

  const matched = escapeHatchQueue.resolve(a.pending_id, a.answer, operatorId);
  if (!matched) {
    return errorResponse("escape_hatch_unknown_pending", {
      pending_id: a.pending_id,
      hint: "The pending entry already resolved (answered, timed out, or canceled).",
    });
  }
  eventLog.push({
    kind: "console",
    level: "info",
    message: `[escape_hatch] answered pending_id=${a.pending_id} operator_id=${operatorId ?? "(anonymous)"}`,
    source: "mcp_internal",
  });
  return jsonResponse({
    ok: true,
    pending_id: a.pending_id,
    resolved_at: Date.now(),
    ...(operatorId !== undefined ? { operator_id: operatorId } : {}),
  });
}
