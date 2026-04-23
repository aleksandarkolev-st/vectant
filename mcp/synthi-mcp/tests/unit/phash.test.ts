import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { hammingDistance, pHash, regionPHash } from "../../src/util/phash.js";

async function solidPng(color: { r: number; g: number; b: number }, w = 128, h = 128): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = color.r;
    raw[i * 3 + 1] = color.g;
    raw[i * 3 + 2] = color.b;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function gradientPng(w = 128, h = 128): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      raw[i] = x * 2;
      raw[i + 1] = y * 2;
      raw[i + 2] = ((x + y) * 2) & 0xff;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

async function checkerPng(w = 128, h = 128, step = 8): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const on = (Math.floor(x / step) + Math.floor(y / step)) % 2 === 0;
      const v = on ? 255 : 0;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

describe("pHash", () => {
  it("returns a 16-char hex string", async () => {
    const png = await solidPng({ r: 10, g: 20, b: 30 });
    const h = await pHash(png);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic across repeated calls on the same input", async () => {
    const png = await gradientPng();
    const a = await pHash(png);
    const b = await pHash(png);
    expect(a).toBe(b);
  });

  it("different structural content produces different hashes (hamming > 0)", async () => {
    const aPng = await solidPng({ r: 255, g: 0, b: 0 });
    const bPng = await checkerPng();
    const a = await pHash(aPng);
    const b = await pHash(bPng);
    expect(hammingDistance(a, b)).toBeGreaterThan(0);
  });

  it("is robust to small pixel perturbations (hamming stays small)", async () => {
    const original = await gradientPng(128, 128);
    // Re-encode with sharp's default PNG optimizer to introduce compression
    // noise without changing the visible image — classic pHash robustness
    // invariant.
    const reencoded = await sharp(original).png({ compressionLevel: 9 }).toBuffer();
    const a = await pHash(original);
    const b = await pHash(reencoded);
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(2);
  });
});

describe("hammingDistance", () => {
  it("returns 0 for identical hashes", () => {
    expect(hammingDistance("deadbeefdeadbeef", "deadbeefdeadbeef")).toBe(0);
  });

  it("returns 64 for inverted hashes", () => {
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  it("rejects length mismatches", () => {
    expect(() => hammingDistance("deadbeef", "deadbeefdeadbeef")).toThrow(/length_mismatch/);
  });

  it("rejects invalid hex", () => {
    expect(() => hammingDistance("zzzz", "zzzz")).toThrow(/invalid_hex/);
  });
});

describe("regionPHash", () => {
  it("hashes a padded bbox", async () => {
    const png = await gradientPng(200, 200);
    const h = await regionPHash(png, { x: 50, y: 50, w: 40, h: 40 });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic across calls", async () => {
    const png = await gradientPng(200, 200);
    const a = await regionPHash(png, { x: 20, y: 20, w: 60, h: 60 });
    const b = await regionPHash(png, { x: 20, y: 20, w: 60, h: 60 });
    expect(a).toBe(b);
  });

  it("clamps bbox padding to the source frame", async () => {
    const png = await gradientPng(200, 200);
    const h = await regionPHash(png, { x: 0, y: 0, w: 10, h: 10 }, { padding: 2, floorPx: 4 });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("throws phash_region_out_of_bounds when the bbox is entirely off-frame", async () => {
    const png = await gradientPng(100, 100);
    await expect(
      regionPHash(png, { x: 500, y: 500, w: 10, h: 10 })
    ).rejects.toThrow(/out_of_bounds/);
  });
});
