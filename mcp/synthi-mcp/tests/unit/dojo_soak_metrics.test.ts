// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  extractNumericUsageCounters,
  extractRuntimeResourceCounters,
  summarizeRuntimeResourceSamples,
  summarizeSoakMemorySamples,
  summarizeUsageCounterSamples,
} from "../soak/soak_metrics.mjs";

describe("Dojo soak metrics", () => {
  it("summarizes process memory growth without assuming monotonic heap usage", () => {
    expect(summarizeSoakMemorySamples([
      {
        at: 1,
        rss_bytes: 100,
        heap_used_bytes: 50,
        heap_total_bytes: 80,
        external_bytes: 10,
        array_buffer_bytes: 5,
      },
      {
        at: 2,
        rss_bytes: 120,
        heap_used_bytes: 45,
        heap_total_bytes: 90,
        external_bytes: 12,
        array_buffer_bytes: 7,
      },
    ])).toEqual(expect.objectContaining({
      sample_count: 2,
      rss_start_bytes: 100,
      rss_end_bytes: 120,
      rss_max_bytes: 120,
      rss_growth_bytes: 20,
      heap_used_growth_bytes: -5,
    }));
  });

  it("extracts numeric usage counters and ignores unrelated payload fields", () => {
    expect(extractNumericUsageCounters({
      counters: {
        tool_call: 4,
        screenshot: "2",
        ignored: "not-a-number",
      },
      hot_seconds: 99,
    })).toEqual({
      tool_call: 4,
      screenshot: 2,
    });
  });

  it("computes usage deltas from first and last numeric counter samples", () => {
    expect(summarizeUsageCounterSamples([
      { phase: "pre_attach", counters: { tool_call: 1, screenshot: 0 } },
      { phase: "post_detach", counters: { tool_call: 8, screenshot: 3 } },
    ])).toEqual(expect.objectContaining({
      sample_count: 2,
      first_phase: "pre_attach",
      last_phase: "post_detach",
      delta: {
        tool_call: 7,
        screenshot: 3,
      },
      counter_names: ["screenshot", "tool_call"],
    }));
  });

  it("summarizes post-detach runtime resources as leak counters", () => {
    expect(summarizeRuntimeResourceSamples([
      {
        phase: "pre_attach",
        active_session_count: 0,
        active_frame_sink_count: 0,
      },
      {
        phase: "post_attach",
        active_session_count: 1,
        active_frame_sink_count: 1,
      },
      {
        phase: "post_detach",
        active_session_count: 0,
        active_frame_sink_count: 0,
      },
    ])).toEqual(expect.objectContaining({
      sample_count: 3,
      post_detach_observed: true,
      active_session_count_max: 1,
      active_frame_sink_count_max: 1,
      browser_session_leak_count: 0,
      frame_sink_leak_count: 0,
      leak_count_source: "post_detach_runtime_session_diagnostics",
    }));
  });

  it("extracts runtime resource counters from usage diagnostics", () => {
    expect(extractRuntimeResourceCounters({
      runtime_session_diagnostics: {
        session_state: "attached",
        active_session_count: 1,
        active_frame_sink_count: 1,
        attached_session_id: "sess-1",
      },
    })).toEqual({
      session_state: "attached",
      active_session_count: 1,
      active_frame_sink_count: 1,
      attached_session_id: "sess-1",
    });
  });
});
