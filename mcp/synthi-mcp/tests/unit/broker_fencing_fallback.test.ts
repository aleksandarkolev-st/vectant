import { beforeEach, describe, expect, it } from "vitest";
import {
  brokerFallbackController,
  brokerRuntime,
  producerFenceRegistry,
} from "../../src/broker/index.js";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { mouseTool } from "../../src/tools/mouse.js";

function installFakeAttached(): void {
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "s_1",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 100, height: 100 },
    frames: {
      getFrame: async () => ({ data: Buffer.alloc(0), width: 100, height: 100, ts: Date.now(), seq: 1 }),
      hasFrame: () => true,
      dimensions: () => ({ width: 100, height: 100 }),
    },
    channels: { sendInput: async () => {} },
  };
}

function withBrokerInputEnforced<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env["SYNTHI_BROKER_INPUT_MODE"];
  process.env["SYNTHI_BROKER_INPUT_MODE"] = "enforce";
  return fn().finally(() => {
    if (prev === undefined) delete process.env["SYNTHI_BROKER_INPUT_MODE"];
    else process.env["SYNTHI_BROKER_INPUT_MODE"] = prev;
  });
}

describe("producer fencing", () => {
  beforeEach(() => {
    producerFenceRegistry.clear();
    eventLog._resetForTests();
  });

  it("rejects a duplicate producer until teardown is confirmed", () => {
    const first = producerFenceRegistry.attach("s_1", "producer_a");
    expect(first.ok).toBe(true);
    const second = producerFenceRegistry.attach("s_1", "producer_b");
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unexpected duplicate producer");
    expect(second.error.error).toBe("DUPLICATE_PRODUCER_REJECTED");
    producerFenceRegistry.confirmTeardown("s_1", "producer_a");
    const third = producerFenceRegistry.attach("s_1", "producer_b");
    expect(third.ok).toBe(true);
    if (!third.ok || !first.ok) throw new Error("unexpected producer grant failure");
    expect(third.grant.producer_epoch).toBe(first.grant.producer_epoch + 1);
  });

  it("rejects stale producer writes", () => {
    const first = producerFenceRegistry.attach("s_1", "producer_a");
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unexpected producer failure");
    const stale = producerFenceRegistry.validateWrite("s_1", {
      producer_id: "producer_a",
      producer_epoch: first.grant.producer_epoch,
      fencing_token: "wrong",
    });
    expect(stale.ok).toBe(false);
  });
});

describe("fallback controls", () => {
  beforeEach(() => {
    producerFenceRegistry.clear();
    brokerFallbackController.clear();
    eventLog._resetForTests();
  });

  it("blocks full direct attach until producer teardown is confirmed", () => {
    producerFenceRegistry.attach("s_1", "producer_a");
    const blocked = brokerFallbackController.apply({
      session_id: "s_1",
      mode: "full_direct_attach",
      reason: "operator rollback",
      operator_id: "admin",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unexpected fallback success");
    expect(blocked.error.error).toBe("FORBIDDEN");
  });

  it("allows invariant-safe fallback modes immediately", () => {
    producerFenceRegistry.attach("s_1", "producer_a");
    const result = brokerFallbackController.apply({
      session_id: "s_1",
      mode: "input_disabled_fallback",
      reason: "canary failure",
      operator_id: "admin",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected fallback failure");
    expect(result.applied_mode).toBe("input_disabled_fallback");
    expect(brokerFallbackController.current("s_1")?.reason).toBe("canary failure");
  });
});

describe("broker recovery", () => {
  beforeEach(() => {
    brokerRuntime._resetForTests();
    brokerFallbackController.clear();
    leaseRegistry._resetForTests();
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("invalidates leases and fails closed while recovering", async () => withBrokerInputEnforced(async () => {
    installFakeAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    brokerRuntime.enterRecovering("restart");
    expect(leaseRegistry.snapshot()).toHaveLength(0);
    if (!lease.ok) throw new Error("unexpected acquire failure");
    const res = await mouseTool({
      action: "click",
      x: 1,
      y: 1,
      lease_id: lease.lease.lease_id,
      based_on_frame_seq: 1,
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("BROKER_RECOVERING");
  }));

  it("drops queued lease requests during recovery", async () => withBrokerInputEnforced(async () => {
    const active = leaseRegistry.acquireWithPolicy(5_000, "agent_a", { scope: ["mouse"] });
    expect(active.ok).toBe(true);
    const queued = leaseRegistry.acquireWithPolicy(5_000, "agent_b", { scope: ["keyboard"] });
    expect(queued.ok).toBe(false);
    expect(leaseRegistry.queueSnapshot()).toHaveLength(1);

    brokerRuntime.enterRecovering("restart");
    brokerRuntime.markReady();

    expect(leaseRegistry.snapshot()).toHaveLength(0);
    expect(leaseRegistry.queueSnapshot()).toHaveLength(0);
    expect(leaseRegistry.currentLease()).toBeNull();
  }));

  it("records recovery time when marked ready", () => {
    brokerRuntime.enterRecovering("restart", 1_000);
    const incident = brokerRuntime.markReady(1_500);
    expect(incident?.broker_ready_ts).toBe(1_500);
    expect(brokerRuntime.brokerState()).toBe("ready");
  });
});
