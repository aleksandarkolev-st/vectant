import { afterEach, describe, expect, it } from "vitest";

import { clearRequestEnvelopeReplayCache, signRequestEnvelope } from "@/lib/local-support/controlPlane";

import { POST } from "./route";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
  clearRequestEnvelopeReplayCache();
});

function envelope(overrides = {}) {
  return {
    request_id: "req_relay_123",
    session_id: "sess_relay_123",
    account_id: "acct_relay_123",
    org_id: "org_relay_123",
    workspace_id: "wk_relay_123",
    capability: "workspace.log.read",
    actor: "support_agent",
    target_display: "server.log Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    target_classification: "L3",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    app_version: "0.1.0",
    protocol_version: "local-support-mvp.1",
    policy_version: "2026.07.05",
    ...overrides,
  };
}

function signedEnvelope(overrides = {}, secret = "test-envelope-secret") {
  const body = envelope(overrides);
  return {
    ...body,
    signature: signRequestEnvelope(body, secret),
  };
}

function request(body, init = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/relay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      ...(init.headers || {}),
    },
    body: JSON.stringify(body),
  });
}

describe("local support relay route", () => {
  it("fails closed when local support is disabled", async () => {
    delete process.env.VECTANT_LOCAL_SUPPORT_ENABLED;

    const response = await POST(request(envelope()));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "denied",
      reason: "feature_disabled",
      relay_forward: false,
      raw_body_included: false,
      bytes_sent: 0,
    });
  });

  it("denies cross-origin relay attempts before signature checks", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const response = await POST(request(signedEnvelope(), { headers: { origin: "https://evil.example" } }));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });
  });

  it("requires signed envelopes and rejects replay before relay forwarding", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const unsigned = await POST(request(envelope()));
    expect(unsigned.status).toBe(403);
    await expect(unsigned.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "request_envelope_signature_missing",
      relay_forward: false,
      bytes_sent: 0,
    });

    const body = signedEnvelope({ request_id: "req_relay_replay" });
    const first = await POST(request(body));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      decision: "relay_ready",
      relay_forward: true,
      bytes_sent: 0,
    });

    const replay = await POST(request(body));
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "request_replay_detected",
      relay_forward: false,
      bytes_sent: 0,
    });
  });

  it("refuses relay forwarding for the wrong account or organization", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";
    process.env.VECTANT_LOCAL_SUPPORT_ACCOUNT_ID = "acct_relay_123";
    process.env.VECTANT_LOCAL_SUPPORT_ORG_ID = "org_relay_123";

    const wrongAccount = await POST(request(signedEnvelope({ account_id: "acct_attacker" })));
    expect(wrongAccount.status).toBe(403);
    await expect(wrongAccount.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "account_mismatch",
      relay_forward: false,
      bytes_sent: 0,
    });

    const wrongOrg = await POST(request(signedEnvelope({
      request_id: "req_relay_wrong_org",
      org_id: "org_attacker",
    })));
    expect(wrongOrg.status).toBe(403);
    await expect(wrongOrg.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "org_mismatch",
      relay_forward: false,
      bytes_sent: 0,
    });
  });

  it("does not consume relay replay nonces for policy-denied envelopes", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const requestId = "req_relay_denied_then_valid";
    const denied = await POST(request(signedEnvelope({
      request_id: requestId,
      capability: "workspace.command.execute",
    })));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "capability_blocked_in_mvp",
      relay_forward: false,
      bytes_sent: 0,
    });

    const valid = await POST(request(signedEnvelope({
      request_id: requestId,
      capability: "workspace.log.read",
    })));
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({
      decision: "relay_ready",
      relay_forward: true,
      bytes_sent: 0,
    });
  });

  it("returns scrubbed relay summaries and never includes local body content", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const response = await POST(request(signedEnvelope()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "relay_ready",
      relay_forward: true,
      raw_body_included: false,
      response_body_included: false,
      bytes_sent: 0,
      target_classification: "L3",
      control_plane_log_class: "local_support.control",
      data_plane_log_class: "local_support.data",
      account_id: "acct_relay_123",
      org_id: "org_relay_123",
    });
    expect(json.target_hash).toMatch(/^sha256:/);
    expect(json.target_display).toContain("authorization: [REDACTED]");
    expect(JSON.stringify(json)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
