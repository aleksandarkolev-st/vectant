import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  BrokerWorkerPool,
  SharedFrameCache,
  SharedInferenceCache,
  promptHash,
} from "../../src/broker/index.js";

async function png(w = 64, h = 64, shift = 0): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 3 + shift) & 0xff;
      raw[i + 1] = (y * 5 + shift) & 0xff;
      raw[i + 2] = ((x ^ y) * 7 + shift) & 0xff;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function put(cache: SharedFrameCache, seq: number, data: Buffer, now = 1_000): void {
  cache.putFrame({
    session_id: "s1",
    frame_seq: seq,
    frame_ts_ms: now,
    ingest_ts_ms: now + 1,
    viewport: { w: 64, h: 64, dpr: 1 },
    data,
    now,
  });
}

describe("shared broker frame cache and worker pool", () => {
  it("stores frames by session+sequence and tracks the latest frame", async () => {
    const cache = new SharedFrameCache();
    const first = await png(64, 64, 0);
    const second = await png(64, 64, 20);
    put(cache, 1, first);
    put(cache, 2, second);

    expect(cache.getFrame("s1", 1, 1_000)?.frame_seq).toBe(1);
    expect(cache.latest("s1", 1_000)?.frame_seq).toBe(2);
    expect(cache.size(1_000)).toBe(2);
  });

  it("coalesces duplicate pHash work for the same frame", async () => {
    const pool = new BrokerWorkerPool(1, 8);
    const cache = new SharedFrameCache(30_000, 8, pool);
    put(cache, 1, await png());

    const [a, b] = await Promise.all([
      cache.computeFramePHash("s1", 1),
      cache.computeFramePHash("s1", 1),
    ]);

    expect(a).toBe(b);
    expect(pool.stats().completed).toBe(1);
  });

  it("detects exact visual duplicates before spending model budget", async () => {
    const cache = new SharedFrameCache();
    const frame = await png();
    put(cache, 1, frame);
    put(cache, 2, frame);

    const result = await cache.isVisuallyDuplicate({
      session_id: "s1",
      previous_frame_seq: 1,
      next_frame_seq: 2,
    });

    expect(result).toMatchObject({
      duplicate: true,
      method: "content_hash",
      hamming_distance: 0,
    });
  });

  it("bounds visual worker concurrency", async () => {
    const pool = new BrokerWorkerPool(2, 8);
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        pool.run(`task:${n}`, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return n;
        })
      )
    );
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(pool.stats().max_observed_active).toBeLessThanOrEqual(2);
  });

  it("caches inference envelopes and marks stale frame results invalid for input", () => {
    const cache = new SharedInferenceCache();
    const hash = promptHash("click the submit button");
    cache.put({
      session_id: "s1",
      frame_seq: 10,
      frame_timestamp_ms: 1_000,
      viewport_size: { w: 800, h: 600 },
      device_pixel_ratio: 1,
      model_version: "gdm-1.4.2",
      confidence: 0.91,
      coordinate_space: "frame_pixels",
      expiry_ms: 10_000,
      valid_for_input: true,
      bbox: { x: 100, y: 200, w: 80, h: 30 },
      prompt_hash: hash,
      provider: "mock",
    });

    const valid = cache.get({
      session_id: "s1",
      frame_seq: 10,
      model_version: "gdm-1.4.2",
      prompt_hash: hash,
      current_frame_seq: 10,
      now: 2_000,
    });
    expect(valid?.valid_for_input).toBe(true);

    const stale = cache.get({
      session_id: "s1",
      frame_seq: 10,
      model_version: "gdm-1.4.2",
      prompt_hash: hash,
      current_frame_seq: 11,
      now: 2_000,
    });
    expect(stale?.valid_for_input).toBe(false);
    expect(cache.stats().hits).toBe(2);
  });
});
