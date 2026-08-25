import { describe, expect, it } from "vitest";
import {
  commandMergeProfile,
  groupMergeProfile,
  noMergeProfile,
  reduceToWindows,
  type RawEvent,
} from "../../src/embodied/merge_profiles.js";

function events(specs: Array<[seq: number, group?: string | number]>): RawEvent[] {
  return specs.map(([seq, group]) => ({ seq, ...(group !== undefined ? { group } : {}), payload: { seq } }));
}

describe("lane0 merge profiles (per-substrate reduction)", () => {
  it("no-merge keeps every event standalone (browser byte-compatible)", () => {
    const windows = reduceToWindows(events([[0], [1], [2]]), noMergeProfile);
    expect(windows).toHaveLength(3);
    expect(windows.every((window) => !window.merged)).toBe(true);
  });

  it("group profile merges same-tick game events into one window", () => {
    const windows = reduceToWindows(
      events([
        [0, "tick-1"],
        [1, "tick-1"],
        [2, "tick-1"],
        [3, "tick-2"],
      ]),
      groupMergeProfile,
    );
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ start_seq: 0, end_seq: 2, merged: true });
    expect(windows[0]!.events).toHaveLength(3);
    expect(windows[1]).toMatchObject({ start_seq: 3, end_seq: 3, merged: false });
  });

  it("command profile folds outputs forward into the preceding command", () => {
    const specs: Array<[number, string?]> = [
      [10, "cmd-A"],
      [11],
      [12],
      [13, "cmd-B"],
    ];
    const windows = reduceToWindows(events(specs), commandMergeProfile);
    expect(windows).toHaveLength(2);
    // cmd-A window absorbed both output lines.
    expect(windows[0]!.events.map((event) => event.seq)).toEqual([10, 11, 12]);
    expect(windows[1]!.events.map((event) => event.seq)).toEqual([13]);
  });

  it("non-adjacent same-key events do not merge across an interruption", () => {
    const specs: Array<[number, string?]> = [
      [0, "tick-1"],
      [1], // ungrouped event breaks adjacency
      [2, "tick-2"],
      [3, "tick-1"], // key repeats but the run was interrupted
    ];
    const windows = reduceToWindows(events(specs), groupMergeProfile);
    expect(windows).toHaveLength(3);
  });

  it("is deterministic across runs", () => {
    const input = events([
      [0, "t1"],
      [1, "t1"],
      [2, "t2"],
    ]);
    expect(JSON.stringify(reduceToWindows(input, groupMergeProfile))).toBe(
      JSON.stringify(reduceToWindows(input, groupMergeProfile)),
    );
  });
});
