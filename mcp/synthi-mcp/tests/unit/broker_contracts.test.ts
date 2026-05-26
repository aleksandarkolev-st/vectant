import { describe, expect, it } from "vitest";
import {
  BROKER_ERROR_CODES,
  BROKER_PROTOCOL_VERSION,
  IdempotencyStore,
  brokerError,
  makeBrokerFrameEvent,
  makeBrokerHealthStatus,
  normalizeBrokerErrorCode,
  queryBrokerReplay,
  stablePayloadHash,
  validateBrokerRequestEnvelope,
} from "../../src/broker/index.js";
import { EventLog } from "../../src/events/log.js";

describe("broker error taxonomy", () => {
  it("normalizes legacy MCP error names into broker codes", () => {
    expect(normalizeBrokerErrorCode("frame_stale")).toBe("FRAME_STALE");
    expect(normalizeBrokerErrorCode("input_ack_timeout")).toBe("INPUT_ACK_TIMEOUT");
    expect(normalizeBrokerErrorCode("lease_already_held")).toBe("LEASE_DENIED");
  });

  it("builds grouped normalized error payloads", () => {
    const payload = brokerError("LEASE_REQUIRED", { lease_id: null });
    expect(payload).toMatchObject({
      error: "LEASE_REQUIRED",
      error_code: "LEASE_REQUIRED",
      category: "lease",
      retryable: false,
    });
    expect(payload.detail).toEqual({ lease_id: null });
  });

  it("exports the required rollout error set", () => {
    expect(BROKER_ERROR_CODES).toContain("BROKER_RECOVERING");
    expect(BROKER_ERROR_CODES).toContain("DUPLICATE_PRODUCER_REJECTED");
    expect(BROKER_ERROR_CODES).toContain("SUBSCRIBER_LAGGING");
  });
});

describe("broker contracts", () => {
  it("builds frame and health envelopes", () => {
    const frame = makeBrokerFrameEvent({
      event_id: 7,
      session_id: "s_1",
      frame_seq: 42,
      frame_ts_ms: 1000,
      ingest_ts_ms: 1010,
      viewport: { w: 800, h: 600, dpr: 1 },
    });
    expect(frame).toEqual({
      type: "frame",
      event_id: 7,
      session_id: "s_1",
      frame_seq: 42,
      frame_ts_ms: 1000,
      ingest_ts_ms: 1010,
      viewport: { w: 800, h: 600, dpr: 1 },
      is_keyframe: false,
    });

    const health = makeBrokerHealthStatus({
      session_id: "s_1",
      broker_state: "ready",
      upstream_connected: true,
      last_frame_age_ms: 12,
    });
    expect(health.upstream.connected).toBe(true);
    expect(health.subscriber.queue_depth).toBe(0);
  });

  it("validates common broker request envelope fields", () => {
    expect(validateBrokerRequestEnvelope({
      protocol_version: BROKER_PROTOCOL_VERSION,
      request_id: "req_1",
      idempotency_key: "idem_1",
    }).ok).toBe(true);
    const bad = validateBrokerRequestEnvelope({ protocol_version: 999, request_id: "r", idempotency_key: "i" });
    expect(bad).toEqual({ ok: false, error: "INVALID_ENVELOPE", field: "protocol_version" });
  });
});

describe("broker idempotency", () => {
  it("replays matching payloads and conflicts on mismatched payloads", () => {
    const store = new IdempotencyStore(1000);
    const a = store.remember({
      scope: "agent:endpoint:s_1",
      idempotency_key: "idem",
      payload: { b: 2, a: 1 },
      response: { ok: true },
      now: 10,
    });
    expect(a.status).toBe("stored");
    const replay = store.remember({
      scope: "agent:endpoint:s_1",
      idempotency_key: "idem",
      payload: { a: 1, b: 2 },
      response: { ok: false },
      now: 20,
    });
    expect(replay.status).toBe("replay");
    expect(replay.record.response).toEqual({ ok: true });
    const conflict = store.remember({
      scope: "agent:endpoint:s_1",
      idempotency_key: "idem",
      payload: { a: 1, b: 3 },
      response: { ok: false },
      now: 30,
    });
    expect(conflict.status).toBe("conflict");
  });

  it("hashes object payloads independent of key order", () => {
    expect(stablePayloadHash({ z: [1, 2], a: true })).toBe(stablePayloadHash({ a: true, z: [1, 2] }));
  });
});

describe("broker replay cursor", () => {
  it("returns events after the cursor and a next cursor when bounded", () => {
    const log = new EventLog(10);
    log.push({ kind: "lifecycle", state: "ready" });
    log.push({ kind: "lifecycle", state: "running" });
    log.push({ kind: "console", level: "info", message: "hello", source: "mcp_internal" });
    const replay = queryBrokerReplay(log, { from_event_id: 1, limit: 1 });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unexpected replay error");
    expect(replay.events.map((e) => e.seq)).toEqual([2]);
    expect(replay.next_event_id).toBe(2);
    expect(replay.last_event_id).toBe(3);
  });

  it("returns CURSOR_TOO_OLD once the ring has evicted the cursor", () => {
    const log = new EventLog(2);
    log.push({ kind: "lifecycle", state: "ready" });
    log.push({ kind: "lifecycle", state: "running" });
    log.push({ kind: "lifecycle", state: "terminated" });
    const replay = queryBrokerReplay(log, { from_event_id: 0 });
    expect(replay.ok).toBe(false);
    if (replay.ok) throw new Error("unexpected replay success");
    expect(replay.error.error).toBe("CURSOR_TOO_OLD");
  });
});
