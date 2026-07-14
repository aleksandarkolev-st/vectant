import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  controlLease: vi.fn(),
  lease: vi.fn(),
  controlOutcome: vi.fn(),
  outcome: vi.fn(),
  updatePorts: vi.fn(),
  policy: vi.fn(),
}));

vi.mock("@/lib/local-support/deviceAuth", () => ({
  authenticateLocalSupportDevice: mocks.authenticate,
}));
vi.mock("@/lib/local-support/relayStore", () => ({
  leaseLocalControlCommand: mocks.controlLease,
  leaseRelayRequest: mocks.lease,
  recordLocalControlOutcome: mocks.controlOutcome,
  recordRelayOutcome: mocks.outcome,
}));
vi.mock("@/lib/local-support/sessionStore", () => ({
  updatePairedSessionPorts: mocks.updatePorts,
}));
vi.mock("@/lib/local-support/policyStore", () => ({
  readDurableLocalSupportPolicy: mocks.policy,
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
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ ok: false, reason: "device_signature_invalid" });
  mocks.policy.mockResolvedValue({ enabled: true });
});

describe("device-authenticated relay endpoint", () => {
  it("prioritizes an exact-session control command over file delivery", async () => {
    authenticate();
    mocks.controlLease.mockResolvedValue({
      command_id: "cmd_12345678",
      session_id: "sess_12345678",
      action: "pause_session",
      lease_id: "11111111-1111-1111-1111-111111111111",
    });

    const response = await POST(request({ action: "poll" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      decision: "relay_control_command",
      command: { command_id: "cmd_12345678", action: "pause_session" },
      raw_body_included: false,
      bytes_sent: 0,
    });
    expect(mocks.lease).not.toHaveBeenCalled();
  });

  it("stops device relay activity when the effective organization policy is disabled", async () => {
    authenticate();
    mocks.policy.mockResolvedValue({ enabled: false });

    const response = await POST(request({ action: "poll" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ decision: "denied", reason: "feature_disabled" });
    expect(mocks.controlLease).not.toHaveBeenCalled();
    expect(mocks.lease).not.toHaveBeenCalled();
  });

  it("records a session-bound control outcome without accepting a body", async () => {
    authenticate();
    mocks.controlOutcome.mockResolvedValue({
      decision: "applied",
      command_id: "cmd_12345678",
    });
    const body = {
      action: "control_outcome",
      command_id: "cmd_12345678",
      lease_id: "11111111-1111-1111-1111-111111111111",
      decision: "applied",
      reason: "pause_applied",
    };

    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(mocks.controlOutcome).toHaveBeenCalledWith(expect.objectContaining({
      commandId: body.command_id,
      leaseId: body.lease_id,
      sessionId: "sess_12345678",
      deviceFingerprint: "sha256:1111111111111111",
      decision: "applied",
    }));
    await expect(response.json()).resolves.toMatchObject({
      decision: "applied",
      raw_body_included: false,
    });

    const forbidden = await POST(request({ ...body, response_body: "local secret" }));
    expect(forbidden.status).toBe(400);
    expect(mocks.controlOutcome).toHaveBeenCalledTimes(1);
  });

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
    expect(mocks.outcome).toHaveBeenCalledWith(expect.objectContaining({
      requestId: body.request_id,
      sessionId: "sess_12345678",
      deviceFingerprint: "sha256:1111111111111111",
      bytesSent: 42,
    }));

    const forbidden = await POST(request({ ...body, response_body: "local secret" }));
    expect(forbidden.status).toBe(400);
    expect(mocks.outcome).toHaveBeenCalledTimes(1);
  });

  it("records only sanitized, session-bound port status", async () => {
    authenticate();
    mocks.updatePorts.mockResolvedValue(true);
    const ports = [{
      port: 3000,
      target_host: "127.0.0.1",
      preview_host: "br-local-p3000.vectant-preview.dev",
      process_identity_hash: "sha256:2222222222222222",
      browser_preview_allowed: true,
      expires_at: "session_end",
    }];

    const response = await POST(request({ action: "status", ports }));

    expect(response.status).toBe(200);
    expect(mocks.updatePorts).toHaveBeenCalledWith(
      "sess_12345678",
      "sha256:1111111111111111",
      ports,
    );
    await expect(response.json()).resolves.toMatchObject({
      decision: "status_recorded",
      raw_body_included: false,
    });

    const invalid = await POST(request({ action: "status", ports, preview_token: "must-not-be-accepted" }));
    expect(invalid.status).toBe(400);
    expect(mocks.updatePorts).toHaveBeenCalledTimes(1);
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

    expect((await POST(request("x".repeat(16 * 1024 + 1)))).status).toBe(400);

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
