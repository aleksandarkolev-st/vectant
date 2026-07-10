import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  denyReviewedRelayRequest,
  storeApprovedRelayPayload,
  takeApprovedRelayPayload,
} from "./relayPayloadStore";
import { relayPayloadSha256 } from "./relayPayloadCrypto";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const request = {
  requestId: "req_123",
  sessionId: "sess_123",
  accountId: "acct_123",
  orgId: "org_123",
  workspaceId: "wk_123",
  deviceFingerprint: "sha256:1111111111111111",
  actor: "support_agent",
  capability: "workspace.log.read",
  targetDisplay: "logs/server.log",
  targetHash: "sha256:target",
  targetClassification: "L3",
  policyVersion: "policy-1",
  scannerVersion: "scanner-1",
  expiresAt: new Date("2030-01-01T00:04:00.000Z"),
};

beforeEach(() => {
  process.env.VECTANT_LOCAL_SUPPORT_RELAY_PAYLOAD_KEY = Buffer.alloc(32, 9).toString("base64");
});

function fakeClient() {
  const tx = {
    localSupportRelayRequest: {
      findFirst: vi.fn(async () => request),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    localSupportRelayPayload: {
      create: vi.fn(async ({ data }) => data),
      findFirst: vi.fn(),
      delete: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({})),
    },
    localSupportCloudAudit: { create: vi.fn(async ({ data }) => data) },
  };
  return { tx, client: { $transaction: vi.fn(async (callback) => callback(tx)) } };
}

describe("one-time encrypted relay payload store", () => {
  it("stores only ciphertext after a matching local review", async () => {
    const { tx, client } = fakeClient();
    const content = "token=[REDACTED]";
    const result = await storeApprovedRelayPayload({
      requestId: request.requestId,
      sessionId: request.sessionId,
      deviceFingerprint: request.deviceFingerprint,
      content,
      contentSha256: relayPayloadSha256(content),
      redactionCount: 1,
      scannerVersion: "scanner-2",
    }, client, NOW);

    const stored = tx.localSupportRelayPayload.create.mock.calls[0][0].data;
    expect(result).toMatchObject({ decision: "sent", bytes_sent: Buffer.byteLength(content) });
    expect(stored.ciphertext).not.toContain(content);
    expect(stored).not.toHaveProperty("content");
    expect(JSON.stringify(tx.localSupportCloudAudit.create.mock.calls[0][0].data)).not.toContain(content);
  });

  it("decrypts once for the bound account and deletes before returning", async () => {
    const { tx, client } = fakeClient();
    const content = "approved redacted content";
    await storeApprovedRelayPayload({
      requestId: request.requestId,
      sessionId: request.sessionId,
      deviceFingerprint: request.deviceFingerprint,
      content,
      contentSha256: relayPayloadSha256(content),
      redactionCount: 2,
      scannerVersion: "scanner-2",
    }, client, NOW);
    const stored = tx.localSupportRelayPayload.create.mock.calls[0][0].data;
    tx.localSupportRelayPayload.findFirst.mockResolvedValue({ ...stored, request });

    const result = await takeApprovedRelayPayload(request.requestId, request.accountId, client, NOW);

    expect(result).toMatchObject({ content, bytes_sent: Buffer.byteLength(content) });
    expect(tx.localSupportRelayPayload.delete).toHaveBeenCalledWith({ where: { requestId: request.requestId } });
    expect(tx.localSupportRelayRequest.update).toHaveBeenCalledWith({
      where: { requestId: request.requestId },
      data: { status: "delivered" },
    });
  });

  it("rejects mismatched content hashes before persistence", async () => {
    const { tx, client } = fakeClient();
    await expect(storeApprovedRelayPayload({
      requestId: request.requestId,
      sessionId: request.sessionId,
      deviceFingerprint: request.deviceFingerprint,
      content: "approved",
      contentSha256: `sha256:${"00".repeat(32)}`,
    }, client, NOW)).resolves.toBeNull();
    expect(tx.localSupportRelayPayload.create).not.toHaveBeenCalled();
  });

  it("records a local denial without creating payload storage", async () => {
    const { tx, client } = fakeClient();
    const result = await denyReviewedRelayRequest({
      requestId: request.requestId,
      sessionId: request.sessionId,
      deviceFingerprint: request.deviceFingerprint,
    }, client, NOW);

    expect(result).toEqual({ decision: "denied", bytes_sent: 0 });
    expect(tx.localSupportRelayPayload.create).not.toHaveBeenCalled();
    expect(tx.localSupportCloudAudit.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      decision: "denied",
      bytesSent: 0,
      reason: "local_user_denied",
    }) });
  });
});
