import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudMocks = vi.hoisted(() => ({
  session: vi.fn(),
  cloudState: vi.fn(),
  enqueue: vi.fn(),
  findSession: vi.fn(),
  revoke: vi.fn(),
  policy: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: cloudMocks.session }));
vi.mock("@/app/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/local-support/transparencyStore", () => ({
  readCloudTransparencyState: cloudMocks.cloudState,
}));
vi.mock("@/lib/local-support/relayStore", async () => {
  const actual = await vi.importActual("@/lib/local-support/relayStore");
  return {
    ...actual,
    enqueueLocalControlCommand: cloudMocks.enqueue,
  };
});
vi.mock("@/lib/local-support/sessionStore", () => ({
  findActiveBrowserControlSession: cloudMocks.findSession,
}));
vi.mock("@/lib/local-support/adminStore", () => ({
  recordDurableAdminRevocation: cloudMocks.revoke,
}));

vi.mock("@/lib/local-support/policyStore", () => ({
  readDurableLocalSupportPolicy: (...args) => cloudMocks.policy(...args),
}));

import { POST, buildFullAccessEnrollmentProposal } from "./route";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  cloudMocks.session.mockResolvedValue(null);
  cloudMocks.cloudState.mockResolvedValue(null);
  cloudMocks.enqueue.mockResolvedValue({ commandId: "cmd_12345678" });
  cloudMocks.findSession.mockResolvedValue(null);
  cloudMocks.revoke.mockResolvedValue({ decision: "revocation_required", revocation_recorded: true });
  cloudMocks.policy.mockImplementation(async () => {
    const controlPlane = await import("@/lib/local-support/controlPlane");
    return controlPlane.readLocalSupportPolicy();
  });
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
  cloudMocks.session.mockReset();
  cloudMocks.cloudState.mockReset();
  cloudMocks.enqueue.mockReset();
  cloudMocks.findSession.mockReset();
  cloudMocks.revoke.mockReset();
  cloudMocks.policy.mockReset();
  cloudMocks.session.mockResolvedValue(null);
  cloudMocks.cloudState.mockResolvedValue(null);
  cloudMocks.enqueue.mockResolvedValue({ commandId: "cmd_12345678" });
  cloudMocks.findSession.mockResolvedValue(null);
  cloudMocks.revoke.mockResolvedValue({ decision: "revocation_required", revocation_recorded: true });
  cloudMocks.policy.mockImplementation(async () => {
    const controlPlane = await import("@/lib/local-support/controlPlane");
    return controlPlane.readLocalSupportPolicy();
  });
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
  it("derives enrollment scope only from a bounded organization policy", () => {
    const policy = {
      full_access: {
        enabled: true,
        auto_approval_enabled: true,
        command_execution_enabled: true,
        process_visibility_enabled: true,
        workspace_mutation_enabled: false,
        local_port_discovery_enabled: false,
        local_port_use_enabled: false,
        enrollment: {
          policy_major: 1,
          mandatory_reconsent_version: 3,
          allowed_support_actors: ["support_agent"],
          max_bytes_per_request: 4096,
          max_bytes_per_session: 16384,
          max_requests_per_minute: 10,
          max_concurrent_reads: 1,
          max_process_records: 32,
          allowed_command_executables: ["python.exe"],
          max_command_timeout_seconds: 30,
          max_command_output_bytes: 4096,
          max_command_concurrency: 1,
          allowed_loopback_ports: [],
          process_visibility_modes: ["workspace_processes"],
          enrollment_ttl_seconds: 60,
        },
      },
    };
    const proposal = buildFullAccessEnrollmentProposal(policy, "support_agent");
    expect(proposal).toMatchObject({
      support_actor: "support_agent",
      policy: {
        allowed_actors: ["support_agent"],
        allowed_command_executables: ["python.exe"],
        process_visibility_modes: ["workspace_processes"],
        allowed_capabilities: expect.arrayContaining(["enroll", "command_execute", "process_inventory"]),
      },
    });
    expect(buildFullAccessEnrollmentProposal(policy, "browser_user")).toBeNull();
  });

  it("queues an authenticated bounded enrollment proposal for native desktop confirmation", async () => {
    const enrollment = {
      policy_major: 1, mandatory_reconsent_version: 3, allowed_support_actors: ["support_agent"],
      max_bytes_per_request: 4096, max_bytes_per_session: 16384, max_requests_per_minute: 10,
      max_concurrent_reads: 1, max_process_records: 32, allowed_command_executables: [],
      max_command_timeout_seconds: 30, max_command_output_bytes: 4096, max_command_concurrency: 1,
      allowed_loopback_ports: [], process_visibility_modes: [], enrollment_ttl_seconds: 60,
    };
    cloudMocks.policy.mockResolvedValue({
      enabled: true, policy_version: "2026.07.05",
      full_access: {
        enabled: true, auto_approval_enabled: false, process_visibility_enabled: false,
        workspace_mutation_enabled: false, command_execution_enabled: false,
        local_port_discovery_enabled: false, local_port_use_enabled: false, enrollment,
      },
    });
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    cloudMocks.cloudState.mockResolvedValue({
      session: { connected: true, session_id: "sess_live_12345678", account_id: "acct_live", org_id: "org_live" },
      workspace: { workspace_id: "wk_live_12345678", display: "Live workspace" },
      full_access: { enrolled: false },
    });
    cloudMocks.findSession.mockResolvedValue({
      sessionId: "sess_live_12345678", accountId: "acct_live", orgId: "org_live",
      workspaceId: "wk_live_12345678", deviceFingerprint: "sha256:1111111111111111",
    });

    const response = await POST(request({
      action: "full_access_enrollment_proposal", support_actor: "support_agent",
      session_id: "sess_live_12345678", workspace_id: "wk_live_12345678",
    }));
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json).toMatchObject({ decision: "local_control_command_queued", action: "full_access_enrollment_proposal" });
    expect(cloudMocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      action: "full_access_enrollment_proposal",
      proposal: expect.objectContaining({ support_actor: "support_agent", policy: expect.objectContaining({ allowed_capabilities: expect.arrayContaining(["enroll", "graph_read"]) }) }),
    }));
  });

  it("denies disconnected page-only actions instead of faking local storage changes", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    delete process.env.VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON;

    const response = await POST(request({ action: "delete_history" }));
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "authentication_required",
      bytes_sent: 0,
    });
  });

  it("requires authentication before touching configured local daemon credentials", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "pause_session" }));
    const json = await response.json();

    expect(response.status).toBe(401);
    expect(json).toMatchObject({ decision: "denied", reason: "authentication_required", bytes_sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not treat a static environment snapshot as a connected local app", async () => {
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

    const response = await POST(request({ action: "pause_session" }));
    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json).toMatchObject({
      decision: "denied",
      reason: "authentication_required",
      bytes_sent: 0,
    });
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

  it("queues authenticated cloud controls for the paired desktop relay", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    cloudMocks.cloudState.mockResolvedValue({
      session: {
        connected: true,
        session_id: "sess_live_12345678",
        account_id: "acct_live",
        org_id: "org_live",
      },
      workspace: { workspace_id: "wk_live_12345678", display: "Live workspace" },
    });
    cloudMocks.findSession.mockResolvedValue({
      sessionId: "sess_live_12345678",
      accountId: "acct_live",
      orgId: "org_live",
      workspaceId: "wk_live_12345678",
      deviceFingerprint: "sha256:1111111111111111",
    });
    cloudMocks.enqueue.mockResolvedValue({ commandId: "cmd_12345678" });

    const response = await POST(request({
      action: "pause_session",
      session_id: "sess_live_12345678",
      workspace_id: "wk_live_12345678",
    }));
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json).toMatchObject({
      decision: "local_control_command_queued",
      action: "pause_session",
      command_id: "cmd_12345678",
      local_daemon_forwarded: false,
      bytes_sent: 0,
    });
    expect(cloudMocks.findSession).toHaveBeenCalledWith({
      accountId: "acct_live",
      sessionId: "sess_live_12345678",
      workspaceId: "wk_live_12345678",
    });
    expect(cloudMocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess_live_12345678",
      accountId: "acct_live",
      workspaceId: "wk_live_12345678",
      action: "pause_session",
      port: null,
      actor: "acct_live",
    }));
  });

  it("forwards connected actions to the configured loopback daemon", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
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

  it("queues Full Access controls for the signed desktop relay instead of exposing a browser-to-daemon route", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    cloudMocks.findSession.mockResolvedValue({
      sessionId: "sess_live_12345678",
      accountId: "acct_live",
      orgId: "org_live",
      workspaceId: "wk_live_12345678",
      deviceFingerprint: "sha256:1111111111111111",
    });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      session: { session_id: "sess_live_12345678", account_id: "acct_live", org_id: "org_live" },
      workspace: { workspace_id: "wk_live_12345678" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      action: "full_access_revoke",
      session_id: "sess_live_12345678",
      workspace_id: "wk_live_12345678",
    }));
    const json = await response.json();

    expect(response.status).toBe(202);
    expect(json).toMatchObject({
      decision: "local_control_command_queued",
      action: "full_access_revoke",
      local_daemon_forwarded: false,
      bytes_sent: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cloudMocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      action: "full_access_revoke",
      sessionId: "sess_live_12345678",
      workspaceId: "wk_live_12345678",
    }));
  });

  it("rejects a daemon paired to a different authenticated account", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_browser" } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      session: { session_id: "sess_live", account_id: "acct_other" },
      workspace: { workspace_id: "wk_live" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "pause_session" }));
    const json = await response.json();

    expect(response.status).toBe(403);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "local_control_context_mismatch",
      bytes_sent: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records cloud revocation before forwarding direct local disconnect", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v1/status/")) {
        return new Response(JSON.stringify({
          session: { session_id: "sess_live", account_id: "acct_live" },
          workspace: { workspace_id: "wk_live" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ decision: "session_disconnected", bytes_sent: 0 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "disconnect_session" }));

    expect(response.status).toBe(200);
    expect(cloudMocks.revoke).toHaveBeenCalledWith(
      { target_type: "session", target_id: "sess_live" },
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when direct local disconnect cannot record cloud revocation", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    cloudMocks.revoke.mockRejectedValue(new Error("database unavailable"));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      session: { session_id: "sess_live", account_id: "acct_live" },
      workspace: { workspace_id: "wk_live" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "disconnect_session" }));
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json).toMatchObject({ decision: "denied", reason: "cloud_control_unavailable", bytes_sent: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("denies connected actions when the daemon control credentials are missing", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    delete process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      session: { session_id: "sess_live", account_id: "acct_live" },
      workspace: { workspace_id: "wk_live" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({ action: "pause_session" }));
    const json = await response.json();

    expect(response.status).toBe(503);
    expect(json).toMatchObject({
      decision: "denied",
      reason: "local_daemon_control_unavailable",
      bytes_sent: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards session approval revocation to the local daemon", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v1/status/")) {
        return new Response(JSON.stringify({
          session: { session_id: "sess_live", account_id: "acct_live" },
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
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v1/status/")) {
        return new Response(JSON.stringify({
          session: { session_id: "sess_live", account_id: "acct_live" },
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
    cloudMocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET = "desktop_control_secret_123456789012345";
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/v1/status/")) {
        return new Response(JSON.stringify({
          session: { session_id: "sess_live", account_id: "acct_live" },
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
