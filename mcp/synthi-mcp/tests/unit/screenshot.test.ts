import { beforeEach, describe, expect, it } from "vitest";
import sharp from "sharp";
import { screenshotTool } from "../../src/tools/screenshot.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

/**
 * These tests stub the session's FrameSink to avoid needing a live
 * WebRTC peer. We inject a `session._resetForTests()`-friendly fake
 * `require()` target. The stubbing is minimal — we monkey-patch the
 * singleton fields just for the duration of each test.
 */

async function solidPng(w: number, h: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = color.r;
    raw[i * 3 + 1] = color.g;
    raw[i * 3 + 2] = color.b;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function installFakeSession(frame: {
  data: Buffer;
  width: number;
  height: number;
  dpr?: number;
  ts: number;
  seq: number;
}): void {
  const dpr = frame.dpr ?? 1;
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake-session",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: frame.width, height: frame.height, dpr },
    frames: {
      getFrame: async () => ({ ...frame, dpr }),
      hasFrame: () => true,
      dimensions: () => ({ width: frame.width, height: frame.height, dpr }),
    },
    // Other fields are not touched by screenshotTool.
  };
}

function installFakeFrameSequence(frames: Array<{
  data: Buffer;
  width: number;
  height: number;
  dpr?: number;
  ts: number;
  seq: number;
}>): void {
  let index = 0;
  const first = frames[0]!;
  const dpr = first.dpr ?? 1;
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake-session",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: first.width, height: first.height, dpr },
    frames: {
      getFrame: async () => {
        const frame = frames[Math.min(index, frames.length - 1)]!;
        index += 1;
        return { ...frame, dpr: frame.dpr ?? dpr };
      },
      hasFrame: () => true,
      dimensions: () => ({ width: first.width, height: first.height, dpr }),
    },
  };
}

describe("synthi_screenshot", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns full frame when no region/scaling specified", async () => {
    const png = await solidPng(400, 300, { r: 255, g: 0, b: 0 });
    installFakeSession({ data: png, width: 400, height: 300, ts: Date.now(), seq: 42 });
    const res = await screenshotTool({});
    expect(res.isError).toBeUndefined();
    const meta = res.structuredContent as { w: number; h: number; seq: number; viewport: { w: number; h: number; dpr: number } };
    expect(meta.w).toBe(400);
    expect(meta.h).toBe(300);
    expect(meta.seq).toBe(42);
    expect(meta.viewport).toEqual({ w: 400, h: 300, dpr: 1 });
  });

  it("crops when region is provided", async () => {
    const png = await solidPng(400, 300, { r: 0, g: 0, b: 255 });
    installFakeSession({ data: png, width: 400, height: 300, ts: Date.now(), seq: 10 });
    const res = await screenshotTool({ region: { x: 100, y: 50, w: 120, h: 80 } });
    expect(res.isError).toBeUndefined();
    const meta = res.structuredContent as { w: number; h: number; region: { x: number; y: number; w: number; h: number } };
    expect(meta.w).toBe(120);
    expect(meta.h).toBe(80);
    expect(meta.region).toEqual({ x: 100, y: 50, w: 120, h: 80 });
  });

  it("clamps out-of-bounds region to the frame", async () => {
    const png = await solidPng(200, 200, { r: 10, g: 10, b: 10 });
    installFakeSession({ data: png, width: 200, height: 200, ts: Date.now(), seq: 1 });
    const res = await screenshotTool({ region: { x: 150, y: 150, w: 200, h: 200 } });
    expect(res.isError).toBeUndefined();
    const meta = res.structuredContent as { w: number; h: number };
    expect(meta.w).toBe(50);
    expect(meta.h).toBe(50);
  });

  it("rejects region entirely off-frame with click_out_of_bounds", async () => {
    const png = await solidPng(200, 200, { r: 10, g: 10, b: 10 });
    installFakeSession({ data: png, width: 200, height: 200, ts: Date.now(), seq: 1 });
    const res = await screenshotTool({ region: { x: 500, y: 500, w: 10, h: 10 } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("click_out_of_bounds");
  });

  it("downscales when max_dim is smaller than the longest edge", async () => {
    const png = await solidPng(1000, 500, { r: 200, g: 100, b: 50 });
    installFakeSession({ data: png, width: 1000, height: 500, ts: Date.now(), seq: 2 });
    const res = await screenshotTool({ max_dim: 400 });
    expect(res.isError).toBeUndefined();
    const meta = res.structuredContent as { w: number; h: number; scaled?: boolean };
    expect(meta.scaled).toBe(true);
    expect(Math.max(meta.w, meta.h)).toBeLessThanOrEqual(400);
  });

  it("returns frame_stale when ts is older than freshness_max_ms", async () => {
    const png = await solidPng(100, 100, { r: 10, g: 10, b: 10 });
    installFakeSession({
      data: png,
      width: 100,
      height: 100,
      ts: Date.now() - 10_000,
      seq: 1,
    });
    const res = await screenshotTool({ freshness_max_ms: 500 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("frame_stale");
  });

  it("rejects invalid region shape", async () => {
    const png = await solidPng(100, 100, { r: 10, g: 10, b: 10 });
    installFakeSession({ data: png, width: 100, height: 100, ts: Date.now(), seq: 1 });
    const res = await screenshotTool({ region: { x: 0, y: 0, w: -1, h: 10 } });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string }).field).toBe("region");
  });

  it("rejects non-integer max_dim", async () => {
    const png = await solidPng(100, 100, { r: 10, g: 10, b: 10 });
    installFakeSession({ data: png, width: 100, height: 100, ts: Date.now(), seq: 1 });
    const res = await screenshotTool({ max_dim: 0 });
    expect(res.isError).toBe(true);
  });

  it("emits a usage event per screenshot", async () => {
    const png = await solidPng(100, 100, { r: 10, g: 10, b: 10 });
    installFakeSession({ data: png, width: 100, height: 100, ts: Date.now(), seq: 1 });
    await screenshotTool({});
    const usage = eventLog.query({ kind: "usage" });
    expect(usage.length).toBe(1);
    expect((usage[0] as { metric: string }).metric).toBe("screenshot");
  });

  it("rejects an unsatisfied HMR frame gate", async () => {
    const png = await solidPng(100, 100, { r: 10, g: 10, b: 10 });
    installFakeSession({ data: png, width: 100, height: 100, ts: Date.now(), seq: 1 });

    const res = await screenshotTool({
      after_frame_gate: { status: "timeout", pipeline_budget_ms: 80 },
    });

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error?: string }).error).toBe("frame_gate_unsatisfied");
  });

  it("waits until the decoded frame satisfies the HMR frame gate", async () => {
    const before = await solidPng(100, 100, { r: 10, g: 10, b: 10 });
    const after = await solidPng(100, 100, { r: 40, g: 80, b: 120 });
    installFakeFrameSequence([
      { data: before, width: 100, height: 100, ts: 1_000, seq: 1 },
      { data: after, width: 100, height: 100, ts: 1_200, seq: 2 },
    ]);

    const res = await screenshotTool({
      after_frame_gate: { status: "satisfied", frame_seq: 2, ts_ms: 1_200 },
      frame_gate_timeout_ms: 100,
    });

    expect(res.isError).toBeUndefined();
    const meta = res.structuredContent as {
      seq: number;
      ts: number;
      frame_gate?: {
        status?: string;
        required_frame_seq?: number;
        required_ts_ms?: number;
        captured_frame_seq?: number;
        captured_ts_ms?: number;
      };
    };
    expect(meta.seq).toBe(2);
    expect(meta.ts).toBe(1_200);
    expect(meta.frame_gate).toMatchObject({
      status: "satisfied",
      required_frame_seq: 2,
      required_ts_ms: 1_200,
      captured_frame_seq: 2,
      captured_ts_ms: 1_200,
    });
  });

  it("returns frame_gate_timeout instead of capturing a stale pre-gate frame", async () => {
    const stale = await solidPng(100, 100, { r: 10, g: 10, b: 10 });
    installFakeFrameSequence([
      { data: stale, width: 100, height: 100, ts: 1_000, seq: 1 },
    ]);

    const res = await screenshotTool({
      after_frame_gate: { status: "satisfied", frame_seq: 2, ts_ms: 1_200 },
      frame_gate_timeout_ms: 0,
    });

    expect(res.isError).toBe(true);
    const body = res.structuredContent as {
      error?: string;
      requested_frame_seq?: number;
      requested_ts_ms?: number;
      latest_frame_seq?: number;
      latest_ts_ms?: number;
    };
    expect(body.error).toBe("frame_gate_timeout");
    expect(body.requested_frame_seq).toBe(2);
    expect(body.requested_ts_ms).toBe(1_200);
    expect(body.latest_frame_seq).toBe(1);
    expect(body.latest_ts_ms).toBe(1_000);
  });
});
