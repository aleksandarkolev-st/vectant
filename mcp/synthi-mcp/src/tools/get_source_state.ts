import { eventLog } from "../events/index.js";
import type { SourceStateEvent } from "../events/index.js";
import { session } from "../session.js";
import { errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

/**
 * Report the session's source-state summary, sourced from the event log.
 *
 * Phase-1 reality: the worker doesn't emit source-state messages today; the
 * MCP has no producer wired yet (ticket tracked in ultraplan §4.2). So this
 * tool returns a well-shaped placeholder plus whatever source_state events
 * the log may already carry (e.g., if a future producer retroactively
 * injects them). Agents can poll this tool, branch on `last_change_seq ===
 * null`, and know they need to rely on their own Edit tool's provenance
 * until the producer ships.
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
    note:
      last === undefined
        ? "No source_state events have been emitted yet. Phase 1 will wire a producer from collab-server / compile pipeline."
        : undefined,
  });
}
