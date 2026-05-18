import { describe, expect, it } from "vitest";
import {
  queryFailedActionTimeline,
  resolveBrokerReplayRetentionPolicy,
} from "../../src/broker/index.js";
import { EventLog } from "../../src/events/log.js";

describe("broker failed-action timeline replay", () => {
  it("reconstructs failed postcondition actions with correlation fields", () => {
    const log = new EventLog();
    log.push({
      kind: "input",
      action: "mouse:click",
      ts: 1_000,
      payload: {
        tool_call_id: "tc_1",
        session_id: "s1",
        agent_id: "agent_a",
        frame_seq: 10,
        lease_id: "lease_1",
        received_at: 990,
        dispatched_at: 995,
        browser_acked_at: 1_000,
        verified_at: 1_200,
        ack_chain: {
          transport_ack: { ack_id: "ack_tc_1", ts: 995 },
          browser_ack: { accepted: true, ts: 1_000, dispatch_ids: ["d1"] },
          effect_verified: { verified: false, ts: 1_200 },
        },
        detail: {
          postcondition: {
            type: "pixel_match",
            supported: true,
            verified: false,
            evidence: { reason: "timeout" },
          },
        },
      },
    });

    const timeline = queryFailedActionTimeline(log, { session_id: "s1", now: 2_000 });
    expect(timeline.ok).toBe(true);
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]).toMatchObject({
      tool_call_id: "tc_1",
      session_id: "s1",
      agent_id: "agent_a",
      frame_seq: 10,
      lease_id: "lease_1",
      action: "mouse:click",
      failure_code: "EFFECT_NOT_VERIFIED",
      failure_stage: "effect_verified",
      received_at: 990,
      dispatched_at: 995,
      browser_acked_at: 1_000,
      verified_at: 1_200,
    });
  });

  it("groups correlated error events into the timeline", () => {
    const log = new EventLog();
    log.push({
      kind: "input",
      action: "keyboard:type",
      ts: 1_000,
      payload: {
        tool_call_id: "tc_2",
        session_id: "s1",
        agent_id: "agent_a",
        frame_seq: 12,
        lease_id: "lease_2",
        received_at: 990,
        dispatched_at: 995,
        browser_acked_at: 1_000,
        ack_chain: {
          transport_ack: { ack_id: "ack_tc_2", ts: 995 },
          browser_ack: { accepted: true, ts: 1_000, dispatch_ids: ["d2"] },
        },
      },
    });
    log.push({
      kind: "error",
      ts: 1_010,
      code: "FRAME_STALE",
      detail: { tool_call_id: "tc_2", frame_seq: 12 },
    });

    const timeline = queryFailedActionTimeline(log, { tool_call_id: "tc_2", now: 2_000 });
    expect(timeline.entries).toHaveLength(1);
    expect(timeline.entries[0]?.failure_code).toBe("FRAME_STALE");
    expect(timeline.entries[0]?.failure_stage).toBe("error_event");
    expect(timeline.entries[0]?.events.map((event) => event.kind)).toEqual(["input", "error"]);
  });

  it("excludes unverified-but-successful actions and respects horizon filtering", () => {
    const log = new EventLog();
    log.push({
      kind: "input",
      action: "mouse:click",
      ts: 100,
      payload: {
        tool_call_id: "old",
        session_id: "s1",
        received_at: 90,
        dispatched_at: 95,
        unverified_at: 100,
        ack_chain: {
          transport_ack: { ack_id: "ack_old", ts: 95 },
          browser_ack: { accepted: true, ts: 100, dispatch_ids: ["d1"] },
        },
      },
    });
    log.push({
      kind: "input",
      action: "mouse:click",
      ts: 1_000,
      payload: {
        tool_call_id: "new",
        session_id: "s1",
        received_at: 990,
        dispatched_at: 995,
        browser_acked_at: 1_000,
        ack_chain: {
          transport_ack: { ack_id: "ack_new", ts: 995 },
          browser_ack: { accepted: false, ts: 1_000, dispatch_ids: ["d2"] },
        },
      },
    });

    const timeline = queryFailedActionTimeline(log, { now: 1_100, horizon_ms: 500 });
    expect(timeline.entries.map((entry) => entry.tool_call_id)).toEqual(["new"]);
    expect(timeline.entries[0]?.failure_code).toBe("INPUT_ACK_TIMEOUT");
  });

  it("resolves retention policy from deployment flags", () => {
    const policy = resolveBrokerReplayRetentionPolicy({
      SYNTHI_BROKER_REPLAY_SHORT_MS: "60000",
      SYNTHI_BROKER_REPLAY_LONG_MS: "3600000",
      SYNTHI_BROKER_REPLAY_PERSIST_PATH: "/tmp/replay.log",
    } as NodeJS.ProcessEnv);
    expect(policy).toMatchObject({
      short_horizon_ms: 60_000,
      long_horizon_ms: 3_600_000,
      persisted: true,
      persist_path: "/tmp/replay.log",
      max_replay_limit: 500,
    });
  });
});
