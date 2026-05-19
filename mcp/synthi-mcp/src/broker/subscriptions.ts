import { randomUUID } from "node:crypto";
import type { EventLogEntry } from "../events/types.js";
import { brokerError, type BrokerErrorPayload } from "./errors.js";
import type { BrokerPrincipal } from "./auth.js";
import { brokerSloRecorder } from "./slo.js";
import { redactBrokerEvent } from "./security.js";

export type BrokerTopic = "frames" | "events" | "health_updates" | "logs";

export interface BrokerSubscription {
  subscription_id: string;
  principal: BrokerPrincipal;
  session_id: string;
  topics: BrokerTopic[];
  cursor: number;
  created_at: number;
  last_emit_at: number;
  dropped_frames: number;
  queue: EventLogEntry[];
}

export interface BrokerSubscribeOk {
  ok: true;
  subscription_id: string;
  accepted_topics: BrokerTopic[];
  replay_start_event_id: number;
}

export interface BrokerResumeOk {
  ok: true;
  resumed_from_event_id: number;
  gap_detected: boolean;
  events: EventLogEntry[];
}

export interface BrokerSubscriptionError {
  ok: false;
  error: BrokerErrorPayload;
}

export interface BrokerSubscriberHealth {
  subscription_id: string;
  lag_ms: number;
  queue_depth: number;
  dropped_frames: number;
  topics: BrokerTopic[];
}

const MAX_FRAME_QUEUE = 1;
const MAX_CONTROL_QUEUE = 128;

export class BrokerSubscriptionRegistry {
  private readonly subscriptions = new Map<string, BrokerSubscription>();

  subscribe(input: {
    principal: BrokerPrincipal;
    session_id: string;
    topics: BrokerTopic[];
    cursor?: number;
    oldest_event_id?: number | null;
    now?: number;
  }): BrokerSubscribeOk | BrokerSubscriptionError {
    const oldest = input.oldest_event_id ?? null;
    const cursor = input.cursor ?? 0;
    if (oldest !== null && cursor < oldest - 1) {
      return { ok: false, error: brokerError("CURSOR_TOO_OLD", { cursor, oldest_event_id: oldest }) };
    }
    const subscription: BrokerSubscription = {
      subscription_id: `sub_${randomUUID()}`,
      principal: input.principal,
      session_id: input.session_id,
      topics: dedupeTopics(input.topics),
      cursor,
      created_at: input.now ?? Date.now(),
      last_emit_at: input.now ?? Date.now(),
      dropped_frames: 0,
      queue: [],
    };
    this.subscriptions.set(subscription.subscription_id, subscription);
    return {
      ok: true,
      subscription_id: subscription.subscription_id,
      accepted_topics: subscription.topics,
      replay_start_event_id: cursor,
    };
  }

  unsubscribe(subscriptionId: string): { ok: true; released: boolean } {
    return { ok: true, released: this.subscriptions.delete(subscriptionId) };
  }

  resume(input: {
    subscription_id: string;
    last_seen_event_id: number;
    events: EventLogEntry[];
    oldest_event_id?: number | null;
    now?: number;
  }): BrokerResumeOk | BrokerSubscriptionError {
    const sub = this.subscriptions.get(input.subscription_id);
    if (!sub) return { ok: false, error: brokerError("SUBSCRIPTION_NOT_FOUND", { subscription_id: input.subscription_id }) };
    const oldest = input.oldest_event_id ?? null;
    if (oldest !== null && input.last_seen_event_id < oldest - 1) {
      return {
        ok: false,
        error: brokerError("CURSOR_TOO_OLD", {
          last_seen_event_id: input.last_seen_event_id,
          oldest_event_id: oldest,
        }),
      };
    }
    sub.cursor = input.last_seen_event_id;
    sub.last_emit_at = input.now ?? Date.now();
    const rawReplay = input.events.filter((event) => event.seq > input.last_seen_event_id);
    let replay: EventLogEntry[];
    try {
      replay = rawReplay
        .filter((event) => sub.session_id === eventSessionId(event, sub.session_id))
        .filter((event) => eventMatchesTopics(event, sub.topics))
        .map((event) => redactBrokerEvent(event, sub.principal.role));
    } catch {
      return { ok: false, error: brokerError("FORBIDDEN", { reason: "redaction_failed" }) };
    }
    return {
      ok: true,
      resumed_from_event_id: input.last_seen_event_id,
      gap_detected: rawReplay[0] ? rawReplay[0].seq > input.last_seen_event_id + 1 : false,
      events: replay,
    };
  }

  publish(event: EventLogEntry, now: number = Date.now()): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.session_id !== eventSessionId(event, sub.session_id)) continue;
      if (!eventMatchesTopics(event, sub.topics)) continue;
      const maxQueue = event.kind === "frame" ? MAX_FRAME_QUEUE : MAX_CONTROL_QUEUE;
      let droppedFrames = 0;
      while (sub.queue.length >= maxQueue) {
        const dropped = sub.queue.shift();
        if (dropped?.kind === "frame" || event.kind === "frame") {
          sub.dropped_frames += 1;
          droppedFrames += 1;
        }
      }
      let fanoutEvent: EventLogEntry;
      try {
        fanoutEvent = redactBrokerEvent(event, sub.principal.role);
      } catch {
        if (event.kind === "frame") sub.dropped_frames += 1;
        continue;
      }
      sub.queue.push(fanoutEvent);
      sub.cursor = event.seq;
      sub.last_emit_at = now;
      const ingestTs = event.kind === "frame" ? event.ingest_ts_ms : event.ts;
      brokerSloRecorder.recordDuration("broker_fanout_latency_p95", now - ingestTs, now, {
        subscription_id: sub.subscription_id,
        event_kind: event.kind,
      });
      if (event.kind === "frame") {
        brokerSloRecorder.recordRatio("subscriber_frame_drop_rate", droppedFrames, 1, now, {
          subscription_id: sub.subscription_id,
        });
      }
    }
  }

  drain(subscriptionId: string): EventLogEntry[] | BrokerSubscriptionError {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return { ok: false, error: brokerError("SUBSCRIPTION_NOT_FOUND", { subscription_id: subscriptionId }) };
    const out = sub.queue;
    sub.queue = [];
    return out;
  }

  health(subscriptionId?: string, now: number = Date.now()): BrokerSubscriberHealth[] {
    const subs = subscriptionId
      ? [...this.subscriptions.values()].filter((s) => s.subscription_id === subscriptionId)
      : [...this.subscriptions.values()];
    return this.healthForSubscriptions(subs, now);
  }

  healthForPrincipal(input: {
    principal: BrokerPrincipal;
    session_id: string;
    subscription_id?: string;
    now?: number;
  }): BrokerSubscriberHealth[] {
    const subs = [...this.subscriptions.values()].filter((sub) => {
      if (input.subscription_id && sub.subscription_id !== input.subscription_id) return false;
      return (
        sub.session_id === input.session_id &&
        sub.principal.tenant_id === input.principal.tenant_id &&
        sub.principal.subject === input.principal.subject
      );
    });
    return this.healthForSubscriptions(subs, input.now ?? Date.now());
  }

  private healthForSubscriptions(subs: BrokerSubscription[], now: number): BrokerSubscriberHealth[] {
    return subs.map((sub) => ({
      subscription_id: sub.subscription_id,
      lag_ms: Math.max(0, now - sub.last_emit_at),
      queue_depth: sub.queue.length,
      dropped_frames: sub.dropped_frames,
      topics: [...sub.topics],
    }));
  }

  get(subscriptionId: string): BrokerSubscription | null {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  clear(): void {
    this.subscriptions.clear();
  }
}

function dedupeTopics(topics: BrokerTopic[]): BrokerTopic[] {
  const valid = new Set<BrokerTopic>(["frames", "events", "health_updates", "logs"]);
  const out: BrokerTopic[] = [];
  for (const t of topics) {
    if (valid.has(t) && !out.includes(t)) out.push(t);
  }
  return out.length > 0 ? out : ["events"];
}

function eventMatchesTopics(event: EventLogEntry, topics: BrokerTopic[]): boolean {
  if (event.kind === "frame") return topics.includes("frames");
  if (event.kind === "console") return topics.includes("logs") || topics.includes("events");
  if (event.kind === "lifecycle") return topics.includes("health_updates") || topics.includes("events");
  return topics.includes("events");
}

function eventSessionId(event: EventLogEntry, fallback: string): string {
  if (event.kind === "frame") return event.session_id;
  if (event.kind === "input") {
    const sid = event.payload["session_id"];
    return typeof sid === "string" ? sid : fallback;
  }
  return fallback;
}
