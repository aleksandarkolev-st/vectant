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
  session_id?: string;
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
  session_id?: string;
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
  session_id?: string;
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

function normalizeSessionId(sessionId: string | undefined): string | undefined {
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

function matchesSession(resourceSessionId: string | undefined, requestedSessionId: string | undefined): boolean {
  const normalized = normalizeSessionId(requestedSessionId);
  if (!normalized) return true;
  return resourceSessionId === undefined || resourceSessionId === normalized;
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
      session_id?: string;
    } = {}
  ): AcquireResult | AcquireRejection {
    const current = this.currentLease(opts.session_id);
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
    now: number = Date.now(),
    session_id?: string
  ): LeaseValidationAllowed | LeaseValidationBlocked {
    const sessionId = normalizeSessionId(session_id);
    if (!callerLeaseId) {
      return {
        allowed: false,
        error: "LEASE_REQUIRED",
        current: this.currentLease(sessionId),
        detail: { scope, ...(sessionId ? { session_id: sessionId } : {}) },
      };
    }
    this.evictExpired(now);
    const lease = this.active.get(callerLeaseId) ?? null;
    if (!lease && this.preempted.has(callerLeaseId)) {
      return {
        allowed: false,
        error: "LEASE_PREEMPTED",
        current: this.currentLease(sessionId),
        detail: { lease_id: callerLeaseId, scope, ...(sessionId ? { session_id: sessionId } : {}) },
      };
    }
    if (!lease) {
      return {
        allowed: false,
        error: "LEASE_EXPIRED",
        current: null,
        detail: { lease_id: callerLeaseId, scope, ...(sessionId ? { session_id: sessionId } : {}) },
      };
    }
    if (!matchesSession(lease.session_id, sessionId)) {
      return {
        allowed: false,
        error: "LEASE_DENIED",
        current: this.currentLease(sessionId),
        detail: {
          lease_id: callerLeaseId,
          scope,
          requested_session_id: sessionId,
          lease_session_id: lease.session_id,
        },
      };
    }
    if (lease.expires_at <= now) {
      this.active.delete(lease.lease_id);
      this.acquireOrder.delete(lease.lease_id);
      this.grantNextQueued(lease.session_id, now);
      return {
        allowed: false,
        error: "LEASE_EXPIRED",
        current: null,
        detail: {
          lease_id: callerLeaseId,
          scope,
          expires_at: lease.expires_at,
          received_at: now,
          ...(sessionId ? { session_id: sessionId } : {}),
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
          ...(sessionId ? { session_id: sessionId } : {}),
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
      session_id?: string;
    } = {}
  ): InputLease {
    const ms = Math.max(MIN_LEASE_MS, Math.min(MAX_LEASE_MS, Math.floor(lease_ms)));
    const acquiredAt = Date.now();
    const lease: InputLease = {
      lease_id: `lease_${randomUUID()}`,
      ...(normalizeSessionId(opts.session_id) ? { session_id: normalizeSessionId(opts.session_id) } : {}),
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

  release(lease_id?: string, session_id?: string): { released: string[]; not_found: string | null } {
    const sessionId = normalizeSessionId(session_id);
    if (lease_id === undefined) {
      const leases = Array.from(this.active.values()).filter((lease) => matchesSession(lease.session_id, sessionId));
      const ids = leases.map((lease) => lease.lease_id);
      for (const id of ids) {
        this.active.delete(id);
        this.acquireOrder.delete(id);
      }
      if (ids.length > 0) {
        eventLog.push({
          kind: "lease",
          action: "released_all",
          payload: { released: ids, ...(sessionId ? { session_id: sessionId } : {}) },
        });
      }
      this.grantNextQueued(sessionId);
      return { released: ids, not_found: null };
    }
    const lease = this.active.get(lease_id);
    if (!lease || !matchesSession(lease.session_id, sessionId)) {
      return { released: [], not_found: lease_id };
    }
    this.active.delete(lease_id);
    this.acquireOrder.delete(lease_id);
    this.emitLeaseEvent("released", lease, {});
    this.grantNextQueued(lease.session_id ?? sessionId);
    return { released: [lease_id], not_found: null };
  }

  invalidateAll(reason: string, now: number = Date.now()): { released: string[]; queued: string[] } {
    const released = Array.from(this.active.keys());
    const queued = this.fairnessQueue.map((entry) => entry.request_id);
    this.active.clear();
    this.acquireOrder.clear();
    this.fairnessQueue.length = 0;
    if (released.length > 0 || queued.length > 0) {
      eventLog.push({
        kind: "lease",
        action: "released_all",
        payload: {
          released,
          queued,
          invalidated: true,
          reason,
        },
        ts: now,
      });
    }
    return { released, queued };
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
      payload: { forced_by: forcedBy, reason, ...(lease.session_id ? { session_id: lease.session_id } : {}) },
    });
    this.emitLeaseLoss(lease, "force_released", forcedBy, reason);
    this.grantNextQueued(lease.session_id);
    return { ok: true, released: true, lease_id, forced_by: forcedBy, reason };
  }

  queueSnapshot(now: number = Date.now(), session_id?: string): LeaseQueueEntry[] {
    const sessionId = normalizeSessionId(session_id);
    return this.fairnessQueue.filter((entry) => matchesSession(entry.session_id, sessionId)).map((entry) => ({
      ...entry,
      scope: [...entry.scope],
      starvation_deadline_ms: entry.starvation_deadline_ms,
      ...(now >= entry.starvation_deadline_ms ? { reason: entry.reason } : {}),
    }));
  }

  nextQueuedCandidate(now: number = Date.now(), session_id?: string): LeaseQueueEntry | null {
    const next = this.pickNextQueued(now, session_id);
    return next ? { ...next, scope: [...next.scope] } : null;
  }

  createActionBatch(input: {
    lease_id: string;
    actions: readonly unknown[];
    scope?: LeaseScope;
    session_id?: string;
    now?: number;
  }): { ok: true; batch: InputActionBatch } | LeaseValidationBlocked {
    const validation = this.validateForBrokerInput(input.lease_id, input.scope ?? "mouse", input.now ?? Date.now(), input.session_id);
    if (!validation.allowed) return validation;
    const now = input.now ?? Date.now();
    const batch: InputActionBatch = {
      batch_id: `batch_${randomUUID()}`,
      lease_id: validation.lease.lease_id,
      ...(validation.lease.session_id ? { session_id: validation.lease.session_id } : {}),
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

  currentLease(session_id?: string): InputLease | null {
    this.evictExpired();
    const sessionId = normalizeSessionId(session_id);
    let best: InputLease | null = null;
    let bestOrder = -1;
    for (const lease of this.active.values()) {
      if (!matchesSession(lease.session_id, sessionId)) continue;
      const order = this.acquireOrder.get(lease.lease_id) ?? 0;
      if (!best || order > bestOrder) {
        best = lease;
        bestOrder = order;
      }
    }
    return best;
  }

  snapshot(session_id?: string): InputLease[] {
    this.evictExpired();
    const sessionId = normalizeSessionId(session_id);
    return Array.from(this.active.values()).filter((lease) => matchesSession(lease.session_id, sessionId));
  }

  private enqueue(
    lease_ms: number,
    owner: string,
    opts: {
      scope?: readonly LeaseScope[];
      preemptible?: boolean;
      priority?: LeasePriority;
      reason?: string | null;
      session_id?: string;
    }
  ): LeaseQueueEntry {
    const now = Date.now();
    const entry: LeaseQueueEntry = {
      request_id: `lease_req_${++this.queueCounter}`,
      ...(normalizeSessionId(opts.session_id) ? { session_id: normalizeSessionId(opts.session_id) } : {}),
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
      payload: { preempted_by: actor, reason, ...(lease.session_id ? { session_id: lease.session_id } : {}) },
    });
    this.emitLeaseLoss(lease, "preempted", actor, reason);
  }

  private grantNextQueued(session_id?: string, now: number = Date.now()): InputLease | null {
    const sessionId = normalizeSessionId(session_id);
    if (this.hasActiveLeaseForSession(sessionId)) return null;
    const next = this.pickNextQueued(now, sessionId);
    if (!next) return null;
    const idx = this.fairnessQueue.findIndex((entry) => entry.request_id === next.request_id);
    if (idx >= 0) this.fairnessQueue.splice(idx, 1);
    return this.mint(next.lease_ms, next.owner, {
      scope: next.scope,
      preemptible: next.preemptible,
      priority: next.priority,
      reason: next.reason,
      session_id: next.session_id,
    });
  }

  private pickNextQueued(now: number, session_id?: string): LeaseQueueEntry | null {
    if (this.fairnessQueue.length === 0) return null;
    const sessionId = normalizeSessionId(session_id);
    const sorted = this.fairnessQueue.filter((entry) => matchesSession(entry.session_id, sessionId)).sort((a, b) => {
      const urgent = Number(b.priority === "urgent_human_override") - Number(a.priority === "urgent_human_override");
      if (urgent !== 0) return urgent;
      const starved = Number(now >= b.starvation_deadline_ms) - Number(now >= a.starvation_deadline_ms);
      if (starved !== 0) return starved;
      return a.requested_at - b.requested_at;
    });
    return sorted[0] ?? null;
  }

  private hasActiveLeaseForSession(session_id?: string): boolean {
    const sessionId = normalizeSessionId(session_id);
    if (!sessionId) return this.active.size > 0;
    for (const lease of this.active.values()) {
      if (matchesSession(lease.session_id, sessionId)) return true;
    }
    return false;
  }

  private emitLeaseEvent(action: "acquired" | "renewed" | "released", lease: InputLease, payload: Record<string, unknown>): void {
    eventLog.push({
      kind: "lease",
      action,
      lease_id: lease.lease_id,
      owner: lease.owner,
      payload: {
        ...payload,
        ...(lease.session_id ? { session_id: lease.session_id } : {}),
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
        ...(lease.session_id ? { session_id: lease.session_id } : {}),
      },
    });
  }

  private evictExpired(now: number = Date.now()): void {
    for (const [id, lease] of this.active) {
      if (lease.expires_at <= now) {
        this.active.delete(id);
        this.acquireOrder.delete(id);
        this.grantNextQueued(lease.session_id, now);
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
