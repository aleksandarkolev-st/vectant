import { describe, expect, it } from "vitest";

import {
  RED_TEAM_SCENARIOS,
  RELEASE_BLOCKER_CATEGORIES,
  RELEASE_BLOCKERS,
  UX_ACCEPTANCE_PROMPTS,
  summarizeLocalSupportReleaseReadiness,
} from "./acceptance";
import { readLocalSupportPolicy, signDeviceProof, validateRequestEnvelope } from "./controlPlane";

const DEVICE_PROOF_SECRET = "test-device-proof-secret";

const PLAN_SECURITY_BLOCKERS = [
  "loopback_bind_only",
  "non_loopback_bind_fails",
  "random_local_port",
  "auth_all_non_health",
  "origin_validation",
  "csrf_signed_nonce",
  "fetch_metadata",
  "pairing_ttl_rate_limits",
  "device_keypair_challenge",
  "pairing_fingerprint",
  "session_ttl",
  "request_replay_protection",
  "workspace_boundary",
  "symlink_junction_escape_tests",
  "denylist_local",
  "scanner_redactor",
  "scanner_failure_denies",
  "no_shell_execution",
  "no_filesystem_writes",
  "no_full_repo_upload",
  "no_broad_port_scan",
  "manual_port_approval",
  "host_based_preview_domain",
  "no_main_vectant_cookies_preview",
  "response_header_policy",
  "redirect_restrictions",
  "service_workers_blocked",
  "flow_control_rate_limits",
  "signed_installer_update",
  "org_kill_switch",
  "emergency_disable",
];

const PLAN_FRONTEND_BLOCKERS = [
  "persistent_banner",
  "overview_screen",
  "context_inventory",
  "sent_payload_history",
  "blocked_sensitive_items",
  "redaction_summaries",
  "review_before_send",
  "activity_log",
  "local_ports_screen",
  "permission_mode_screen",
  "pause_visible",
  "disconnect_visible",
  "revoke_controls",
  "export_delete_local_history",
  "clear_actor_identity",
  "available_vs_sent",
];

const PLAN_PRODUCT_BLOCKERS = [
  "onboarding_explains_risks",
  "workspace_picker_complete",
  "balanced_default",
  "manual_mode_available",
  "fast_support_bounded",
  "full_access_port_read_scoped",
  "agent_interaction_disabled",
  "error_states_understandable",
  "uninstall_stops_bridge",
  "update_required_state",
];

const REQUIRED_RED_TEAM_SCENARIOS = [
  "malicious_website_localhost_attack",
  "compromised_support_session",
  "malicious_repo_symlink_farm",
  "malicious_local_dev_server",
  "preview_ssrf_attempt",
  "secret_heavy_logs",
  "update_downgrade_attempt",
  "endpoint_fuzzing",
  "websocket_abuse",
  "confused_deputy_approval_flow",
];

const REQUIRED_UX_PROMPTS = [
  "connected_workspace",
  "sent_payloads",
  "blocked_items",
  "env_sent",
  "approved_ports",
  "ai_preview_read",
  "support_preview_read",
  "pause_control",
  "disconnect_control",
  "redactions",
  "fast_support_auto",
  "revoke_port",
  "delete_history",
];

function ids(items) {
  return new Set(items.map((item) => item.id));
}

describe("local support release acceptance evidence", () => {
  it("maps every release blocker from the security transparency plan to evidence", () => {
    const blockerIds = ids(RELEASE_BLOCKERS);
    for (const requiredId of [
      ...PLAN_SECURITY_BLOCKERS,
      ...PLAN_FRONTEND_BLOCKERS,
      ...PLAN_PRODUCT_BLOCKERS,
    ]) {
      expect(blockerIds.has(requiredId), requiredId).toBe(true);
    }

    const summary = summarizeLocalSupportReleaseReadiness();
    expect(summary.unmapped).toEqual([]);
    expect(summary.mapped).toBe(RELEASE_BLOCKERS.length);
    expect(summary.byCategory).toMatchObject({
      security: PLAN_SECURITY_BLOCKERS.length,
      frontend_transparency: PLAN_FRONTEND_BLOCKERS.length,
      product: PLAN_PRODUCT_BLOCKERS.length,
    });
  });

  it("keeps blocker ids unique, categorized, and release-readable", () => {
    expect(new Set(RELEASE_BLOCKERS.map((item) => item.id)).size).toBe(RELEASE_BLOCKERS.length);
    for (const blocker of RELEASE_BLOCKERS) {
      expect(RELEASE_BLOCKER_CATEGORIES).toContain(blocker.category);
      expect(blocker.label).toMatch(/\S/);
      expect(["partial", "ci_required"]).toContain(blocker.status);
      expect(blocker.evidence.length).toBeGreaterThan(0);
      for (const evidence of blocker.evidence) expect(evidence).toMatch(/\S/);
    }
  });

  it("keeps release-critical MVP capabilities disabled by default", () => {
    const policy = readLocalSupportPolicy({
      VECTANT_LOCAL_SUPPORT_ENABLED: "true",
      VECTANT_LOCAL_SUPPORT_DEVICE_PROOF_SECRET: DEVICE_PROOF_SECRET,
    });
    expect(policy.mvp).toMatchObject({
      balanced_mode_default: true,
      manual_mode_available: true,
      fast_support_enabled: true,
      agent_read_enabled: false,
      agent_interaction_enabled: false,
      persistent_port_approvals: false,
      shell_commands: false,
      file_writes: false,
      repo_upload: false,
    });

    for (const capability of [
      "workspace.file.write",
      "workspace.command.execute",
      "workspace.repo.upload",
      "localhost.preview.response_body",
      "localhost.preview.screenshot",
      "browser.console.read",
      "browser.network_summary.read",
    ]) {
      const envelope = {
        request_id: `req_${capability}`,
        session_id: "sess_acceptance",
        account_id: "acct_acceptance",
        org_id: "org_acceptance",
        workspace_id: "wk_acceptance",
        device_fingerprint: "sha256:aaaaaaaaaaaaaaaa",
        capability,
        actor: "support_agent",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        app_version: "0.1.0",
        protocol_version: "local-support-mvp.1",
        policy_version: "2026.07.05",
      };
      expect(validateRequestEnvelope({
        ...envelope,
        device_proof: signDeviceProof(envelope, DEVICE_PROOF_SECRET),
      }, policy)).toMatchObject({
        decision: "denied",
        bytes_sent: 0,
      });
    }
  });

  it("tracks every required red-team scenario before beta", () => {
    const scenarioIds = ids(RED_TEAM_SCENARIOS);
    for (const requiredId of REQUIRED_RED_TEAM_SCENARIOS) {
      expect(scenarioIds.has(requiredId), requiredId).toBe(true);
    }
    for (const scenario of RED_TEAM_SCENARIOS) {
      expect(scenario.status).toBe("planned");
      expect(scenario.evidence).toMatch(/\S/);
    }
  });

  it("tracks every UX acceptance prompt from the plan", () => {
    const promptIds = ids(UX_ACCEPTANCE_PROMPTS);
    for (const requiredId of REQUIRED_UX_PROMPTS) {
      expect(promptIds.has(requiredId), requiredId).toBe(true);
    }
    for (const prompt of UX_ACCEPTANCE_PROMPTS) {
      expect(prompt.question).toMatch(/\?$/);
      expect(prompt.answerEvidence).toMatch(/\S/);
    }
  });
});
