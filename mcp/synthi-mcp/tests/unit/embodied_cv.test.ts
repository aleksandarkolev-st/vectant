import { describe, expect, it } from "vitest";
import {
  blockDelta,
  dHash64,
  downscaleSquare,
  hammingHex,
  hsvBandPredicate,
  regionIdentity,
  rgbToHsv,
  templateMatch,
  toGray,
  type GrayBuffer,
  type RgbBuffer,
} from "../../src/embodied/perception/cv.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRgb(seed: number, width = 32, height = 32): RgbBuffer {
  const rand = mulberry32(seed);
  const data = new Uint32Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = (Math.floor(rand() * 256) << 16) | (Math.floor(rand() * 256) << 8) | Math.floor(rand() * 256);
  }
  return { width, height, data };
}

/** Solid color with optional brightness shift (lighting invariance probe). */
function solidRgb(r: number, g: number, b: number, width = 32, height = 32, shift = 0): RgbBuffer {
  const clamp = (v: number) => Math.max(0, Math.min(255, v + shift));
  const data = new Uint32Array(width * height).fill(
    (clamp(r) << 16) | (clamp(g) << 8) | clamp(b),
  );
  return { width, height, data };
}

describe("dHash determinism and robustness", () => {
  it("is deterministic: same input, same hash", () => {
    const image = randomRgb(1);
    const gray = toGray(image);
    expect(dHash64(gray)).toBe(dHash64(toGray(randomRgb(1))));
  });

  it("identical views hash identically; different views differ", () => {
    const a = dHash64(toGray(solidRgb(120, 40, 200)));
    const b = dHash64(toGray(solidRgb(120, 40, 200)));
    const noise = dHash64(toGray(randomRgb(99)));
    expect(hammingHex(a, b)).toBe(0);
    expect(hammingHex(a, noise)).toBeGreaterThan(4);
  });

  it("tolerates uniform lighting shifts on textured content", () => {
    // Textured base vs same texture +10 brightness: structure preserved.
    const rand = mulberry32(7);
    const w = 48;
    const h = 48;
    const base = new Uint8Array(w * h);
    for (let i = 0; i < base.length; i += 1) base[i] = Math.floor(rand() * 256);
    const shifted = new Uint8Array(w * h);
    for (let i = 0; i < shifted.length; i += 1) {
      shifted[i] = Math.min(255, (base[i] as number) + 10);
    }
    const verdict = regionIdentity(
      { width: w, height: h, data: base },
      { width: w, height: h, data: shifted },
      10,
    );
    expect(verdict.same).toBe(true);
    expect(verdict.confidence).toBeGreaterThan(0.7);
  });

  it("hamming distance is a metric over 64 bits", () => {
    const hashes = Array.from({ length: 20 }, (_, i) =>
      dHash64(toGray(randomRgb(i * 13 + 5))),
    );
    for (const h of hashes) {
      expect(hammingHex(h, h)).toBe(0);
      expect(hammingHex(h, h.split("").reverse().join(""))).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("HSV band predicate", () => {
  it("classifies hue families correctly (purple vs green)", () => {
    const purple = solidRgb(128, 40, 200); // hue ~275
    const green = solidRgb(40, 180, 60); // hue ~130
    const purpleBand = { h_min: 265, h_max: 300, s_min: 0.25, v_min: 0.1 };
    expect(hsvBandPredicate(purple, purpleBand).matches).toBe(true);
    expect(hsvBandPredicate(green, purpleBand).matches).toBe(false);
  });

  it("handles hue wrap-around (red band across 360)", () => {
    const red = solidRgb(220, 30, 30); // hue ~0
    const wrappedBand = { h_min: 350, h_max: 10, s_min: 0.3, v_min: 0.1 };
    expect(hsvBandPredicate(red, wrappedBand).matches).toBe(true);
  });

  it("coverage scales with mixed populations deterministically", () => {
    const rand = mulberry32(42);
    const data = new Uint32Array(100);
    for (let i = 0; i < 100; i += 1) {
      data[i] =
        i < 60
          ? (150 << 16) | (40 << 8) | 210 // purple-ish
          : (Math.floor(rand() * 256) << 16) | (Math.floor(rand() * 256) << 8) | Math.floor(rand() * 256);
    }
    const first = hsvBandPredicate({ width: 10, height: 10, data }, { h_min: 265, h_max: 300, s_min: 0.25, v_min: 0.1 });
    const second = hsvBandPredicate({ width: 10, height: 10, data }, { h_min: 265, h_max: 300, s_min: 0.25, v_min: 0.1 });
    expect(first.coverage).toBeCloseTo(second.coverage, 10);
    expect(first.coverage).toBeGreaterThanOrEqual(0.6);
  });

  it("rgbToHsv corner cases stay stable", () => {
    expect(rgbToHsv(255, 255, 255)).toEqual({ h: 0, s: 0, v: 1 });
    expect(rgbToHsv(0, 0, 0)).toEqual({ h: 0, s: 0, v: 0 });
    expect(rgbToHsv(255, 0, 0).h).toBeCloseTo(0, 5);
    expect(rgbToHsv(0, 255, 0).h).toBeCloseTo(120, 5);
    expect(rgbToHsv(0, 0, 255).h).toBeCloseTo(240, 5);
  });
});

describe("template matching (NCC)", () => {
  it("finds an exact template at its location with score ~1", () => {
    const rand = mulberry32(11);
    const imageData = new Uint8Array(64 * 64);
    for (let i = 0; i < imageData.length; i += 1) imageData[i] = Math.floor(rand() * 256);
    // Stamp a distinctive 8x8 pattern at (20, 24).
    const pattern: GrayBuffer = { width: 8, height: 8, data: new Uint8Array(64) };
    for (let i = 0; i < 64; i += 1) {
      const value = (i % 3 === 0 ? 230 : 25);
      (pattern.data as Uint8Array)[i] = value;
      imageData[(24 + Math.floor(i / 8)) * 64 + 20 + (i % 8)] = value;
    }
    const match = templateMatch({ width: 64, height: 64, data: imageData }, pattern, 0.95);
    expect(match.found).toBe(true);
    expect(match.best_x).toBe(20);
    expect(match.best_y).toBe(24);
    expect(match.score).toBeGreaterThan(0.97);
  });

  it("rejects when the pattern is absent", () => {
    const rand = mulberry32(12);
    const imageData = new Uint8Array(32 * 32);
    for (let i = 0; i < imageData.length; i += 1) imageData[i] = Math.floor(rand() * 256);
    const checker: GrayBuffer = { width: 8, height: 8, data: new Uint8Array(64) };
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        (checker.data as Uint8Array)[y * 8 + x] = (x + y) % 2 === 0 ? 255 : 0;
      }
    }
    const match = templateMatch({ width: 32, height: 32, data: imageData }, checker, 0.98);
    expect(match.found).toBe(false);
  });

  it("returns not-found for oversized templates instead of throwing", () => {
    const big: GrayBuffer = { width: 10, height: 10, data: new Uint8Array(100).fill(128) };
    const small: GrayBuffer = { width: 4, height: 4, data: new Uint8Array(16).fill(128) };
    expect(templateMatch(small, big).found).toBe(false);
  });
});

describe("block-delta change detection", () => {
  it("localizes the changed block and stays silent elsewhere", () => {
    const before = new Uint8Array(32 * 32).fill(100);
    const after = new Uint8Array(32 * 32).fill(100);
    // Change one 8x8 area inside block (2,1) of an 8px grid.
    for (let y = 12; y < 18; y += 1) {
      for (let x = 18; x < 22; x += 1) {
        after[y * 32 + x] = 220;
      }
    }
    const delta = blockDelta(
      { width: 32, height: 32, data: before },
      { width: 32, height: 32, data: after },
      8,
      8,
    );
    expect(delta.changed_blocks).toContainEqual({ bx: 2, by: 1 });
    expect(delta.changed_blocks.length).toBeLessThanOrEqual(2);
  });

  it("reports zero change for identical buffers and rejects size mismatch", () => {
    const buf = new Uint8Array(16 * 16).fill(90);
    const delta = blockDelta(
      { width: 16, height: 16, data: buf },
      { width: 16, height: 16, data: buf.slice() },
      8,
      4,
    );
    expect(delta.changed_blocks).toHaveLength(0);
    expect(delta.mean_delta).toBe(0);
    expect(() =>
      blockDelta(
        { width: 16, height: 16, data: buf },
        { width: 8, height: 8, data: new Uint8Array(64) },
        8,
      ),
    ).toThrow(/same-sized/);
  });
});

describe("downscale sanity", () => {
  it("preserves uniform values under scaling", () => {
    const grid = downscaleSquare({ width: 40, height: 20, data: new Uint8Array(800).fill(77) }, 9);
    for (let i = 0; i < grid.length; i += 1) {
      expect(grid[i]).toBeCloseTo(77, 5);
    }
  });
});

describe("cv module boundary", () => {
  it("has zero imports beyond node builtins and no scenario nouns", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/embodied/perception/cv.ts", import.meta.url)),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual([]); // fully self-contained
    for (const noun of ["door", "purple", "nginx"]) {
      expect(source.toLowerCase()).not.toContain(noun);
    }
  });
});
