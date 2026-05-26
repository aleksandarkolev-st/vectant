import { beforeEach, describe, expect, it, vi } from "vitest";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { eventLog } from "../../src/events/index.js";
import { locateEngine } from "../../src/locate/index.js";
import { session } from "../../src/session.js";
import { mouseTool } from "../../src/tools/mouse.js";
import { keyboardTool } from "../../src/tools/keyboard.js";
import { releaseInputTool } from "../../src/tools/release_input.js";
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

function installFakeAttached(
  frame: { seq: number; ts: number; dpr?: number | null } = { seq: 10, ts: Date.now(), dpr: 1 },
  opts: { sharedLease?: "local" | "missing" | "deny" } = {}
): { sent: string[] } {
  const dpr = frame.dpr === null ? undefined : frame.dpr ?? 1;
  const sent: string[] = [];
  const channels: Record<string, unknown> = {
    sendInput: async (frames: string[]) => {
      sent.push(...frames);
    },
  };
  if (opts.sharedLease !== "missing") {
    channels["requestInputLease"] = async (payload: Record<string, unknown>) => {
      const op = payload["op"];
      const leaseId = typeof payload["lease_id"] === "string" ? payload["lease_id"] : undefined;
      const scope = Array.isArray(payload["scope"]) && payload["scope"][0] === "keyboard" ? "keyboard" : "mouse";
      if (opts.sharedLease === "deny") return { ok: false, error: "LEASE_DENIED", reason: "held_by_other_peer" };
      if (op !== "validate") return { ok: false, error: "LEASE_DENIED" };
      const validation = leaseRegistry.validateForBrokerInput(leaseId, scope, Date.now(), "fake");
      if (!validation.allowed) return { ok: false, error: validation.error, ...validation.detail };
      return { ok: true, lease_id: validation.lease.lease_id, lease: validation.lease };
    };
  }
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 800, height: 600, ...(dpr === undefined ? {} : { dpr }) },
    frames: {
      getFrame: async () => ({ data: Buffer.alloc(0), width: 800, height: 600, ...(dpr === undefined ? {} : { dpr }), ts: frame.ts, seq: frame.seq }),
      hasFrame: () => true,
      dimensions: () => ({ width: 800, height: 600, ...(dpr === undefined ? {} : { dpr }) }),
    },
    channels,
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

  it("fails closed when shared session lease authority is unavailable", async () => withBrokerInputEnforced(async () => {
    const { sent } = installFakeAttached({ seq: 10, ts: Date.now() }, { sharedLease: "missing" });
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

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string; reason?: string }).error).toBe("LEASE_DENIED");
    expect((res.structuredContent as { reason?: string }).reason).toBe("shared_session_lease_authority_unavailable");
    expect(sent).toHaveLength(0);
  }));

  it("honors shared-authority denial even when the local lease matches", async () => withBrokerInputEnforced(async () => {
    const { sent } = installFakeAttached({ seq: 10, ts: Date.now() }, { sharedLease: "deny" });
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

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string; reason?: string }).error).toBe("LEASE_DENIED");
    expect((res.structuredContent as { reason?: string }).reason).toBe("held_by_other_peer");
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
      based_on_viewport: { w: 800, h: 600, dpr: 1 },
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

  it("rejects input when viewport dimensions changed", async () => withBrokerInputEnforced(async () => {
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
      based_on_viewport: { w: 1024, h: 600, dpr: 1 },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string; reason?: string }).error).toBe("FRAME_STALE");
    expect((res.structuredContent as { reason?: string }).reason).toBe("viewport_changed");
    expect(sent).toHaveLength(0);
  }));

  it("rejects input when producer DPR changed", async () => withBrokerInputEnforced(async () => {
    const { sent } = installFakeAttached({ seq: 10, ts: Date.now(), dpr: 2 });
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire rejection");
    const res = await mouseTool({
      action: "click",
      x: 10,
      y: 10,
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 10,
      based_on_viewport: { w: 800, h: 600, dpr: 1 },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string; reason?: string }).error).toBe("FRAME_STALE");
    expect((res.structuredContent as { reason?: string }).reason).toBe("viewport_changed");
    expect((res.structuredContent as { frame_viewport?: { dpr?: number } }).frame_viewport?.dpr).toBe(2);
    expect(sent).toHaveLength(0);
  }));

  it("rejects viewport freshness when producer DPR is unavailable", async () => withBrokerInputEnforced(async () => {
    const { sent } = installFakeAttached({ seq: 10, ts: Date.now(), dpr: null });
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire rejection");
    const res = await mouseTool({
      action: "click",
      x: 10,
      y: 10,
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 10,
      based_on_viewport: { w: 800, h: 600, dpr: 1 },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string; reason?: string }).error).toBe("FRAME_STALE");
    expect((res.structuredContent as { reason?: string }).reason).toBe("producer_dpr_unavailable");
    expect(sent).toHaveLength(0);
  }));

  it("gates handle-based mouse actions before locator resolution", async () => withBrokerInputEnforced(async () => {
    const { sent } = installFakeAttached({ seq: 10, ts: Date.now() });
    const resolveSpy = vi.spyOn(locateEngine, "resolve");
    try {
      const res = await mouseTool({
        action: "click",
        handle: { handle_id: "h_1" },
        based_on_frame_seq: 10,
      });
      expect(res.isError).toBe(true);
      expect((res.structuredContent as { error: string }).error).toBe("LEASE_REQUIRED");
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(sent).toHaveLength(0);
    } finally {
      resolveSpy.mockRestore();
    }
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

  it("rejects release-all in broker-enforced mode", async () => withBrokerInputEnforced(async () => {
    installFakeAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    const res = await releaseInputTool({});
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string; detail?: { reason?: string } }).error).toBe("FORBIDDEN");
    expect((res.structuredContent as { detail?: { reason?: string } }).detail?.reason).toBe("release_all_disabled_in_enforce_mode");
    expect(leaseRegistry.snapshot()).toHaveLength(1);
  }));
});
