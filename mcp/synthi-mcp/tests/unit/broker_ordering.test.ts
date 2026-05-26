import { describe, expect, it } from "vitest";
import {
  BrokerStreamOrderTracker,
  brokerDedupeKey,
} from "../../src/broker/index.js";

describe("broker stream ordering semantics", () => {
  it("builds stable dedupe keys for control and frame events", () => {
    expect(brokerDedupeKey({
      kind: "frame",
      seq: 7,
      ts: 1,
      session_id: "s1",
      frame_seq: 42,
      frame_ts_ms: 1,
      ingest_ts_ms: 2,
      viewport: { w: 100, h: 100, dpr: 1 },
      is_keyframe: false,
    })).toBe("s1:frame:7:42");
    expect(brokerDedupeKey({
      kind: "input",
      seq: 8,
      ts: 1,
      action: "mouse:click",
      payload: { session_id: "s1" },
    })).toBe("s1:control:8");
  });

  it("rejects duplicate control events", () => {
    const tracker = new BrokerStreamOrderTracker();
    const event = {
      kind: "input" as const,
      seq: 1,
      ts: 1,
      action: "mouse:click",
      payload: { session_id: "s1" },
    };
    expect(tracker.accept(event).accepted).toBe(true);
    const duplicate = tracker.accept(event);
    expect(duplicate).toMatchObject({
      accepted: false,
      duplicate: true,
      reason: "duplicate",
    });
  });

  it("detects control-event gaps and tells clients to resume", () => {
    const tracker = new BrokerStreamOrderTracker();
    tracker.accept({
      kind: "input",
      seq: 1,
      ts: 1,
      action: "mouse:move",
      payload: { session_id: "s1" },
    });
    const gap = tracker.accept({
      kind: "input",
      seq: 4,
      ts: 2,
      action: "mouse:click",
      payload: { session_id: "s1" },
    });
    expect(gap).toMatchObject({
      accepted: false,
      gap_detected: true,
      reason: "control_gap",
      expected_next: 2,
      observed: 4,
    });
  });

  it("marks frame-sequence gaps as input-invalidating without rejecting frame metadata", () => {
    const tracker = new BrokerStreamOrderTracker(1);
    tracker.accept({
      kind: "frame",
      seq: 1,
      ts: 1,
      session_id: "s1",
      frame_seq: 10,
      frame_ts_ms: 1,
      ingest_ts_ms: 2,
      viewport: { w: 100, h: 100, dpr: 1 },
      is_keyframe: false,
    });
    const gap = tracker.accept({
      kind: "frame",
      seq: 2,
      ts: 2,
      session_id: "s1",
      frame_seq: 13,
      frame_ts_ms: 2,
      ingest_ts_ms: 3,
      viewport: { w: 100, h: 100, dpr: 1 },
      is_keyframe: false,
    });
    expect(gap).toMatchObject({
      accepted: true,
      gap_detected: true,
      invalidates_input: true,
      reason: "frame_gap",
      expected_next: 11,
      observed: 13,
    });
  });
});
