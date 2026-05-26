import type { BrokerErrorCode } from "./errors.js";

export const BROKER_PROTOCOL_VERSION = 1;

export type BrokerState = "ready" | "recovering" | "degraded" | "disconnected";

export interface BrokerViewport {
  w: number;
  h: number;
  dpr: number;
}

export interface BrokerFrameEvent {
  type: "frame";
  event_id: number;
  session_id: string;
  frame_seq: number;
  frame_ts_ms: number;
  ingest_ts_ms: number;
  viewport: BrokerViewport;
  is_keyframe: boolean;
}

export interface BrokerLifecycleEvent {
  type: "lifecycle";
  event_id: number;
  session_id: string;
  state: "warming" | "ready" | "running" | "hibernated" | "migrating" | "crashed" | "terminated" | "unknown";
  state_ts_ms: number;
  reason?: string;
}

export interface BrokerHealthStatus {
  session_id: string;
  broker_state: BrokerState;
  upstream: {
    connected: boolean;
    last_frame_age_ms: number | null;
    rtt_ms: number | null;
  };
  subscriber: {
    lag_ms: number;
    queue_depth: number;
    dropped_frames: number;
  };
}

export interface BrokerRequestEnvelope {
  protocol_version: number;
  request_id: string;
  idempotency_key: string;
}

export interface BrokerEnvelopeValidationOk {
  ok: true;
  envelope: BrokerRequestEnvelope;
}

export interface BrokerEnvelopeValidationError {
  ok: false;
  error: BrokerErrorCode | "INVALID_ENVELOPE";
  field?: string;
}

export function makeBrokerFrameEvent(input: {
  event_id: number;
  session_id: string;
  frame_seq: number;
  frame_ts_ms: number;
  viewport: BrokerViewport;
  ingest_ts_ms?: number;
  is_keyframe?: boolean;
}): BrokerFrameEvent {
  return {
    type: "frame",
    event_id: input.event_id,
    session_id: input.session_id,
    frame_seq: input.frame_seq,
    frame_ts_ms: input.frame_ts_ms,
    ingest_ts_ms: input.ingest_ts_ms ?? Date.now(),
    viewport: input.viewport,
    is_keyframe: input.is_keyframe ?? false,
  };
}

export function makeBrokerLifecycleEvent(input: {
  event_id: number;
  session_id: string;
  state: BrokerLifecycleEvent["state"];
  state_ts_ms?: number;
  reason?: string;
}): BrokerLifecycleEvent {
  const event: BrokerLifecycleEvent = {
    type: "lifecycle",
    event_id: input.event_id,
    session_id: input.session_id,
    state: input.state,
    state_ts_ms: input.state_ts_ms ?? Date.now(),
  };
  if (input.reason !== undefined) event.reason = input.reason;
  return event;
}

export function makeBrokerHealthStatus(input: {
  session_id: string;
  broker_state: BrokerState;
  upstream_connected: boolean;
  last_frame_age_ms?: number | null;
  rtt_ms?: number | null;
  lag_ms?: number;
  queue_depth?: number;
  dropped_frames?: number;
}): BrokerHealthStatus {
  return {
    session_id: input.session_id,
    broker_state: input.broker_state,
    upstream: {
      connected: input.upstream_connected,
      last_frame_age_ms: input.last_frame_age_ms ?? null,
      rtt_ms: input.rtt_ms ?? null,
    },
    subscriber: {
      lag_ms: input.lag_ms ?? 0,
      queue_depth: input.queue_depth ?? 0,
      dropped_frames: input.dropped_frames ?? 0,
    },
  };
}

export function validateBrokerRequestEnvelope(raw: unknown): BrokerEnvelopeValidationOk | BrokerEnvelopeValidationError {
  if (!raw || typeof raw !== "object") return { ok: false, error: "INVALID_ENVELOPE" };
  const obj = raw as Record<string, unknown>;
  if (obj["protocol_version"] !== BROKER_PROTOCOL_VERSION) {
    return { ok: false, error: "INVALID_ENVELOPE", field: "protocol_version" };
  }
  if (typeof obj["request_id"] !== "string" || obj["request_id"].length === 0) {
    return { ok: false, error: "INVALID_ENVELOPE", field: "request_id" };
  }
  if (typeof obj["idempotency_key"] !== "string" || obj["idempotency_key"].length === 0) {
    return { ok: false, error: "INVALID_ENVELOPE", field: "idempotency_key" };
  }
  return {
    ok: true,
    envelope: {
      protocol_version: BROKER_PROTOCOL_VERSION,
      request_id: obj["request_id"],
      idempotency_key: obj["idempotency_key"],
    },
  };
}
