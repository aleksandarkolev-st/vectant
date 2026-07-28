import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(async () => ({ user: { id: "acct_1" } })),
  findFirst: vi.fn(),
  enqueue: vi.fn(async () => undefined),
  readPolicy: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/app/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({ default: { localSupportSession: { findFirst: mocks.findFirst } } }));
vi.mock("@/lib/local-support/relayStore", () => ({ enqueueRelayRequest: mocks.enqueue }));
vi.mock("@/lib/local-support/policyStore", () => ({ readDurableLocalSupportPolicy: mocks.readPolicy }));

function request() {
  return new Request("http://localhost:3000/api/local-support/test-request", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
  });
}

const paired = {
  sessionId: "sess_1",
  accountId: "acct_1",
  orgId: "org_1",
  workspaceId: "workspace_1",
  deviceFingerprint: "device_1",
  appVersion: "1.0.0",
  protocolVersion: "1",
  policyVersion: "policy-1",
};

describe("local support test request route", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.session.mockReset();
    mocks.session.mockResolvedValue({ user: { id: "acct_1" } });
    mocks.findFirst.mockReset();
    mocks.enqueue.mockReset();
    mocks.enqueue.mockResolvedValue(undefined);
    mocks.readPolicy.mockReset();
    mocks.readPolicy.mockResolvedValue({ enabled: true });
  });

  it("blocks a connected account when its organization policy is disabled", async () => {
    vi.stubEnv("VECTANT_LOCAL_SUPPORT_TEST_REQUESTS", "true");
    mocks.findFirst.mockResolvedValue(paired);
    mocks.readPolicy.mockResolvedValue({ enabled: false });
    const { POST } = await import("./route");

    const response = await POST(request());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ decision: "denied", reason: "feature_disabled", bytes_sent: 0 });
    expect(mocks.readPolicy).toHaveBeenCalledWith(expect.anything(), undefined, "org_1");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("queues a safe test request for the paired organization", async () => {
    vi.stubEnv("VECTANT_LOCAL_SUPPORT_TEST_REQUESTS", "true");
    mocks.findFirst.mockResolvedValue(paired);
    const { POST } = await import("./route");

    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({ decision: "test_request_queued", target_display: "package.json", bytes_sent: 0 });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: "org_1", session_id: "sess_1" }),
      expect.objectContaining({ org_id: "org_1", target_display: "package.json" }),
    );
  });
});
