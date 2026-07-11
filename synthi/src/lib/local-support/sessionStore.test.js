import { describe, expect, it, vi } from "vitest";

import { authorizeRelaySession, findActivePairedSession, persistPairedSession } from "./sessionStore";

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
});
