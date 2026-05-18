import { beforeEach, describe, expect, it } from "vitest";
import { currentBrokerHealthStatus, recordBrokerFrameObservation } from "../../src/broker/index.js";
import { eventLog } from "../../src/events/index.js";
import { resourceUrisForEvent, RESOURCE_URIS } from "../../src/resources/index.js";
import { session } from "../../src/session.js";
import { healthTool } from "../../src/tools/health.js";
import { screenshotTool } from "../../src/tools/screenshot.js";

function installFakeAttached(frameTs: number = Date.now()): void {
  const frame = { data: Buffer.from("not-a-real-png"), width: 800, height: 600, ts: frameTs, seq: 7 };
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake-session",
    signalingUrl: "ws://localhost:9000",
    peer: { pc: { connectionState: "connected" } },
    frames: {
      getFrame: async () => frame,
      hasFrame: () => true,
      dimensions: () => ({ width: 800, height: 600 }),
      latestInfo: () => ({ width: 800, height: 600, ts: frame.ts, seq: frame.seq }),
    },
    buildLogDC: { readyState: "open" },
    terminalDC: { readyState: "open" },
  };
}

describe("broker read-only observation", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("records broker frame metadata into the event log", () => {
    const ev = recordBrokerFrameObservation({
      session_id: "s_1",
      frame: { data: Buffer.alloc(0), width: 320, height: 240, ts: 1000, seq: 3 },
    });
    expect(ev).toMatchObject({
      type: "frame",
      session_id: "s_1",
      frame_seq: 3,
      frame_ts_ms: 1000,
      viewport: { w: 320, h: 240, dpr: 1 },
    });
    const entries = eventLog.query({ kind: "frame" });
    expect(entries).toHaveLength(1);
    expect(resourceUrisForEvent(entries[0]!)).toContain(RESOURCE_URIS.screenshot);
  });

  it("builds health with ready broker state and frame age", () => {
    const now = Date.now();
    installFakeAttached(now - 123);
    const health = currentBrokerHealthStatus(now);
    expect(health).toMatchObject({
      session_id: "fake-session",
      broker_state: "ready",
      upstream: {
        connected: true,
        last_frame_age_ms: 123,
        rtt_ms: null,
      },
      subscriber: {
        lag_ms: 0,
        queue_depth: 0,
        dropped_frames: 0,
      },
    });
  });

  it("health tool exposes broker health when detached", async () => {
    const res = await healthTool({});
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { broker: { broker_state: string; session_id: string } };
    expect(body.broker).toEqual(expect.objectContaining({
      broker_state: "disconnected",
      session_id: "unattached",
    }));
  });
});

describe("synthi_screenshot broker frame metadata", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns a broker_frame envelope for screenshot responses", async () => {
    const sharp = await import("sharp");
    const png = await sharp.default({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    }).png().toBuffer();
    (session as unknown as { state: string }).state = "attached";
    (session as unknown as { attached: unknown }).attached = {
      sessionId: "fake-session",
      signalingUrl: "ws://localhost:9000",
      frames: {
        getFrame: async () => ({ data: png, width: 8, height: 8, ts: 1000, seq: 5 }),
        hasFrame: () => true,
        waitForFirstFrame: async () => {},
        dimensions: () => ({ width: 8, height: 8 }),
      },
    };
    const res = await screenshotTool({});
    expect(res.isError).toBeUndefined();
    const body = res.structuredContent as { broker_frame: { frame_seq: number; event_id: number } };
    expect(body.broker_frame.frame_seq).toBe(5);
    expect(body.broker_frame.event_id).toBeGreaterThan(0);
    expect(eventLog.query({ kind: "frame" })).toHaveLength(1);
  });
});
