import { describe, expect, it, vi } from "vitest";

import {
  authorizeRelaySession,
  findActivePairedSession,
  persistPairedSession,
  renewPairedSession,
  updatePairedSessionPorts,
} from "./sessionStore";

describe("local support paired session store", () => {
  it("persists the verified public key and consent scope", async () => {
    const create = vi.fn(async ({ data }) => data);
    const completed = {
      decision: "pairing_complete",
      session_id: "sess_1",
      pairing_id: "pair_1",
      browser_session_id: "browser_1",
      account_id: "acct_1",
      org_id: "org_1",
      workspace_id: "wk_1",
      device_fingerprint: "sha256:1111111111111111",
      capabilities: ["workspace.log.read"],
      policy_version: "policy-1",
      protocol_version: "protocol-1",
      expires_at: "2030-01-01T00:00:00.000Z",
    };
    const result = await persistPairedSession(completed, {
      device_public_key: "AB".repeat(32),
      device_fingerprint: completed.device_fingerprint,
    }, { localSupportSession: { create } });

    expect(result).toMatchObject({
      sessionId: "sess_1",
      devicePublicKey: "ab".repeat(32),
      capabilitiesJson: "[\"workspace.log.read\"]",
    });
    expect(result).not.toHaveProperty("devicePrivateKey");
  });

  it("rejects mismatched device identities", async () => {
    await expect(persistPairedSession({
      decision: "pairing_complete",
      device_fingerprint: "sha256:1111111111111111",
    }, {
      device_public_key: "ab".repeat(32),
      device_fingerprint: "sha256:2222222222222222",
    }, { localSupportSession: { create: vi.fn() } })).rejects.toThrow("did not match");
  });

  it("queries only active, unexpired, non-revoked device-bound sessions", async () => {
    const findFirst = vi.fn(async () => ({ sessionId: "sess_1" }));
    const now = new Date("2029-01-01T00:00:00.000Z");
    await findActivePairedSession("sess_1", "sha256:1111111111111111", {
      localSupportSession: { findFirst },
    }, now);

    expect(findFirst).toHaveBeenCalledWith({ where: {
      sessionId: "sess_1",
      deviceFingerprint: "sha256:1111111111111111",
      status: "active",
      revokedAt: null,
      expiresAt: { gt: now },
    } });
  });

  it("authorizes relay envelopes only against the full durable session boundary", async () => {
    const findFirst = vi.fn(async () => ({
      sessionId: "sess_1",
      capabilitiesJson: "[\"workspace.log.read\"]",
    }));
    const now = new Date("2029-01-01T00:00:00.000Z");
    const result = await authorizeRelaySession({
      session_id: "sess_1",
      account_id: "acct_1",
      org_id: "org_1",
      workspace_id: "wk_1",
      device_fingerprint: "sha256:1111111111111111",
      capability: "workspace.log.read",
    }, { localSupportSession: { findFirst } }, now);

    expect(result.ok).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({ where: {
      sessionId: "sess_1",
      accountId: "acct_1",
      orgId: "org_1",
      workspaceId: "wk_1",
      deviceFingerprint: "sha256:1111111111111111",
      status: "active",
      revokedAt: null,
      expiresAt: { gt: now },
    } });
  });

  it("denies capabilities outside the pairing consent receipt", async () => {
    const result = await authorizeRelaySession({ capability: "workspace.file.source.read" }, {
      localSupportSession: { findFirst: vi.fn(async () => ({ capabilitiesJson: "[\"workspace.log.read\"]" })) },
    });
    expect(result).toEqual({ ok: false, reason: "session_capability_not_granted" });
  });

  it("persists only loopback preview targets", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const port = {
      port: 5173,
      target_host: "169.254.169.254",
      preview_host: "br-local-p5173.vectant-preview.dev",
      process_identity_hash: "sha256:" + "a".repeat(16),
      browser_preview_allowed: true,
      expires_at: "2030-01-01T00:00:00.000Z",
    };

    await expect(updatePairedSessionPorts(
      "sess_1",
      "sha256:1111111111111111",
      [port],
      { localSupportSession: { updateMany } },
    )).resolves.toBe(false);
    expect(updateMany).not.toHaveBeenCalled();

    const loopbackPort = {
      ...port,
      target_host: "127.0.0.1",
      agent_read_allowed: true,
      support_agent_read_allowed: true,
      agent_interact_allowed: true,
      send_response_body_allowed: true,
      send_screenshot_allowed: true,
      send_console_errors_allowed: true,
      state_changing_methods_allowed: true,
    };
    await expect(updatePairedSessionPorts(
      "sess_1",
      "sha256:1111111111111111",
      [loopbackPort],
      { localSupportSession: { updateMany } },
    )).resolves.toBe(true);
    const persisted = JSON.parse(updateMany.mock.calls[0][0].data.approvedPortsJson)[0];
    expect(persisted).toMatchObject({
      browser_preview_allowed: true,
      agent_read_allowed: false,
      support_agent_read_allowed: false,
      agent_interact_allowed: false,
      send_response_body_allowed: false,
      send_screenshot_allowed: false,
      send_console_errors_allowed: false,
      state_changing_methods_allowed: false,
    });
  });

  it("renews only an active, non-revoked session for another hour", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const now = new Date("2029-01-01T00:00:00.000Z");
    const expiresAt = await renewPairedSession(
      "sess_1",
      "sha256:1111111111111111",
      { localSupportSession: { updateMany } },
      now,
    );

    expect(expiresAt).toEqual(new Date("2029-01-01T01:00:00.000Z"));
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        sessionId: "sess_1",
        deviceFingerprint: "sha256:1111111111111111",
        status: "active",
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { expiresAt },
    });
  });
});
