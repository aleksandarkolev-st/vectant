import { describe, expect, it, vi } from "vitest";

import {
  enqueueLocalControlCommand,
  enqueueRelayRequest,
  leaseLocalControlCommand,
  leaseRelayRequest,
  recordLocalControlOutcome,
  recordRelayOutcome,
} from "./relayStore";

function requestRecord(overrides = {}) {
  return {
    requestId: "req_123",
    sessionId: "sess_123",
    accountId: "acct_123",
    orgId: "org_123",
    workspaceId: "wk_123",
    deviceFingerprint: "sha256:3333333333333333",
    actor: "support_agent",
    capability: "workspace.log.read",
    targetDisplay: "logs/server.log",
    targetHash: "sha256:target",
    targetClassification: "L3",
    redactionCount: 2,
    scannerVersion: "scanner-1",
    policyVersion: "policy-1",
    protocolVersion: "protocol-1",
    appVersion: "0.1.0",
    deviceProof: "sha256:proof",
    envelopeSignature: "sha256:signature",
    status: "queued",
    expiresAt: new Date("2030-01-01T00:01:00.000Z"),
    leaseId: "lease-1",
    leaseExpiresAt: new Date("2030-01-01T00:00:15.000Z"),
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeClient(overrides = {}) {
  const tx = {
    localSupportControlCommand: {
      create: vi.fn(async ({ data }) => controlRecord(data)),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => controlRecord()),
      findUnique: vi.fn(async () => controlRecord()),
    },
    localSupportSession: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    localSupportRelayPayload: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    localSupportControlAudit: {
      create: vi.fn(async ({ data }) => ({ id: "control-audit-1", ...data })),
      update: vi.fn(async ({ data }) => ({ id: "control-audit-1", ...data })),
    },
    localSupportRelayRequest: {
      create: vi.fn(async ({ data }) => requestRecord(data)),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => requestRecord()),
      findUnique: vi.fn(async () => requestRecord()),
    },
    localSupportCloudAudit: {
      create: vi.fn(async ({ data }) => ({ id: "audit-1", ...data })),
    },
    localSupportSecurityEvent: {
      create: vi.fn(async ({ data }) => ({ id: "event-1", ...data })),
    },
    ...overrides,
  };
  return { tx, client: { ...tx, $transaction: vi.fn(async (callback) => callback(tx)) } };
}

function controlRecord(overrides = {}) {
  return {
    commandId: "cmd_12345678",
    sessionId: "sess_12345678",
    accountId: "acct_123",
    orgId: "org_123",
    workspaceId: "wk_12345678",
    deviceFingerprint: "sha256:3333333333333333",
    action: "pause_session",
    port: null,
    status: "queued",
    expiresAt: new Date("2030-01-01T00:01:00.000Z"),
    leaseId: "lease-control-1",
    leaseExpiresAt: new Date("2030-01-01T00:00:15.000Z"),
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("durable local support relay store", () => {
  it("queues a minimized browser control command without local credentials", async () => {
    const { client } = fakeClient();
    await enqueueLocalControlCommand({
      commandId: "cmd_12345678",
      sessionId: "sess_12345678",
      accountId: "acct_123",
      orgId: "org_123",
      workspaceId: "wk_12345678",
      deviceFingerprint: "sha256:3333333333333333",
      action: "revoke_port",
      port: 5173,
      expiresAt: "2030-01-01T00:01:00.000Z",
    }, client);
    expect(client.localSupportControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commandId: "cmd_12345678",
        action: "revoke_port",
        port: 5173,
      }),
    });
    expect(client.localSupportControlAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commandId: "cmd_12345678",
        decision: "queued",
        actor: "browser_user",
        capability: "local_support.revoke_port",
        bytesSent: 0,
      }),
    });
  });

  it("records the authenticated cloud actor on browser control audits", async () => {
    const { client } = fakeClient();
    await enqueueLocalControlCommand({
      commandId: "cmd_actor_12345678",
      sessionId: "sess_12345678",
      accountId: "acct_123",
      orgId: "org_123",
      workspaceId: "wk_12345678",
      deviceFingerprint: "sha256:3333333333333333",
      action: "pause_session",
      expiresAt: "2030-01-01T00:01:00.000Z",
      actor: "user_987",
    }, client);
    expect(client.localSupportControlAudit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ commandId: "cmd_actor_12345678", actor: "user_987" }),
    });
  });

  it("queues only narrowing Full Access emergency controls", async () => {
    const { client } = fakeClient();
    await enqueueLocalControlCommand({
      commandId: "cmd_full_revoke_123",
      sessionId: "sess_12345678",
      accountId: "acct_123",
      orgId: "org_123",
      workspaceId: "wk_12345678",
      deviceFingerprint: "sha256:3333333333333333",
      action: "full_access_revoke",
      expiresAt: "2030-01-01T00:01:00.000Z",
    }, client);
    expect(client.localSupportControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "full_access_revoke", port: null }),
    });
  });

  it("persists a bounded metadata-only control proposal", async () => {
    const { client } = fakeClient();
    await enqueueLocalControlCommand({
      commandId: "cmd_proposal_12345678",
      sessionId: "sess_12345678",
      accountId: "acct_123",
      orgId: "org_123",
      workspaceId: "wk_12345678",
      deviceFingerprint: "sha256:3333333333333333",
      action: "pause_session",
      proposal: { policy_version: "policy-1", capability_count: 2 },
      expiresAt: "2030-01-01T00:01:00.000Z",
    }, client);
    expect(client.localSupportControlCommand.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        proposalJson: JSON.stringify({ policy_version: "policy-1", capability_count: 2 }),
      }),
    });
  });

  it("rejects control proposals containing credential-like metadata", async () => {
    const { client } = fakeClient();
    await expect(enqueueLocalControlCommand({
      commandId: "cmd_unsafe_proposal_123",
      sessionId: "sess_12345678",
      accountId: "acct_123",
      orgId: "org_123",
      workspaceId: "wk_12345678",
      deviceFingerprint: "sha256:3333333333333333",
      action: "pause_session",
      proposal: { secret: "must-not-store" },
      expiresAt: "2030-01-01T00:01:00.000Z",
    }, client)).rejects.toThrow("Local control proposal was unsafe.");
  });

  it("leases the oldest control command only for its exact paired device", async () => {
    const { tx, client } = fakeClient();
    const command = await leaseLocalControlCommand({
      sessionId: "sess_12345678",
      deviceFingerprint: "sha256:3333333333333333",
      leaseId: "lease-control-1",
      leaseMs: 999_999,
    }, client, new Date("2030-01-01T00:00:00.000Z"));
    expect(tx.localSupportControlCommand.updateMany).toHaveBeenCalledTimes(2);
    expect(command).toMatchObject({
      command_id: "cmd_12345678",
      action: "pause_session",
      lease_id: "lease-control-1",
    });
  });

  it("records a scrubbed applied or denied control outcome only within its lease", async () => {
    const { client } = fakeClient();
    const result = await recordLocalControlOutcome({
      commandId: "cmd_12345678",
      leaseId: "lease-control-1",
      sessionId: "sess_12345678",
      deviceFingerprint: "sha256:3333333333333333",
      decision: "applied",
      reason: "pause_applied Authorization: Bearer should-not-persist",
    }, client, new Date("2030-01-01T00:00:01.000Z"));
    expect(result).toMatchObject({
      decision: "applied",
      command_id: "cmd_12345678",
      session_revoked: false,
    });
    expect(JSON.stringify(result)).not.toContain("should-not-persist");
    expect(client.localSupportControlCommand.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ commandId: "cmd_12345678", leaseId: "lease-control-1" }),
      data: expect.objectContaining({ status: "applied", leaseId: null, leaseExpiresAt: null }),
    });
    expect(client.localSupportControlAudit.update).toHaveBeenCalledWith({
      where: { commandId: "cmd_12345678" },
      data: expect.objectContaining({ decision: "applied" }),
    });
  });

  it("revokes a cloud session and purges queued relay work after local disconnect", async () => {
    const { tx, client } = fakeClient();
    tx.localSupportControlCommand.findUnique.mockResolvedValueOnce(controlRecord({
      action: "disconnect_session",
    }));

    const result = await recordLocalControlOutcome({
      commandId: "cmd_12345678",
      leaseId: "lease-control-1",
      sessionId: "sess_12345678",
      deviceFingerprint: "sha256:3333333333333333",
      decision: "applied",
      reason: "session_disconnected",
    }, client, new Date("2030-01-01T00:00:01.000Z"));

    expect(result).toMatchObject({ session_revoked: true });
    expect(tx.localSupportSession.updateMany).toHaveBeenCalledWith({
      where: {
        sessionId: "sess_12345678",
        deviceFingerprint: "sha256:3333333333333333",
        status: "active",
      },
      data: { status: "revoked", revokedAt: new Date("2030-01-01T00:00:01.000Z") },
    });
    expect(tx.localSupportRelayPayload.deleteMany).toHaveBeenCalledWith({
      where: { request: { sessionId: "sess_12345678" } },
    });
    expect(tx.localSupportRelayRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "sess_12345678" }),
      data: expect.objectContaining({ status: "revoked" }),
    }));
  });

  it("queues only the signed envelope and a scrubbed control audit", async () => {
    const { tx, client } = fakeClient();
    const decision = {
      request_id: "req_123", session_id: "sess_123", account_id: "acct_123", org_id: "org_123",
      workspace_id: "wk_123", device_fingerprint: "sha256:3333333333333333", actor: "support_agent",
      capability: "workspace.log.read", target_display: "logs/server.log", target_hash: "sha256:target",
      target_classification: "L3", redaction_count: 2, scanner_version: "scanner-1",
      policy_version: "policy-1", protocol_version: "protocol-1", app_version: "0.1.0",
    };
    await enqueueRelayRequest({
      ...decision,
      expires_at: "2030-01-01T00:01:00.000Z",
      device_proof: "sha256:proof",
      signature: "sha256:signature",
      raw_response_body: "must never persist",
    }, decision, client);

    const stored = tx.localSupportRelayRequest.create.mock.calls[0][0].data;
    const audit = tx.localSupportCloudAudit.create.mock.calls[0][0].data;
    expect(stored).not.toHaveProperty("raw_response_body");
    expect(JSON.stringify(audit)).not.toContain("must never persist");
    expect(audit).toMatchObject({ decision: "queued", logClass: "local_support.control", bytesSent: 0 });
  });

  it("leases the oldest eligible envelope with a bounded delivery lease", async () => {
    const { tx, client } = fakeClient();
    const delivery = await leaseRelayRequest({
      sessionId: "sess_123", deviceFingerprint: "sha256:3333333333333333", leaseId: "lease-1", leaseMs: 999_999,
    }, client, new Date("2030-01-01T00:00:00.000Z"));

    expect(tx.localSupportRelayRequest.updateMany.mock.calls[1][0].data.leaseExpiresAt.toISOString())
      .toBe("2030-01-01T00:01:00.000Z");
    expect(delivery).toMatchObject({ request_id: "req_123", lease_id: "lease-1", signature: "sha256:signature" });
    expect(delivery).not.toHaveProperty("response_body");
  });

  it("records only minimized outcomes and forces denied byte counts to zero", async () => {
    const { tx, client } = fakeClient();
    const result = await recordRelayOutcome({
      requestId: "req_123",
      leaseId: "lease-1",
      sessionId: "sess_123",
      deviceFingerprint: "sha256:3333333333333333",
      decision: "denied",
      bytesSent: 9000,
      redactionCount: 4,
      scannerVersion: "scanner-2",
      reason: "local_policy_denied",
      responseBody: "must never persist",
    }, client, new Date("2030-01-01T00:00:01.000Z"));

    const audit = tx.localSupportCloudAudit.create.mock.calls[0][0].data;
    expect(result).toMatchObject({ decision: "denied", bytes_sent: 0 });
    expect(tx.localSupportRelayRequest.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        requestId: "req_123",
        leaseId: "lease-1",
        sessionId: "sess_123",
        deviceFingerprint: "sha256:3333333333333333",
      }),
    });
    expect(audit).toMatchObject({ decision: "denied", bytesSent: 0, logClass: "local_support.data" });
    expect(JSON.stringify(audit)).not.toContain("must never persist");
    expect(tx.localSupportSecurityEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: "local_request_denied",
        severity: "medium",
        alert: true,
        requestId: "req_123",
        targetHash: "sha256:target",
        logClass: "local_support.security.medium",
      }),
    });
  });

  it("routes scanner and secret denials as immediate scrubbed alerts", async () => {
    const { tx, client } = fakeClient({
      localSupportRelayRequest: {
        create: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findFirst: vi.fn(async () => requestRecord({
          targetClassification: "L5",
          targetDisplay: "config/[REDACTED]",
        })),
        findUnique: vi.fn(),
      },
    });

    await recordRelayOutcome({
      requestId: "req_123",
      leaseId: "lease-1",
      sessionId: "sess_123",
      deviceFingerprint: "sha256:3333333333333333",
      decision: "denied",
      bytesSent: 0,
      redactionCount: 0,
      scannerVersion: "scanner-2",
      reason: "scanner_failure",
      rawBody: "OPENAI_API_KEY=must-never-persist",
    }, client, new Date("2030-01-01T00:00:01.000Z"));

    const alert = tx.localSupportSecurityEvent.create.mock.calls[0][0].data;
    expect(alert).toMatchObject({
      eventType: "scanner_failure",
      severity: "high",
      alertRoute: "security_ops_immediate",
      targetDisplay: "config/[REDACTED]",
      targetHash: "sha256:target",
    });
    expect(JSON.stringify(alert)).not.toContain("must-never-persist");
  });

  it("ends the delivery lease while local review remains pending", async () => {
    const { tx, client } = fakeClient();
    const result = await recordRelayOutcome({
      requestId: "req_123",
      leaseId: "lease-1",
      sessionId: "sess_123",
      deviceFingerprint: "sha256:3333333333333333",
      decision: "review_pending",
      bytesSent: 500,
      redactionCount: 3,
      scannerVersion: "scanner-2",
      reason: "local_review_required",
    }, client, new Date("2030-01-01T00:00:01.000Z"));

    expect(result).toMatchObject({ decision: "review_pending", bytes_sent: 0 });
    expect(tx.localSupportRelayRequest.updateMany.mock.calls.at(-1)[0].data).toMatchObject({
      status: "review_pending",
      leaseId: null,
      leaseExpiresAt: null,
    });
    expect(tx.localSupportSecurityEvent.create).not.toHaveBeenCalled();
  });
});
