import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), take: vi.fn() }));
vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/app/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/local-support/relayPayloadStore", () => ({ takeApprovedRelayPayload: mocks.take }));

import { POST } from "./route";

function request(body, origin = "https://beta.vectant.dev") {
  return new Request("https://beta.vectant.dev/api/local-support/relay/payload", {
    method: "POST",
    headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

describe("one-time support payload retrieval", () => {
  it("returns an approved payload only to its authenticated account", async () => {
    mocks.session.mockResolvedValue({ user: { id: "acct_123" } });
    mocks.take.mockResolvedValue({
      content: "approved redacted content",
      bytes_sent: 25,
      content_sha256: `sha256:${"11".repeat(32)}`,
      redaction_count: 2,
      scanner_version: "scanner-1",
    });

    const response = await POST(request({
      request_id: "req_12345678",
      session_id: "sess_12345678",
      workspace_id: "wk_12345678",
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.take).toHaveBeenCalledWith(
      "req_12345678",
      "acct_123",
      "sess_12345678",
      "wk_12345678",
    );
    await expect(response.json()).resolves.toMatchObject({
      decision: "payload_delivered",
      content: "approved redacted content",
      raw_body_included: true,
    });
  });

  it("denies cross-origin, unauthenticated, extra-field, and consumed requests", async () => {
    expect((await POST(request({ request_id: "req_12345678" }, "https://evil.example"))).status).toBe(403);

    mocks.session.mockResolvedValueOnce(null);
    expect((await POST(request({
      request_id: "req_12345678",
      session_id: "sess_12345678",
      workspace_id: "wk_12345678",
    }))).status).toBe(401);

    mocks.session.mockResolvedValue({ user: { id: "acct_123" } });
    expect((await POST(request({
      request_id: "req_12345678",
      session_id: "sess_12345678",
      workspace_id: "wk_12345678",
      include_raw_log: true,
    }))).status).toBe(400);

    mocks.take.mockResolvedValueOnce(null);
    expect((await POST(request({
      request_id: "req_12345678",
      session_id: "sess_12345678",
      workspace_id: "wk_12345678",
    }))).status).toBe(404);
  });
});
