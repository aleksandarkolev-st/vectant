import { beforeEach, describe, expect, it } from "vitest";
import {
  BROKER_SLO_DEFINITIONS,
  BrokerSloRecorder,
  brokerSloDefinitions,
  brokerSloRecorder,
} from "../../src/broker/index.js";
import { BrokerSubscriptionRegistry } from "../../src/broker/subscriptions.js";
import type { BrokerPrincipal } from "../../src/broker/auth.js";

const principal: BrokerPrincipal = {
  subject: "agent",
  role: "read_only",
  tenant_id: "tenant",
  session_ids: ["s1"],
};

describe("broker SLO definitions and gates", () => {
  beforeEach(() => {
    brokerSloRecorder.clear();
  });

  it("defines every rollout SLO with denominator, window, owner, and threshold", () => {
    const definitions = brokerSloDefinitions();
    expect(definitions.map((definition) => definition.name)).toEqual([
      "broker_fanout_latency_p95",
      "screenshot_age_p95",
      "input_ack_timeout_rate",
      "input_postcondition_success_rate",
      "duplicate_inference_reduction",
      "locate_cache_hit_latency_p95",
      "subscriber_frame_drop_rate",
      "broker_recovery_time_p95",
    ]);
    for (const definition of definitions) {
      expect(definition.numerator.length).toBeGreaterThan(0);
      expect(definition.denominator.length).toBeGreaterThan(0);
      expect(definition.start_ts.length).toBeGreaterThan(0);
      expect(definition.end_ts.length).toBeGreaterThan(0);
      expect(definition.window.length).toBeGreaterThan(0);
      expect(definition.owner).toBe("Broker team");
      expect(definition.alert_threshold.length).toBeGreaterThan(0);
    }
    expect(BROKER_SLO_DEFINITIONS).toHaveLength(8);
  });

  it("evaluates p95 latency gates against configured targets", () => {
    const recorder = new BrokerSloRecorder();
    const now = 10_000;
    for (const value of [80, 90, 100, 110, 700]) {
      recorder.recordDuration("screenshot_age_p95", value, now);
    }
    const pass = recorder.evaluate(["screenshot_age_p95"], now);
    expect(pass.ok).toBe(true);
    expect(pass.gates[0]?.observed).toBe(700);

    recorder.recordDuration("screenshot_age_p95", 900, now);
    const fail = recorder.evaluate(["screenshot_age_p95"], now);
    expect(fail.ok).toBe(false);
    expect(fail.gates[0]?.status).toBe("fail");
  });

  it("evaluates rate gates in both directions", () => {
    const recorder = new BrokerSloRecorder();
    const now = 10_000;
    recorder.recordRatio("input_ack_timeout_rate", 1, 1_000, now);
    recorder.recordRatio("input_postcondition_success_rate", 99, 100, now);

    const accepted = recorder.evaluate(["input_ack_timeout_rate", "input_postcondition_success_rate"], now);
    expect(accepted.ok).toBe(true);
    expect(accepted.gates.map((gate) => gate.status)).toEqual(["pass", "pass"]);

    recorder.recordRatio("input_ack_timeout_rate", 10, 1_000, now);
    recorder.recordRatio("input_postcondition_success_rate", 50, 100, now);
    const rejected = recorder.evaluate(["input_ack_timeout_rate", "input_postcondition_success_rate"], now);
    expect(rejected.ok).toBe(false);
    expect(rejected.gates.map((gate) => gate.status)).toEqual(["fail", "fail"]);
  });

  it("marks gates unknown until measured data exists", () => {
    const recorder = new BrokerSloRecorder();
    const result = recorder.evaluate(["broker_recovery_time_p95"], 10_000);
    expect(result.ok).toBe(false);
    expect(result.gates[0]).toMatchObject({
      name: "broker_recovery_time_p95",
      status: "unknown",
      observed: null,
      sample_count: 0,
    });
  });

  it("records fanout latency and subscriber drop samples during publish", () => {
    const registry = new BrokerSubscriptionRegistry();
    const sub = registry.subscribe({
      principal,
      session_id: "s1",
      topics: ["frames"],
      now: 1_000,
    });
    expect(sub.ok).toBe(true);

    registry.publish({
      kind: "frame",
      seq: 1,
      ts: 1_100,
      session_id: "s1",
      frame_seq: 10,
      frame_ts_ms: 1_050,
      ingest_ts_ms: 1_100,
      viewport: { w: 100, h: 100, dpr: 1 },
      is_keyframe: false,
    }, 1_150);
    registry.publish({
      kind: "frame",
      seq: 2,
      ts: 1_200,
      session_id: "s1",
      frame_seq: 11,
      frame_ts_ms: 1_150,
      ingest_ts_ms: 1_200,
      viewport: { w: 100, h: 100, dpr: 1 },
      is_keyframe: false,
    }, 1_260);

    const fanout = brokerSloRecorder.evaluate(["broker_fanout_latency_p95"], 1_260);
    expect(fanout.gates[0]?.observed).toBe(60);
    const drops = brokerSloRecorder.evaluate(["subscriber_frame_drop_rate"], 1_260);
    expect(drops.gates[0]?.observed).toBe(0.5);
  });
});
