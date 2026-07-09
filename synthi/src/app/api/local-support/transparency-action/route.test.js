import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
});

function request(body, headers = {}) {
  return new Request("https://app.vectant.dev/api/local-support/transparency-action", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://app.vectant.dev",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("local support transparency action route", () => {
  it("denies disconnected page-only actions instead of faking local storage changes", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    delete process.env.VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON;

    const response = await POST(request({ action: "delete_history" }));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "local_app_not_connected",
      bytes_sent: 0,
    });
  });

  it("returns zero-byte local control decisions for connected actions", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON = JSON.stringify({
      session: {
        connected: true,
        session_id: "sess_live",
      },
      workspace: {
        workspace_id: "wk_live",
        display: "Live workspace",
      },
      ports: [
        {
          port: 5173,
          preview_host: "br-local-p5173.vectant-preview.dev",
          preview_token: "hidden-token",
        },
      ],
    });

    const pause = await POST(request({ action: "pause_session" }));
    expect(pause.status).toBe(200);
    await expect(pause.json()).resolves.toMatchObject({
      decision: "local_control_action_required",
      action: "pause_session",
      session_id: "sess_live",
      workspace_id: "wk_live",
      bytes_sent: 0,
      raw_body_included: false,
      local_enforcement_required: true,
    });

    const revokePort = await POST(request({ action: "revoke_port", port: 5173 }));
    expect(revokePort.status).toBe(200);
    const json = await revokePort.json();
    expect(json).toMatchObject({
      decision: "local_control_action_required",
      action: "revoke_port",
      port: 5173,
      bytes_sent: 0,
    });
    expect(JSON.stringify(json)).not.toContain("hidden-token");
  });

  it("rejects cross-site action attempts", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON = JSON.stringify({
      session: { connected: true, session_id: "sess_live" },
    });

    const response = await POST(request(
      { action: "disconnect_session" },
      {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    ));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });
  });

  it("forwards connected actions to the configured loopback daemon", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v1/status/")) {
        return new Response(JSON.stringify({
          session: {
            connected: true,
            session_id: "sess_live",
            account_id: "acct_live",
          },
          workspace: {
            workspace_id: "wk_live",
            display: "Live workspace",
          },
          ports: [{ port: 5173, preview_host: "br-local-p5173.vectant-preview.dev" }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        session_id: "sess_live",
        paused: true,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "pause_session" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      decision: "local_control_action_applied",
      action: "pause_session",
      local_daemon_forwarded: true,
      bytes_sent: 0,
      raw_body_included: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:49152\/v1\/status\/web_/),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:49152\/v1\/session\/pause\/web_pause_session_/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer local_status_bearer_12345678901234567890",
          "x-vectant-local-control-secret": "desktop_control_secret_123456789012345",
        }),
      }),
    );
  });

  it("forwards session approval revocation to the local daemon", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v1/status/")) {
        return new Response(JSON.stringify({
          session: { session_id: "sess_live" },
          workspace: { workspace_id: "wk_live" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        decision: "session_approvals_revoked",
        bytes_sent: 0,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "revoke_session_approvals" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      decision: "local_control_action_applied",
      action: "revoke_session_approvals",
      daemon_decision: "session_approvals_revoked",
      local_daemon_forwarded: true,
      bytes_sent: 0,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:49152\/v1\/approval\/revoke-all\/web_revoke_session_approvals_/),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-vectant-local-control-secret": "desktop_control_secret_123456789012345",
        }),
      }),
    );
  });

  it("sanitizes daemon history export responses before returning them to the browser", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v1/status/")) {
        return new Response(JSON.stringify({
          session: { session_id: "sess_live" },
          workspace: { workspace_id: "wk_live" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        export_version: "local-support-audit-v1",
        raw_bodies_included: false,
        retention_days: 30,
        root_hash: "sha256:root",
        events: [{ summary: "Blocked Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }],
        consent_receipts: [{ target_display: "server.log" }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "export_history" }));
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      decision: "local_control_action_applied",
      action: "export_history",
      export: {
        export_version: "local-support-audit-v1",
        raw_bodies_included: false,
        retention_days: 30,
        events_count: 1,
        consent_receipts_count: 1,
        root_hash: "sha256:root",
      },
    });
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("server.log");
  });

  it("does not forward actions to non-loopback daemon URLs", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://169.254.169.254/latest/meta-data";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    process.env.VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON = JSON.stringify({
      session: { connected: true, session_id: "sess_live" },
      workspace: { workspace_id: "wk_live" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "disconnect_session" }));
    const json = await response.json();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "local_daemon_url_not_loopback",
      bytes_sent: 0,
    });
  });

  it("scrubs daemon denial messages before returning them to the browser", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v1/status/")) {
        return new Response(JSON.stringify({
          session: { session_id: "sess_live" },
          workspace: { workspace_id: "wk_live" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        decision: "denied",
        reason: "scanner_failure",
        user_visible_message: "Blocked Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      }), { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "delete_history" }));
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "scanner_failure",
      local_daemon_forwarded: true,
      bytes_sent: 0,
    });
    expect(json.user_visible_message).toContain("authorization: [REDACTED]");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
});
