import { afterEach, describe, expect, it } from "vitest";

import { GET } from "./route";

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
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

  it("scrubs secrets and hides preview tokens from renderer state", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON = JSON.stringify({
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
          aiRead: false,
          responseBodies: false,
          token_state: "present_hidden_from_renderer",
        }),
      ],
      export_metadata: {
        raw_bodies_included: false,
        audit_chain_verified: true,
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
  });
});
