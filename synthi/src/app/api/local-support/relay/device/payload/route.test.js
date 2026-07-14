import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), store: vi.fn(), deny: vi.fn(), policy: vi.fn() }));
vi.mock("@/lib/local-support/deviceAuth", () => ({ authenticateLocalSupportDevice: mocks.authenticate }));
vi.mock("@/lib/local-support/relayPayloadStore", () => ({
  storeApprovedRelayPayload: mocks.store,
  denyReviewedRelayRequest: mocks.deny,
}));
vi.mock("@/lib/local-support/policyStore", () => ({
  readDurableLocalSupportPolicy: mocks.policy,
}));

import { POST } from "./route";

function request(body) {
  return new Request("https://beta.vectant.dev/api/local-support/relay/device/payload", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validBody(overrides = {}) {
  return {
    action: "upload",
    request_id: "req_12345678",
    content: "token=[REDACTED]",
    content_sha256: `sha256:${"11".repeat(32)}`,
    redaction_count: 1,
    scanner_version: "scanner-1",
    ...overrides,
  };
}

describe("device approved payload upload", () => {
  beforeEach(() => {
    mocks.policy.mockResolvedValue({ enabled: true });
  });

  it("blocks payload delivery when the effective organization policy is disabled", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: true,
      session: { sessionId: "sess_12345678", deviceFingerprint: "sha256:1111111111111111", orgId: "org_12345678" },
    });
    mocks.policy.mockResolvedValue({ enabled: false });

    const response = await POST(request(validBody()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ decision: "denied", reason: "feature_disabled" });
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it("authenticates the exact body and stores through the encrypted payload store", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: true,
      session: { sessionId: "sess_12345678", deviceFingerprint: "sha256:1111111111111111" },
    });
    mocks.store.mockResolvedValue({ decision: "sent", bytes_sent: 16, expires_at: "2030-01-01T00:01:00Z" });

    const response = await POST(request(validBody()));

    expect(response.status).toBe(200);
    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.any(Request),
      "/api/local-support/relay/device/payload",
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    );
    expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "req_12345678",
      sessionId: "sess_12345678",
      content: "token=[REDACTED]",
    }));
    await expect(response.json()).resolves.toMatchObject({ decision: "sent", raw_body_included: false });
  });

  it("rejects extra fields, oversized content, and non-pending requests", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: true,
      session: { sessionId: "sess_12345678", deviceFingerprint: "sha256:1111111111111111" },
    });
    expect((await POST(request(validBody({ raw_body: "forbidden" })))).status).toBe(400);
    expect((await POST(request(validBody({ content: "x".repeat(256 * 1024 + 1) })))).status).toBe(400);

    mocks.store.mockResolvedValueOnce(null);
    const stale = await POST(request(validBody()));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ reason: "payload_request_not_pending", bytes_sent: 0 });
  });

  it("records an exact body-free local denial", async () => {
    mocks.authenticate.mockResolvedValue({
      ok: true,
      session: { sessionId: "sess_12345678", deviceFingerprint: "sha256:1111111111111111" },
    });
    mocks.deny.mockResolvedValue({ decision: "denied", bytes_sent: 0 });

    const response = await POST(request({
      action: "deny",
      request_id: "req_12345678",
      reason: "local_user_denied",
    }));

    expect(response.status).toBe(200);
    expect(mocks.deny).toHaveBeenCalledWith({
      requestId: "req_12345678",
      sessionId: "sess_12345678",
      deviceFingerprint: "sha256:1111111111111111",
    });
    await expect(response.json()).resolves.toMatchObject({ decision: "denied", bytes_sent: 0 });
  });
});
