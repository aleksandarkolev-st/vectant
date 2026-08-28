import { afterEach, describe, expect, it } from "vitest";
import { FrameSink } from "../../src/frames.js";

describe("FrameSink optional media attachment", () => {
  afterEach(() => {
    FrameSink.stopAll();
  });

  it("supports a live session before any media track exists", async () => {
    const sink = new FrameSink();

    expect(sink.hasFrame()).toBe(false);
    expect(sink.dimensions()).toBeNull();
    await expect(sink.getFrame()).rejects.toThrow("no_frame_yet");

    sink.stop();
    expect(sink.attachTrack({} as never)).toBe(false);
  });
});
