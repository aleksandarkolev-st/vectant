import { describe, it, expect, beforeEach } from "vitest";
import sharp from "sharp";
import { structuralChangeGate } from "../../src/correctness/structural_change.js";
import { eventLog } from "../../src/events/index.js";

beforeEach(() => {
  structuralChangeGate.reset();
});

async function flatFrame(r: number, g: number, b: number, w = 128, h = 128): Promise<Buffer> {
  return sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r, g, b },
    },
  })
    .png()
    .toBuffer();
}

async function checkerFrame(w = 128, h = 128): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const v = on ? 255 : 0;
      const i = (y * w + x) * 3;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
}

describe("structuralChangeGate", () => {
  it("verdict is no_baseline when applied fires without compile-start", async () => {
    const frame = await flatFrame(128, 64, 64);
    const verdict = await structuralChangeGate.onHmrApplied(frame, 10);
    expect(verdict.kind).toBe("no_baseline");
  });

  it("clean verdict when pre and post frames are identical", async () => {
    const frame = await flatFrame(60, 90, 120);
    await structuralChangeGate.onCompileStart(frame, 1);
    const verdict = await structuralChangeGate.onHmrApplied(frame, 2);
    expect(verdict.kind).toBe("clean");
    if (verdict.kind === "clean") {
      expect(verdict.hamming).toBe(0);
    }
  });

  it("structural_change verdict when frames differ above threshold", async () => {
    const flat = await flatFrame(20, 20, 20);
    const checker = await checkerFrame();
    await structuralChangeGate.onCompileStart(flat, 1);
    const verdict = await structuralChangeGate.onHmrApplied(checker, 2);
    expect(verdict.kind).toBe("structural_change");
    if (verdict.kind === "structural_change") {
      expect(verdict.hamming).toBeGreaterThan(16);
      expect(verdict.baseline_frame_seq).toBe(1);
      expect(verdict.applied_frame_seq).toBe(2);
    }
  });

  it("emits a security event on structural change", async () => {
    const flat = await flatFrame(5, 5, 5);
    const checker = await checkerFrame();
    await structuralChangeGate.onCompileStart(flat, 11);
    const beforeCount = eventLog.size();
    await structuralChangeGate.onHmrApplied(checker, 12);
    const entries = eventLog.query({ kind: "security", since_seq: beforeCount - 1 });
    const match = entries.find((e) => {
      if (e.kind !== "security") return false;
      const d = e.detail as { code?: string } | undefined;
      return d?.code === "input_rejected_hmr_structural_change";
    });
    expect(match).toBeDefined();
  });

  it("baseline resets after onHmrApplied regardless of verdict", async () => {
    const frame = await flatFrame(10, 20, 30);
    await structuralChangeGate.onCompileStart(frame, 5);
    expect(structuralChangeGate.currentBaselineSeq()).toBe(5);
    await structuralChangeGate.onHmrApplied(frame, 6);
    expect(structuralChangeGate.currentBaselineSeq()).toBeNull();
  });

  it("phash_unavailable verdict when applied frame is garbage", async () => {
    const frame = await flatFrame(30, 30, 30);
    await structuralChangeGate.onCompileStart(frame, 1);
    // Pass a non-PNG buffer so sharp throws.
    const verdict = await structuralChangeGate.onHmrApplied(Buffer.from([0xff, 0xd8, 0xff]), 2);
    expect(verdict.kind).toBe("phash_unavailable");
  });
});
