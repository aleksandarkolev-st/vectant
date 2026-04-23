import sharp from "sharp";
import type { BBox } from "../../src/util/phash.js";

/**
 * Shared helpers for the phase-0.5 spike harness.
 *
 * Modes:
 *   - "sim"  — synthetic frames + injected build-log events. Runs anywhere
 *              (no docker, no Anthropic key). Measures MCP-layer correctness
 *              (cache mechanics, wait_hmr classification, pHash stability)
 *              but NOT real worker HMR timings.
 *   - "live" — live Synthi stack. Requires docker-compose up + Claude Code +
 *              (for E4) ANTHROPIC_API_KEY. Measures end-to-end timings.
 *              Phase-0.5 scope ships the sim path; the live path is gated on
 *              a `synthi_compile` tool (phase 1) or a Puppeteer driver.
 */

export type SpikeMode = "sim" | "live";

export function currentMode(): SpikeMode {
  return (process.env["SPIKE_MODE"] as SpikeMode | undefined) ?? "sim";
}

export function requireLive(experiment: string): void {
  if (currentMode() !== "live") {
    throw new Error(
      `${experiment} requires SPIKE_MODE=live. The sim-mode equivalent is ${experiment}_sim. See tests/spike/README.md.`
    );
  }
}

export interface SynthScene {
  w: number;
  h: number;
  /** Panel region that stays stable across frames. */
  panel: BBox;
  /** Panel color. Edit this to mimic an "edit → HMR" transition. */
  panelColor: { r: number; g: number; b: number };
  /** Noise seed for the animated particle field. Each frame's particles live
   *  at a slightly different position so full-frame pHash changes between
   *  frames. Particles never overlap the panel region. */
  frameIndex: number;
}

/** Deterministic pseudo-random: LCG. */
export function prngAt(seed: number): () => number {
  let state = (seed * 2654435769) >>> 0;
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/**
 * Synthetic frame generator matching the particle_demo fixture's spirit:
 * noisy field + stable panel. Returns a PNG buffer. Used for sim-mode E2b
 * without needing the real fixture to be running.
 */
export async function synthFrame(scene: SynthScene): Promise<Buffer> {
  const { w, h, panel, panelColor, frameIndex } = scene;
  const raw = Buffer.alloc(w * h * 3);
  // Dark background.
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = 20;
    raw[i * 3 + 1] = 20;
    raw[i * 3 + 2] = 40;
  }
  // Noisy particle field — frameIndex seeds the prng so two frames with the
  // same frameIndex are identical, different frameIndex → different layout.
  // Particles are sized + counted to mimic the particle_demo fixture's
  // visible motion density so full-frame pHash *does* drift between frames
  // (sparse 3×3 × 200 particles survive pHash's 32×32 downsample as noise).
  const rand = prngAt(frameIndex + 1);
  const particleCount = 800;
  const particleSize = 6;
  for (let i = 0; i < particleCount; i++) {
    const x = Math.floor(rand() * w);
    const y = Math.floor(rand() * h);
    for (let dy = 0; dy < particleSize; dy++) {
      for (let dx = 0; dx < particleSize; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= w || py >= h) continue;
        // Don't paint inside the panel region — preserves panel invariance.
        if (px >= panel.x && px < panel.x + panel.w && py >= panel.y && py < panel.y + panel.h) {
          continue;
        }
        const idx = (py * w + px) * 3;
        raw[idx] = 255;
        raw[idx + 1] = 255;
        raw[idx + 2] = 255;
      }
    }
  }
  // Stable panel.
  for (let y = panel.y; y < panel.y + panel.h; y++) {
    for (let x = panel.x; x < panel.x + panel.w; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const idx = (y * w + x) * 3;
      raw[idx] = panelColor.r;
      raw[idx + 1] = panelColor.g;
      raw[idx + 2] = panelColor.b;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/** Solid-color frame — E1 sim stand-in for a "stable counter UI" between HMR events. */
export async function synthSolidFrame(w: number, h: number, color: { r: number; g: number; b: number }): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = color.r;
    raw[i * 3 + 1] = color.g;
    raw[i * 3 + 2] = color.b;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

export interface Percentiles {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
}

export function summarize(xs: number[]): Percentiles {
  if (xs.length === 0) {
    return { n: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, min: 0 };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const pick = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    n: xs.length,
    mean: sum / xs.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted[sorted.length - 1]!,
    min: sorted[0]!,
  };
}

/**
 * Minimal event injector for sim-mode wait_hmr tests. Pretends to be the
 * build-log DC: emits arbitrary JSON messages to subscribers on demand.
 */
export class SyntheticHmrBus {
  private readonly listeners = new Set<(msg: Record<string, unknown>) => void>();

  subscribe(cb: (msg: Record<string, unknown>) => void): () => void {
    this.listeners.add(cb);
    return (): void => {
      this.listeners.delete(cb);
    };
  }

  emit(msg: Record<string, unknown>): void {
    for (const cb of this.listeners) cb(msg);
  }

  /** Schedule an emit after `delayMs`. Returns an unref'd handle. */
  emitAfter(delayMs: number, msg: Record<string, unknown>): NodeJS.Timeout {
    const t = setTimeout(() => this.emit(msg), delayMs);
    return t;
  }
}
