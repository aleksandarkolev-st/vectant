import { afterEach, describe, expect, it } from "vitest";

import { POST } from "./route";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
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

function envelope(overrides = {}) {
  return {
    request_id: "req_123",
    session_id: "sess_123",
    workspace_id: "wk_123",
    capability: "workspace.file.source.read",
    actor: "support_agent",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    app_version: "0.1.0",
    ...overrides,
  };
}

describe("local support request-envelope route", () => {
  it("denies cross-origin browser calls before policy evaluation", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";

    const response = await POST(request(envelope(), { headers: { origin: "https://evil.example" } }));
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
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";

    const response = await POST(request(envelope({ capability: "workspace.log.read" })));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      decision: "approval_required",
      local_enforcement_required: true,
      bytes_sent: 0,
    });
  });
});
