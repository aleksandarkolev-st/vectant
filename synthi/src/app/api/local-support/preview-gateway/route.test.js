import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearAdminRevocationStore,
  clearRequestEnvelopeReplayCache,
  signDeviceProof,
  signRequestEnvelope,
} from "@/lib/local-support/controlPlane";

vi.mock("@/lib/local-support/policyStore", async () => {
  const controlPlane = await import("@/lib/local-support/controlPlane");
  return { readDurableLocalSupportPolicy: async () => controlPlane.readLocalSupportPolicy() };
});

import { POST } from "./route";

const OLD_ENV = { ...process.env };
const DEVICE_PROOF_SECRET = "test-device-proof-secret";

afterEach(() => {
  process.env = { ...OLD_ENV };
  clearAdminRevocationStore();
  clearRequestEnvelopeReplayCache();
});

function enableLocalSupport() {
  process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
  process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";
  process.env.VECTANT_LOCAL_SUPPORT_DEVICE_PROOF_SECRET = DEVICE_PROOF_SECRET;
}

function envelope(overrides = {}) {
  const body = {
    request_id: "req_preview_route_123",
    session_id: "sess_preview_route_123",
    account_id: "acct_preview_123",
    org_id: "org_preview_123",
    workspace_id: "wk_preview_123",
    device_fingerprint: "sha256:5555555555555555",
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

function request(body, init = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/preview-gateway", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      "sec-fetch-site": "same-origin",
      ...(init.headers || {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("local support preview-gateway route", () => {
  it("requires same-origin signed browser preview envelopes", async () => {
    enableLocalSupport();

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
    enableLocalSupport();

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
    enableLocalSupport();

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
    enableLocalSupport();

    const cases = [
      [{ request_headers: { authorization: "Bearer secret" } }, "preview_credentials_header_blocked"],
      [{ request_headers: { "sec-websocket-key": "abc" } }, "preview_websocket_blocked"],
      [{ request_headers: [["content-length", "0"], ["content-length", "0"]] }, "preview_duplicate_content_length_blocked"],
      [{ request_headers: { "content-length": "0", "transfer-encoding": "chunked" } }, "preview_ambiguous_body_length_blocked"],
      [{ request_headers: { connection: "authorization" } }, "preview_connection_sensitive_header_blocked"],
      [{ request_headers: [["connection", "x-shadow-hop"], ["x-shadow-hop", "secret"]] }, "preview_connection_named_header_blocked"],
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

  it("classifies preview redirects without proxying unsafe targets", async () => {
    enableLocalSupport();

    const loopback = await POST(request(signedEnvelope({
      request_id: "req_preview_redirect_loopback",
      preview_path: "/docs/index.html",
      redirect_location: "http://127.0.0.1:3000/ok?x=1",
    })));
    expect(loopback.status).toBe(200);
    await expect(loopback.json()).resolves.toMatchObject({
      decision: "preview_redirect_rewrite",
      preview_forward: true,
      redirect_rewrite_path: "/ok?x=1",
      response_body_included: false,
      bytes_sent: 0,
    });

    const relative = await POST(request(signedEnvelope({
      request_id: "req_preview_redirect_relative",
      preview_path: "/docs/index.html",
      redirect_location: "next.html",
    })));
    expect(relative.status).toBe(200);
    await expect(relative.json()).resolves.toMatchObject({
      decision: "preview_redirect_rewrite",
      redirect_rewrite_path: "/docs/next.html",
      bytes_sent: 0,
    });

    for (const [location, reason] of [
      ["http://169.254.169.254/latest/meta-data/", "preview_redirect_target_not_loopback"],
      ["http://192.168.1.1/admin", "preview_redirect_target_not_loopback"],
      ["file:///etc/passwd", "preview_redirect_custom_scheme_blocked"],
      ["http://user:pass@127.0.0.1:3000/secret", "preview_redirect_userinfo_blocked"],
      ["http://127.0.0.1:3001/wrong-port", "preview_redirect_target_not_loopback"],
    ]) {
      const response = await POST(request(signedEnvelope({
        request_id: `req_${reason}_${location.length}`,
        redirect_location: location,
      })));
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        decision: "denied",
        reason,
        preview_forward: false,
        bytes_sent: 0,
      });
    }

    const external = await POST(request(signedEnvelope({
      request_id: "req_preview_redirect_external",
      redirect_location: "https://example.com/docs",
    })));
    expect(external.status).toBe(200);
    await expect(external.json()).resolves.toMatchObject({
      decision: "preview_external_navigation",
      preview_forward: false,
      external_navigation: true,
      bytes_sent: 0,
    });
  });

  it("rejects malformed JSON at the shared HTTP boundary", async () => {
    enableLocalSupport();

    const response = await POST(request("{"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "malformed_json",
      bytes_sent: 0,
    });
  });
});
