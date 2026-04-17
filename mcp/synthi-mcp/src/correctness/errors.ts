/**
 * Central registry of server-enforced error codes. Ultraplan §4.10 lists
 * ~25 rows; this module implements the phase-1 subset (rest are wire-
 * reserved for the worker to surface).
 *
 * Each code carries:
 *   - `code`: the stable wire string
 *   - `priority`: deterministic ordering when multiple checks could fire.
 *     Lower wins (1 is highest-priority).
 *   - `build(detail)`: returns the full error payload with required_tool_call
 *     populated where applicable.
 *
 * The priority ladder (§4.10) prevents non-determinism when an action
 * fails two checks: the agent always sees the most-actionable error.
 */

export interface ErrorPayload {
  error: string;
  priority: number;
  required_tool_call?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ErrorSpec {
  code: string;
  priority: number;
  build(detail?: Record<string, unknown>): ErrorPayload;
}

const SPECS: Record<string, ErrorSpec> = {
  unsafe_signaling: {
    code: "unsafe_signaling",
    priority: 1,
    build: (detail) => ({
      error: "unsafe_signaling",
      priority: 1,
      required_tool_call: {
        tool: "synthi_attach",
        suggested_args: { "i-understand-no-auth": true, ...((detail?.["suggested_args"] as object | undefined) ?? {}) },
      },
      ...(detail ?? {}),
    }),
  },
  session_terminated: {
    code: "session_terminated",
    priority: 2,
    build: (detail) => ({
      error: "session_terminated",
      priority: 2,
      required_tool_call: { tool: "synthi_attach", suggested_args: {} },
      ...(detail ?? {}),
    }),
  },
  session_migrating: {
    code: "session_migrating",
    priority: 3,
    build: (detail) => ({
      error: "session_migrating",
      priority: 3,
      required_tool_call: { tool: "synthi_wait", suggested_args: { condition: "log", pattern: "lifecycle.*running", timeoutMs: 60000 } },
      ...(detail ?? {}),
    }),
  },
  session_not_ready: {
    code: "session_not_ready",
    priority: 4,
    build: (detail) => ({
      error: "session_not_ready",
      priority: 4,
      required_tool_call: { tool: "synthi_wait", suggested_args: { condition: "log", pattern: "lifecycle.*running", timeoutMs: 60000 } },
      ...(detail ?? {}),
    }),
  },
  input_rejected_awaiting_ack: {
    code: "input_rejected_awaiting_ack",
    priority: 5,
    build: (detail) => ({
      error: "input_rejected_awaiting_ack",
      priority: 5,
      required_tool_call: { tool: "synthi_acknowledge_disruption", suggested_args: {} },
      ...(detail ?? {}),
    }),
  },
  input_queue_full: {
    code: "input_queue_full",
    priority: 6,
    build: (detail) => ({
      error: "input_queue_full",
      priority: 6,
      ...(detail ?? {}),
    }),
  },
  frame_stale: {
    code: "frame_stale",
    priority: 7,
    build: (detail) => ({
      error: "frame_stale",
      priority: 7,
      ...(detail ?? {}),
    }),
  },
  process_hung: {
    code: "process_hung",
    priority: 8,
    build: (detail) => ({
      error: "process_hung",
      priority: 8,
      ...(detail ?? {}),
    }),
  },
  click_out_of_bounds: {
    code: "click_out_of_bounds",
    priority: 9,
    build: (detail) => ({
      error: "click_out_of_bounds",
      priority: 9,
      ...(detail ?? {}),
    }),
  },
  no_focus_target: {
    code: "no_focus_target",
    priority: 10,
    build: (detail) => ({
      error: "no_focus_target",
      priority: 10,
      ...(detail ?? {}),
    }),
  },
  locator_expired: {
    code: "locator_expired",
    priority: 11,
    build: (detail) => ({
      error: "locator_expired",
      priority: 11,
      required_tool_call: { tool: "synthi_locate", suggested_args: { reuse_handle: false } },
      ...(detail ?? {}),
    }),
  },
  locator_drift: {
    code: "locator_drift",
    priority: 12,
    build: (detail) => ({
      error: "locator_drift",
      priority: 12,
      required_tool_call: { tool: "synthi_locate", suggested_args: { reuse_handle: false } },
      ...(detail ?? {}),
    }),
  },
  locator_unresolved: {
    code: "locator_unresolved",
    priority: 13,
    build: (detail) => ({
      error: "locator_unresolved",
      priority: 13,
      ...(detail ?? {}),
    }),
  },
  locator_ambiguous: {
    code: "locator_ambiguous",
    priority: 14,
    build: (detail) => ({
      error: "locator_ambiguous",
      priority: 14,
      required_tool_call: { tool: "synthi_locate", suggested_args: { hints: {} } },
      ...(detail ?? {}),
    }),
  },
  capability_not_available: {
    code: "capability_not_available",
    priority: 15,
    build: (detail) => ({
      error: "capability_not_available",
      priority: 15,
      ...(detail ?? {}),
    }),
  },
  quota_exceeded: {
    code: "quota_exceeded",
    priority: 16,
    build: (detail) => ({
      error: "quota_exceeded",
      priority: 16,
      ...(detail ?? {}),
    }),
  },
  confirmation_required: {
    code: "confirmation_required",
    priority: 17,
    build: (detail) => ({
      error: "confirmation_required",
      priority: 17,
      ...(detail ?? {}),
    }),
  },
};

export const ERROR_PRIORITY = Object.fromEntries(
  Object.entries(SPECS).map(([k, s]) => [k, s.priority])
);

export function buildError(code: string, detail?: Record<string, unknown>): ErrorPayload {
  const spec = SPECS[code];
  if (!spec) return { error: code, priority: 99, ...(detail ?? {}) };
  return spec.build(detail);
}

/**
 * Deterministic priority sort. Returns the highest-priority (lowest number)
 * of a list of candidate error codes. Used when multiple checks would fire
 * for a single action.
 */
export function pickHighestPriority(codes: string[]): string | null {
  if (codes.length === 0) return null;
  let best = codes[0]!;
  let bestPriority = SPECS[best]?.priority ?? 99;
  for (let i = 1; i < codes.length; i++) {
    const p = SPECS[codes[i]!]?.priority ?? 99;
    if (p < bestPriority) {
      best = codes[i]!;
      bestPriority = p;
    }
  }
  return best;
}
