/**
 * Input lease registry — ultraplan §Arbitration wire. Supports two modes:
 *
 *   - `advisory` (default): phase-1 behaviour. Multi-acquire allowed, no
 *     enforcement; input tools emit a security event on lease mismatch
 *     but still dispatch. Tests documenting phase-1 behaviour still pass.
 *   - `single-holder`: phase-2c MCP-local enforcement. A second `acquire`
 *     while a live lease exists fails with `lease_already_held` (unless
 *     the caller passes `takeover: true`). Input tools reject dispatch
 *     with `input_lease_held_by_other` when the caller's lease_id doesn't
 *     match the current holder.
 *
 * Select via `SYNTHI_LEASE_MODE=single-holder`. Worker-side enforcement
 * (the cross-peer gate that would block a separate browser session from
 * bypassing the MCP-local registry) is still a follow-up and requires
 * the worker's `PeerRegistry` to track leases — scaffolded separately.
 *
 * Records a `console`-kind event so operators can trace who held input
 * authority at any moment.
 */

import { randomUUID } from "node:crypto";
import { eventLog } from "../events/index.js";

export type LeaseMode = "advisory" | "single-holder";

export interface InputLease {
  lease_id: string;
  acquired_at: number;
  expires_at: number;
  lease_ms: number;
  owner: string;
}

export interface AcquireResult {
  ok: true;
  lease: InputLease;
  evicted?: InputLease;
}

export interface AcquireRejection {
  ok: false;
  error: "lease_already_held";
  current: InputLease;
}

export interface DispatchAllowed {
  allowed: true;
  current: InputLease | null;
}

export interface DispatchBlocked {
  allowed: false;
  error: "input_lease_held_by_other";
  current: InputLease;
}

const MIN_LEASE_MS = 50;
const MAX_LEASE_MS = 10 * 60 * 1000; // 10 min

export function resolveLeaseMode(): LeaseMode {
  const raw = process.env["SYNTHI_LEASE_MODE"];
  if (raw === "single-holder") return "single-holder";
  return "advisory";
}

class LeaseRegistry {
  private active = new Map<string, InputLease>();
  // Monotonic counter serves as a tiebreaker when two leases are
  // acquired within the same millisecond — Date.now() coarse-grained
  // timing would otherwise make `currentLease()` pick arbitrarily.
  private acquireCounter = 0;
  private acquireOrder = new Map<string, number>();

  acquire(lease_ms: number, owner: string = "mcp_agent"): InputLease {
    // Advisory-mode backwards-compat shim: unconditionally mint a new
    // lease. Single-holder callers go through `acquireWithPolicy` and
    // surface a rejection envelope instead of silently multi-acquiring.
    return this.mint(lease_ms, owner);
  }

  acquireWithPolicy(
    lease_ms: number,
    owner: string = "mcp_agent",
    opts: { takeover?: boolean } = {}
  ): AcquireResult | AcquireRejection {
    const current = this.currentLease();
    if (resolveLeaseMode() === "single-holder" && current && !opts.takeover) {
      return { ok: false, error: "lease_already_held", current };
    }
    let evicted: InputLease | undefined;
    if (current && opts.takeover) {
      this.active.delete(current.lease_id);
      this.acquireOrder.delete(current.lease_id);
      evicted = current;
      eventLog.push({
        kind: "console",
        level: "info",
        message: `[input_lease] takeover evicted lease_id=${current.lease_id} owner=${current.owner}`,
        source: "mcp_internal",
      });
    }
    const lease = this.mint(lease_ms, owner);
    return evicted ? { ok: true, lease, evicted } : { ok: true, lease };
  }

  enforceDispatch(callerLeaseId: string | undefined): DispatchAllowed | DispatchBlocked {
    if (resolveLeaseMode() !== "single-holder") return { allowed: true, current: this.currentLease() };
    const current = this.currentLease();
    if (!current) return { allowed: true, current: null };
    if (callerLeaseId === current.lease_id) return { allowed: true, current };
    return { allowed: false, error: "input_lease_held_by_other", current };
  }

  private mint(lease_ms: number, owner: string): InputLease {
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
