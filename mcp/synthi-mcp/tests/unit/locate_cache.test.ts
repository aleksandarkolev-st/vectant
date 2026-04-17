import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { LocateCache, DEFAULT_TTL_MS } from "../../src/locate/cache.js";
import { regionPHash } from "../../src/util/phash.js";

async function gradientPng(w = 200, h = 200, shift = 0): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = (x * 2 + shift) & 0xff;
      raw[i + 1] = (y * 2 + shift) & 0xff;
      raw[i + 2] = ((x + y) * 2) & 0xff;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function solidPng(w = 200, h = 200, color = { r: 10, g: 10, b: 10 }): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = color.r;
    raw[i * 3 + 1] = color.g;
    raw[i * 3 + 2] = color.b;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("LocateCache", () => {
  const bbox = { x: 50, y: 50, w: 40, h: 40 };

  it("reports miss for unknown handle", async () => {
    const cache = new LocateCache();
    const png = await gradientPng();
    const r = await cache.tryResolve("nonexistent", png);
    expect(r.kind).toBe("miss");
  });

  it("returns hit when the frame matches the stored region_phash", async () => {
    const cache = new LocateCache();
    const png = await gradientPng();
    const phash = await regionPHash(png, bbox);
    const now = Date.now();
    cache.put({
      handle_id: "h1",
      description: "gradient region",
      bbox,
      region_phash: phash,
      expires_ts: now + DEFAULT_TTL_MS,
      created_ts: now,
      backend: "mock",
    });
    const r = await cache.tryResolve("h1", png, now);
    expect(r.kind).toBe("hit");
    expect(r.hamming_distance).toBe(0);
  });

  it("returns expired when now >= expires_ts", async () => {
    const cache = new LocateCache();
    const png = await gradientPng();
    const phash = await regionPHash(png, bbox);
    const now = Date.now();
    cache.put({
      handle_id: "h2",
      description: "expired entry",
      bbox,
      region_phash: phash,
      expires_ts: now - 1,
      created_ts: now - DEFAULT_TTL_MS,
      backend: "mock",
    });
    const r = await cache.tryResolve("h2", png, now);
    expect(r.kind).toBe("expired");
  });

  it("returns drift when the region content changed substantially", async () => {
    const cache = new LocateCache(DEFAULT_TTL_MS, /*driftThreshold=*/ 4);
    const gradient = await gradientPng();
    const solid = await solidPng();
    const phashGradient = await regionPHash(gradient, bbox);
    const now = Date.now();
    cache.put({
      handle_id: "h3",
      description: "drifted",
      bbox,
      region_phash: phashGradient,
      expires_ts: now + DEFAULT_TTL_MS,
      created_ts: now,
      backend: "mock",
    });
    const r = await cache.tryResolve("h3", solid, now);
    expect(r.kind).toBe("drift");
    expect(r.hamming_distance ?? 0).toBeGreaterThan(4);
  });

  it("size() + clear() manage entries", async () => {
    const cache = new LocateCache();
    const png = await gradientPng();
    const phash = await regionPHash(png, bbox);
    const now = Date.now();
    cache.put({
      handle_id: "a",
      description: "a",
      bbox,
      region_phash: phash,
      expires_ts: now + 1000,
      created_ts: now,
      backend: "mock",
    });
    cache.put({
      handle_id: "b",
      description: "b",
      bbox,
      region_phash: phash,
      expires_ts: now + 1000,
      created_ts: now,
      backend: "mock",
    });
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
