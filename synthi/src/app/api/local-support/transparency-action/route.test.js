import { afterEach, describe, expect, it } from "vitest";

import { POST } from "./route";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
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
});
