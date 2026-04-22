/**
 * synthi_snapshot — capture observable session state.
 *
 * Ultraplan §Snapshot/restore (phase 3). This tool is scoped to what the
 * MCP can actually see: source-state markers, latest frame, event-log seq.
 * The guest process heap is not captured — that is a CRIU + worker concern
 * tracked separately.
 */

import { eventLog } from "../events/index.js";
import type { SourceStateEvent } from "../events/index.js";
import { session } from "../session.js";
import { snapshotStore, type SnapshotRecord } from "../snapshot/index.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

interface RawArgs {
  label?: unknown;
  detail?: unknown;
  /** When true (default false), omit the PNG blob to keep the response small. */
  omit_frame?: unknown;
  /** Downscale the captured frame's longest edge to this many pixels. */
  frame_max_dim?: unknown;
}

export async function snapshotTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  if (a.label !== undefined && typeof a.label !== "string") {
    return errorResponse("invalid_args", { field: "label", expected: "string" });
  }
  if (a.omit_frame !== undefined && typeof a.omit_frame !== "boolean") {
    return errorResponse("invalid_args", { field: "omit_frame", expected: "boolean" });
  }
  if (a.frame_max_dim !== undefined) {
    if (typeof a.frame_max_dim !== "number" || !Number.isInteger(a.frame_max_dim) || a.frame_max_dim < 16) {
      return errorResponse("invalid_args", { field: "frame_max_dim", expected: "integer >= 16" });
    }
  }

  const sourceEntries = eventLog.query({ kind: "source_state" });
  const lastSource = sourceEntries[sourceEntries.length - 1] as SourceStateEvent | undefined;

  let frame: SnapshotRecord["frame"] = {};
  if (a.omit_frame !== true) {
    try {
      const current = await attached.frames.getFrame();
      const buf = current.data;
      // Optional downscale so snapshot payloads don't balloon to multi-MB.
      const maxDim = typeof a.frame_max_dim === "number" ? a.frame_max_dim : undefined;
      let pngBuf: Buffer = buf;
      let outW = current.width;
      let outH = current.height;
      if (maxDim !== undefined) {
        const sharp = (await import("sharp")).default;
        const longest = Math.max(current.width, current.height);
        if (longest > maxDim) {
          const resized = await sharp(buf).resize({
            width: current.width >= current.height ? maxDim : undefined,
            height: current.height > current.width ? maxDim : undefined,
          }).png().toBuffer();
          pngBuf = resized;
          const meta = await sharp(resized).metadata();
          outW = meta.width ?? current.width;
          outH = meta.height ?? current.height;
        }
      }
      frame = {
        png_base64: pngBuf.toString("base64"),
        frame_seq: current.seq,
        ts: current.ts,
        width: outW,
        height: outH,
      };
    } catch {
      // Frame not yet available — record the snapshot anyway.
      frame = {};
    }
  }

  const record: SnapshotRecord = {
    snapshot_id: snapshotStore.newId(),
    ...(typeof a.label === "string" ? { label: a.label } : {}),
    session_id: attached.sessionId,
    captured_at: Date.now(),
    event_log_seq_at_capture: eventLog.lastSeq(),
    wire_state: session.getWireState(),
    source_state: {
      last_changed_files: lastSource?.last_changed_files ?? [],
      content_hash: lastSource?.content_hash ?? null,
      source_state_seq: lastSource?.seq ?? null,
      source_state_ts: lastSource?.ts ?? null,
    },
    frame,
    ...(a.detail !== undefined && typeof a.detail === "object" && a.detail !== null
      ? { detail: a.detail as Record<string, unknown> }
      : {}),
  };

  await snapshotStore.save(record);

  eventLog.push({
    kind: "console",
    level: "info",
    message: `[snapshot] captured id=${record.snapshot_id} label=${record.label ?? "(none)"} seq=${record.event_log_seq_at_capture}`,
    source: "mcp_internal",
  });

  const digest = snapshotStore.digest(record);
  // Response intentionally omits the raw PNG blob by default to keep the
  // tool-result small; callers that want the image can call
  // synthi_restore({snapshot_id, include_frame:true}) or read from the
  // synthi://snapshot/<id> resource. The blob remains stored.
  return jsonResponse({
    ok: true,
    snapshot_id: record.snapshot_id,
    label: record.label ?? null,
    captured_at: record.captured_at,
    session_id: record.session_id,
    event_log_seq_at_capture: record.event_log_seq_at_capture,
    wire_state: record.wire_state,
    source_state: record.source_state,
    frame: frame.png_base64
      ? {
          frame_seq: frame.frame_seq,
          ts: frame.ts,
          width: frame.width,
          height: frame.height,
          bytes: Buffer.byteLength(frame.png_base64, "base64"),
        }
      : { omitted: true },
    digest,
  });
}
