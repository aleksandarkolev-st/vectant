/**
 * Quota enforcement — ultraplan §Cost observability + §Phase 2d.
 *
 * Phase 1 shipped metrics: synthi_get_usage surfaces counters, Prometheus
 * exposes them, but nothing rejects a runaway loop. Phase 2d adds a
 * soft gate: when configured cost / rate ceilings are exceeded over a
 * rolling window, the MCP returns `quota_exceeded` (priority 16) instead
 * of executing the tool call.
 *
 * Opt-in via env:
 *
 *   SYNTHI_QUOTA_MODE=off      default — metrics only, no gating
 *   SYNTHI_QUOTA_MODE=warn     log a security event on breach, still dispatch
 *   SYNTHI_QUOTA_MODE=enforce  reject the tool call with quota_exceeded
 *
 *   SYNTHI_QUOTA_VISION_COST_USD_PER_HR    default 5.00 — rolling-60m vision cost
 *   SYNTHI_QUOTA_TOOL_CALLS_PER_MIN        default 120  — rolling-60s tool calls
 *   SYNTHI_QUOTA_SCREENSHOTS_PER_MIN       default 30   — rolling-60s screenshot calls
 *
 * The gate runs before every tool dispatch in `server.ts`. It only
 * inspects the MCP-local event log; worker-side quota (kill-on-budget-
 * blown, per-pod CPU throttling) is out of scope.
 */

import { eventLog } from "../events/index.js";
import type { UsageEvent } from "../events/index.js";
import { buildError, type ErrorPayload } from "../correctness/errors.js";

export type QuotaMode = "off" | "warn" | "enforce";

export interface QuotaLimits {
  vision_cost_usd_per_hr: number;
  tool_calls_per_min: number;
  screenshots_per_min: number;
}

const DEFAULT_LIMITS: QuotaLimits = {
  vision_cost_usd_per_hr: 5.0,
  tool_calls_per_min: 120,
  screenshots_per_min: 30,
};

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

export function resolveQuotaMode(): QuotaMode {
  const raw = process.env["SYNTHI_QUOTA_MODE"];
  if (raw === "warn") return "warn";
  if (raw === "enforce") return "enforce";
  return "off";
}

export function resolveQuotaLimits(): QuotaLimits {
  return {
    vision_cost_usd_per_hr: parsePositiveNumber(
      process.env["SYNTHI_QUOTA_VISION_COST_USD_PER_HR"],
      DEFAULT_LIMITS.vision_cost_usd_per_hr
    ),
    tool_calls_per_min: parsePositiveNumber(
      process.env["SYNTHI_QUOTA_TOOL_CALLS_PER_MIN"],
      DEFAULT_LIMITS.tool_calls_per_min
    ),
    screenshots_per_min: parsePositiveNumber(
      process.env["SYNTHI_QUOTA_SCREENSHOTS_PER_MIN"],
      DEFAULT_LIMITS.screenshots_per_min
    ),
  };
}

// Tools that consume vision budget. `synthi_locate` + `synthi_describe`
// call claude_api / gemini_api when a server-side backend is configured;
// `synthi_screenshot` is counted separately under screenshots-per-minute.
const VISION_TOOLS = new Set(["synthi_locate", "synthi_describe"]);

interface Totals {
  vision_cost_usd: number;
  tool_calls: number;
  screenshots: number;
}

function windowedTotals(windowSecSince: { min: number; hr: number }, now: number): Totals {
  const minCutoff = now - windowSecSince.min * 1000;
  const hrCutoff = now - windowSecSince.hr * 1000;
  const usages = eventLog.query({ kind: "usage" }) as UsageEvent[];
  const t: Totals = { vision_cost_usd: 0, tool_calls: 0, screenshots: 0 };
  for (const u of usages) {
    const ts = u.ts;
    if (u.metric === "tool_call" && ts >= minCutoff) {
      t.tool_calls += u.value;
    } else if (u.metric === "screenshot" && ts >= minCutoff) {
      t.screenshots += u.value;
    } else if (u.metric === "vision_inference" && ts >= hrCutoff) {
      const detail = u.detail as { cost_usd?: unknown } | undefined;
      if (detail && typeof detail.cost_usd === "number") {
        t.vision_cost_usd += detail.cost_usd;
      }
    }
  }
  return t;
}

export interface QuotaBreach {
  metric: "vision_cost_usd_per_hr" | "tool_calls_per_min" | "screenshots_per_min";
  current: number;
  limit: number;
  tool: string;
}

/**
 * Returns the first quota breach triggered by a would-be dispatch of `toolName`,
 * or null when the call is within every budget. Metrics-only mode always
 * returns null — use `resolveQuotaMode()` first to decide whether to
 * enforce, warn, or ignore.
 */
export function checkQuota(toolName: string, now: number = Date.now()): QuotaBreach | null {
  const limits = resolveQuotaLimits();
  const totals = windowedTotals({ min: 60, hr: 3600 }, now);

  // Every tool is rate-limited on aggregate calls-per-minute.
  if (totals.tool_calls >= limits.tool_calls_per_min) {
    return {
      metric: "tool_calls_per_min",
      current: totals.tool_calls,
      limit: limits.tool_calls_per_min,
      tool: toolName,
    };
  }
  if (toolName === "synthi_screenshot" && totals.screenshots >= limits.screenshots_per_min) {
    return {
      metric: "screenshots_per_min",
      current: totals.screenshots,
      limit: limits.screenshots_per_min,
      tool: toolName,
    };
  }
  if (VISION_TOOLS.has(toolName) && totals.vision_cost_usd >= limits.vision_cost_usd_per_hr) {
    return {
      metric: "vision_cost_usd_per_hr",
      current: Number(totals.vision_cost_usd.toFixed(4)),
      limit: limits.vision_cost_usd_per_hr,
      tool: toolName,
    };
  }
  return null;
}

/**
 * Server-dispatch adapter. Called before every tool call. Returns:
 *   - `null` to proceed with dispatch
 *   - ErrorPayload to short-circuit with `quota_exceeded`
 *
 * Side-effect: emits a security event on every breach so `synthi_get_event_log`
 * surfaces the history (both in warn and enforce modes).
 */
export function enforceQuota(toolName: string): ErrorPayload | null {
  const mode = resolveQuotaMode();
  if (mode === "off") return null;
  const breach = checkQuota(toolName);
  if (!breach) return null;
  eventLog.push({
    kind: "security",
    code: "rate_limit_warning",
    detail: {
      code: "quota_exceeded",
      mode,
      ...breach,
    },
  });
  if (mode === "warn") return null;
  return buildError("quota_exceeded", {
    metric: breach.metric,
    current: breach.current,
    limit: breach.limit,
    tool: breach.tool,
    window:
      breach.metric === "vision_cost_usd_per_hr"
        ? "rolling_3600s"
        : "rolling_60s",
  });
}
