import { beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { dispatchAckRegistry } from "../../src/util/dispatch_ack_registry.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { dispatchInputTool } from "../../src/tools/dispatch_input.js";

interface FakeSendOptions {
  onFrameSent?: (frame: string) => void;
}

interface FakeFrameColor {
  r: number;
  g: number;
  b: number;
}

async function pngForColor(color: FakeFrameColor): Promise<Buffer> {
  return sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: color,
    },
  }).png().toBuffer();
}

async function installFakeAttached(opts: { interFrameDelayMs?: number; frameColors?: FakeFrameColor[] } = {}): Promise<{ sent: string[] }> {
  const colors = opts.frameColors && opts.frameColors.length > 0
    ? opts.frameColors
    : [{ r: 9, g: 8, b: 7 }];
  const pngs = await Promise.all(colors.map((color) => pngForColor(color)));
  let frameReads = 0;
  const sent: string[] = [];
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "s_1",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 4, height: 4 },
    frames: {
      getFrame: async () => {
        const data = pngs[Math.min(frameReads, pngs.length - 1)]!;
        frameReads += 1;
        return { data, width: 4, height: 4, ts: Date.now(), seq: 3 };
      },
      hasFrame: () => true,
      dimensions: () => ({ width: 4, height: 4 }),
    },
    channels: {
      requestInputLease: async (payload: Record<string, unknown>) => {
        const op = payload["op"];
        const leaseId = typeof payload["lease_id"] === "string" ? payload["lease_id"] : undefined;
        const scope = Array.isArray(payload["scope"]) && payload["scope"][0] === "mouse" ? "mouse" : "keyboard";
        if (op !== "validate") return { ok: false, error: "LEASE_DENIED" };
        const validation = leaseRegistry.validateForBrokerInput(leaseId, scope, Date.now(), "s_1");
        if (!validation.allowed) return { ok: false, error: validation.error, ...validation.detail };
        return { ok: true, lease_id: validation.lease.lease_id, lease: validation.lease };
      },
      sendInput: async (frames: string[], sendOpts?: FakeSendOptions) => {
        sent.push(...frames);
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i]!;
          sendOpts?.onFrameSent?.(frame);
          const parsed = JSON.parse(frame) as { dispatch_id?: string };
          if (parsed.dispatch_id) {
            dispatchAckRegistry.resolveAck({ dispatch_id: parsed.dispatch_id, accepted: true });
          }
          if (opts.interFrameDelayMs && i < frames.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, opts.interFrameDelayMs));
          }
        }
      },
    },
  };
  return { sent };
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

  it("reuses the session disruption gate before sending input", async () => withBrokerInputEnforced(async () => {
    const { sent } = await installFakeAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");
    session.setWireState("migrating");

    const res = await dispatchInputTool({
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
      action: { tool: "synthi_mouse", kind: "click", x: 1, y: 1 },
    });

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("session_migrating");
    expect(sent).toHaveLength(0);
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

  it("waits up to the timeout for pixel postconditions", async () => withBrokerInputEnforced(async () => {
    await installFakeAttached({
      frameColors: [
        { r: 9, g: 8, b: 7 },
        { r: 1, g: 1, b: 1 },
        { r: 9, g: 8, b: 7 },
      ],
    });
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["keyboard"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");
    const res = await dispatchInputTool({
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
      action: { tool: "synthi_keyboard", kind: "key", key: "Enter" },
      postcondition: { type: "pixel_match", x: 0, y: 0, expected_rgb: [9, 8, 7] },
      timeout_ms: 100,
    });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { effect_verified: { verified: boolean } };
    expect(body.effect_verified.verified).toBe(true);
  }));

  it("starts ack timers when each queued typing frame is sent", async () => withBrokerInputEnforced(async () => {
    await installFakeAttached({ interFrameDelayMs: 15 });
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["keyboard"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");
    const res = await dispatchInputTool({
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
      action: { tool: "synthi_keyboard", kind: "type", text: "ab" },
      timeout_ms: 5,
    });
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { unverified?: boolean };
    expect(body.unverified).toBe(true);
  }));

  it("returns a normalized error for invalid regex postconditions", async () => withBrokerInputEnforced(async () => {
    await installFakeAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["keyboard"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");
    const res = await dispatchInputTool({
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 3,
      action: { tool: "synthi_keyboard", kind: "key", key: "Enter" },
      postcondition: { type: "event_log", pattern: "(" },
      timeout_ms: 10,
    });
    expect(res.isError).toBe(true);
    const body = res.structuredContent as { error: string; detail?: { evidence?: { reason?: string } } };
    expect(body.error).toBe("UNSUPPORTED_POSTCONDITION_TYPE");
    expect(body.detail?.evidence?.reason).toBe("invalid_regex");
  }));
});
