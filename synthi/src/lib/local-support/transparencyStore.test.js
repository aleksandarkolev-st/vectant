import { describe, expect, it, vi } from "vitest";

import { readCloudTransparencyState } from "./transparencyStore";

describe("cloud-backed transparency state", () => {
  it("derives sent, blocked, and review-pending views from durable records", async () => {
    const createdAt = new Date("2030-01-01T00:00:00.000Z");
    const common = {
      accountId: "acct_1", requestId: "req_sent", actor: "support_agent",
      capability: "workspace.log.read", targetDisplay: "logs/server.log", targetHash: "sha256:target",
      targetClassification: "L3", redactionCount: 2, scannerVersion: "scanner-2",
      bytesSent: 42, logClass: "local_support.data", createdAt,
    };
    const client = {
      localSupportSession: { findFirst: vi.fn(async () => ({
        sessionId: "sess_1", accountId: "acct_1", orgId: "org_1", workspaceId: "wk_1",
        deviceFingerprint: "sha256:1111111111111111",
        approvedPortsJson: JSON.stringify([{
          port: 5173,
          target_host: "127.0.0.1",
          preview_host: "br-local-p5173.vectant-preview.dev",
          process_identity_hash: "sha256:" + "a".repeat(16),
          browser_preview_allowed: true,
          agent_read_allowed: true,
          support_agent_read_allowed: true,
          agent_interact_allowed: true,
          send_response_body_allowed: true,
          send_screenshot_allowed: true,
          send_console_errors_allowed: true,
          state_changing_methods_allowed: true,
          persistent: true,
          expires_at: "2030-01-01T00:30:00.000Z",
        }]),
      })) },
      localSupportCloudAudit: { findMany: vi.fn(async () => [
        { ...common, decision: "sent", reason: "approved_payload_encrypted" },
        { ...common, requestId: "req_denied", decision: "denied", bytesSent: 0, reason: "local_user_denied" },
      ]) },
      localSupportRelayRequest: { findMany: vi.fn(async () => [
        { ...common, status: "sent" },
        { ...common, requestId: "req_review", status: "review_pending" },
        { ...common, requestId: "req_denied", status: "denied" },
      ]) },
    };

    const state = await readCloudTransparencyState("acct_1", client, createdAt);

    expect(state.session).toMatchObject({ connected: true, session_id: "sess_1" });
    expect(state.sent_payloads).toEqual([expect.objectContaining({ request_id: "req_sent", bytes_sent: 42 })]);
    expect(state.blocked_items).toEqual([expect.objectContaining({ reason: "local_user_denied", bytes_sent: 0 })]);
    expect(state.inventory).toContainEqual(expect.objectContaining({
      target: "logs/server.log",
      state: "approval_required",
      bytes_sent: 0,
    }));
    expect(state.ports).toEqual([expect.objectContaining({
      browser: true,
      aiRead: false,
      supportRead: false,
      aiInteract: false,
      responseBodies: false,
      screenshots: false,
      consoleNetwork: false,
      persistent: false,
      methods: "GET, HEAD",
    })]);
    expect(JSON.stringify(state)).not.toContain("content");
  });

  it("returns an empty disconnected state without an authenticated account", async () => {
    await expect(readCloudTransparencyState(null, {})).resolves.toMatchObject({
      session: undefined,
      sent_payloads: [],
      blocked_items: [],
    });
  });
});
