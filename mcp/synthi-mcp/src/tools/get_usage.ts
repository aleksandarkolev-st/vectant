import { eventLog } from "../events/index.js";
import type { UsageEvent } from "../events/index.js";
import { session } from "../session.js";
import { jsonResponse, type ToolResponse } from "./shared.js";

/**
 * Aggregate the usage events in the log into a small snapshot. Phase-1
 * shipping behavior: all values are derived from the event log; no
 * persistent store. Event log is a ring buffer so numbers reset when
 * events age out of the window.
 *
 * Vision inference count + cost are present but zero until the
 * claude_api backend lands and emits metric:"vision_inference" events.
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
  });
}
