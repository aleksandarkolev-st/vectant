import sharp from "sharp";

/**
 * 64-bit perceptual hash via 2D DCT on a 32×32 grayscale downsample.
 *
 * Algorithm (classic pHash):
 *   1. Decode input PNG → 32×32 grayscale raw pixels.
 *   2. 2D DCT-II on the 1024-pixel matrix.
 *   3. Take the top-left 8×8 block (low-frequency coefficients).
 *   4. Median over positions 1..63 (skip DC at [0,0]).
 *   5. Each output bit = 1 if the corresponding coefficient > median.
 *
 * Output: 16-char lowercase hex string (64 bits, big-endian).
 *
 * Determinism: this runs in the main event loop; the DCT is O(N²·M²)
 * = ~1M float ops at N=32. Acceptable for spike and phase 1 region
 * hashing (regions are small), but hot paths should switch to a
 * native binding if profiling shows it.
 */
export async function pHash(png: Buffer): Promise<string> {
  const raw = await sharp(png)
    .removeAlpha()
    .grayscale()
    .resize(32, 32, { fit: "fill" })
    .raw()
    .toBuffer();

  const pixels = new Float64Array(32 * 32);
  for (let i = 0; i < 32 * 32; i++) pixels[i] = raw[i] ?? 0;

  const dct = dct2d32(pixels);

  const coeffs: number[] = [];
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      coeffs.push(dct[u * 32 + v]!);
    }
  }

  const nonDC = coeffs.slice(1);
  const sorted = [...nonDC].sort((a, b) => a - b);
  const median = (sorted[30]! + sorted[31]!) / 2;

  let hi = 0n;
  let lo = 0n;
  for (let i = 0; i < 64; i++) {
    const c = coeffs[i]!;
    const bit = c > median ? 1n : 0n;
    if (i < 32) lo |= bit << BigInt(i);
    else hi |= bit << BigInt(i - 32);
  }
  const hex = hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
  return hex;
}

/** Pre-computed DCT-II cosine table for N=32. */
const DCT_TABLE_N = 32;
const dctTable: Float64Array = (() => {
  const t = new Float64Array(DCT_TABLE_N * DCT_TABLE_N);
  for (let k = 0; k < DCT_TABLE_N; k++) {
    for (let n = 0; n < DCT_TABLE_N; n++) {
      t[k * DCT_TABLE_N + n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * DCT_TABLE_N));
    }
  }
  return t;
})();

/**
 * Separable 2D DCT-II on a 32×32 input. O(N³) = 32k ops * 2 passes = 64k ops,
 * much faster than the naive O(N⁴) direct form. Only the top-left 8×8 block
 * is eventually read, but we compute the full matrix to keep the function
 * self-contained (future callers may want more coefficients).
 */
function dct2d32(input: Float64Array): Float64Array {
  const N = DCT_TABLE_N;
  const row = new Float64Array(N * N);
  // Pass 1: DCT along rows.
  for (let x = 0; x < N; x++) {
    for (let u = 0; u < N; u++) {
      let sum = 0;
      for (let n = 0; n < N; n++) {
        sum += input[x * N + n]! * dctTable[u * N + n]!;
      }
      row[x * N + u] = sum;
    }
  }
  const out = new Float64Array(N * N);
  // Pass 2: DCT along columns.
  for (let u = 0; u < N; u++) {
    for (let v = 0; v < N; v++) {
      let sum = 0;
      for (let x = 0; x < N; x++) {
        sum += row[x * N + u]! * dctTable[v * N + x]!;
      }
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      const cv = v === 0 ? 1 / Math.SQRT2 : 1;
      out[v * N + u] = 0.25 * cu * cv * sum;
    }
  }
  return out;
}

/**
 * Hamming distance between two hex-encoded 64-bit hashes. Lower = more
 * similar. Identical inputs → 0. Uniform random inputs → ~32.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`phash_length_mismatch (a=${a.length}, b=${b.length})`);
  }
  let ba: bigint;
  let bb: bigint;
  try {
    ba = BigInt(`0x${a}`);
    bb = BigInt(`0x${b}`);
  } catch {
    throw new Error("phash_invalid_hex");
  }
  let xor = ba ^ bb;
  let dist = 0;
  while (xor > 0n) {
    if (xor & 1n) dist++;
    xor >>= 1n;
  }
  return dist;
}

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Region-pHash. Crops the bbox plus padding from the source PNG, then pHashes
 * the crop. Padding defaults to ±20% of each side with an 8 px floor —
 * matches `AGENT_MCP_ULTRAPLAN.md:1380` region semantics.
 *
 * Throws `phash_region_out_of_bounds` if the bbox is entirely outside the
 * source frame; sharp will silently clamp otherwise. We validate up front.
 */
export async function regionPHash(
  png: Buffer,
  bbox: BBox,
  opts: { padding?: number; floorPx?: number } = {}
): Promise<string> {
  const padding = opts.padding ?? 0.2;
  const floorPx = opts.floorPx ?? 8;
  const padW = Math.max(floorPx, Math.round(bbox.w * padding));
  const padH = Math.max(floorPx, Math.round(bbox.h * padding));

  const meta = await sharp(png).metadata();
  const imgW = meta.width ?? 0;
  const imgH = meta.height ?? 0;
  if (imgW === 0 || imgH === 0) {
    throw new Error("phash_source_has_no_dims");
  }
  if (bbox.x + bbox.w <= 0 || bbox.y + bbox.h <= 0 || bbox.x >= imgW || bbox.y >= imgH) {
    throw new Error("phash_region_out_of_bounds");
  }

  const left = Math.max(0, bbox.x - padW);
  const top = Math.max(0, bbox.y - padH);
  const right = Math.min(imgW, bbox.x + bbox.w + padW);
  const bottom = Math.min(imgH, bbox.y + bbox.h + padH);
  const extract = { left, top, width: right - left, height: bottom - top };

  const cropped = await sharp(png).extract(extract).png().toBuffer();
  return pHash(cropped);
}
