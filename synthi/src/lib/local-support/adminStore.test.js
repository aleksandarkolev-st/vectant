import { describe, expect, it, vi } from "vitest";

import { readDurableAdminState, recordDurableAdminRevocation } from "./adminStore";

const now = new Date("2030-01-01T00:00:00.000Z");
const session = {
  sessionId: "sess_12345678",
  deviceFingerprint: "sha256:1111111111111111",
  accountId: "acct_1",
  orgId: "org_1",
  workspaceId: "wk_1",
  appVersion: "0.1.0",
  policyVersion: "policy-1",
  status: "active",
  revokedAt: null,
  expiresAt: new Date("2030-01-01T01:00:00.000Z"),
  lastDeviceProofAt: now,
  updatedAt: now,
  createdAt: now,
};
const policy = { enabled: true, policy_version: "policy-1" };

describe("durable local support admin state", () => {
  it("derives paired devices and sessions from persisted pairing rows", async () => {
    const state = await readDurableAdminState({
      localSupportSession: { findMany: vi.fn(async () => [session]) },
    });

    expect(state.devices).toEqual([expect.objectContaining({
      device_id: session.deviceFingerprint,
      app_version: "0.1.0",
      active_sessions: 1,
      revoked: false,
    })]);
    expect(state.sessions).toEqual([expect.objectContaining({ session_id: session.sessionId, revoked: false })]);
  });

  it("atomically revokes sessions, queued relay work, and encrypted payloads", async () => {
    const tx = {
      localSupportSession: {
        findMany: vi.fn(async () => [session]),
        updateMany: vi.fn(async () => ({ count: 1 })),
        count: vi.fn(async () => 1),
      },
      localSupportRelayPayload: { deleteMany: vi.fn(async () => ({ count: 1 })) },
      localSupportRelayRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    tx.localSupportSession.findMany
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce([{ deviceFingerprint: session.deviceFingerprint }]);
    const client = { $transaction: vi.fn(async (callback) => callback(tx)) };

    const result = await recordDurableAdminRevocation({
      target_type: "session",
      target_id: session.sessionId,
    }, policy, client, now);

    expect(result).toMatchObject({ decision: "revocation_required", revocation_recorded: true });
    expect(tx.localSupportSession.updateMany).toHaveBeenCalledWith({
      where: { sessionId: { in: [session.sessionId] } },
      data: { status: "revoked", revokedAt: now },
    });
    expect(tx.localSupportRelayRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "revoked", leaseId: null }),
    }));
    expect(tx.localSupportRelayPayload.deleteMany).toHaveBeenCalled();
  });
});
