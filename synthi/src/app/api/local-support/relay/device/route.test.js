import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  lease: vi.fn(),
  outcome: vi.fn(),
}));

vi.mock("@/lib/local-support/deviceAuth", () => ({
  authenticateLocalSupportDevice: mocks.authenticate,
}));
vi.mock("@/lib/local-support/relayStore", () => ({
  leaseRelayRequest: mocks.lease,
  recordRelayOutcome: mocks.outcome,
}));

import { POST } from "./route";

function request(body) {
  return new Request("https://beta.vectant.dev/api/local-support/relay/device", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function authenticate() {
  mocks.authenticate.mockResolvedValue({
    ok: true,
    session: { sessionId: "sess_12345678", deviceFingerprint: "sha256:1111111111111111" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("device-authenticated relay endpoint", () => {
  it("leases a minimized signed envelope to the paired desktop", async () => {
    authenticate();
    mocks.lease.mockResolvedValue({
      request_id: "req_12345678",
      lease_id: "11111111-1111-1111-1111-111111111111",
      capability: "workspace.log.read",
      target_display: "logs/server.log",
      signature: "sha256:signature",
    });

    const response = await POST(request({ action: "poll" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.any(Request),
      "/api/local-support/relay/device",
      expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    );
    expect(mocks.lease).toHaveBeenCalledWith({
      sessionId: "sess_12345678",
      deviceFingerprint: "sha256:1111111111111111",
    });
    expect(json).toMatchObject({ decision: "relay_delivery", raw_body_included: false, bytes_sent: 0 });
  });

  it("records only an exact minimized outcome schema", async () => {
    authenticate();
    mocks.outcome.mockResolvedValue({ decision: "sent", bytes_sent: 42, audit_id: "audit-1" });
    const body = {
      action: "outcome",
      request_id: "req_12345678",
      lease_id: "11111111-1111-1111-1111-111111111111",
      decision: "sent",
      bytes_sent: 42,
      redaction_count: 2,
      scanner_version: "scanner-1",
      reason: "approved_and_revalidated",
    };

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(mocks.outcome).toHaveBeenCalledWith(expect.objectContaining({ requestId: body.request_id, bytesSent: 42 }));

    const forbidden = await POST(request({ ...body, response_body: "local secret" }));
    expect(forbidden.status).toBe(400);
    expect(mocks.outcome).toHaveBeenCalledTimes(1);
  });

  it("accepts a body-free local review pending outcome", async () => {
    authenticate();
    mocks.outcome.mockResolvedValue({ decision: "review_pending", bytes_sent: 0, audit_id: "audit-2" });

    const response = await POST(request({
      action: "outcome",
      request_id: "req_12345678",
      lease_id: "11111111-1111-1111-1111-111111111111",
      decision: "review_pending",
      bytes_sent: 0,
      redaction_count: 2,
      scanner_version: "scanner-1",
      reason: "local_review_required",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ decision: "review_pending", bytes_sent: 0 });
  });

  it("fails closed for invalid proof, oversized input, and stale leases", async () => {
    mocks.authenticate.mockResolvedValueOnce({ ok: false, reason: "device_signature_invalid" });
    expect((await POST(request({ action: "poll" }))).status).toBe(403);

    expect((await POST(request("x".repeat(4097)))).status).toBe(400);

    authenticate();
    mocks.outcome.mockResolvedValueOnce(null);
    const stale = await POST(request({
      action: "outcome",
      request_id: "req_12345678",
      lease_id: "11111111-1111-1111-1111-111111111111",
      decision: "denied",
      bytes_sent: 0,
      redaction_count: 0,
      scanner_version: "scanner-1",
      reason: "local_policy_denied",
    }));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ decision: "denied", reason: "relay_lease_invalid" });
  });

  it("fails closed when durable delivery state is unavailable", async () => {
    authenticate();
    mocks.lease.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await POST(request({ action: "poll" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "relay_unavailable",
      raw_body_included: false,
      bytes_sent: 0,
    });
  });
});
