/**
 * Unit tests for the Prometheus metrics registry + event-log bridge.
 *
 * Covers ultraplan §4.4 locator counters (`locator_reresolutions_by_reason`,
 * `locator_cache_dispatches_by_mode`) with the v4.4 sum invariants:
 *   sum(mode[*])   == total dispatches
 *   sum(reason[*]) == total re-resolutions (= dispatches - cached)
 */

import { beforeEach, describe, it, expect } from "vitest";
import {
  LabeledCounter,
  MetricsRegistry,
  bindEventLogToMetrics,
  recordToolCall,
  metrics,
  TOOL_CALLS,
  INPUTS_TOTAL,
  SCREENSHOTS_TOTAL,
  VISION_INFERENCES_TOTAL,
  VISION_COST_USD,
  LOCATOR_CACHE_DISPATCHES,
  LOCATOR_RERESOLUTIONS,
  EGRESS_BYTES,
} from "../../src/observability/metrics.js";
import { EventLog } from "../../src/events/log.js";
import {
  renderPrometheusText,
  resolvePrometheusPort,
} from "../../src/observability/prometheus_server.js";

describe("LabeledCounter", () => {
  it("inc(labels) accumulates by labelset", () => {
    const c = new LabeledCounter("my_counter", "test", ["a", "b"]);
    c.inc({ a: "x", b: "1" });
    c.inc({ a: "x", b: "1" }, 3);
    c.inc({ a: "y", b: "1" });
    expect(c.get({ a: "x", b: "1" })).toBe(4);
    expect(c.get({ a: "y", b: "1" })).toBe(1);
    expect(c.sumAll()).toBe(5);
  });

  it("ignores unknown labels (no cardinality bomb from typos)", () => {
    const c = new LabeledCounter("my_counter", "test", ["tool"]);
    c.inc({ tool: "synthi_attach", typo: "extra" });
    expect(c.snapshot()).toHaveLength(1);
    expect(c.snapshot()[0]?.labels).toEqual({ tool: "synthi_attach" });
  });

  it("ignores non-positive increments", () => {
    const c = new LabeledCounter("my_counter", "test", []);
    c.inc({}, -1);
    c.inc({}, NaN);
    expect(c.sumAll()).toBe(0);
  });

  it("render emits valid Prometheus v0.0.4 text format", () => {
    const c = new LabeledCounter("synthi_example", "example help", ["kind"]);
    c.inc({ kind: "a" }, 2);
    c.inc({ kind: "b" });
    const text = c.render();
    expect(text).toContain("# HELP synthi_example example help");
    expect(text).toContain("# TYPE synthi_example counter");
    expect(text).toMatch(/synthi_example\{kind="a"\} 2/);
    expect(text).toMatch(/synthi_example\{kind="b"\} 1/);
  });

  it("render on unlabelled counter emits a default zero line when empty", () => {
    const c = new LabeledCounter("synthi_empty", "help", []);
    expect(c.render()).toContain("synthi_empty 0");
  });

  it("escapes label values (quotes, backslashes, newlines)", () => {
    const c = new LabeledCounter("synthi_x", "h", ["k"]);
    c.inc({ k: 'a"b\\c\nd' });
    expect(c.render()).toContain('k="a\\"b\\\\c\\nd"');
  });
});

describe("MetricsRegistry", () => {
  beforeEach(() => {
    metrics.clear();
  });

  it("counter() is idempotent (same name returns same instance)", () => {
    const reg = new MetricsRegistry();
    const a = reg.counter("x", "help", ["t"]);
    const b = reg.counter("x", "help_other", ["t"]);
    expect(a).toBe(b);
  });

  it("render concatenates every registered counter", () => {
    const reg = new MetricsRegistry();
    reg.counter("a", "help a", ["t"]).inc({ t: "1" });
    reg.counter("b", "help b", ["t"]).inc({ t: "2" });
    const text = reg.render();
    expect(text).toContain("# HELP a help a");
    expect(text).toContain("# HELP b help b");
  });
});

describe("bindEventLogToMetrics — vision + locator + input flow", () => {
  beforeEach(() => {
    metrics.clear();
  });

  it("usage{metric:vision_inference} increments backend+model counters + adds cost", () => {
    const log = new EventLog();
    const unbind = bindEventLogToMetrics(log);
    log.push({
      kind: "usage",
      metric: "vision_inference",
      value: 1,
      detail: { backend: "claude_api", model: "claude-opus-4-7", cost_usd: 0.015 },
    });
    log.push({
      kind: "usage",
      metric: "vision_inference",
      value: 1,
      detail: { backend: "gemini_api", model: "gemini-2.5-flash", cost_usd: 0.0003 },
    });
    expect(
      VISION_INFERENCES_TOTAL.get({ backend: "claude_api", model: "claude-opus-4-7" })
    ).toBe(1);
    expect(
      VISION_INFERENCES_TOTAL.get({ backend: "gemini_api", model: "gemini-2.5-flash" })
    ).toBe(1);
    expect(
      VISION_COST_USD.get({ backend: "claude_api", model: "claude-opus-4-7" })
    ).toBeCloseTo(0.015, 6);
    unbind();
  });

  it("infers backend from model id when detail.backend is omitted", () => {
    const log = new EventLog();
    bindEventLogToMetrics(log);
    log.push({
      kind: "usage",
      metric: "vision_inference",
      value: 1,
      detail: { model: "claude-sonnet-4-6", cost_usd: 0.003 },
    });
    expect(
      VISION_INFERENCES_TOTAL.get({ backend: "claude_api", model: "claude-sonnet-4-6" })
    ).toBe(1);
  });

  it("screenshot + egress_bytes + input events route to their counters", () => {
    const log = new EventLog();
    bindEventLogToMetrics(log);
    log.push({ kind: "usage", metric: "screenshot", value: 1 });
    log.push({
      kind: "usage",
      metric: "egress_bytes",
      value: 12345,
      detail: { kind: "screenshot" },
    });
    log.push({ kind: "input", action: "mouse:click", payload: {} });
    log.push({ kind: "input", action: "key:down", payload: {} });
    expect(SCREENSHOTS_TOTAL.sumAll()).toBe(1);
    expect(EGRESS_BYTES.get({ kind: "screenshot" })).toBe(12345);
    expect(INPUTS_TOTAL.get({ action: "mouse:click" })).toBe(1);
    expect(INPUTS_TOTAL.get({ action: "key:down" })).toBe(1);
  });

  it("locator_resolution increments mode counter; sum invariant holds", () => {
    const log = new EventLog();
    bindEventLogToMetrics(log);
    const makeEvent = (resolved_via: "cached" | "region_match" | "re_resolved", reason: string) =>
      log.push({
        kind: "locator_resolution",
        handle_id: "h1",
        description: "btn",
        resolved_via,
        reason,
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        region_phash: "ab",
      });
    makeEvent("cached", "hamming=2_under_threshold");
    makeEvent("cached", "hamming=1_under_threshold");
    makeEvent("region_match", "region_match_via_claude_api(ok)");
    makeEvent("re_resolved", "re_resolved_via_gemini_api(ok)");
    makeEvent("re_resolved", "re_resolved_via_claude_api(ok)");
    expect(LOCATOR_CACHE_DISPATCHES.sumAll()).toBe(5);
    expect(LOCATOR_CACHE_DISPATCHES.get({ mode: "cached" })).toBe(2);
    expect(LOCATOR_CACHE_DISPATCHES.get({ mode: "region_match" })).toBe(1);
    expect(LOCATOR_CACHE_DISPATCHES.get({ mode: "re_resolved" })).toBe(2);
  });

  it("re-resolution reasons classified + sum invariant vs total re-resolutions", () => {
    const log = new EventLog();
    bindEventLogToMetrics(log);
    const push = (resolved_via: "cached" | "region_match" | "re_resolved", reason: string) =>
      log.push({
        kind: "locator_resolution",
        handle_id: "h",
        description: "x",
        resolved_via,
        reason,
        bbox: { x: 0, y: 0, w: 1, h: 1 },
        region_phash: "c",
      });
    push("cached", "hamming=0");
    push("cached", "hamming=0");
    push("region_match", "region_match_via_claude_api(ok)");
    push("re_resolved", "re_resolved_via_claude_api(ok)");
    push("re_resolved", "re_resolved_via_gemini_api(ok)");

    // Sum-invariant: total non-cached == sum(reasons).
    const nonCached =
      LOCATOR_CACHE_DISPATCHES.get({ mode: "region_match" }) +
      LOCATOR_CACHE_DISPATCHES.get({ mode: "re_resolved" });
    expect(LOCATOR_RERESOLUTIONS.sumAll()).toBe(nonCached);
    // 1 region_match + 2 re_resolved = 3
    expect(LOCATOR_RERESOLUTIONS.sumAll()).toBe(3);
  });
});

describe("recordToolCall", () => {
  beforeEach(() => {
    metrics.clear();
  });

  it("increments by (tool, outcome)", () => {
    recordToolCall("synthi_attach", "ok");
    recordToolCall("synthi_attach", "ok");
    recordToolCall("synthi_attach", "error");
    recordToolCall("synthi_screenshot", "ok");
    expect(TOOL_CALLS.get({ tool: "synthi_attach", outcome: "ok" })).toBe(2);
    expect(TOOL_CALLS.get({ tool: "synthi_attach", outcome: "error" })).toBe(1);
    expect(TOOL_CALLS.get({ tool: "synthi_screenshot", outcome: "ok" })).toBe(1);
    expect(TOOL_CALLS.sumAll()).toBe(4);
  });
});

describe("renderPrometheusText + resolvePrometheusPort", () => {
  beforeEach(() => {
    metrics.clear();
  });

  it("renderPrometheusText aggregates all declared counters", () => {
    recordToolCall("synthi_attach", "ok");
    const text = renderPrometheusText();
    expect(text).toContain("synthi_tool_calls_total");
    expect(text).toContain('tool="synthi_attach"');
    expect(text).toContain('outcome="ok"');
  });

  it("resolvePrometheusPort accepts valid ports", () => {
    expect(resolvePrometheusPort("9464")).toBe(9464);
    expect(resolvePrometheusPort("1")).toBe(1);
    expect(resolvePrometheusPort("65535")).toBe(65535);
  });

  it("resolvePrometheusPort rejects nonsense values", () => {
    expect(resolvePrometheusPort(undefined)).toBeUndefined();
    expect(resolvePrometheusPort("")).toBeUndefined();
    expect(resolvePrometheusPort("abc")).toBeUndefined();
    expect(resolvePrometheusPort("-5")).toBeUndefined();
    expect(resolvePrometheusPort("70000")).toBeUndefined();
  });
});
