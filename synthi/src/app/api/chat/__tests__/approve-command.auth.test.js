import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveActor: vi.fn(),
  executeTool: vi.fn(),
}));

vi.mock("@/lib/integrations/session", () => ({
  resolveActor: mocks.resolveActor,
}));

vi.mock("../toolDefinitions.js", () => ({
  executeTool: mocks.executeTool,
}));

vi.mock("../route.js", () => ({
  pendingCommandApprovals: new Map([
    ["live-other-user", { resolve: vi.fn(), userId: "owner-1" }],
  ]),
  deferredCommandsMap: new Map([
    [
      "deferred-other-user",
      { command: "git commit -m test", userId: "owner-1" },
    ],
  ]),
}));

import { POST } from "../route";

describe("approve command authorization", () => {
  beforeEach(() => {
    mocks.resolveActor.mockReset();
    mocks.executeTool.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated callers before resolving or executing commands", async () => {
    mocks.resolveActor.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/chat/approve-command", {
        method: "POST",
        body: JSON.stringify({ id: "deferred-other-user", approved: true }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mocks.executeTool).not.toHaveBeenCalled();
  });

  it("blocks another user's live and deferred approvals", async () => {
    mocks.resolveActor.mockResolvedValue({ userId: "attacker-user" });

    for (const id of ["live-other-user", "deferred-other-user"]) {
      const response = await POST(
        new Request("http://localhost/api/chat/approve-command", {
          method: "POST",
          body: JSON.stringify({ id, approved: true }),
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Forbidden" });
    }

    expect(mocks.executeTool).not.toHaveBeenCalled();
  });
});
