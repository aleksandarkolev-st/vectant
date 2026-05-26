import type { EventLogEntry } from "../events/types.js";

export interface BrokerOrderingDecision {
  accepted: boolean;
  duplicate: boolean;
  gap_detected: boolean;
  invalidates_input: boolean;
  dedupe_key: string;
  reason: "accepted" | "duplicate" | "control_gap" | "frame_gap";
  expected_next?: number;
  observed?: number;
}

export interface BrokerOrderingState {
  session_id: string;
  last_control_event_id: number;
  last_frame_seq: number | null;
}

export function brokerDedupeKey(event: EventLogEntry, fallbackSessionId = "default"): string {
  const sessionId = eventSessionId(event, fallbackSessionId);
  if (event.kind === "frame") return `${sessionId}:frame:${event.seq}:${event.frame_seq}`;
  return `${sessionId}:control:${event.seq}`;
}

export class BrokerStreamOrderTracker {
  private readonly seen = new Set<string>();
  private readonly states = new Map<string, BrokerOrderingState>();

  constructor(private readonly frameGapThreshold = 1) {}

  accept(event: EventLogEntry, fallbackSessionId = "default"): BrokerOrderingDecision {
    const sessionId = eventSessionId(event, fallbackSessionId);
    const key = brokerDedupeKey(event, fallbackSessionId);
    if (this.seen.has(key)) {
      return {
        accepted: false,
        duplicate: true,
        gap_detected: false,
        invalidates_input: false,
        dedupe_key: key,
        reason: "duplicate",
      };
    }
    this.seen.add(key);
    const state = this.states.get(sessionId) ?? {
      session_id: sessionId,
      last_control_event_id: 0,
      last_frame_seq: null,
    };

    if (event.kind !== "frame") {
      const expected = state.last_control_event_id + 1;
      state.last_control_event_id = Math.max(state.last_control_event_id, event.seq);
      this.states.set(sessionId, state);
      if (event.seq > expected) {
        return {
          accepted: false,
          duplicate: false,
          gap_detected: true,
          invalidates_input: false,
          dedupe_key: key,
          reason: "control_gap",
          expected_next: expected,
          observed: event.seq,
        };
      }
      return accepted(key);
    }

    const previousFrame = state.last_frame_seq;
    state.last_frame_seq = Math.max(state.last_frame_seq ?? event.frame_seq, event.frame_seq);
    this.states.set(sessionId, state);
    if (previousFrame !== null && event.frame_seq - previousFrame > this.frameGapThreshold) {
      return {
        accepted: true,
        duplicate: false,
        gap_detected: true,
        invalidates_input: true,
        dedupe_key: key,
        reason: "frame_gap",
        expected_next: previousFrame + 1,
        observed: event.frame_seq,
      };
    }
    return accepted(key);
  }

  snapshot(sessionId: string): BrokerOrderingState | null {
    const state = this.states.get(sessionId);
    return state ? { ...state } : null;
  }

  clear(): void {
    this.seen.clear();
    this.states.clear();
  }
}

function accepted(dedupeKey: string): BrokerOrderingDecision {
  return {
    accepted: true,
    duplicate: false,
    gap_detected: false,
    invalidates_input: false,
    dedupe_key: dedupeKey,
    reason: "accepted",
  };
}

function eventSessionId(event: EventLogEntry, fallback: string): string {
  if (event.kind === "frame") return event.session_id;
  if (event.kind === "input") {
    const sid = event.payload["session_id"];
    return typeof sid === "string" ? sid : fallback;
  }
  if (event.kind === "lease") {
    const sid = event.payload["session_id"];
    return typeof sid === "string" ? sid : fallback;
  }
  return fallback;
}

export const brokerStreamOrderTracker = new BrokerStreamOrderTracker();
