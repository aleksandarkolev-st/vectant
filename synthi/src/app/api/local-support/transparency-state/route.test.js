import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), cloudState: vi.fn() }));
vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/app/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/local-support/transparencyStore", () => ({
  readCloudTransparencyState: mocks.cloudState,
}));
vi.mock("@/lib/local-support/policyStore", async () => {
  const controlPlane = await import("@/lib/local-support/controlPlane");
  return { readDurableLocalSupportPolicy: async () => controlPlane.readLocalSupportPolicy() };
});

import { GET } from "./route";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  mocks.session.mockReset();
  mocks.cloudState.mockReset();
  mocks.session.mockResolvedValue(null);
  mocks.cloudState.mockResolvedValue({
    inventory: [], sent_payloads: [], blocked_items: [], activity: [], ports: [],
  });
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.unstubAllGlobals();
});

describe("local support transparency state route", () => {
  it("returns a truthful empty state without caching", async () => {
    delete process.env.VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON;

    const response = await GET();
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "transparency_state_ready",
      raw_bodies_included: false,
      session: {
        connected: false,
        session_id: "not_paired",
      },
      workspace: {
        workspace_id: "not_selected",
      },
      inventory: [],
      sent_payloads: [],
      blocked_items: [],
      activity: [],
      ports: [],
    });
  });

  it("scrubs live cloud summaries and hides preview tokens from renderer state", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    mocks.session.mockResolvedValue({ user: { id: "acct_live" } });
    mocks.cloudState.mockResolvedValue({
      scanner_version: "scanner Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      session: {
        connected: true,
        session_id: "sess_live",
        account_id: "acct_live",
      },
      workspace: {
        workspace_id: "wk_live",
        display: "Workspace postgres://user:pass@localhost/db",
      },
      inventory: [
        {
          target: ".env Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
          state: "approval_required",
          classification: "L4",
        },
      ],
      sent_payloads: [
        {
          request_id: "req_sent",
          actor: "support_agent",
          target_display: "server.log sk-abcdefghijklmnopqrstuvwxyz123456",
          target_hash: "sha256:abc",
          redaction_count: 2,
          bytes_sent: 42,
        },
      ],
      blocked_items: [
        {
          target: ".env ghp_abcdefghijklmnopqrstuvwxyz123456",
          reason: "denied_secret_request",
          classification: "L5",
        },
      ],
      activity: [
        {
          class: "Denied",
          summary: "Blocked Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        },
      ],
      ports: [
        {
          port: 5173,
          preview_host: "br-local-p5173.vectant-preview.dev",
          preview_token: "raw-preview-token",
          service: "vite",
          aiRead: true,
          responseBodies: true,
        },
      ],
    });

    const response = await GET();
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      session: {
        connected: true,
        account_id: "acct_live",
      },
      workspace: {
        workspace_id: "wk_live",
      },
      inventory: [
        expect.objectContaining({
          state: "approval_required",
          classification: "L4",
        }),
      ],
      sent_payloads: [
        expect.objectContaining({
          id: "req_sent",
          redactions: 2,
          bytes: 42,
        }),
      ],
      blocked_items: [
        expect.objectContaining({
          bytes_sent: 0,
          className: "L5",
        }),
      ],
      ports: [
        expect.objectContaining({
          port: 5173,
          aiRead: true,
          responseBodies: true,
          token_state: "present_hidden_from_renderer",
        }),
      ],
      export_metadata: {
        raw_bodies_included: false,
        audit_chain_verified: false,
      },
    });
    expect(json.activity[0]).toMatchObject({
      chain_index: 0,
      previous_event_hash: "sha256:genesis",
    });
    expect(json.activity[0].event_hash).toMatch(/^sha256:/);
    expect(json.export_metadata.audit_chain_head).toBe(json.activity[0].event_hash);
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("postgres://user:pass");
    expect(serialized).not.toContain("raw-preview-token");
    expect(mocks.cloudState).toHaveBeenCalledWith("acct_live");
  });

  it("maps live loopback daemon status without exposing preview tokens", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://127.0.0.1:49152";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    const fetchMock = vi.fn(async (url, init) => new Response(JSON.stringify({
      session: {
        session_id: "sess_live",
        account_id: "acct_live",
        org_id: "org_live",
        workspace_id: "wk_live",
        device_fingerprint: "sha256:1111111111111111",
        paused: true,
      },
      workspace: {
        workspace_id: "wk_live",
        display: "Live workspace",
        scanner_version: "scanner-2026.07.05",
      },
      ports: [
        {
          port: 5173,
          target_host: "127.0.0.1",
          preview_host: "br-local-p5173.vectant-preview.dev",
          process_identity_hash: "sha256:process",
          browser_preview_allowed: true,
          agent_read_allowed: true,
          support_agent_read_allowed: true,
          send_response_body_allowed: true,
          preview_token: "raw-preview-token",
        },
      ],
      history: {
        events: [
          {
            at: "2026-07-09T08:00:00Z",
            class: "Denied",
            summary: "Blocked Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
            previous_hash: "sha256:prev",
            event_hash: "sha256:event",
          },
        ],
        consent_receipts: [
          {
            request_id: "req_sent",
            actor: "support_agent",
            target_display: "server.log",
            classification: "L2",
            content_sha256: "sha256:content",
            capability: "workspace.log.read",
            granted_at: "2026-07-09T08:01:00Z",
          },
        ],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:49152\/v1\/status\/web_/),
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: expect.objectContaining({
          origin: "https://app.vectant.dev",
          "sec-fetch-site": "same-site",
          authorization: "Bearer local_status_bearer_12345678901234567890",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      session: {
        connected: true,
        paused: true,
        session_id: "sess_live",
        account_id: "acct_live",
      },
      workspace: {
        workspace_id: "wk_live",
        display: "Live workspace",
      },
      sent_payloads: [
        expect.objectContaining({
          id: "req_sent",
          actor: "support_agent",
          target: "server.log",
        }),
      ],
      blocked_items: [
        expect.objectContaining({
          bytes_sent: 0,
          reason: "denied_locally",
        }),
      ],
      ports: [
        expect.objectContaining({
          port: 5173,
          aiRead: false,
          supportRead: false,
          responseBodies: false,
          aiInteract: false,
          screenshots: false,
          consoleNetwork: false,
          persistent: false,
          methods: "GET, HEAD only",
          token_state: "present_hidden_from_renderer",
        }),
      ],
    });
    expect(serialized).not.toContain("raw-preview-token");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("rejects configured non-loopback local daemon URLs without fetching them", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL = "http://169.254.169.254/latest/meta-data";
    process.env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER = "local_status_bearer_12345678901234567890";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();
    const json = await response.json();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(json.activity[0]).toMatchObject({
      kind: "Denied",
    });
    expect(json.activity[0].text).toContain("not loopback HTTP");
  });
});
