import { afterEach, describe, expect, it } from "vitest";

import { GET, POST } from "./route";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
});

function adminGet(headers = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/admin/state", {
    method: "GET",
    headers,
  });
}

function adminPost(body, headers = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/admin/state", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("local support admin state route", () => {
  it("fails closed when admin access is unconfigured or token is wrong", async () => {
    delete process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN;
    let response = await GET(adminGet());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "admin_token_unconfigured",
      bytes_sent: 0,
    });

    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";
    response = await GET(adminGet({ "x-vectant-admin-token": "wrong" }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "admin_token_invalid",
      bytes_sent: 0,
    });
  });

  it("returns scrubbed device and session summaries without raw bodies", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_STATE_JSON = JSON.stringify({
      devices: [
        {
          device_id: "dev_123 Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
          account_id: "acct_123",
          org_id: "org_123",
          app_version: "0.1.0",
          last_active_at: "2026-07-06T12:00:00Z",
          active_sessions: 2,
          approved_ports_count: 1,
        },
      ],
      sessions: [
        {
          session_id: "sess_123",
          device_id: "dev_123",
          workspace_id: "wk_123",
          approved_ports_count: 1,
          app_version: "0.1.0",
        },
      ],
    });

    const response = await GET(adminGet({ "x-vectant-admin-token": "admin-secret" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "admin_state_ready",
      raw_body_included: false,
      paired_devices: [
        expect.objectContaining({
          account_id: "acct_123",
          approved_ports_count: 1,
          active_sessions: 2,
        }),
      ],
      active_sessions: [
        expect.objectContaining({
          session_id: "sess_123",
          approved_ports_count: 1,
        }),
      ],
    });
    expect(json.paired_devices[0].device_id).toContain("authorization: [REDACTED]");
    expect(JSON.stringify(json)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("builds immediate revoke decisions for devices and sessions", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";

    const response = await POST(
      adminPost(
        { target_type: "session", target_id: "sess_123" },
        { "x-vectant-admin-token": "admin-secret" },
      ),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "revocation_required",
      reason: "session_revocation_requested",
      target_type: "session",
      target_id: "sess_123",
      bytes_sent: 0,
      raw_body_included: false,
      local_enforcement_required: true,
    });

    const invalid = await POST(
      adminPost(
        { target_type: "workspace", target_id: "wk_123" },
        { "x-vectant-admin-token": "admin-secret" },
      ),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "invalid_admin_revoke_target",
      bytes_sent: 0,
    });
  });
});
