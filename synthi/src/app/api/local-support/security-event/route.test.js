import { afterEach, describe, expect, it, vi } from "vitest";

function request(body, { origin = "http://localhost:3000" } = {}) {
  return new Request("http://localhost:3000/api/local-support/security-event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function rawRequest(body, { origin = "http://localhost:3000" } = {}) {
  return new Request("http://localhost:3000/api/local-support/security-event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
    },
    body,
  });
}

describe("local support security event route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects cross-origin telemetry submissions", async () => {
    vi.stubEnv("VECTANT_LOCAL_SUPPORT_ENABLED", "true");
    const { POST } = await import("./route");

    const response = await POST(request({ event_type: "bad_origin" }, { origin: "https://evil.example" }));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });
  });

  it("rejects cross-site fetch metadata telemetry submissions", async () => {
    vi.stubEnv("VECTANT_LOCAL_SUPPORT_ENABLED", "true");
    const { POST } = await import("./route");

    const response = await POST(new Request("http://localhost:3000/api/local-support/security-event", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ event_type: "bad_origin" }),
    }));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });
  });

  it("records scrubbed security events", async () => {
    vi.stubEnv("VECTANT_LOCAL_SUPPORT_ENABLED", "true");
    const { POST } = await import("./route");

    const response = await POST(
      request({
        event_type: "preview_redirect_blocked",
        count: 1,
        target: "http://169.254.169.254/latest/meta-data/?token=sk-abcdefghijklmnopqrstuvwxyz123456",
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      accepted: true,
      decision: "recorded",
      event_type: "preview_redirect_blocked",
      severity: "high",
      alert: true,
      alert_route: "local_support.security.high",
      raw_body_included: false,
    });
    expect(json.dedupe_key).toMatch(/^sha256:/);
    expect(json.target_display).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("routes traffic spike alerts without raw local content", async () => {
    vi.stubEnv("VECTANT_LOCAL_SUPPORT_ENABLED", "true");
    const { POST } = await import("./route");

    const response = await POST(
      request({
        event_type: "traffic_spike",
        count: 9,
        session_id: "sess_ops",
        target: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      decision: "recorded",
      event_type: "traffic_spike",
      severity: "high",
      alert_route: "local_support.security.high",
      raw_body_included: false,
    });
    expect(json.dedupe_key).toMatch(/^sha256:/);
    expect(JSON.stringify(json)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("denies oversized security event bodies", async () => {
    vi.stubEnv("VECTANT_LOCAL_SUPPORT_ENABLED", "true");
    const { POST } = await import("./route");

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
