import type { EventLog } from "../events/log.js";
import type { EventLogEntry } from "../events/types.js";
import { brokerError, type BrokerErrorPayload } from "./errors.js";

export interface BrokerReplayRequest {
  from_event_id: number;
  to_event_id?: number;
  limit?: number;
}

export interface BrokerReplayOk {
  ok: true;
  events: EventLogEntry[];
  next_event_id?: number;
  last_event_id: number;
}

export interface BrokerReplayError {
  ok: false;
  error: BrokerErrorPayload;
}

export const MAX_REPLAY_LIMIT = 500;
export const DEFAULT_FAILED_ACTION_HORIZON_MS = 15 * 60_000;
export const DEFAULT_LONG_REPLAY_RETENTION_MS = 24 * 60 * 60_000;

export interface BrokerReplayRetentionPolicy {
  short_horizon_ms: number;
  long_horizon_ms: number;
  persisted: boolean;
  persist_path?: string;
  max_replay_limit: number;
}

export interface BrokerFailedActionTimelineRequest {
  session_id?: string;
  tool_call_id?: string;
  since_ts?: number;
  horizon_ms?: number;
  now?: number;
  limit?: number;
}

export interface BrokerFailedActionTimelineEvent {
  seq: number;
  ts: number;
  kind: EventLogEntry["kind"];
  code?: string;
  action?: string;
}

export interface BrokerFailedActionTimelineEntry {
  tool_call_id: string;
  session_id: string;
  agent_id: string | null;
  frame_seq: number | null;
  lease_id: string | null;
  action: string;
  failure_code: string;
  failure_stage: "transport_ack" | "browser_ack" | "effect_verified" | "postcondition" | "error_event";
  received_at: number | null;
  dispatched_at: number | null;
  browser_acked_at: number | null;
  verified_at: number | null;
  unverified_at: number | null;
  ack_chain?: Record<string, unknown>;
  events: BrokerFailedActionTimelineEvent[];
}

export interface BrokerFailedActionTimelineOk {
  ok: true;
  entries: BrokerFailedActionTimelineEntry[];
  from_ts: number;
  to_ts: number;
  last_event_id: number;
  retention: BrokerReplayRetentionPolicy;
}

export function queryBrokerReplay(log: EventLog, request: BrokerReplayRequest): BrokerReplayOk | BrokerReplayError {
  if (!Number.isInteger(request.from_event_id) || request.from_event_id < 0) {
    return { ok: false, error: brokerError("CURSOR_TOO_OLD", { from_event_id: request.from_event_id }) };
  }
  const firstSeq = log.firstSeq();
  if (firstSeq !== null && request.from_event_id < firstSeq - 1) {
    return {
      ok: false,
      error: brokerError("CURSOR_TOO_OLD", {
        from_event_id: request.from_event_id,
        oldest_available_event_id: firstSeq,
      }),
    };
  }
  const boundedLimit = Math.max(1, Math.min(MAX_REPLAY_LIMIT, Math.floor(request.limit ?? MAX_REPLAY_LIMIT)));
  let events = log.query({ since_seq: request.from_event_id, limit: boundedLimit });
  if (request.to_event_id !== undefined) {
    events = events.filter((event) => event.seq <= request.to_event_id!);
  }
  const lastReturned = events[events.length - 1]?.seq ?? request.from_event_id;
  const response: BrokerReplayOk = {
    ok: true,
    events,
    last_event_id: log.lastSeq(),
  };
  if (lastReturned < log.lastSeq() && events.length === boundedLimit) {
    response.next_event_id = lastReturned;
  }
  return response;
}

export function resolveBrokerReplayRetentionPolicy(env: NodeJS.ProcessEnv = process.env): BrokerReplayRetentionPolicy {
  const persistPath = env["SYNTHI_BROKER_REPLAY_PERSIST_PATH"];
  return {
    short_horizon_ms: parsePositiveInt(env["SYNTHI_BROKER_REPLAY_SHORT_MS"], DEFAULT_FAILED_ACTION_HORIZON_MS),
    long_horizon_ms: parsePositiveInt(env["SYNTHI_BROKER_REPLAY_LONG_MS"], DEFAULT_LONG_REPLAY_RETENTION_MS),
    persisted: typeof persistPath === "string" && persistPath.length > 0,
    ...(persistPath ? { persist_path: persistPath } : {}),
    max_replay_limit: MAX_REPLAY_LIMIT,
  };
}

export function queryFailedActionTimeline(
  log: EventLog,
  request: BrokerFailedActionTimelineRequest = {}
): BrokerFailedActionTimelineOk {
  const now = request.now ?? Date.now();
  const policy = resolveBrokerReplayRetentionPolicy();
  const horizonMs = Math.max(1, Math.min(request.horizon_ms ?? policy.short_horizon_ms, policy.long_horizon_ms));
  const fromTs = request.since_ts ?? now - horizonMs;
  const limit = Math.max(1, Math.min(MAX_REPLAY_LIMIT, Math.floor(request.limit ?? MAX_REPLAY_LIMIT)));
  const events = log.query({ since_ts: fromTs });
  const correlatedErrors = new Map<string, EventLogEntry[]>();
  for (const event of events) {
    if (event.kind !== "error") continue;
    const toolCallId = typeof event.detail?.["tool_call_id"] === "string" ? event.detail["tool_call_id"] : null;
    if (!toolCallId) continue;
    const list = correlatedErrors.get(toolCallId) ?? [];
    list.push(event);
    correlatedErrors.set(toolCallId, list);
  }

  const entries: BrokerFailedActionTimelineEntry[] = [];
  for (const event of events) {
    if (event.kind !== "input") continue;
    const payload = event.payload;
    const toolCallId = stringOrNull(payload["tool_call_id"]);
    if (!toolCallId) continue;
    if (request.tool_call_id && request.tool_call_id !== toolCallId) continue;
    const sessionId = stringOrNull(payload["session_id"]) ?? "unknown";
    if (request.session_id && request.session_id !== sessionId) continue;

    const failure = classifyInputFailure(payload, correlatedErrors.get(toolCallId) ?? []);
    if (!failure) continue;

    entries.push({
      tool_call_id: toolCallId,
      session_id: sessionId,
      agent_id: stringOrNull(payload["agent_id"]),
      frame_seq: numberOrNull(payload["frame_seq"]),
      lease_id: stringOrNull(payload["lease_id"]),
      action: event.action,
      failure_code: failure.code,
      failure_stage: failure.stage,
      received_at: numberOrNull(payload["received_at"]),
      dispatched_at: numberOrNull(payload["dispatched_at"]),
      browser_acked_at: numberOrNull(payload["browser_acked_at"]),
      verified_at: numberOrNull(payload["verified_at"]),
      unverified_at: numberOrNull(payload["unverified_at"]),
      ...(isRecord(payload["ack_chain"]) ? { ack_chain: payload["ack_chain"] } : {}),
      events: [
        { seq: event.seq, ts: event.ts, kind: event.kind, action: event.action },
        ...(correlatedErrors.get(toolCallId) ?? []).map((error) => ({
          seq: error.seq,
          ts: error.ts,
          kind: error.kind,
          code: error.kind === "error" ? error.code : undefined,
        })),
      ],
    });
  }

  return {
    ok: true,
    entries: entries.slice(-limit),
    from_ts: fromTs,
    to_ts: now,
    last_event_id: log.lastSeq(),
    retention: policy,
  };
}

function classifyInputFailure(
  payload: Record<string, unknown>,
  errors: EventLogEntry[]
): { code: string; stage: BrokerFailedActionTimelineEntry["failure_stage"] } | null {
  const ackChain = isRecord(payload["ack_chain"]) ? payload["ack_chain"] : null;
  const browserAck = ackChain && isRecord(ackChain["browser_ack"]) ? ackChain["browser_ack"] : null;
  if (browserAck?.["accepted"] === false) {
    return { code: "INPUT_ACK_TIMEOUT", stage: "browser_ack" };
  }
  const detail = isRecord(payload["detail"]) ? payload["detail"] : null;
  const postcondition = detail && isRecord(detail["postcondition"]) ? detail["postcondition"] : null;
  if (postcondition?.["supported"] === false) {
    return { code: "UNSUPPORTED_POSTCONDITION_TYPE", stage: "postcondition" };
  }
  if (postcondition?.["supported"] === true && postcondition["verified"] === false) {
    return { code: "EFFECT_NOT_VERIFIED", stage: "effect_verified" };
  }
  const firstError = errors.find((event) => event.kind === "error");
  if (firstError?.kind === "error") {
    return { code: firstError.code, stage: "error_event" };
  }
  return null;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
