import { afterEach, describe, expect, it } from "vitest";

import {
  clearRequestEnvelopeReplayCache,
  buildRelayForwardDecision,
  enforceRequestEnvelopeReplayProtection,
  evaluatePolicyPrecedence,
  readLocalSupportPolicy,
  signRequestEnvelope,
  summarizeSecurityEvent,
  validateRequestEnvelope,
  verifyRequestEnvelopeSignature,
} from "./controlPlane";

const future = () => new Date(Date.now() + 60_000).toISOString();

afterEach(() => {
  clearRequestEnvelopeReplayCache();
});

function envelope(overrides = {}) {
  return {
    request_id: "req_123",
    session_id: "sess_123",
    workspace_id: "wk_123",
    capability: "workspace.file.source.read",
    actor: "vectant_ai",
    expires_at: future(),
    app_version: "0.1.0",
    ...overrides,
  };
}

describe("local support control plane policy", () => {
  it("fails closed when the feature is disabled or org killed", () => {
    const disabled = readLocalSupportPolicy({});
    expect(validateRequestEnvelope(envelope(), disabled)).toMatchObject({
      decision: "denied",
      reason: "feature_disabled",
      bytes_sent: 0,
    });

    const killed = readLocalSupportPolicy({
      VECTANT_LOCAL_SUPPORT_ENABLED: "true",
      VECTANT_LOCAL_SUPPORT_ORG_DISABLED: "true",
    });
    expect(killed.enabled).toBe(false);
    expect(validateRequestEnvelope(envelope(), killed).reason).toBe("feature_disabled");
  });

  it("rejects old app versions and expired envelopes", () => {
    const policy = readLocalSupportPolicy({
      VECTANT_LOCAL_SUPPORT_ENABLED: "true",
      VECTANT_LOCAL_SUPPORT_MIN_APP_VERSION: "0.2.0",
    });
    expect(validateRequestEnvelope(envelope({ app_version: "0.1.9" }), policy).reason).toBe("app_version_too_old");
    expect(validateRequestEnvelope(envelope({ app_version: "0.2.0", expires_at: "2020-01-01T00:00:00Z" }), policy).reason).toBe("expired_request");
  });

  it("exposes emergency controls and blocks revoked versions", () => {
    const policy = readLocalSupportPolicy({
      VECTANT_LOCAL_SUPPORT_ENABLED: "true",
      VECTANT_LOCAL_SUPPORT_PAIRING_DISABLED: "true",
      VECTANT_LOCAL_SUPPORT_PREVIEW_GATEWAY_DISABLED: "true",
      VECTANT_LOCAL_SUPPORT_VULNERABLE_VERSIONS: "0.1.1, 0.1.2",
      VECTANT_LOCAL_SUPPORT_DISABLED_REASON: "Emergency disable active.",
    });

    expect(policy.enabled).toBe(false);
    expect(policy.disabled_reason).toBe("Emergency disable active.");
    expect(policy.emergency_controls).toMatchObject({
      pairing_disabled: true,
      preview_gateway_disabled: true,
      agent_access_disabled: true,
    });

    const requestsEnabled = { ...policy, enabled: true };
    expect(validateRequestEnvelope(envelope({ app_version: "0.1.2" }), requestsEnabled)).toMatchObject({
      decision: "denied",
      reason: "app_version_blocked",
    });
  });

  it("exposes retention controls and no-retention mode", () => {
    const retained = readLocalSupportPolicy({
      VECTANT_LOCAL_SUPPORT_ENABLED: "true",
      VECTANT_LOCAL_SUPPORT_RETENTION_DAYS: "120",
    });
    expect(retained.retention).toMatchObject({
      no_retention: false,
      local_activity_days: 90,
      cloud_security_event_days: 90,
      raw_bodies_allowed: false,
    });

    const noRetention = readLocalSupportPolicy({
      VECTANT_LOCAL_SUPPORT_ENABLED: "true",
      VECTANT_LOCAL_SUPPORT_NO_RETENTION: "true",
    });
    expect(noRetention.retention).toMatchObject({
      no_retention: true,
      local_activity_days: 0,
      cloud_security_event_days: 0,
    });
    expect(
      summarizeSecurityEvent({ event_type: "bad_origin", target: "https://evil.example" }, noRetention),
    ).toMatchObject({
      decision: "recorded",
      retention_days: 0,
      raw_body_included: false,
    });
  });

  it("blocks writes, command execution, repo upload, and AI preview reading in the MVP", () => {
    const policy = readLocalSupportPolicy({ VECTANT_LOCAL_SUPPORT_ENABLED: "true" });
    for (const capability of [
      "workspace.file.write",
      "workspace.command.execute",
      "workspace.repo.upload",
      "localhost.preview.response_body",
      "localhost.preview.screenshot",
      "browser.console.read",
      "browser.network_summary.read",
    ]) {
      expect(validateRequestEnvelope(envelope({ capability }), policy)).toMatchObject({
        decision: "denied",
        reason: "capability_blocked_in_mvp",
        bytes_sent: 0,
      });
    }

    expect(
      validateRequestEnvelope(
        envelope({ capability: "localhost.preview.browser", actor: "vectant_ai" }),
        policy,
      ),
    ).toMatchObject({
      decision: "denied",
      reason: "agent_preview_read_separate_permission_required",
    });
  });

  it("allows only approval-gated MVP read capabilities", () => {
    const policy = readLocalSupportPolicy({ VECTANT_LOCAL_SUPPORT_ENABLED: "true" });
    expect(validateRequestEnvelope(envelope({ capability: "workspace.log.read" }), policy)).toMatchObject({
      decision: "approval_required",
      local_enforcement_required: true,
      bytes_sent: 0,
    });
  });

  it("enforces policy precedence above item-specific approval", () => {
    expect(
      evaluatePolicyPrecedence({
        emergency_remote_kill_switch: { decision: "denied", reason: "Emergency disable active." },
        item_specific_approval: "approved",
        final_scanner_redactor_decision: "allow",
      }),
    ).toMatchObject({
      decision: "denied",
      reason: "blocked_by_emergency_remote_kill_switch",
      blocked_layer: "emergency_remote_kill_switch",
      bytes_sent: 0,
    });

    expect(
      evaluatePolicyPrecedence({
        enterprise_org_policy: { decision: "denied", reason: "Port preview disabled by organization." },
        item_specific_approval: "approved",
        final_scanner_redactor_decision: "allow",
      }),
    ).toMatchObject({
      decision: "denied",
      reason: "blocked_by_enterprise_org_policy",
      blocked_layer: "enterprise_org_policy",
    });

    expect(
      evaluatePolicyPrecedence({
        workspace_policy: { decision: "denied", reason: ".ssh remains blocked." },
        item_specific_approval: "approved",
        final_scanner_redactor_decision: "allow",
      }),
    ).toMatchObject({
      decision: "denied",
      reason: "blocked_by_workspace_policy",
      blocked_layer: "workspace_policy",
    });
  });

  it("requires final scanner approval even after user approval", () => {
    expect(
      evaluatePolicyPrecedence({
        item_specific_approval: "approved",
        final_scanner_redactor_decision: { decision: "denied", reason: "Scanner failed closed." },
      }),
    ).toMatchObject({
      decision: "denied",
      reason: "blocked_by_final_scanner_redactor_decision",
      blocked_layer: "final_scanner_redactor_decision",
      bytes_sent: 0,
    });

    expect(
      evaluatePolicyPrecedence({
        item_specific_approval: "approved",
        final_scanner_redactor_decision: "allow",
      }),
    ).toMatchObject({
      decision: "allowed_after_local_checks",
      reason: "all_policy_layers_allowed",
      blocked_layer: null,
      bytes_sent: 0,
    });
  });

  it("signs request envelopes canonically and detects tampering", () => {
    const secret = "test-envelope-secret";
    const body = envelope({ capability: "workspace.log.read" });
    const reordered = {
      app_version: body.app_version,
      expires_at: body.expires_at,
      actor: body.actor,
      capability: body.capability,
      workspace_id: body.workspace_id,
      session_id: body.session_id,
      request_id: body.request_id,
    };
    const signature = signRequestEnvelope(body, secret);

    expect(signature).toBe(signRequestEnvelope(reordered, secret));
    expect(verifyRequestEnvelopeSignature({ ...body, signature }, secret)).toMatchObject({
      decision: "verified",
      reason: "request_envelope_signature_valid",
    });
    expect(
      verifyRequestEnvelopeSignature({ ...body, capability: "workspace.metadata.read", signature }, secret),
    ).toMatchObject({
      decision: "denied",
      reason: "request_envelope_signature_invalid",
      bytes_sent: 0,
    });
  });

  it("records request envelope nonces and rejects replay", () => {
    const body = envelope({
      request_id: "req_replay",
      session_id: "sess_replay",
      expires_at: new Date(1_000_000).toISOString(),
    });

    expect(enforceRequestEnvelopeReplayProtection(body, 900_000)).toMatchObject({
      decision: "accepted",
      reason: "request_replay_nonce_recorded",
      bytes_sent: 0,
    });
    expect(enforceRequestEnvelopeReplayProtection(body, 900_001)).toMatchObject({
      decision: "denied",
      reason: "request_replay_detected",
      bytes_sent: 0,
    });
    expect(enforceRequestEnvelopeReplayProtection({ ...body, request_id: "req_replay_2" }, 1_000_001)).toMatchObject({
      decision: "accepted",
      reason: "request_replay_nonce_recorded",
    });
  });

  it("records scrubbed security events without raw local content", () => {
    const policy = readLocalSupportPolicy({ VECTANT_LOCAL_SUPPORT_ENABLED: "true" });
    const event = summarizeSecurityEvent(
      {
        event_type: "denied_secret_request",
        count: 3,
        session_id: "sess_123",
        request_id: "req_123",
        target: ".env Authorization: Bearer abcdefghijklmnopqrstuvwxyz postgres://user:pass@localhost/db",
      },
      policy,
    );

    expect(event).toMatchObject({
      accepted: true,
      decision: "recorded",
      event_type: "denied_secret_request",
      severity: "critical",
      alert: true,
      alert_route: "local_support.security.critical",
      raw_body_included: false,
    });
    expect(event.dedupe_key).toMatch(/^sha256:/);
    expect(event.target_display).toContain("[REDACTED:database_url]");
    expect(event.target_display).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(event.target_display).not.toContain("postgres://user:pass");
  });

  it("routes required operational security alerts by severity without raw bodies", () => {
    const policy = readLocalSupportPolicy({ VECTANT_LOCAL_SUPPORT_ENABLED: "true" });
    const cases = [
      ["bad_origin", 10, "high", "local_support.security.high"],
      ["old_version", 1, "medium", "local_support.security.watch"],
      ["app_version_too_old", 1, "medium", "local_support.security.watch"],
      ["traffic_spike", 5, "high", "local_support.security.high"],
      ["scanner_failure", 1, "critical", "local_support.security.critical"],
      ["rate_limit_exceeded", 5, "high", "local_support.security.high"],
      ["pairing_failed", 5, "high", "local_support.security.high"],
      ["suspicious_support_request", 5, "high", "local_support.security.high"],
      ["preview_redirect_blocked", 1, "high", "local_support.security.high"],
      ["path_traversal", 1, "high", "local_support.security.high"],
    ];

    for (const [eventType, count, severity, route] of cases) {
      const event = summarizeSecurityEvent(
        {
          event_type: eventType,
          count,
          session_id: "sess_alert",
          target: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        },
        policy,
      );
      expect(event).toMatchObject({
        decision: "recorded",
        severity,
        alert_route: route,
        raw_body_included: false,
      });
      expect(event.dedupe_key).toMatch(/^sha256:/);
      expect(JSON.stringify(event)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    }
  });

  it("builds minimized relay forwarding decisions without raw local bodies", () => {
    const policy = readLocalSupportPolicy({ VECTANT_LOCAL_SUPPORT_ENABLED: "true" });
    const decision = buildRelayForwardDecision(
      envelope({
        actor: "support_agent",
        capability: "workspace.log.read",
        target_display: "server.log Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        target_classification: "L3",
      }),
      policy,
    );

    expect(decision).toMatchObject({
      decision: "relay_ready",
      relay_forward: true,
      local_enforcement_required: true,
      raw_body_included: false,
      response_body_included: false,
      bytes_sent: 0,
      actor: "support_agent",
      capability: "workspace.log.read",
      target_classification: "L3",
      control_plane_log_class: "local_support.control",
      data_plane_log_class: "local_support.data",
    });
    expect(decision.target_hash).toMatch(/^sha256:/);
    expect(decision.target_display).toContain("authorization: [REDACTED]");
    expect(JSON.stringify(decision)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
