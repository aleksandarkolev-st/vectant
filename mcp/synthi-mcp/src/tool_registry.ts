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
  "synthi_describe",
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
  "synthi_report_source_state",
  // Operational
  "synthi_get_usage",
  "synthi_set_quality",
  "synthi_checkpoint",
  "synthi_acknowledge_disruption",
  "synthi_get_crash_info",
  "synthi_reset_guest",
  // Arbitration wire (phase-1 record-only; enforcement is phase 2c)
  "synthi_acquire_input",
  "synthi_release_input",
  // Escape hatch wire (phase-1 stubs returning escape_hatch_backend_not_implemented)
  "synthi_request_human",
  "synthi_annotate_and_ask",
  "synthi_recent_human_actions",
  // Enriched tier (phase 2b — runtime-advertised; stubs return
  // enriched_tier_not_available until a provider attaches)
  "synthi_query",
  "synthi_act",
  "synthi_click_text",
  "synthi_fill_form",
  "synthi_get_labels",
  "synthi_get_process_state",
  "synthi_get_metrics",
  // Audio (phase 2d — worker audio-tee exists; peak emission is the
  // remaining hook). Stubs return audio_backend_not_implemented.
  "synthi_get_audio_level",
  "synthi_wait_audio_event",
] as const;

export type AdvertisedToolName = (typeof ADVERTISED_TOOLS)[number];
