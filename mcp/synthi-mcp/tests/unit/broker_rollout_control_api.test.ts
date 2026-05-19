import { beforeEach, describe, expect, it } from "vitest";
import {
  BrokerControlPlane,
  BrokerRolloutController,
  brokerAuditLog,
  brokerFallbackController,
} from "../../src/broker/index.js";
import type { BrokerPrincipal } from "../../src/broker/auth.js";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { EventLog } from "../../src/events/log.js";

const inputPrincipal: BrokerPrincipal = {
  subject: "agent",
  role: "input_control",
  tenant_id: "tenant",
  session_ids: ["s1"],
};

const adminPrincipal: BrokerPrincipal = {
  ...inputPrincipal,
  subject: "admin",
  role: "admin",
};

const otherInputPrincipal: BrokerPrincipal = {
  ...inputPrincipal,
  subject: "other-agent",
};

describe("broker rollout controls", () => {
  beforeEach(() => {
    brokerAuditLog._resetForTests();
    brokerFallbackController.clear();
  });

  it("routes read-only and input operations according to per-session mode", () => {
    const rollout = new BrokerRolloutController();
    rollout.setSessionMode({
      session_id: "s1",
      mode: "broker_read_only",
      reason: "canary",
      updated_by: "operator",
    });
    expect(rollout.shouldRoute("s1", "screenshot")).toMatchObject({ broker: true, shadow: false });
    expect(rollout.shouldRoute("s1", "input")).toMatchObject({ broker: false, shadow: false });

    rollout.setSessionMode({
      session_id: "s1",
      mode: "shadow",
      reason: "dual_read",
      updated_by: "operator",
    });
    expect(rollout.shouldRoute("s1", "screenshot")).toMatchObject({ broker: false, shadow: true });
  });

  it("records dual-read parity for broker canaries", () => {
    const rollout = new BrokerRolloutController();
    const match = rollout.recordDualReadComparison({
      session_id: "s1",
      frame_seq: 1,
      direct: "same",
      broker: "same",
      now: 1_000,
    });
    expect(match.matched).toBe(true);
    rollout.recordDualReadComparison({
      session_id: "s1",
      frame_seq: 2,
      direct: "direct",
      broker: "broker",
      now: 1_001,
    });
    expect(rollout.dualReadHealth("s1")).toMatchObject({
      comparisons: 2,
      mismatches: 1,
      parity_rate: 0.5,
    });
  });

  it("kill switch moves routing back to direct and applies invariant-safe fallback", () => {
    const rollout = new BrokerRolloutController();
    const result = rollout.killSwitch({
      session_id: "s1",
      reason: "operator_abort",
      operator_id: "operator",
      mode: "input_disabled_fallback",
      now: 1_000,
    });
    expect(result.ok).toBe(true);
    expect(rollout.getSessionState("s1").mode).toBe("input_disabled");
    expect(brokerFallbackController.current("s1")?.mode).toBe("input_disabled_fallback");
  });
});

describe("broker control API lease and fallback contracts", () => {
  beforeEach(() => {
    leaseRegistry._resetForTests();
    brokerFallbackController.clear();
    brokerAuditLog._resetForTests();
  });

  it("acquires leases idempotently and detects idempotency conflicts", () => {
    const control = new BrokerControlPlane(new EventLog());
    const first = control.acquireLease({
      principal: inputPrincipal,
      session_id: "s1",
      scope: ["mouse"],
      idempotency_key: "k1",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unexpected acquire failure");

    const replay = control.acquireLease({
      principal: inputPrincipal,
      session_id: "s1",
      scope: ["mouse"],
      idempotency_key: "k1",
    });
    expect(replay).toEqual(first);

    const conflict = control.acquireLease({
      principal: inputPrincipal,
      session_id: "s1",
      scope: ["keyboard"],
      idempotency_key: "k1",
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("unexpected conflict success");
    expect(conflict.error.error).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("replays denied lease acquisition without duplicate queue entries", () => {
    const prev = process.env["SYNTHI_BROKER_INPUT_MODE"];
    process.env["SYNTHI_BROKER_INPUT_MODE"] = "enforce";
    try {
      const control = new BrokerControlPlane(new EventLog());
      const first = control.acquireLease({
        principal: inputPrincipal,
        session_id: "s1",
        scope: ["mouse"],
        idempotency_key: "holder",
      });
      expect(first.ok).toBe(true);

      const denied = control.acquireLease({
        principal: otherInputPrincipal,
        session_id: "s1",
        scope: ["keyboard"],
        idempotency_key: "contender",
      });
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unexpected acquire success");
      expect(denied.error.error).toBe("LEASE_DENIED");
      expect(leaseRegistry.queueSnapshot()).toHaveLength(1);

      const replay = control.acquireLease({
        principal: otherInputPrincipal,
        session_id: "s1",
        scope: ["keyboard"],
        idempotency_key: "contender",
      });
      expect(replay).toEqual(denied);
      expect(leaseRegistry.queueSnapshot()).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env["SYNTHI_BROKER_INPUT_MODE"];
      else process.env["SYNTHI_BROKER_INPUT_MODE"] = prev;
    }
  });

  it("renews, releases, and force releases through the control API", () => {
    const control = new BrokerControlPlane(new EventLog());
    const lease = control.acquireLease({
      principal: inputPrincipal,
      session_id: "s1",
      scope: ["keyboard"],
      idempotency_key: "k1",
    });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire failure");

    const renewed = control.renewLease({
      principal: inputPrincipal,
      lease_id: lease.lease_id,
      extend_ms: 1_000,
      idempotency_key: "k2",
    });
    expect(renewed.ok).toBe(true);

    const released = control.releaseLease({
      principal: inputPrincipal,
      lease_id: lease.lease_id,
      idempotency_key: "k3",
    });
    expect(released).toMatchObject({ ok: true, released: true });

    const second = control.acquireLease({
      principal: inputPrincipal,
      session_id: "s1",
      scope: ["keyboard"],
      idempotency_key: "k4",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unexpected second acquire failure");
    const forced = control.forceReleaseLease({
      principal: adminPrincipal,
      lease_id: second.lease_id,
      reason: "human_takeover",
    });
    expect(forced.ok).toBe(true);
  });

  it("rejects renew and release attempts from non-owner principals", () => {
    const control = new BrokerControlPlane(new EventLog());
    const lease = control.acquireLease({
      principal: inputPrincipal,
      session_id: "s1",
      scope: ["keyboard"],
      idempotency_key: "k1",
    });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire failure");

    const renewedByOther = control.renewLease({
      principal: otherInputPrincipal,
      lease_id: lease.lease_id,
      extend_ms: 1_000,
      idempotency_key: "k2",
    });
    expect(renewedByOther.ok).toBe(false);
    if (renewedByOther.ok) throw new Error("unexpected renew success");
    expect(renewedByOther.error.error).toBe("FORBIDDEN");
    expect(renewedByOther.error.detail?.["reason"]).toBe("lease_owner_mismatch");

    const releasedByOther = control.releaseLease({
      principal: otherInputPrincipal,
      lease_id: lease.lease_id,
      idempotency_key: "k3",
    });
    expect(releasedByOther.ok).toBe(false);
    if (releasedByOther.ok) throw new Error("unexpected release success");
    expect(releasedByOther.error.error).toBe("FORBIDDEN");
    expect(leaseRegistry.snapshot().some((entry) => entry.lease_id === lease.lease_id)).toBe(true);
  });

  it("requires admin role for fallback controls", () => {
    const control = new BrokerControlPlane(new EventLog());
    const blocked = control.fallback({
      principal: inputPrincipal,
      session_id: "s1",
      mode: "input_disabled_fallback",
      reason: "test",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unexpected fallback success");
    expect(blocked.error.error).toBe("FORBIDDEN");

    const allowed = control.fallback({
      principal: adminPrincipal,
      session_id: "s1",
      mode: "input_disabled_fallback",
      reason: "test",
    });
    expect(allowed.ok).toBe(true);
  });
});
