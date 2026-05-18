import { beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { dispatchAckRegistry } from "../../src/util/dispatch_ack_registry.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { dispatchInputTool } from "../../src/tools/dispatch_input.js";

async function installFakeAttached(): Promise<void> {
  const png = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: { r: 9, g: 8, b: 7 },
    },
  }).png().toBuffer();
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "s_1",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 4, height: 4 },
    frames: {
      getFrame: async () => ({ data: png, width: 4, height: 4, ts: Date.now(), seq: 3 }),
      hasFrame: () => true,
      dimensions: () => ({ width: 4, height: 4 }),
    },
    channels: {
      sendInput: async (frames: string[]) => {
        for (const frame of frames) {
          const parsed = JSON.parse(frame) as { dispatch_id?: string };
          if (parsed.dispatch_id) {
            dispatchAckRegistry.resolveAck({ dispatch_id: parsed.dispatch_id, accepted: true });
          }
        }
      },
    },
  };
}

async function withBrokerInputEnforced<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env["SYNTHI_BROKER_INPUT_MODE"];
  process.env["SYNTHI_BROKER_INPUT_MODE"] = "enforce";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env["SYNTHI_BROKER_INPUT_MODE"];
    else process.env["SYNTHI_BROKER_INPUT_MODE"] = prev;
  }
}

describe("synthi_dispatch_input", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    leaseRegistry._resetForTests();
    dispatchAckRegistry._resetForTests();
  });

  it("returns explicit unverified:true without a postcondition and records traceability", async () => withBrokerInputEnforced(async () => {
    await installFakeAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");
    const res = await dispatchInputTool({
      tool_call_id: "tc_1",
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
      action: { tool: "synthi_mouse", kind: "click", x: 1, y: 1 },
    });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { unverified: boolean; ack_chain: unknown };
    expect(body.unverified).toBe(true);
    expect(body.ack_chain).toBeDefined();
    const input = eventLog.query({ kind: "input" })[0] as { payload: Record<string, unknown> };
    expect(input.payload.tool_call_id).toBe("tc_1");
    expect(input.payload.session_id).toBe("s_1");
    expect(input.payload.frame_seq).toBe(3);
    expect(input.payload.lease_id).toBe(lease.lease.lease_id);
  }));

  it("returns UNSUPPORTED_POSTCONDITION_TYPE for unavailable DOM verifier", async () => withBrokerInputEnforced(async () => {
    await installFakeAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["keyboard"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");
    const res = await dispatchInputTool({
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
      action: { tool: "synthi_keyboard", kind: "key", key: "Enter" },
      postcondition: { type: "dom_visible", selector: "[data-testid='counter']" },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("UNSUPPORTED_POSTCONDITION_TYPE");
  }));

  it("verifies supported pixel postconditions", async () => withBrokerInputEnforced(async () => {
    await installFakeAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["keyboard"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");
    const res = await dispatchInputTool({
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
      action: { tool: "synthi_keyboard", kind: "key", key: "Enter" },
      postcondition: { type: "pixel_match", x: 0, y: 0, expected_rgb: [9, 8, 7] },
    });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { effect_verified: { verified: boolean } };
    expect(body.effect_verified.verified).toBe(true);
  }));
});
