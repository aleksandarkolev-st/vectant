/**
 * Single source of truth for the MCP's advertised tool names. Consumed by
 * both `server.ts` (ListTools handler) and `tools/attach.ts` (capability
 * manifest). Keep this list aligned with the actual schema registrations;
 * adding or removing a tool in one place without the other drifts the
 * manifest.
 *
 * Order is informational — it reflects the ultraplan's core-13 grouping
 * so the agent sees tools in a predictable order when introspecting.
 */

export const ADVERTISED_TOOLS = [
  // Lifecycle
  "synthi_attach",
  "synthi_detach",
  "synthi_reconnect",
  "synthi_health",
  // Observation
  "synthi_screenshot",
  "synthi_wait",
  "synthi_wait_hmr",
  // Build control
  "synthi_compile",
  // Input
  "synthi_mouse",
  "synthi_keyboard",
  "synthi_click",
  "synthi_type",
  // Semantic addressing
  "synthi_locate",
  // Verification
  "synthi_verify",
  // Event log / telemetry / source state
  "synthi_get_event_log",
  "synthi_get_source_state",
  // Operational
  "synthi_get_usage",
  "synthi_set_quality",
  "synthi_checkpoint",
  "synthi_acknowledge_disruption",
  "synthi_get_crash_info",
  "synthi_reset_guest",
] as const;

export type AdvertisedToolName = (typeof ADVERTISED_TOOLS)[number];
