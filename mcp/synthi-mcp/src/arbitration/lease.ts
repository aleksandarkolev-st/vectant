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
import type { BrokerErrorCode } from "../broker/errors.js";

export type LeaseMode = "advisory" | "single-holder";
export type LeaseScope = "mouse" | "keyboard";
export type LeasePriority = "normal" | "urgent_human_override";

export interface InputLease {
  lease_id: string;
  acquired_at: number;
  expires_at: number;
  lease_ms: number;
  owner: string;
  scope: LeaseScope[];
  preemptible: boolean;
  priority: LeasePriority;
  reason: string | null;
  continuous_owner_since: number;
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

export interface LeaseValidationAllowed {
  allowed: true;
  lease: InputLease;
}

export interface LeaseValidationBlocked {
  allowed: false;
  error: Extract<BrokerErrorCode, "LEASE_REQUIRED" | "LEASE_EXPIRED" | "LEASE_DENIED" | "LEASE_PREEMPTED">;
  current: InputLease | null;
  detail: Record<string, unknown>;
}

const MIN_LEASE_MS = 50;
export const DEFAULT_LEASE_MS = 15_000;
export const MAX_LEASE_MS = 15_000;
export const MAX_CONTINUOUS_OWNERSHIP_MS = 60_000;

export function resolveLeaseMode(): LeaseMode {
  const raw = process.env["SYNTHI_LEASE_MODE"];
  if (raw === "single-holder") return "single-holder";
  return "advisory";
}

export function resolveLeaseOwner(): string {
  const explicit = process.env["SYNTHI_AGENT_ID"] || process.env["SYNTHI_AGENT_SUBJECT"];
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return "mcp_agent";
}

function normalizeScope(scope: readonly LeaseScope[] | undefined): LeaseScope[] {
  if (!scope || scope.length === 0) return ["mouse", "keyboard"];
  const out: LeaseScope[] = [];
  for (const item of scope) {
    if ((item === "mouse" || item === "keyboard") && !out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out : ["mouse", "keyboard"];
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
    opts: {
      takeover?: boolean;
      scope?: readonly LeaseScope[];
      preemptible?: boolean;
      priority?: LeasePriority;
      reason?: string | null;
    } = {}
  ): AcquireResult | AcquireRejection {
    const current = this.currentLease();
    const singleHolderRequired =
      resolveLeaseMode() === "single-holder" ||
      process.env["SYNTHI_BROKER_INPUT_MODE"] === "enforce";
    if (singleHolderRequired && current && !opts.takeover) {
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
    const lease = this.mint(lease_ms, owner, opts);
    return evicted ? { ok: true, lease, evicted } : { ok: true, lease };
  }

  enforceDispatch(callerLeaseId: string | undefined): DispatchAllowed | DispatchBlocked {
    if (resolveLeaseMode() !== "single-holder") return { allowed: true, current: this.currentLease() };
    const current = this.currentLease();
    if (!current) return { allowed: true, current: null };
    if (callerLeaseId === current.lease_id) return { allowed: true, current };
    return { allowed: false, error: "input_lease_held_by_other", current };
  }

  validateForBrokerInput(
    callerLeaseId: string | undefined,
    scope: LeaseScope,
    now: number = Date.now()
  ): LeaseValidationAllowed | LeaseValidationBlocked {
    if (!callerLeaseId) {
      return {
        allowed: false,
        error: "LEASE_REQUIRED",
        current: this.currentLease(),
        detail: { scope },
      };
    }
    this.evictExpired(now);
    const lease = this.active.get(callerLeaseId) ?? null;
    if (!lease) {
      return {
        allowed: false,
        error: "LEASE_EXPIRED",
        current: null,
        detail: { lease_id: callerLeaseId, scope },
      };
    }
    if (lease.expires_at <= now) {
      this.active.delete(lease.lease_id);
      this.acquireOrder.delete(lease.lease_id);
      return {
        allowed: false,
        error: "LEASE_EXPIRED",
        current: null,
        detail: {
          lease_id: callerLeaseId,
          scope,
          expires_at: lease.expires_at,
          received_at: now,
        },
      };
    }
    if (!lease.scope.includes(scope)) {
      return {
        allowed: false,
        error: "LEASE_DENIED",
        current: lease,
        detail: {
          lease_id: callerLeaseId,
          requested_scope: scope,
          lease_scope: lease.scope,
        },
      };
    }
    return { allowed: true, lease };
  }

  renew(
    lease_id: string,
    extend_ms: number,
    now: number = Date.now()
  ): { ok: true; lease: InputLease } | { ok: false; error: "LEASE_EXPIRED"; detail: Record<string, unknown> } {
    this.evictExpired(now);
    const lease = this.active.get(lease_id);
    if (!lease || lease.expires_at <= now) {
      if (lease) {
        this.active.delete(lease_id);
        this.acquireOrder.delete(lease_id);
      }
      return { ok: false, error: "LEASE_EXPIRED", detail: { lease_id, received_at: now } };
    }
    const ms = Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(extend_ms)));
    const ownershipCeiling = lease.continuous_owner_since + MAX_CONTINUOUS_OWNERSHIP_MS;
    const nextExpiresAt = Math.min(now + ms, ownershipCeiling);
    const renewed: InputLease = {
      ...lease,
      expires_at: nextExpiresAt,
      lease_ms: Math.max(0, nextExpiresAt - now),
    };
    this.active.set(lease_id, renewed);
    eventLog.push({
      kind: "console",
      level: "info",
      message: `[input_lease] renewed lease_id=${lease_id} expires_at=${renewed.expires_at}`,
      source: "mcp_internal",
    });
    return { ok: true, lease: renewed };
  }

  private mint(
    lease_ms: number,
    owner: string,
    opts: {
      scope?: readonly LeaseScope[];
      preemptible?: boolean;
      priority?: LeasePriority;
      reason?: string | null;
    } = {}
  ): InputLease {
    const ms = Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(lease_ms)));
    const acquiredAt = Date.now();
    const lease: InputLease = {
      lease_id: `lease_${randomUUID()}`,
      acquired_at: acquiredAt,
      expires_at: acquiredAt + ms,
      lease_ms: ms,
      owner,
      scope: normalizeScope(opts.scope),
      preemptible: opts.preemptible ?? true,
      priority: opts.priority ?? "normal",
      reason: opts.reason ?? null,
      continuous_owner_since: acquiredAt,
    };
    this.acquireOrder.set(lease.lease_id, ++this.acquireCounter);
    this.active.set(lease.lease_id, lease);
    eventLog.push({
      kind: "console",
      level: "info",
        message: `[input_lease] acquired lease_id=${lease.lease_id} ms=${ms} owner=${owner} scope=${lease.scope.join(",")}`,
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

  private evictExpired(now: number = Date.now()): void {
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
