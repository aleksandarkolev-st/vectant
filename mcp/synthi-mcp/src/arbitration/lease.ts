/**
 * Input lease registry — phase-1 wire-only (ultraplan §Arbitration wire).
 *
 * Phase-1 behavior:
 *   - `acquire` mints a lease_id, records the holder, and returns expiry.
 *     Concurrent callers on the same session get distinct leases; nothing
 *     blocks because enforcement is phase-2c (worker-side input gating).
 *   - `release` is idempotent; releasing an unknown/expired id returns
 *     `lease_not_found`.
 *   - `currentLease()` returns the highest-priority live lease (most
 *     recently acquired, not expired), or null.
 *
 * Records a `lifecycle`-kind console event so operators can trace who
 * held input authority at any moment. Enforcement is phase 2 per
 * `AGENT_MCP_REMAINING_WORK.md §2.1`.
 */

import { randomUUID } from "node:crypto";
import { eventLog } from "../events/index.js";

export interface InputLease {
  lease_id: string;
  acquired_at: number;
  expires_at: number;
  lease_ms: number;
  owner: string;
}

const MIN_LEASE_MS = 50;
const MAX_LEASE_MS = 10 * 60 * 1000; // 10 min

class LeaseRegistry {
  private active = new Map<string, InputLease>();
  // Monotonic counter serves as a tiebreaker when two leases are
  // acquired within the same millisecond — Date.now() coarse-grained
  // timing would otherwise make `currentLease()` pick arbitrarily.
  private acquireCounter = 0;
  private acquireOrder = new Map<string, number>();

  acquire(lease_ms: number, owner: string = "mcp_agent"): InputLease {
    const ms = Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(lease_ms)));
    const lease: InputLease = {
      lease_id: `lease_${randomUUID()}`,
      acquired_at: Date.now(),
      expires_at: Date.now() + ms,
      lease_ms: ms,
      owner,
    };
    this.acquireOrder.set(lease.lease_id, ++this.acquireCounter);
    this.active.set(lease.lease_id, lease);
    eventLog.push({
      kind: "console",
      level: "info",
      message: `[input_lease] acquired lease_id=${lease.lease_id} ms=${ms} owner=${owner}`,
      source: "mcp_internal",
    });
    return lease;
  }

  release(lease_id?: string): { released: string[]; not_found: string | null } {
    if (lease_id === undefined) {
      const ids = Array.from(this.active.keys());
      this.active.clear();
      this.acquireOrder.clear();
      if (ids.length > 0) {
        eventLog.push({
          kind: "console",
          level: "info",
          message: `[input_lease] released_all count=${ids.length}`,
          source: "mcp_internal",
        });
      }
      return { released: ids, not_found: null };
    }
    if (!this.active.has(lease_id)) {
      return { released: [], not_found: lease_id };
    }
    this.active.delete(lease_id);
    this.acquireOrder.delete(lease_id);
    eventLog.push({
      kind: "console",
      level: "info",
      message: `[input_lease] released lease_id=${lease_id}`,
      source: "mcp_internal",
    });
    return { released: [lease_id], not_found: null };
  }

  currentLease(): InputLease | null {
    this.evictExpired();
    let best: InputLease | null = null;
    let bestOrder = -1;
    for (const lease of this.active.values()) {
      const order = this.acquireOrder.get(lease.lease_id) ?? 0;
      if (!best || order > bestOrder) {
        best = lease;
        bestOrder = order;
      }
    }
    return best;
  }

  snapshot(): InputLease[] {
    this.evictExpired();
    return Array.from(this.active.values());
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, lease] of this.active) {
      if (lease.expires_at <= now) {
        this.active.delete(id);
        this.acquireOrder.delete(id);
      }
    }
  }

  _resetForTests(): void {
    this.active.clear();
    this.acquireOrder.clear();
    this.acquireCounter = 0;
  }
}

export const leaseRegistry = new LeaseRegistry();
