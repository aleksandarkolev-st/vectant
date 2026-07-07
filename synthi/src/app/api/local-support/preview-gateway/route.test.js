import { afterEach, describe, expect, it } from "vitest";

import {
  clearAdminRevocationStore,
  clearRequestEnvelopeReplayCache,
  signRequestEnvelope,
} from "@/lib/local-support/controlPlane";

import { POST } from "./route";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
  clearAdminRevocationStore();
  clearRequestEnvelopeReplayCache();
});

function envelope(overrides = {}) {
  return {
    request_id: "req_preview_route_123",
    session_id: "sess_preview_route_123",
    account_id: "acct_preview_123",
    org_id: "org_preview_123",
    workspace_id: "wk_preview_123",
    device_fingerprint: "sha256:5555555555555555",
    device_proof: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    capability: "localhost.preview.browser",
    actor: "user_browser",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    app_version: "0.1.0",
    protocol_version: "local-support-mvp.1",
    policy_version: "2026.07.05",
    preview_host: "br-local-p3000.vectant-preview.dev",
    target_host: "127.0.0.1",
    approved_port: 3000,
    requested_port: 3000,
    preview_method: "GET",
    preview_path: "/",
    request_headers: {
      accept: "text/html",
    },
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
  return new Request("https://beta.vectant.dev/api/local-support/preview-gateway", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      ...(init.headers || {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("local support preview-gateway route", () => {
  it("requires same-origin signed browser preview envelopes", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const crossOrigin = await POST(request(signedEnvelope(), { headers: { origin: "https://evil.example" } }));
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });

    const unsigned = await POST(request(envelope({ request_id: "req_preview_unsigned" })));
    expect(unsigned.status).toBe(403);
    await expect(unsigned.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "request_envelope_signature_missing",
      preview_forward: false,
      bytes_sent: 0,
    });
  });

  it("authorizes browser-only loopback preview without exposing response bodies", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const response = await POST(request(signedEnvelope()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "preview_gateway_ready",
      preview_forward: true,
      browser_stream_only: true,
      support_read_allowed: false,
      ai_read_allowed: false,
      response_body_included: false,
      raw_body_included: false,
      bytes_sent: 0,
      preview_host: "br-local-p3000.vectant-preview.dev",
      target_host: "127.0.0.1",
      approved_port: 3000,
      control_plane_log_class: "local_support.control",
      data_plane_log_class: "local_support.preview",
    });
  });

  it("rejects preview replays and unsafe preview targets", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const body = signedEnvelope({ request_id: "req_preview_replay" });
    const first = await POST(request(body));
    expect(first.status).toBe(200);

    const replay = await POST(request(body));
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "request_replay_detected",
      preview_forward: false,
      bytes_sent: 0,
    });

    const metadata = await POST(request(signedEnvelope({
      request_id: "req_preview_metadata_route",
      target_host: "169.254.169.254",
    })));
    expect(metadata.status).toBe(403);
    await expect(metadata.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "preview_target_not_loopback",
      preview_forward: false,
      bytes_sent: 0,
    });
  });

  it("blocks credentials, websocket, service-worker, and unsafe method attempts", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const cases = [
      [{ request_headers: { authorization: "Bearer secret" } }, "preview_credentials_header_blocked"],
      [{ request_headers: { "sec-websocket-key": "abc" } }, "preview_websocket_blocked"],
      [{ preview_path: "/service-worker.js" }, "preview_path_invalid"],
      [{ preview_method: "POST" }, "preview_method_not_allowed"],
    ];

    for (const [overrides, reason] of cases) {
      const response = await POST(request(signedEnvelope({
        request_id: `req_${reason}`,
        ...overrides,
      })));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        decision: "denied",
        reason,
        preview_forward: false,
        bytes_sent: 0,
      });
    }
  });

  it("rejects malformed JSON at the shared HTTP boundary", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";

    const response = await POST(request("{"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "malformed_json",
      bytes_sent: 0,
    });
  });
});
