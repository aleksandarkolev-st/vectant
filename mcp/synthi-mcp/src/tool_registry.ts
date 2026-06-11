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
  // General browser runtime
  "synthi_browser_attach_current_workspace",
  "synthi_browser_observe",
  "synthi_browser_observe_preview",
  "synthi_browser_begin_teach",
  "synthi_browser_end_teach",
  "synthi_browser_attach",
  "synthi_browser_list_tabs",
  "synthi_browser_select_tab",
  "synthi_browser_open",
  "synthi_browser_close_tab",
  "synthi_browser_request_consent",
  "synthi_browser_get_consent",
  "synthi_browser_revoke_consent",
  "synthi_browser_snapshot",
  "synthi_browser_start_teach",
  "synthi_browser_stop_teach",
  "synthi_browser_get_trace",
  "synthi_browser_get_trace_status",
  "synthi_browser_get_lane0_status",
  "synthi_browser_answer_teach_question",
  "synthi_browser_get_workflow_card",
  "synthi_browser_get_unresolved_steps",
  "synthi_browser_compile_workflow",
  "synthi_browser_generate_script",
  "synthi_browser_generate_private_tool_manifest",
  "synthi_browser_publish_private_tool",
  "synthi_browser_list_private_tools",
  "synthi_browser_get_private_tool_manifest",
  "synthi_browser_capture_auth_checkpoint_storage",
  "synthi_browser_run_workflow",
  "synthi_browser_explain_failure",
  "synthi_browser_acquire_lease",
  "synthi_browser_release_lease",
  "synthi_browser_action",
  "synthi_browser_wait",
  "synthi_browser_get_console",
  "synthi_browser_get_network",
  "synthi_browser_detect_project",
  "synthi_browser_run_project",
  "synthi_browser_project_status",
  "synthi_browser_stop_project",
  "synthi_browser_get_deployment_readiness",
  // Agent Dojo licensed competencies
  "synthi_dojo_list_competencies",
  "synthi_dojo_get_skill",
  "synthi_dojo_get_skill_assurance_case",
  "synthi_dojo_get_entrustment_level",
  "synthi_dojo_get_license",
  "synthi_dojo_get_guardrails",
  "synthi_dojo_get_case_law",
  "synthi_dojo_explain_block",
  "synthi_dojo_request_permission_upgrade",
  "synthi_dojo_generate_vivarium_scenarios",
  "synthi_dojo_run_checkride",
  "synthi_dojo_publish_skill",
  "synthi_dojo_recertify_skill",
  "synthi_dojo_issue_proof_capsule",
  "synthi_dojo_run_with_proof_capsule",
  // Auth checkpoint readiness
  "synthi_auth_begin_checkpoint_enrollment",
  "synthi_auth_finish_checkpoint_enrollment",
  "synthi_auth_list_checkpoints",
  "synthi_auth_revoke_checkpoint",
  "synthi_auth_configure_refresh_provider",
  "synthi_auth_test_refresh_provider",
  "synthi_auth_get_tool_auth_readiness",
  // Workspace source identity
  "synthi_source_register_tokens",
  "synthi_source_lookup_token",
  "synthi_source_open_in_ide",
  "synthi_source_get_mapping_status",
  "synthi_source_suggest_affordance_patch",
  // Replay safety and mutation isolation
  "synthi_safety_get_mutation_plan",
  "synthi_safety_set_replay_isolation_profile",
  "synthi_safety_run_prefix_validation",
  "synthi_safety_run_ci_isolated_replay",
  "synthi_safety_explain_blocked_hardening",
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
  "synthi_dispatch_input",
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
  "synthi_renew_input",
  "synthi_release_input",
  "synthi_force_release_input",
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
  // Phase 3 — snapshot / restore + escape-hatch answer tool.
  "synthi_snapshot",
  "synthi_restore",
  "synthi_list_snapshots",
  "synthi_answer_escape_hatch",
] as const;

export type AdvertisedToolName = (typeof ADVERTISED_TOOLS)[number];
