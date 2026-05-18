/**
 * Unit tests for the input-lease registry that backs
 * synthi_acquire_input / synthi_release_input.
 *
 * Phase 1 is wire-only — enforcement on the worker is phase 2c. These
 * tests cover the MCP-local bookkeeping only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { eventLog } from "../../src/events/index.js";

beforeEach(() => {
  leaseRegistry._resetForTests();
  // Not strictly needed — event log tests don't assert against the lease tests.
});

describe("leaseRegistry", () => {
  it("acquire returns a lease with unique id + requested duration (clamped)", () => {
    const a = leaseRegistry.acquire(5000, "agent_a");
    const b = leaseRegistry.acquire(5000, "agent_b");
    expect(a.lease_id).not.toBe(b.lease_id);
    expect(a.owner).toBe("agent_a");
    expect(a.lease_ms).toBe(5000);
    expect(a.expires_at - a.acquired_at).toBe(5000);
  });

  it("acquire clamps lease_ms into [50, 15000]", () => {
    const tiny = leaseRegistry.acquire(1, "x");
    expect(tiny.lease_ms).toBe(50);
    const huge = leaseRegistry.acquire(24 * 60 * 60 * 1000, "y");
    expect(huge.lease_ms).toBe(15_000);
  });

  it("leases carry D0 scope and audit fields", () => {
    const lease = leaseRegistry.acquireWithPolicy(5000, "agent_a", {
      scope: ["mouse"],
      preemptible: false,
      reason: "checkout_flow",
    });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire rejection");
    expect(lease.lease.scope).toEqual(["mouse"]);
    expect(lease.lease.preemptible).toBe(false);
    expect(lease.lease.reason).toBe("checkout_flow");
  });

  it("release by id removes only that lease + surfaces not_found for unknown ids", () => {
    const a = leaseRegistry.acquire(5000, "a");
    const b = leaseRegistry.acquire(5000, "b");
    const r1 = leaseRegistry.release(a.lease_id);
    expect(r1).toEqual({ released: [a.lease_id], not_found: null });
    const r2 = leaseRegistry.release("lease_does_not_exist");
    expect(r2.not_found).toBe("lease_does_not_exist");
    expect(leaseRegistry.snapshot().map((l) => l.lease_id)).toEqual([b.lease_id]);
  });

  it("release with no id clears every lease", () => {
    leaseRegistry.acquire(1000, "a");
    leaseRegistry.acquire(1000, "b");
    const r = leaseRegistry.release();
    expect(r.not_found).toBeNull();
    expect(r.released).toHaveLength(2);
    expect(leaseRegistry.snapshot()).toHaveLength(0);
  });

  it("currentLease returns the most-recently-acquired live lease", () => {
    const a = leaseRegistry.acquire(5000, "a");
    const b = leaseRegistry.acquire(5000, "b");
    const current = leaseRegistry.currentLease();
    expect(current?.lease_id).toBe(b.lease_id);
    leaseRegistry.release(b.lease_id);
    expect(leaseRegistry.currentLease()?.lease_id).toBe(a.lease_id);
  });

  it("emits a console event on every acquire + release", () => {
    const before = eventLog.size();
    leaseRegistry.acquire(5000, "x");
    leaseRegistry.release();
    expect(eventLog.size()).toBeGreaterThanOrEqual(before + 2);
  });

  it("renews active leases before expiry", () => {
    const lease = leaseRegistry.acquire(15_000, "x");
    const renewed = leaseRegistry.renew(lease.lease_id, 15_000, lease.acquired_at + 10_000);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) throw new Error("unexpected renewal rejection");
    expect(renewed.lease.expires_at).toBe(lease.acquired_at + 25_000);
    expect(renewed.lease.lease_ms).toBe(15_000);
  });

  it("rejects renewal after expiry", () => {
    const lease = leaseRegistry.acquire(100, "x");
    const renewed = leaseRegistry.renew(lease.lease_id, 15_000, lease.acquired_at + 200);
    expect(renewed.ok).toBe(false);
  });

  it("validates broker input leases by id and scope", () => {
    const lease = leaseRegistry.acquireWithPolicy(5_000, "x", { scope: ["mouse"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected acquire rejection");
    expect(leaseRegistry.validateForBrokerInput(lease.lease.lease_id, "mouse").allowed).toBe(true);
    const blocked = leaseRegistry.validateForBrokerInput(lease.lease.lease_id, "keyboard");
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) throw new Error("unexpected validation success");
    expect(blocked.error).toBe("LEASE_DENIED");
  });

  it("broker enforce mode rejects a second active lease without takeover", () => {
    const prev = process.env["SYNTHI_BROKER_INPUT_MODE"];
    process.env["SYNTHI_BROKER_INPUT_MODE"] = "enforce";
    try {
      const first = leaseRegistry.acquireWithPolicy(5_000, "a");
      expect(first.ok).toBe(true);
      const second = leaseRegistry.acquireWithPolicy(5_000, "b");
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("unexpected second lease");
      expect(second.error).toBe("lease_already_held");
    } finally {
      if (prev === undefined) delete process.env["SYNTHI_BROKER_INPUT_MODE"];
      else process.env["SYNTHI_BROKER_INPUT_MODE"] = prev;
    }
  });
});
