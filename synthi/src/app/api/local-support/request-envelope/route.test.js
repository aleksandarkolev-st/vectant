import { afterEach, describe, expect, it } from "vitest";

import {
  clearAdminRevocationStore,
  clearRequestEnvelopeReplayCache,
  signDeviceProof,
  signRequestEnvelope,
} from "@/lib/local-support/controlPlane";

import { POST } from "./route";

const OLD_ENV = { ...process.env };
const DEVICE_PROOF_SECRET = "test-device-proof-secret";

afterEach(() => {
  process.env = { ...OLD_ENV };
  clearAdminRevocationStore();
  clearRequestEnvelopeReplayCache();
});

function request(body, init = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/request-envelope", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      ...(init.headers || {}),
    },
    body: JSON.stringify(body),
  });
}

function rawRequest(body, init = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/request-envelope", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      ...(init.headers || {}),
    },
    body,
  });
}

function enableLocalSupport() {
  process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
  process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";
  process.env.VECTANT_LOCAL_SUPPORT_DEVICE_PROOF_SECRET = DEVICE_PROOF_SECRET;
}

function envelope(overrides = {}) {
  const body = {
    request_id: "req_123",
    session_id: "sess_123",
    account_id: "acct_123",
    org_id: "org_123",
    workspace_id: "wk_123",
    device_fingerprint: "sha256:1111111111111111",
    capability: "workspace.file.source.read",
    actor: "support_agent",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    app_version: "0.1.0",
    protocol_version: "local-support-mvp.1",
    policy_version: "2026.07.05",
    ...overrides,
  };
  return {
    ...body,
    device_proof: overrides.device_proof || signDeviceProof(body, DEVICE_PROOF_SECRET),
  };
}

function signedEnvelope(overrides = {}, secret = "test-envelope-secret") {
  const body = envelope(overrides);
  return {
    ...body,
    signature: signRequestEnvelope(body, secret),
  };
}

describe("local support request-envelope route", () => {
  it("denies cross-origin browser calls before policy evaluation", async () => {
    enableLocalSupport();

    const response = await POST(request(signedEnvelope(), { headers: { origin: "https://evil.example" } }));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });
  });

  it("denies cross-site fetch metadata before policy evaluation", async () => {
    enableLocalSupport();

    const response = await POST(request(signedEnvelope(), { headers: { "sec-fetch-site": "cross-site" } }));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });
  });

  it("fails closed when the feature is not enabled", async () => {
    delete process.env.VECTANT_LOCAL_SUPPORT_ENABLED;

    const response = await POST(request(envelope()));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "feature_disabled",
      bytes_sent: 0,
    });
  });

  it("approval-gates allowed MVP reads without sending bytes", async () => {
    enableLocalSupport();

    const response = await POST(request(signedEnvelope({ capability: "workspace.log.read" })));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "approval_required",
      local_enforcement_required: true,
      bytes_sent: 0,
    });
  });

  it("denies signed envelopes for the wrong account or organization", async () => {
    enableLocalSupport();
    process.env.VECTANT_LOCAL_SUPPORT_ACCOUNT_ID = "acct_123";
    process.env.VECTANT_LOCAL_SUPPORT_ORG_ID = "org_123";
    process.env.VECTANT_LOCAL_SUPPORT_DEVICE_FINGERPRINT = "sha256:1111111111111111";

    const wrongAccount = await POST(request(signedEnvelope({ account_id: "acct_attacker" })));
    expect(wrongAccount.status).toBe(403);
    await expect(wrongAccount.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "account_mismatch",
      bytes_sent: 0,
    });

    const wrongOrg = await POST(request(signedEnvelope({
      request_id: "req_wrong_org",
      org_id: "org_attacker",
    })));
    expect(wrongOrg.status).toBe(403);
    await expect(wrongOrg.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "org_mismatch",
      bytes_sent: 0,
    });

    const wrongDevice = await POST(request(signedEnvelope({
      request_id: "req_wrong_device",
      device_fingerprint: "sha256:2222222222222222",
    })));
    expect(wrongDevice.status).toBe(403);
    await expect(wrongDevice.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "device_mismatch",
      bytes_sent: 0,
    });
  });

  it("denies unsigned or tampered request envelopes before approval", async () => {
    enableLocalSupport();

    const unsigned = await POST(request(envelope({ capability: "workspace.log.read" })));
    expect(unsigned.status).toBe(403);
    await expect(unsigned.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "request_envelope_signature_missing",
      bytes_sent: 0,
    });

    const signed = signedEnvelope({ capability: "workspace.log.read" });
    const tampered = { ...signed, target: ".env", capability: "workspace.metadata.read" };
    const response = await POST(request(tampered));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "request_envelope_signature_invalid",
      bytes_sent: 0,
    });
  });

  it("denies signed envelopes with unsafe identifiers before local approval", async () => {
    enableLocalSupport();

    const response = await POST(request(signedEnvelope({
      request_id: "req_unsafe\nheader",
      capability: "workspace.log.read",
    })));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "invalid_schema",
      bytes_sent: 0,
    });
  });

  it("rejects replayed signed request envelopes", async () => {
    enableLocalSupport();
    const body = signedEnvelope({
      request_id: "req_replay_route",
      capability: "workspace.log.read",
    });

    const first = await POST(request(body));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      decision: "approval_required",
      bytes_sent: 0,
    });

    const replay = await POST(request(body));
    const replayJson = await replay.json();
    expect(replay.status).toBe(409);
    expect(replayJson).toMatchObject({
      decision: "denied",
      reason: "request_replay_detected",
      bytes_sent: 0,
    });
  });

  it("does not consume replay nonces for policy-denied envelopes", async () => {
    enableLocalSupport();

    const requestId = "req_policy_denied_then_valid";
    const denied = await POST(request(signedEnvelope({
      request_id: requestId,
      capability: "workspace.file.write",
    })));
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "capability_blocked_in_mvp",
      bytes_sent: 0,
    });

    const valid = await POST(request(signedEnvelope({
      request_id: requestId,
      capability: "workspace.log.read",
    })));
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({
      decision: "approval_required",
      bytes_sent: 0,
    });
  });

  it("fails closed when envelope signing is not configured for enabled support", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_DEVICE_PROOF_SECRET = DEVICE_PROOF_SECRET;
    delete process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET;

    const response = await POST(request(envelope({ capability: "workspace.log.read" })));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "request_envelope_signing_unconfigured",
      bytes_sent: 0,
    });
  });

  it("fails closed when device proof verification is not configured", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";
    delete process.env.VECTANT_LOCAL_SUPPORT_DEVICE_PROOF_SECRET;

    const response = await POST(request(signedEnvelope({ capability: "workspace.log.read" })));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "device_proof_unconfigured",
      bytes_sent: 0,
    });
  });

  it("denies oversized request envelopes before policy evaluation", async () => {
    enableLocalSupport();

    const response = await POST(rawRequest(JSON.stringify({ padding: "x".repeat(70 * 1024) })));
    const json = await response.json();

    expect(response.status).toBe(413);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "body_too_large",
      bytes_sent: 0,
    });
  });
});
