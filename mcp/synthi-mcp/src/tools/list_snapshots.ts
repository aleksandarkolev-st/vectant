import { snapshotStore } from "../snapshot/index.js";
import { session } from "../session.js";
import { errorResponse, jsonResponse, type ToolResponse } from "./shared.js";

interface RawArgs {
  limit?: unknown;
  /** When true, include the PNG blob for each snapshot. Default false. */
  include_frame?: unknown;
}

/**
 * synthi_list_snapshots — enumerate captured snapshots for the attached
 * session. Frames are omitted by default to keep responses small.
 */
export async function listSnapshotsTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  let limit = 32;
  if (a.limit !== undefined) {
    if (typeof a.limit !== "number" || !Number.isInteger(a.limit) || a.limit < 1) {
      return errorResponse("invalid_args", { field: "limit", expected: "positive integer" });
    }
    limit = Math.min(256, a.limit);
  }

  const all = await snapshotStore.list();
  const scoped = all.filter((r) => r.session_id === attached.sessionId);
  const page = scoped.slice(-limit);
  const includeFrame = a.include_frame === true;

  return jsonResponse({
    ok: true,
    count: page.length,
    total: scoped.length,
    snapshots: page.map((r) => ({
      snapshot_id: r.snapshot_id,
      label: r.label ?? null,
      captured_at: r.captured_at,
      event_log_seq_at_capture: r.event_log_seq_at_capture,
      wire_state: r.wire_state,
      source_state: r.source_state,
      frame: includeFrame && r.frame.png_base64
        ? {
            png_base64: r.frame.png_base64,
            frame_seq: r.frame.frame_seq,
            ts: r.frame.ts,
            width: r.frame.width,
            height: r.frame.height,
          }
        : {
            frame_seq: r.frame.frame_seq ?? null,
            ts: r.frame.ts ?? null,
            width: r.frame.width ?? null,
            height: r.frame.height ?? null,
            omitted: r.frame.png_base64 === undefined ? "no_frame_available" : "blob_omitted_by_default",
          },
    })),
  });
}
