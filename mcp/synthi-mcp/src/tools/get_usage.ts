import { eventLog } from "../events/index.js";
import type { UsageEvent } from "../events/index.js";
import { session } from "../session.js";
import { inputQueueDepth } from "../correctness/input_queue_depth.js";
import { jsonResponse, type ToolResponse } from "./shared.js";

/**
 * Aggregate the usage events in the log into a small snapshot. Phase-1
 * shipping behavior: all values are derived from the event log; no
 * persistent store. Event log is a ring buffer so numbers reset when
 * events age out of the window.
 *
 * Vision inference cost is computed per-model using
 * `claude_api.ts::PRICING_USD_PER_MILLION`, with an opus-rate fallback for
 * models not in the table (conservative — never silently underbills).
 */
export async function getUsageTool(_args: unknown): Promise<ToolResponse> {
  const usages = eventLog.query({ kind: "usage" }) as UsageEvent[];
  const counters: Record<string, number> = {};
  let costUsdEstimate = 0;
  for (const u of usages) {
    counters[u.metric] = (counters[u.metric] ?? 0) + u.value;
    if (u.metric === "vision_inference" && u.detail && typeof (u.detail as { cost_usd?: unknown }).cost_usd === "number") {
      costUsdEstimate += (u.detail as { cost_usd: number }).cost_usd;
    }
  }
  const attached = session.get();
  const attachedAt = session.getAttachedAt();
  const hotSeconds = attachedAt ? Math.floor((Date.now() - attachedAt) / 1000) : 0;
  const queueSnapshot = inputQueueDepth.snapshot();
  const peaks = queueSnapshot.recent_peaks;
  const peaksMax = peaks.length === 0 ? 0 : Math.max(...peaks);
  const peaksMean = peaks.length === 0 ? 0 : peaks.reduce((a, b) => a + b, 0) / peaks.length;
  return jsonResponse({
    ok: true,
    session_id: attached?.sessionId ?? null,
    counters: {
      tool_call: counters["tool_call"] ?? 0,
      screenshot: counters["screenshot"] ?? 0,
      vision_inference: counters["vision_inference"] ?? 0,
      egress_bytes: counters["egress_bytes"] ?? 0,
    },
    vision_inference_count: counters["vision_inference"] ?? 0,
    vision_cost_usd_estimate: Number(costUsdEstimate.toFixed(4)),
    hot_seconds: hotSeconds,
    events_in_log: eventLog.size(),
    last_seq: eventLog.lastSeq(),
    input_queue_depth: {
      inflight: queueSnapshot.inflight,
      max_inflight_current_cycle: queueSnapshot.max_inflight_current_cycle,
      cycles_observed: queueSnapshot.cycles_observed,
      recent_peak_max: peaksMax,
      recent_peak_mean: Number(peaksMean.toFixed(2)),
      recent_peaks: peaks,
    },
    frame_timing: session.getFrameTimingSnapshot(),
  });
}
