import { describe, it, expect, beforeEach } from "vitest";
import { inputQueueDepth } from "../../src/correctness/input_queue_depth.js";

beforeEach(() => {
  inputQueueDepth.reset();
});

describe("inputQueueDepth", () => {
  it("recordDispatch is a no-op outside a compile window", () => {
    inputQueueDepth.recordDispatch("mouse:click");
    const s = inputQueueDepth.snapshot();
    expect(s.inflight).toBe(0);
    expect(s.cycles_observed).toBe(0);
  });

  it("counts dispatches inside the compile window", () => {
    inputQueueDepth.onCompileStart();
    inputQueueDepth.recordDispatch("mouse:click");
    inputQueueDepth.recordDispatch("keyboard:type");
    inputQueueDepth.recordDispatch("keyboard:type");
    const mid = inputQueueDepth.snapshot();
    expect(mid.inflight).toBe(3);
    expect(mid.max_inflight_current_cycle).toBe(3);
  });

  it("flushes peak into recent_peaks histogram on onCompileEnd", () => {
    inputQueueDepth.onCompileStart();
    inputQueueDepth.recordDispatch("a");
    inputQueueDepth.recordDispatch("b");
    inputQueueDepth.onCompileEnd();
    const after = inputQueueDepth.snapshot();
    expect(after.cycles_observed).toBe(1);
    expect(after.recent_peaks).toEqual([2]);
    expect(after.inflight).toBe(0);
  });

  it("multiple cycles accumulate into recent_peaks", () => {
    for (let cycle = 1; cycle <= 4; cycle++) {
      inputQueueDepth.onCompileStart();
      for (let i = 0; i < cycle; i++) inputQueueDepth.recordDispatch("x");
      inputQueueDepth.onCompileEnd();
    }
    const s = inputQueueDepth.snapshot();
    expect(s.recent_peaks).toEqual([1, 2, 3, 4]);
    expect(s.cycles_observed).toBe(4);
  });

  it("recovers from missing onCompileEnd (start without prior end flushes)", () => {
    inputQueueDepth.onCompileStart();
    inputQueueDepth.recordDispatch("a");
    inputQueueDepth.recordDispatch("b");
    // forgot the end
    inputQueueDepth.onCompileStart();
    const after = inputQueueDepth.snapshot();
    expect(after.cycles_observed).toBe(1);
    expect(after.recent_peaks).toEqual([2]);
    expect(after.inflight).toBe(0);
  });
});
