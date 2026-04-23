import { eventLog } from "../events/index.js";
import { session } from "../session.js";
import {
  errorResponse,
  jsonResponse,
  type ToolResponse,
} from "./shared.js";

/**
 * Record-only for phase 1. The MCP does not yet negotiate bandwidth with
 * the worker — the worker's encoder defaults are configured at spawn
 * (video_pipeline.rs:19-92). This tool preserves the wire + caches the
 * intent in the event log so we can ship real negotiation in phase 2
 * without breaking the client surface.
 */

interface RawArgs {
  target_fps?: unknown;
  target_bitrate?: unknown;
  target_resolution?: unknown;
}

export async function setQualityTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as RawArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  const effective: Record<string, unknown> = {};
  if (a.target_fps !== undefined) {
    if (typeof a.target_fps !== "number" || a.target_fps <= 0) {
      return errorResponse("invalid_args", { field: "target_fps", expected: "positive number" });
    }
    effective["target_fps"] = a.target_fps;
  }
  if (a.target_bitrate !== undefined) {
    if (typeof a.target_bitrate !== "number" || a.target_bitrate <= 0) {
      return errorResponse("invalid_args", { field: "target_bitrate", expected: "positive number (bits/sec)" });
    }
    effective["target_bitrate"] = a.target_bitrate;
  }
  if (a.target_resolution !== undefined) {
    const r = a.target_resolution as { w?: unknown; h?: unknown };
    if (!r || typeof r.w !== "number" || typeof r.h !== "number") {
      return errorResponse("invalid_args", { field: "target_resolution", expected: "{w:number,h:number}" });
    }
    effective["target_resolution"] = { w: r.w, h: r.h };
  }

  eventLog.push({
    kind: "usage",
    metric: "tool_call",
    value: 1,
    detail: { tool: "synthi_set_quality", requested: effective, applied: false, reason: "phase_1_record_only" },
  });
  return jsonResponse({
    ok: true,
    applied: false,
    note: "Phase 1 records the intent only; bandwidth negotiation with the worker is phase 2.",
    requested: effective,
  });
}
