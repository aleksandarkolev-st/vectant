/**
 * Shared computer-vision primitives for pixel-level perception.
 *
 * The plan's rule: adapters never implement pixel math. They declare WHICH
 * primitive + parameters in their schema's perception bindings; this module
 * is the only implementation. All functions are pure, deterministic, and
 * operate on plain {width, height, data} grayscale or packed-RGB buffers so
 * the module has zero dependencies.
 *
 * Every verdict carries a confidence; pixel-derived predicates are treated
 * like T3/T4 affordances (valid but below structural).
 */

export interface GrayBuffer {
  width: number;
  height: number;
  /** Row-major grayscale, 0..255. */
  data: Uint8Array | number[];
}

export interface RgbBuffer {
  width: number;
  height: number;
  /** Row-major packed 0xRRGGBB integers. */
  data: Uint32Array | number[];
}

// ---------------------------------------------------------------------------
// Grayscale + downscaling helpers
// ---------------------------------------------------------------------------

export function toGray(image: RgbBuffer): GrayBuffer {
  const { width, height, data } = image;
  const out = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const pixel = data[i] as number;
    const r = (pixel >> 16) & 0xff;
    const g = (pixel >> 8) & 0xff;
    const b = pixel & 0xff;
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width, height, data: out };
}

/** Box-filter downscale to exactly size x size grayscale. */
export function downscaleSquare(
  gray: GrayBuffer,
  size: number,
): Float64Array {
  const out = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor((x * gray.width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * gray.width) / size));
      const y0 = Math.floor((y * gray.height) / size);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * gray.height) / size));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1 && yy < gray.height; yy += 1) {
        for (let xx = x0; xx < x1 && xx < gray.width; xx += 1) {
          sum += gray.data[yy * gray.width + xx] as number;
          count += 1;
        }
      }
      out[y * size + x] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** Crop a rectangular region into its own gray buffer. */
export function cropRegion(
  gray: GrayBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
): GrayBuffer {
  const out = new Uint8Array(w * h);
  for (let row = 0; row < h; row += 1) {
    for (let col = 0; col < w; col += 1) {
      const srcY = Math.min(gray.height - 1, y + row);
      const srcX = Math.min(gray.width - 1, x + col);
      out[row * w + col] = gray.data[srcY * gray.width + srcX] as number;
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// Perceptual hash (dHash 64-bit, hex string) — region/view identity
// ---------------------------------------------------------------------------

/**
 * Difference hash over a 9x8 grayscale grid: bit (x,y) = gray[x][y] > gray[x+1][y].
 * Robust to compression, scaling, and minor lighting shifts. Identical inputs
 * always produce identical hashes (determinism requirement).
 */
export function dHash64(gray: GrayBuffer): string {
  const S = 9;
  const grid = downscaleSquare(gray, S);
  let hash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = grid[y * S + x] as number;
      const right = grid[y * S + x + 1] as number;
      if (left > right) {
        hash |= 1n << BigInt(y * 8 + x);
      }
    }
  }
  return hash.toString(16).padStart(16, "0");
}

/** Hamming distance between two dHash hex strings (0..64). */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  const wideA = BigInt(`0x${a}`);
  const wideB = BigInt(`0x${b}`);
  let xor = wideA ^ wideB;
  let count = 0;
  while (xor !== 0n) {
    count += 1;
    xor &= xor - 1n;
  }
  return count;
}

export interface RegionIdentityVerdict {
  same: boolean;
  distance: number;
  confidence: number;
}

/** Region identity decision with linear confidence falloff. */
export function regionIdentity(
  a: GrayBuffer,
  b: GrayBuffer,
  maxDistance = 10,
): RegionIdentityVerdict {
  const distance = hammingHex(dHash64(a), dHash64(b));
  const same = distance <= maxDistance;
  const confidence = Math.max(0, Math.min(1, 1 - distance / 64));
  return { same, distance, confidence };
}

// ---------------------------------------------------------------------------
// HSV band predicate — appearance-class primitive
// ---------------------------------------------------------------------------

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) h = (((gn - bn) / delta) % 6 + 6) % 6 * 60;
    else if (max === gn) h = ((bn - rn) / delta + 2) * 60;
    else h = ((rn - gn) / delta + 4) * 60;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max };
}

export interface HsvBand {
  /** Hue range in degrees, 0..360; wraps if min > max. */
  h_min: number;
  h_max: number;
  s_min: number;
  v_min: number;
}

export interface BandVerdict {
  matches: boolean;
  /** Fraction of pixels inside the band (0..1). */
  coverage: number;
  confidence: number;
}

/**
 * Evaluate a hue/sat/value band over an RGB region. Deterministic: same
 * buffer + band => same verdict. Confidence equals coverage clamped to [0,1]
 * — callers treat sub-structural verdicts per plan rules.
 */
export function hsvBandPredicate(
  image: RgbBuffer,
  band: HsvBand,
): BandVerdict {
  const total = image.width * image.height;
  let inside = 0;
  for (let i = 0; i < total; i += 1) {
    const pixel = image.data[i] as number;
    const { h, s, v } = rgbToHsv((pixel >> 16) & 0xff, (pixel >> 8) & 0xff, pixel & 0xff);
    const hueOk =
      band.h_min <= band.h_max
        ? h >= band.h_min && h <= band.h_max
        : h >= band.h_min || h <= band.h_max; // wrap around 360
    if (hueOk && s >= band.s_min && v >= band.v_min) inside += 1;
  }
  const coverage = total === 0 ? 0 : inside / total;
  return { matches: coverage >= 0.5, coverage, confidence: Math.min(1, coverage * 2) };
}

// ---------------------------------------------------------------------------
// Template matching — normalized cross-correlation over grayscale
// ---------------------------------------------------------------------------

export interface MatchVerdict {
  best_x: number;
  best_y: number;
  score: number;
  found: boolean;
  confidence: number;
}

function meanOf(buf: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) sum += buf[i] as number;
  return buf.length === 0 ? 0 : sum / buf.length;
}

/**
 * Sliding-window NCC of `template` over `image`. Returns the best position
 * and score in [-1, 1]. found = score >= threshold. O(W*H*w*h); intended for
 * small templates/regions, with the block-delta pre-filter run first.
 */
export function templateMatch(
  image: GrayBuffer,
  template: GrayBuffer,
  threshold = 0.9,
): MatchVerdict {
  const iw = image.width;
  const ih = image.height;
  const tw = template.width;
  const th = template.height;
  if (tw > iw || th > ih || tw === 0 || th === 0) {
    return { best_x: -1, best_y: -1, score: -1, found: false, confidence: 0 };
  }
  const tMean = meanOf(Float64Array.from(template.data as number[]));
  let tVar = 0;
  for (let i = 0; i < tw * th; i += 1) {
    const d = (template.data[i] as number) - tMean;
    tVar += d * d;
  }
  const tNorm = Math.sqrt(tVar) || 1e-9;

  let bestScore = -2;
  let bestX = -1;
  let bestY = -1;
  for (let y = 0; y + th <= ih; y += 1) {
    for (let x = 0; x + tw <= iw; x += 1) {
      let wSum = 0;
      let iVar = 0;
      let cross = 0;
      // First pass for window mean.
      for (let ty = 0; ty < th; ty += 1) {
        for (let tx = 0; tx < tw; tx += 1) {
          wSum += image.data[(y + ty) * iw + x + tx] as number;
        }
      }
      const wMean = wSum / (tw * th);
      // Second pass for variance and correlation.
      for (let ty = 0; ty < th; ty += 1) {
        for (let tx = 0; tx < tw; tx += 1) {
          const iv = (image.data[(y + ty) * iw + x + tx] as number) - wMean;
          const tv = (template.data[ty * tw + tx] as number) - tMean;
          iVar += iv * iv;
          cross += iv * tv;
        }
      }
      const score = cross / (Math.sqrt(iVar) * tNorm || 1e-9);
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
        bestY = y;
      }
    }
  }
  const finalScore = Math.max(-1, Math.min(1, bestScore));
  return {
    best_x: bestX,
    best_y: bestY,
    score: finalScore,
    found: finalScore >= threshold,
    confidence: (finalScore + 1) / 2,
  };
}

// ---------------------------------------------------------------------------
// Block-delta change detection — cheap pre-filter before expensive CV
// ---------------------------------------------------------------------------

export interface BlockDelta {
  changed_blocks: Array<{ bx: number; by: number }>;
  /** Mean absolute difference across all blocks (0..255). */
  mean_delta: number;
}

/**
 * Compare two same-sized gray buffers on a block grid. A block "changed"
 * when its mean absolute difference exceeds `threshold`. Deterministic.
 */
export function blockDelta(
  a: GrayBuffer,
  b: GrayBuffer,
  blockSize: number,
  threshold = 8,
): BlockDelta {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("blockDelta requires same-sized buffers");
  }
  const blocksX = Math.ceil(a.width / blockSize);
  const blocksY = Math.ceil(a.height / blockSize);
  const changed: Array<{ bx: number; by: number }> = [];
  let totalDelta = 0;
  for (let by = 0; by < blocksY; by += 1) {
    for (let bx = 0; bx < blocksX; bx += 1) {
      let sum = 0;
      let count = 0;
      for (let y = by * blockSize; y < Math.min((by + 1) * blockSize, a.height); y += 1) {
        for (let x = bx * blockSize; x < Math.min((bx + 1) * blockSize, a.width); x += 1) {
          const d = Math.abs(
            (a.data[y * a.width + x] as number) - (b.data[y * b.width + x] as number),
          );
          sum += d;
          count += 1;
        }
      }
      const mean = count > 0 ? sum / count : 0;
      totalDelta += mean;
      if (mean > threshold) changed.push({ bx, by });
    }
  }
  return { changed_blocks: changed, mean_delta: totalDelta / (blocksX * blocksY) };
}
