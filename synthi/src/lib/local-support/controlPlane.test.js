import { afterEach, describe, expect, it } from "vitest";

import {
  clearAdminRevocationStore,
  clearRequestEnvelopeReplayCache,
  buildPreviewGatewayDecision,
  buildRelayForwardDecision,
  constantTimeStringEqual,
  enforceRequestEnvelopeReplayProtection,
  evaluatePolicyPrecedence,
  readLocalSupportPolicy,
  signDeviceProof,
  signRequestEnvelope,
  summarizeTransparencyState,
  summarizeSecurityEvent,
  validateRequestEnvelope,
  verifyRequestEnvelopeSignature,
} from "./controlPlane";

const future = () => new Date(Date.now() + 60_000).toISOString();

afterEach(() => {
  clearAdminRevocationStore();
  clearRequestEnvelopeReplayCache();
});

const DEVICE_PROOF_SECRET = "test-device-proof-secret";

function envelope(overrides = {}) {
  const body = {
    request_id: "req_123",
    session_id: "sess_123",
    account_id: "acct_123",
    org_id: "org_123",
    workspace_id: "wk_123",
    device_fingerprint: "sha256:1111111111111111",
    capability: "workspace.file.source.read",
    actor: "vectant_ai",
    expires_at: future(),
    app_version: "0.1.0",
    protocol_version: "local-support-mvp.1",
    policy_version: "2026.07.05",
    ...overrides,
  };
  return {
    ...body,
    device_proof: overrides.device_proof || signDeviceProof(body, DEVICE_PROOF_SECRET),
  };
}

function proofBound(body) {
  return {
    ...body,
    device_proof: signDeviceProof(body, DEVICE_PROOF_SECRET),
  };
}

function enabledPolicy(overrides = {}) {
  return readLocalSupportPolicy({
    VECTANT_LOCAL_SUPPORT_ENABLED: "true",
    VECTANT_LOCAL_SUPPORT_DEVICE_PROOF_SECRET: DEVICE_PROOF_SECRET,
    ...overrides,
  });
}

describe("local support control plane policy", () => {
  it("fails closed when the feature is disabled or org killed", () => {
    const disabled = readLocalSupportPolicy({});
    expect(validateRequestEnvelope(envelope(), disabled)).toMatchObject({
      decision: "denied",
      reason: "feature_disabled",
      bytes_sent: 0,
    });

    const killed = enabledPolicy({
      VECTANT_LOCAL_SUPPORT_ORG_DISABLED: "true",
    });
    expect(killed.enabled).toBe(false);
    expect(validateRequestEnvelope(envelope(), killed).reason).toBe("feature_disabled");
  });

  it("rejects old app versions and expired envelopes", () => {
    const policy = enabledPolicy({
      VECTANT_LOCAL_SUPPORT_MIN_APP_VERSION: "0.2.0",
    });
    expect(validateRequestEnvelope(envelope({ app_version: "0.1.9" }), policy).reason).toBe("app_version_too_old");
    expect(validateRequestEnvelope(envelope({ app_version: "0.2.0", expires_at: "2020-01-01T00:00:00Z" }), policy).reason).toBe("expired_request");
  });

  it("binds envelopes to account organization protocol and policy versions", () => {
    const policy = enabledPolicy({
      VECTANT_LOCAL_SUPPORT_ACCOUNT_ID: "acct_123",
      VECTANT_LOCAL_SUPPORT_ORG_ID: "org_123",
      VECTANT_LOCAL_SUPPORT_DEVICE_FINGERPRINT: "sha256:1111111111111111",
    });

    expect(validateRequestEnvelope(envelope({ account_id: "acct_other" }), policy)).toMatchObject({
      decision: "denied",
      reason: "account_mismatch",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({ org_id: "org_other" }), policy)).toMatchObject({
      decision: "denied",
      reason: "org_mismatch",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({ device_fingerprint: "sha256:2222222222222222" }), policy)).toMatchObject({
      decision: "denied",
      reason: "device_mismatch",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({ device_fingerprint: "device-not-valid" }), { ...policy, device_fingerprint: null })).toMatchObject({
      decision: "denied",
      reason: "device_fingerprint_invalid",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({ device_proof: "sha256:not-hex" }), policy)).toMatchObject({
      decision: "denied",
      reason: "device_proof_invalid",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope(), { ...policy, device_proof_secret: null })).toMatchObject({
      decision: "denied",
      reason: "device_proof_unconfigured",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({
      device_proof: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "device_proof_invalid",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({ protocol_version: "local-support-old" }), policy)).toMatchObject({
      decision: "denied",
      reason: "protocol_version_mismatch",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({ policy_version: "2025.01.01" }), policy)).toMatchObject({
      decision: "denied",
      reason: "policy_version_mismatch",
      bytes_sent: 0,
    });
  });

  it("rejects unsafe envelope identifiers and malformed app versions", () => {
    const policy = enabledPolicy();
    expect(validateRequestEnvelope(envelope({ request_id: "req_123\nx" }), policy)).toMatchObject({
      decision: "denied",
      reason: "invalid_schema",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({ session_id: "s".repeat(129) }), policy)).toMatchObject({
      decision: "denied",
      reason: "invalid_schema",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({ app_version: "next-release" }), policy)).toMatchObject({
      decision: "denied",
      reason: "invalid_schema",
      bytes_sent: 0,
    });
  });

  it("exposes emergency controls and blocks revoked versions", () => {
    const policy = enabledPolicy({
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

  it("denies revoked sessions and devices from env or admin state", () => {
    const policy = enabledPolicy({
      VECTANT_LOCAL_SUPPORT_REVOKED_SESSIONS: "sess_123",
      VECTANT_LOCAL_SUPPORT_REVOKED_DEVICES: "sha256:2222222222222222",
    });

    expect(validateRequestEnvelope(envelope(), policy)).toMatchObject({
      decision: "denied",
      reason: "session_revoked",
      bytes_sent: 0,
    });
    expect(validateRequestEnvelope(envelope({
      session_id: "sess_ok",
      device_fingerprint: "sha256:2222222222222222",
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "device_revoked",
      bytes_sent: 0,
    });
  });

  it("exposes retention controls and no-retention mode", () => {
    const retained = enabledPolicy({
      VECTANT_LOCAL_SUPPORT_RETENTION_DAYS: "120",
    });
    expect(retained.retention).toMatchObject({
      no_retention: false,
      local_activity_days: 90,
      cloud_security_event_days: 90,
      raw_bodies_allowed: false,
    });

    const noRetention = enabledPolicy({
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
    const policy = enabledPolicy();
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
    const policy = enabledPolicy();
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
      protocol_version: body.protocol_version,
      policy_version: body.policy_version,
      expires_at: body.expires_at,
      actor: body.actor,
      capability: body.capability,
      workspace_id: body.workspace_id,
      device_proof: body.device_proof,
      device_fingerprint: body.device_fingerprint,
      org_id: body.org_id,
      account_id: body.account_id,
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

  it("compares shared control-plane secrets without accepting partial prefixes", () => {
    expect(constantTimeStringEqual("admin-secret", "admin-secret")).toBe(true);
    expect(constantTimeStringEqual("admin-secret", "admin-secreu")).toBe(false);
    expect(constantTimeStringEqual("admin-secret", "admin")).toBe(false);
    expect(constantTimeStringEqual("", "admin-secret")).toBe(false);
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
    expect(enforceRequestEnvelopeReplayProtection({
      ...body,
      request_id: "req_replay_2",
      expires_at: new Date(1_100_000).toISOString(),
    }, 1_000_001)).toMatchObject({
      decision: "accepted",
      reason: "request_replay_nonce_recorded",
    });

    const expired = { ...body, request_id: "req_replay_expired" };
    expect(enforceRequestEnvelopeReplayProtection(expired, 1_000_001)).toMatchObject({
      decision: "denied",
      reason: "request_replay_expired",
      bytes_sent: 0,
    });
    expect(enforceRequestEnvelopeReplayProtection({ ...expired, expires_at: new Date(1_100_000).toISOString() }, 1_000_002)).toMatchObject({
      decision: "accepted",
      reason: "request_replay_nonce_recorded",
    });
  });

  it("records scrubbed security events without raw local content", () => {
    const policy = enabledPolicy();
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
    const policy = enabledPolicy();
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
    const policy = enabledPolicy();
    const decision = buildRelayForwardDecision(
      envelope({
        actor: "support_agent",
        capability: "workspace.log.read",
        target_display: "server.log Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        target_classification: "L3",
        redaction_count: 2,
        scanner_version: "scanner-2026.07.05",
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
      account_id: "acct_123",
      org_id: "org_123",
      device_fingerprint: "sha256:1111111111111111",
      capability: "workspace.log.read",
      target_classification: "L3",
      redaction_count: 2,
      scanner_version: "scanner-2026.07.05",
      control_plane_log_class: "local_support.control",
      data_plane_log_class: "local_support.data",
    });
    expect(decision.target_hash).toMatch(/^sha256:/);
    expect(decision.target_display).toContain("authorization: [REDACTED]");
    expect(JSON.stringify(decision)).not.toContain("abcdefghijklmnopqrstuvwxyz");

    const clamped = buildRelayForwardDecision(envelope({
      actor: "support_agent",
      capability: "workspace.log.read",
      redaction_count: 50_000,
      scanner_version: "scanner Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    }), policy);
    expect(clamped).toMatchObject({
      decision: "relay_ready",
      redaction_count: 1000,
    });
    expect(clamped.scanner_version).toContain("authorization: [REDACTED]");
    expect(JSON.stringify(clamped)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("authorizes browser-only localhost preview and blocks SSRF or support reads", () => {
    const policy = enabledPolicy();
    const previewEnvelope = envelope({
      actor: "user_browser",
      capability: "localhost.preview.browser",
      request_id: "req_preview",
      preview_host: "br-local-p3000.vectant-preview.dev",
      target_host: "127.0.0.1",
      approved_port: 3000,
      requested_port: 3000,
      preview_method: "GET",
      preview_path: "/dashboard",
      request_headers: {
        accept: "text/html",
      },
    });

    expect(buildPreviewGatewayDecision(previewEnvelope, policy)).toMatchObject({
      decision: "preview_gateway_ready",
      preview_forward: true,
      browser_stream_only: true,
      support_read_allowed: false,
      ai_read_allowed: false,
      response_body_included: false,
      raw_body_included: false,
      bytes_sent: 0,
      actor: "user_browser",
      approved_port: 3000,
    });

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_lower_method",
      preview_method: " get ",
    }), policy)).toMatchObject({
      decision: "preview_gateway_ready",
      preview_forward: true,
      bytes_sent: 0,
    });

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_bad_method",
      preview_method: "GET\r\nX-Injected: yes",
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "preview_method_invalid",
      preview_forward: false,
      bytes_sent: 0,
    });

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_support",
      actor: "support_agent",
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "browser_only_preview_required",
      preview_forward: false,
      bytes_sent: 0,
    });

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_metadata",
      target_host: "169.254.169.254",
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "preview_target_not_loopback",
      preview_forward: false,
      bytes_sent: 0,
    });

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_cookie",
      request_headers: { cookie: "sid=secret" },
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "preview_credentials_header_blocked",
      preview_forward: false,
      bytes_sent: 0,
    });

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_ws",
      request_headers: { upgrade: "websocket" },
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "preview_websocket_blocked",
      preview_forward: false,
      bytes_sent: 0,
    });

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_ai",
      actor: "vectant_ai",
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "agent_preview_read_separate_permission_required",
      preview_forward: false,
      bytes_sent: 0,
    });

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_interaction",
      capability: "localhost.preview.agent_interact",
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "capability_blocked_in_mvp",
      preview_forward: false,
      bytes_sent: 0,
    });

    for (const [request_headers, reason] of [
      [[["content-length", "0"], ["content-length", "0"]], "preview_duplicate_content_length_blocked"],
      [{ "content-length": "0", "transfer-encoding": "chunked" }, "preview_ambiguous_body_length_blocked"],
      [{ connection: "authorization" }, "preview_connection_sensitive_header_blocked"],
      [[["connection", "x-shadow-hop"], ["x-shadow-hop", "secret"]], "preview_connection_named_header_blocked"],
    ]) {
      expect(buildPreviewGatewayDecision(proofBound({
        ...previewEnvelope,
        request_id: `req_${reason}`,
        request_headers,
      }), policy)).toMatchObject({
        decision: "denied",
        reason,
        preview_forward: false,
        bytes_sent: 0,
      });
    }

    expect(buildPreviewGatewayDecision(proofBound({
      ...previewEnvelope,
      request_id: "req_preview_host",
      preview_host: "br-local-p3001.vectant-preview.dev",
    }), policy)).toMatchObject({
      decision: "denied",
      reason: "preview_host_mismatch",
      preview_forward: false,
      bytes_sent: 0,
    });
  });

  it("builds scrubbed transparency state without renderer secrets", () => {
    const policy = enabledPolicy();
    const state = summarizeTransparencyState(
      {
        session: {
          connected: true,
          session_id: "sess_123",
          account_id: "acct_123",
        },
        workspace: {
          workspace_id: "wk_123",
          display: "repo Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        },
        ports: [
          {
            port: 3000,
            preview_token: "secret-preview-token",
            aiRead: true,
            supportRead: true,
            responseBodies: true,
            screenshots: true,
          },
        ],
        activity: [
          {
            at: "2026-07-07T10:00:00.000Z",
            class: "Denied",
            summary: "Blocked Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
          },
          {
            at: "2026-07-07T10:01:00.000Z",
            kind: "Redaction",
            text: "Redacted postgres://user:pass@localhost/db",
          },
        ],
      },
      policy,
    );

    expect(state).toMatchObject({
      decision: "transparency_state_ready",
      raw_bodies_included: false,
      session: {
        connected: true,
        session_id: "sess_123",
      },
      workspace: {
        workspace_id: "wk_123",
      },
      ports: [
        expect.objectContaining({
          port: 3000,
          aiRead: false,
          supportRead: false,
          responseBodies: false,
          screenshots: false,
          token_state: "present_hidden_from_renderer",
        }),
      ],
      export_metadata: {
        audit_chain_verified: false,
      },
    });
    expect(state.activity).toHaveLength(2);
    expect(state.activity[0]).toMatchObject({
      chain_index: 0,
      previous_event_hash: "sha256:genesis",
    });
    expect(state.activity[0].event_hash).toMatch(/^sha256:/);
    expect(state.activity[1].previous_event_hash).toBe(state.activity[0].event_hash);
    expect(state.export_metadata.audit_chain_head).toBe(state.activity[1].event_hash);
    expect(state.workspace.display).toContain("authorization: [REDACTED]");
    expect(JSON.stringify(state)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(state)).not.toContain("secret-preview-token");
    expect(JSON.stringify(state)).not.toContain("postgres://user:pass");
  });
});
