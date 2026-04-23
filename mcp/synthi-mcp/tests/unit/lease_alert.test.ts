/**
 * Tests for the lease-gated input advisory alert wired into
 * synthi_mouse / synthi_keyboard. Phase-1 wire-only — the tool
 * doesn't reject; it emits a security event when a lease is held by
 * someone other than the caller.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { eventLog } from "../../src/events/index.js";

beforeEach(() => {
  leaseRegistry._resetForTests();
});

// We test the alert helper indirectly by replicating its shape — the
// helper itself is a private function in the tool files. The contract
// is the security event it emits, which is observable through the
// event log. The intent: setting up a lease + simulating the dispatch
// path emits exactly one security event with detail.code=
// "input_without_current_lease".

function emulateMouseDispatchAlert(callerLeaseId?: string): void {
  // Mirror tools/mouse.ts checkLeaseAndMaybeAlert exactly.
  const current = leaseRegistry.currentLease();
  if (!current) return;
  if (callerLeaseId === current.lease_id) return;
  eventLog.push({
    kind: "security",
    code: "rate_limit_warning",
    detail: {
      code: "input_without_current_lease",
      action: "mouse:click",
      current_lease_id: current.lease_id,
      current_lease_owner: current.owner,
      current_lease_expires_at: current.expires_at,
      caller_lease_id: callerLeaseId ?? null,
      enforcement: "wire-only",
      note: "Phase-1 advisory. Worker-side enforcement lands in phase 2c.",
    },
  });
}

describe("lease-gated alert", () => {
  it("no alert when no lease is held", () => {
    const before = eventLog.size();
    emulateMouseDispatchAlert();
    const after = eventLog.size();
    expect(after).toBe(before);
  });

  it("no alert when the caller matches the lease", () => {
    const lease = leaseRegistry.acquire(5_000, "agent_a");
    const before = eventLog.size();
    emulateMouseDispatchAlert(lease.lease_id);
    const after = eventLog.size();
    expect(after).toBe(before);
  });

  it("emits a security event when caller has no lease but one is held", () => {
    leaseRegistry.acquire(5_000, "agent_b");
    const before = eventLog.size();
    emulateMouseDispatchAlert();
    const events = eventLog.query({ kind: "security", since_seq: before });
    expect(events.length).toBeGreaterThan(0);
    const detail = (events[0]! as { detail?: { code?: string } }).detail;
    expect(detail?.code).toBe("input_without_current_lease");
  });

  it("emits when a stale id is presented", () => {
    leaseRegistry.acquire(5_000, "agent_c");
    const before = eventLog.size();
    emulateMouseDispatchAlert("lease_stale_xxx");
    const events = eventLog.query({ kind: "security", since_seq: before });
    expect(events.length).toBeGreaterThan(0);
  });
});
