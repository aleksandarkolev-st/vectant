import type { EventLog } from "../events/log.js";
import type { EventLogEntry } from "../events/types.js";
import {
  authorizeBrokerCapability,
  principalKey,
  type BrokerPrincipal,
} from "./auth.js";
import {
  DEFAULT_LEASE_MS,
  leaseRegistry,
  type LeasePriority,
  type LeaseScope,
} from "../arbitration/lease.js";
import {
  BrokerSubscriptionRegistry,
  type BrokerSubscribeOk,
  type BrokerSubscriptionError,
  type BrokerTopic,
} from "./subscriptions.js";
import { IdempotencyStore } from "./idempotency.js";
import { brokerError, type BrokerErrorPayload } from "./errors.js";
import { queryBrokerReplay, type BrokerReplayOk } from "./replay.js";
import {
  type BrokerHealthStatus,
} from "./contracts.js";
import { auditBrokerEvent, redactBrokerEvent } from "./security.js";
import { brokerFallbackController, type BrokerFallbackMode, type BrokerFallbackResult } from "./fallback.js";
import { currentBrokerHealthStatus } from "./read_only.js";

type AcquireLeaseResponse = { ok: true; lease_id: string; expires_at_ms: number } | { ok: false; error: BrokerErrorPayload };

export class BrokerControlPlane {
  readonly subscriptions = new BrokerSubscriptionRegistry();
  private readonly idempotency = new IdempotencyStore<unknown>();

  constructor(private readonly log: EventLog) {}

  subscribe(input: {
    principal: BrokerPrincipal;
    session_id: string;
    topics: BrokerTopic[];
    cursor?: number;
    idempotency_key: string;
  }): BrokerSubscribeOk | BrokerSubscriptionError {
    const auth = authorizeBrokerCapability(input.principal, "subscribe_frames", input.session_id);
    if (auth) return auth;
    const payload = {
      session_id: input.session_id,
      topics: input.topics,
      cursor: input.cursor ?? 0,
    };
    const replay = this.idempotency.lookup({
      scope: this.scope(input.principal, "subscribe", input.session_id),
      idempotency_key: input.idempotency_key,
      payload,
    });
    if (replay.status === "conflict") return { ok: false, error: brokerError("IDEMPOTENCY_CONFLICT") };
    if (replay.status === "replay") {
      return replay.record.response as BrokerSubscribeOk;
    }
    const result = this.subscriptions.subscribe({
      principal: input.principal,
      session_id: input.session_id,
      topics: input.topics,
      cursor: input.cursor,
      oldest_event_id: this.log.firstSeq(),
    });
    if (result.ok) {
      auditBrokerEvent({
        action: "subscribe",
        principal: input.principal,
        payload: {
          session_id: input.session_id,
          topics: input.topics,
          subscription_id: result.subscription_id,
        },
      });
      this.idempotency.remember({
        scope: this.scope(input.principal, "subscribe", input.session_id),
        idempotency_key: input.idempotency_key,
        payload,
        response: result,
      });
    }
    return result;
  }

  acquireLease(input: {
    principal: BrokerPrincipal;
    session_id: string;
    scope?: LeaseScope[];
    lease_ms?: number;
    reason?: string | null;
    preemptible?: boolean;
    priority?: LeasePriority;
    idempotency_key: string;
  }): AcquireLeaseResponse {
    const auth = authorizeBrokerCapability(input.principal, "acquire_lease", input.session_id);
    if (auth) return auth;
    const payload = {
      session_id: input.session_id,
      scope: input.scope ?? ["mouse", "keyboard"],
      lease_ms: input.lease_ms ?? DEFAULT_LEASE_MS,
      reason: input.reason ?? null,
      preemptible: input.preemptible ?? true,
      priority: input.priority ?? "normal",
    };
    const scope = this.scope(input.principal, "acquire_lease", input.session_id);
    const replay = this.idempotency.lookup({ scope, idempotency_key: input.idempotency_key, payload });
    if (replay.status === "conflict") return { ok: false, error: brokerError("IDEMPOTENCY_CONFLICT") };
    if (replay.status === "replay") return replay.record.response as AcquireLeaseResponse;
    const result = leaseRegistry.acquireWithPolicy(payload.lease_ms, input.principal.subject, {
      scope: payload.scope,
      preemptible: payload.preemptible,
      priority: payload.priority,
      reason: payload.reason,
      session_id: input.session_id,
    });
    if (!result.ok) {
      const response = {
        ok: false as const,
        error: brokerError("LEASE_DENIED", {
          current_lease_id: result.current.lease_id,
          queued_request_id: result.queued?.request_id,
        }),
      };
      this.idempotency.remember({ scope, idempotency_key: input.idempotency_key, payload, response });
      return response;
    }
    const response = { ok: true as const, lease_id: result.lease.lease_id, expires_at_ms: result.lease.expires_at };
    this.idempotency.remember({ scope, idempotency_key: input.idempotency_key, payload, response });
    auditBrokerEvent({
      action: "acquire_lease",
      principal: input.principal,
      payload: { session_id: input.session_id, lease_id: response.lease_id },
    });
    return response;
  }

  renewLease(input: {
    principal: BrokerPrincipal;
    lease_id: string;
    extend_ms?: number;
    idempotency_key: string;
  }): { ok: true; lease_id: string; expires_at_ms: number } | { ok: false; error: BrokerErrorPayload } {
    const auth = authorizeBrokerCapability(input.principal, "renew_own_lease");
    if (auth) return auth;
    const payload = { lease_id: input.lease_id, extend_ms: input.extend_ms ?? DEFAULT_LEASE_MS };
    const scope = this.scope(input.principal, "renew_lease", input.lease_id);
    const replay = this.idempotency.lookup({ scope, idempotency_key: input.idempotency_key, payload });
    if (replay.status === "conflict") return { ok: false, error: brokerError("IDEMPOTENCY_CONFLICT") };
    if (replay.status === "replay") return replay.record.response as { ok: true; lease_id: string; expires_at_ms: number };
    const ownerError = this.requireLeaseOwner(input.lease_id, input.principal.subject);
    if (ownerError) return { ok: false, error: ownerError };
    const renewed = leaseRegistry.renew(input.lease_id, payload.extend_ms);
    if (!renewed.ok) return { ok: false, error: brokerError(renewed.error, renewed.detail) };
    const response = { ok: true as const, lease_id: renewed.lease.lease_id, expires_at_ms: renewed.lease.expires_at };
    this.idempotency.remember({ scope, idempotency_key: input.idempotency_key, payload, response });
    return response;
  }

  releaseLease(input: {
    principal: BrokerPrincipal;
    lease_id: string;
    idempotency_key: string;
  }): { ok: true; released: boolean; reason?: string } | { ok: false; error: BrokerErrorPayload } {
    const auth = authorizeBrokerCapability(input.principal, "renew_own_lease");
    if (auth) return auth;
    const payload = { lease_id: input.lease_id };
    const scope = this.scope(input.principal, "release_lease", input.lease_id);
    const replay = this.idempotency.lookup({ scope, idempotency_key: input.idempotency_key, payload });
    if (replay.status === "conflict") return { ok: false, error: brokerError("IDEMPOTENCY_CONFLICT") };
    if (replay.status === "replay") return replay.record.response as { ok: true; released: boolean; reason?: string };
    const ownerError = this.requireLeaseOwner(input.lease_id, input.principal.subject);
    if (ownerError) return { ok: false, error: ownerError };
    const released = leaseRegistry.release(input.lease_id);
    const response = released.not_found
      ? { ok: true as const, released: false, reason: "already_expired" }
      : { ok: true as const, released: true };
    this.idempotency.remember({ scope, idempotency_key: input.idempotency_key, payload, response });
    return response;
  }

  forceReleaseLease(input: {
    principal: BrokerPrincipal;
    lease_id: string;
    reason: string;
  }): ReturnType<typeof leaseRegistry.forceRelease> | { ok: false; error: BrokerErrorPayload } {
    const auth = authorizeBrokerCapability(input.principal, "force_release_lease");
    if (auth) return auth;
    const result = leaseRegistry.forceRelease(input.lease_id, input.principal.subject, input.reason);
    if (!result.ok) return { ok: false, error: brokerError("LEASE_EXPIRED", { lease_id: input.lease_id }) };
    return result;
  }

  fallback(input: {
    principal: BrokerPrincipal;
    session_id: string;
    mode: BrokerFallbackMode;
    reason: string;
  }): BrokerFallbackResult {
    const auth = authorizeBrokerCapability(input.principal, "toggle_fallback", input.session_id);
    if (auth) return { ok: false, error: auth.error, safety_checks_passed: false };
    auditBrokerEvent({
      action: "fallback",
      principal: input.principal,
      payload: { session_id: input.session_id, mode: input.mode, reason: input.reason },
    });
    return brokerFallbackController.apply({
      session_id: input.session_id,
      mode: input.mode,
      reason: input.reason,
      operator_id: input.principal.subject,
    });
  }

  unsubscribe(input: {
    principal: BrokerPrincipal;
    subscription_id: string;
  }): { ok: true; released: boolean } | BrokerSubscriptionError {
    const sub = this.subscriptions.get(input.subscription_id);
    if (!sub) return { ok: false, error: brokerError("SUBSCRIPTION_NOT_FOUND", { subscription_id: input.subscription_id }) };
    if (sub.principal.tenant_id !== input.principal.tenant_id || sub.principal.subject !== input.principal.subject) {
      return { ok: false, error: brokerError("FORBIDDEN", { reason: "subscription_owner_mismatch" }) };
    }
    auditBrokerEvent({
      action: "unsubscribe",
      principal: input.principal,
      payload: { subscription_id: input.subscription_id },
    });
    return this.subscriptions.unsubscribe(input.subscription_id);
  }

  resume(input: {
    principal: BrokerPrincipal;
    subscription_id: string;
    last_seen_event_id: number;
  }): ReturnType<BrokerSubscriptionRegistry["resume"]> {
    const sub = this.subscriptions.get(input.subscription_id);
    if (!sub) return { ok: false, error: brokerError("SUBSCRIPTION_NOT_FOUND", { subscription_id: input.subscription_id }) };
    if (sub.principal.tenant_id !== input.principal.tenant_id || sub.principal.subject !== input.principal.subject) {
      return { ok: false, error: brokerError("FORBIDDEN", { reason: "subscription_owner_mismatch" }) };
    }
    auditBrokerEvent({
      action: "resume",
      principal: input.principal,
      payload: {
        subscription_id: input.subscription_id,
        last_seen_event_id: input.last_seen_event_id,
      },
    });
    return this.subscriptions.resume({
      subscription_id: input.subscription_id,
      last_seen_event_id: input.last_seen_event_id,
      events: this.log.query({ since_seq: input.last_seen_event_id }),
      oldest_event_id: this.log.firstSeq(),
    });
  }

  replay(input: {
    principal: BrokerPrincipal;
    session_id: string;
    from_event_id: number;
    to_event_id?: number;
    limit?: number;
  }): BrokerReplayOk | { ok: false; error: BrokerErrorPayload } {
    const auth = authorizeBrokerCapability(input.principal, "replay_logs", input.session_id);
    if (auth) return auth;
    const result = queryBrokerReplay(this.log, {
      from_event_id: input.from_event_id,
      to_event_id: input.to_event_id,
      limit: input.limit,
    });
    if (!result.ok) return result;
    const events = result.events.filter((event) => eventMatchesReplaySession(event, input.session_id));
    auditBrokerEvent({
      action: "replay",
      principal: input.principal,
      payload: {
        session_id: input.session_id,
        from_event_id: input.from_event_id,
        to_event_id: input.to_event_id ?? null,
        returned_events: events.length,
      },
    });
    try {
      return {
        ...result,
        events: events.map((event) => redactBrokerEvent(event, input.principal.role)),
      };
    } catch {
      return { ok: false, error: brokerError("FORBIDDEN", { reason: "redaction_failed" }) };
    }
  }

  health(input: {
    principal: BrokerPrincipal;
    session_id: string;
    subscriber_id?: string;
  }): { ok: true; health: BrokerHealthStatus; subscribers: ReturnType<BrokerSubscriptionRegistry["health"]> } | { ok: false; error: BrokerErrorPayload } {
    const auth = authorizeBrokerCapability(input.principal, "subscribe_frames", input.session_id);
    if (auth) return auth;
    const subscribers = input.principal.role === "admin"
      ? this.subscriptions.health(input.subscriber_id)
      : this.subscriptions.healthForPrincipal({
          principal: input.principal,
          session_id: input.session_id,
          subscription_id: input.subscriber_id,
        });
    const aggregateDrops = subscribers.reduce((sum, sub) => sum + sub.dropped_frames, 0);
    const aggregateQueue = subscribers.reduce((sum, sub) => sum + sub.queue_depth, 0);
    const baseHealth = currentBrokerHealthStatus();
    const sessionHealth: BrokerHealthStatus = baseHealth.session_id === input.session_id || baseHealth.session_id === "unattached"
      ? { ...baseHealth, session_id: input.session_id }
      : {
          ...baseHealth,
          session_id: input.session_id,
          broker_state: "disconnected",
          upstream: {
            connected: false,
            last_frame_age_ms: null,
            rtt_ms: null,
          },
        };
    return {
      ok: true,
      health: {
        ...sessionHealth,
        subscriber: {
          lag_ms: Math.max(0, ...subscribers.map((s) => s.lag_ms)),
          queue_depth: aggregateQueue,
          dropped_frames: aggregateDrops,
        },
      },
      subscribers,
    };
  }

  publish(event: EventLogEntry): void {
    this.subscriptions.publish(event);
  }

  clear(): void {
    this.subscriptions.clear();
  }

  private scope(principal: BrokerPrincipal, endpoint: string, sessionId: string): string {
    return `${principalKey(principal)}:${endpoint}:${sessionId}`;
  }

  private requireLeaseOwner(leaseId: string, subject: string): BrokerErrorPayload | null {
    const lease = leaseRegistry.snapshot().find((item) => item.lease_id === leaseId);
    if (lease && lease.owner !== subject) {
      return brokerError("FORBIDDEN", {
        reason: "lease_owner_mismatch",
        lease_id: leaseId,
        lease_owner: lease.owner,
      });
    }
    return null;
  }
}

function eventMatchesReplaySession(event: EventLogEntry, requestedSessionId: string): boolean {
  const explicitSessionId = explicitEventSessionId(event);
  return explicitSessionId === null || explicitSessionId === requestedSessionId;
}

function explicitEventSessionId(event: EventLogEntry): string | null {
  if (event.kind === "frame") return event.session_id;
  if (event.kind === "input") return stringField(event.payload["session_id"]);
  if (event.kind === "lease") return stringField(event.payload["session_id"]);
  if (event.kind === "error") return stringField(event.detail?.["session_id"]);
  if (event.kind === "usage") return stringField(event.detail?.["session_id"]);
  if (event.kind === "source_state") return stringField(event.detail?.["session_id"]);
  if (event.kind === "security") return stringField(event.detail?.["session_id"]);
  if (event.kind === "lifecycle") return stringField(event.detail?.["session_id"]);
  return null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
