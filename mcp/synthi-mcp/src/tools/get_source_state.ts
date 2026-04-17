import { eventLog } from "../events/index.js";
import type { SourceStateEvent } from "../events/index.js";
import { session } from "../session.js";
import { errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

/**
 * Report the session's source-state summary, sourced from the event log.
 *
 * Producers today:
 *   - `synthi_compile`               — auto-emits a source_state event with
 *                                      last_changed_files + content_hash on
 *                                      every dispatched compile.
 *   - `synthi_report_source_state`   — agent-driven explicit producer; the
 *                                      agent calls this after editing files
 *                                      without also driving the compile.
 *
 * Future worker/collab-server-side producers (human-driven edits, frontend
 * saves) land via AGENT_MCP_STATUS §4.3 follow-up; the shape is already
 * stable so those additions are purely additive.
 */
export async function getSourceStateTool(_args: unknown): Promise<ToolResponse> {
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");
  const entries = eventLog.query({ kind: "source_state" });
  const last = entries[entries.length - 1] as SourceStateEvent | undefined;
  return jsonResponse({
    ok: true,
    session_id: attached.sessionId,
    last_changed_files: last?.last_changed_files ?? [],
    last_change_seq: last?.seq ?? null,
    last_change_ts: last?.ts ?? null,
    content_hash: last?.content_hash ?? null,
    source_state_event_count: entries.length,
  });
}
