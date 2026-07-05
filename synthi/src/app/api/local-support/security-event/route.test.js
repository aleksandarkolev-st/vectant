import { afterEach, describe, expect, it, vi } from "vitest";

function request(body, { origin = "http://localhost:3000" } = {}) {
  return new Request("http://localhost:3000/api/local-support/security-event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
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
    expect(json).toMatchObject({
      accepted: true,
      decision: "recorded",
      event_type: "preview_redirect_blocked",
      severity: "high",
      raw_body_included: false,
    });
    expect(json.target_display).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
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
