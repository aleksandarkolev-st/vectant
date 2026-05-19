import { beforeEach, describe, expect, it } from "vitest";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { mouseTool } from "../../src/tools/mouse.js";
import { keyboardTool } from "../../src/tools/keyboard.js";
import {
  brokerFallbackController,
  brokerRolloutController,
} from "../../src/broker/index.js";

function withBrokerInputEnforced<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env["SYNTHI_BROKER_INPUT_MODE"];
  process.env["SYNTHI_BROKER_INPUT_MODE"] = "enforce";
  return fn().finally(() => {
    if (prev === undefined) delete process.env["SYNTHI_BROKER_INPUT_MODE"];
    else process.env["SYNTHI_BROKER_INPUT_MODE"] = prev;
  });
}

function installFakeAttached(frame: { seq: number; ts: number } = { seq: 10, ts: Date.now() }): { sent: string[] } {
  const sent: string[] = [];
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 800, height: 600 },
    frames: {
      getFrame: async () => ({ data: Buffer.alloc(0), width: 800, height: 600, ts: frame.ts, seq: frame.seq }),
      hasFrame: () => true,
      dimensions: () => ({ width: 800, height: 600 }),
    },
    channels: {
      sendInput: async (frames: string[]) => {
        sent.push(...frames);
      },
    },
  };
  return { sent };
}

describe("broker-enforced input gate", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    leaseRegistry._resetForTests();
    brokerFallbackController.clear();
    brokerRolloutController.clear();
  });

  it("requires a lease before mouse dispatch", async () => withBrokerInputEnforced(async () => {
    const { sent } = installFakeAttached();
    const res = await mouseTool({ action: "click", x: 10, y: 10, based_on_frame_seq: 10 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("LEASE_REQUIRED");
    expect(sent).toHaveLength(0);
  }));

  it("dispatches with a matching lease and fresh frame seq", async () => withBrokerInputEnforced(async () => {
    const { sent } = installFakeAttached({ seq: 10, ts: Date.now() });
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire rejection");
    const res = await mouseTool({
      action: "click",
      x: 10,
      y: 10,
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 10,
    });
    expect(res.isError).toBeUndefined();
    expect(sent).toHaveLength(2);
  }));

  it("blocks dispatch when input-disabled fallback is active", async () => {
    const { sent } = installFakeAttached();
    const fallback = brokerFallbackController.apply({
      session_id: "fake",
      mode: "input_disabled_fallback",
      reason: "canary rollback",
      operator_id: "admin",
    });
    expect(fallback.ok).toBe(true);

    const res = await mouseTool({ action: "click", x: 10, y: 10, based_on_frame_seq: 10 });

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string; reason?: string }).error).toBe("FORBIDDEN");
    expect((res.structuredContent as { reason?: string }).reason).toBe("input_disabled");
    expect(sent).toHaveLength(0);
  });

  it("rejects input based on a stale frame seq", async () => withBrokerInputEnforced(async () => {
    const { sent } = installFakeAttached({ seq: 10, ts: Date.now() });
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire rejection");
    const res = await mouseTool({
      action: "click",
      x: 10,
      y: 10,
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 7,
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("FRAME_STALE");
    expect(sent).toHaveLength(0);
  }));

  it("rejects keyboard input when the lease lacks keyboard scope", async () => withBrokerInputEnforced(async () => {
    installFakeAttached({ seq: 3, ts: Date.now() });
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire rejection");
    const res = await keyboardTool({
      action: "key",
      key: "Enter",
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("LEASE_DENIED");
  }));

  it("rejects frames older than the input freshness window", async () => withBrokerInputEnforced(async () => {
    installFakeAttached({ seq: 3, ts: Date.now() - 1_000 });
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["keyboard"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire rejection");
    const res = await keyboardTool({
      action: "key",
      key: "Enter",
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("FRAME_STALE");
  }));
});
