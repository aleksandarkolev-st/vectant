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
  reentrant?: boolean;
}

export interface AcquireRejection {
  ok: false;
  error: "lease_already_held";
  current: InputLease;
  queued?: LeaseQueueEntry;
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

export interface LeaseQueueEntry {
  request_id: string;
  owner: string;
  requested_at: number;
  lease_ms: number;
  scope: LeaseScope[];
  preemptible: boolean;
  priority: LeasePriority;
  reason: string | null;
  starvation_deadline_ms: number;
}

export interface ForceReleaseResult {
  ok: true;
  released: boolean;
  lease_id: string;
  forced_by: string;
  reason: string;
}

export interface InputActionBatch {
  batch_id: string;
  lease_id: string;
  owner: string;
  action_count: number;
  created_at: number;
  expires_at: number;
}

const MIN_LEASE_MS = 50;
export const DEFAULT_LEASE_MS = 15_000;
export const MAX_LEASE_MS = 15_000;
export const MAX_CONTINUOUS_OWNERSHIP_MS = 60_000;
export const FAIRNESS_STARVATION_MS = 30_000;

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

function mergeScopes(current: readonly LeaseScope[], requested: readonly LeaseScope[]): LeaseScope[] {
  const out = [...current];
  for (const item of normalizeScope(requested)) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

class LeaseRegistry {
  private active = new Map<string, InputLease>();
  private readonly preempted = new Set<string>();
  private readonly fairnessQueue: LeaseQueueEntry[] = [];
  // Monotonic counter serves as a tiebreaker when two leases are
  // acquired within the same millisecond — Date.now() coarse-grained
  // timing would otherwise make `currentLease()` pick arbitrarily.
  private acquireCounter = 0;
  private acquireOrder = new Map<string, number>();
  private queueCounter = 0;

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
      if (current.owner === owner) {
        const renewed = this.renewLease(current.lease_id, lease_ms, Date.now(), opts.scope);
        if (renewed.ok) return { ok: true, lease: renewed.lease, reentrant: true };
      }
      if (opts.priority === "urgent_human_override" && current.preemptible) {
        this.preemptLease(current, owner, opts.reason ?? "urgent_human_override");
        const lease = this.mint(lease_ms, owner, opts);
        return { ok: true, lease, evicted: current };
      }
      const queued = this.enqueue(lease_ms, owner, opts);
      return { ok: false, error: "lease_already_held", current, queued };
    }
    let evicted: InputLease | undefined;
    if (current && opts.takeover) {
      this.preemptLease(current, owner, opts.reason ?? "takeover");
      evicted = current;
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
    if (!lease && this.preempted.has(callerLeaseId)) {
      return {
        allowed: false,
        error: "LEASE_PREEMPTED",
        current: this.currentLease(),
        detail: { lease_id: callerLeaseId, scope },
      };
    }
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
  ): { ok: true; lease: InputLease } | { ok: false; error: "LEASE_EXPIRED" | "LEASE_PREEMPTED"; detail: Record<string, unknown> } {
    return this.renewLease(lease_id, extend_ms, now);
  }

  private renewLease(
    lease_id: string,
    extend_ms: number,
    now: number = Date.now(),
    requestedScope?: readonly LeaseScope[]
  ): { ok: true; lease: InputLease } | { ok: false; error: "LEASE_EXPIRED" | "LEASE_PREEMPTED"; detail: Record<string, unknown> } {
    this.evictExpired(now);
    if (this.preempted.has(lease_id)) {
      return { ok: false, error: "LEASE_PREEMPTED", detail: { lease_id, received_at: now } };
    }
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
      scope: requestedScope ? mergeScopes(lease.scope, requestedScope) : lease.scope,
    };
    this.active.set(lease_id, renewed);
    this.emitLeaseEvent("renewed", renewed, { expires_at: renewed.expires_at });
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
    this.emitLeaseEvent("acquired", lease, { lease_ms: ms });
    return lease;
  }

  release(lease_id?: string): { released: string[]; not_found: string | null } {
    if (lease_id === undefined) {
      const ids = Array.from(this.active.keys());
      this.active.clear();
      this.acquireOrder.clear();
      if (ids.length > 0) {
        eventLog.push({
          kind: "lease",
          action: "released_all",
          payload: { released: ids },
        });
      }
      this.grantNextQueued();
      return { released: ids, not_found: null };
    }
    const lease = this.active.get(lease_id);
    if (!lease) {
      return { released: [], not_found: lease_id };
    }
    this.active.delete(lease_id);
    this.acquireOrder.delete(lease_id);
    this.emitLeaseEvent("released", lease, {});
    this.grantNextQueued();
    return { released: [lease_id], not_found: null };
  }

  forceRelease(lease_id: string, forcedBy: string, reason: string): ForceReleaseResult | { ok: false; error: "lease_not_found" } {
    const lease = this.active.get(lease_id);
    if (!lease) return { ok: false, error: "lease_not_found" };
    this.active.delete(lease_id);
    this.acquireOrder.delete(lease_id);
    this.preempted.add(lease_id);
    eventLog.push({
      kind: "lease",
      action: "force_released",
      lease_id,
      owner: lease.owner,
      payload: { forced_by: forcedBy, reason },
    });
    this.emitLeaseLoss(lease, "force_released", forcedBy, reason);
    this.grantNextQueued();
    return { ok: true, released: true, lease_id, forced_by: forcedBy, reason };
  }

  queueSnapshot(now: number = Date.now()): LeaseQueueEntry[] {
    return this.fairnessQueue.map((entry) => ({
      ...entry,
      scope: [...entry.scope],
      starvation_deadline_ms: entry.starvation_deadline_ms,
      ...(now >= entry.starvation_deadline_ms ? { reason: entry.reason } : {}),
    }));
  }

  nextQueuedCandidate(now: number = Date.now()): LeaseQueueEntry | null {
    const next = this.pickNextQueued(now);
    return next ? { ...next, scope: [...next.scope] } : null;
  }

  createActionBatch(input: {
    lease_id: string;
    actions: readonly unknown[];
    scope?: LeaseScope;
    now?: number;
  }): { ok: true; batch: InputActionBatch } | LeaseValidationBlocked {
    const validation = this.validateForBrokerInput(input.lease_id, input.scope ?? "mouse", input.now ?? Date.now());
    if (!validation.allowed) return validation;
    const now = input.now ?? Date.now();
    const batch: InputActionBatch = {
      batch_id: `batch_${randomUUID()}`,
      lease_id: validation.lease.lease_id,
      owner: validation.lease.owner,
      action_count: input.actions.length,
      created_at: now,
      expires_at: validation.lease.expires_at,
    };
    eventLog.push({
      kind: "lease",
      action: "batch_created",
      lease_id: validation.lease.lease_id,
      owner: validation.lease.owner,
      payload: batch as unknown as Record<string, unknown>,
      ts: now,
    });
    return { ok: true, batch };
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

  private enqueue(
    lease_ms: number,
    owner: string,
    opts: {
      scope?: readonly LeaseScope[];
      preemptible?: boolean;
      priority?: LeasePriority;
      reason?: string | null;
    }
  ): LeaseQueueEntry {
    const now = Date.now();
    const entry: LeaseQueueEntry = {
      request_id: `lease_req_${++this.queueCounter}`,
      owner,
      requested_at: now,
      lease_ms: Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(lease_ms))),
      scope: normalizeScope(opts.scope),
      preemptible: opts.preemptible ?? true,
      priority: opts.priority ?? "normal",
      reason: opts.reason ?? null,
      starvation_deadline_ms: now + FAIRNESS_STARVATION_MS,
    };
    this.fairnessQueue.push(entry);
    eventLog.push({
      kind: "lease",
      action: "queued",
      owner,
      payload: { ...entry, scope: [...entry.scope] },
      ts: now,
    });
    return { ...entry, scope: [...entry.scope] };
  }

  private preemptLease(lease: InputLease, actor: string, reason: string): void {
    this.active.delete(lease.lease_id);
    this.acquireOrder.delete(lease.lease_id);
    this.preempted.add(lease.lease_id);
    eventLog.push({
      kind: "lease",
      action: "preempted",
      lease_id: lease.lease_id,
      owner: lease.owner,
      payload: { preempted_by: actor, reason },
    });
    this.emitLeaseLoss(lease, "preempted", actor, reason);
  }

  private grantNextQueued(now: number = Date.now()): InputLease | null {
    if (this.active.size > 0) return null;
    const next = this.pickNextQueued(now);
    if (!next) return null;
    const idx = this.fairnessQueue.findIndex((entry) => entry.request_id === next.request_id);
    if (idx >= 0) this.fairnessQueue.splice(idx, 1);
    return this.mint(next.lease_ms, next.owner, {
      scope: next.scope,
      preemptible: next.preemptible,
      priority: next.priority,
      reason: next.reason,
    });
  }

  private pickNextQueued(now: number): LeaseQueueEntry | null {
    if (this.fairnessQueue.length === 0) return null;
    const sorted = [...this.fairnessQueue].sort((a, b) => {
      const urgent = Number(b.priority === "urgent_human_override") - Number(a.priority === "urgent_human_override");
      if (urgent !== 0) return urgent;
      const starved = Number(now >= b.starvation_deadline_ms) - Number(now >= a.starvation_deadline_ms);
      if (starved !== 0) return starved;
      return a.requested_at - b.requested_at;
    });
    return sorted[0] ?? null;
  }

  private emitLeaseEvent(action: "acquired" | "renewed" | "released", lease: InputLease, payload: Record<string, unknown>): void {
    eventLog.push({
      kind: "lease",
      action,
      lease_id: lease.lease_id,
      owner: lease.owner,
      payload: {
        ...payload,
        scope: [...lease.scope],
        expires_at: lease.expires_at,
        priority: lease.priority,
        preemptible: lease.preemptible,
        reason: lease.reason,
      },
    });
  }

  private emitLeaseLoss(lease: InputLease, cause: "preempted" | "force_released", actor: string, reason: string): void {
    eventLog.push({
      kind: "input",
      action: "lease_loss",
      payload: {
        lease_id: lease.lease_id,
        owner: lease.owner,
        cause,
        actor,
        reason,
        scope: [...lease.scope],
      },
    });
  }

  private evictExpired(now: number = Date.now()): void {
    for (const [id, lease] of this.active) {
      if (lease.expires_at <= now) {
        this.active.delete(id);
        this.acquireOrder.delete(id);
        this.grantNextQueued(now);
      }
    }
  }

  _resetForTests(): void {
    this.active.clear();
    this.preempted.clear();
    this.fairnessQueue.length = 0;
    this.acquireOrder.clear();
    this.acquireCounter = 0;
    this.queueCounter = 0;
  }
}

export const leaseRegistry = new LeaseRegistry();
