import { session } from "../session.js";
import { humanActions } from "../escape_hatch/human_actions.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * synthi_recent_human_actions — ultraplan §Escape hatch wire.
 *
 * Returns human-authored input actions observed since `sinceSeq`. Phase 1
 * returns an empty list unless the worker has populated it (source-of-
 * truth hook pending per `AGENT_MCP_REMAINING_WORK.md §2.1`).
 */

interface RawArgs {
  sinceSeq?: unknown;
  limit?: unknown;
}

export async function recentHumanActionsTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  let sinceSeq: number | undefined;
  if (a.sinceSeq !== undefined) {
    if (typeof a.sinceSeq !== "number" || !Number.isInteger(a.sinceSeq) || a.sinceSeq < 0) {
      return errorResponse("invalid_args", { field: "sinceSeq", expected: "non-negative integer" });
    }
    sinceSeq = a.sinceSeq;
  }

  let limit = 64;
  if (a.limit !== undefined) {
    if (typeof a.limit !== "number" || !Number.isInteger(a.limit) || a.limit <= 0) {
      return errorResponse("invalid_args", { field: "limit", expected: "positive integer" });
    }
    limit = a.limit;
  }

  const actions = humanActions.query(sinceSeq, limit);
  session.touch();
  return jsonResponse({
    ok: true,
    actions,
    count: actions.length,
    note:
      actions.length === 0
        ? "No human-authored input observed. Worker input-source attribution is phase-1 pending; tool surface is live so agents can branch on presence once the hook ships."
        : undefined,
  });
}
