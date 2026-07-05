import { describe, expect, it } from "vitest";

import { readLocalSupportPolicy, validateRequestEnvelope } from "./controlPlane";

const future = () => new Date(Date.now() + 60_000).toISOString();

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

  it("blocks writes, command execution, repo upload, and AI preview reading in the MVP", () => {
    const policy = readLocalSupportPolicy({ VECTANT_LOCAL_SUPPORT_ENABLED: "true" });
    for (const capability of ["workspace.file.write", "workspace.command.execute", "workspace.repo.upload"]) {
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
});
