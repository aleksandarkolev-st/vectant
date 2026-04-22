/**
 * synthi_get_audio_level + synthi_wait_audio_event — ultraplan §Phase 2d.
 *
 * Phase-1 wire-only stubs. Worker has the audio track plumbed through
 * `TrackFanout` (backend/synthi-webrtc-compiler/worker/src/main.rs:638)
 * but there's no peak-analysis path emitting audio stats on the build-log
 * data channel yet. Until that lands, both tools return
 * `audio_backend_not_implemented` so agents have a stable failure mode
 * to branch on.
 *
 * Shape is pinned so phase-2d landing is additive — no tool-signature
 * churn once the worker starts emitting audio-level frames.
 */

import { session } from "../session.js";
import {
  errorResponse,
  type ToolResponse,
} from "./shared.js";

interface GetAudioLevelArgs {
  window_ms?: unknown;
}

interface WaitAudioEventArgs {
  kind?: unknown;
  threshold_dbfs?: unknown;
  window_ms?: unknown;
  timeoutMs?: unknown;
}

const VALID_EVENT_KINDS = ["above_threshold", "silence"] as const;

export async function getAudioLevelTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as GetAudioLevelArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");
  // Once the worker emits {type:"audio-level", peak_dbfs, rms_dbfs, ts_ms}
  // on the build-log DC, read the most-recent sample from the session's
  // audio-level ring buffer here. Reserve the return shape now so the
  // eventual implementation is additive.
  return errorResponse("audio_backend_not_implemented", {
    tool: "synthi_get_audio_level",
    requested_window_ms: typeof a.window_ms === "number" ? a.window_ms : null,
    hint: "Audio peak analysis lands in phase 2d. Worker-side audio-tee plumbing exists but peak emission on the build-log DC is the missing hookup.",
    reserved_shape: {
      peak_dbfs: "number",
      rms_dbfs: "number",
      window_ms: "number",
      sample_ts: "number",
    },
  });
}

export async function waitAudioEventTool(args: unknown): Promise<ToolResponse> {
  const a = (args ?? {}) as WaitAudioEventArgs;
  const attached = session.get();
  if (!attached) return errorResponse("not_attached");

  const kind = typeof a.kind === "string" ? a.kind : "above_threshold";
  if (!(VALID_EVENT_KINDS as readonly string[]).includes(kind)) {
    return errorResponse("invalid_args", { field: "kind", allowed: VALID_EVENT_KINDS });
  }
  return errorResponse("audio_backend_not_implemented", {
    tool: "synthi_wait_audio_event",
    requested: {
      kind,
      threshold_dbfs: typeof a.threshold_dbfs === "number" ? a.threshold_dbfs : null,
      window_ms: typeof a.window_ms === "number" ? a.window_ms : null,
      timeoutMs: typeof a.timeoutMs === "number" ? a.timeoutMs : null,
    },
    hint: "Phase 2d wire stub. Fall back to synthi_wait({condition:'log', pattern: ...}) until the worker audio-peak emission lands.",
  });
}
