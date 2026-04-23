/**
 * Prometheus-shape counter registry + event-log bridge for the MCP.
 *
 * Why hand-rolled instead of `prom-client`: the surface is small (six
 * counters), opt-in (only runs when `SYNTHI_PROMETHEUS_PORT` is set),
 * and bringing in a dep just to emit text is over-engineering. The
 * text format is stable (v0.0.4) and trivially renderable.
 *
 * Sum invariants (ultraplan v4.4, `locator_metrics.test.ts`):
 *   sum(synthi_locator_cache_dispatches_by_mode[*]) == total dispatches
 *   sum(synthi_locator_reresolutions_by_reason[*]) == total re-resolutions
 *
 * Metric names + labels lock in at phase 1. New labels are additive
 * only — do NOT rename a label, or the downstream PromQL dashboards
 * break silently.
 */

import type { EventLog } from "../events/log.js";
import type { EventLogEntry } from "../events/types.js";

/**
 * Prometheus counter. Labels are a stable set; adding a label name means
 * bumping the metric version. Values are monotonic; we never decrement.
 */
export class LabeledCounter {
  private readonly values = new Map<string, { labels: Record<string, string>; value: number }>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: readonly string[]
  ) {}

  private key(labels: Record<string, string>): string {
    // Stable order so the same label set always maps to the same key.
    const sorted = [...this.labelNames].sort().map((n) => `${n}=${labels[n] ?? ""}`);
    return sorted.join("|");
  }

  inc(labels: Record<string, string> = {}, by: number = 1): void {
    if (!Number.isFinite(by) || by < 0) return;
    // Defensive: ignore unknown labels so typos don't explode cardinality.
    const clean: Record<string, string> = {};
    for (const name of this.labelNames) {
      clean[name] = labels[name] ?? "";
    }
    const k = this.key(clean);
    const existing = this.values.get(k);
    if (existing) {
      existing.value += by;
    } else {
      this.values.set(k, { labels: clean, value: by });
    }
  }

  get(labels: Record<string, string> = {}): number {
    const clean: Record<string, string> = {};
    for (const name of this.labelNames) {
      clean[name] = labels[name] ?? "";
    }
    return this.values.get(this.key(clean))?.value ?? 0;
  }

  /** Sum across every label combination. Used by sum-invariant tests. */
  sumAll(): number {
    let total = 0;
    for (const { value } of this.values.values()) total += value;
    return total;
  }

  /** Snapshot of all label+value pairs for inspection / tests. */
  snapshot(): Array<{ labels: Record<string, string>; value: number }> {
    return Array.from(this.values.values()).map((v) => ({
      labels: { ...v.labels },
      value: v.value,
    }));
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    if (this.values.size === 0 && this.labelNames.length === 0) {
      // Unlabelled counter with zero observations — still emit a default
      // line so scrape tooling has something to anchor on.
      lines.push(`${this.name} 0`);
      return lines.join("\n");
    }
    for (const { labels, value } of this.values.values()) {
      if (this.labelNames.length === 0) {
        lines.push(`${this.name} ${value}`);
      } else {
        const labelStr = this.labelNames
          .map((n) => `${n}="${escapeLabel(labels[n] ?? "")}"`)
          .join(",");
        lines.push(`${this.name}{${labelStr}} ${value}`);
      }
    }
    return lines.join("\n");
  }

  clear(): void {
    this.values.clear();
  }
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

export class MetricsRegistry {
  private readonly counters = new Map<string, LabeledCounter>();

  counter(name: string, help: string, labelNames: readonly string[] = []): LabeledCounter {
    const existing = this.counters.get(name);
    if (existing) return existing;
    const c = new LabeledCounter(name, help, labelNames);
    this.counters.set(name, c);
    return c;
  }

  get(name: string): LabeledCounter | undefined {
    return this.counters.get(name);
  }

  render(): string {
    return Array.from(this.counters.values())
      .map((c) => c.render())
      .join("\n\n");
  }

  clear(): void {
    for (const c of this.counters.values()) c.clear();
  }

  _resetForTests(): void {
    this.counters.clear();
  }
}

export const metrics = new MetricsRegistry();

/**
 * Standard counter set. Declared once per process; handlers + the event-
 * log subscription increment them.
 */
export const TOOL_CALLS = metrics.counter(
  "synthi_tool_calls_total",
  "MCP tool invocations, labelled by tool name + outcome.",
  ["tool", "outcome"]
);

export const INPUTS_TOTAL = metrics.counter(
  "synthi_inputs_total",
  "Input dispatches sent to the worker, labelled by action.",
  ["action"]
);

export const SCREENSHOTS_TOTAL = metrics.counter(
  "synthi_screenshots_total",
  "Screenshots served to the agent."
);

export const VISION_INFERENCES_TOTAL = metrics.counter(
  "synthi_vision_inferences_total",
  "Server-side vision grounding calls, labelled by backend + model.",
  ["backend", "model"]
);

export const VISION_COST_USD = metrics.counter(
  "synthi_vision_cost_usd_total",
  "Cumulative vision-inference cost estimate in USD (per backend + model).",
  ["backend", "model"]
);

export const LOCATOR_CACHE_DISPATCHES = metrics.counter(
  "synthi_locator_cache_dispatches_by_mode",
  "Locator dispatches by cache outcome. sum over mode = total dispatches.",
  ["mode"]
);

export const LOCATOR_RERESOLUTIONS = metrics.counter(
  "synthi_locator_reresolutions_by_reason",
  "Locator re-resolutions by reason. sum over reason = total re-resolutions (= dispatches minus cached).",
  ["reason"]
);

export const EGRESS_BYTES = metrics.counter(
  "synthi_egress_bytes_total",
  "Bytes emitted back to the agent through tool responses, labelled by kind.",
  ["kind"]
);

/**
 * Record a completed tool call. Called from the top-level dispatcher in
 * `server.ts`. Treats `response.isError` as the error outcome (most tools
 * swallow their own exceptions and return structured error payloads).
 */
export function recordToolCall(tool: string, outcome: "ok" | "error"): void {
  TOOL_CALLS.inc({ tool, outcome });
}

/**
 * Classify a locator_resolution event's `reason` field into a short
 * bucket label suitable for Prometheus. Reason strings today look like
 * `hamming=7_under_threshold`, `re_resolved_via_claude_api(cached(ok))`,
 * `region_match_via_claude_api(claude_api(...))` — we want coarse buckets,
 * not a cardinality explosion of the full string.
 */
function classifyReason(reason: string): string {
  if (reason.startsWith("hamming=")) return "hamming_under_threshold";
  if (reason.startsWith("re_resolved_via_")) return "re_resolved";
  if (reason.startsWith("region_match_via_")) return "region_match";
  if (reason.startsWith("expired")) return "expired";
  if (reason.startsWith("drift")) return "drift";
  return "other";
}

function classifyBackend(model: string | undefined, backend: string | undefined): string {
  if (backend && typeof backend === "string") return backend;
  if (!model) return "unknown";
  if (model.startsWith("claude-")) return "claude_api";
  if (model.startsWith("gemini-")) return "gemini_api";
  return "unknown";
}

/**
 * Subscribe to an event log so relevant events auto-increment counters.
 * Returns an unsubscribe fn for tests / shutdown.
 */
export function bindEventLogToMetrics(log: EventLog): () => void {
  return log.onAppend((e: EventLogEntry) => {
    try {
      handleEvent(e);
    } catch {
      // metrics must never break the producer
    }
  });
}

function handleEvent(e: EventLogEntry): void {
  switch (e.kind) {
    case "usage": {
      if (e.metric === "vision_inference") {
        const detail = (e.detail ?? {}) as {
          backend?: unknown;
          model?: unknown;
          cost_usd?: unknown;
        };
        const model = typeof detail.model === "string" ? detail.model : "unknown";
        const backend = classifyBackend(model, typeof detail.backend === "string" ? detail.backend : undefined);
        VISION_INFERENCES_TOTAL.inc({ backend, model }, 1);
        if (typeof detail.cost_usd === "number" && Number.isFinite(detail.cost_usd) && detail.cost_usd >= 0) {
          VISION_COST_USD.inc({ backend, model }, detail.cost_usd);
        }
      } else if (e.metric === "screenshot") {
        SCREENSHOTS_TOTAL.inc({}, e.value ?? 1);
      } else if (e.metric === "egress_bytes") {
        const detail = (e.detail ?? {}) as { kind?: unknown };
        const kind = typeof detail.kind === "string" ? detail.kind : "other";
        EGRESS_BYTES.inc({ kind }, e.value ?? 0);
      }
      return;
    }
    case "locator_resolution": {
      LOCATOR_CACHE_DISPATCHES.inc({ mode: e.resolved_via });
      if (e.resolved_via !== "cached") {
        LOCATOR_RERESOLUTIONS.inc({ reason: classifyReason(e.reason) });
      }
      return;
    }
    case "input": {
      INPUTS_TOTAL.inc({ action: e.action });
      return;
    }
    default:
      return;
  }
}

/** Test-only: reset every registered counter. */
export function _resetMetricsForTests(): void {
  metrics.clear();
}
